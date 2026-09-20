// docs/control-plane.md §3.2, §3.3, §8: every row of the start/stop state-machine tables against
// the in-memory store (resulting item, whether `launch()` was called, status, body).
import { describe, expect, it } from 'vitest';

import { initialClusterState } from '@dst/shared';
import type { ClusterStateItem } from '@dst/shared';

import { FakeClock } from '../fakes/fake-clock';
import { FakeLauncher } from '../fakes/fake-launcher';
import { FakeParameterStore } from '../fakes/fake-parameter-store';
import { FakeStateStore } from '../fakes/fake-state-store';
import { FakeWorldRegistry, testWorld } from '../fakes/fake-world-registry';
import type { StateStore } from '../ports';
import { startWorld, stopWorld } from './worlds';
import type { WorldsDeps } from './worlds';

const USER = { steamId64: '76561197960287930', nickname: 'Nick' };
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

describe('startWorld (docs/control-plane.md §3.2)', () => {
  it('starts a world when the item is absent (a missing item counts as stopped)', async () => {
    const { deps, store, launcher } = makeDeps(undefined);
    const result = await startWorld(deps, 'w1', USER);
    expect(result.kind).toBe('ok');
    expect(launcher.calls).toHaveLength(1);
    const item = store.peek();
    expect(item?.status).toBe('starting');
    expect(item?.worldId).toBe('w1');
    expect(item?.desiredWorldId).toBe('w1');
    expect(item?.startedBy).toBe(USER.steamId64);
    expect(item?.startedByNickname).toBe(USER.nickname);
  });

  it('starts a world from stopped', async () => {
    const { deps, store, launcher } = makeDeps(state({ status: 'stopped' }));
    const result = await startWorld(deps, 'w1', USER);
    expect(result.kind).toBe('ok');
    expect(launcher.calls).toEqual([expect.objectContaining({ worldId: 'w1' })]);
    expect(store.peek()?.status).toBe('starting');
  });

  it('re-asserts desire (W2) when the same world is already starting; no new launch', async () => {
    const initial = state({
      status: 'starting',
      worldId: 'w1',
      desiredWorldId: 'w1',
      sessionId: '20260101T000000Z-aaaaaa',
      startedBy: 'someone-else',
      startedByNickname: 'Someone Else',
    });
    const { deps, store, launcher } = makeDeps(initial);
    const result = await startWorld(deps, 'w1', USER);
    expect(result.kind).toBe('ok');
    expect(launcher.calls).toHaveLength(0);
    const item = store.peek();
    expect(item?.status).toBe('starting');
    expect(item?.sessionId).toBe('20260101T000000Z-aaaaaa'); // unchanged: no new instance
    expect(item?.desiredBy).toBe(USER.steamId64);
    expect(item?.startedBy).toBe('someone-else'); // W2 never touches startedBy
  });

  it('returns 409 world_busy when a different world is starting; no queueing', async () => {
    const initial = state({
      status: 'starting',
      worldId: 'w1',
      sessionId: '20260101T000000Z-aaaaaa',
    });
    const { deps, store, launcher } = makeDeps(initial);
    const result = await startWorld(deps, 'w2', USER);
    expect(result).toEqual({
      kind: 'error',
      status: 409,
      code: 'world_busy',
      message: expect.any(String),
    });
    expect(launcher.calls).toHaveLength(0);
    expect(store.peek()).toEqual(initial);
  });

  it('re-asserts desire (W2) when the same world is already running', async () => {
    const initial = state({
      status: 'running',
      worldId: 'w1',
      sessionId: '20260101T000000Z-aaaaaa',
    });
    const { deps, store, launcher } = makeDeps(initial);
    const result = await startWorld(deps, 'w1', USER);
    expect(result.kind).toBe('ok');
    expect(launcher.calls).toHaveLength(0);
    expect(store.peek()?.status).toBe('running');
    expect(store.peek()?.desiredWorldId).toBe('w1');
  });

  it('queues a switch (W2) when a different world is running; no new launch', async () => {
    const initial = state({
      status: 'running',
      worldId: 'w1',
      sessionId: '20260101T000000Z-aaaaaa',
    });
    const { deps, store, launcher } = makeDeps(initial);
    const result = await startWorld(deps, 'w2', USER);
    expect(result.kind).toBe('ok');
    expect(launcher.calls).toHaveLength(0);
    const item = store.peek();
    expect(item?.status).toBe('running'); // unchanged: the switch happens in place, later
    expect(item?.worldId).toBe('w1');
    expect(item?.desiredWorldId).toBe('w2');
  });

  it('re-asserts desire (W2) while stopping the same world (supervisor restarts it)', async () => {
    const initial = state({
      status: 'stopping',
      worldId: 'w1',
      desiredWorldId: null,
      sessionId: '20260101T000000Z-aaaaaa',
    });
    const { deps, store, launcher } = makeDeps(initial);
    const result = await startWorld(deps, 'w1', USER);
    expect(result.kind).toBe('ok');
    expect(launcher.calls).toHaveLength(0);
    expect(store.peek()?.desiredWorldId).toBe('w1');
  });

  it('queues a switch (W2) while stopping a different world', async () => {
    const initial = state({
      status: 'stopping',
      worldId: 'w1',
      desiredWorldId: null,
      sessionId: '20260101T000000Z-aaaaaa',
    });
    const { deps, store, launcher } = makeDeps(initial);
    const result = await startWorld(deps, 'w2', USER);
    expect(result.kind).toBe('ok');
    expect(launcher.calls).toHaveLength(0);
    expect(store.peek()?.desiredWorldId).toBe('w2');
  });

  it('rolls back (W4) and returns 503 launch_failed when RunInstances fails', async () => {
    const { deps, store, launcher } = makeDeps(state({ status: 'stopped' }));
    // The real ec2-launcher adapter formats its thrown Error as `${err.name}: ${message}` before
    // this ever reaches routes/worlds.ts (docs/control-plane.md §4); the fake reproduces that.
    launcher.failNextWith(new Error('InsufficientInstanceCapacity: no capacity in any AZ'));
    const result = await startWorld(deps, 'w1', USER);
    expect(result).toEqual({
      kind: 'error',
      status: 503,
      code: 'launch_failed',
      message: expect.any(String),
    });
    const item = store.peek();
    expect(item?.status).toBe('stopped');
    expect(item?.desiredWorldId).toBeNull();
    expect(item?.sessionId).toBeNull();
    expect(item?.lastStopReason).toBe('launch-failed');
    expect(item?.lastError).toContain('InsufficientInstanceCapacity');
  });

  it('returns 409 state_conflict after exhausting attempts on a store that never accepts a write', async () => {
    const flaky: StateStore = {
      get: async () => state({ status: 'stopped' }),
      startFresh: async () => false,
      setDesired: async () => false,
      clearDesired: async () => false,
      rollbackLaunch: async () => false,
      maxAgeGraceful: async () => false,
      finalizeStopped: async () => false,
    };
    const registry = new FakeWorldRegistry([testWorld({ worldId: 'w1' })]);
    const deps: WorldsDeps = {
      clock: new FakeClock(NOW),
      store: flaky,
      registry,
      params: new FakeParameterStore({ '/dst/cluster-password': 'pw' }),
      launcher: new FakeLauncher(),
    };
    const result = await startWorld(deps, 'w1', USER);
    expect(result).toEqual({
      kind: 'error',
      status: 409,
      code: 'state_conflict',
      message: expect.any(String),
    });
  });
});

describe('stopWorld (docs/control-plane.md §3.3)', () => {
  it('is a no-op when the item is absent', async () => {
    const { deps, store } = makeDeps(undefined);
    const result = await stopWorld(deps, 'w1', USER);
    expect(result.kind).toBe('ok');
    expect(store.peek()).toBeUndefined();
  });

  it('is a no-op when already stopped', async () => {
    const initial = state({ status: 'stopped', worldId: 'w1' });
    const { deps, store } = makeDeps(initial);
    const result = await stopWorld(deps, 'w1', USER);
    expect(result.kind).toBe('ok');
    expect(store.peek()).toEqual(initial);
  });

  it('clears the desire (W3) when W is the active world', async () => {
    const initial = state({
      status: 'running',
      worldId: 'w1',
      desiredWorldId: 'w1',
      sessionId: '20260101T000000Z-aaaaaa',
    });
    const { deps, store } = makeDeps(initial);
    const result = await stopWorld(deps, 'w1', USER);
    expect(result.kind).toBe('ok');
    const item = store.peek();
    expect(item?.desiredWorldId).toBeNull();
    expect(item?.desiredBy).toBe(USER.steamId64);
    expect(item?.status).toBe('running'); // the supervisor drives status -> stopping/stopped
  });

  it('is a no-op for a world that is not the active worldId (a queued switch target)', async () => {
    const initial = state({
      status: 'running',
      worldId: 'w1',
      desiredWorldId: 'w2',
      sessionId: '20260101T000000Z-aaaaaa',
    });
    const { deps, store } = makeDeps(initial);
    const result = await stopWorld(deps, 'w2', USER);
    expect(result.kind).toBe('ok');
    expect(store.peek()).toEqual(initial); // unchanged: stopping W2 while W1 runs is a no-op
  });

  it('is idempotent when the desire is already null', async () => {
    const initial = state({
      status: 'stopping',
      worldId: 'w1',
      desiredWorldId: null,
      sessionId: '20260101T000000Z-aaaaaa',
    });
    const { deps, store } = makeDeps(initial);
    const result = await stopWorld(deps, 'w1', USER);
    expect(result.kind).toBe('ok');
    expect(store.peek()?.desiredWorldId).toBeNull();
  });
});
