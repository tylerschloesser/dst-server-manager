// docs/web.md §4: the viewer's own map (docs/control-plane.md §5.8, docs/decisions.md §19).
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ClusterStatus, MapResponse } from '@dst/shared';
import { apiGet } from './client';
import { handleWorldsError } from './queries';
import { useRefetchAfterStop } from './recaps';

export function mapQueryKey(worldId: string): ['map', string] {
  return ['map', worldId];
}

export function fetchMap(worldId: string): Promise<MapResponse> {
  return apiGet<MapResponse>(`/api/worlds/${encodeURIComponent(worldId)}/map`);
}

export function useWorldMap(worldId: string, status: ClusterStatus) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: mapQueryKey(worldId),
    queryFn: () => fetchMap(worldId),
    staleTime: 5 * 60_000, // a map only changes when a session ends, which refetches it anyway
  });
  useEffect(() => {
    if (query.error) handleWorldsError(query.error, queryClient);
  }, [query.error, queryClient]);
  useRefetchAfterStop(mapQueryKey(worldId), status);
  return query;
}
