// docs/web.md §4: start/stop/sign-out, all bodyless POSTs through src/api/client.ts.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { QueryClient, UseMutationOptions } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import type { ClusterStatus, WorldsResponse } from '@dst/shared';
import { apiPost, ApiError } from './client';

// Structurally matches Mantine's `NotificationData` (which permits arbitrary `data-*` props via
// an index signature) so it can be passed to `notifications.show` without a cast.
export interface MutationErrorNotification extends Record<`data-${string}`, unknown> {
  color: string;
  title: string;
  message: string;
}

/** Maps a failed start/stop mutation to a notification, or `null` when none should show — a 401
 *  is handled separately, by clearing the signed-in state. */
export function mapMutationError(err: unknown): MutationErrorNotification | null {
  if (err instanceof ApiError) {
    if (err.status === 401) return null;
    if (err.status === 403) {
      return {
        color: 'red',
        title: 'Not allowed',
        message: "Your account isn't on the allowlist anymore.",
      };
    }
    if (err.status === 409) {
      return {
        color: 'yellow',
        title: 'Server busy',
        message: 'Another world is already starting. Try again in a moment.',
      };
    }
  }
  return { color: 'red', title: "That didn't work", message: 'Try again in a moment.' };
}

/** Optimistic patch applied to the cached `WorldsResponse` before the request resolves
 *  (docs/web.md §4); `onSettled`'s invalidate is the backstop either way. */
export function optimisticWorldsUpdate(
  previous: WorldsResponse,
  worldId: string,
  action: 'start' | 'stop',
): WorldsResponse {
  if (action === 'stop') {
    if (!previous.active || previous.active.worldId !== worldId) return previous;
    return { ...previous, active: { ...previous.active, status: 'stopping' } };
  }
  const status: ClusterStatus = 'starting';
  const reusePrevious = previous.active?.worldId === worldId ? previous.active : null;
  return {
    ...previous,
    active: {
      worldId,
      status,
      stale: false,
      startedBy: reusePrevious?.startedBy ?? null,
      startedAt: reusePrevious?.startedAt ?? null,
      playerCount: reusePrevious?.playerCount ?? null,
      idleDeadline: reusePrevious?.idleDeadline ?? null,
      join: null,
    },
  };
}

interface MutationContext {
  previous: WorldsResponse | undefined;
}

function useWorldMutation(action: 'start' | 'stop') {
  const queryClient = useQueryClient();
  return useMutation<WorldsResponse, unknown, string, MutationContext>({
    mutationFn: async (worldId: string) => {
      const res = await apiPost(`/api/worlds/${worldId}/${action}`);
      return (await res.json()) as WorldsResponse;
    },
    onMutate: async (worldId: string) => {
      await queryClient.cancelQueries({ queryKey: ['worlds'] });
      const previous = queryClient.getQueryData<WorldsResponse>(['worlds']);
      if (previous) {
        queryClient.setQueryData<WorldsResponse>(
          ['worlds'],
          optimisticWorldsUpdate(previous, worldId, action),
        );
      }
      return { previous };
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['worlds'], data);
    },
    onError: (err, _worldId, context) => {
      if (context?.previous) {
        queryClient.setQueryData(['worlds'], context.previous);
      }
      if (err instanceof ApiError && err.status === 401) {
        queryClient.setQueryData(['me'], null);
        return;
      }
      const notification = mapMutationError(err);
      if (notification) notifications.show(notification);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ['worlds'] });
    },
  });
}

export function useStartWorld() {
  return useWorldMutation('start');
}

export function useStopWorld() {
  return useWorldMutation('stop');
}

/** Extracted from `useSignOut` so a failed sign-out's error handling — the same
 *  401-clears-session / `mapMutationError`-then-notify treatment every other mutation in this
 *  package uses — can be exercised directly in tests, without rendering a component. */
export function signOutMutationOptions(
  queryClient: QueryClient,
): UseMutationOptions<void, unknown, void> {
  return {
    mutationFn: async () => {
      await apiPost('/api/auth/logout');
    },
    onSuccess: () => {
      queryClient.clear();
      queryClient.setQueryData(['me'], null);
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 401) {
        queryClient.setQueryData(['me'], null);
        return;
      }
      const notification = mapMutationError(err);
      if (notification) notifications.show(notification);
    },
  };
}

export function useSignOut() {
  const queryClient = useQueryClient();
  return useMutation(signOutMutationOptions(queryClient));
}
