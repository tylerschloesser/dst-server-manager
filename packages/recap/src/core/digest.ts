// The deterministic session digest (docs/decisions.md §18, docs/research/map-inventory-recap.md
// §3.1). Pure: bytes in, `Recap` out. No AWS, no network, no clock except `input.now`.
//
// Rule: never emit a wrong number. Every format surprise throws `SaveFormatError` (the caller
// logs `digest_parse_failed` and writes nothing); every *known* gap (a missing save version, a
// player with no log lines) is reported in `recap.notes` and the affected field is null.
import { RECAP_SCHEMA_VERSION } from '@dst/shared';
import type {
  Recap,
  RecapCalendarPoint,
  RecapCarrying,
  RecapContainerGroup,
  RecapDeath,
  RecapItem,
  RecapItemCondition,
  RecapNamed,
  RecapNamedCount,
  RecapPlayer,
  RecapPlayersFile,
  RecapPosition,
  RecapShard,
} from '@dst/shared';

import { GAME_DATA, characterName, displayName, isPlaceable } from './gamedata';
import { parseLogs } from './logs';
import type { ParsedLogs, SessionLogs } from './logs';
import { SaveFormatError, evalLuaTable } from './lua';
import { isBitSet, newBits, popcount, splitPlayerFile, visitedBitmap } from './player';
import { buildMap } from './map';
import { loadSaveFiles } from './save';
import type { PlayerDirFiles, SaveFiles, ShardFiles } from './save';
import { biomeAt, luaSlots, stackOf, summarizeWorld, tileOf } from './world';
import type { Placed, WorldSummary } from './world';

export const DIGEST_VERSION = 'digest-2'; // 2: the map files (docs/decisions.md §19)

const SHARDS: RecapShard[] = ['master', 'caves'];
const SECONDS_PER_DAY = 480;
/** Structures within this many world units of each other form one cluster (10 tiles). */
const BASE_CLUSTER_RADIUS = 40;
/** A position within this many world units of the base centre counts as "at base" (15 tiles). */
const AT_BASE_RADIUS = 60;
/** Containers that are not built from a recipe but are the players' own storage. */
const FOLLOWER_CONTAINERS = new Set(['chester', 'hutch']);

/** The fields of `sessions/<w>/<s>/manifest.json` the digest reads (docs/storage.md §8). */
export interface ManifestLike {
  sessionId?: string;
  worldId?: string;
  startedBy?: string | null;
  startedAt?: string | null;
  joinableAt?: string | null;
  stoppedAt?: string | null;
  stopReason?: string | null;
  peakPlayers?: number | null;
  dstBuildId?: string | null;
  preStartVersionId?: string | null;
  postStopVersionId?: string | null;
}

export interface DigestInput {
  worldId: string;
  sessionId: string;
  manifest: ManifestLike;
  /** `worlds/<w>/save.tar.zst` at `preStartVersionId`; null if it is gone or there is none. */
  before: Buffer | null;
  /** … at `postStopVersionId`; null when the session never pushed a save. */
  after: Buffer | null;
  logs: SessionLogs;
  /** The previous session's `postStopVersionId` (null/undefined when there is no previous
   *  session): decides `recap.continuous`. */
  previousPostStopVersionId?: string | null;
  /** players.json entries from earlier digests of this world, to recognise userdirs. */
  knownPlayers?: RecapPlayersFile['players'];
  note?: string | null;
  now: Date;
}

export interface DigestFile {
  path: string; // relative to `sessions/<w>/<s>/digest/`
  body: Buffer;
  contentType: string;
}

export interface DigestOutput {
  recap: Recap;
  players: RecapPlayersFile;
  files: DigestFile[];
}

// ---------------------------------------------------------------------------------------------
// Parsed saves
// ---------------------------------------------------------------------------------------------

type Json = unknown;
function isObject(v: Json): v is Record<string, Json> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function num(v: Json): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

interface Meta {
  cycles: number;
  season: string;
  elapsed: number | null;
  remaining: number | null;
}

interface PlayerRecord {
  n: number;
  shard: RecapShard;
  x: number | null;
  z: number | null;
  data: Record<string, Json>;
  prefab: string | null;
  /** shardSessionId -> visited bitmap */
  maps: Map<string, Buffer>;
}

interface ParsedShard {
  files: ShardFiles;
  world: WorldSummary;
  metas: Map<number, Meta>;
}

interface ParsedSave {
  shards: Partial<Record<RecapShard, ParsedShard>>;
}

/** `null` for a freshly generated world's worldgen snapshot, whose meta is exactly
 *  `{clock={},seasons={}}` (measured on a generated test world: the first slot, written before
 *  the clock exists). Every consumer already treats a slot without a meta as unknown. Any other
 *  missing field is still a format surprise. */
async function parseMeta(text: string, what: string): Promise<Meta | null> {
  const v = await evalLuaTable(text, what);
  if (!isObject(v) || !isObject(v['clock']) || !isObject(v['seasons'])) {
    throw new SaveFormatError(`${what}: missing clock/seasons`);
  }
  if (Object.keys(v['clock']).length === 0 && Object.keys(v['seasons']).length === 0) return null;
  const cycles = num(v['clock']['cycles']);
  const season = v['seasons']['season'];
  if (cycles === null || typeof season !== 'string')
    throw new SaveFormatError(`${what}: bad clock/season`);
  return {
    cycles,
    season,
    elapsed: num(v['seasons']['elapseddaysinseason']),
    remaining: num(v['seasons']['remainingdaysinseason']),
  };
}

async function parseSave(buf: Buffer, label: string): Promise<ParsedSave> {
  const files: SaveFiles = loadSaveFiles(buf);
  const shards: ParsedSave['shards'] = {};
  for (const shard of SHARDS) {
    const f = files[shard];
    if (f === undefined) continue;
    const text = f.newestWorld.data.toString('utf8');
    const worldJson = await evalLuaTable(text, `${label}/${shard}/world`);
    const world = summarizeWorld(worldJson, isPlaceable);
    const metas = new Map<number, Meta>();
    for (const [n, m] of f.metas) {
      const meta = await parseMeta(m, `${label}/${shard}/${n}.meta`);
      if (meta !== null) metas.set(n, meta);
    }
    shards[shard] = { files: f, world, metas };
  }
  return { shards };
}

async function parsePlayerRecord(
  buf: Buffer,
  n: number,
  shard: RecapShard,
  dims: Map<string, { width: number; height: number }>,
  what: string,
): Promise<PlayerRecord> {
  const split = splitPlayerFile(buf, what);
  const rec = await evalLuaTable(split.lua, what);
  if (!isObject(rec) || !isObject(rec['data'])) throw new SaveFormatError(`${what}: no data table`);
  const maps = new Map<string, Buffer>();
  for (const block of split.maps) {
    const d = dims.get(block.shardSessionId);
    if (d === undefined) continue; // a map of a shard session that no longer exists in this save
    maps.set(block.shardSessionId, visitedBitmap(block.payload, d.width, d.height, what));
  }
  return {
    n,
    shard,
    x: num(rec['x']),
    z: num(rec['z']),
    data: rec['data'],
    prefab: typeof rec['prefab'] === 'string' ? rec['prefab'] : null,
    maps,
  };
}

function dimsOf(save: ParsedSave): Map<string, { width: number; height: number }> {
  const out = new Map<string, { width: number; height: number }>();
  for (const s of Object.values(save.shards)) {
    out.set(s.files.sessionId, { width: s.world.map.width, height: s.world.map.height });
  }
  return out;
}

function newestSnapshot(p: PlayerDirFiles | undefined): number | null {
  if (p === undefined || p.snapshots.size === 0) return null;
  return Math.max(...p.snapshots.keys());
}

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

function calendar(meta: Meta | null): RecapCalendarPoint | null {
  if (meta === null) return null;
  return {
    day: meta.cycles + 1,
    season: meta.season,
    dayOfSeason: meta.elapsed === null ? null : meta.elapsed + 1,
    daysLeftInSeason: meta.remaining,
  };
}

function newestMeta(s: ParsedShard | undefined): Meta | null {
  if (s === undefined) return null;
  return s.metas.get(s.files.newestWorld.n) ?? null;
}

function sortedCounts(delta: Map<string, number>, sign: 1 | -1): RecapNamedCount[] {
  return [...delta.entries()]
    .filter(([, d]) => d * sign > 0)
    .map(([prefab, d]) => ({ prefab, name: displayName(prefab), delta: d }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.name.localeCompare(b.name));
}

function diffMaps(after: Map<string, number>, before: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const k of new Set([...after.keys(), ...before.keys()])) {
    const d = (after.get(k) ?? 0) - (before.get(k) ?? 0);
    if (d !== 0) out.set(k, d);
  }
  return out;
}

function sumShards(
  save: ParsedSave | null,
  pick: (w: WorldSummary) => Map<string, number>,
): Map<string, number> {
  const out = new Map<string, number>();
  if (save === null) return out;
  for (const s of Object.values(save.shards)) {
    for (const [k, v] of pick(s.world)) out.set(k, (out.get(k) ?? 0) + v);
  }
  return out;
}

export function itemCondition(data: Json): RecapItemCondition | undefined {
  if (!isObject(data)) return undefined;
  const c: RecapItemCondition = {};
  const fu = isObject(data['finiteuses']) ? num(data['finiteuses']['uses']) : null;
  if (fu !== null) c.usesLeft = Math.round(fu * 10) / 10;
  const fuel = isObject(data['fueled']) ? num(data['fueled']['fuel']) : null;
  if (fuel !== null) c.fuel = Math.round(fuel);
  const armor = isObject(data['armor']) ? num(data['armor']['condition']) : null;
  if (armor !== null) c.armor = Math.round(armor);
  const perish = isObject(data['perishable']) ? num(data['perishable']['time']) : null;
  if (perish !== null) c.perishDaysLeft = Math.round((perish / SECONDS_PER_DAY) * 10) / 10;
  return Object.keys(c).length > 0 ? c : undefined;
}

export function toItem(raw: Json): RecapItem | null {
  if (!isObject(raw) || typeof raw['prefab'] !== 'string') return null;
  const item: RecapItem = {
    prefab: raw['prefab'],
    name: displayName(raw['prefab']),
    count: stackOf(raw),
  };
  const condition = itemCondition(raw['data']);
  if (condition !== undefined) item.condition = condition;
  return item;
}

export function carryingOf(data: Record<string, Json>, shard: RecapShard): RecapCarrying | null {
  const inv = data['inventory'];
  if (!isObject(inv)) return null;
  const inventory = luaSlots(inv['items'])
    .map(([, it]) => toItem(it))
    .filter((x): x is RecapItem => x !== null);
  const equipped: RecapCarrying['equipped'] = [];
  let backpack: RecapCarrying['backpack'] = null;
  const equip = inv['equip'];
  if (isObject(equip)) {
    for (const slot of Object.keys(equip).sort()) {
      const raw = equip[slot];
      const item = toItem(raw);
      if (item === null) continue;
      equipped.push({ slot, item });
      const cdata = isObject(raw) && isObject(raw['data']) ? raw['data']['container'] : undefined;
      if (isObject(cdata)) {
        backpack = {
          prefab: item.prefab,
          name: item.name,
          items: luaSlots(cdata['items'])
            .map(([, it]) => toItem(it))
            .filter((x): x is RecapItem => x !== null),
        };
      }
    }
  }
  return { inventory, equipped, backpack, shard };
}

function recipesOf(rec: PlayerRecord | null): Set<string> {
  const out = new Set<string>();
  if (rec === null) return out;
  const builder = rec.data['builder'];
  if (isObject(builder)) {
    for (const [, r] of luaSlots(builder['recipes'])) if (typeof r === 'string') out.add(r);
  }
  return out;
}

/** Centre of the densest cluster of placed structures on the surface, or null with none. */
export function baseCentre(placed: Placed[]): { x: number; z: number } | null {
  let best: Placed[] = [];
  for (const p of placed) {
    const near = placed.filter((q) => Math.hypot(q.x - p.x, q.z - p.z) <= BASE_CLUSTER_RADIUS);
    if (near.length > best.length) best = near;
  }
  if (best.length < 3) return null; // a lone campfire is not a base
  return {
    x: best.reduce((s, p) => s + p.x, 0) / best.length,
    z: best.reduce((s, p) => s + p.z, 0) / best.length,
  };
}

function statsOf(rec: PlayerRecord | null): RecapPlayer['stats'] {
  if (rec === null) return null;
  const pick = (k: string, f: string): number | null => {
    const c = rec.data[k];
    const v = isObject(c) ? num(c[f]) : null;
    return v === null ? null : Math.round(v);
  };
  return {
    health: pick('health', 'health'),
    hunger: pick('hunger', 'hunger'),
    sanity: pick('sanity', 'current'),
  };
}

// ---------------------------------------------------------------------------------------------
// The digest
// ---------------------------------------------------------------------------------------------

interface PlayerDraft {
  userdir: string;
  ku: string | null;
  persona: string | null;
  steamId64: string | null;
  beforeRecs: PlayerRecord[]; // newest per shard dir
  afterRecs: PlayerRecord[];
  afterAll: PlayerRecord[]; // every after snapshot newer than the before save's newest
  savelocation: RecapShard | null;
}

function savelocationShard(p: PlayerDirFiles | undefined, notes: Set<string>): RecapShard | null {
  const b = p?.savelocation?.[0];
  if (b === undefined) return null;
  const shardId = b & 0x7f; // measured 0x81 = on Master (shard id 1); the high bit is a flag
  if (shardId === 1) return 'master';
  if (shardId === 2) return 'caves';
  notes.add(`unrecognised savelocation byte 0x${b.toString(16)}; fell back to the logs`);
  return null;
}

async function loadPlayerRecords(
  save: ParsedSave,
  label: string,
  userdir: string,
  newerThan: Map<RecapShard, number> | null,
): Promise<{ newest: PlayerRecord[]; all: PlayerRecord[] }> {
  const dims = dimsOf(save);
  const newest: PlayerRecord[] = [];
  const all: PlayerRecord[] = [];
  for (const shard of SHARDS) {
    const s = save.shards[shard];
    const dir = s?.files.players.get(userdir);
    if (dir === undefined) continue;
    const top = newestSnapshot(dir);
    const floor = newerThan?.get(shard) ?? -1;
    for (const n of [...dir.snapshots.keys()].sort((a, b) => a - b)) {
      if (n !== top && (newerThan === null || n <= floor)) continue;
      const rec = await parsePlayerRecord(
        dir.snapshots.get(n)!,
        n,
        shard,
        dims,
        `${label}/${shard}/player/${n}`,
      );
      if (n === top) newest.push(rec);
      if (newerThan !== null && n > floor) all.push(rec);
    }
  }
  return { newest, all };
}

function bestBitmap(recs: PlayerRecord[], shardSessionId: string | undefined): Buffer | null {
  if (shardSessionId === undefined) return null;
  let best: Buffer | null = null;
  let bestCount = -1;
  for (const r of recs) {
    const bm = r.maps.get(shardSessionId);
    if (bm === undefined) continue;
    const c = popcount(bm);
    if (c > bestCount) {
      best = bm;
      bestCount = c;
    }
  }
  return best;
}

export async function digestSession(input: DigestInput): Promise<DigestOutput> {
  const notes = new Set<string>();
  const logs: ParsedLogs = parseLogs(input.logs);
  for (const line of logs.unparsed) notes.add(`unrecognised chat announcement: ${line}`);

  const before = input.before !== null ? await parseSave(input.before, 'before') : null;
  const after = input.after !== null ? await parseSave(input.after, 'after') : null;
  if (before === null) notes.add('the pre-session save is unavailable: nothing to compare against');
  if (after === null) notes.add('no post-session save: only the logs were digested');

  const hasCaves = (after ?? before)?.shards.caves !== undefined;

  // ---- calendar ----------------------------------------------------------------------------
  const startMeta = newestMeta(before?.shards.master);
  const endMeta = newestMeta(after?.shards.master);
  let start = calendar(startMeta);
  if (start === null && logs.bootCycles !== null) {
    start = {
      day: logs.bootCycles + 1,
      season: logs.bootSeason ?? 'unknown',
      dayOfSeason: null,
      daysLeftInSeason: null,
    };
  } else if (start !== null && logs.bootCycles !== null && logs.bootCycles + 1 !== start.day) {
    notes.add(
      `the boot log says day ${logs.bootCycles + 1} but the pre-session save says day ${start.day}`,
    );
  }
  const end = calendar(endMeta);
  const seasonChanges: Recap['time']['seasonChanges'] = [];
  if (start !== null && after !== null) {
    const points = [...after.shards.master!.metas.values()]
      .map((m) => ({ day: m.cycles + 1, season: m.season, elapsed: m.elapsed }))
      .sort((a, b) => a.day - b.day);
    const seen = new Set<string>([start.season]);
    for (const p of points) {
      if (seen.has(p.season) || p.elapsed === null) continue;
      seen.add(p.season);
      const began = p.day - p.elapsed;
      if (began > start.day) seasonChanges.push({ season: p.season, day: began });
    }
    if (end !== null && !seen.has(end.season) && endMeta?.elapsed !== null && endMeta !== null) {
      seasonChanges.push({ season: end.season, day: end.day - (endMeta.elapsed ?? 0) });
    }
  }

  // ---- world deltas ------------------------------------------------------------------------
  let built: RecapNamedCount[] = [];
  let destroyed: RecapNamedCount[] = [];
  let storage: RecapNamedCount[] = [];
  if (before !== null && after !== null) {
    const structures = (w: WorldSummary) =>
      new Map([...w.counts].filter(([prefab]) => isPlaceable(prefab)));
    const structDelta = diffMaps(sumShards(after, structures), sumShards(before, structures));
    built = sortedCounts(structDelta, 1);
    destroyed = sortedCounts(structDelta, -1).map((c) => ({ ...c, delta: -c.delta }));
    const storeDelta = diffMaps(
      sumShards(after, (w) => w.stored),
      sumShards(before, (w) => w.stored),
    );
    storage = [...sortedCounts(storeDelta, 1), ...sortedCounts(storeDelta, -1)].sort(
      (a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.name.localeCompare(b.name),
    );
  }
  const containers: RecapContainerGroup[] = [];
  for (const shard of SHARDS) {
    const w = after?.shards[shard]?.world;
    if (w === undefined) continue;
    for (const [prefab, g] of w.containerGroups) {
      if (!isPlaceable(prefab) && !FOLLOWER_CONTAINERS.has(prefab)) continue; // no world-gen loot
      containers.push({
        prefab,
        name: displayName(prefab),
        shard,
        containers: g.containers,
        items: sortedCounts(g.items, 1),
      });
    }
  }
  containers.sort(
    (a, b) =>
      a.shard.localeCompare(b.shard) || b.containers - a.containers || a.name.localeCompare(b.name),
  );
  const base = after?.shards.master ? baseCentre(after.shards.master.world.placed) : null;

  // ---- players -----------------------------------------------------------------------------
  const kuByUserdir = new Map<string, string>();
  for (const k of input.knownPlayers ?? []) if (k.userdir && k.ku) kuByUserdir.set(k.userdir, k.ku);
  for (const id of logs.identities.values())
    for (const u of id.userdirs.keys()) kuByUserdir.set(u, id.ku);
  const knownByKu = new Map((input.knownPlayers ?? []).filter((k) => k.ku).map((k) => [k.ku!, k]));

  const userdirs = new Set<string>();
  for (const save of [before, after]) {
    for (const s of Object.values(save?.shards ?? {}))
      for (const u of s.files.players.keys()) userdirs.add(u);
  }

  const drafts: PlayerDraft[] = [];
  for (const userdir of [...userdirs].sort()) {
    const ku = kuByUserdir.get(userdir) ?? null;
    const id = ku !== null ? logs.identities.get(ku) : undefined;
    const beforeNewest = new Map<RecapShard, number>();
    for (const shard of SHARDS) {
      const n = newestSnapshot(before?.shards[shard]?.files.players.get(userdir));
      if (n !== null) beforeNewest.set(shard, n);
    }
    const changed = SHARDS.some((shard) => {
      const a = newestSnapshot(after?.shards[shard]?.files.players.get(userdir));
      return a !== null && a !== (beforeNewest.get(shard) ?? null);
    });
    const joined = id !== undefined && (id.persona !== null || id.userdirs.has(userdir));
    if (!changed && !joined) continue; // not in this session (or a long-gone one-time visitor)

    const b =
      before !== null
        ? await loadPlayerRecords(before, 'before', userdir, null)
        : { newest: [], all: [] };
    const a =
      after !== null
        ? await loadPlayerRecords(after, 'after', userdir, beforeNewest)
        : { newest: [], all: [] };
    const afterMaster = after?.shards.master?.files.players.get(userdir);
    drafts.push({
      userdir,
      ku,
      persona: id?.persona ?? (ku !== null ? (knownByKu.get(ku)?.persona ?? null) : null),
      steamId64: id?.steamId64 ?? (ku !== null ? (knownByKu.get(ku)?.steamId64 ?? null) : null),
      beforeRecs: b.newest,
      afterRecs: a.newest,
      afterAll: a.all,
      savelocation: savelocationShard(afterMaster, notes),
    });
  }

  drafts.sort(
    (x, y) =>
      // Named players first. (Not `?? '~'`: localeCompare sorts punctuation before letters.)
      Number(x.persona === null) - Number(y.persona === null) ||
      (x.persona ?? '').localeCompare(y.persona ?? '') ||
      x.userdir.localeCompare(y.userdir),
  );
  const players: RecapPlayer[] = [];
  const privatePlayers: RecapPlayersFile['players'] = [];
  const files: DigestFile[] = [];
  const refByPersona = new Map<string, string>();
  const stops: { ref: string; shard: RecapShard; x: number; z: number }[] = [];

  drafts.forEach((d, i) => {
    const ref = `p${i + 1}`;
    if (d.persona !== null) refByPersona.set(d.persona, ref);
    privatePlayers.push({
      ref,
      ku: d.ku,
      steamId64: d.steamId64,
      persona: d.persona,
      userdir: d.userdir,
    });
  });

  for (const [i, d] of drafts.entries()) {
    const ref = `p${i + 1}`;
    // The shard the player's newest save is on: the logs' last migration if they moved this
    // session, else the save's own savelocation, else wherever a file exists (Master first).
    const logShard = d.ku !== null ? logs.lastShard.get(d.ku) : undefined;
    const pickNewest = (recs: PlayerRecord[], pref: RecapShard | null | undefined) =>
      recs.find((r) => r.shard === pref) ??
      recs.find((r) => r.shard === 'master') ??
      recs[0] ??
      null;
    const newestAfter = pickNewest(d.afterRecs, logShard ?? d.savelocation);
    const newestBefore = pickNewest(d.beforeRecs, 'master');

    const newTiles: RecapPlayer['newTiles'] = { master: null, caves: null };
    const totalTiles: RecapPlayer['totalTiles'] = { master: null, caves: null };
    for (const shard of SHARDS) {
      const sid = after?.shards[shard]?.files.sessionId;
      const aBits = bestBitmap(d.afterRecs, sid);
      if (aBits === null) continue;
      const beforeSid = before?.shards[shard]?.files.sessionId;
      const bBits = beforeSid === sid ? bestBitmap(d.beforeRecs, sid) : null;
      const added = newBits(aBits, bBits);
      newTiles[shard] = popcount(added);
      totalTiles[shard] = popcount(aBits);
      if (bBits !== null) {
        const removed = popcount(newBits(bBits, aBits));
        if (removed > 0)
          notes.add(`${ref}: ${removed} ${shard} tiles were visited before but not after`);
      }
      files.push(
        {
          path: `trail/${ref}/${shard}.visited.bin`,
          body: Buffer.from(aBits),
          contentType: 'application/octet-stream',
        },
        {
          path: `trail/${ref}/${shard}.new.bin`,
          body: added,
          contentType: 'application/octet-stream',
        },
      );
    }

    const position = (rec: PlayerRecord, day: number): RecapPosition | null => {
      if (rec.x === null || rec.z === null) return null;
      const s = after?.shards[rec.shard];
      if (s === undefined) return null;
      const atBase =
        rec.shard === 'master' &&
        base !== null &&
        Math.hypot(rec.x - base.x, rec.z - base.z) <= AT_BASE_RADIUS;
      return { day, shard: rec.shard, biome: biomeAt(s.world.map, rec.x, rec.z), atBase };
    };

    const daily = new Map<string, RecapPosition>();
    for (const rec of d.afterAll.sort((x, y) => x.n - y.n)) {
      const meta = after?.shards[rec.shard]?.metas.get(rec.n);
      if (meta === undefined) continue;
      const pos = position(rec, meta.cycles + 1);
      // The first save of a day is DST's dawn autosave; later same-day saves are pauses and the
      // shutdown, whose position is `lastPosition` anyway.
      const key = `${pos?.day}/${pos?.shard}`;
      if (pos !== null && !daily.has(key)) daily.set(key, pos);
    }
    const dailyPositions = [...daily.values()].sort(
      (x, y) => x.day - y.day || x.shard.localeCompare(y.shard),
    );
    const endDay = end?.day ?? null;
    const lastPosition =
      newestAfter !== null && endDay !== null ? position(newestAfter, endDay) : null;
    if (newestAfter !== null && newestAfter.x !== null && newestAfter.z !== null) {
      stops.push({ ref, shard: newestAfter.shard, x: newestAfter.x, z: newestAfter.z });
    }

    const learnedSet = new Set<string>();
    const beforeRecipes = new Set([...d.beforeRecs].flatMap((r) => [...recipesOf(r)]));
    for (const r of d.afterRecs)
      for (const x of recipesOf(r)) if (!beforeRecipes.has(x)) learnedSet.add(x);
    const learned: RecapNamed[] =
      d.beforeRecs.length === 0
        ? [] // no baseline (a brand-new player, or no pre-session save): every recipe is not news
        : [...learnedSet]
            .sort()
            .map((r) => ({ prefab: r, name: displayName(GAME_DATA.recipeProducts[r] ?? r) }));
    if (newestBefore === null && before !== null && d.afterRecs.length > 0) {
      notes.add(`${ref} has no save before this session (first session in this world)`);
    }

    const character = newestAfter?.prefab ?? newestBefore?.prefab ?? null;
    const deaths =
      d.persona === null
        ? 0
        : logs.events.filter((e) => e.kind === 'death' && e.persona === d.persona).length;
    const revives =
      d.persona === null
        ? 0
        : logs.events.filter((e) => e.kind === 'revive' && e.persona === d.persona).length;
    if (d.ku === null) notes.add(`${ref}: no log line links this save to a Steam account`);

    players.push({
      ref,
      persona: d.persona,
      character,
      characterName: character !== null ? characterName(character) : null,
      presentBefore: d.beforeRecs.length > 0,
      presentAfter: d.afterRecs.length > 0,
      newTiles,
      totalTiles,
      dailyPositions,
      lastPosition,
      learned,
      carrying: newestAfter !== null ? carryingOf(newestAfter.data, newestAfter.shard) : null,
      deaths,
      revives,
      caveTrips: d.ku !== null ? (logs.caveTrips.get(d.ku) ?? 0) : 0,
      stats: statsOf(newestAfter),
    });
  }

  // Tile maps are only meaningful with their dimensions.
  if (files.length > 0 && after !== null) {
    const dims = Object.fromEntries(
      Object.entries(after.shards).map(([k, s]) => [
        k,
        { width: s.world.map.width, height: s.world.map.height },
      ]),
    );
    files.push({
      path: 'trail/index.json',
      body: Buffer.from(
        JSON.stringify(
          { format: 'bitmap, 1 bit per tile, MSB-first, row-major (row = y)', dims },
          null,
          2,
        ),
      ),
      contentType: 'application/json',
    });
  }

  // ---- map (docs/decisions.md §19) --------------------------------------------------------
  if (after !== null) {
    const map = buildMap({
      shards: Object.fromEntries(Object.entries(after.shards).map(([k, s]) => [k, s.world])),
      base,
      stops,
      isOwnContainer: (prefab) => isPlaceable(prefab) || FOLLOWER_CONTAINERS.has(prefab),
      displayName,
      day: end?.day ?? null,
      stoppedAt: input.manifest.stoppedAt ?? null,
    });
    files.push(...map.files);
    for (const n of map.notes) notes.add(n);
  }

  // ---- deaths ------------------------------------------------------------------------------
  // TODO(events): kills, crafts and a timed path need the live engine — position polling
  // (docs/research/map-inventory-recap.md §3.4) or a server-only event mod (§3.5). Deaths and
  // revives are all the chat log carries.
  const deaths: RecapDeath[] = [];
  for (const [i, e] of logs.events.entries()) {
    if (e.kind !== 'death') continue;
    const revive = logs.events
      .slice(i + 1)
      .find((r) => r.kind === 'revive' && r.persona === e.persona);
    const nextDeath = logs.events
      .slice(i + 1)
      .find((r) => r.kind === 'death' && r.persona === e.persona);
    const counted =
      revive !== undefined && (nextDeath === undefined || revive.seconds <= nextDeath.seconds);
    deaths.push({
      player: refByPersona.get(e.persona) ?? null,
      persona: e.persona,
      cause: e.detail ?? 'unknown',
      minute: Math.floor(e.seconds / 60),
      revivedBy: counted ? (revive.detail ?? null) : null,
      revivedAfterMinutes: counted ? Math.round((revive.seconds - e.seconds) / 60) : null,
    });
  }

  // ---- session -----------------------------------------------------------------------------
  const m = input.manifest;
  const from = m.joinableAt ?? m.startedAt ?? null;
  const realMinutes =
    from && m.stoppedAt ? Math.round((Date.parse(m.stoppedAt) - Date.parse(from)) / 60_000) : null;
  const continuous =
    input.previousPostStopVersionId === undefined || input.previousPostStopVersionId === null
      ? null
      : (m.preStartVersionId ?? null) === input.previousPostStopVersionId;
  if (continuous === false) {
    notes.add(
      'the world was restored or re-seeded before this session: deltas compare against that restore',
    );
  }

  const recap: Recap = {
    schemaVersion: RECAP_SCHEMA_VERSION,
    digestVersion: DIGEST_VERSION,
    worldId: input.worldId,
    sessionId: input.sessionId,
    generatedAt: input.now.toISOString(),
    hasCaves,
    session: {
      startedAt: m.startedAt ?? null,
      joinableAt: m.joinableAt ?? null,
      stoppedAt: m.stoppedAt ?? null,
      stopReason: m.stopReason ?? null,
      realMinutes,
      peakPlayers: m.peakPlayers ?? null,
      startedBy: m.startedBy ?? null,
      dstBuildId: m.dstBuildId ?? null,
    },
    continuous,
    status: before !== null && after !== null ? 'ok' : 'partial',
    notes: [...notes],
    time: {
      start,
      end,
      daysPassed: start !== null && end !== null ? end.day - start.day : null,
      seasonChanges,
    },
    built,
    destroyed,
    storage,
    containers,
    deaths,
    players,
    noteAtDigest: input.note ?? null,
  };
  return {
    recap,
    players: { schemaVersion: RECAP_SCHEMA_VERSION, players: privatePlayers },
    files,
  };
}

// Exposed for unit tests.
export const _internal = { calendar, diffMaps, sortedCounts, tileOf, isBitSet };
