import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFsSource, localSaveVersionPath, writeDigestLocally } from './fs-source';

const W = 'test-a';
let root: string;

async function put(rel: string, body: string | Buffer): Promise<void> {
  const p = path.join(root, rel);
  await mkdir(path.dirname(p), { recursive: true });
  await writeFile(p, body);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'recap-fs-source-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('createFsSource', () => {
  it('lists session directories sorted, ignoring files; a missing world lists nothing', async () => {
    await put(`sessions/${W}/20260103T000000Z-c/manifest.json`, '{}');
    await put(`sessions/${W}/20260101T000000Z-a/manifest.json`, '{}');
    await put(`sessions/${W}/20260102T000000Z-b/manifest.json`, '{}');
    await put(`sessions/${W}/stray-file.txt`, 'x');
    const src = createFsSource(root);
    expect(await src.listSessions(W)).toEqual([
      '20260101T000000Z-a',
      '20260102T000000Z-b',
      '20260103T000000Z-c',
    ]);
    expect(await src.listSessions('test-none')).toEqual([]);
  });

  it('reads the manifest and logs; missing files read as null', async () => {
    await put(`sessions/${W}/s1/manifest.json`, '{"postStopVersionId":"v2"}');
    await put(`sessions/${W}/s1/master/server_log.txt`, 'log line\n');
    const src = createFsSource(root);
    expect(await src.readManifest(W, 's1')).toEqual({ postStopVersionId: 'v2' });
    expect(await src.readManifest(W, 's2')).toBeNull();
    expect(await src.readText(W, 's1', 'master/server_log.txt')).toBe('log line\n');
    expect(await src.readText(W, 's1', 'caves/server_log.txt')).toBeNull();
  });

  it('reads a save version from <root>/worlds/<w>/<versionId>.tar.zst, even a dot-leading id', async () => {
    await put(`worlds/${W}/.hiddenVersion_1.tar.zst`, Buffer.from([1, 2, 3]));
    await put(`worlds/${W}/v2.tar.zst`, Buffer.from([4]));
    const src = createFsSource(root);
    expect(await src.readSaveVersion(W, '.hiddenVersion_1')).toEqual(Buffer.from([1, 2, 3]));
    expect(await src.readSaveVersion(W, 'v2')).toEqual(Buffer.from([4]));
    expect(await src.readSaveVersion(W, 'gone')).toBeNull();
    expect(localSaveVersionPath(root, W, '.x')).toBe(path.join(root, 'worlds', W, '.x.tar.zst'));
  });

  it('reads digest files from a separate digest root when given', async () => {
    const digestRoot = path.join(root, 'out');
    await put(`out/sessions/${W}/s1/digest/recap.json`, '{"a":1}');
    await put(`sessions/${W}/s1/digest/recap.json`, '{"a":"wrong root"}');
    expect(
      (await createFsSource(root, digestRoot).readDigestFile(W, 's1', 'recap.json'))!.toString(),
    ).toBe('{"a":1}');
    expect((await createFsSource(root).readDigestFile(W, 's1', 'recap.json'))!.toString()).toBe(
      '{"a":"wrong root"}',
    );
    expect(await createFsSource(root).readDigestFile(W, 's1', 'summary.md')).toBeNull();
  });

  it('non-ENOENT errors propagate', async () => {
    await put(`sessions/${W}/s1/manifest.json/oops`, 'a directory where a file should be');
    await expect(createFsSource(root).readManifest(W, 's1')).rejects.toThrow(/EISDIR/);
  });
});

describe('writeDigestLocally', () => {
  const f = (p: string, body = 'x') => ({ path: p, body: Buffer.from(body), contentType: 'x' });

  it('writes nested files under <digestRoot>/sessions/<w>/<s>/digest/', async () => {
    const dir = await writeDigestLocally(root, W, 's1', [
      f('recap.json', '{}'),
      f('trail/p1/master.new.bin', 'bits'),
    ]);
    expect(dir).toBe(path.join(root, 'sessions', W, 's1', 'digest'));
    expect(await readFile(path.join(dir, 'recap.json'), 'utf8')).toBe('{}');
    expect(await readFile(path.join(dir, 'trail/p1/master.new.bin'), 'utf8')).toBe('bits');
  });

  it('refuses path traversal out of the digest directory', async () => {
    for (const p of ['../manifest.json', 'trail/../../escape.json', '../../../../x', '.', '']) {
      await expect(writeDigestLocally(root, W, 's1', [f(p)]), p).rejects.toThrow(
        /refusing to write outside/,
      );
    }
    await expect(readFile(path.join(root, 'sessions', W, 's1', 'manifest.json'))).rejects.toThrow(
      /ENOENT/,
    );
  });
});
