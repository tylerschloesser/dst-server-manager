// docs/web.md §4: useMe / useWorlds. Types come from @dst/shared (decisions §16.2); nothing here
// redefines them.
import { useEffect } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { MeResponse, WorldsResponse } from '@dst/shared';
import { apiGet, ApiError } from './client';

/** A 401 resolves to `null` (signed out) instead of throwing, so `App` can branch on
 *  `data === null` without a try/catch at the call site. */
export async function fetchMe(): Promise<MeResponse | null> {
  try {
    return await apiGet<MeResponse>('/api/me');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: fetchMe,
    staleTime: 60_000,
  });
}

/** docs/decisions.md §11 / docs/web.md §4: 5 s while the active world is not `stopped`,
 *  30 s otherwise (and whenever there is no active world at all). */
export function worldsRefetchInterval(data: WorldsResponse | undefined): number {
  const status = data?.active?.status;
  return status && status !== 'stopped' ? 5_000 : 30_000;
}

/** A 401 on the worlds poll means the session died; drop back to the signed-out screen. */
export function handleWorldsError(error: unknown, queryClient: QueryClient): void {
  if (error instanceof ApiError && error.status === 401) {
    queryClient.setQueryData(['me'], null);
  }
}

export function useWorlds(enabled = true) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ['worlds'],
    queryFn: () => apiGet<WorldsResponse>('/api/worlds'),
    enabled,
    refetchInterval: (q) => worldsRefetchInterval(q.state.data),
    refetchIntervalInBackground: false,
  });

  useEffect(() => {
    if (query.error) handleWorldsError(query.error, queryClient);
  }, [query.error, queryClient]);

  return query;
}
