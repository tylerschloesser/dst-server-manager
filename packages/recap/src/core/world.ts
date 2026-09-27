// The world file (docs/research/save-anatomy.md §2): entity counts, container contents, structure
// positions, and the per-tile area names used to name positions.
import { SaveFormatError } from './lua';

export interface WorldMap {
  width: number;
  height: number;
  /** Per tile (row-major, row = y): 1-based index into `topologyIds` (0 = none), `nodeidtilemap`. */
  nodeIds: Uint16Array;
  topologyIds: string[];
}

export interface Placed {
  prefab: string;
  x: number;
  z: number;
}

/** The terrain grid (`map.tiles`) with its tile names (`map.world_tile_map`, name -> id; ids are
 *  looked up there, never hard-coded: `gamelogic.lua` renumbers them on load). */
export interface Terrain {
  /** Per tile (row-major, row = y): the tile id. */
  tiles: Uint16Array;
  idToName: Map<number, string>;
}

/** A container entity with a position, and what is in it (prefab -> total stack count). */
export interface PlacedContainer extends Placed {
  items: Map<string, number>;
}

export interface WorldSummary {
  map: WorldMap;
  /** Null when `map.tiles` or `map.world_tile_map` is missing or malformed; `terrainError` says
   *  why. The map is optional (docs/decisions.md §19): its absence never fails the digest. */
  terrain: Terrain | null;
  terrainError: string | null;
  /** every container entity that has a position */
  containersPlaced: PlacedContainer[];
  /** prefab -> number of entities */
  counts: Map<string, number>;
  /** prefab -> total stack count across every container on the shard */
  stored: Map<string, number>;
  /** every entity with a position whose prefab satisfies the caller's filter */
  placed: Placed[];
  /** container prefab -> { number of such containers, prefab -> total stack count inside } */
  containerGroups: Map<string, { containers: number; items: Map<string, number> }>;
}

type Json = unknown;

function isObject(v: Json): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** A Lua sequence arrives as a JSON array; a sparse one (slot tables) as an object keyed by the
 *  stringified slot number. Returns `[slot, value]` pairs in slot order either way. */
export function luaSlots(v: Json): [number, Json][] {
  if (Array.isArray(v)) return v.map((x, i) => [i + 1, x]);
  if (isObject(v)) {
    return Object.entries(v)
      .map(([k, x]): [number, Json] => [Number(k), x])
      .filter(([k]) => Number.isInteger(k))
      .sort((a, b) => a[0] - b[0]);
  }
  return [];
}

/** Decodes a `VRSN` grid (base64): "VRSN" | 0x00 | u32 LE version=1 | w*h × u16 LE. */
export function decodeVrsnGrid(
  b64: string,
  width: number,
  height: number,
  what: string,
): Uint16Array {
  const buf = Buffer.from(b64, 'base64');
  if (buf.subarray(0, 4).toString('ascii') !== 'VRSN' || buf[4] !== 0) {
    throw new SaveFormatError(`${what}: missing VRSN header`);
  }
  const version = buf.readUInt32LE(5);
  if (version !== 1) throw new SaveFormatError(`${what}: VRSN version ${version}, expected 1`);
  const expected = 9 + width * height * 2;
  if (buf.length !== expected) {
    throw new SaveFormatError(
      `${what}: ${buf.length} bytes, expected ${expected} for ${width}x${height}`,
    );
  }
  const out = new Uint16Array(width * height);
  for (let i = 0; i < out.length; i++) out[i] = buf.readUInt16LE(9 + i * 2);
  return out;
}

export function stackOf(item: Json): number {
  if (!isObject(item)) return 1;
  const data = item['data'];
  if (isObject(data) && isObject(data['stackable'])) {
    const stack = data['stackable']['stack'];
    if (typeof stack === 'number' && stack >= 1) return stack;
  }
  return 1;
}

function addCount(m: Map<string, number>, k: string, n: number): void {
  m.set(k, (m.get(k) ?? 0) + n);
}

function decodeTerrain(map: Record<string, Json>, width: number, height: number): Terrain {
  const b64 = map['tiles'];
  const tileMap = map['world_tile_map'];
  if (typeof b64 !== 'string') throw new SaveFormatError('tiles: missing');
  if (!isObject(tileMap)) throw new SaveFormatError('world_tile_map: missing');
  const idToName = new Map<number, string>();
  for (const [name, id] of Object.entries(tileMap)) {
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      throw new SaveFormatError(`world_tile_map: ${name} has no integer id`);
    }
    idToName.set(id, name);
  }
  const tiles = decodeVrsnGrid(b64, width, height, 'tiles');
  for (const id of tiles) {
    if (!idToName.has(id)) throw new SaveFormatError(`tiles: id ${id} is not in world_tile_map`);
  }
  return { tiles, idToName };
}

export function summarizeWorld(
  world: Json,
  isPlaceable: (prefab: string) => boolean,
): WorldSummary {
  if (!isObject(world) || !isObject(world['map']) || !isObject(world['ents'])) {
    throw new SaveFormatError('world: missing map or ents');
  }
  const map = world['map'];
  const width = map['width'];
  const height = map['height'];
  if (typeof width !== 'number' || typeof height !== 'number' || width <= 0 || height <= 0) {
    throw new SaveFormatError('world: bad map width/height');
  }
  const nodeidtilemap = map['nodeidtilemap'];
  const topology = map['topology'];
  if (typeof nodeidtilemap !== 'string' || !isObject(topology) || !Array.isArray(topology['ids'])) {
    throw new SaveFormatError('world: missing nodeidtilemap or topology.ids');
  }
  const topologyIds = topology['ids'].map((x) => (typeof x === 'string' ? x : ''));

  const counts = new Map<string, number>();
  const stored = new Map<string, number>();
  const placed: Placed[] = [];
  const containerGroups: WorldSummary['containerGroups'] = new Map();
  const containersPlaced: PlacedContainer[] = [];
  for (const [prefab, list] of Object.entries(world['ents'])) {
    const ents = luaSlots(list).map(([, e]) => e);
    addCount(counts, prefab, ents.length);
    const wanted = isPlaceable(prefab);
    for (const e of ents) {
      if (!isObject(e)) continue;
      if (wanted && typeof e['x'] === 'number' && typeof e['z'] === 'number') {
        placed.push({ prefab, x: e['x'], z: e['z'] });
      }
      const data = e['data'];
      if (isObject(data) && isObject(data['container'])) {
        let group = containerGroups.get(prefab);
        if (group === undefined) {
          group = { containers: 0, items: new Map() };
          containerGroups.set(prefab, group);
        }
        group.containers++;
        const items = new Map<string, number>();
        for (const [, item] of luaSlots(data['container']['items'])) {
          if (isObject(item) && typeof item['prefab'] === 'string') {
            addCount(stored, item['prefab'], stackOf(item));
            addCount(group.items, item['prefab'], stackOf(item));
            addCount(items, item['prefab'], stackOf(item));
          }
        }
        if (typeof e['x'] === 'number' && typeof e['z'] === 'number') {
          containersPlaced.push({ prefab, x: e['x'], z: e['z'], items });
        }
      }
    }
  }

  let terrain: Terrain | null = null;
  let terrainError: string | null = null;
  try {
    terrain = decodeTerrain(map, width, height);
  } catch (err) {
    if (!(err instanceof SaveFormatError)) throw err;
    terrainError = err.message;
  }

  return {
    map: {
      width,
      height,
      nodeIds: decodeVrsnGrid(nodeidtilemap, width, height, 'nodeidtilemap'),
      topologyIds,
    },
    terrain,
    terrainError,
    containersPlaced,
    counts,
    stored,
    placed,
    containerGroups,
  };
}

/** World position -> tile (docs/research/save-anatomy.md §2.1, TILE_SCALE 4). */
export function tileOf(map: WorldMap, x: number, z: number): { tx: number; ty: number } | null {
  const tx = Math.floor(x / 4 + map.width / 2);
  const ty = Math.floor(z / 4 + map.height / 2);
  if (tx < 0 || ty < 0 || tx >= map.width || ty >= map.height) return null;
  return { tx, ty };
}

/** "Dig that rock:7:Rocky" -> "Rocky"; "For a nice walk:BG_64:BGForest" -> "Forest";
 *  "DeepForest" -> "Deep Forest". Null when the tile has no area (ocean, impassable). */
export function biomeName(topologyId: string): string | null {
  const room = topologyId.split(':').pop() ?? '';
  const bare = room.replace(/^BG/, '').replace(/_+/g, ' ').trim();
  if (bare === '') return null;
  return bare.replace(/([a-z])([A-Z])/g, '$1 $2');
}

export function biomeAt(map: WorldMap, x: number, z: number): string | null {
  const t = tileOf(map, x, z);
  if (t === null) return null;
  // Node ids are 1-based Lua indices into topology.ids; 0 = no area (ocean, measured: every one
  // of the 99,182 zero tiles on our surface is sea). Checked against the base: ids[n-1] = Grass.
  const node = map.nodeIds[t.ty * map.width + t.tx]!;
  if (node === 0) return null;
  const id = map.topologyIds[node - 1];
  return id === undefined ? null : biomeName(id);
}
