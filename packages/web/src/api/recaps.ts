// docs/web.md §4: the recap query and the note mutation (docs/control-plane.md §5.6, §5.7).
import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient, UseMutationOptions } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { NOTE_HEADER } from '@dst/shared/recap';
import type { ClusterStatus, NoteResponse, RecapsResponse } from '@dst/shared';
import { apiGet, apiPost, ApiError } from './client';
import { mapMutationError } from './mutations';
import { handleWorldsError } from './queries';

export function recapsQueryKey(worldId: string): ['recaps', string] {
  return ['recaps', worldId];
}

export function fetchRecaps(worldId: string): Promise<RecapsResponse> {
  return apiGet<RecapsResponse>(`/api/worlds/${encodeURIComponent(worldId)}/recaps`);
}

/** The note is bodyless: URI-encoded in `x-dst-note` (the client never sends a body, see
 *  `client.ts`). An empty string clears it. */
export function noteHeaders(text: string): Record<string, string> {
  return { [NOTE_HEADER]: encodeURIComponent(text) };
}

export function useRecaps(worldId: string, status: ClusterStatus) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: recapsQueryKey(worldId),
    queryFn: () => fetchRecaps(worldId),
    staleTime: 60_000,
  });

  useEffect(() => {
    if (query.error) handleWorldsError(query.error, queryClient);
  }, [query.error, queryClient]);

  // A session just ended: its digest follows within a minute or so of `stopped`, so look again
  // on the transition and once more a little later.
  const previous = useRef(status);
  useEffect(() => {
    const was = previous.current;
    previous.current = status;
    if (status !== 'stopped' || was === 'stopped') return;
    void queryClient.invalidateQueries({ queryKey: recapsQueryKey(worldId) });
    const timer = setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey: recapsQueryKey(worldId) });
    }, 90_000);
    return () => clearTimeout(timer);
  }, [status, worldId, queryClient]);

  return query;
}

export function saveNoteMutationOptions(
  queryClient: QueryClient,
  worldId: string,
): UseMutationOptions<NoteResponse, unknown, string> {
  return {
    mutationFn: async (text: string) => {
      const res = await apiPost(
        `/api/worlds/${encodeURIComponent(worldId)}/note`,
        noteHeaders(text),
      );
      return (await res.json()) as NoteResponse;
    },
    onSuccess: (data) => {
      queryClient.setQueryData<RecapsResponse>(recapsQueryKey(worldId), (old) =>
        old ? { ...old, note: data.note } : old,
      );
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 401) {
        queryClient.setQueryData(['me'], null);
        return;
      }
      if (err instanceof ApiError && err.code === 'invalid_note') {
        notifications.show({
          color: 'yellow',
          title: "Couldn't save the note",
          message: err.message,
        });
        return;
      }
      const notification = mapMutationError(err);
      if (notification) notifications.show(notification);
    },
  };
}

export function useSaveNote(worldId: string) {
  const queryClient = useQueryClient();
  return useMutation(saveNoteMutationOptions(queryClient, worldId));
}
