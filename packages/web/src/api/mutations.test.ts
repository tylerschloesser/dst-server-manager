import { describe, expect, it } from 'vitest';
import type { WorldsResponse } from '@dst/shared';
import { ApiError } from './client';
import { mapMutationError, optimisticWorldsUpdate } from './mutations';

describe('mapMutationError', () => {
  it('returns null for a 401 (handled by signing the user out, not a notification)', () => {
    expect(mapMutationError(new ApiError(401, 'unauthorized', 'x'))).toBeNull();
  });

  it('maps 403 to the allowlist notification', () => {
    expect(mapMutationError(new ApiError(403, 'not_allowed', 'x'))).toEqual({
      color: 'red',
      title: 'Not allowed',
      message: "Your account isn't on the allowlist anymore.",
    });
  });

  it('maps 409 to the busy notification', () => {
    expect(mapMutationError(new ApiError(409, 'world_busy', 'x'))).toEqual({
      color: 'yellow',
      title: 'Server busy',
      message: 'Another world is already starting. Try again in a moment.',
    });
  });

  it('maps anything else, including a network error, to a generic retry notification', () => {
    const expected = {
      color: 'red',
      title: "That didn't work",
      message: 'Try again in a moment.',
    };
    expect(mapMutationError(new ApiError(500, 'internal', 'x'))).toEqual(expected);
    expect(mapMutationError(new Error('network down'))).toEqual(expected);
  });
});

const emptyWorlds: WorldsResponse = {
  worlds: [],
  active: null,
  lastStopReason: null,
  lastError: null,
};

describe('optimisticWorldsUpdate', () => {
  it('sets a starting active block for the start target', () => {
    const result = optimisticWorldsUpdate(emptyWorlds, 'test-a', 'start');

    expect(result.active).toEqual({
      worldId: 'test-a',
      status: 'starting',
      stale: false,
      startedBy: null,
      startedAt: null,
      playerCount: null,
      idleDeadline: null,
      join: null,
    });
  });

  it('sets the active world to stopping', () => {
    const running: WorldsResponse = {
      ...emptyWorlds,
      active: {
        worldId: 'test-a',
        status: 'running',
        stale: false,
        startedBy: 'Dev',
        startedAt: null,
        playerCount: 0,
        idleDeadline: null,
        join: null,
      },
    };

    const result = optimisticWorldsUpdate(running, 'test-a', 'stop');

    expect(result.active?.status).toBe('stopping');
    expect(result.active?.startedBy).toBe('Dev');
  });

  it('leaves state untouched when stopping a world that is not active', () => {
    const running: WorldsResponse = {
      ...emptyWorlds,
      active: {
        worldId: 'test-a',
        status: 'running',
        stale: false,
        startedBy: 'Dev',
        startedAt: null,
        playerCount: 0,
        idleDeadline: null,
        join: null,
      },
    };

    const result = optimisticWorldsUpdate(running, 'test-b', 'stop');

    expect(result).toBe(running);
  });
});
