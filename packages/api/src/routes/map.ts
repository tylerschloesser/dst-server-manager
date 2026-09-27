// GET /api/worlds/{id}/map (docs/control-plane.md §5.8, docs/decisions.md §19): the viewer's own
// map as of their last session in this world, already cut to their reveal.
import type { MapResponse } from '@dst/shared';

import type { MapStore } from '../ports';
import { toMapResponse } from '../recaps/map-view';

export interface MapDeps {
  maps: MapStore;
}

export async function buildMapResponse(
  deps: MapDeps,
  worldId: string,
  viewerSteamId64: string,
): Promise<MapResponse> {
  return toMapResponse(await deps.maps.findForViewer(worldId, viewerSteamId64), worldId);
}
