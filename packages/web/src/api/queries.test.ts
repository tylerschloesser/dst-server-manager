import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';
import type { WorldsResponse } from '@dst/shared';
import { ApiError } from './client';
import { fetchMe, handleWorldsError, worldsRefetchInterval } from './queries';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('fetchMe', () => {
  afterEach(() => {
    vi.mocked(fetch).mockReset();
  });

  it('returns the parsed body on success', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(200, { nickname: 'Dev' }));

    await expect(fetchMe()).resolves.toEqual({ nickname: 'Dev' });
  });

  it('resolves to null on a 401 instead of throwing', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(401, { error: { code: 'unauthorized' } }));

    await expect(fetchMe()).resolves.toBeNull();
  });

  it('rethrows any other error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(500, { error: { code: 'internal' } }));

    await expect(fetchMe()).rejects.toBeInstanceOf(ApiError);
  });
});

const emptyWorlds: WorldsResponse = {
  worlds: [],
  active: null,
  lastStopReason: null,
  lastError: null,
};

describe('worldsRefetchInterval', () => {
  it('polls every 30s when there is no data yet or no active world', () => {
    expect(worldsRefetchInterval(undefined)).toBe(30_000);
    expect(worldsRefetchInterval(emptyWorlds)).toBe(30_000);
  });

  it('polls every 30s when the active world is stopped', () => {
    const data: WorldsResponse = {
      ...emptyWorlds,
      active: {
        worldId: 'test-a',
        status: 'stopped',
        stale: false,
        startedBy: null,
        startedAt: null,
        playerCount: null,
        idleDeadline: null,
        join: null,
      },
    };
    expect(worldsRefetchInterval(data)).toBe(30_000);
  });

  it('polls every 5s while the active world is starting, running or stopping', () => {
    for (const status of ['starting', 'running', 'stopping'] as const) {
      const data: WorldsResponse = {
        ...emptyWorlds,
        active: {
          worldId: 'test-a',
          status,
          stale: false,
          startedBy: null,
          startedAt: null,
          playerCount: null,
          idleDeadline: null,
          join: null,
        },
      };
      expect(worldsRefetchInterval(data)).toBe(5_000);
    }
  });
});

describe('handleWorldsError', () => {
  it('clears the me query on a 401', () => {
    const setQueryData = vi.fn();
    handleWorldsError(new ApiError(401, 'unauthorized', 'nope'), {
      setQueryData,
    } as unknown as QueryClient);
    expect(setQueryData).toHaveBeenCalledWith(['me'], null);
  });

  it('does nothing for other errors', () => {
    const setQueryData = vi.fn();
    handleWorldsError(new ApiError(500, 'internal', 'oops'), {
      setQueryData,
    } as unknown as QueryClient);
    handleWorldsError(new Error('network'), { setQueryData } as unknown as QueryClient);
    expect(setQueryData).not.toHaveBeenCalled();
  });
});
