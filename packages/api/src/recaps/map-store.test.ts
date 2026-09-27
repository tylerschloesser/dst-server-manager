// docs/decisions.md §19: which session each player's map comes from. Synthetic objects only.
import { describe, expect, it, vi } from 'vitest';

import { MAP_INDEX_FILE, mapTilesFile, trailFile } from '@dst/shared';

import { FakeObjectReader } from '../fakes/fake-recap-store';
import type { ObjectReader } from '../ports';
import { createMapStore, mapPlayers } from './map-store';
import { digestKey } from './store';

const A = '76561190000000123';
const B = '76561190000000456';
type P = { ref: string; steamId64: string | null; persona?: string; trail?: boolean };
const playersJson = (ps: P[]) =>
  JSON.stringify({
    schemaVersion: 1,
    players: ps.map((p) => ({
      ref: p.ref,
      ku: null,
      steamId64: p.steamId64,
      persona: p.persona ?? null,
      userdir: null,
    })),
  });
const INDEX = JSON.stringify({ schemaVersion: 1, shards: { master: {} } });

function session(sessionId: string, players: P[], opts: { index?: boolean } = {}) {
  const k = (f: string) => digestKey('w', sessionId, f);
  const out: [string, string | Uint8Array][] = [
    [k('recap.json'), '{}'],
    [k('players.json'), playersJson(players)],
    [k(mapTilesFile('master')), new Uint8Array([1])],
  ];
  for (const p of players)
    if (p.trail !== false)
      out.push([k(trailFile(p.ref, 'master', 'visited')), new Uint8Array([0x80])]);
  if (opts.index !== false) out.push([k(MAP_INDEX_FILE), INDEX]);
  return out;
}

const bySteamId = (maps: { steamId64: string; sessionId: string; ref: string }[]) =>
  Object.fromEntries(maps.map((m) => [m.steamId64, [m.sessionId, m.ref]]));

describe('createMapStore.findAll', () => {
  it('gives each player their own newest session with a map and a trail, not the newest overall', async () => {
    const objects = new FakeObjectReader(
      new Map([
        ...session('20260104T000000Z-000004', [{ ref: 'p1', steamId64: A }], { index: false }), // digest-1
        ...session('20260103T000000Z-000003', [{ ref: 'p1', steamId64: B, persona: 'bee' }]), // B alone
        ...session('20260102T000000Z-000002', [{ ref: 'p2', steamId64: A, trail: false }]), // no trail
        ...session('20260101T000000Z-000001', [
          { ref: 'p1', steamId64: B },
          { ref: 'p2', steamId64: A, persona: 'ay' },
        ]),
      ]),
    );
    const found = await createMapStore(objects).findAll('w');
    expect(bySteamId(found)).toEqual({
      [B]: ['20260103T000000Z-000003', 'p1'],
      [A]: ['20260101T000000Z-000001', 'p2'],
    });
    expect(found.find((m) => m.steamId64 === B)?.persona).toBe('bee');
    expect(found.find((m) => m.steamId64 === A)?.shards.master?.fresh).toBeNull();
  });

  it('skips players without a SteamID64 (they cannot be followed across sessions)', async () => {
    const objects = new FakeObjectReader(
      new Map(
        session('20260101T000000Z-000001', [
          { ref: 'p1', steamId64: null },
          { ref: 'p2', steamId64: A },
        ]),
      ),
    );
    expect((await createMapStore(objects).findAll('w')).map((m) => m.ref)).toEqual(['p2']);
  });

  it("reads every session's index and players in parallel", async () => {
    const inner = new FakeObjectReader(
      new Map([
        ...session('20260102T000000Z-000002', [{ ref: 'p1', steamId64: A }]),
        ...session('20260101T000000Z-000001', [{ ref: 'p1', steamId64: B }]),
      ]),
    );
    let inFlight = 0;
    let peak = 0;
    const slow: ObjectReader = {
      listPrefixes: (p) => inner.listPrefixes(p),
      getText: async (k) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return inner.getText(k);
      },
      getBytes: (k) => inner.getBytes(k),
    };
    expect(await createMapStore(slow).findAll('w')).toHaveLength(2);
    expect(peak).toBe(4); // 2 sessions × (index, players), all at once
  });

  it('empty when nobody has a trail', async () => {
    const objects = new FakeObjectReader(
      new Map(session('20260101T000000Z-000001', [{ ref: 'p1', steamId64: null }])),
    );
    expect(await createMapStore(objects).findAll('w')).toEqual([]);
  });

  it('a read error skips that session (logged) and keeps the rest', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const inner = new FakeObjectReader(
      new Map([
        ...session('20260102T000000Z-000002', [{ ref: 'p1', steamId64: A }]),
        ...session('20260101T000000Z-000001', [{ ref: 'p1', steamId64: A }]),
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
    expect(bySteamId(await createMapStore(flaky).findAll('w'))).toEqual({
      [A]: ['20260101T000000Z-000001', 'p1'],
    });
    expect(String(log.mock.calls[0]?.[0])).toContain('read_failed:SlowDown');
    log.mockRestore();
  });
});

describe('mapPlayers', () => {
  it('keeps well-formed refs with a SteamID64 and ignores the rest', () => {
    expect(
      mapPlayers(JSON.parse(playersJson([{ ref: 'p4', steamId64: A, persona: 'x' }]))),
    ).toEqual([{ ref: 'p4', steamId64: A, persona: 'x' }]);
    expect(mapPlayers(JSON.parse(playersJson([{ ref: '../x', steamId64: A }])))).toEqual([]);
    expect(mapPlayers(JSON.parse(playersJson([{ ref: 'p4', steamId64: null }])))).toEqual([]);
    expect(mapPlayers({ schemaVersion: 2, players: [] })).toEqual([]);
    expect(mapPlayers(null)).toEqual([]);
  });
});
