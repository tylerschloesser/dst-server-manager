// docs/control-plane.md §5.6: the recap scan — newest first, invalid digests skipped and logged,
// at most RECAP_SCAN_CAP prefixes examined.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeObjectReader } from '../fakes/fake-recap-store';
import { FIXTURE_RECAP_NEW, FIXTURE_SESSION_NEW } from '../fakes/recap-fixture';
import { RECAP_SCAN_CAP, createRecapStore, digestKey } from './store';

function recapFor(sessionId: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...FIXTURE_RECAP_NEW, sessionId, ...extra });
}

function sid(i: number): string {
  return `202609${String(10 + Math.floor(i / 10)).padStart(2, '0')}T0000${String(i % 10).padStart(2, '0')}Z-${String(i).padStart(6, '0')}`;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createRecapStore', () => {
  it('orders sessions newest first regardless of listing order', async () => {
    const objects = new Map<string, string>();
    for (const i of [3, 1, 2]) objects.set(digestKey('w', sid(i), 'recap.json'), recapFor(sid(i)));
    const store = createRecapStore(new FakeObjectReader(objects));
    const out = await store.listRecent('w', 10);
    expect(out.map((r) => r.sessionId)).toEqual([sid(3), sid(2), sid(1)]);
  });

  it('skips missing, unparseable, wrong-schema and mismatched digests, with a log line each', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const objects = new Map<string, string>([
      [digestKey('w', sid(6), 'recap.json'), '{not json'],
      [digestKey('w', sid(5), 'recap.json'), recapFor(sid(5), { schemaVersion: 2 })],
      [digestKey('w', sid(4), 'recap.json'), recapFor('someone-else')],
      [`sessions/w/${sid(3)}/manifest.json`, '{}'],
      [digestKey('w', sid(2), 'recap.json'), '[]'],
      [digestKey('w', sid(1), 'recap.json'), recapFor(sid(1))],
    ]);
    const out = await createRecapStore(new FakeObjectReader(objects)).listRecent('w', 3);
    expect(out.map((r) => r.sessionId)).toEqual([sid(1)]);
    const reasons = log.mock.calls
      .map((c) => JSON.parse(String(c[0])) as { event: string; reason: string })
      .filter((e) => e.event === 'recap_skipped')
      .map((e) => e.reason);
    expect(reasons).toEqual([
      'invalid_json',
      'schema_version',
      'session_mismatch',
      'missing',
      'invalid_json',
    ]);
  });

  it('stops after `limit` found, reading no more than it needs', async () => {
    const objects = new Map<string, string>();
    for (let i = 0; i < 8; i++) {
      objects.set(digestKey('w', sid(i), 'recap.json'), recapFor(sid(i)));
    }
    const reader = new FakeObjectReader(objects);
    const getText = vi.spyOn(reader, 'getText');
    const out = await createRecapStore(reader).listRecent('w', 2);
    expect(out.map((r) => r.sessionId)).toEqual([sid(7), sid(6)]);
    const recapReads = getText.mock.calls.filter(([k]) => k.endsWith('/recap.json'));
    expect(recapReads).toHaveLength(2);
  });

  it(`examines at most ${RECAP_SCAN_CAP} session prefixes`, async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const objects = new Map<string, string>();
    // The only valid digest is the oldest of 40 sessions: beyond the cap, so never found.
    for (let i = 0; i < 40; i++) objects.set(`sessions/w/${sid(i)}/manifest.json`, '{}');
    objects.set(digestKey('w', sid(0), 'recap.json'), recapFor(sid(0)));
    const reader = new FakeObjectReader(objects);
    const getText = vi.spyOn(reader, 'getText');
    const out = await createRecapStore(reader).listRecent('w', 3);
    expect(out).toEqual([]);
    expect(getText.mock.calls.length).toBe(RECAP_SCAN_CAP);
  });

  it('keeps players/summary files as read, and null when absent or unparseable', async () => {
    const objects = new Map<string, string>([
      [digestKey('w', FIXTURE_SESSION_NEW, 'recap.json'), recapFor(FIXTURE_SESSION_NEW)],
      [digestKey('w', FIXTURE_SESSION_NEW, 'summary.json'), '{oops'],
      [digestKey('w', FIXTURE_SESSION_NEW, 'summary.md'), '## hi'],
    ]);
    const [r] = await createRecapStore(new FakeObjectReader(objects)).listRecent('w', 1);
    expect(r?.players).toBeNull();
    expect(r?.summaryMeta).toBeNull();
    expect(r?.summaryText).toBe('## hi');
  });

  it('skips (not fails) a session whose read throws', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const objects = new Map<string, string>([
      [digestKey('w', sid(2), 'recap.json'), recapFor(sid(2))],
      [digestKey('w', sid(1), 'recap.json'), recapFor(sid(1))],
    ]);
    const reader = new FakeObjectReader(objects);
    const real = reader.getText.bind(reader);
    vi.spyOn(reader, 'getText').mockImplementation(async (key) => {
      if (key.includes(sid(2))) throw new Error('boom');
      return real(key);
    });
    const out = await createRecapStore(reader).listRecent('w', 2);
    expect(out.map((r) => r.sessionId)).toEqual([sid(1)]);
  });
});
