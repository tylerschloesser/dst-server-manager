// AWS adapters for the digest (docs/infra.md §3.7). Read-only except `createS3DigestWriter`,
// which refuses any key outside `sessions/<w>/<s>/digest/` — the same boundary the Lambda's IAM
// enforces (`WriteDigest`), checked again here so a bug cannot even attempt it.
import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';

import {
  CONTROL_REGION,
  DATA_BUCKET,
  DIGEST_DIR,
  GAME_REGION,
  NOTE_PK,
  parseNotesItem,
  PARAM_ANTHROPIC_API_KEY,
  SESSIONS_PREFIX,
  TABLE_NAME,
  WORLD_ID_RE,
} from '@dst/shared';

import type { DigestFile, ManifestLike } from '../core/digest';
import type { NoteSource, SessionSource } from '../pipeline';

type Log = (event: Record<string, unknown>) => void;

/** Errors that mean "that object is not there (any more)". A missing key under a prefix-scoped
 *  ListBucket grant can surface as AccessDenied rather than NoSuchKey. */
function isAbsent(err: unknown): boolean {
  const name = (err as { name?: string }).name;
  return (
    name === 'NoSuchKey' ||
    name === 'NoSuchVersion' ||
    name === 'NotFound' ||
    name === 'AccessDenied'
  );
}

export function createS3Client(): S3Client {
  return new S3Client({ region: GAME_REGION });
}

export function createS3Source(
  s3: S3Client,
  log: Log = () => {},
  bucket = DATA_BUCKET,
): SessionSource {
  async function get(key: string, versionId?: string): Promise<Buffer | null> {
    try {
      const res = await s3.send(
        new GetObjectCommand({
          Bucket: bucket,
          Key: key,
          ...(versionId ? { VersionId: versionId } : {}),
        }),
      );
      if (res.Body === undefined) return null;
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (err) {
      if (isAbsent(err)) {
        log({
          event: 's3_object_absent',
          key,
          versionId: versionId ?? null,
          error: (err as Error).name,
        });
        return null;
      }
      throw err;
    }
  }
  const sessionKey = (w: string, s: string, rel: string) => `${SESSIONS_PREFIX}${w}/${s}/${rel}`;

  return {
    async listSessions(worldId) {
      const out: string[] = [];
      let token: string | undefined;
      do {
        const res = await s3.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: `${SESSIONS_PREFIX}${worldId}/`,
            Delimiter: '/',
            ContinuationToken: token,
          }),
        );
        for (const p of res.CommonPrefixes ?? []) {
          const id = p.Prefix?.slice(`${SESSIONS_PREFIX}${worldId}/`.length).replace(/\/$/, '');
          if (id) out.push(id);
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (token !== undefined);
      return out.sort();
    },
    async readManifest(worldId, sessionId) {
      const buf = await get(sessionKey(worldId, sessionId, 'manifest.json'));
      return buf === null ? null : (JSON.parse(buf.toString('utf8')) as ManifestLike);
    },
    async readText(worldId, sessionId, relPath) {
      const buf = await get(sessionKey(worldId, sessionId, relPath));
      return buf === null ? null : buf.toString('utf8');
    },
    async readSaveVersion(worldId, versionId) {
      return get(`worlds/${worldId}/save.tar.zst`, versionId);
    },
    async readDigestFile(worldId, sessionId, name) {
      return get(sessionKey(worldId, sessionId, `${DIGEST_DIR}/${name}`));
    },
  };
}

const DIGEST_KEY_RE = /^sessions\/[a-z0-9-]{1,32}\/[A-Za-z0-9-]{1,64}\/digest\/[A-Za-z0-9._/-]+$/;

/** The one S3 key shape the digest may write. Throws on anything else. */
export function digestKey(worldId: string, sessionId: string, relPath: string): string {
  const key = `${SESSIONS_PREFIX}${worldId}/${sessionId}/${DIGEST_DIR}/${relPath}`;
  if (!WORLD_ID_RE.test(worldId) || !DIGEST_KEY_RE.test(key) || key.split('/').includes('..')) {
    throw new Error(`refusing to write outside sessions/*/digest/: ${key}`);
  }
  return key;
}

export function createS3DigestWriter(s3: S3Client, bucket = DATA_BUCKET) {
  return async (worldId: string, sessionId: string, files: DigestFile[]): Promise<string[]> => {
    const keys = files.map((f) => digestKey(worldId, sessionId, f.path)); // validate all first
    for (const [i, f] of files.entries()) {
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: keys[i],
          Body: f.body,
          ContentType: f.contentType,
        }),
      );
    }
    return keys;
  };
}

/** The per-world "next time" notes (`pk=NOTE, sk=<worldId>`, the `notes` map or a legacy `text`;
 *  docs/control-plane.md §5.7), newest first, parsed by the API's own `parseNotesItem`. Never
 *  throws: a missing item or an error reads as "no notes". */
export function createDynamoNoteSource(log: Log = () => {}): NoteSource {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region: CONTROL_REGION }));
  return {
    async getNotes(worldId) {
      try {
        const res = await doc.send(
          new GetCommand({
            TableName: TABLE_NAME,
            Key: { pk: NOTE_PK, sk: worldId },
            ProjectionExpression: '#n, #t',
            ExpressionAttributeNames: { '#n': 'notes', '#t': 'text' },
          }),
        );
        return parseNotesItem(res.Item).map((n) => n.text);
      } catch (err) {
        log({ event: 'note_read_failed', error: (err as Error).name });
        return [];
      }
    },
  };
}

/** The optional `/dst/anthropic-api-key` (us-west-2). Missing or unreadable -> null: the digest
 *  still runs, the summary is marked unavailable. The value is never logged. */
export async function readAnthropicKeyFromSsm(log: Log = () => {}): Promise<string | null> {
  try {
    const res = await new SSMClient({ region: GAME_REGION }).send(
      new GetParameterCommand({ Name: PARAM_ANTHROPIC_API_KEY, WithDecryption: true }),
    );
    const v = res.Parameter?.Value;
    return v !== undefined && v.trim() !== '' ? v.trim() : null;
  } catch (err) {
    log({ event: 'anthropic_key_unavailable', error: (err as Error).name });
    return null;
  }
}
