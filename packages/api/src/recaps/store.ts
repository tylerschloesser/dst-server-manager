// The recap scan (docs/control-plane.md §5.6): newest sessions first, only those with a valid
// digest. Written against the tiny `ObjectReader` port so the S3 adapter and the in-memory fake
// that local dev and e2e use run exactly this code.
import { DIGEST_DIR, RECAP_SCHEMA_VERSION, SESSIONS_PREFIX } from '@dst/shared';

import type { ObjectReader, RecapStore, StoredRecap } from '../ports';

/** Newest session prefixes examined per request. A world whose last 30 sessions all lack a digest
 *  shows fewer recaps rather than costing a request per session it has ever had. */
export const RECAP_SCAN_CAP = 30;

/** Session ids are `20260927T033435Z-776769`; anything else under `sessions/<w>/` is ignored. */
const SESSION_DIR_RE = /^[A-Za-z0-9-]{1,64}$/;

export function digestKey(worldId: string, sessionId: string, file: string): string {
  return `${SESSIONS_PREFIX}${worldId}/${sessionId}/${DIGEST_DIR}/${file}`;
}

function logSkip(worldId: string, sessionId: string, reason: string): void {
  console.log(JSON.stringify({ event: 'recap_skipped', worldId, sessionId, reason }));
}

function parseJson(text: string | null): { ok: true; value: unknown } | { ok: false } {
  if (text === null) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

async function readOne(
  objects: ObjectReader,
  worldId: string,
  sessionId: string,
): Promise<StoredRecap | null> {
  try {
    const recapText = await objects.getText(digestKey(worldId, sessionId, 'recap.json'));
    if (recapText === null) {
      logSkip(worldId, sessionId, 'missing');
      return null;
    }
    const parsed = parseJson(recapText);
    if (!parsed.ok || !isRecord(parsed.value)) {
      logSkip(worldId, sessionId, 'invalid_json');
      return null;
    }
    const recap = parsed.value;
    if (recap['schemaVersion'] !== RECAP_SCHEMA_VERSION) {
      logSkip(worldId, sessionId, 'schema_version');
      return null;
    }
    if (recap['sessionId'] !== sessionId) {
      logSkip(worldId, sessionId, 'session_mismatch');
      return null;
    }

    const [playersText, metaText, summaryText] = await Promise.all([
      objects.getText(digestKey(worldId, sessionId, 'players.json')),
      objects.getText(digestKey(worldId, sessionId, 'summary.json')),
      objects.getText(digestKey(worldId, sessionId, 'summary.md')),
    ]);
    const players = parseJson(playersText);
    const meta = parseJson(metaText);
    return {
      sessionId,
      recap,
      players: players.ok ? players.value : null,
      summaryMeta: meta.ok ? meta.value : null,
      summaryText,
    };
  } catch (err) {
    const name = err instanceof Error ? err.name : 'Error';
    logSkip(worldId, sessionId, `read_failed:${name}`);
    return null;
  }
}

/** The world's newest `RECAP_SCAN_CAP` session ids, newest first. Shared with the map scan. */
export async function recentSessionIds(objects: ObjectReader, worldId: string): Promise<string[]> {
  const prefix = `${SESSIONS_PREFIX}${worldId}/`;
  const prefixes = await objects.listPrefixes(prefix);
  return prefixes
    .filter((p) => p.startsWith(prefix))
    .map((p) => p.slice(prefix.length).replace(/\/$/, ''))
    .filter((id) => SESSION_DIR_RE.test(id))
    .sort()
    .reverse()
    .slice(0, RECAP_SCAN_CAP);
}

export function createRecapStore(objects: ObjectReader): RecapStore {
  return {
    async listRecent(worldId: string, limit: number): Promise<StoredRecap[]> {
      const sessionIds = await recentSessionIds(objects, worldId);

      const found: StoredRecap[] = [];
      let next = 0;
      // Read only as many sessions at a time as are still missing: the common case (every
      // session has a digest) costs exactly `limit` recap.json reads, in parallel.
      while (found.length < limit && next < sessionIds.length) {
        const batch = sessionIds.slice(next, next + (limit - found.length));
        next += batch.length;
        const results = await Promise.all(batch.map((id) => readOne(objects, worldId, id)));
        for (const r of results) if (r !== null) found.push(r);
      }
      return found.slice(0, limit);
    },
  };
}
