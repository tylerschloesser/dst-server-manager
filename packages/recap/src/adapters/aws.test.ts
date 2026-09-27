import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';

import { DATA_BUCKET } from '@dst/shared';

import { createS3DigestWriter, createS3Source, digestKey } from './aws';

const W = 'test-a';
const S = '20260101T000000Z-abc123';

function fakeS3(impl: (cmd: unknown) => unknown) {
  const send = vi.fn(async (cmd: unknown) => impl(cmd));
  return { send, s3: { send } as unknown as S3Client };
}

const named = (name: string) => Object.assign(new Error(name), { name });
const body = (text: string) => ({
  Body: { transformToByteArray: async () => new TextEncoder().encode(text) },
});

describe('digestKey', () => {
  it('accepts sessions/<w>/<s>/digest/<file> including nested trail paths', () => {
    expect(digestKey(W, S, 'recap.json')).toBe(`sessions/${W}/${S}/digest/recap.json`);
    expect(digestKey(W, S, 'trail/p1/master.new.bin')).toBe(
      `sessions/${W}/${S}/digest/trail/p1/master.new.bin`,
    );
    expect(digestKey('tylerni2026', S, 'summary.md')).toContain('digest/summary.md');
  });

  it('rejects traversal, empty paths, odd characters, bad world ids and bad session ids', () => {
    for (const [w, s, rel] of [
      [W, S, '../manifest.json'],
      [W, S, 'trail/../../manifest.json'],
      [W, S, '../../../../worlds/test-a/save.tar.zst'],
      [W, S, '..'],
      [W, S, ''],
      [W, S, 'has space.json'],
      [W, S, 'q?x=1'],
      ['Bad_World', S, 'recap.json'],
      ['../worlds', S, 'recap.json'],
      ['', S, 'recap.json'],
      ['a'.repeat(33), S, 'recap.json'],
      [W, '', 'recap.json'],
      [W, 'a/b', 'recap.json'],
      [W, '..', 'recap.json'],
      [W, 'x'.repeat(65), 'recap.json'],
    ]) {
      expect(() => digestKey(w!, s!, rel!), `${w} ${s} ${rel}`).toThrow(
        /refusing to write outside sessions\/\*\/digest\//,
      );
    }
  });
});

describe('createS3DigestWriter', () => {
  const file = (path: string) => ({
    path,
    body: Buffer.from('x'),
    contentType: 'application/json',
  });

  it('puts every file under the digest prefix with its content type', async () => {
    const { send, s3 } = fakeS3(() => ({}));
    const keys = await createS3DigestWriter(s3)(W, S, [file('recap.json'), file('trail/p1/a.bin')]);
    expect(keys).toEqual([
      `sessions/${W}/${S}/digest/recap.json`,
      `sessions/${W}/${S}/digest/trail/p1/a.bin`,
    ]);
    expect(send).toHaveBeenCalledTimes(2);
    const cmd = send.mock.calls[0]![0] as PutObjectCommand;
    expect(cmd).toBeInstanceOf(PutObjectCommand);
    expect(cmd.input).toMatchObject({
      Bucket: DATA_BUCKET,
      Key: keys[0],
      ContentType: 'application/json',
    });
  });

  it('validates ALL keys before the first PutObject', async () => {
    const { send, s3 } = fakeS3(() => ({}));
    await expect(
      createS3DigestWriter(s3)(W, S, [file('recap.json'), file('../../manifest.json')]),
    ).rejects.toThrow(/refusing/);
    expect(send).not.toHaveBeenCalled();
  });

  it('honours a bucket override', async () => {
    const { send, s3 } = fakeS3(() => ({}));
    await createS3DigestWriter(s3, 'other-bucket')(W, S, [file('recap.json')]);
    expect((send.mock.calls[0]![0] as PutObjectCommand).input.Bucket).toBe('other-bucket');
  });
});

describe('createS3Source', () => {
  it('lists session ids across pages, sorted', async () => {
    const pages = [
      {
        CommonPrefixes: [{ Prefix: `sessions/${W}/b/` }, { Prefix: `sessions/${W}/a/` }],
        IsTruncated: true,
        NextContinuationToken: 't1',
      },
      { CommonPrefixes: [{ Prefix: `sessions/${W}/c/` }], IsTruncated: false },
    ];
    const { send, s3 } = fakeS3(() => pages.shift());
    expect(await createS3Source(s3).listSessions(W)).toEqual(['a', 'b', 'c']);
    const [first, second] = send.mock.calls.map((c) => c[0] as ListObjectsV2Command);
    expect(first).toBeInstanceOf(ListObjectsV2Command);
    expect(first!.input).toMatchObject({ Prefix: `sessions/${W}/`, Delimiter: '/' });
    expect(second!.input.ContinuationToken).toBe('t1');
  });

  it('reads manifests, logs, digest files and save versions by key (and VersionId)', async () => {
    const { send, s3 } = fakeS3((cmd) => {
      const key = (cmd as GetObjectCommand).input.Key!;
      return body(key.endsWith('manifest.json') ? '{"postStopVersionId":"v2"}' : `K=${key}`);
    });
    const src = createS3Source(s3);
    expect(await src.readManifest(W, S)).toEqual({ postStopVersionId: 'v2' });
    expect(await src.readText(W, S, 'master/server_log.txt')).toBe(
      `K=sessions/${W}/${S}/master/server_log.txt`,
    );
    expect((await src.readDigestFile(W, S, 'players.json'))!.toString()).toBe(
      `K=sessions/${W}/${S}/digest/players.json`,
    );
    expect((await src.readSaveVersion(W, 'v.123'))!.toString()).toBe(`K=worlds/${W}/save.tar.zst`);
    const last = send.mock.calls.at(-1)![0] as GetObjectCommand;
    expect(last).toBeInstanceOf(GetObjectCommand);
    expect(last.input).toMatchObject({ Key: `worlds/${W}/save.tar.zst`, VersionId: 'v.123' });
  });

  it('absent objects (NoSuchKey, NoSuchVersion, NotFound, AccessDenied) read as null and are logged', async () => {
    for (const name of ['NoSuchKey', 'NoSuchVersion', 'NotFound', 'AccessDenied']) {
      const log = vi.fn();
      const { s3 } = fakeS3(() => {
        throw named(name);
      });
      expect(await createS3Source(s3, log).readSaveVersion(W, 'v1')).toBeNull();
      expect(log).toHaveBeenCalledWith({
        event: 's3_object_absent',
        key: `worlds/${W}/save.tar.zst`,
        versionId: 'v1',
        error: name,
      });
    }
  });

  it('any other error propagates (so the Lambda retry can help)', async () => {
    const { s3 } = fakeS3(() => {
      throw named('SlowDown');
    });
    await expect(createS3Source(s3).readManifest(W, S)).rejects.toThrow('SlowDown');
  });

  it('a response without a body reads as null', async () => {
    const { s3 } = fakeS3(() => ({}));
    expect(await createS3Source(s3).readText(W, S, 'x')).toBeNull();
  });
});
