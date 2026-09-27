// The map half of the digest (docs/decisions.md §19): per shard, the terrain as a one-byte palette
// grid and the things worth drawing on it. Pure. Written unmasked, per session, under `digest/map/`
// — the API cuts it to each viewer's reveal before anything reaches a browser.
//
// Never fatal: a terrain the digest cannot read costs the map (a `recap.notes` line), never the
// recap.
import { gzipSync } from 'node:zlib';

import { MAP_INDEX_FILE, RECAP_SCHEMA_VERSION, mapTilesFile } from '@dst/shared';
import type { MapContainer, MapTile, RecapMapIndex, RecapShard } from '@dst/shared';

import type { DigestFile } from './digest';
import type { WorldSummary } from './world';
import { tileOf } from './world';

export interface MapInput {
  shards: Partial<Record<RecapShard, WorldSummary>>;
  /** The base centre in world units (surface only), from `baseCentre`. */
  base: { x: number; z: number } | null;
  /** Each player's stop position, by recap ref. */
  stops: { ref: string; shard: RecapShard; x: number; z: number }[];
  /** Which container prefabs are the players' own (the recap's rule: no world-gen loot). */
  isOwnContainer: (prefab: string) => boolean;
  displayName: (prefab: string) => string;
  day: number | null;
  stoppedAt: string | null;
}

export interface MapOutput {
  files: DigestFile[];
  notes: string[];
}

function toTile(w: WorldSummary, x: number, z: number): MapTile | null {
  const t = tileOf(w.map, x, z);
  return t === null ? null : { tx: t.tx, ty: t.ty };
}

export function buildMap(input: MapInput): MapOutput {
  const files: DigestFile[] = [];
  const notes: string[] = [];
  const index: RecapMapIndex = {
    schemaVersion: RECAP_SCHEMA_VERSION,
    day: input.day,
    stoppedAt: input.stoppedAt,
    shards: {},
  };

  for (const [shard, w] of Object.entries(input.shards) as [RecapShard, WorldSummary][]) {
    if (w.terrain === null) {
      notes.push(`no ${shard} map: ${w.terrainError ?? 'no terrain'}`);
      continue;
    }
    // Palette: the tile types present, by name so the bytes do not depend on Klei's numbering.
    const ids = [...new Set(w.terrain.tiles)];
    const names = ids.map((id) => w.terrain!.idToName.get(id)!).sort();
    if (names.length > 255) {
      notes.push(`no ${shard} map: ${names.length} tile types do not fit one byte`);
      continue;
    }
    const byName = new Map(names.map((n, i) => [n, i + 1]));
    const byId = new Map(ids.map((id) => [id, byName.get(w.terrain!.idToName.get(id)!)!]));
    const grid = new Uint8Array(w.terrain.tiles.length);
    for (let i = 0; i < grid.length; i++) grid[i] = byId.get(w.terrain.tiles[i]!)!;

    const containers: MapContainer[] = [];
    for (const c of w.containersPlaced) {
      if (!input.isOwnContainer(c.prefab)) continue;
      const t = toTile(w, c.x, c.z);
      if (t === null) continue;
      containers.push({
        ...t,
        prefab: c.prefab,
        name: input.displayName(c.prefab),
        items: [...c.items]
          .map(([prefab, count]) => ({ prefab, name: input.displayName(prefab), count }))
          .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
      });
    }
    containers.sort((a, b) => a.ty - b.ty || a.tx - b.tx || a.prefab.localeCompare(b.prefab));

    const stops: Record<string, MapTile> = {};
    for (const s of input.stops) {
      if (s.shard !== shard) continue;
      const t = toTile(w, s.x, s.z);
      if (t !== null) stops[s.ref] = t;
    }

    index.shards[shard] = {
      width: w.map.width,
      height: w.map.height,
      palette: names,
      containers,
      base:
        shard === 'master' && input.base !== null ? toTile(w, input.base.x, input.base.z) : null,
      stops,
    };
    files.push({
      path: mapTilesFile(shard),
      body: gzipSync(grid, { level: 9 }),
      contentType: 'application/gzip',
    });
  }

  if (files.length > 0) {
    files.push({
      path: MAP_INDEX_FILE,
      body: Buffer.from(JSON.stringify(index)),
      contentType: 'application/json',
    });
  }
  return { files, notes };
}
