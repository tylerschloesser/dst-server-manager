// GET /api/worlds/{id}/map (docs/control-plane.md §5.8, docs/decisions.md §19): every player's
// map as of their last session in this world, each already cut to that player's reveal.
import type { MapResponse } from '@dst/shared';

import type { MapStore } from '../ports';
import { toMapResponse } from '../recaps/map-view';

export interface MapDeps {
  maps: MapStore;
}

export async function buildMapResponse(
  deps: MapDeps,
  worldId: string,
  /** `null` for a guest: no map is theirs, so none is `isViewer`. */
  viewerSteamId64: string | null,
  nicknames: Record<string, string>,
): Promise<MapResponse> {
  return toMapResponse(await deps.maps.findAll(worldId), worldId, viewerSteamId64, nicknames);
}
