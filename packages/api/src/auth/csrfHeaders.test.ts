// docs/auth.md §9.2, `CSRF / headers` group, cases 93-99 (case 100 lives in
// `completeSteamLogin.test.ts`, next to the rest of the real `logout()` wiring).
//
// 93-98 exercise the CSRF precondition as it is actually implemented: centrally, in
// `router.ts`'s `csrfOk`/`route.csrf` (docs/control-plane.md §5.2), which already matches
// docs/auth.md §8.1 exactly (`Origin === publicOrigin` and `X-DST-Request === '1'`, checked before
// the route handler ever calls `requireUser`). That file is outside this task's owned paths
// (`packages/api/src/auth/**`), so these are read-only tests against the existing router, not new
// router code.
//
// 99 ("every API response carries the five §8.2 headers") is scoped to the responses this auth
// module itself produces (`beginSteamLogin`/`completeSteamLogin`/`logout`) — the only responses
// this task owns. `router.ts`'s own `jsonResponse`/`errorResponse`/`finalize` only add
// `content-type`/`cache-control` (see `router.ts`'s `finalize`), so extending the other four
// headers to every non-auth route is out of scope here and would need a change to `router.ts`.
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../errors';
import { FakeClock } from '../fakes/fake-clock';
import { FakeLauncher } from '../fakes/fake-launcher';
import { FakeParameterStore } from '../fakes/fake-parameter-store';
import { FakeStateStore } from '../fakes/fake-state-store';
import { FakeWorldRegistry, testWorld } from '../fakes/fake-world-registry';
import type { HttpRequest, Identity } from '../ports';
import type { RouterDeps, createRouter as CreateRouter } from '../router';

const PUBLIC_ORIGIN = 'https://dst.ty.ler.dev';

// `../router` imports `* as auth from './auth'` (index.ts), which validates `APP_ENV`/
// `PUBLIC_ORIGIN` (env.ts) at module load. Static imports are hoisted above any `process.env`
// assignment in this file, so `../router` is imported dynamically, after setting the env, rather
// than at the top of the file.
let createRouter: typeof CreateRouter;

beforeAll(async () => {
  process.env['APP_ENV'] = 'test';
  process.env['PUBLIC_ORIGIN'] = 'http://localhost:5173';
  delete process.env['DEV_SESSION_SECRET'];
  ({ createRouter } = await import('../router'));
});

function makeEvent(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): HttpRequest {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: path,
    rawQueryString: '',
    cookies: [],
    headers,
    requestContext: {
      accountId: 'test',
      apiId: 'test',
      domainName: 'test',
      domainPrefix: 'test',
      http: {
        method,
        path,
        protocol: 'HTTP/1.1',
        sourceIp: '203.0.113.99',
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

function makeDeps(identity: Identity): RouterDeps {
  const registry = new FakeWorldRegistry([testWorld({ worldId: 'test-lifecycle-a' })]);
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
      fetchSteam: vi.fn<typeof fetch>(),
    },
    publicOrigin: PUBLIC_ORIGIN,
  };
}

describe('CSRF / headers', () => {
  it('93. no Origin header -> 403', async () => {
    const identity: Identity = { requireUser: vi.fn() };
    const router = createRouter(makeDeps(identity));
    const res = await router.handle(makeEvent('POST', '/api/worlds/test-lifecycle-a/start'));
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body ?? '{}').error.code).toBe('csrf_failed');
    expect(identity.requireUser).not.toHaveBeenCalled();
  });

  it('94. Origin: https://evil.example -> 403', async () => {
    const identity: Identity = { requireUser: vi.fn() };
    const router = createRouter(makeDeps(identity));
    const res = await router.handle(
      makeEvent('POST', '/api/worlds/test-lifecycle-a/start', {
        origin: 'https://evil.example',
        'x-dst-request': '1',
      }),
    );
    expect(res.status).toBe(403);
    expect(identity.requireUser).not.toHaveBeenCalled();
  });

  it('95. right Origin but no X-DST-Request -> 403', async () => {
    const identity: Identity = { requireUser: vi.fn() };
    const router = createRouter(makeDeps(identity));
    const res = await router.handle(
      makeEvent('POST', '/api/worlds/test-lifecycle-a/start', { origin: PUBLIC_ORIGIN }),
    );
    expect(res.status).toBe(403);
    expect(identity.requireUser).not.toHaveBeenCalled();
  });

  it('96. X-DST-Request: true (not "1") -> 403', async () => {
    const identity: Identity = { requireUser: vi.fn() };
    const router = createRouter(makeDeps(identity));
    const res = await router.handle(
      makeEvent('POST', '/api/worlds/test-lifecycle-a/start', {
        origin: PUBLIC_ORIGIN,
        'x-dst-request': 'true',
      }),
    );
    expect(res.status).toBe(403);
    expect(identity.requireUser).not.toHaveBeenCalled();
  });

  it('97. correct Origin + X-DST-Request: 1 but no session cookie -> 401 (CSRF passes, auth fails)', async () => {
    const identity: Identity = {
      requireUser: vi.fn().mockRejectedValue(new ApiError('unauthorized')),
    };
    const router = createRouter(makeDeps(identity));
    const res = await router.handle(
      makeEvent('POST', '/api/worlds/test-lifecycle-a/start', {
        origin: PUBLIC_ORIGIN,
        'x-dst-request': '1',
      }),
    );
    expect(identity.requireUser).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(401);
    expect(JSON.parse(res.body ?? '{}').error.code).toBe('unauthorized');
  });

  it('98. no response from any route contains an access-control-* header', async () => {
    const identity: Identity = {
      requireUser: vi.fn().mockResolvedValue({ steamId64: '76561199000000001', nickname: 'Tyler' }),
    };
    const router = createRouter(makeDeps(identity));
    const responses = await Promise.all([
      router.handle(makeEvent('GET', '/api/worlds')),
      router.handle(makeEvent('GET', '/api/me')),
      router.handle(
        makeEvent('POST', '/api/worlds/test-lifecycle-a/start', {
          origin: PUBLIC_ORIGIN,
          'x-dst-request': '1',
        }),
      ),
      router.handle(makeEvent('GET', '/api/nope')),
    ]);
    for (const res of responses) {
      for (const key of Object.keys(res.headers)) {
        expect(key.toLowerCase().startsWith('access-control-')).toBe(false);
      }
    }
  });

  it('99. every response this auth module itself produces carries the five §8.2 headers', async () => {
    vi.resetModules();
    process.env['APP_ENV'] = 'test';
    process.env['PUBLIC_ORIGIN'] = 'http://localhost:5173';
    delete process.env['DEV_SESSION_SECRET'];
    const { beginSteamLogin, completeSteamLogin, logout } = await import('./index');

    const authDeps = {
      secrets: { read: async () => 'unit-test-secret' },
      users: { getUsers: async () => ({}) },
      nowMs: () => Date.now(),
      fetchSteam: vi.fn<typeof fetch>(),
    };

    const expectSecurityHeaders = (headers: Record<string, string>) => {
      expect(headers['cache-control']).toBe('no-store');
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['referrer-policy']).toBe('no-referrer');
      expect(headers['content-security-policy']).toContain("default-src 'none'");
      expect(headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    };

    const loginRes = await beginSteamLogin(authDeps);
    expectSecurityHeaders(loginRes.headers);

    const callbackEvent = makeEvent('GET', '/api/auth/steam/callback');
    const callbackRes = await completeSteamLogin(callbackEvent, authDeps);
    expectSecurityHeaders(callbackRes.headers);

    const logoutRes = logout(authDeps);
    expectSecurityHeaders(logoutRes.headers);

    const badMethodRes = await completeSteamLogin(
      makeEvent('POST', '/api/auth/steam/callback'),
      authDeps,
    );
    expectSecurityHeaders(badMethodRes.headers);
  });
});
