import { describe, expect, it } from 'vitest';

import { isBootOrphan, reduce, shardsFor, stopOrder } from '../src/core/reduce';
import type { ReconcileCommand, ReconcileState, WriteCommand } from '../src/core/types';

function baseState(overrides: Partial<ReconcileState> = {}): ReconcileState {
  return {
    phase: 'running',
    sessionId: '20260919T201355Z-a1b2c3',
    instanceId: 'i-0123456789abcdef0',
    worldId: 'test-a',
    hasCaves: true,
    desiredWorldId: 'test-a',
    desiredBy: '76500000000000001',
    desiredByNickname: 'Tyler',
    loadCompleted: true,
    stopping: null,
    ...overrides,
  };
}

function writes(commands: readonly ReconcileCommand[]): WriteCommand[] {
  return commands
    .filter((c): c is Extract<ReconcileCommand, { type: 'write' }> => c.type === 'write')
    .map((c) => c.write);
}

describe('shardsFor / stopOrder', () => {
  it('hasCaves=false never starts or polls Caves', () => {
    expect(shardsFor(false)).toEqual(['Master']);
    expect(stopOrder(shardsFor(false))).toEqual(['Master']);
  });

  it('hasCaves=true starts both shards, Caves stopped first', () => {
    expect(shardsFor(true)).toEqual(['Master', 'Caves']);
    expect(stopOrder(shardsFor(true))).toEqual(['Caves', 'Master']);
  });
});

describe('isBootOrphan', () => {
  it('is an orphan when the sessionId does not match', () => {
    expect(isBootOrphan('ours', { sessionId: 'someone-elses', status: 'starting' })).toBe(true);
  });

  it('is an orphan when the state is not starting', () => {
    expect(isBootOrphan('ours', { sessionId: 'ours', status: 'running' })).toBe(true);
  });

  it('is not an orphan when both match', () => {
    expect(isBootOrphan('ours', { sessionId: 'ours', status: 'starting' })).toBe(false);
  });
});

describe('reduce: boot', () => {
  it('orphan at boot halts with zero writes', () => {
    const state = baseState({ phase: 'boot' });
    const { state: next, commands } = reduce(state, { type: 'orphan' });
    expect(next.phase).toBe('halted');
    expect(commands).toEqual([{ type: 'halt' }]);
    expect(writes(commands)).toEqual([]);
  });
});

describe('reduce: desired-changed', () => {
  it('save is not pushed when the world never finished loading', () => {
    const state = baseState({ phase: 'starting', loadCompleted: false });
    const { state: next, commands } = reduce(state, {
      type: 'desired-changed',
      desiredWorldId: null,
      desiredBy: null,
      desiredByNickname: null,
    });
    expect(next.phase).toBe('stopping');
    expect(next.stopping).toEqual({ reason: 'user', next: null });
    expect(commands).toEqual([
      {
        type: 'write',
        write: {
          kind: 'S4',
          sessionId: state.sessionId,
          instanceId: state.instanceId,
          reason: 'user',
        },
      },
      { type: 'stop-shards', shards: ['Caves', 'Master'] },
    ]);
    // The stop-complete step (tested below) is what actually decides push-vs-no-push; assert the
    // ingredient this test is named for: loadCompleted stayed false through the transition.
    expect(next.loadCompleted).toBe(false);
  });

  it('desired goes null while running -> stop user with a push', () => {
    const state = baseState({ phase: 'running', loadCompleted: true });
    const { state: stopping } = reduce(state, {
      type: 'desired-changed',
      desiredWorldId: null,
      desiredBy: null,
      desiredByNickname: null,
    });
    expect(stopping.phase).toBe('stopping');
    const { commands } = reduce(stopping, { type: 'stop-complete', newSessionId: null });
    expect(commands).toContainEqual({ type: 'push-save' });
    expect(writes(commands)).toEqual([
      { kind: 'S6', sessionId: state.sessionId, instanceId: state.instanceId, reason: 'user' },
    ]);
  });

  it('a different world while running -> stop switch then start B in place under a new sessionId', () => {
    const state = baseState({ phase: 'running', worldId: 'test-a' });
    const { state: stopping, commands: stopCommands } = reduce(state, {
      type: 'desired-changed',
      desiredWorldId: 'test-b',
      desiredBy: '76500000000000002',
      desiredByNickname: 'Friend',
    });
    expect(stopping.phase).toBe('stopping');
    expect(stopping.stopping).toEqual({ reason: 'switch', next: 'test-b' });
    expect(writes(stopCommands)).toEqual([
      { kind: 'S4', sessionId: state.sessionId, instanceId: state.instanceId, reason: 'switch' },
    ]);

    const { state: switched, commands } = reduce(stopping, {
      type: 'stop-complete',
      newSessionId: '20260919T220000Z-b2c3d4',
    });
    expect(switched.phase).toBe('starting');
    expect(switched.worldId).toBe('test-b');
    expect(switched.sessionId).toBe('20260919T220000Z-b2c3d4');
    expect(writes(commands)).toEqual([
      {
        kind: 'S5',
        sessionId: state.sessionId,
        instanceId: state.instanceId,
        newSessionId: '20260919T220000Z-b2c3d4',
        newWorldId: 'test-b',
        desiredBy: '76500000000000002',
        desiredByNickname: 'Friend',
      },
    ]);
    // S6 is never attempted at all on an in-place switch.
    expect(commands.some((c) => c.type === 'write' && c.write.kind === 'S6')).toBe(false);
  });

  it('a world requested during shutdown is started instead of terminating', () => {
    const stoppingState = baseState({
      phase: 'stopping',
      stopping: { reason: 'idle', next: null },
    });
    const { state: queued, commands } = reduce(stoppingState, {
      type: 'desired-changed',
      desiredWorldId: 'test-b',
      desiredBy: '76500000000000002',
      desiredByNickname: 'Friend',
    });
    expect(queued.phase).toBe('stopping'); // still finishing the current stop
    expect(queued.stopping).toEqual({ reason: 'idle', next: 'test-b' });
    expect(commands).toEqual([]); // nothing new happens yet; queued only

    const { state: switched, commands: finishCommands } = reduce(queued, {
      type: 'stop-complete',
      newSessionId: '20260919T230000Z-c3d4e5',
    });
    expect(switched.phase).toBe('starting');
    expect(switched.worldId).toBe('test-b');
    expect(finishCommands.some((c) => c.type === 'shutdown')).toBe(false);
    expect(writes(finishCommands)).toEqual([
      {
        kind: 'S5',
        sessionId: stoppingState.sessionId,
        instanceId: stoppingState.instanceId,
        newSessionId: '20260919T230000Z-c3d4e5',
        newWorldId: 'test-b',
        desiredBy: '76500000000000002',
        desiredByNickname: 'Friend',
      },
    ]);
  });

  it('re-asserting the already-running world while running is a no-op', () => {
    const state = baseState({ phase: 'running', worldId: 'test-a' });
    const { state: next, commands } = reduce(state, {
      type: 'desired-changed',
      desiredWorldId: 'test-a',
      desiredBy: state.desiredBy,
      desiredByNickname: state.desiredByNickname,
    });
    expect(next.phase).toBe('running');
    expect(commands).toEqual([]);
  });

  it('a desired change while installing/boot only records the desire (no stop yet)', () => {
    const state = baseState({ phase: 'installing' });
    const { state: next, commands } = reduce(state, {
      type: 'desired-changed',
      desiredWorldId: null,
      desiredBy: null,
      desiredByNickname: null,
    });
    expect(next.desiredWorldId).toBeNull();
    expect(next.phase).toBe('installing');
    expect(commands).toEqual([]);
  });
});

describe('reduce: S6 condition failure', () => {
  it("write S6's condition failing starts the desired world instead of shutting down", () => {
    const state = baseState({ phase: 'stopping', stopping: { reason: 'idle', next: null } });
    const { state: next, commands } = reduce(state, {
      type: 's6-condition-failed',
      desiredWorldId: 'test-b',
      newSessionId: '20260919T230500Z-d4e5f6',
    });
    expect(next.phase).toBe('starting');
    expect(next.worldId).toBe('test-b');
    expect(commands.some((c) => c.type === 'shutdown')).toBe(false);
    expect(writes(commands)).toEqual([
      {
        kind: 'S5',
        sessionId: state.sessionId,
        instanceId: state.instanceId,
        newSessionId: '20260919T230500Z-d4e5f6',
        newWorldId: 'test-b',
        desiredBy: state.desiredBy ?? 'reaper',
        desiredByNickname: state.desiredByNickname ?? 'reaper',
      },
    ]);
  });
});

describe('reduce: shard-exited', () => {
  it('shard exit while running stops with reason crash and pushes the save', () => {
    const state = baseState({ phase: 'running', loadCompleted: true });
    const { state: stopping, commands: stopCommands } = reduce(state, {
      type: 'shard-exited',
      shard: 'Master',
    });
    expect(stopping.phase).toBe('stopping');
    expect(stopping.stopping?.reason).toBe('crash');
    expect(writes(stopCommands)).toEqual([
      { kind: 'S4', sessionId: state.sessionId, instanceId: state.instanceId, reason: 'crash' },
    ]);
    const { commands } = reduce(stopping, { type: 'stop-complete', newSessionId: null });
    expect(commands).toContainEqual({ type: 'push-save' });
  });

  it('shard exit while starting stops with reason crash and does not push', () => {
    const state = baseState({ phase: 'starting', loadCompleted: false });
    const { state: stopping } = reduce(state, { type: 'shard-exited', shard: 'Caves' });
    expect(stopping.stopping?.reason).toBe('crash');
    const { commands } = reduce(stopping, { type: 'stop-complete', newSessionId: null });
    expect(commands).not.toContainEqual({ type: 'push-save' });
  });

  it('a shard exit while installing or already stopping/halted is ignored', () => {
    const installing = baseState({ phase: 'installing' });
    expect(reduce(installing, { type: 'shard-exited', shard: 'Master' }).commands).toEqual([]);
    const halted = baseState({ phase: 'halted' });
    expect(reduce(halted, { type: 'shard-exited', shard: 'Master' }).commands).toEqual([]);
  });
});

describe('reduce: boot-timeout', () => {
  it('a boot that never becomes joinable within 15 minutes stops with reason crash', () => {
    const state = baseState({ phase: 'starting', loadCompleted: false });
    const { state: stopping, commands } = reduce(state, { type: 'boot-timeout' });
    expect(stopping.phase).toBe('stopping');
    expect(stopping.stopping?.reason).toBe('crash');
    expect(writes(commands)).toEqual([
      { kind: 'S4', sessionId: state.sessionId, instanceId: state.instanceId, reason: 'crash' },
    ]);
  });

  it('a boot-timeout event outside "starting" is ignored', () => {
    const state = baseState({ phase: 'running' });
    expect(reduce(state, { type: 'boot-timeout' }).commands).toEqual([]);
  });
});

describe('reduce: idle-timeout', () => {
  it('idle timeout while running stops with reason idle', () => {
    const state = baseState({ phase: 'running' });
    const { state: stopping, commands } = reduce(state, { type: 'idle-timeout' });
    expect(stopping.stopping?.reason).toBe('idle');
    expect(writes(commands)).toEqual([
      { kind: 'S4', sessionId: state.sessionId, instanceId: state.instanceId, reason: 'idle' },
    ]);
  });

  it('idle-timeout outside "running" is ignored', () => {
    const state = baseState({ phase: 'starting' });
    expect(reduce(state, { type: 'idle-timeout' }).commands).toEqual([]);
  });
});

describe('reduce: load-completed', () => {
  it('records that the Master logged LOAD BE: done', () => {
    const state = baseState({ loadCompleted: false });
    const { state: next } = reduce(state, { type: 'load-completed' });
    expect(next.loadCompleted).toBe(true);
  });
});

describe('reduce: every write carries the session/instance condition', () => {
  it('every emitted write command carries this state’s sessionId and instanceId', () => {
    const state = baseState({ phase: 'running' });
    const scenarios: Array<() => ReturnType<typeof reduce>> = [
      () => reduce(state, { type: 'shard-exited', shard: 'Master' }),
      () => reduce(state, { type: 'idle-timeout' }),
      () =>
        reduce(state, {
          type: 'desired-changed',
          desiredWorldId: null,
          desiredBy: null,
          desiredByNickname: null,
        }),
    ];
    for (const run of scenarios) {
      const { commands } = run();
      for (const w of writes(commands)) {
        expect(w.sessionId).toBe(state.sessionId);
        expect(w.instanceId).toBe(state.instanceId);
      }
    }
  });
});
