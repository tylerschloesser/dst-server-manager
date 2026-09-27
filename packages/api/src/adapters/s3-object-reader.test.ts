// docs/control-plane.md §5.6: the S3 ObjectReader, against a fake `send` (no SDK mock, no network).
import { GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DATA_BUCKET } from '@dst/shared';

import { createS3ObjectReader } from './s3-object-reader';
import type { S3Sender } from './s3-object-reader';

function s3Error(name: string, status: number): Error {
  const err = new Error(name);
  err.name = name;
  (err as unknown as { $metadata: { httpStatusCode: number } }).$metadata = {
    httpStatusCode: status,
  };
  return err;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createS3ObjectReader', () => {
  it('lists CommonPrefixes with Delimiter "/" across every page', async () => {
    const inputs: unknown[] = [];
    const sender: S3Sender = {
      send: vi.fn(async (cmd) => {
        expect(cmd).toBeInstanceOf(ListObjectsV2Command);
        inputs.push(cmd.input);
        if ((cmd.input as { ContinuationToken?: string }).ContinuationToken === undefined) {
          return {
            CommonPrefixes: [{ Prefix: 'sessions/w/a/' }],
            IsTruncated: true,
            NextContinuationToken: 't1',
          };
        }
        return { CommonPrefixes: [{ Prefix: 'sessions/w/b/' }], IsTruncated: false };
      }),
    };
    const out = await createS3ObjectReader(sender).listPrefixes('sessions/w/');
    expect(out).toEqual(['sessions/w/a/', 'sessions/w/b/']);
    expect(inputs).toEqual([
      { Bucket: DATA_BUCKET, Prefix: 'sessions/w/', Delimiter: '/', ContinuationToken: undefined },
      { Bucket: DATA_BUCKET, Prefix: 'sessions/w/', Delimiter: '/', ContinuationToken: 't1' },
    ]);
  });

  it('reads an object body as text', async () => {
    const sender: S3Sender = {
      send: vi.fn(async (cmd) => {
        expect(cmd).toBeInstanceOf(GetObjectCommand);
        expect(cmd.input).toEqual({ Bucket: DATA_BUCKET, Key: 'k' });
        return { Body: { transformToString: async () => '{"a":1}' } };
      }),
    };
    expect(await createS3ObjectReader(sender).getText('k')).toBe('{"a":1}');
  });

  it('maps NoSuchKey (404) and AccessDenied (403, logged) to null', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errors = [s3Error('NoSuchKey', 404), s3Error('AccessDenied', 403)];
    const sender: S3Sender = {
      send: vi.fn(async () => {
        throw errors.shift();
      }),
    };
    const reader = createS3ObjectReader(sender);
    expect(await reader.getText('a')).toBeNull();
    expect(await reader.getText('b')).toBeNull();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]?.[0])).toContain('recap_object_denied');
  });

  it('rethrows anything else', async () => {
    const sender: S3Sender = {
      send: vi.fn(async () => {
        throw s3Error('SlowDown', 503);
      }),
    };
    await expect(createS3ObjectReader(sender).getText('k')).rejects.toThrow('SlowDown');
  });
});
