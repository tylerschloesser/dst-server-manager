// Stored digest -> browser view (docs/control-plane.md §5.6). THE PRIVACY BOUNDARY: every object
// in the response is constructed here, field by field, from a whitelist. Nothing read from S3 is
// ever spread (`...raw`) into the response, so a field a future digest adds (or a KU id / SteamID64
// that ends up somewhere it should not) cannot reach a page. `players.json` — the only file that
// holds KU ids and SteamID64s — is consulted for one thing, the allowlist nickname, and none of its
// values are copied.
import { RECAP_SCHEMA_VERSION } from '@dst/shared';
import type {
  RecapCalendarPoint,
  RecapCarrying,
  RecapContainerGroup,
  RecapDeath,
  RecapEntry,
  RecapEquipped,
  RecapItem,
  RecapItemCondition,
  RecapNamed,
  RecapNamedCount,
  RecapPlayerView,
  RecapPosition,
  RecapSession,
  RecapShard,
  RecapSummaryView,
  RecapView,
  RecapWorldTime,
} from '@dst/shared';

import type { StoredRecap } from '../ports';

type Raw = Record<string, unknown>;

function rec(v: unknown): Raw | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Raw) : null;
}

/** Belt and braces behind the whitelist: even a whitelisted string field (a persona, a death
 *  cause) that somehow carries a KU id or a SteamID64 has it redacted before it can be served. */
const IDENTIFIER_RE = /KU_[A-Za-z0-9_-]+|(?<!\d)7656119\d{10}(?!\d)/g;

function str(v: unknown): string | null {
  return typeof v === 'string' ? v.replace(IDENTIFIER_RE, '[redacted]') : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function bool(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

function list<T>(v: unknown, map: (x: unknown) => T | null): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const x of v) {
    const m = map(x);
    if (m !== null) out.push(m);
  }
  return out;
}

function shard(v: unknown): RecapShard | null {
  return v === 'master' || v === 'caves' ? v : null;
}

function named(v: unknown): RecapNamed | null {
  const r = rec(v);
  const prefab = str(r?.['prefab']);
  if (r === null || prefab === null) return null;
  return { prefab, name: str(r['name']) ?? prefab };
}

function namedCount(v: unknown): RecapNamedCount | null {
  const r = rec(v);
  const n = named(v);
  const delta = num(r?.['delta']);
  if (n === null || delta === null) return null;
  return { prefab: n.prefab, name: n.name, delta };
}

function containerGroup(v: unknown): RecapContainerGroup | null {
  const r = rec(v);
  const n = named(v);
  if (r === null || n === null) return null;
  return {
    prefab: n.prefab,
    name: n.name,
    shard: shard(r['shard']) ?? 'master',
    containers: num(r['containers']) ?? 0,
    items: list(r['items'], namedCount),
  };
}

function calendar(v: unknown): RecapCalendarPoint | null {
  const r = rec(v);
  const day = num(r?.['day']);
  if (r === null || day === null) return null;
  return {
    day,
    season: str(r['season']) ?? '',
    dayOfSeason: num(r['dayOfSeason']),
    daysLeftInSeason: num(r['daysLeftInSeason']),
  };
}

function condition(v: unknown): RecapItemCondition | undefined {
  const r = rec(v);
  if (r === null) return undefined;
  const out: RecapItemCondition = {};
  const usesLeft = num(r['usesLeft']);
  const fuel = num(r['fuel']);
  const armor = num(r['armor']);
  const perishDaysLeft = num(r['perishDaysLeft']);
  if (usesLeft !== null) out.usesLeft = usesLeft;
  if (fuel !== null) out.fuel = fuel;
  if (armor !== null) out.armor = armor;
  if (perishDaysLeft !== null) out.perishDaysLeft = perishDaysLeft;
  return Object.keys(out).length > 0 ? out : undefined;
}

function item(v: unknown): RecapItem | null {
  const r = rec(v);
  const n = named(v);
  if (r === null || n === null) return null;
  const out: RecapItem = { prefab: n.prefab, name: n.name, count: num(r['count']) ?? 1 };
  const c = condition(r['condition']);
  if (c !== undefined) out.condition = c;
  return out;
}

function equipped(v: unknown): RecapEquipped | null {
  const r = rec(v);
  const slot = str(r?.['slot']);
  const it = item(r?.['item']);
  if (slot === null || it === null) return null;
  return { slot, item: it };
}

function carrying(v: unknown): RecapCarrying | null {
  const r = rec(v);
  if (r === null) return null;
  const bp = rec(r['backpack']);
  const bpNamed = named(bp);
  return {
    inventory: list(r['inventory'], item),
    equipped: list(r['equipped'], equipped),
    backpack:
      bp !== null && bpNamed !== null
        ? { prefab: bpNamed.prefab, name: bpNamed.name, items: list(bp['items'], item) }
        : null,
    shard: shard(r['shard']) ?? 'master',
  };
}

function position(v: unknown): RecapPosition | null {
  const r = rec(v);
  const day = num(r?.['day']);
  if (r === null || day === null) return null;
  return {
    day,
    shard: shard(r['shard']) ?? 'master',
    biome: str(r['biome']),
    atBase: bool(r['atBase']) ?? false,
  };
}

function perShard(v: unknown): Record<RecapShard, number | null> {
  const r = rec(v);
  return { master: num(r?.['master']), caves: num(r?.['caves']) };
}

function stats(v: unknown): RecapPlayerView['stats'] {
  const r = rec(v);
  if (r === null) return null;
  return { health: num(r['health']), hunger: num(r['hunger']), sanity: num(r['sanity']) };
}

/** ref -> SteamID64 from the private `players.json`. Only the pair is kept, and only to look up a
 *  nickname; the SteamID64 itself is never returned. */
function steamIdsByRef(playersFile: unknown): Map<string, string> {
  const out = new Map<string, string>();
  const r = rec(playersFile);
  if (r === null || r['schemaVersion'] !== RECAP_SCHEMA_VERSION) return out;
  for (const p of Array.isArray(r['players']) ? r['players'] : []) {
    const pr = rec(p);
    // Raw reads, not `str()`: that one redacts SteamID64s, and this is the one lookup that needs
    // the real value (it is used as a map key and never returned).
    const ref = pr?.['ref'];
    const steamId64 = pr?.['steamId64'];
    if (typeof ref === 'string' && typeof steamId64 === 'string') out.set(ref, steamId64);
  }
  return out;
}

function player(
  v: unknown,
  steamIds: Map<string, string>,
  nicknames: Record<string, string>,
): RecapPlayerView | null {
  const r = rec(v);
  const ref = str(r?.['ref']);
  if (r === null || ref === null) return null;
  const steamId64 = steamIds.get(ref);
  const nickname =
    steamId64 !== undefined && Object.hasOwn(nicknames, steamId64)
      ? (nicknames[steamId64] ?? null)
      : null;
  return {
    ref,
    persona: str(r['persona']),
    character: str(r['character']),
    characterName: str(r['characterName']),
    presentBefore: bool(r['presentBefore']) ?? false,
    presentAfter: bool(r['presentAfter']) ?? false,
    newTiles: perShard(r['newTiles']),
    totalTiles: perShard(r['totalTiles']),
    dailyPositions: list(r['dailyPositions'], position),
    lastPosition: position(r['lastPosition']),
    learned: list(r['learned'], named),
    carrying: carrying(r['carrying']),
    deaths: num(r['deaths']) ?? 0,
    revives: num(r['revives']) ?? 0,
    caveTrips: num(r['caveTrips']) ?? 0,
    stats: stats(r['stats']),
    nickname,
  };
}

function death(v: unknown): RecapDeath | null {
  const r = rec(v);
  const persona = str(r?.['persona']);
  if (r === null || persona === null) return null;
  return {
    player: str(r['player']),
    persona,
    cause: str(r['cause']) ?? 'unknown',
    minute: num(r['minute']) ?? 0,
    revivedBy: str(r['revivedBy']),
    revivedAfterMinutes: num(r['revivedAfterMinutes']),
  };
}

function session(v: unknown): RecapSession {
  const r = rec(v);
  return {
    startedAt: str(r?.['startedAt']),
    joinableAt: str(r?.['joinableAt']),
    stoppedAt: str(r?.['stoppedAt']),
    stopReason: str(r?.['stopReason']),
    realMinutes: num(r?.['realMinutes']),
    peakPlayers: num(r?.['peakPlayers']),
    startedBy: str(r?.['startedBy']),
    dstBuildId: str(r?.['dstBuildId']),
  };
}

function worldTime(v: unknown): RecapWorldTime {
  const r = rec(v);
  return {
    start: calendar(r?.['start']),
    end: calendar(r?.['end']),
    daysPassed: num(r?.['daysPassed']),
    seasonChanges: list(r?.['seasonChanges'], (x) => {
      const c = rec(x);
      const season = str(c?.['season']);
      const day = num(c?.['day']);
      return season !== null && day !== null ? { season, day } : null;
    }),
  };
}

export function toRecapView(
  stored: StoredRecap,
  worldId: string,
  nicknames: Record<string, string>,
): RecapView {
  const r = stored.recap;
  const steamIds = steamIdsByRef(stored.players);
  return {
    schemaVersion: RECAP_SCHEMA_VERSION,
    digestVersion: str(r['digestVersion']) ?? '',
    worldId,
    sessionId: stored.sessionId,
    generatedAt: str(r['generatedAt']) ?? '',
    hasCaves: bool(r['hasCaves']) ?? false,
    session: session(r['session']),
    continuous: bool(r['continuous']),
    status: r['status'] === 'partial' ? 'partial' : 'ok',
    notes: list(r['notes'], str),
    time: worldTime(r['time']),
    built: list(r['built'], namedCount),
    destroyed: list(r['destroyed'], namedCount),
    storage: list(r['storage'], namedCount),
    containers: list(r['containers'], containerGroup),
    deaths: list(r['deaths'], death),
    players: list(r['players'], (p) => player(p, steamIds, nicknames)),
    noteAtDigest: str(r['noteAtDigest']),
  };
}

/** `status: 'ok'` only when `summary.json` says ok AND `summary.md` exists and is non-empty. */
export function toSummaryView(stored: StoredRecap): RecapSummaryView {
  const meta = rec(stored.summaryMeta);
  const text = stored.summaryText?.trim() ?? '';
  if (meta === null || meta['status'] !== 'ok' || text === '') return { status: 'unavailable' };
  return {
    status: 'ok',
    text,
    model: str(meta['model']) ?? '',
    promptVersion: str(meta['promptVersion']) ?? '',
  };
}

export function toRecapEntry(
  stored: StoredRecap,
  worldId: string,
  nicknames: Record<string, string>,
): RecapEntry {
  return {
    sessionId: stored.sessionId,
    recap: toRecapView(stored, worldId, nicknames),
    summary: toSummaryView(stored),
  };
}
