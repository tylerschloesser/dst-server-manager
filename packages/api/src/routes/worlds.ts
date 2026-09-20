// GET /api/worlds, POST .../start, POST .../stop (docs/control-plane.md §3, §5.4). Every mutation
// is an attempt loop over a conditional write: read, decide, write; on a failed condition, re-read
// and re-decide, up to MAX_ATTEMPTS (docs/control-plane.md §3.1).
import {
  GAME_REGION,
  PARAM_CLUSTER_PASSWORD,
  deriveWorldsResponse,
  isJoinable,
  newSessionId,
} from '@dst/shared';
import type { ClusterStateItem, WorldRegistryItem, WorldsResponse } from '@dst/shared';

import type { Clock, Launcher, ParameterStore, StateStore, WorldRegistry } from '../ports';

const MAX_ATTEMPTS = 3;

export interface WorldsDeps {
  clock: Clock;
  store: StateStore;
  registry: WorldRegistry;
  params: ParameterStore;
  launcher: Launcher;
}

export interface MutationOk {
  kind: 'ok';
  body: WorldsResponse;
}

export interface MutationError {
  kind: 'error';
  status: number;
  code: 'world_busy' | 'state_conflict' | 'launch_failed';
  message: string;
}

export type MutationResult = MutationOk | MutationError;

async function activeWorldFor(
  registry: WorldRegistry,
  state: ClusterStateItem,
): Promise<WorldRegistryItem | null> {
  if (state.worldId === null) return null;
  return registry.get(state.worldId);
}

/** Builds the exact `GET /api/worlds` body (docs/control-plane.md §5.4) from whatever the state
 * item currently holds — used both by `GET /api/worlds` itself and by the mutations, which return
 * this same shape built from the state they just wrote (decisions §16.9). */
export async function buildWorldsResponse(deps: WorldsDeps): Promise<WorldsResponse> {
  const [worlds, state] = await Promise.all([deps.registry.list(), deps.store.get()]);
  const now = deps.clock.now();
  const activeWorld = await activeWorldFor(deps.registry, state);

  let password: string | null = null;
  if (activeWorld !== null && isJoinable(state)) {
    password = await deps.params.get(PARAM_CLUSTER_PASSWORD, GAME_REGION);
  }

  return deriveWorldsResponse({ worlds, activeWorld, state, now, password });
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 200);
  return String(err).slice(0, 200);
}

/** docs/control-plane.md §3.2. */
export async function startWorld(
  deps: WorldsDeps,
  worldId: string,
  user: { steamId64: string; nickname: string },
): Promise<MutationResult> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const state = await deps.store.get();
    const now = deps.clock.now();

    if (state.status === 'stopped') {
      const sessionId = newSessionId(now);
      const ok = await deps.store.startFresh({
        worldId,
        sessionId,
        steamId64: user.steamId64,
        nickname: user.nickname,
        now,
      });
      if (!ok) continue;

      try {
        await deps.launcher.launch({ sessionId, worldId });
      } catch (err) {
        const message = describeError(err);
        await deps.store.rollbackLaunch({ sessionId, error: message, now: deps.clock.now() });
        return {
          kind: 'error',
          status: 503,
          code: 'launch_failed',
          message: 'Could not start an instance right now',
        };
      }

      return { kind: 'ok', body: await buildWorldsResponse(deps) };
    }

    if (state.status === 'starting' && state.worldId !== worldId) {
      return {
        kind: 'error',
        status: 409,
        code: 'world_busy',
        message: 'Another world is starting',
      };
    }

    // starting W, running W, running X (switch), stopping W, stopping X: all re-assert desire
    // (docs/control-plane.md §3.2). `sessionId` is always non-null here: only `stopped` has a null
    // sessionId (S6), and every branch above already handled `stopped`.
    const expectedSessionId = state.sessionId;
    if (expectedSessionId === null) continue; // defensive: re-read and re-decide

    const ok = await deps.store.setDesired({
      worldId,
      steamId64: user.steamId64,
      nickname: user.nickname,
      expectedStatus: state.status,
      expectedSessionId,
      now,
    });
    if (!ok) continue;

    return { kind: 'ok', body: await buildWorldsResponse(deps) };
  }

  return {
    kind: 'error',
    status: 409,
    code: 'state_conflict',
    message: 'Too many concurrent updates',
  };
}

/** docs/control-plane.md §3.3. */
export async function stopWorld(
  deps: WorldsDeps,
  worldId: string,
  user: { steamId64: string; nickname: string },
): Promise<MutationResult> {
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const state = await deps.store.get();
    const now = deps.clock.now();

    if (state.status === 'stopped' || state.worldId !== worldId) {
      return { kind: 'ok', body: await buildWorldsResponse(deps) };
    }

    const ok = await deps.store.clearDesired({
      worldId,
      steamId64: user.steamId64,
      nickname: user.nickname,
      now,
    });
    if (!ok) continue; // re-read: might now be stopped, or worldId may have changed -> no-op above

    return { kind: 'ok', body: await buildWorldsResponse(deps) };
  }

  return {
    kind: 'error',
    status: 409,
    code: 'state_conflict',
    message: 'Too many concurrent updates',
  };
}
