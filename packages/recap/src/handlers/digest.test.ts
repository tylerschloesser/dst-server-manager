import type { S3Event } from 'aws-lambda';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SaveFormatError, configureLuaWasm } from '../core/lua';
import type { PipelineOutput } from '../pipeline';

// No AWS client is ever used: the adapters and the pipeline are replaced wholesale.
const h = vi.hoisted(() => ({
  writeDigest: vi.fn(async (_w: string, _s: string, files: { path: string }[]) =>
    files.map((f) => `k/${f.path}`),
  ),
  runPipeline: vi.fn(),
  source: { fake: 'source' },
  notes: { getNotes: async () => [] },
}));
vi.mock('../adapters/aws', () => ({
  createS3Client: vi.fn(() => ({})),
  createS3Source: vi.fn(() => h.source),
  createS3DigestWriter: vi.fn(() => h.writeDigest),
  createDynamoNoteSource: vi.fn(() => h.notes),
  readAnthropicKeyFromSsm: vi.fn(async () => 'test-key-not-real'),
}));
// The handler points wasmoon at `glue.wasm` next to the bundle, which only exists in dist/.
vi.mock('../core/lua', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core/lua')>()),
  configureLuaWasm: vi.fn(),
}));
vi.mock('../pipeline', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../pipeline')>()),
  runPipeline: h.runPipeline,
}));

const { handler, parseManifestKey } = await import('./digest');
const wasmCalls = [...vi.mocked(configureLuaWasm).mock.calls]; // module init, before any reset

const S = '20260101T000000Z-abc123';
const event = (...keys: string[]) =>
  ({ Records: keys.map((key) => ({ s3: { object: { key } } })) }) as unknown as S3Event;

let logs: Record<string, unknown>[] = [];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => {
    logs.push(JSON.parse(line) as Record<string, unknown>);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  h.runPipeline.mockReset();
  h.writeDigest.mockClear();
});

describe('parseManifestKey', () => {
  it('extracts world and session from a manifest key', () => {
    expect(parseManifestKey(`sessions/test-a/${S}/manifest.json`)).toEqual({
      worldId: 'test-a',
      sessionId: S,
    });
    expect(parseManifestKey(`sessions/tylerni2026/${S}/manifest.json`)?.worldId).toBe(
      'tylerni2026',
    );
  });

  it('URL-decodes the key, with + as a space', () => {
    expect(parseManifestKey('sessions/test-a/2026%2D01/manifest.json')).toEqual({
      worldId: 'test-a',
      sessionId: '2026-01',
    });
    expect(parseManifestKey('sessions/test-a/a+b/manifest.json')?.sessionId).toBe('a b');
    expect(parseManifestKey('sessions%2Ftest-a%2Fs1%2Fmanifest.json')?.sessionId).toBe('s1');
  });

  it('returns null for anything that is not a session manifest or has a bad world id', () => {
    for (const key of [
      `sessions/test-a/${S}/master/server_log.txt`,
      `sessions/test-a/${S}/digest/manifest.json`,
      `sessions/test-a/manifest.json`,
      `worlds/test-a/manifest.json`,
      `sessions/Bad_World/${S}/manifest.json`,
      `sessions/${'a'.repeat(33)}/${S}/manifest.json`,
      `xsessions/test-a/${S}/manifest.json`,
      `sessions/test-a/${S}/manifest.json.bak`,
    ]) {
      expect(parseManifestKey(key), key).toBeNull();
    }
  });
});

describe('handler', () => {
  it('points wasmoon at the glue.wasm shipped next to the bundle', () => {
    expect(wasmCalls).toEqual([[expect.stringMatching(/[/\\]glue\.wasm$/)]]);
  });

  const output = {
    recap: { status: 'ok', players: [{}, {}] },
    summaryMeta: { status: 'ok', model: 'claude-opus-5', costUsd: 0.01 },
    files: [{ path: 'recap.json' }, { path: 'players.json' }],
  } as unknown as PipelineOutput;

  it('ignores non-manifest keys without running the pipeline', async () => {
    await handler(event(`sessions/test-a/${S}/master/server_log.txt`));
    expect(h.runPipeline).not.toHaveBeenCalled();
    expect(logs).toContainEqual({
      event: 'digest_ignored',
      key: `sessions/test-a/${S}/master/server_log.txt`,
    });
  });

  it('runs the pipeline and writes its files under the digest prefix', async () => {
    h.runPipeline.mockResolvedValueOnce(output);
    await handler(event(`sessions/test-a/${S}/manifest.json`));
    expect(h.runPipeline).toHaveBeenCalledWith(
      expect.objectContaining({
        source: h.source,
        worldId: 'test-a',
        sessionId: S,
        note: h.notes,
        apiKey: 'test-key-not-real',
      }),
    );
    expect(h.writeDigest).toHaveBeenCalledWith('test-a', S, output.files);
    expect(logs.find((l) => l['event'] === 'digest_done')).toMatchObject({
      worldId: 'test-a',
      sessionId: S,
      status: 'ok',
      players: 2,
      files: 2,
      summary_status: 'ok',
      summary_reason: null,
      summary_model: 'claude-opus-5',
      summary_cost_usd: 0.01,
    });
    // the API key is never logged
    expect(JSON.stringify(logs)).not.toContain('test-key-not-real');
  });

  it('a SaveFormatError writes nothing, logs digest_parse_failed, and does not throw', async () => {
    h.runPipeline.mockRejectedValueOnce(new SaveFormatError('after/master/world: bad'));
    await expect(handler(event(`sessions/test-a/${S}/manifest.json`))).resolves.toBeUndefined();
    expect(h.writeDigest).not.toHaveBeenCalled();
    expect(logs).toContainEqual({
      event: 'digest_parse_failed',
      worldId: 'test-a',
      sessionId: S,
      error: 'after/master/world: bad',
    });
  });

  it('any other error is logged and rethrown for the Lambda retry', async () => {
    h.runPipeline.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'SlowDown' }));
    await expect(handler(event(`sessions/test-a/${S}/manifest.json`))).rejects.toThrow('x');
    expect(logs).toContainEqual({
      event: 'digest_failed',
      worldId: 'test-a',
      sessionId: S,
      error: 'SlowDown',
    });
    expect(h.writeDigest).not.toHaveBeenCalled();
  });

  it('handles several records, continuing past a parse failure', async () => {
    h.runPipeline.mockRejectedValueOnce(new SaveFormatError('bad')).mockResolvedValueOnce(output);
    await handler(event(`sessions/test-a/s1/manifest.json`, `sessions/test-a/s2/manifest.json`));
    expect(h.runPipeline).toHaveBeenCalledTimes(2);
    expect(h.writeDigest).toHaveBeenCalledTimes(1);
    expect(h.writeDigest.mock.calls[0]![1]).toBe('s2');
  });
});
