// The map scan (docs/decisions.md §19, docs/control-plane.md §5.8): one map per player, each from
// that player's newest session that has a map index AND a trail of theirs. That is the map as the
// player last saw it — if a friend played alone since, their sessions do not change it, exactly as
// the in-game map would not know what changed. Players without a SteamID64 cannot be followed
// across sessions and are skipped.
import { MAP_INDEX_FILE, RECAP_SCHEMA_VERSION, mapTilesFile, trailFile } from '@dst/shared';
import type { RecapShard } from '@dst/shared';

import type { MapStore, ObjectReader, StoredMap } from '../ports';
import { digestKey, recentSessionIds } from './store';

const SHARDS: RecapShard[] = ['master', 'caves'];
const REF_RE = /^p\d{1,3}$/;

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function rec(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export interface MapPlayer {
  ref: string;
  steamId64: string;
  persona: string | null;
}

/** Every player with a SteamID64 and a well-formed ref in one session's private `players.json`.
 *  Raw reads: the SteamID64 is a lookup key, returned only inside the API. */
export function mapPlayers(playersFile: unknown): MapPlayer[] {
  const r = rec(playersFile);
  if (r === null || r['schemaVersion'] !== RECAP_SCHEMA_VERSION) return [];
  const out: MapPlayer[] = [];
  for (const p of Array.isArray(r['players']) ? r['players'] : []) {
    const pr = rec(p);
    const ref = pr?.['ref'];
    const steamId64 = pr?.['steamId64'];
    const persona = pr?.['persona'];
    if (typeof ref !== 'string' || !REF_RE.test(ref)) continue;
    if (typeof steamId64 !== 'string' || steamId64 === '') continue;
    out.push({ ref, steamId64, persona: typeof persona === 'string' ? persona : null });
  }
  return out;
}

interface SessionHead {
  sessionId: string;
  index: unknown;
  players: MapPlayer[];
}

function logSkipped(worldId: string, sessionId: string, err: unknown): void {
  const name = err instanceof Error ? err.name : 'Error';
  console.log(
    JSON.stringify({ event: 'map_skipped', worldId, sessionId, reason: `read_failed:${name}` }),
  );
}

/** A session's map index and players, or null when it has no map (digest-1, a map-less save). */
async function readHead(
  objects: ObjectReader,
  worldId: string,
  sessionId: string,
): Promise<SessionHead | null> {
  const key = (file: string) => digestKey(worldId, sessionId, file);
  const [indexText, playersText] = await Promise.all([
    objects.getText(key(MAP_INDEX_FILE)),
    objects.getText(key('players.json')),
  ]);
  if (indexText === null) return null;
  const index = parseJson(indexText);
  if (rec(rec(index)?.['shards']) === null) return null;
  return { sessionId, index, players: mapPlayers(parseJson(playersText)) };
}

/** One player's grids and trail in one session; null when they left no trail there. */
async function readMap(
  objects: ObjectReader,
  worldId: string,
  head: SessionHead,
  player: MapPlayer,
): Promise<StoredMap | null> {
  const key = (file: string) => digestKey(worldId, head.sessionId, file);
  const listed = rec(rec(head.index)?.['shards']) ?? {};
  const { ref } = player;
  const shards: StoredMap['shards'] = {};
  await Promise.all(
    SHARDS.filter((s) => rec(listed[s]) !== null).map(async (shard) => {
      const [tilesGz, visited, fresh] = await Promise.all([
        objects.getBytes(key(mapTilesFile(shard))),
        objects.getBytes(key(trailFile(ref, shard, 'visited'))),
        objects.getBytes(key(trailFile(ref, shard, 'new'))),
      ]);
      if (tilesGz !== null && visited !== null) shards[shard] = { tilesGz, visited, fresh };
    }),
  );
  if (Object.keys(shards).length === 0) return null;
  return { sessionId: head.sessionId, ...player, index: head.index, shards };
}

export function createMapStore(objects: ObjectReader): MapStore {
  return {
    async findAll(worldId: string): Promise<StoredMap[]> {
      const sessionIds = await recentSessionIds(objects, worldId);
      const heads = await Promise.all(
        sessionIds.map((sessionId) =>
          readHead(objects, worldId, sessionId).catch((err: unknown) => {
            logSkipped(worldId, sessionId, err);
            return null;
          }),
        ),
      );
      // steamId64 -> the sessions they appear in, newest first (recentSessionIds' order).
      const byPlayer = new Map<string, { head: SessionHead; player: MapPlayer }[]>();
      for (const head of heads) {
        if (head === null) continue;
        for (const player of head.players) {
          const list = byPlayer.get(player.steamId64) ?? [];
          list.push({ head, player });
          byPlayer.set(player.steamId64, list);
        }
      }
      // Each player's newest session that holds a trail of theirs; almost always the first.
      const found = await Promise.all(
        [...byPlayer.values()].map(async (candidates) => {
          for (const { head, player } of candidates) {
            try {
              const map = await readMap(objects, worldId, head, player);
              if (map !== null) return map;
            } catch (err) {
              logSkipped(worldId, head.sessionId, err);
            }
          }
          return null;
        }),
      );
      return found.filter((m): m is StoredMap => m !== null);
    },
  };
}
