// Synthetic save fixtures for the recap tests (docs/research/save-anatomy.md). EVERYTHING here is
// hand-written: tiny Lua tables, generated bitmaps, invented names ("alice", "bob"), fake ids
// (`KU_TEST…`, SteamID64s `7656119000000…`, shard session ids `00000000000000AA`, userdirs
// `TESTUSERDIR1`). Nothing is copied from a real save or a real log — this repo is public.
//
// Test-only: imported by `*.test.ts` files, never by production code (the Lambda bundle's single
// entry point is `handlers/digest.ts`).
import { deflateSync, zstdCompressSync } from 'node:zlib';

// ---------------------------------------------------------------------------------------------
// Lua serialisation
// ---------------------------------------------------------------------------------------------

/** A Lua value as the fixtures describe it. A `Map<number, …>` becomes a sparse slot table
 *  `{[1]=…,[6]=…}`; an array a sequence; a plain object a record. `LuaRaw` is emitted verbatim. */
export type LuaValue =
  | string
  | number
  | boolean
  | null
  | LuaRaw
  | LuaValue[]
  | Map<number, LuaValue>
  | { [k: string]: LuaValue | undefined };

export class LuaRaw {
  constructor(readonly code: string) {}
}

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function luaString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c === 0x7f) out += `\\${String(c).padStart(3, '0')}`;
    else out += ch; // UTF-8 passes through as bytes
  }
  return out + '"';
}

export function toLua(v: LuaValue): string {
  if (v === null) return 'nil';
  if (v instanceof LuaRaw) return v.code;
  if (typeof v === 'string') return luaString(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (Number.isNaN(v)) return '(0/0)';
    if (v === Infinity) return '(1/0)';
    if (v === -Infinity) return '(-1/0)';
    return String(v);
  }
  if (Array.isArray(v)) return `{${v.map(toLua).join(',')}}`;
  if (v instanceof Map) {
    return `{${[...v.entries()].map(([k, x]) => `[${k}]=${toLua(x)}`).join(',')}}`;
  }
  const parts: string[] = [];
  for (const [k, x] of Object.entries(v)) {
    if (x === undefined) continue;
    parts.push(`${IDENT.test(k) ? k : `[${luaString(k)}]`}=${toLua(x)}`);
  }
  return `{${parts.join(',')}}`;
}

// ---------------------------------------------------------------------------------------------
// tar (ustar) + zstd
// ---------------------------------------------------------------------------------------------

const BLOCK = 512;

export interface TarSpec {
  path: string;
  data?: Buffer | string;
  /** '0' file (default), '5' dir, '2' symlink, 'x' pax, 'L' GNU long name, or anything to test. */
  type?: string;
  /** How to carry a path longer than 100 bytes: a pax `x` record or a GNU `L` entry. */
  longName?: 'pax' | 'gnu';
  magic?: 'ustar' | 'gnu' | 'bad';
}

function writeStr(h: Buffer, off: number, len: number, s: string): void {
  const b = Buffer.from(s, 'utf8');
  if (b.length > len) throw new Error(`tar fixture: ${JSON.stringify(s)} longer than ${len}`);
  b.copy(h, off);
}

function octal(n: number, len: number): string {
  return n.toString(8).padStart(len - 1, '0');
}

export function tarHeader(opts: {
  name: string;
  size: number;
  type: string;
  magic?: 'ustar' | 'gnu' | 'bad';
}): Buffer {
  const h = Buffer.alloc(BLOCK);
  writeStr(h, 0, 100, opts.name);
  writeStr(h, 100, 8, octal(0o644, 8));
  writeStr(h, 108, 8, octal(0, 8));
  writeStr(h, 116, 8, octal(0, 8));
  writeStr(h, 124, 12, octal(opts.size, 12));
  writeStr(h, 136, 12, octal(1767225600, 12));
  h[156] = opts.type.charCodeAt(0);
  const magic = opts.magic ?? 'ustar';
  if (magic === 'ustar') {
    writeStr(h, 257, 6, 'ustar'); // "ustar\0"
    writeStr(h, 263, 2, '00');
  } else if (magic === 'gnu') {
    writeStr(h, 257, 8, 'ustar  '); // "ustar  \0"
  } else {
    writeStr(h, 257, 6, 'nope!');
  }
  // checksum: the sum of the header with the checksum field read as 8 spaces
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  writeStr(h, 148, 8, `${octal(sum, 7)}\0`);
  return h;
}

function pad(data: Buffer): Buffer {
  const rem = data.length % BLOCK;
  return rem === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - rem)]);
}

function paxRecord(key: string, value: string): string {
  const body = ` ${key}=${value}\n`;
  let len = body.length + 1;
  while (String(len).length + Buffer.byteLength(body) !== len)
    len = String(len).length + Buffer.byteLength(body);
  return `${len}${body}`;
}

/** A ustar archive. `end: false` omits the two zero blocks (to test the missing marker). */
export function makeTar(entries: TarSpec[], opts: { end?: boolean } = {}): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const data =
      e.data === undefined
        ? Buffer.alloc(0)
        : Buffer.isBuffer(e.data)
          ? e.data
          : Buffer.from(e.data);
    const type = e.type ?? '0';
    let name = e.path;
    if (e.longName === 'pax') {
      const rec = Buffer.from(paxRecord('path', e.path));
      parts.push(tarHeader({ name: 'PaxHeader/long', size: rec.length, type: 'x' }), pad(rec));
      name = 'truncated-name-the-pax-path-overrides';
    } else if (e.longName === 'gnu') {
      const rec = Buffer.from(e.path + '\0');
      parts.push(
        tarHeader({ name: '././@LongLink', size: rec.length, type: 'L', magic: 'gnu' }),
        pad(rec),
      );
      name = e.path.slice(0, 99);
    }
    parts.push(
      tarHeader({
        name,
        size: data.length,
        type,
        ...(e.magic ? { magic: e.magic } : e.longName === 'gnu' ? { magic: 'gnu' as const } : {}),
      }),
      pad(data),
    );
  }
  if (opts.end !== false) parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

export function zstd(buf: Buffer): Buffer {
  return zstdCompressSync(buf);
}

// ---------------------------------------------------------------------------------------------
// World, meta, player files
// ---------------------------------------------------------------------------------------------

/** "VRSN" | 0x00 | u32 LE version | w*h u16 LE, base64. */
export function vrsnGrid(
  nodeIds: number[],
  opts: { version?: number; magic?: string } = {},
): string {
  const head = Buffer.alloc(9);
  head.write(opts.magic ?? 'VRSN', 0, 'ascii');
  head[4] = 0;
  head.writeUInt32LE(opts.version ?? 1, 5);
  const body = Buffer.alloc(nodeIds.length * 2);
  nodeIds.forEach((n, i) => body.writeUInt16LE(n, i * 2));
  return Buffer.concat([head, body]).toString('base64');
}

export interface EntSpec {
  x?: number;
  z?: number;
  /** Items in a container on this entity (slot order; use a Map for sparse slots). */
  items?: LuaValue[] | Map<number, LuaValue>;
  data?: { [k: string]: LuaValue };
}

export interface WorldSpec {
  width: number;
  height: number;
  /** Row-major, 1-based into `topology`; default all 0. Or a function of the tile. */
  nodeIds?: number[] | ((tx: number, ty: number) => number);
  topology: string[];
  ents: Record<string, EntSpec[]>;
  /** Terrain (`map.tiles`): tile ids, row-major, or a function of the tile. Default: every tile
   *  `GRASS`. `null` leaves `tiles` and `world_tile_map` out, as a malformed save would. */
  tiles?: number[] | ((tx: number, ty: number) => number) | null;
  /** `map.world_tile_map`, name -> id. Default: `DEFAULT_TILE_MAP`. */
  tileMap?: Record<string, number>;
}

/** A few real DST tile names with made-up ids (the real ids are looked up, never assumed). */
export const DEFAULT_TILE_MAP: Record<string, number> = {
  IMPASSABLE: 1,
  GRASS: 6,
  FOREST: 7,
  ROCKY: 3,
  OCEAN_COASTAL: 201,
};

export function item(
  prefab: string,
  extra: { stack?: number; data?: { [k: string]: LuaValue } } = {},
) {
  const data: { [k: string]: LuaValue } = { ...(extra.data ?? {}) };
  if (extra.stack !== undefined) data['stackable'] = { stack: extra.stack };
  return Object.keys(data).length > 0 ? { prefab, data } : { prefab };
}

export function nodeIdList(spec: Pick<WorldSpec, 'width' | 'height' | 'nodeIds'>): number[] {
  const n = spec.width * spec.height;
  if (spec.nodeIds === undefined) return new Array<number>(n).fill(0);
  if (Array.isArray(spec.nodeIds)) return spec.nodeIds;
  const out: number[] = [];
  for (let ty = 0; ty < spec.height; ty++)
    for (let tx = 0; tx < spec.width; tx++) out.push(spec.nodeIds(tx, ty));
  return out;
}

function tileIdList(spec: WorldSpec): number[] {
  const tiles = spec.tiles ?? (() => DEFAULT_TILE_MAP['GRASS']!);
  if (Array.isArray(tiles)) return tiles;
  return nodeIdList({
    width: spec.width,
    height: spec.height,
    nodeIds: tiles as (tx: number, ty: number) => number,
  });
}

export function worldLua(spec: WorldSpec): string {
  const ents: { [k: string]: LuaValue } = {};
  for (const [prefab, list] of Object.entries(spec.ents)) {
    ents[prefab] = list.map((e) => {
      const data: { [k: string]: LuaValue } = { ...(e.data ?? {}) };
      if (e.items !== undefined) data['container'] = { items: e.items };
      const out: { [k: string]: LuaValue } = {};
      if (e.x !== undefined) out['x'] = e.x;
      if (e.z !== undefined) out['z'] = e.z;
      if (Object.keys(data).length > 0) out['data'] = data;
      return out;
    });
  }
  const savedata = {
    map: {
      width: spec.width,
      height: spec.height,
      prefab: 'forest',
      nodeidtilemap: vrsnGrid(nodeIdList(spec)),
      topology: { ids: spec.topology },
      ...(spec.tiles === null
        ? {}
        : { tiles: vrsnGrid(tileIdList(spec)), world_tile_map: spec.tileMap ?? DEFAULT_TILE_MAP }),
    },
    ents,
    meta: { build_version: '000000' },
  };
  return `local savedata = ${toLua(savedata)}\nreturn savedata\0`;
}

export function metaLua(m: {
  cycles: number;
  season: string;
  elapsed: number;
  remaining: number;
}): string {
  return `return ${toLua({
    clock: { cycles: m.cycles, phase: 'day' },
    seasons: {
      season: m.season,
      elapseddaysinseason: m.elapsed,
      remainingdaysinseason: m.remaining,
    },
  })}`;
}

/** MSB-first, row-major bitmap of ceil(w*h/8) bytes with the given tiles set. */
export function bitmap(width: number, height: number, tiles: [number, number][]): Buffer {
  const out = Buffer.alloc(Math.ceil((width * height) / 8));
  for (const [tx, ty] of tiles) {
    const i = ty * width + tx;
    out[i >> 3]! |= 0x80 >> (i & 7);
  }
  return out;
}

export interface MapBlockSpec {
  shardSessionId: string;
  bitmap: Buffer;
  /** Undecoded "seeable" prefix; default 7 junk bytes. */
  prefix?: Buffer;
  /** Corruptions for error tests. */
  idLen?: number;
  rawLen?: number;
  one?: number;
  badZlib?: boolean;
}

export function mapBlock(m: MapBlockSpec): Buffer {
  const raw = Buffer.concat([m.prefix ?? Buffer.from([1, 2, 3, 0, 1, 9, 9]), m.bitmap]);
  const comp = m.badZlib ? Buffer.from('definitely not zlib') : deflateSync(raw);
  const head = Buffer.alloc(2 + 16 + 4);
  head.writeUInt16BE(m.idLen ?? 16, 0);
  head.write(m.shardSessionId.padEnd(16, '0').slice(0, 16), 2, 'latin1');
  head.writeUInt32BE(16 + comp.length, 18);
  const blockHead = Buffer.alloc(16);
  blockHead.writeUInt32LE(m.one ?? 1, 0);
  blockHead.writeUInt32LE(16, 4);
  blockHead.writeUInt32LE(m.rawLen ?? raw.length, 8);
  blockHead.writeUInt32LE(comp.length, 12);
  return Buffer.concat([head, blockHead, comp]);
}

export interface PlayerSpec {
  x?: number;
  z?: number;
  prefab?: string;
  /** inventory slot table (a Map for sparse slots) */
  items?: LuaValue[] | Map<number, LuaValue>;
  equip?: { [slot: string]: LuaValue };
  recipes?: string[];
  health?: number;
  hunger?: number;
  sanity?: number;
  maps?: MapBlockSpec[];
}

export function playerLua(p: PlayerSpec): string {
  const rec: { [k: string]: LuaValue } = {};
  if (p.x !== undefined) rec['x'] = p.x;
  rec['y'] = 0;
  if (p.z !== undefined) rec['z'] = p.z;
  rec['prefab'] = p.prefab ?? 'wilson';
  rec['data'] = {
    inventory: { items: p.items ?? [], equip: p.equip ?? {} },
    builder: { recipes: p.recipes ?? [] },
    health: { health: p.health ?? 150 },
    hunger: { hunger: p.hunger ?? 75 },
    sanity: { current: p.sanity ?? 200 },
  };
  rec['age'] = 0;
  return `return ${toLua(rec)}`;
}

/** 3 junk bytes | Lua | 0x01 | map blocks (save-anatomy §3). */
export function playerFile(p: PlayerSpec): Buffer {
  return Buffer.concat([
    Buffer.from([0x0a, 0xfe, 0x33]),
    Buffer.from(playerLua(p), 'utf8'),
    Buffer.from([0x01]),
    ...(p.maps ?? []).map(mapBlock),
  ]);
}

// ---------------------------------------------------------------------------------------------
// A whole save.tar.zst
// ---------------------------------------------------------------------------------------------

export interface PlayerDirSpec {
  snapshots: Record<number, PlayerSpec | Buffer>;
  /** one byte, Master only (0x81 = Master, 0x82 = Caves) */
  savelocation?: number;
}

export interface ShardSaveSpec {
  sessionId: string;
  /** snapshot number -> world spec (or raw text). Every number also gets a meta if given. */
  worlds: Record<number, WorldSpec | string>;
  metas: Record<number, { cycles: number; season: string; elapsed: number; remaining: number }>;
  players?: Record<string, PlayerDirSpec>;
}

export interface SaveSpec {
  master?: ShardSaveSpec;
  caves?: ShardSaveSpec;
  /** Extra shard session dirs (e.g. a lingering old one) keyed by shard. */
  extra?: { shard: 'master' | 'caves'; spec: ShardSaveSpec }[];
  /** Arbitrary extra archive entries (cluster.ini stand-ins, `._` AppleDouble twins, dirs). */
  entries?: TarSpec[];
  /** Path prefix inside the archive, e.g. './' as GNU tar writes it. */
  prefix?: string;
}

const pad10 = (n: number) => String(n).padStart(10, '0');

export function shardEntries(dir: 'Master' | 'Caves', s: ShardSaveSpec, prefix = ''): TarSpec[] {
  const base = `${prefix}${dir}/save/session/${s.sessionId}`;
  const out: TarSpec[] = [{ path: `${base}/`, type: '5' }];
  for (const [n, w] of Object.entries(s.worlds)) {
    out.push({
      path: `${base}/${pad10(Number(n))}`,
      data: typeof w === 'string' ? w : worldLua(w),
    });
  }
  for (const [n, m] of Object.entries(s.metas)) {
    out.push({ path: `${base}/${pad10(Number(n))}.meta`, data: metaLua(m) });
  }
  for (const [userdir, p] of Object.entries(s.players ?? {})) {
    for (const [n, snap] of Object.entries(p.snapshots)) {
      out.push({
        path: `${base}/${userdir}/${pad10(Number(n))}`,
        data: Buffer.isBuffer(snap) ? snap : playerFile(snap),
      });
      out.push({
        path: `${base}/${userdir}/${pad10(Number(n))}.meta`,
        data: 'return {character="wilson"}',
      });
    }
    if (p.savelocation !== undefined) {
      out.push({ path: `${base}/${userdir}/savelocation`, data: Buffer.from([p.savelocation]) });
    }
  }
  return out;
}

export function saveTar(spec: SaveSpec): Buffer {
  const prefix = spec.prefix ?? '';
  const entries: TarSpec[] = [{ path: `${prefix}cluster_settings_placeholder.txt`, data: 'x' }];
  if (spec.master) entries.push(...shardEntries('Master', spec.master, prefix));
  if (spec.caves) entries.push(...shardEntries('Caves', spec.caves, prefix));
  for (const e of spec.extra ?? [])
    entries.push(...shardEntries(e.shard === 'master' ? 'Master' : 'Caves', e.spec, prefix));
  entries.push(...(spec.entries ?? []));
  return makeTar(entries);
}

export function saveTarZst(spec: SaveSpec): Buffer {
  return zstd(saveTar(spec));
}

// ---------------------------------------------------------------------------------------------
// Log lines
// ---------------------------------------------------------------------------------------------

export function logTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `[${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}]`;
}

/** `[[seconds, body], …]` -> a log file. */
export function logText(lines: [number, string][]): string {
  return lines.map(([t, body]) => `${logTime(t)}: ${body}`).join('\n') + '\n';
}
