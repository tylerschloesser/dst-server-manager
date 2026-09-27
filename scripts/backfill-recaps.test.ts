import { describe, expect, it } from 'vitest';

import type { SessionSource } from '@dst/recap';

import {
  USAGE,
  needsDigest,
  parseArgs,
  withOverlay,
  withoutSummaryOverwrite,
} from './backfill-recaps';

function source(files: Record<string, string>): SessionSource {
  return {
    listSessions: async () => [],
    readManifest: async () => null,
    readText: async () => null,
    readSaveVersion: async () => null,
    readDigestFile: async (w, s, name) => {
      const v = files[`${w}/${s}/${name}`];
      return v === undefined ? null : Buffer.from(v);
    },
  };
}

describe('backfill-recaps parseArgs', () => {
  it('--help short-circuits before any validation', () => {
    expect(parseArgs(['--help'])).toEqual({ help: true });
    expect(parseArgs(['--world-id', 'BAD!', '--help'])).toEqual({ help: true });
  });

  it('lists every flag in USAGE', () => {
    for (const f of [
      '--world-id',
      '--from-dir',
      '--write',
      '--summaries',
      '--force',
      '--sessions',
      '--out',
      '--variant',
      '--model',
      '--help',
    ]) {
      expect(USAGE).toContain(f);
    }
  });

  it('is a dry run unless --write', () => {
    const a = parseArgs(['--world-id', 'test-a']);
    expect(a).toMatchObject({ help: false, write: false, summaries: false, force: false });
  });

  it('refuses --write with --from-dir, a bad world id, unknown flags, variants and models', () => {
    expect(() => parseArgs(['--world-id', 'test-a', '--write', '--from-dir', '/tmp/x'])).toThrow(
      /cannot be combined/,
    );
    expect(() => parseArgs(['--world-id', 'Bad Id'])).toThrow(/--world-id/);
    expect(() => parseArgs(['--world-id', 'test-a', '--nope'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--world-id', 'test-a', '--variant', 'nope'])).toThrow(/variant/);
    expect(() => parseArgs(['--world-id', 'test-a', '--model', 'nope'])).toThrow(/model/);
  });

  it('parses --sessions as a list', () => {
    expect(parseArgs(['--world-id', 'test-a', '--sessions', 'a,b'])).toMatchObject({
      sessions: ['a', 'b'],
    });
  });
});

describe('backfill-recaps idempotency', () => {
  const ok = JSON.stringify({ status: 'ok' });
  const unavailable = JSON.stringify({ status: 'unavailable', reason: 'no_api_key' });

  it('digests a session with no recap.json', async () => {
    expect(await needsDigest(source({}), 'test-a', 's1', { force: false, summaries: false })).toBe(
      true,
    );
  });

  it('skips an existing digest unless --force', async () => {
    const src = source({ 'test-a/s1/recap.json': '{}' });
    expect(await needsDigest(src, 'test-a', 's1', { force: false, summaries: false })).toBe(false);
    expect(await needsDigest(src, 'test-a', 's1', { force: true, summaries: false })).toBe(true);
  });

  it('with --summaries, redoes a digest whose summary is missing or unavailable, not an ok one', async () => {
    const opts = { force: false, summaries: true };
    expect(await needsDigest(source({ 'test-a/s1/recap.json': '{}' }), 'test-a', 's1', opts)).toBe(
      true,
    );
    expect(
      await needsDigest(
        source({ 'test-a/s1/recap.json': '{}', 'test-a/s1/summary.json': unavailable }),
        'test-a',
        's1',
        opts,
      ),
    ).toBe(true);
    expect(
      await needsDigest(
        source({ 'test-a/s1/recap.json': '{}', 'test-a/s1/summary.json': ok }),
        'test-a',
        's1',
        opts,
      ),
    ).toBe(false);
  });
});

describe('backfill-recaps overlay', () => {
  it('serves digests produced earlier in the run before the underlying source', async () => {
    const overlay = new Map([['test-a/s1/summary.md', Buffer.from('from this run')]]);
    const src = withOverlay(
      source({ 'test-a/s1/summary.md': 'stored', 'test-a/s0/summary.md': 'older' }),
      overlay,
    );
    expect((await src.readDigestFile('test-a', 's1', 'summary.md'))?.toString()).toBe(
      'from this run',
    );
    expect((await src.readDigestFile('test-a', 's0', 'summary.md'))?.toString()).toBe('older');
  });
});

describe('backfill-recaps keeps paid-for summaries', () => {
  const f = (path: string) => ({ path, body: Buffer.from(path), contentType: 'x' });
  const files = [f('recap.json'), f('summary.json'), f('summary.md'), f('map/index.json')];
  const paths = (r: { files: { path: string }[] }) => r.files.map((x) => x.path);

  it('without --summaries, never overwrites an existing summary', () => {
    const r = withoutSummaryOverwrite(files, { summaries: false, existingSummary: true });
    expect(r.kept).toBe(true);
    expect(paths(r)).toEqual(['recap.json', 'map/index.json']);
  });

  it('writes the (disabled) summary where there is none, and everything with --summaries', () => {
    expect(
      paths(withoutSummaryOverwrite(files, { summaries: false, existingSummary: false })),
    ).toEqual(paths({ files }));
    const r = withoutSummaryOverwrite(files, { summaries: true, existingSummary: true });
    expect(r.kept).toBe(false);
    expect(paths(r)).toEqual(paths({ files }));
  });
});
