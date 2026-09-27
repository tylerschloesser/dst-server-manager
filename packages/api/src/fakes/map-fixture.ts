// SYNTHETIC map fixture (docs/decisions.md §19) for local dev, e2e and unit tests. The terrain is
// generated from a formula, the trail is a hand-drawn loop, the storage is invented. Nothing here
// comes from a real save.
//
// The story (numbers the tests assert):
//   surface  80×60: an island of GRASS/FOREST/ROCKY/MARSH in OCEAN_COASTAL/OCEAN_SWELL, a CARPET
//            base at (20, 30), and a far DESERT_DIRT islet at x ≥ 68 the viewer never visited, so
//            the reveal must hide DESERT_DIRT entirely (not even in the palette)
//   trail    a loop around the base and a spoke into it; 12 of its tiles are new this session
//   stops    the viewer (p3) stopped at base; p1's stop is on the loop and is never on p3's map
//   storage  two chests + an ice box at base (revealed); a chest on the unvisited islet (hidden)
//   caves    40×30, one short walk
//   friend   p1 ("alice", "Ally" on the local allowlist) walked east from the loop to a stash at
//            (46, 23), 12 tiles outside the viewer's reveal: on p1's map only. Surface only (no
//            caves trail), 5 new tiles. The islet is outside EVERY player's reveal.
import { gzipSync } from 'node:zlib';

import { MAP_INDEX_FILE, RECAP_SCHEMA_VERSION, mapTilesFile, trailFile } from '@dst/shared';
import type { RecapMapIndex } from '@dst/shared';

export const MAP_FIXTURE_SURFACE = { width: 80, height: 60 };
export const MAP_FIXTURE_CAVES = { width: 40, height: 30 };
export const MAP_FIXTURE_BASE = { tx: 20, ty: 30 };
export const MAP_FIXTURE_FRESH_COUNT = 12;
export const MAP_FIXTURE_FRIEND_REF = 'p1';
export const MAP_FIXTURE_STASH = { tx: 46, ty: 23 };
export const MAP_FIXTURE_FRIEND_FRESH_COUNT = 5;

const SURFACE_PALETTE = [
  'CARPET',
  'DESERT_DIRT',
  'FOREST',
  'GRASS',
  'MARSH',
  'OCEAN_COASTAL',
  'OCEAN_SWELL',
  'ROCKY',
];
const CAVES_PALETTE = ['CAVE', 'FUNGUS', 'IMPASSABLE', 'SINKHOLE'];

function surfaceTile(tx: number, ty: number): string {
  if (tx >= 68 && tx <= 76 && ty >= 8 && ty <= 16) return 'DESERT_DIRT';
  if (Math.abs(tx - MAP_FIXTURE_BASE.tx) <= 1 && Math.abs(ty - MAP_FIXTURE_BASE.ty) <= 1)
    return 'CARPET';
  const d = Math.hypot((tx - 28) / 24, (ty - 30) / 22) + 0.08 * Math.sin(tx / 3) * Math.cos(ty / 4);
  if (d > 1.25) return 'OCEAN_SWELL';
  if (d > 1) return 'OCEAN_COASTAL';
  if (tx > 38) return ty < 30 ? 'ROCKY' : 'MARSH';
  return (tx + ty) % 11 < 5 ? 'FOREST' : 'GRASS';
}

function cavesTile(tx: number, ty: number): string {
  if (ty < 4 || ty > 25 || tx < 3 || tx > 36) return 'IMPASSABLE';
  if (Math.abs(ty - 15) <= 2) return 'CAVE';
  return tx < 20 ? 'SINKHOLE' : 'FUNGUS';
}

function grid(
  dims: { width: number; height: number },
  palette: string[],
  at: (tx: number, ty: number) => string,
): Buffer {
  const out = Buffer.alloc(dims.width * dims.height);
  for (let ty = 0; ty < dims.height; ty++)
    for (let tx = 0; tx < dims.width; tx++)
      out[ty * dims.width + tx] = palette.indexOf(at(tx, ty)) + 1;
  return out;
}

function bitmap(dims: { width: number; height: number }, tiles: [number, number][]): Buffer {
  const out = Buffer.alloc(Math.ceil((dims.width * dims.height) / 8));
  for (const [tx, ty] of tiles) {
    const i = ty * dims.width + tx;
    out[i >> 3]! |= 0x80 >> (i & 7);
  }
  return out;
}

/** A rectangle's outline from (x0, y0) to (x1, y1), walked clockwise. */
function loop(x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const out: [number, number][] = [];
  for (let x = x0; x <= x1; x++) out.push([x, y0]);
  for (let y = y0 + 1; y <= y1; y++) out.push([x1, y]);
  for (let x = x1 - 1; x >= x0; x--) out.push([x, y1]);
  for (let y = y1 - 1; y > y0; y--) out.push([x0, y]);
  return out;
}

/** The loop, then a spoke from its west side in to the base (the loop alone would leave the
 *  base, 8 tiles inside it, in the fog). */
const SURFACE_TRAIL: [number, number][] = [
  ...loop(12, 22, 34, 38),
  ...Array.from({ length: 8 }, (_, i): [number, number] => [13 + i, MAP_FIXTURE_BASE.ty]),
];
const SURFACE_FRESH = SURFACE_TRAIL.slice(0, MAP_FIXTURE_FRESH_COUNT);
/** p1: from their stop on the loop's top edge east to the stash. */
const FRIEND_TRAIL: [number, number][] = Array.from({ length: 17 }, (_, i) => [30 + i, 22]);
const FRIEND_FRESH = FRIEND_TRAIL.slice(-MAP_FIXTURE_FRIEND_FRESH_COUNT);
const CAVES_TRAIL: [number, number][] = Array.from({ length: 10 }, (_, i) => [8 + i, 15]);

export const MAP_FIXTURE_INDEX: RecapMapIndex = {
  schemaVersion: RECAP_SCHEMA_VERSION,
  day: 60,
  stoppedAt: '2026-09-27T04:39:39.000Z',
  shards: {
    master: {
      ...MAP_FIXTURE_SURFACE,
      palette: SURFACE_PALETTE,
      containers: [
        {
          tx: 19,
          ty: 29,
          prefab: 'treasurechest',
          name: 'Chest',
          items: [
            { prefab: 'cutgrass', name: 'Cut Grass', count: 60 },
            { prefab: 'log', name: 'Log', count: 38 },
          ],
        },
        {
          tx: 19,
          ty: 29,
          prefab: 'treasurechest',
          name: 'Chest',
          items: [{ prefab: 'gears', name: 'Gears', count: 3 }],
        },
        {
          tx: 21,
          ty: 31,
          prefab: 'icebox',
          name: 'Ice Box',
          items: [{ prefab: 'meat', name: 'Meat', count: 4 }],
        },
        {
          tx: 72,
          ty: 12,
          prefab: 'treasurechest',
          name: 'Chest',
          items: [{ prefab: 'goldnugget', name: 'Hidden Gold', count: 9 }],
        },
        {
          ...MAP_FIXTURE_STASH,
          prefab: 'treasurechest',
          name: 'Chest',
          items: [{ prefab: 'marble', name: 'Marble', count: 7 }],
        },
      ],
      base: MAP_FIXTURE_BASE,
      stops: { p1: { tx: 30, ty: 22 }, p3: { tx: 20, ty: 31 } },
    },
    caves: {
      ...MAP_FIXTURE_CAVES,
      palette: CAVES_PALETTE,
      containers: [],
      base: null,
      stops: {},
    },
  },
};

/** The objects the digest would have written for one session: the grids, `ref`'s trail (the
 *  viewer's) and the friend's (`MAP_FIXTURE_FRIEND_REF`, surface only). */
export function mapFixtureObjects(
  key: (file: string) => string,
  ref: string,
): [string, string | Uint8Array][] {
  return [
    [key(MAP_INDEX_FILE), JSON.stringify(MAP_FIXTURE_INDEX)],
    [
      key(mapTilesFile('master')),
      gzipSync(grid(MAP_FIXTURE_SURFACE, SURFACE_PALETTE, surfaceTile)),
    ],
    [key(mapTilesFile('caves')), gzipSync(grid(MAP_FIXTURE_CAVES, CAVES_PALETTE, cavesTile))],
    [key(trailFile(ref, 'master', 'visited')), bitmap(MAP_FIXTURE_SURFACE, SURFACE_TRAIL)],
    [key(trailFile(ref, 'master', 'new')), bitmap(MAP_FIXTURE_SURFACE, SURFACE_FRESH)],
    [key(trailFile(ref, 'caves', 'visited')), bitmap(MAP_FIXTURE_CAVES, CAVES_TRAIL)],
    [key(trailFile(ref, 'caves', 'new')), bitmap(MAP_FIXTURE_CAVES, [])],
    [
      key(trailFile(MAP_FIXTURE_FRIEND_REF, 'master', 'visited')),
      bitmap(MAP_FIXTURE_SURFACE, FRIEND_TRAIL),
    ],
    [
      key(trailFile(MAP_FIXTURE_FRIEND_REF, 'master', 'new')),
      bitmap(MAP_FIXTURE_SURFACE, FRIEND_FRESH),
    ],
  ];
}
