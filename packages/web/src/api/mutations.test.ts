import { afterEach, describe, expect, it, vi } from 'vitest';
import { MutationObserver, QueryClient, QueryObserver } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import type { WorldsResponse } from '@dst/shared';
import { ApiError } from './client';
import { mapMutationError, optimisticWorldsUpdate, signOutMutationOptions } from './mutations';

vi.mock('@mantine/notifications', () => ({
  notifications: { show: vi.fn() },
}));

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

describe('signOutMutationOptions (exercised the way useSignOut uses it, via MutationObserver — see docs/web.md §4)', () => {
  afterEach(() => {
    vi.mocked(fetch).mockReset();
    vi.mocked(notifications.show).mockReset();
  });

  it('surfaces a notification, and does not clear the session, when POST /api/auth/logout fails', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'internal', message: 'boom' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const queryClient = new QueryClient();
    queryClient.setQueryData(['me'], { nickname: 'Dev' });
    const observer = new MutationObserver(queryClient, signOutMutationOptions(queryClient));

    await expect(observer.mutate()).rejects.toBeInstanceOf(ApiError);

    expect(notifications.show).toHaveBeenCalledWith({
      color: 'red',
      title: "That didn't work",
      message: 'Try again in a moment.',
    });
    // A failed sign-out must not silently leave the UI believing it worked.
    expect(queryClient.getQueryData(['me'])).toEqual({ nickname: 'Dev' });
  });

  it('clears the session without a notification when logout 401s (already signed out)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: 'unauthorized', message: 'nope' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const queryClient = new QueryClient();
    queryClient.setQueryData(['me'], { nickname: 'Dev' });
    const observer = new MutationObserver(queryClient, signOutMutationOptions(queryClient));

    await expect(observer.mutate()).rejects.toBeInstanceOf(ApiError);

    expect(notifications.show).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(['me'])).toBeNull();
  });

  it('clears the session with no notification on a successful sign-out', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const queryClient = new QueryClient();
    queryClient.setQueryData(['me'], { nickname: 'Dev' });
    queryClient.setQueryData(['worlds'], { worlds: [] });
    const observer = new MutationObserver(queryClient, signOutMutationOptions(queryClient));

    await observer.mutate();

    expect(notifications.show).not.toHaveBeenCalled();
    expect(queryClient.getQueryData(['me'])).toBeNull();
    expect(queryClient.getQueryData(['worlds'])).toBeUndefined();
  });

  it('updates the live ["me"] observer to null on success, instead of orphaning it (the bug: App reads this observer to decide which screen to render)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 204 }));
    const queryClient = new QueryClient();
    queryClient.setQueryData(['me'], { nickname: 'Dev' });

    // Mirrors `useMe()` in src/api/queries.ts: a query observer that stays mounted across the
    // sign-out, the way App's `useMe()` does — this is what must see the transition to
    // signed-out, not just the cache entry in isolation.
    const meObserver = new QueryObserver(queryClient, { queryKey: ['me'] });
    const seen: unknown[] = [];
    const unsubscribe = meObserver.subscribe((result) => {
      seen.push(result.data);
    });

    const mutationObserver = new MutationObserver(queryClient, signOutMutationOptions(queryClient));
    await mutationObserver.mutate();

    unsubscribe();

    expect(meObserver.getCurrentResult().data).toBeNull();
    expect(seen).toContain(null);
  });
});
