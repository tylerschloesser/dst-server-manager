// Stored maps -> every player's map (docs/decisions.md §19, docs/control-plane.md §5.8). THE
// SPOILER AND PRIVACY BOUNDARY for the map, like `view.ts` is for the recap:
//   - each map is masked by its own player's reveal: that player's visited trail dilated by
//     MAP_REVEAL_RADIUS_TILES (a friend's map deliberately shows what the friend has seen);
//   - every tile outside it leaves as 0 (fog), and the palette is cut to the tile types revealed,
//     so not even the *kinds* of unexplored terrain reach the browser;
//   - containers, the base and the stop outside it are dropped;
//   - every field of the untrusted `map/index.json` is validated and copied one by one;
//   - a player is known only by a label (nickname, else persona, redacted); no SteamID64 leaves.
import { gunzipSync, gzipSync } from 'node:zlib';

import { MAP_REVEAL_RADIUS_TILES } from '@dst/shared';
import type {
  MapContainer,
  MapResponse,
  MapShardView,
  MapTile,
  PlayerMap,
  RecapShard,
} from '@dst/shared';

import type { StoredMap } from '../ports';

const MAX_SIDE = 1024; // DST's largest preset is 450×450
const MAX_CONTAINERS = 2000;
const MAX_ITEMS = 100;
const TILE_NAME_RE = /^[A-Z0-9_]{1,40}$/;
const IDENTIFIER_RE = /KU_[A-Za-z0-9_-]+|(?<!\d)7656119\d{10}(?!\d)/g;

type Raw = Record<string, unknown>;
function rec(v: unknown): Raw | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Raw) : null;
}
function int(v: unknown, lo: number, hi: number): number | null {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi ? v : null;
}
function str(v: unknown, max = 80): string | null {
  return typeof v === 'string' && v.length <= max ? v.replace(IDENTIFIER_RE, '[redacted]') : null;
}

export function bitAt(bits: Uint8Array, i: number): boolean {
  return ((bits[i >> 3] ?? 0) & (0x80 >> (i & 7))) !== 0;
}

/** Every tile whose centre is within `r + ½` tiles of a visited tile (the disc the radius was
 *  picked with). One byte per tile, 1 = revealed. */
export function dilate(visited: Uint8Array, width: number, height: number, r: number): Uint8Array {
  const out = new Uint8Array(width * height);
  const offsets: [number, number][] = [];
  for (let dy = -r; dy <= r; dy++)
    for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r + r) offsets.push([dx, dy]);
  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      if (!bitAt(visited, ty * width + tx)) continue;
      for (const [dx, dy] of offsets) {
        const x = tx + dx;
        const y = ty + dy;
        if (x >= 0 && y >= 0 && x < width && y < height) out[y * width + x] = 1;
      }
    }
  }
  return out;
}

function popcount(bits: Uint8Array): number {
  let n = 0;
  for (let b of bits) {
    while (b !== 0) {
      b &= b - 1;
      n++;
    }
  }
  return n;
}

function b64gz(bytes: Uint8Array): string {
  return gzipSync(bytes, { level: 9 }).toString('base64');
}

function tile(v: unknown, width: number, height: number): MapTile | null {
  const r = rec(v);
  const tx = int(r?.['tx'], 0, width - 1);
  const ty = int(r?.['ty'], 0, height - 1);
  return tx === null || ty === null ? null : { tx, ty };
}

function container(v: unknown, width: number, height: number): MapContainer | null {
  const r = rec(v);
  const t = tile(v, width, height);
  const prefab = str(r?.['prefab']);
  if (r === null || t === null || prefab === null) return null;
  const items: MapContainer['items'] = [];
  for (const it of Array.isArray(r['items']) ? r['items'].slice(0, MAX_ITEMS) : []) {
    const ir = rec(it);
    const ip = str(ir?.['prefab']);
    const count = int(ir?.['count'], 1, 1_000_000);
    if (ip !== null && count !== null)
      items.push({ prefab: ip, name: str(ir?.['name']) ?? ip, count });
  }
  return { ...t, prefab, name: str(r['name']) ?? prefab, items };
}

/** One shard, masked. Null when anything about it is malformed: no map beats a wrong map. */
export function toMapShardView(
  indexShard: unknown,
  stored: NonNullable<StoredMap['shards'][RecapShard]>,
  ref: string,
  radius: number = MAP_REVEAL_RADIUS_TILES,
): MapShardView | null {
  const s = rec(indexShard);
  const width = int(s?.['width'], 1, MAX_SIDE);
  const height = int(s?.['height'], 1, MAX_SIDE);
  const rawPalette = s?.['palette'];
  if (s === null || width === null || height === null || !Array.isArray(rawPalette)) return null;
  if (rawPalette.length > 255) return null;
  const palette: string[] = [];
  for (const name of rawPalette) {
    if (typeof name !== 'string' || !TILE_NAME_RE.test(name)) return null;
    palette.push(name);
  }

  let tiles: Buffer;
  try {
    tiles = gunzipSync(stored.tilesGz, { maxOutputLength: width * height + 1 });
  } catch {
    return null;
  }
  const bitmapLen = Math.ceil((width * height) / 8);
  if (tiles.length !== width * height || stored.visited.length !== bitmapLen) return null;
  const fresh =
    stored.fresh !== null && stored.fresh.length === bitmapLen
      ? stored.fresh
      : new Uint8Array(bitmapLen);

  const reveal = dilate(stored.visited, width, height, radius);
  const inReveal = (t: MapTile | null): t is MapTile =>
    t !== null && reveal[t.ty * width + t.tx] === 1;

  // Compact the palette to the revealed tile types, keeping the stored (by-name) order.
  const used = new Uint8Array(palette.length + 1);
  for (let i = 0; i < tiles.length; i++) {
    const v = tiles[i]!;
    if (v === 0 || v > palette.length) return null;
    if (reveal[i] === 1) used[v] = 1;
  }
  const remap = new Uint8Array(palette.length + 1);
  const outPalette: string[] = [];
  for (let v = 1; v <= palette.length; v++) {
    if (used[v] === 1) {
      outPalette.push(palette[v - 1]!);
      remap[v] = outPalette.length;
    }
  }
  const grid = new Uint8Array(width * height);
  for (let i = 0; i < grid.length; i++) if (reveal[i] === 1) grid[i] = remap[tiles[i]!]!;
  const freshMasked = new Uint8Array(bitmapLen);
  for (let i = 0; i < bitmapLen; i++) freshMasked[i] = fresh[i]! & stored.visited[i]!;

  const containers: MapContainer[] = [];
  const rawContainers = Array.isArray(s['containers']) ? s['containers'] : [];
  for (const c of rawContainers.slice(0, MAX_CONTAINERS)) {
    const mc = container(c, width, height);
    if (mc !== null && inReveal(mc)) containers.push(mc);
  }
  const base = tile(s['base'], width, height);
  const stop = tile(rec(s['stops'])?.[ref], width, height);

  return {
    width,
    height,
    palette: outPalette,
    tiles: b64gz(grid),
    trail: b64gz(stored.visited),
    fresh: b64gz(freshMasked),
    freshCount: popcount(freshMasked),
    containers,
    base: inReveal(base) ? base : null,
    stop: inReveal(stop) ? stop : null,
  };
}

function toPlayerMap(
  stored: StoredMap,
  viewerSteamId64: string,
  nicknames: Record<string, string>,
): PlayerMap | null {
  const index = rec(stored.index);
  const indexShards = rec(index?.['shards']);
  const shards: Partial<Record<RecapShard, MapShardView>> = {};
  for (const shard of ['master', 'caves'] as const) {
    const st = stored.shards[shard];
    if (st === undefined || popcount(st.visited) === 0) continue;
    const view = toMapShardView(indexShards?.[shard], st, stored.ref);
    if (view !== null) shards[shard] = view;
  }
  if (Object.keys(shards).length === 0) return null;
  const nickname = Object.hasOwn(nicknames, stored.steamId64)
    ? nicknames[stored.steamId64]
    : undefined;
  return {
    label: str(nickname) ?? str(stored.persona) ?? 'Player',
    isViewer: stored.steamId64 === viewerSteamId64,
    sessionId: stored.sessionId,
    stoppedAt: str(index?.['stoppedAt'], 40),
    day: int(index?.['day'], 1, 1_000_000),
    shards,
  };
}

/** Every player's map, the viewer's first, then the most recently played. The SteamID64s select
 *  nicknames and `isViewer` and are never copied into the response. */
export function toMapResponse(
  stored: StoredMap[],
  worldId: string,
  viewerSteamId64: string,
  nicknames: Record<string, string>,
): MapResponse {
  const maps = stored
    .map((s) => toPlayerMap(s, viewerSteamId64, nicknames))
    .filter((m): m is PlayerMap => m !== null)
    .sort(
      (a, b) =>
        Number(b.isViewer) - Number(a.isViewer) ||
        (b.stoppedAt ?? '').localeCompare(a.stoppedAt ?? '') ||
        b.sessionId.localeCompare(a.sessionId) ||
        a.label.localeCompare(b.label),
    );
  if (maps.length === 0) return { status: 'none', worldId };
  return { status: 'ok', worldId, revealRadius: MAP_REVEAL_RADIUS_TILES, maps };
}
