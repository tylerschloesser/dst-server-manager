// docs/control-plane.md §8: path/method table, 404/405, 400 on a bad id, 404 on an unknown world,
// `cache-control: no-store` everywhere, viewer IP from `x-forwarded-for`, plus a test titled
// **exactly** `routes GET /api/me to the auth module` (quoted verbatim in the execution plan).
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { API_SECURITY_HEADERS } from './auth/headers';
import { FakeClock } from './fakes/fake-clock';
import { FakeLauncher } from './fakes/fake-launcher';
import { FakeParameterStore } from './fakes/fake-parameter-store';
import { FakeStateStore } from './fakes/fake-state-store';
import { FakeWorldRegistry, testWorld } from './fakes/fake-world-registry';
import type { HttpRequest, Identity } from './ports';
import { createRouter, viewerIp } from './router';
import type { RouterDeps } from './router';

// `router.ts` imports `* as auth from './auth'`; mocking the same specifier here intercepts it
// (docs/control-plane.md §5.2: the auth routes and GET /api/me "delegate to src/auth/index.ts").
vi.mock('./auth', () => ({
  requireUser: vi.fn(),
  beginSteamLogin: vi.fn(),
  completeSteamLogin: vi.fn(),
  logout: vi.fn(),
  mintSessionToken: vi.fn(),
  verifySessionToken: vi.fn(),
}));

import * as auth from './auth';

const PUBLIC_ORIGIN = 'https://dst.ty.ler.dev';

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
      http: {
        method,
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '203.0.113.99', // must never be used by the router (docs/decisions.md §10)
        userAgent: 'vitest',
      },
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
  const registry = new FakeWorldRegistry([testWorld({ worldId: 'test-a' })]);
  const identity: Identity = {
    requireUser: vi.fn().mockResolvedValue({ steamId64: '76561197960287930', nickname: 'Nick' }),
  };
  return {
    clock: new FakeClock(),
    store: new FakeStateStore(),
    registry,
    params: new FakeParameterStore({ '/dst/cluster-password': 'pw' }),
    launcher: new FakeLauncher(),
    identity,
    auth: {
      secrets: { read: async () => 'secret' },
      users: { getUsers: async () => ({}) },
      nowMs: () => Date.now(),
      fetchSteam: fetch,
    },
    publicOrigin: PUBLIC_ORIGIN,
    ...overrides,
  };
}

const POST_CSRF_HEADERS = { origin: PUBLIC_ORIGIN, 'x-dst-request': '1' };

beforeEach(() => {
  vi.mocked(auth.requireUser).mockReset();
  vi.mocked(auth.beginSteamLogin).mockReset();
  vi.mocked(auth.completeSteamLogin).mockReset();
  vi.mocked(auth.logout).mockReset();
});

describe('createRouter', () => {
  it('returns 404 not_found for an unmatched path', async () => {
    const router = createRouter(makeDeps());
    const res = await router.handle(makeEvent('GET', '/api/nope'));
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body ?? '{}')).toEqual({
      error: { code: 'not_found', message: expect.any(String) },
    });
  });

  it('returns 405 method_not_allowed when the path matches a different method', async () => {
    const router = createRouter(makeDeps());
    const res = await router.handle(makeEvent('DELETE', '/api/worlds'));
    expect(res.status).toBe(405);
    expect(JSON.parse(res.body ?? '{}').error.code).toBe('method_not_allowed');
  });

  it('returns 400 invalid_world_id for a malformed id, before touching auth', async () => {
    const identity: Identity = { requireUser: vi.fn() };
    const router = createRouter(makeDeps({ identity }));
    const res = await router.handle(
      makeEvent('POST', '/api/worlds/NOT-VALID!!/start', { headers: POST_CSRF_HEADERS }),
    );
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body ?? '{}').error.code).toBe('invalid_world_id');
    expect(identity.requireUser).not.toHaveBeenCalled();
  });

  it('returns 404 world_not_found for a valid id that is not registered', async () => {
    const router = createRouter(makeDeps());
    const res = await router.handle(
      makeEvent('POST', '/api/worlds/no-such-world/start', { headers: POST_CSRF_HEADERS }),
    );
    expect(res.status).toBe(404);
    expect(JSON.parse(res.body ?? '{}').error.code).toBe('world_not_found');
  });

  it('returns 403 csrf_failed for a mutation missing the CSRF headers', async () => {
    const router = createRouter(makeDeps());
    const res = await router.handle(makeEvent('POST', '/api/worlds/test-a/start'));
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body ?? '{}').error.code).toBe('csrf_failed');
  });

  it('carries cache-control: no-store on every response', async () => {
    const router = createRouter(makeDeps());
    const responses = await Promise.all([
      router.handle(makeEvent('GET', '/api/nope')),
      router.handle(makeEvent('DELETE', '/api/worlds')),
      router.handle(makeEvent('GET', '/api/worlds')),
    ]);
    for (const res of responses) {
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    }
  });

  it('routes GET /api/me to the auth module', async () => {
    vi.mocked(auth.requireUser).mockResolvedValue({
      ok: true,
      user: { steamId64: '76561197960287930', nickname: 'Nick' },
    });
    const deps = makeDeps();
    const router = createRouter(deps);

    const event = makeEvent('GET', '/api/me');
    const res = await router.handle(event);

    expect(auth.requireUser).toHaveBeenCalledTimes(1);
    expect(auth.requireUser).toHaveBeenCalledWith(event, deps.auth);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body ?? '{}')).toEqual({ nickname: 'Nick' });
  });

  it('GET /api/me returns 401 unauthorized when the auth module rejects', async () => {
    vi.mocked(auth.requireUser).mockResolvedValue({
      ok: false,
      status: 401,
      code: 'unauthorized',
    });
    const router = createRouter(makeDeps());
    const res = await router.handle(makeEvent('GET', '/api/me'));
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body ?? '{}').error.code).toBe('unauthorized');
  });

  it('delegates GET /api/auth/steam/login to beginSteamLogin', async () => {
    vi.mocked(auth.beginSteamLogin).mockResolvedValue({
      status: 302,
      headers: { location: 'https://steamcommunity.com/openid/login' },
      cookies: ['dst_state=abc; Path=/'],
    });
    const deps = makeDeps();
    const router = createRouter(deps);
    const res = await router.handle(makeEvent('GET', '/api/auth/steam/login'));
    expect(auth.beginSteamLogin).toHaveBeenCalledWith(deps.auth);
    expect(res.status).toBe(302);
    expect(res.cookies).toEqual(['dst_state=abc; Path=/']);
  });

  it('requires CSRF headers on POST /api/auth/logout', async () => {
    const router = createRouter(makeDeps());
    const res = await router.handle(makeEvent('POST', '/api/auth/logout'));
    expect(res.status).toBe(403);
    expect(auth.logout).not.toHaveBeenCalled();
  });

  it('delegates POST /api/auth/logout to logout once CSRF passes', async () => {
    vi.mocked(auth.logout).mockReturnValue({
      status: 204,
      headers: {},
      cookies: ['dst_session=; Max-Age=0; Path=/'],
    });
    const deps = makeDeps();
    const router = createRouter(deps);
    const res = await router.handle(
      makeEvent('POST', '/api/auth/logout', { headers: POST_CSRF_HEADERS }),
    );
    expect(auth.logout).toHaveBeenCalledWith(deps.auth);
    expect(res.status).toBe(204);
  });
});

describe('docs/auth.md §8.2: headers on every API response', () => {
  const HEADER_NAMES = Object.keys(API_SECURITY_HEADERS);

  /** Every one of the five §8.2 headers is present exactly once (case-insensitively) with the
   * exact §8.2 value — never missing, never duplicated, never weakened. */
  function expectSecurityHeaders(headers: Record<string, string>): void {
    const lowerKeys = Object.keys(headers).map((k) => k.toLowerCase());
    for (const name of HEADER_NAMES) {
      expect(lowerKeys.filter((k) => k === name)).toHaveLength(1);
      expect(headers[name]).toBe(API_SECURITY_HEADERS[name]);
    }
  }

  it('sets all five headers on a non-auth success response (GET /api/worlds)', async () => {
    const router = createRouter(makeDeps());
    const res = await router.handle(makeEvent('GET', '/api/worlds'));
    expect(res.status).toBe(200);
    expectSecurityHeaders(res.headers);
  });

  it('sets all five headers on an unauthenticated 401 (GET /api/me)', async () => {
    vi.mocked(auth.requireUser).mockResolvedValue({
      ok: false,
      status: 401,
      code: 'unauthorized',
    });
    const router = createRouter(makeDeps());
    const res = await router.handle(makeEvent('GET', '/api/me'));
    expect(res.status).toBe(401);
    expectSecurityHeaders(res.headers);
  });

  it('sets all five headers on a 404', async () => {
    const router = createRouter(makeDeps());
    const res = await router.handle(makeEvent('GET', '/api/nope'));
    expect(res.status).toBe(404);
    expectSecurityHeaders(res.headers);
  });

  it('sets all five headers on the login redirect without clobbering Location or Set-Cookie', async () => {
    vi.mocked(auth.beginSteamLogin).mockResolvedValue({
      status: 302,
      headers: { location: 'https://steamcommunity.com/openid/login' },
      cookies: ['dst_state=abc; Path=/'],
    });
    const router = createRouter(makeDeps());
    const res = await router.handle(makeEvent('GET', '/api/auth/steam/login'));
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('https://steamcommunity.com/openid/login');
    expect(res.cookies).toEqual(['dst_state=abc; Path=/']);
    expectSecurityHeaders(res.headers);
  });

  // RFC 9110: a 204 has no content, so it must not carry content-type (or any other body header)
  // -- but it is not exempt from the §8.2 security headers, and Set-Cookie must still pass through.
  it('does not set content-type on a 204 response, but still sets the five security headers and Set-Cookie', async () => {
    vi.mocked(auth.logout).mockReturnValue({
      status: 204,
      headers: {},
      cookies: ['dst_session=; Max-Age=0; Path=/'],
    });
    const router = createRouter(makeDeps());
    const res = await router.handle(
      makeEvent('POST', '/api/auth/logout', { headers: POST_CSRF_HEADERS }),
    );
    expect(res.status).toBe(204);
    expect(res.headers['content-type']).toBeUndefined();
    expect(res.headers['content-length']).toBeUndefined();
    expectSecurityHeaders(res.headers);
    expect(res.cookies).toEqual(['dst_session=; Max-Age=0; Path=/']);
  });

  it('still sets content-type: application/json; charset=utf-8 on an ordinary JSON response', async () => {
    const router = createRouter(makeDeps());
    const res = await router.handle(makeEvent('GET', '/api/worlds'));
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/json; charset=utf-8');
    expectSecurityHeaders(res.headers);
  });
});

describe('viewerIp', () => {
  it('reads the first address from x-forwarded-for, never requestContext.http.sourceIp', () => {
    const event = makeEvent('GET', '/api/worlds', {
      headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' },
    });
    expect(viewerIp(event)).toBe('198.51.100.7');
    expect(event.requestContext.http.sourceIp).not.toBe('198.51.100.7');
  });

  it('is null when x-forwarded-for is absent', () => {
    const event = makeEvent('GET', '/api/worlds');
    expect(viewerIp(event)).toBeNull();
  });
});
