// @dst/supervisor core: the reconcile state machine (docs/game-server.md §8, §12; write
// expressions in docs/control-plane.md §2). `reduce(state, event) => { state, commands }` is the
// only place phase transitions happen; `src/index.ts` (a later task) executes the returned
// commands through the ports in core/types.ts.
import type { StopReason } from '@dst/shared';

import type { ReconcileEvent, ReconcileCommand, ReconcileState, Shard } from './types';

/** Which shards a world with `hasCaves` starts/polls — `false` never starts or polls Caves. */
export function shardsFor(hasCaves: boolean): readonly Shard[] {
  return hasCaves ? ['Master', 'Caves'] : ['Master'];
}

/** Caves is always stopped before Master (docs/game-server.md §9): its `c_shutdown` needs a live
 *  Master, and an orphaned Caves can never be saved or stopped. */
export function stopOrder(shards: readonly Shard[]): readonly Shard[] {
  return [...shards].sort((a, b) => {
    if (a === b) return 0;
    return a === 'Caves' ? -1 : 1;
  });
}

/**
 * The supervisor's own boot-time orphan check (docs/game-server.md §8): "If `sessionId !== ours`
 * or `status !== 'starting'` this is an orphan." Distinct from the reaper's runtime orphan rule
 * (decisions §16.7), which lives in `packages/api`'s reaper module, not here.
 */
export function isBootOrphan(
  ownSessionId: string,
  state: { readonly sessionId: string | null; readonly status: string },
): boolean {
  return state.sessionId !== ownSessionId || state.status !== 'starting';
}

/**
 * `next` is the world to start on this same instance once the stop finishes, or `null` to halt.
 * `next === state.worldId` is **not** a switch — it is the supervisor's own `desiredWorldId`, still
 * naming the world it is stopping — so it collapses to `null` and the session ends.
 *
 * A stop that ends in `null` for any reason but `user` also emits **S8** (release the desire; on a
 * `user` stop W3 has already nulled it). S6 is conditional on
 * `desiredWorldId` already being null, and on a self-initiated stop (`idle`, `crash`) nothing else
 * ever nulls it: without S8 that condition fails, the `s6-condition-failed` branch below reads the
 * world's own id back out of `desiredWorldId` and restarts it, and an idle world can never stop
 * itself (measured: docs/_first-boot-notes.md round 3). S8 is conditional on `desiredWorldId` still
 * being this world, so a start that lands during the stop still wins and still takes the S5 path.
 */
function beginStop(
  state: ReconcileState,
  reason: StopReason,
  nextRequest: string | null,
): { state: ReconcileState; commands: ReconcileCommand[] } {
  const next = nextRequest === state.worldId ? null : nextRequest;
  const commands: ReconcileCommand[] = [
    {
      type: 'write',
      write: { kind: 'S4', sessionId: state.sessionId, instanceId: state.instanceId, reason },
    },
  ];
  if (next === null && reason !== 'user') {
    commands.push({
      type: 'write',
      write: {
        kind: 'S8',
        sessionId: state.sessionId,
        instanceId: state.instanceId,
        worldId: state.worldId,
      },
    });
  }
  commands.push({ type: 'stop-shards', shards: stopOrder(shardsFor(state.hasCaves)) });
  return {
    state: { ...state, phase: 'stopping', stopping: { reason, next } },
    commands,
  };
}

/**
 * The pure reconcile step. Every `write` command it emits carries the current `sessionId` and
 * `instanceId` (docs/decisions.md §6: "every supervisor write is conditional on
 * `sessionId`/`instanceId` being its own").
 */
export function reduce(
  state: ReconcileState,
  event: ReconcileEvent,
): { state: ReconcileState; commands: ReconcileCommand[] } {
  switch (event.type) {
    case 'orphan':
      // Boot-time orphan: log, write nothing, shutdown -h now (docs/game-server.md §8).
      return { state: { ...state, phase: 'halted' }, commands: [{ type: 'halt' }] };

    case 'load-completed':
      return { state: { ...state, loadCompleted: true }, commands: [] };

    case 'desired-changed': {
      const { desiredWorldId, desiredBy, desiredByNickname } = event;
      const withDesired: ReconcileState = {
        ...state,
        desiredWorldId,
        desiredBy,
        desiredByNickname,
      };

      if (state.phase === 'stopping') {
        // "A world requested during shutdown is started instead of terminating" (decisions §6):
        // queue it as the stop's `next` instead of touching anything else right now.
        return {
          state: {
            ...withDesired,
            stopping:
              state.stopping === null
                ? null
                : { reason: state.stopping.reason, next: desiredWorldId },
          },
          commands: [],
        };
      }

      if (state.phase !== 'starting' && state.phase !== 'running') {
        return { state: withDesired, commands: [] };
      }

      if (desiredWorldId === state.worldId) {
        return { state: withDesired, commands: [] }; // no-op: re-asserting the running world
      }

      const reason: StopReason = desiredWorldId === null ? 'user' : 'switch';
      return beginStop(withDesired, reason, desiredWorldId);
    }

    case 'shard-exited': {
      if (state.phase !== 'starting' && state.phase !== 'running') {
        return { state, commands: [] };
      }
      return beginStop(state, 'crash', state.desiredWorldId);
    }

    case 'boot-timeout': {
      if (state.phase !== 'starting') return { state, commands: [] };
      return beginStop(state, 'crash', state.desiredWorldId);
    }

    case 'idle-timeout': {
      if (state.phase !== 'running') return { state, commands: [] };
      return beginStop(state, 'idle', state.desiredWorldId);
    }

    case 'stop-complete': {
      if (state.stopping === null) return { state, commands: [] };
      const { reason, next } = state.stopping;
      const commands: ReconcileCommand[] = [];
      // decisions §16.15: pushed only if the Master ever logged `LOAD BE: done`.
      if (state.loadCompleted) commands.push({ type: 'push-save' });
      commands.push({ type: 'upload-logs' });

      if (next !== null && event.newSessionId !== null) {
        // In-place switch: write S5 directly, never attempt S6 at all (docs/game-server.md §8).
        commands.push({
          type: 'write',
          write: {
            kind: 'S5',
            sessionId: state.sessionId,
            instanceId: state.instanceId,
            newSessionId: event.newSessionId,
            newWorldId: next,
            desiredBy: state.desiredBy ?? 'reaper',
            desiredByNickname: state.desiredByNickname ?? 'reaper',
          },
        });
        return {
          state: {
            ...state,
            phase: 'starting',
            sessionId: event.newSessionId,
            worldId: next,
            loadCompleted: false,
            stopping: null,
          },
          commands,
        };
      }

      commands.push({
        type: 'write',
        write: { kind: 'S6', sessionId: state.sessionId, instanceId: state.instanceId, reason },
      });
      commands.push({ type: 'shutdown' });
      return { state: { ...state, phase: 'halted', stopping: null }, commands };
    }

    case 's6-condition-failed': {
      // The S6 write's ConditionExpression failed: someone asked for a world during shutdown
      // (docs/control-plane.md §2 "S6"). Start it instead of terminating.
      return {
        state: {
          ...state,
          phase: 'starting',
          sessionId: event.newSessionId,
          worldId: event.desiredWorldId,
          desiredWorldId: event.desiredWorldId,
          loadCompleted: false,
          stopping: null,
        },
        commands: [
          {
            type: 'write',
            write: {
              kind: 'S5',
              sessionId: state.sessionId,
              instanceId: state.instanceId,
              newSessionId: event.newSessionId,
              newWorldId: event.desiredWorldId,
              desiredBy: state.desiredBy ?? 'reaper',
              desiredByNickname: state.desiredByNickname ?? 'reaper',
            },
          },
        ],
      };
    }
  }
}
