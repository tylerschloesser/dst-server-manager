// @dst/supervisor adapters: the data bucket (docs/storage.md §1, §4). The instance role has
// `s3:GetObject`/`s3:GetObjectVersion` on `worlds/*`, `binaries/*`, `runtime/*`, `runtime-cache/*`
// and `s3:PutObject` on `worlds/*`, `inflight/*`, `sessions/*`, `binaries/*`, `runtime-cache/*` —
// never `seed/*`, never a delete. Uploaded with the SDK, not the CLI, so `VersionId` comes back
// (docs/game-server.md §10).
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';

import type { ObjectPort } from '../core';

// `StreamingBlobPayloadInputTypes` lives in `@smithy/types`, a transitive dependency this package
// does not declare directly (docs/game-server.md §1's dependency list is exhaustive). Deriving the
// field's type structurally from the command's own constructor avoids naming it.
type PutObjectBody = ConstructorParameters<typeof PutObjectCommand>[0]['Body'];

function isNoSuchKey(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name: unknown }).name === 'NoSuchKey'
  );
}

export function createS3Adapter(client: S3Client, bucket: string): ObjectPort {
  return {
    async getObject(key: string) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (res.Body === undefined) return null;
        return {
          body: res.Body as unknown as NodeJS.ReadableStream,
          versionId: res.VersionId ?? null,
        };
      } catch (err) {
        if (isNoSuchKey(err)) return null;
        throw err;
      }
    },
    async putObject(key: string, body: NodeJS.ReadableStream | Buffer) {
      const res = await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body as unknown as PutObjectBody,
        }),
      );
      return { versionId: res.VersionId ?? null };
    },
  };
}
