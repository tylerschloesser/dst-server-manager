// docs/control-plane.md §5.6, §5.7: GET /api/worlds/{id}/recaps and the three note writes
// through the real router, with the in-memory fakes and the synthetic fixture.
import { gunzipSync } from 'node:zlib';

import { describe, expect, it, vi } from 'vitest';

import { NOTES_MAX, NOTE_HEADER, NOTE_MAX_CHARS, RECAPS_MAX_LIMIT } from '@dst/shared';
import type { MapResponse, NotesResponse, RecapsResponse } from '@dst/shared';

// `router.ts` imports `* as auth from './auth'`, whose env.ts validates APP_ENV at module load;
// these routes never touch it (identity is injected), so it is stubbed as in router.test.ts.
vi.mock('../auth', () => ({
  requireUser: vi.fn(),
  beginSteamLogin: vi.fn(),
  completeSteamLogin: vi.fn(),
  logout: vi.fn(),
}));

import { ApiError } from '../errors';
import { FakeClock } from '../fakes/fake-clock';
import { FakeLauncher } from '../fakes/fake-launcher';
import { FakeNoteStore } from '../fakes/fake-note-store';
import { FakeParameterStore } from '../fakes/fake-parameter-store';
import { FakeObjectReader, createFakeRecapStore } from '../fakes/fake-recap-store';
import { FakeStateStore } from '../fakes/fake-state-store';
import { FakeWorldRegistry, testWorld } from '../fakes/fake-world-registry';
import {
  FIXTURE_KU_ALICE,
  FIXTURE_KU_BOB,
  FIXTURE_RECAP_NEW,
  FIXTURE_SESSION_NEW,
  FIXTURE_SESSION_OLD,
  FIXTURE_STEAMID_ALICE,
  FIXTURE_STEAMID_BOB,
  FIXTURE_STEAMID_DEV,
  recapFixtureObjects,
} from '../fakes/recap-fixture';
import {
  MAP_FIXTURE_BASE,
  MAP_FIXTURE_FRESH_COUNT,
  MAP_FIXTURE_FRIEND_FRESH_COUNT,
  MAP_FIXTURE_STASH,
  MAP_FIXTURE_SURFACE,
} from '../fakes/map-fixture';
import type { HttpRequest, Identity, RecapStore } from '../ports';
import { digestKey } from '../recaps/store';
import { createRouter } from '../router';
import type { RouterDeps } from '../router';

const PUBLIC_ORIGIN = 'https://dst.ty.ler.dev';
const CSRF = { origin: PUBLIC_ORIGIN, 'x-dst-request': '1' };

function makeEvent(
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; rawQueryString?: string } = {},
): HttpRequest {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: opts.rawQueryString ?? '',
    cookies: [],
    headers: opts.headers ?? {},
    requestContext: {
      accountId: 'test',
      apiId: 'test',
      domainName: 'test',
      domainPrefix: 'test',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '203.0.113.99', userAgent: 'vitest' },
      requestId: 'req-1',
      routeKey: '$default',
      stage: '$default',
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
    body: undefined,
    isBase64Encoded: false,
  };
}

function makeDeps(overrides: Partial<RouterDeps> = {}): RouterDeps {
  const identity: Identity = {
    requireUser: vi.fn().mockResolvedValue({ steamId64: FIXTURE_STEAMID_ALICE, nickname: 'Dev' }),
    requireViewer: vi.fn().mockResolvedValue({
      kind: 'member',
      ...{ steamId64: FIXTURE_STEAMID_ALICE, nickname: 'Dev' },
    }),
  };
  // A fresh source object per test: the allowlist cache is keyed by source instance.
  const users = { getUsers: async () => ({ [FIXTURE_STEAMID_ALICE]: 'Ally' }) };
  return {
    clock: new FakeClock(new Date('2026-09-27T12:00:00.000Z')),
    store: new FakeStateStore(),
    registry: new FakeWorldRegistry([
      testWorld({ worldId: 'test-a' }),
      testWorld({ worldId: 'test-b' }),
    ]),
    params: new FakeParameterStore({ '/dst/cluster-password': 'pw' }),
    launcher: new FakeLauncher(),
    recaps: createFakeRecapStore().store,
    maps: createFakeRecapStore().maps,
    notes: new FakeNoteStore(),
    identity,
    auth: {
      secrets: { read: async () => 'secret' },
      users,
      nowMs: () => Date.now(),
      fetchSteam: vi.fn<typeof fetch>(),
    },
    publicOrigin: PUBLIC_ORIGIN,
    ...overrides,
  };
}

async function getRecaps(deps: RouterDeps, worldId = 'test-a', rawQueryString = '') {
  const res = await createRouter(deps).handle(
    makeEvent('GET', `/api/worlds/${worldId}/recaps`, { rawQueryString }),
  );
  return { res, body: JSON.parse(res.body ?? '{}') as RecapsResponse };
}

/** Ids handed out in order, so tests can name the note they just added. */
const ID1 = '00000000-0000-4000-8000-000000000001';
const ID2 = '00000000-0000-4000-8000-000000000002';
function idSeq(): () => string {
  const ids = [ID1, ID2, ...Array.from({ length: 98 }, (_, i) => `id-${i}`)];
  return () => ids.shift() ?? 'exhausted';
}

function postNote(
  deps: RouterDeps,
  path: string,
  header: string | undefined,
  opts: { csrf?: boolean; worldId?: string } = {},
) {
  const headers: Record<string, string> = opts.csrf === false ? {} : { ...CSRF };
  if (header !== undefined) headers[NOTE_HEADER] = header;
  const worldId = opts.worldId ?? 'test-a';
  return createRouter(deps).handle(
    makeEvent('POST', `/api/worlds/${worldId}/notes${path}`, { headers }),
  );
}

const addNote = (deps: RouterDeps, text: string, opts?: { csrf?: boolean; worldId?: string }) =>
  postNote(deps, '', encodeURIComponent(text), opts);

async function notesOf(res: { status: number; body?: string }): Promise<NotesResponse['notes']> {
  expect(res.status).toBe(200);
  return (JSON.parse(res.body ?? '{}') as NotesResponse).notes;
}

const asUser = (nickname: string): Identity => ({
  requireUser: vi.fn().mockResolvedValue({ steamId64: FIXTURE_STEAMID_ALICE, nickname }),
  requireViewer: vi
    .fn()
    .mockResolvedValue({ kind: 'member', steamId64: FIXTURE_STEAMID_ALICE, nickname }),
});

describe('GET /api/worlds/{id}/recaps', () => {
  it('requires a signed-in, allowlisted user', async () => {
    const identity: Identity = {
      requireUser: vi.fn().mockRejectedValue(new ApiError('unauthorized')),
      requireViewer: vi.fn().mockRejectedValue(new ApiError('unauthorized')),
    };
    const { res } = await getRecaps(makeDeps({ identity }));
    expect(res.status).toBe(401);
  });

  it('400 on a malformed world id before touching auth; 404 on an unknown world', async () => {
    const identity: Identity = { requireUser: vi.fn(), requireViewer: vi.fn() };
    const bad = await getRecaps(makeDeps({ identity }), 'NOT_VALID');
    expect(bad.res.status).toBe(400);
    expect(identity.requireUser).not.toHaveBeenCalled();
    expect(identity.requireViewer).not.toHaveBeenCalled();
    const unknown = await getRecaps(makeDeps(), 'no-such-world');
    expect(unknown.res.status).toBe(404);
  });

  it('returns the valid recaps newest first, skipping bad and digest-less sessions', async () => {
    const { res, body } = await getRecaps(makeDeps());
    expect(res.status).toBe(200);
    expect(body.worldId).toBe('test-a');
    expect(body.notes).toEqual([]);
    expect(body.recaps.map((r) => r.sessionId)).toEqual([FIXTURE_SESSION_NEW, FIXTURE_SESSION_OLD]);
    const [newest, older] = body.recaps;
    expect(newest?.summary).toMatchObject({ status: 'ok', model: 'fixture-model' });
    expect(newest?.summary.status === 'ok' && newest.summary.text).toContain(
      '**Where things stand**',
    );
    expect(older?.summary).toEqual({ status: 'unavailable' });
    expect(older?.recap.status).toBe('partial');
    expect(older?.recap.continuous).toBe(false);
  });

  it('an empty list for a world without sessions', async () => {
    const { res, body } = await getRecaps(makeDeps(), 'test-b');
    expect(res.status).toBe(200);
    expect(body.recaps).toEqual([]);
  });

  it('attaches the allowlist nickname by ref, null when the player is not on the allowlist', async () => {
    const { body } = await getRecaps(makeDeps());
    const players = body.recaps[0]?.recap.players ?? [];
    expect(players.map((p) => [p.persona, p.nickname])).toEqual([
      ['alice', 'Ally'],
      ['bob', null],
    ]);
  });

  it('never serves a KU id or SteamID64, even when recap.json itself carries them', async () => {
    const objects = recapFixtureObjects();
    const poisoned = {
      ...FIXTURE_RECAP_NEW,
      secretTopLevel: FIXTURE_KU_ALICE,
      steamId64: FIXTURE_STEAMID_ALICE,
      players: FIXTURE_RECAP_NEW.players.map((p, i) => ({
        ...p,
        ku: i === 0 ? FIXTURE_KU_ALICE : FIXTURE_KU_BOB,
        steamId64: i === 0 ? FIXTURE_STEAMID_ALICE : FIXTURE_STEAMID_BOB,
        persona: i === 0 ? `alice ${FIXTURE_KU_ALICE}` : p.persona,
      })),
      deaths: FIXTURE_RECAP_NEW.deaths.map((d) => ({
        ...d,
        cause: `Overheating (${FIXTURE_STEAMID_BOB})`,
        killerKu: FIXTURE_KU_BOB,
      })),
      session: { ...FIXTURE_RECAP_NEW.session, startedBySteamId: FIXTURE_STEAMID_ALICE },
    };
    objects.set(digestKey('test-a', FIXTURE_SESSION_NEW, 'recap.json'), JSON.stringify(poisoned));
    const deps = makeDeps({ recaps: createFakeRecapStore(new FakeObjectReader(objects)).store });

    const { res, body } = await getRecaps(deps);
    expect(res.status).toBe(200);
    const raw = res.body ?? '';
    expect(raw).not.toContain('KU_');
    expect(raw).not.toContain(FIXTURE_STEAMID_ALICE);
    expect(raw).not.toContain(FIXTURE_STEAMID_BOB);
    expect(raw).not.toContain('secretTopLevel');
    expect(raw).not.toContain('killerKu');
    expect(raw).not.toContain('startedBySteamId');
    expect(raw).not.toContain('TESTUSERDIR'); // players.json's userdir is private too
    // ...while the whitelisted facts are still there.
    expect(body.recaps[0]?.recap.built.map((b) => b.name)).toContain('Endothermic Fire Pit');
    expect(body.recaps[0]?.recap.players[0]?.nickname).toBe('Ally');
    expect(body.recaps[0]?.recap.containers.map((c) => [c.name, c.shard, c.containers])).toEqual([
      ['Chest', 'master', 5],
      ['Ice Box', 'master', 1],
      ['Chester', 'master', 1],
      ['Chest', 'caves', 1],
    ]);
  });

  describe('limit', () => {
    function spyStore(): { store: RecapStore; limits: number[] } {
      const inner = createFakeRecapStore().store;
      const limits: number[] = [];
      return {
        limits,
        store: {
          listRecent: (w, n) => {
            limits.push(n);
            return inner.listRecent(w, n);
          },
        },
      };
    }

    it.each([
      ['', 3],
      ['limit=', 3],
      ['limit=1', 1],
      ['limit=0', 1],
      ['limit=7', 7],
      ['limit=999', RECAPS_MAX_LIMIT],
    ])('%j -> %i', async (qs, expected) => {
      const spy = spyStore();
      const { res } = await getRecaps(makeDeps({ recaps: spy.store }), 'test-a', qs);
      expect(res.status).toBe(200);
      expect(spy.limits).toEqual([expected]);
    });

    it.each(['limit=abc', 'limit=2.5', 'limit=-1'])('%j -> 400 invalid_limit', async (qs) => {
      const { res } = await getRecaps(makeDeps(), 'test-a', qs);
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body ?? '{}').error.code).toBe('invalid_limit');
    });

    it('limit=1 returns only the newest recap', async () => {
      const { body } = await getRecaps(makeDeps(), 'test-a', 'limit=1');
      expect(body.recaps.map((r) => r.sessionId)).toEqual([FIXTURE_SESSION_NEW]);
    });
  });
});

describe('note writes (POST /api/worlds/{id}/notes[/{noteId}[/delete]])', () => {
  it('all three are CSRF-protected like start/stop', async () => {
    const deps = makeDeps({ newId: idSeq() });
    await addNote(deps, 'keep');
    for (const [path, header] of [
      ['', 'hi'],
      [`/${ID1}`, 'hi'],
      [`/${ID1}/delete`, undefined],
    ] as const) {
      const res = await postNote(deps, path, header, { csrf: false });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body ?? '{}').error.code).toBe('csrf_failed');
    }
    expect((await deps.notes.list('test-a')).map((n) => n.text)).toEqual(['keep']);
  });

  it('require a user, and 404 an unknown world', async () => {
    const identity: Identity = {
      requireUser: vi.fn().mockRejectedValue(new ApiError('unauthorized')),
      requireViewer: vi.fn().mockRejectedValue(new ApiError('unauthorized')),
    };
    expect((await addNote(makeDeps({ identity }), 'hi')).status).toBe(401);
    expect((await addNote(makeDeps(), 'hi', { worldId: 'nope' })).status).toBe(404);
    expect((await postNote(makeDeps(), `/${ID1}`, 'hi', { worldId: 'nope' })).status).toBe(404);
    expect(
      (await postNote(makeDeps(), `/${ID1}/delete`, undefined, { worldId: 'nope' })).status,
    ).toBe(404);
  });

  it('only a UUID or "legacy" is a note id', async () => {
    expect((await postNote(makeDeps(), '/not-an-id', 'hi')).status).toBe(404);
    expect((await postNote(makeDeps(), `/${ID1.toUpperCase()}`, 'hi')).status).toBe(404);
    expect((await postNote(makeDeps(), '/legacy', 'hi')).status).toBe(404); // note_not_found
  });

  it('add decodes, strips control characters, collapses whitespace, stamps the author', async () => {
    const deps = makeDeps({ newId: idSeq() });
    const notes = await notesOf(await addNote(deps, '  Bring ice\n\tto base  🧊\u202e '));
    expect(notes).toEqual([
      {
        id: ID1,
        text: 'Bring ice to base 🧊',
        createdAt: '2026-09-27T12:00:00.000Z',
        createdBy: 'Dev',
        editedAt: null,
        editedBy: null,
      },
    ]);
    const { body: recaps } = await getRecaps(deps);
    expect(recaps.notes).toEqual(notes);
  });

  it('lists newest first; an edit keeps its place and records another editor', async () => {
    const clock = new FakeClock(new Date('2026-10-01T00:00:00.000Z'));
    const deps = makeDeps({ newId: idSeq(), clock });
    await addNote(deps, 'first');
    clock.set(new Date('2026-10-02T00:00:00.000Z'));
    const both = await notesOf(await addNote(deps, 'second'));
    expect(both.map((n) => n.text)).toEqual(['second', 'first']);

    clock.set(new Date('2026-10-03T00:00:00.000Z'));
    const self = await notesOf(await postNote(deps, `/${ID1}`, 'first, fixed'));
    expect(self.map((n) => n.text)).toEqual(['second', 'first, fixed']);
    expect(self[1]).toMatchObject({
      createdBy: 'Dev',
      editedAt: '2026-10-03T00:00:00.000Z',
      editedBy: null,
    });

    const other = await notesOf(
      await postNote({ ...deps, identity: asUser('Ni') }, `/${ID1}`, 'first, by Ni'),
    );
    expect(other[1]).toMatchObject({ text: 'first, by Ni', createdBy: 'Dev', editedBy: 'Ni' });
  });

  it('delete removes one note and is idempotent', async () => {
    const deps = makeDeps({ newId: idSeq() });
    await addNote(deps, 'a');
    await addNote(deps, 'b');
    expect(
      (await notesOf(await postNote(deps, `/${ID1}/delete`, undefined))).map((n) => n.id),
    ).toEqual([ID2]);
    expect(
      (await notesOf(await postNote(deps, `/${ID1}/delete`, undefined))).map((n) => n.id),
    ).toEqual([ID2]);
  });

  it('editing a missing (or just-deleted) note is 404 note_not_found', async () => {
    const deps = makeDeps({ newId: idSeq() });
    await addNote(deps, 'a');
    await postNote(deps, `/${ID1}/delete`, undefined);
    const res = await postNote(deps, `/${ID1}`, 'too late');
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body ?? '{}').error.code).toBe('note_not_found');
  });

  it(`refuses note ${NOTES_MAX + 1} with too_many_notes`, async () => {
    const deps = makeDeps({ newId: idSeq() });
    for (let i = 0; i < NOTES_MAX; i++) expect((await addNote(deps, `n${i}`)).status).toBe(200);
    const res = await addNote(deps, 'one more');
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body ?? '{}').error.code).toBe('too_many_notes');
    expect(await deps.notes.list('test-a')).toHaveLength(NOTES_MAX);
  });

  it(`accepts exactly ${NOTE_MAX_CHARS} characters and rejects one more`, async () => {
    const deps = makeDeps();
    expect((await addNote(deps, 'é'.repeat(NOTE_MAX_CHARS))).status).toBe(200);
    const tooLong = await addNote(deps, 'é'.repeat(NOTE_MAX_CHARS + 1));
    expect(tooLong.status).toBe(400);
    expect(JSON.parse(tooLong.body ?? '{}').error.code).toBe('invalid_note');
    expect((await deps.notes.list('test-a')).map((n) => n.text)).toEqual([
      'é'.repeat(NOTE_MAX_CHARS),
    ]);
  });

  it('rejects a header that is not valid percent-encoding', async () => {
    const res = await postNote(makeDeps(), '', '%E0%A4%A');
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body ?? '{}').error.code).toBe('invalid_note');
  });

  it.each([
    ['an empty header', ''],
    ['whitespace only', encodeURIComponent(' \n ')],
    ['no header at all', undefined],
  ])('%s is a 400 "Note is empty" for add and edit', async (_label, header) => {
    const deps = makeDeps({ newId: idSeq() });
    await addNote(deps, 'keep going');
    for (const path of ['', `/${ID1}`]) {
      const res = await postNote(deps, path, header);
      expect(res.status).toBe(400);
      expect(JSON.parse(res.body ?? '{}').error).toEqual({
        code: 'invalid_note',
        message: 'Note is empty',
      });
    }
    expect((await deps.notes.list('test-a')).map((n) => n.text)).toEqual(['keep going']);
  });
});

describe('GET /api/worlds/{id}/map (docs/control-plane.md §5.8)', () => {
  const as = (steamId64: string): Identity => ({
    requireUser: vi.fn().mockResolvedValue({ steamId64, nickname: 'x' }),
    requireViewer: vi.fn().mockResolvedValue({ kind: 'member', ...{ steamId64, nickname: 'x' } }),
  });
  async function getMap(deps: RouterDeps, worldId = 'test-a') {
    const res = await createRouter(deps).handle(makeEvent('GET', `/api/worlds/${worldId}/map`));
    return { res, body: JSON.parse(res.body ?? '{}') as MapResponse };
  }
  const tilesOf = (b64: string) => gunzipSync(Buffer.from(b64, 'base64'));

  it('401 signed out; 400 on a malformed id before auth; 404 on an unknown world', async () => {
    const out = await getMap(
      makeDeps({
        identity: {
          requireUser: vi.fn().mockRejectedValue(new ApiError('unauthorized')),
          requireViewer: vi.fn().mockRejectedValue(new ApiError('unauthorized')),
        },
      }),
    );
    expect(out.res.status).toBe(401);
    const identity: Identity = { requireUser: vi.fn(), requireViewer: vi.fn() };
    expect((await getMap(makeDeps({ identity }), 'NOT_VALID')).res.status).toBe(400);
    expect(identity.requireUser).not.toHaveBeenCalled();
    expect(identity.requireViewer).not.toHaveBeenCalled();
    expect((await getMap(makeDeps(), 'no-such-world')).res.status).toBe(404);
  });

  it("serves the viewer's own map first, masked to their reveal", async () => {
    const { res, body } = await getMap(makeDeps({ identity: as(FIXTURE_STEAMID_DEV) }));
    expect(res.status).toBe(200);
    if (body.status !== 'ok') throw new Error('expected a map');
    expect(body).toMatchObject({ worldId: 'test-a', revealRadius: 4 });
    // Dev (p3) and alice (p1) walked; bob (p2) left no trail, so has no map.
    expect(body.maps.map((m) => [m.label, m.isViewer])).toEqual([
      ['dev', true],
      ['Ally', false],
    ]);
    const mine = body.maps[0]!;
    expect(mine).toMatchObject({ sessionId: FIXTURE_SESSION_NEW, day: 60 });
    const m = mine.shards.master!;
    // The unvisited islet's tile type is not even named.
    expect(m.palette).not.toContain('DESERT_DIRT');
    expect(m.palette).toContain('CARPET');
    const tiles = tilesOf(m.tiles);
    const { width } = MAP_FIXTURE_SURFACE;
    expect(tiles.length).toBe(width * MAP_FIXTURE_SURFACE.height);
    expect(tiles[12 * width + 72]).toBe(0); // the islet: fog
    expect(tiles[5 * width + 5]).toBe(0); // far from the trail: fog
    expect(tiles[MAP_FIXTURE_STASH.ty * width + MAP_FIXTURE_STASH.tx]).toBe(0); // alice's only
    expect(m.palette[tiles[MAP_FIXTURE_BASE.ty * width + MAP_FIXTURE_BASE.tx]! - 1]).toBe('CARPET');
    // Storage in the reveal only: the islet's chest (and its "Hidden Gold") never leaves.
    expect(m.containers.map((c) => [c.name, c.tx, c.ty])).toEqual([
      ['Chest', 19, 29],
      ['Chest', 19, 29],
      ['Ice Box', 21, 31],
    ]);
    expect(res.body).not.toContain('Hidden Gold');
    expect(res.body).not.toContain('DESERT_DIRT');
    expect(m.base).toEqual(MAP_FIXTURE_BASE);
    expect(m.stop).toEqual({ tx: 20, ty: 31 }); // p3's; p1's stop is on p1's map only
    expect(m.freshCount).toBe(MAP_FIXTURE_FRESH_COUNT);
    expect(mine.shards.caves?.palette).toEqual(['CAVE', 'FUNGUS', 'SINKHOLE']); // no IMPASSABLE: out of reach
    // No identifier of anyone, including the viewer's own.
    expect(res.body).not.toMatch(/KU_|7656119|TESTUSERDIR/);
  });

  it("a friend's map is masked by the friend's reveal, not the viewer's", async () => {
    const { body } = await getMap(makeDeps({ identity: as(FIXTURE_STEAMID_DEV) }));
    if (body.status !== 'ok') throw new Error('expected a map');
    const ally = body.maps[1]!;
    expect(Object.keys(ally.shards)).toEqual(['master']); // no caves trail
    const m = ally.shards.master!;
    const tiles = tilesOf(m.tiles);
    const { width } = MAP_FIXTURE_SURFACE;
    expect(tiles[MAP_FIXTURE_STASH.ty * width + MAP_FIXTURE_STASH.tx]).not.toBe(0);
    expect(tiles[MAP_FIXTURE_BASE.ty * width + MAP_FIXTURE_BASE.tx]).toBe(0); // dev's base: fog
    expect(m.containers.map((c) => [c.name, c.tx, c.ty])).toEqual([
      ['Chest', MAP_FIXTURE_STASH.tx, MAP_FIXTURE_STASH.ty],
    ]);
    expect(m.base).toBeNull();
    expect(m.stop).toEqual({ tx: 30, ty: 22 });
    expect(m.freshCount).toBe(MAP_FIXTURE_FRIEND_FRESH_COUNT);
  });

  it('every map for a viewer with no trail (theirs is simply missing); none without maps', async () => {
    for (const steamId64 of [FIXTURE_STEAMID_BOB, '76561190000000999']) {
      const { body } = await getMap(makeDeps({ identity: as(steamId64) }));
      if (body.status !== 'ok') throw new Error('expected maps');
      expect(body.maps.map((m) => [m.label, m.isViewer])).toEqual([
        ['Ally', false],
        ['dev', false],
      ]);
    }
    const { body } = await getMap(makeDeps({ identity: as(FIXTURE_STEAMID_DEV) }), 'test-b');
    expect(body).toEqual({ status: 'none', worldId: 'test-b' });
  });
});
