// Reaper unit tests (docs/control-plane.md §8): fake clock + fake EC2 + a small in-memory
// ReaperStore for every rule in §6. Three titles are quoted verbatim below because the execution
// plan greps for them character for character — do not reword them.
import { initialClusterState } from '@dst/shared';
import type { ClusterStateItem, StopReason } from '@dst/shared';
import { beforeEach, describe, expect, it } from 'vitest';

import { FakeClock } from '../fakes/fake-clock';
import { FakeDns } from '../fakes/fake-dns';
import type { ReaperEc2, ReaperInstance, ReaperStore } from './index';
import { runReaper } from './index';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const MAX_SESSION_MS = 12 * HOUR;
const MAX_SESSION_GRACE_MS = 10 * MINUTE;
const REAPER_HEARTBEAT_STALE_MS = 10 * MINUTE;
const REAPER_BOOT_GRACE_MS = 15 * MINUTE;
const STARTING_WITHOUT_INSTANCE_MS = 3 * MINUTE;

const NOW = new Date('2026-06-01T12:00:00.000Z');

function state(overrides: Partial<ClusterStateItem>): ClusterStateItem {
  return { ...initialClusterState(), ...overrides };
}

function instance(overrides: Partial<ReaperInstance>): ReaperInstance {
  return {
    instanceId: 'i-default',
    launchTime: NOW,
    sessionIdTag: 'S1',
    ...overrides,
  };
}

interface StoreWrite {
  type: 'maxAgeGraceful' | 'finalizeStopped';
  sessionId: string;
  reason?: Extract<StopReason, 'reaper-max-age' | 'reaper-stale'>;
}

class FakeReaperStore implements ReaperStore {
  item: ClusterStateItem;
  writes: StoreWrite[] = [];

  constructor(initial: ClusterStateItem) {
    this.item = initial;
  }

  async get(): Promise<ClusterStateItem> {
    return { ...this.item };
  }

  async maxAgeGraceful(a: { sessionId: string; instanceId: string; now: Date }): Promise<boolean> {
    if (this.item.status === 'stopped') return false;
    if (this.item.sessionId !== a.sessionId) return false;
    if (this.item.instanceId !== a.instanceId) return false;
    this.writes.push({ type: 'maxAgeGraceful', sessionId: a.sessionId });
    this.item = {
      ...this.item,
      desiredWorldId: null,
      desiredBy: 'reaper',
      desiredByNickname: 'reaper',
      desiredAt: a.now.toISOString(),
      lastStopReason: 'reaper-max-age',
    };
    return true;
  }

  async finalizeStopped(a: {
    sessionId: string;
    reason: Extract<StopReason, 'reaper-max-age' | 'reaper-stale'>;
    error: string;
  }): Promise<boolean> {
    if (this.item.sessionId !== a.sessionId) return false;
    this.writes.push({ type: 'finalizeStopped', sessionId: a.sessionId, reason: a.reason });
    this.item = {
      ...this.item,
      status: 'stopped',
      sessionId: null,
      instanceId: null,
      publicIp: null,
      joinableAt: null,
      playerCount: null,
      idleDeadline: null,
      heartbeatAt: null,
      lastStopReason: a.reason,
      desiredWorldId: null,
      lastError: a.error,
    };
    return true;
  }
}

class FakeReaperEc2 implements ReaperEc2 {
  private instances: ReaperInstance[];
  terminated: string[] = [];

  constructor(instances: ReaperInstance[]) {
    this.instances = instances;
  }

  async describeGameInstances(): Promise<ReaperInstance[]> {
    return this.instances.filter((i) => !this.terminated.includes(i.instanceId));
  }

  async terminate(instanceId: string): Promise<void> {
    if (!this.terminated.includes(instanceId)) this.terminated.push(instanceId);
  }
}

let clock: FakeClock;
let dns: FakeDns;

beforeEach(() => {
  clock = new FakeClock(NOW);
  dns = new FakeDns();
});

describe('orphan (rule 1)', () => {
  it('terminates an orphan and does not touch a healthy tracked session', async () => {
    const store = new FakeReaperStore(
      state({
        status: 'running',
        worldId: 'w',
        sessionId: 'S1',
        instanceId: 'i-1',
        heartbeatAt: NOW.toISOString(),
      }),
    );
    const ec2 = new FakeReaperEc2([
      instance({ instanceId: 'i-1', sessionIdTag: 'S1', launchTime: NOW }),
      instance({ instanceId: 'i-2', sessionIdTag: 'S0', launchTime: NOW }),
    ]);

    const result = await runReaper({}, { store, ec2, dns, clock });

    expect(ec2.terminated).toEqual(['i-2']);
    expect(result.terminated).toEqual([{ instanceId: 'i-2', reason: 'reaper-stale' }]);
    // The orphan's finalize write is scoped to its own (foreign) session, so it can never match
    // the tracked session — the healthy instance's state is left completely untouched.
    expect(store.item.status).toBe('running');
    expect(store.item.sessionId).toBe('S1');
    expect(store.item.instanceId).toBe('i-1');
  });

  it('switched instance is not an orphan', async () => {
    // decisions §16.7: an in-place switch changes state.sessionId while the instance keeps its
    // original launch-session tag; the instance id still matches, so it is never an orphan.
    const store = new FakeReaperStore(
      state({
        status: 'starting',
        worldId: 'w2',
        sessionId: 'S2',
        instanceId: 'i-1',
        startedAt: NOW.toISOString(),
      }),
    );
    const ec2 = new FakeReaperEc2([
      instance({ instanceId: 'i-1', sessionIdTag: 'S1', launchTime: NOW }),
    ]);

    const result = await runReaper({}, { store, ec2, dns, clock });

    expect(ec2.terminated).toEqual([]);
    expect(result.terminated).toEqual([]);
    expect(result.reconciled).toBe(false);
    expect(store.writes).toEqual([]);
  });
});

describe('max age (rule 2/3)', () => {
  it('graceful: nulls the desire and writes reaper-max-age without terminating', async () => {
    const store = new FakeReaperStore(
      state({
        status: 'running',
        worldId: 'w',
        sessionId: 'S1',
        instanceId: 'i-1',
        desiredWorldId: 'w',
        heartbeatAt: NOW.toISOString(),
      }),
    );
    const launchTime = new Date(NOW.getTime() - (MAX_SESSION_MS + MINUTE));
    const ec2 = new FakeReaperEc2([
      instance({ instanceId: 'i-1', sessionIdTag: 'S1', launchTime }),
    ]);

    const result = await runReaper({}, { store, ec2, dns, clock });

    expect(ec2.terminated).toEqual([]);
    expect(result.terminated).toEqual([]);
    expect(result.nulledDesire).toEqual(['i-1']);
    expect(store.item.desiredWorldId).toBeNull();
    expect(store.item.lastStopReason).toBe('reaper-max-age');
    expect(store.item.status).toBe('running'); // still running — the supervisor does the stopping
  });

  it('hard: terminates once age exceeds the max session plus its 10 minute grace', async () => {
    const store = new FakeReaperStore(
      state({
        status: 'running',
        worldId: 'w',
        sessionId: 'S1',
        instanceId: 'i-1',
        desiredWorldId: null,
        heartbeatAt: NOW.toISOString(),
      }),
    );
    const launchTime = new Date(NOW.getTime() - (MAX_SESSION_MS + MAX_SESSION_GRACE_MS + MINUTE));
    const ec2 = new FakeReaperEc2([
      instance({ instanceId: 'i-1', sessionIdTag: 'S1', launchTime }),
    ]);

    const result = await runReaper({}, { store, ec2, dns, clock });

    expect(ec2.terminated).toEqual(['i-1']);
    expect(result.terminated).toEqual([{ instanceId: 'i-1', reason: 'reaper-max-age' }]);
    expect(store.item.status).toBe('stopped');
    expect(store.item.lastStopReason).toBe('reaper-max-age');
    expect(store.item.sessionId).toBeNull();
  });
});

describe('stale heartbeat (rule 4)', () => {
  it('is ignored during the 15 minute boot grace', async () => {
    const store = new FakeReaperStore(
      state({
        status: 'running',
        worldId: 'w',
        sessionId: 'S1',
        instanceId: 'i-1',
        heartbeatAt: null,
      }),
    );
    const launchTime = new Date(NOW.getTime() - 5 * MINUTE); // < REAPER_BOOT_GRACE_MS
    const ec2 = new FakeReaperEc2([
      instance({ instanceId: 'i-1', sessionIdTag: 'S1', launchTime }),
    ]);

    const result = await runReaper({}, { store, ec2, dns, clock });

    expect(ec2.terminated).toEqual([]);
    expect(result.terminated).toEqual([]);
    expect(result.reconciled).toBe(false);
    expect(store.writes).toEqual([]);
  });

  it('terminates once the boot grace has passed with a null or too-old heartbeat', async () => {
    const store = new FakeReaperStore(
      state({
        status: 'running',
        worldId: 'w',
        sessionId: 'S1',
        instanceId: 'i-1',
        heartbeatAt: new Date(NOW.getTime() - (REAPER_HEARTBEAT_STALE_MS + MINUTE)).toISOString(),
      }),
    );
    const launchTime = new Date(NOW.getTime() - (REAPER_BOOT_GRACE_MS + MINUTE));
    const ec2 = new FakeReaperEc2([
      instance({ instanceId: 'i-1', sessionIdTag: 'S1', launchTime }),
    ]);

    const result = await runReaper({}, { store, ec2, dns, clock });

    expect(ec2.terminated).toEqual(['i-1']);
    expect(result.terminated).toEqual([{ instanceId: 'i-1', reason: 'reaper-stale' }]);
    expect(store.item.status).toBe('stopped');
    expect(store.item.lastStopReason).toBe('reaper-stale');
  });
});

describe('rule order', () => {
  it('max-age beats stale when an instance is old enough to match both', async () => {
    const store = new FakeReaperStore(
      state({
        status: 'running',
        worldId: 'w',
        sessionId: 'S1',
        instanceId: 'i-1',
        desiredWorldId: null,
        heartbeatAt: new Date(NOW.getTime() - (REAPER_HEARTBEAT_STALE_MS + MINUTE)).toISOString(),
      }),
    );
    // Past both the hard max-age threshold AND the stale-heartbeat threshold.
    const launchTime = new Date(NOW.getTime() - (MAX_SESSION_MS + MAX_SESSION_GRACE_MS + MINUTE));
    const ec2 = new FakeReaperEc2([
      instance({ instanceId: 'i-1', sessionIdTag: 'S1', launchTime }),
    ]);

    const result = await runReaper({}, { store, ec2, dns, clock });

    // Reason attributes to max-age (evaluated first), never to stale.
    expect(result.terminated).toEqual([{ instanceId: 'i-1', reason: 'reaper-max-age' }]);
  });

  it('orphan beats max-age and stale when an instance matches all three', async () => {
    const store = new FakeReaperStore(
      state({
        status: 'running',
        worldId: 'w',
        sessionId: 'S1',
        instanceId: 'i-other',
        heartbeatAt: new Date(NOW.getTime() - (REAPER_HEARTBEAT_STALE_MS + MINUTE)).toISOString(),
      }),
    );
    const launchTime = new Date(NOW.getTime() - (MAX_SESSION_MS + MAX_SESSION_GRACE_MS + MINUTE));
    const ec2 = new FakeReaperEc2([
      // The actual tracked instance, alive and well, so reconcile does not also fire.
      instance({ instanceId: 'i-other', sessionIdTag: 'S1', launchTime: NOW }),
      instance({ instanceId: 'i-orphan', sessionIdTag: 'S0', launchTime }),
    ]);

    const result = await runReaper({}, { store, ec2, dns, clock });

    expect(result.terminated).toEqual([{ instanceId: 'i-orphan', reason: 'reaper-stale' }]);
    expect(result.reconciled).toBe(false);
    // The tracked (different) session's state item is untouched — the orphan write can never
    // match state.sessionId.
    expect(store.item.sessionId).toBe('S1');
  });
});

describe('reconcile', () => {
  it('stops a running world with no live instance', async () => {
    const store = new FakeReaperStore(
      state({
        status: 'running',
        worldId: 'w',
        sessionId: 'S1',
        instanceId: 'i-1',
        heartbeatAt: NOW.toISOString(),
      }),
    );
    const ec2 = new FakeReaperEc2([]);

    const result = await runReaper({}, { store, ec2, dns, clock });

    expect(result.reconciled).toBe(true);
    expect(store.item.status).toBe('stopped');
    expect(store.item.lastStopReason).toBe('reaper-stale');
  });

  it('does not reconcile a starting world within its 3 minute grace', async () => {
    const store = new FakeReaperStore(
      state({
        status: 'starting',
        worldId: 'w',
        sessionId: 'S1',
        instanceId: null,
        startedAt: new Date(NOW.getTime() - MINUTE).toISOString(),
      }),
    );
    const ec2 = new FakeReaperEc2([]);

    const result = await runReaper({}, { store, ec2, dns, clock });

    expect(result.reconciled).toBe(false);
    expect(store.item.status).toBe('starting');
  });

  it('starting without an instance is reconciled after the grace', async () => {
    const store = new FakeReaperStore(
      state({
        status: 'starting',
        worldId: 'w',
        sessionId: 'S1',
        instanceId: null,
        startedAt: new Date(NOW.getTime() - (STARTING_WITHOUT_INSTANCE_MS + MINUTE)).toISOString(),
      }),
    );
    const ec2 = new FakeReaperEc2([]);

    const result = await runReaper({}, { store, ec2, dns, clock });

    expect(result.reconciled).toBe(true);
    expect(store.item.status).toBe('stopped');
    expect(store.item.lastStopReason).toBe('reaper-stale');
  });
});

describe('the `now` override', () => {
  it('may only move the clock forward, never back', async () => {
    // Forward: an event.now in the future can push an instance over the hard max-age threshold
    // that the real clock alone would not yet reach.
    {
      const store = new FakeReaperStore(
        state({ status: 'running', worldId: 'w', sessionId: 'S1', instanceId: 'i-1' }),
      );
      const launchTime = new Date(NOW.getTime() - (MAX_SESSION_MS + MAX_SESSION_GRACE_MS - MINUTE));
      const ec2 = new FakeReaperEc2([
        instance({ instanceId: 'i-1', sessionIdTag: 'S1', launchTime }),
      ]);
      const futureOverride = new Date(NOW.getTime() + 5 * MINUTE).toISOString();

      const result = await runReaper({ now: futureOverride }, { store, ec2, dns, clock });

      expect(result.terminated).toEqual([{ instanceId: 'i-1', reason: 'reaper-max-age' }]);
    }

    // Backward: an event.now in the past can never make the reaper less aggressive than the real
    // clock — an instance already past the hard threshold at the real time is still terminated.
    {
      const store = new FakeReaperStore(
        state({ status: 'running', worldId: 'w', sessionId: 'S1', instanceId: 'i-1' }),
      );
      const launchTime = new Date(NOW.getTime() - (MAX_SESSION_MS + MAX_SESSION_GRACE_MS + MINUTE));
      const ec2 = new FakeReaperEc2([
        instance({ instanceId: 'i-1', sessionIdTag: 'S1', launchTime }),
      ]);
      const pastOverride = new Date(NOW.getTime() - 24 * HOUR).toISOString();

      const result = await runReaper({ now: pastOverride }, { store, ec2, dns, clock });

      expect(result.terminated).toEqual([{ instanceId: 'i-1', reason: 'reaper-max-age' }]);
    }
  });
});

describe('ReaperResult', () => {
  it('matches the action actually taken across a mixed batch', async () => {
    const store = new FakeReaperStore(
      state({
        status: 'running',
        worldId: 'w',
        sessionId: 'S1',
        instanceId: 'i-tracked',
        desiredWorldId: 'w',
        heartbeatAt: NOW.toISOString(),
      }),
    );
    const gracefulAge = new Date(NOW.getTime() - (MAX_SESSION_MS + MINUTE));
    const ec2 = new FakeReaperEc2([
      instance({ instanceId: 'i-tracked', sessionIdTag: 'S1', launchTime: gracefulAge }),
      instance({ instanceId: 'i-orphan', sessionIdTag: 'S0', launchTime: NOW }),
    ]);

    const result = await runReaper({}, { store, ec2, dns, clock });

    expect(result).toEqual({
      nulledDesire: ['i-tracked'],
      terminated: [{ instanceId: 'i-orphan', reason: 'reaper-stale' }],
      reconciled: false,
      joinRecordSunk: true, // the orphan terminate ended a session
    });
  });
});

describe('idempotency', () => {
  it('a repeat run over unchanged inputs performs zero writes', async () => {
    const store = new FakeReaperStore(
      state({
        status: 'running',
        worldId: 'w',
        sessionId: 'S1',
        instanceId: 'i-1',
        heartbeatAt: new Date(NOW.getTime() - (REAPER_HEARTBEAT_STALE_MS + MINUTE)).toISOString(),
      }),
    );
    const launchTime = new Date(NOW.getTime() - (REAPER_BOOT_GRACE_MS + MINUTE));
    const ec2 = new FakeReaperEc2([
      instance({ instanceId: 'i-1', sessionIdTag: 'S1', launchTime }),
    ]);

    const first = await runReaper({}, { store, ec2, dns, clock });
    expect(first.terminated).toEqual([{ instanceId: 'i-1', reason: 'reaper-stale' }]);
    const writesAfterFirst = store.writes.length;

    const second = await runReaper({}, { store, ec2, dns, clock });

    expect(second).toEqual({
      nulledDesire: [],
      terminated: [],
      reconciled: false,
      joinRecordSunk: false,
    });
    expect(store.writes.length).toBe(writesAfterFirst);
    expect(ec2.terminated).toEqual(['i-1']); // TerminateInstances was not re-issued
  });
});

// docs/decisions.md §17: the reaper is the backstop for an instance that dies without getting an
// AWS call out — the panic poweroff, the dead-man `shutdown`, a hard crash, or this very reaper
// terminating it. Whatever `play.dst.ty.ler.dev` says at that point is stale by construction.
describe('the join record backstop', () => {
  it('sinks the record when it terminates a stale instance', async () => {
    const store = new FakeReaperStore(
      state({
        status: 'running',
        worldId: 'w',
        sessionId: 'S1',
        instanceId: 'i-1',
        heartbeatAt: new Date(NOW.getTime() - (REAPER_HEARTBEAT_STALE_MS + MINUTE)).toISOString(),
      }),
    );
    const launchTime = new Date(NOW.getTime() - (REAPER_BOOT_GRACE_MS + MINUTE));
    const ec2 = new FakeReaperEc2([
      instance({ instanceId: 'i-1', sessionIdTag: 'S1', launchTime }),
    ]);

    const result = await runReaper({}, { store, ec2, dns, clock });

    expect(dns.writes).toEqual(['192.0.2.1']);
    expect(result.joinRecordSunk).toBe(true);
  });

  it('sinks the record when it reconciles a session with no live instance', async () => {
    const store = new FakeReaperStore(
      state({
        status: 'running',
        worldId: 'w',
        sessionId: 'S1',
        instanceId: 'i-1',
        heartbeatAt: NOW.toISOString(),
      }),
    );

    const result = await runReaper({}, { store, ec2: new FakeReaperEc2([]), dns, clock });

    expect(result.reconciled).toBe(true);
    expect(dns.writes).toEqual(['192.0.2.1']);
  });

  it('touches DNS exactly once per run, however many instances it ends', async () => {
    const store = new FakeReaperStore(
      state({ status: 'running', worldId: 'w', sessionId: 'S1', instanceId: 'i-1' }),
    );
    const ec2 = new FakeReaperEc2([
      instance({ instanceId: 'i-orphan-a', sessionIdTag: 'S0', launchTime: NOW }),
      instance({ instanceId: 'i-orphan-b', sessionIdTag: 'S0', launchTime: NOW }),
    ]);

    await runReaper({}, { store, ec2, dns, clock });

    expect(ec2.terminated).toEqual(['i-orphan-a', 'i-orphan-b']);
    expect(dns.writes).toEqual(['192.0.2.1']);
  });

  it('leaves DNS alone on a no-op tick', async () => {
    const store = new FakeReaperStore(state({ status: 'stopped' }));

    const result = await runReaper({}, { store, ec2: new FakeReaperEc2([]), dns, clock });

    expect(dns.writes).toEqual([]);
    expect(result.joinRecordSunk).toBe(false);
  });

  it("leaves a healthy running session's record alone", async () => {
    const store = new FakeReaperStore(
      state({
        status: 'running',
        worldId: 'w',
        sessionId: 'S1',
        instanceId: 'i-1',
        desiredWorldId: 'w',
        heartbeatAt: NOW.toISOString(),
      }),
    );
    const ec2 = new FakeReaperEc2([
      instance({ instanceId: 'i-1', sessionIdTag: 'S1', launchTime: NOW }),
    ]);

    await runReaper({}, { store, ec2, dns, clock });

    expect(ec2.terminated).toEqual([]);
    expect(dns.writes).toEqual([]);
  });

  // Cost safety outranks DNS: a Route 53 failure must not stop the reaper terminating or writing
  // state. The next tick that ends a session tries the sink again.
  it('still terminates and finalizes when Route 53 fails', async () => {
    dns.failWith(new Error('Throttling'));
    const store = new FakeReaperStore(
      state({
        status: 'running',
        worldId: 'w',
        sessionId: 'S1',
        instanceId: 'i-1',
        heartbeatAt: new Date(NOW.getTime() - (REAPER_HEARTBEAT_STALE_MS + MINUTE)).toISOString(),
      }),
    );
    const launchTime = new Date(NOW.getTime() - (REAPER_BOOT_GRACE_MS + MINUTE));
    const ec2 = new FakeReaperEc2([
      instance({ instanceId: 'i-1', sessionIdTag: 'S1', launchTime }),
    ]);

    const result = await runReaper({}, { store, ec2, dns, clock });

    expect(ec2.terminated).toEqual(['i-1']);
    expect(store.item.status).toBe('stopped');
    expect(result.joinRecordSunk).toBe(false);
  });
});
