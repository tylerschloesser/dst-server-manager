// ObjectReader over the data bucket (docs/control-plane.md §5.6). Read-only: the API role holds
// `s3:GetObject` on `sessions/*/digest/*` and `s3:ListBucket` limited to `s3:prefix` `sessions/*`,
// nothing else in the bucket. The bucket lives in GAME_REGION; the API Lambda in CONTROL_REGION,
// so the client is pinned to the bucket's region.
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

import { DATA_BUCKET, GAME_REGION } from '@dst/shared';

import type { ObjectReader } from '../ports';

/** Structural slice of `S3Client` so tests can hand in a fake `send` without an SDK mock. */
export interface S3Sender {
  send(command: ListObjectsV2Command | GetObjectCommand): Promise<unknown>;
}

const MAX_LIST_PAGES = 20; // 20 000 sessions: far beyond any real world, a hard stop on a bad loop

function httpStatus(err: unknown): number | undefined {
  const meta = (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata;
  return meta?.httpStatusCode;
}

/** 404 is "no such object". 403 is also "absent" here: S3 answers a GET for a missing key with
 *  403 instead of 404 whenever the caller's `s3:ListBucket` does not cover that key, and a
 *  missing optional digest file (summary.md) must not fail the whole request. It is logged, so a
 *  genuine permissions regression is still visible. */
function isAbsent(err: unknown, key: string): boolean {
  const name = err instanceof Error ? err.name : '';
  const status = httpStatus(err);
  if (name === 'NoSuchKey' || name === 'NotFound' || status === 404) return true;
  if (name === 'AccessDenied' || status === 403) {
    console.log(JSON.stringify({ event: 'recap_object_denied', key }));
    return true;
  }
  return false;
}

export function createS3ObjectReader(
  client: S3Sender = new S3Client({ region: GAME_REGION }),
  bucket: string = DATA_BUCKET,
): ObjectReader {
  return {
    async listPrefixes(prefix: string): Promise<string[]> {
      const out: string[] = [];
      let token: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const res = (await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            Delimiter: '/',
            ContinuationToken: token,
          }),
        )) as {
          CommonPrefixes?: { Prefix?: string }[];
          IsTruncated?: boolean;
          NextContinuationToken?: string;
        };
        for (const p of res.CommonPrefixes ?? []) if (p.Prefix !== undefined) out.push(p.Prefix);
        if (res.IsTruncated !== true || res.NextContinuationToken === undefined) break;
        token = res.NextContinuationToken;
      }
      return out;
    },

    async getText(key: string): Promise<string | null> {
      try {
        const res = (await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))) as {
          Body?: { transformToString(encoding?: string): Promise<string> };
        };
        if (res.Body === undefined) return null;
        return await res.Body.transformToString('utf-8');
      } catch (err) {
        if (isAbsent(err, key)) return null;
        throw err;
      }
    },
  };
}
