// The map scan (docs/decisions.md §19, docs/control-plane.md §5.8): the viewer's newest session
// that has a map index AND a trail of theirs. That is the map as the viewer last saw it — if a
// friend played alone since, their sessions are skipped, exactly as the in-game map would not
// know what changed. Reads only the viewer's own trail files; another player's are never fetched.
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

/** The viewer's ref in one session's private `players.json`, or null. Raw reads: the SteamID64
 *  is compared, never copied anywhere. */
export function refForViewer(playersFile: unknown, steamId64: string): string | null {
  const r = rec(playersFile);
  if (r === null || r['schemaVersion'] !== RECAP_SCHEMA_VERSION) return null;
  for (const p of Array.isArray(r['players']) ? r['players'] : []) {
    const pr = rec(p);
    const ref = pr?.['ref'];
    if (pr?.['steamId64'] === steamId64 && typeof ref === 'string' && REF_RE.test(ref)) return ref;
  }
  return null;
}

async function readOne(
  objects: ObjectReader,
  worldId: string,
  sessionId: string,
  steamId64: string,
): Promise<StoredMap | null> {
  const key = (file: string) => digestKey(worldId, sessionId, file);
  const [indexText, playersText] = await Promise.all([
    objects.getText(key(MAP_INDEX_FILE)),
    objects.getText(key('players.json')),
  ]);
  if (indexText === null) return null; // no map in this digest (digest-1, or a map-less save)
  const ref = refForViewer(parseJson(playersText), steamId64);
  if (ref === null) return null; // the viewer did not play this session
  const index = parseJson(indexText);
  const listed = rec(rec(index)?.['shards']);
  if (listed === null) return null;

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
  return { sessionId, ref, index, shards };
}

export function createMapStore(objects: ObjectReader): MapStore {
  return {
    async findForViewer(worldId: string, steamId64: string): Promise<StoredMap | null> {
      for (const sessionId of await recentSessionIds(objects, worldId)) {
        try {
          const found = await readOne(objects, worldId, sessionId, steamId64);
          if (found !== null) return found;
        } catch (err) {
          const name = err instanceof Error ? err.name : 'Error';
          console.log(
            JSON.stringify({
              event: 'map_skipped',
              worldId,
              sessionId,
              reason: `read_failed:${name}`,
            }),
          );
        }
      }
      return null;
    },
  };
}
