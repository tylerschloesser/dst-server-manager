// docs/decisions.md §19: which session's map a viewer gets. Synthetic objects only.
import { describe, expect, it, vi } from 'vitest';

import { MAP_INDEX_FILE, mapTilesFile, trailFile } from '@dst/shared';

import { FakeObjectReader } from '../fakes/fake-recap-store';
import type { ObjectReader } from '../ports';
import { createMapStore, refForViewer } from './map-store';
import { digestKey } from './store';

const V = '76561190000000123';
const players = (ref: string, steamId64: string | null) =>
  JSON.stringify({
    schemaVersion: 1,
    players: [{ ref, ku: null, steamId64, persona: null, userdir: null }],
  });
const INDEX = JSON.stringify({ schemaVersion: 1, shards: { master: {} } });

function session(
  sessionId: string,
  opts: { index?: boolean; ref?: string; viewer?: string | null },
) {
  const k = (f: string) => digestKey('w', sessionId, f);
  const ref = opts.ref ?? 'p1';
  const out: [string, string | Uint8Array][] = [
    [k('recap.json'), '{}'],
    [k('players.json'), players(ref, opts.viewer === undefined ? V : opts.viewer)],
    [k(trailFile(ref, 'master', 'visited')), new Uint8Array([0x80])],
    [k(mapTilesFile('master')), new Uint8Array([1])],
  ];
  if (opts.index !== false) out.push([k(MAP_INDEX_FILE), INDEX]);
  return out;
}

describe('createMapStore', () => {
  it("picks the newest session with a map AND the viewer's trail, reading only their files", async () => {
    const objects = new FakeObjectReader(
      new Map([
        ...session('20260103T000000Z-000003', { index: false }), // digest-1: no map
        ...session('20260102T000000Z-000002', { viewer: '76561190000000999' }), // a friend alone
        ...session('20260101T000000Z-000001', { ref: 'p2' }),
        ...session('20251231T000000Z-000000', {}),
      ]),
    );
    const read = vi.spyOn(objects, 'getBytes');
    const found = await createMapStore(objects).findForViewer('w', V);
    expect(found?.sessionId).toBe('20260101T000000Z-000001');
    expect(found?.ref).toBe('p2');
    expect(found?.shards.master?.fresh).toBeNull();
    expect(read.mock.calls.map(([k]) => k).every((k) => !k.includes('/trail/p1/'))).toBe(true);
  });

  it('null when the viewer has no trail anywhere', async () => {
    const objects = new FakeObjectReader(
      new Map(session('20260101T000000Z-000001', { viewer: null })),
    );
    expect(await createMapStore(objects).findForViewer('w', V)).toBeNull();
  });

  it('a read error skips that session (logged) and keeps looking', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const inner = new FakeObjectReader(
      new Map([
        ...session('20260102T000000Z-000002', {}),
        ...session('20260101T000000Z-000001', {}),
      ]),
    );
    const flaky: ObjectReader = {
      listPrefixes: (p) => inner.listPrefixes(p),
      getText: async (k) => {
        if (k.includes('20260102T')) throw Object.assign(new Error('x'), { name: 'SlowDown' });
        return inner.getText(k);
      },
      getBytes: (k) => inner.getBytes(k),
    };
    expect((await createMapStore(flaky).findForViewer('w', V))?.sessionId).toBe(
      '20260101T000000Z-000001',
    );
    expect(String(log.mock.calls[0]?.[0])).toContain('read_failed:SlowDown');
  });
});

describe('refForViewer', () => {
  it('matches the SteamID64 exactly and ignores malformed entries', () => {
    expect(refForViewer(JSON.parse(players('p4', V)), V)).toBe('p4');
    expect(refForViewer(JSON.parse(players('../x', V)), V)).toBeNull();
    expect(refForViewer(JSON.parse(players('p4', V)), '7656119000000012')).toBeNull();
    expect(refForViewer({ schemaVersion: 2, players: [] }, V)).toBeNull();
    expect(refForViewer(null, V)).toBeNull();
  });
});
