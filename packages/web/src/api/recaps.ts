// docs/web.md §4: the recap query and the three note mutations (docs/control-plane.md §5.6, §5.7).
import { useEffect, useRef } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient, UseMutationOptions } from '@tanstack/react-query';
import { notifications } from '@mantine/notifications';
import { NOTE_HEADER } from '@dst/shared/recap';
import type { ClusterStatus, NotesResponse, RecapsResponse } from '@dst/shared';
import { apiGet, apiPost, ApiError } from './client';
import { mapMutationError } from './mutations';
import { handleWorldsError } from './queries';

export function recapsQueryKey(worldId: string): ['recaps', string] {
  return ['recaps', worldId];
}

export function fetchRecaps(worldId: string): Promise<RecapsResponse> {
  return apiGet<RecapsResponse>(`/api/worlds/${encodeURIComponent(worldId)}/recaps`);
}

/** A note write is bodyless: the text is URI-encoded in `x-dst-note` (the client never sends a
 *  body, see `client.ts`). */
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
  useRefetchAfterStop(recapsQueryKey(worldId), status);

  return query;
}

/** A session just ended: its digest follows within a minute or so of `stopped`, so look again on
 *  the transition and once more a little later. Shared by the recap and the map. */
export function useRefetchAfterStop(queryKey: readonly unknown[], status: ClusterStatus): void {
  const queryClient = useQueryClient();
  const previous = useRef(status);
  const key = JSON.stringify(queryKey);
  useEffect(() => {
    const was = previous.current;
    previous.current = status;
    if (status !== 'stopped' || was === 'stopped') return;
    const queryKey = JSON.parse(key) as unknown[];
    void queryClient.invalidateQueries({ queryKey });
    const timer = setTimeout(() => {
      void queryClient.invalidateQueries({ queryKey });
    }, 90_000);
    return () => clearTimeout(timer);
  }, [status, key, queryClient]);
}

function notesPath(worldId: string, ...rest: string[]): string {
  return [`/api/worlds/${encodeURIComponent(worldId)}/notes`, ...rest.map(encodeURIComponent)].join(
    '/',
  );
}

/** The one shape of every note write: a bodyless POST that answers with the whole list, which
 *  replaces `notes` in the cached recaps. */
function noteMutationOptions<V>(
  queryClient: QueryClient,
  worldId: string,
  request: (vars: V) => { path: string; headers?: Record<string, string> },
  failTitle: string,
): UseMutationOptions<NotesResponse, unknown, V> {
  return {
    mutationFn: async (vars: V) => {
      const { path, headers } = request(vars);
      const res = await apiPost(path, headers);
      return (await res.json()) as NotesResponse;
    },
    onSuccess: (data) => {
      queryClient.setQueryData<RecapsResponse>(recapsQueryKey(worldId), (old) =>
        old ? { ...old, notes: data.notes } : old,
      );
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 401) {
        queryClient.setQueryData(['me'], null);
        return;
      }
      if (err instanceof ApiError && err.code === 'note_not_found') {
        // Someone else deleted it: show the list as it now stands.
        void queryClient.invalidateQueries({ queryKey: recapsQueryKey(worldId) });
        notifications.show({
          color: 'yellow',
          title: failTitle,
          message: 'Someone deleted that note.',
        });
        return;
      }
      if (
        err instanceof ApiError &&
        (err.code === 'invalid_note' || err.code === 'too_many_notes')
      ) {
        notifications.show({ color: 'yellow', title: failTitle, message: err.message });
        return;
      }
      const notification = mapMutationError(err);
      if (notification) notifications.show(notification);
    },
  };
}

export function addNoteMutationOptions(queryClient: QueryClient, worldId: string) {
  return noteMutationOptions(
    queryClient,
    worldId,
    (text: string) => ({ path: notesPath(worldId), headers: noteHeaders(text) }),
    "Couldn't save the note",
  );
}

export function editNoteMutationOptions(queryClient: QueryClient, worldId: string) {
  return noteMutationOptions(
    queryClient,
    worldId,
    ({ id, text }: { id: string; text: string }) => ({
      path: notesPath(worldId, id),
      headers: noteHeaders(text),
    }),
    "Couldn't save the note",
  );
}

export function deleteNoteMutationOptions(queryClient: QueryClient, worldId: string) {
  return noteMutationOptions(
    queryClient,
    worldId,
    (id: string) => ({ path: notesPath(worldId, id, 'delete') }),
    "Couldn't delete the note",
  );
}

export function useAddNote(worldId: string) {
  const queryClient = useQueryClient();
  return useMutation(addNoteMutationOptions(queryClient, worldId));
}

export function useEditNote(worldId: string) {
  const queryClient = useQueryClient();
  return useMutation(editNoteMutationOptions(queryClient, worldId));
}

export function useDeleteNote(worldId: string) {
  const queryClient = useQueryClient();
  return useMutation(deleteNoteMutationOptions(queryClient, worldId));
}
