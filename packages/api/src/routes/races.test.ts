// docs/control-plane.md §3.4, §8: the interleaved-write races, via `FakeStateStore`. Each
// conditional write in the fake runs its condition check and mutation in one synchronous step, so
// `Promise.all([...])` over two calls reproduces a real DynamoDB race faithfully: both callers'
// reads resolve with the pre-mutation snapshot before either write can land (docs/control-plane.md
// §2's conditional `UpdateItem`s serialise the same way). See `src/fakes/fake-state-store.ts`.
import { describe, expect, it } from 'vitest';

import { initialClusterState } from '@dst/shared';
import type { ClusterStateItem } from '@dst/shared';

import { FakeClock } from '../fakes/fake-clock';
import { FakeLauncher } from '../fakes/fake-launcher';
import { FakeParameterStore } from '../fakes/fake-parameter-store';
import { FakeStateStore } from '../fakes/fake-state-store';
import { FakeWorldRegistry, testWorld } from '../fakes/fake-world-registry';
import { startWorld, stopWorld } from './worlds';
import type { WorldsDeps } from './worlds';

const USER_A = { steamId64: '76561197960287930', nickname: 'A' };
const USER_B = { steamId64: '76561197960287931', nickname: 'B' };
const NOW = new Date('2026-01-01T00:00:00.000Z');

function state(overrides: Partial<ClusterStateItem> = {}): ClusterStateItem {
  return { ...initialClusterState(), ...overrides };
}

function makeDeps(initial?: ClusterStateItem) {
  const store = new FakeStateStore(initial);
  const registry = new FakeWorldRegistry([
    testWorld({ worldId: 'w1' }),
    testWorld({ worldId: 'w2' }),
  ]);
  const launcher = new FakeLauncher();
  const deps: WorldsDeps = {
    clock: new FakeClock(NOW),
    store,
    registry,
    params: new FakeParameterStore({ '/dst/cluster-password': 'pw' }),
    launcher,
  };
  return { deps, store, launcher };
}

describe('races (docs/control-plane.md §3.4)', () => {
  it('two users starting the same world from stopped: exactly one instance is launched', async () => {
    const { deps, store, launcher } = makeDeps(state({ status: 'stopped' }));

    const [resultA, resultB] = await Promise.all([
      startWorld(deps, 'w1', USER_A),
      startWorld(deps, 'w1', USER_B),
    ]);

    expect(resultA.kind).toBe('ok');
    expect(resultB.kind).toBe('ok'); // the loser re-reads `starting W` and takes the W2 row
    expect(launcher.calls).toHaveLength(1);

    const item = store.peek();
    expect(item?.status).toBe('starting');
    expect(item?.worldId).toBe('w1');
    // Whoever's conditional write actually committed owns `startedBy`; the other only re-asserted
    // desire (W2), which never touches `startedBy`.
    expect([USER_A.steamId64, USER_B.steamId64]).toContain(item?.startedBy);
  });

  it('two users starting different worlds from stopped: the loser gets 409 world_busy', async () => {
    const { deps, store, launcher } = makeDeps(state({ status: 'stopped' }));

    const [resultA, resultB] = await Promise.all([
      startWorld(deps, 'w1', USER_A),
      startWorld(deps, 'w2', USER_B),
    ]);

    // Exactly one instance, ever: the second caller's W1 attempt fails (someone else is already
    // `starting`), and a different world while `starting` never queues (docs/control-plane.md §3.2).
    expect(launcher.calls).toHaveLength(1);
    const outcomes = [resultA.kind, resultB.kind].sort();
    expect(outcomes).toEqual(['error', 'ok']);
    const busy = resultA.kind === 'error' ? resultA : resultB;
    if (busy.kind === 'error') {
      expect(busy.code).toBe('world_busy');
      expect(busy.status).toBe(409);
    }
    expect(store.peek()?.status).toBe('starting');
  });

  it('stop racing a start from stopped: a safe outcome either way, never a lost or double launch', async () => {
    // docs/control-plane.md §3.4: "Either W1 wins and W3 then nulls the desire ..., or the stop
    // sees `stopped` and no-ops." Both callers' first read happens before either write lands (see
    // file header), so the stop's single-attempt no-op decision is made from the same
    // pre-mutation `stopped` snapshot the start saw — it correctly no-ops rather than clobbering
    // the world that is about to start. The already-covered `stopWorld` matrix test demonstrates
    // the other allowed outcome (a stop that lands *after* a start commits does null the desire).
    const { deps, store, launcher } = makeDeps(state({ status: 'stopped' }));

    const [startResult, stopResult] = await Promise.all([
      startWorld(deps, 'w1', USER_A),
      stopWorld(deps, 'w1', USER_B),
    ]);

    expect(startResult.kind).toBe('ok');
    expect(stopResult.kind).toBe('ok');
    expect(launcher.calls).toHaveLength(1); // exactly one instance, never zero, never two
    const item = store.peek();
    expect(item?.status).toBe('starting'); // the world is not lost
    expect(item?.worldId).toBe('w1');
  });

  it('start racing the supervisor writing S6, W2 first: the desire survives for the supervisor to pick up (S5)', async () => {
    const initial = state({
      status: 'stopping',
      worldId: 'w1',
      desiredWorldId: null,
      sessionId: '20260101T000000Z-aaaaaa',
    });
    const { deps, store, launcher } = makeDeps(initial);

    const result = await startWorld(deps, 'w1', USER_A);

    expect(result.kind).toBe('ok');
    expect(launcher.calls).toHaveLength(0); // a switch/re-assert never launches
    const item = store.peek();
    expect(item?.desiredWorldId).toBe('w1');
    // A real supervisor's S6 write is conditional on `attribute_type(desiredWorldId, 'NULL')`
    // (docs/control-plane.md §2); that condition now fails, so it takes the S5 path (starts W on
    // the same instance) instead of terminating. The request is never lost.
  });

  it('start racing the supervisor writing S6, S6 first: the API re-reads stopped and retries as a fresh start', async () => {
    const initial = state({
      status: 'stopping',
      worldId: 'w1',
      desiredWorldId: null,
      sessionId: '20260101T000000Z-aaaaaa',
    });
    const { deps, store, launcher } = makeDeps(initial);

    // Simulate the supervisor's S6 landing in the gap between the API's read and its own
    // conditional write (docs/control-plane.md §2, S6).
    store.interleaveAfterNextRead((current) => {
      if (current === undefined) return current;
      return {
        ...current,
        status: 'stopped',
        sessionId: null,
        instanceId: null,
        publicIp: null,
        joinableAt: null,
        playerCount: null,
        idleDeadline: null,
        heartbeatAt: null,
        lastStopReason: 'idle',
      };
    });

    const result = await startWorld(deps, 'w1', USER_A);

    expect(result.kind).toBe('ok');
    // Attempt 1 tried W2 against `stopping`, but by the time it ran the item was already
    // `stopped` (S6 landed first), so the condition failed; attempt 2 re-read `stopped` and
    // retried as a fresh W1 + launch. Never lost, never double-launched.
    expect(launcher.calls).toHaveLength(1);
    const item = store.peek();
    expect(item?.status).toBe('starting');
    expect(item?.worldId).toBe('w1');
  });

  it('reaper vs supervisor: a reaper write pinned to a stale sessionId never clobbers a new session', async () => {
    // docs/control-plane.md §3.4: "R1-R3 pin sessionId, so a supervisor that moved to a new
    // session (S5) is unaffected." The reaper itself lives in src/reaper (T2.3); this test
    // demonstrates the pinning property the state-machine relies on, using the same StateStore
    // port: a stale-session actor's conditional write must fail once the session has moved on.
    const initial = state({
      status: 'running',
      worldId: 'w1',
      sessionId: 'old-session',
      desiredWorldId: 'w1',
    });
    const { deps, store } = makeDeps(initial);

    // The supervisor switches in place to a brand new session (S5-equivalent), simulated directly
    // since S5 is supervisor logic, not part of this package's ports.
    store.setRaw({ ...initial, sessionId: 'new-session', worldId: 'w1' });

    // A reaper-style write still pinned to the old session must not be observable as succeeding
    // against the FakeStateStore's public ports: setDesired is the closest port-level analog and
    // is conditioned on `sessionId`, exactly like R1-R3.
    const ok = await deps.store.setDesired({
      worldId: 'w1',
      steamId64: 'reaper',
      nickname: 'reaper',
      expectedStatus: 'running',
      expectedSessionId: 'old-session',
      now: NOW,
    });
    expect(ok).toBe(false);
    expect(store.peek()?.sessionId).toBe('new-session');
  });
});
