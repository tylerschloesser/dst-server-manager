// Digest Lambda entry (docs/infra.md §3.7): S3 ObjectCreated on `sessions/<w>/<s>/manifest.json`
// (the supervisor uploads it last, after the logs). Thin wiring; the work is `runPipeline`.
//
// Failure policy (docs/decisions.md §18): a save-format surprise logs `digest_parse_failed` and
// writes NOTHING (a wrong recap is worse than none) and does not throw, since a retry would fail
// the same way. Anything else (S3/network) throws so Lambda's single async retry can help. The LLM
// can never fail the digest: `summarize` never throws.
import path from 'node:path';

import type { S3Event } from 'aws-lambda';

import { SESSIONS_PREFIX, WORLD_ID_RE } from '@dst/shared';

import {
  createDynamoNoteSource,
  createS3Client,
  createS3DigestWriter,
  createS3Source,
  readAnthropicKeyFromSsm,
} from '../adapters/aws';
import { SaveFormatError, configureLuaWasm } from '../core/lua';
import { runPipeline } from '../pipeline';

// esbuild.mjs copies wasmoon's glue.wasm next to the bundle.
if (typeof __dirname !== 'undefined') configureLuaWasm(path.join(__dirname, 'glue.wasm'));

const log = (event: Record<string, unknown>) => console.log(JSON.stringify(event));
const s3 = createS3Client();
const source = createS3Source(s3, log);
const writeDigest = createS3DigestWriter(s3);
const notes = createDynamoNoteSource(log);

const MANIFEST_RE = new RegExp(`^${SESSIONS_PREFIX}([^/]+)/([^/]+)/manifest\\.json$`);

export function parseManifestKey(rawKey: string): { worldId: string; sessionId: string } | null {
  // S3 event keys are URL-encoded with '+' for spaces.
  let key: string;
  try {
    key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
  } catch {
    return null; // malformed percent-encoding: not a key we wrote
  }
  const m = MANIFEST_RE.exec(key);
  if (m === null || !WORLD_ID_RE.test(m[1]!)) return null;
  return { worldId: m[1]!, sessionId: m[2]! };
}

export const handler = async (event: S3Event): Promise<void> => {
  const apiKey = await readAnthropicKeyFromSsm(log);
  for (const record of event.Records ?? []) {
    const target = parseManifestKey(record.s3.object.key);
    if (target === null) {
      log({ event: 'digest_ignored', key: record.s3.object.key });
      continue;
    }
    const started = Date.now();
    try {
      const out = await runPipeline({
        source,
        ...target,
        note: notes,
        apiKey,
        log: (e) => log({ ...target, ...e }),
      });
      const keys = await writeDigest(target.worldId, target.sessionId, out.files);
      log({
        event: 'digest_done',
        ...target,
        status: out.recap.status,
        players: out.recap.players.length,
        files: keys.length,
        summary_status: out.summaryMeta.status,
        summary_reason: out.summaryMeta.status === 'unavailable' ? out.summaryMeta.reason : null,
        summary_model: out.summaryMeta.status === 'ok' ? out.summaryMeta.model : null,
        summary_cost_usd: out.summaryMeta.status === 'ok' ? out.summaryMeta.costUsd : null,
        ms: Date.now() - started,
      });
    } catch (err) {
      if (err instanceof SaveFormatError) {
        log({ event: 'digest_parse_failed', ...target, error: err.message.slice(0, 300) });
        continue;
      }
      log({ event: 'digest_failed', ...target, error: err instanceof Error ? err.name : 'Error' });
      throw err;
    }
  }
};
