// docs/auth.md §12: guest (read-only) links, end to end through the real router and the real
// auth module — nothing mocked but the stores. Uses the dynamic-import pattern of
// `auth/requireUser.test.ts`, because `auth/index.ts` reads `APP_ENV` at module load.
import { describe, expect, it, vi } from 'vitest';

import type { WorldsResponse } from '@dst/shared';

import { FakeClock } from './fakes/fake-clock';
import { FakeLauncher } from './fakes/fake-launcher';
import { FakeNoteStore } from './fakes/fake-note-store';
import { FakeParameterStore } from './fakes/fake-parameter-store';
import { createFakeRecapStore } from './fakes/fake-recap-store';
import { FIXTURE_STEAMID_DEV } from './fakes/recap-fixture';
import { FakeStateStore } from './fakes/fake-state-store';
import { FakeWorldRegistry, testWorld } from './fakes/fake-world-registry';
import type { HttpRequest } from './ports';

const SECRET = 'unit-test-only-secret-value';
const PUBLIC_ORIGIN = 'http://localhost:5173';
const MEMBER_ID = FIXTURE_STEAMID_DEV;
const NOW_MS = Date.parse('2026-09-27T12:00:00.000Z');
const NOW_S = NOW_MS / 1000;
const CSRF = { origin: PUBLIC_ORIGIN, 'x-dst-request': '1' };

async function setup() {
  vi.resetModules();
  process.env['APP_ENV'] = 'test';
  process.env['PUBLIC_ORIGIN'] = PUBLIC_ORIGIN;
  delete process.env['DEV_SESSION_SECRET'];
  const auth = await import('./auth');
  const { createAuthIdentity } = await import('./adapters/auth-identity');
  const { createRouter } = await import('./router');

  const authDeps = {
    secrets: { read: async () => SECRET },
    users: { getUsers: async () => ({ [MEMBER_ID]: 'Dev' }) },
    nowMs: () => NOW_MS,
    fetchSteam: vi.fn<typeof fetch>(),
  };
  const store = new FakeStateStore();
  const params = new FakeParameterStore({ '/dst/cluster-password': 'hunter2' });
  const { store: recaps, maps } = createFakeRecapStore();
  const router = createRouter({
    clock: new FakeClock(new Date(NOW_MS)),
    store,
    registry: new FakeWorldRegistry([testWorld({ worldId: 'test-a' })]),
    params,
    launcher: new FakeLauncher(),
    recaps,
    maps,
    notes: new FakeNoteStore(),
    identity: createAuthIdentity(authDeps),
    auth: authDeps,
    publicOrigin: PUBLIC_ORIGIN,
  });

  const guestToken = (over: { label?: string; ttlS?: number; nowSec?: number } = {}) =>
    auth.mintGuestToken({
      label: over.label ?? 'demo',
      ttlS: over.ttlS ?? 86_400,
      guestKey: auth.deriveGuestKey(SECRET, 'test'),
      nowSec: over.nowSec ?? NOW_S,
    });
  const memberToken = () =>
    auth.mintSessionToken({
      steamId64: MEMBER_ID,
      sessionKey: auth.deriveSessionKey(SECRET, 'test'),
      nowSec: NOW_S,
    });

  return { auth, authDeps, router, store, params, guestToken, memberToken };
}

function makeEvent(
  method: string,
  path: string,
  opts: { token?: string; rawQueryString?: string; headers?: Record<string, string> } = {},
): HttpRequest {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: opts.rawQueryString ?? '',
    cookies: opts.token !== undefined ? [`dst_session=${opts.token}`] : [],
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
      time: new Date(NOW_MS).toISOString(),
      timeEpoch: NOW_MS,
    },
    body: undefined,
    isBase64Encoded: false,
  };
}

describe('GET /api/auth/guest', () => {
  it('a valid link sets the session cookie to the link, living exactly as long, and redirects /', async () => {
    const { router, guestToken } = await setup();
    const token = guestToken({ ttlS: 3600 });
    const res = await router.handle(
      makeEvent('GET', '/api/auth/guest', { rawQueryString: `t=${token}` }),
    );
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/');
    expect(res.cookies).toEqual([
      `dst_session=${token}; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax`,
    ]);
  });

  it('an invalid, expired, missing or repeated link redirects to the error and sets nothing', async () => {
    const { router, guestToken, memberToken } = await setup();
    const expired = guestToken({ ttlS: 60, nowSec: NOW_S - 61 });
    for (const qs of [
      `t=${expired}`,
      `t=${memberToken()}`,
      't=g1.test.garbage.x',
      '',
      `t=${guestToken()}&t=${guestToken()}`,
    ]) {
      const res = await router.handle(makeEvent('GET', '/api/auth/guest', { rawQueryString: qs }));
      expect(res.status).toBe(302);
      expect(res.headers['location']).toBe('/?error=guest-link-invalid');
      expect(res.cookies).toEqual([]);
    }
  });

  it('never overwrites a signed-in member session', async () => {
    const { router, guestToken, memberToken } = await setup();
    const res = await router.handle(
      makeEvent('GET', '/api/auth/guest', {
        token: memberToken(),
        rawQueryString: `t=${guestToken()}`,
      }),
    );
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/');
    expect(res.cookies).toEqual([]);
  });

  it('replaces an older guest cookie with the new link', async () => {
    const { router, guestToken } = await setup();
    const fresh = guestToken({ label: 'new' });
    const res = await router.handle(
      makeEvent('GET', '/api/auth/guest', {
        token: guestToken({ label: 'old' }),
        rawQueryString: `t=${fresh}`,
      }),
    );
    expect(res.cookies[0]).toContain(`dst_session=${fresh};`);
  });
});

describe('a guest cookie', () => {
  it('reads /api/me as "Guest"', async () => {
    const { router, guestToken } = await setup();
    const res = await router.handle(makeEvent('GET', '/api/me', { token: guestToken() }));
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body ?? '{}')).toEqual({ nickname: 'Guest', guest: true });
  });

  it('gets 403 read_only from every write, and changes nothing', async () => {
    const { router, store, guestToken } = await setup();
    const token = guestToken();
    for (const path of [
      '/api/worlds/test-a/start',
      '/api/worlds/test-a/stop',
      '/api/worlds/test-a/notes',
      '/api/worlds/test-a/notes/legacy',
      '/api/worlds/test-a/notes/00000000-0000-4000-8000-000000000001/delete',
    ]) {
      const res = await router.handle(makeEvent('POST', path, { token, headers: CSRF }));
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body ?? '{}').error.code).toBe('read_only');
    }
    expect((await store.get()).status).toBe('stopped');
  });

  it('sees a joinable world without its password or console command, and SSM is never read', async () => {
    const { router, store, params, guestToken, memberToken } = await setup();
    store.setRaw({
      ...(await store.get()),
      status: 'running',
      worldId: 'test-a',
      sessionId: 's-1',
      publicIp: '203.0.113.10',
      desiredWorldId: 'test-a',
    });
    const getSpy = vi.spyOn(params, 'get');

    const guestRes = await router.handle(makeEvent('GET', '/api/worlds', { token: guestToken() }));
    expect(guestRes.status).toBe(200);
    expect(guestRes.body).not.toContain('hunter2');
    const guestBody = JSON.parse(guestRes.body ?? '{}') as WorldsResponse;
    expect(guestBody.active?.join).toMatchObject({
      ip: '203.0.113.10',
      password: null,
      connectCommand: null,
    });
    expect(getSpy).not.toHaveBeenCalled();

    const memberRes = await router.handle(
      makeEvent('GET', '/api/worlds', { token: memberToken() }),
    );
    const memberBody = JSON.parse(memberRes.body ?? '{}') as WorldsResponse;
    expect(memberBody.active?.join?.password).toBe('hunter2');
  });

  it("reads recaps and maps; no map is the viewer's", async () => {
    const { router, guestToken } = await setup();
    const token = guestToken();
    const recaps = await router.handle(makeEvent('GET', '/api/worlds/test-a/recaps', { token }));
    expect(recaps.status).toBe(200);
    const map = await router.handle(makeEvent('GET', '/api/worlds/test-a/map', { token }));
    expect(map.status).toBe(200);
    const body = JSON.parse(map.body ?? '{}') as { maps?: { isViewer: boolean }[] };
    expect(body.maps?.length).toBeGreaterThan(0);
    expect(body.maps?.some((m) => m.isViewer)).toBe(false);
  });

  it('an expired guest cookie is signed out (401), not read-only', async () => {
    const { router, guestToken } = await setup();
    const token = guestToken({ ttlS: 60, nowSec: NOW_S - 61 });
    expect((await router.handle(makeEvent('GET', '/api/worlds', { token }))).status).toBe(401);
    const res = await router.handle(
      makeEvent('POST', '/api/worlds/test-a/stop', { token, headers: CSRF }),
    );
    expect(res.status).toBe(401);
  });
});
