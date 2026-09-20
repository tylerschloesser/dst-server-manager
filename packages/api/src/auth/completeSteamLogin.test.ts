// docs/auth.md §9.2 — the parts of the numbered list that need the real, wired-up `index.ts`
// exports (`beginSteamLogin`, `completeSteamLogin`, `logout`), which read the real `APP_ENV`/
// `PUBLIC_ORIGIN` from `env.ts` at module load. Static ES imports are hoisted above any
// `process.env` assignment in the same file, so every test here sets `process.env` and then
// dynamically `import()`s a freshly reset module graph (`vi.resetModules()`), instead of
// statically importing `./index`.
//
// Covers: the `Login route` group (64-67), the `mode / ns / pollution` group's case 63 (the
// method check that only `completeSteamLogin` can see), the `Session / allowlist` group's cases
// 68-69 (allowlisted vs not, through the real callback), and the `CSRF / headers` group's case
// 100 (logout's exact cookie).
import { createHmac, randomBytes } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CALLBACK_PATH, EXPECTED_SIGNED, OPENID_NS, STEAM_OP_ENDPOINT } from './constants';
import { deriveKeys } from './secrets';
import type { HttpRequest } from '../ports';

const SECRET = 'unit-test-only-secret-value';
const FAKE_STEAM_ID = '76561199000000001';

function isoPrefix(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19) + 'Z';
}

async function loadAuth(env: {
  appEnv?: string;
  publicOrigin?: string;
  devSessionSecret?: string;
}) {
  vi.resetModules();
  process.env['APP_ENV'] = env.appEnv ?? 'test';
  process.env['PUBLIC_ORIGIN'] = env.publicOrigin ?? 'http://localhost:5173';
  if (env.devSessionSecret !== undefined) {
    process.env['DEV_SESSION_SECRET'] = env.devSessionSecret;
  } else {
    delete process.env['DEV_SESSION_SECRET'];
  }
  return import('./index');
}

function makeEvent(
  method: string,
  rawQueryString: string,
  cookies: string[] = [],
  headers: Record<string, string> = {},
): HttpRequest {
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: CALLBACK_PATH,
    rawQueryString,
    cookies,
    headers,
    requestContext: {
      accountId: 'test',
      apiId: 'test',
      domainName: 'test',
      domainPrefix: 'test',
      http: {
        method,
        path: CALLBACK_PATH,
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

function makeAuthDeps(overrides: { users?: Record<string, string>; nowMs?: () => number } = {}) {
  return {
    secrets: { read: async () => SECRET },
    users: { getUsers: async () => overrides.users ?? { [FAKE_STEAM_ID]: 'Tyler' } },
    nowMs: overrides.nowMs ?? (() => Date.parse('2026-06-01T12:00:00.000Z')),
    fetchSteam: vi.fn<typeof fetch>(
      async () => new Response(`ns:${OPENID_NS}\nis_valid:true\n`, { status: 200 }),
    ),
  };
}

function buildValidCallback(
  appEnv: 'prod' | 'test' | 'local',
  publicOrigin: string,
  nowMs: number,
  overrideStateId?: string,
): { rawQueryString: string; cookies: string[] } {
  const { stateKey } = deriveKeys(SECRET, appEnv);
  const stateId = overrideStateId ?? randomBytes(32).toString('base64url');
  const issuedAt = Math.floor(nowMs / 1000) - 1;
  const mac = createHmac('sha256', stateKey).update(`${stateId}|${issuedAt}`).digest('base64url');
  const cookieName = appEnv === 'prod' ? '__Host-dst_oidc_state' : 'dst_oidc_state';
  const cookie = `${cookieName}=${stateId}.${issuedAt}.${mac}`;

  const identity = `https://steamcommunity.com/openid/id/${FAKE_STEAM_ID}`;
  const returnTo = `${publicOrigin}${CALLBACK_PATH}?state=${stateId}`;
  const nonce = `${isoPrefix(nowMs - 5000)}r4nd0m`;
  const usp = new URLSearchParams();
  usp.set('openid.ns', OPENID_NS);
  usp.set('openid.mode', 'id_res');
  usp.set('openid.op_endpoint', STEAM_OP_ENDPOINT);
  usp.set('openid.claimed_id', identity);
  usp.set('openid.identity', identity);
  usp.set('openid.return_to', returnTo);
  usp.set('openid.response_nonce', nonce);
  usp.set('openid.assoc_handle', 'fake-assoc-handle');
  usp.set('openid.signed', EXPECTED_SIGNED);
  usp.set('openid.sig', 'ZmFrZS1zaWc=');
  usp.set('state', stateId);

  return { rawQueryString: usp.toString(), cookies: [cookie] };
}

beforeEach(() => {
  delete process.env['DEV_SESSION_SECRET'];
});

describe('Login route', () => {
  it('64. the redirect Location has exactly the six openid.* parameters with exactly those values', async () => {
    const { beginSteamLogin } = await loadAuth({});
    const deps = makeAuthDeps();
    const res = await beginSteamLogin(deps);
    const location = new URL(res.headers['location']!);
    expect(`${location.origin}${location.pathname}`).toBe(STEAM_OP_ENDPOINT);
    const keys = [...location.searchParams.keys()];
    expect(keys).toEqual([
      'openid.ns',
      'openid.mode',
      'openid.identity',
      'openid.claimed_id',
      'openid.return_to',
      'openid.realm',
    ]);
    expect(location.searchParams.get('openid.ns')).toBe(OPENID_NS);
    expect(location.searchParams.get('openid.mode')).toBe('checkid_setup');
    expect(location.searchParams.get('openid.identity')).toBe(
      'http://specs.openid.net/auth/2.0/identifier_select',
    );
    expect(location.searchParams.get('openid.claimed_id')).toBe(
      'http://specs.openid.net/auth/2.0/identifier_select',
    );
    expect(location.searchParams.get('openid.realm')).toBe('http://localhost:5173');
  });

  it('65. return_to and realm never change with a hostile Host/Origin/X-Forwarded-Host (beginSteamLogin takes no event at all)', async () => {
    const { beginSteamLogin } = await loadAuth({});
    const deps = makeAuthDeps();
    const res = await beginSteamLogin(deps);
    const location = new URL(res.headers['location']!);
    const returnTo = new URL(location.searchParams.get('openid.return_to')!);
    expect(`${returnTo.origin}${returnTo.pathname}`).toBe(`http://localhost:5173${CALLBACK_PATH}`);
    expect(location.searchParams.get('openid.realm')).toBe('http://localhost:5173');
  });

  it('66. state cookie matches the prod / test-local Set-Cookie shape', async () => {
    const prodAuth = await loadAuth({ appEnv: 'prod', publicOrigin: 'https://dst.ty.ler.dev' });
    const prodRes = await prodAuth.beginSteamLogin(makeAuthDeps());
    expect(prodRes.cookies[0]).toMatch(
      /^__Host-dst_oidc_state=[^;]+; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
    );

    const testAuth = await loadAuth({ appEnv: 'test', publicOrigin: 'http://localhost:5173' });
    const testRes = await testAuth.beginSteamLogin(makeAuthDeps());
    expect(testRes.cookies[0]).toMatch(
      /^dst_oidc_state=[^;]+; Max-Age=600; Path=\/; HttpOnly; SameSite=Lax$/,
    );
  });

  it('67. two successive logins produce different stateIds', async () => {
    const { beginSteamLogin } = await loadAuth({});
    const deps = makeAuthDeps();
    const res1 = await beginSteamLogin(deps);
    const res2 = await beginSteamLogin(deps);
    const id1 = new URL(res1.headers['location']!).searchParams.get('openid.return_to');
    const id2 = new URL(res2.headers['location']!).searchParams.get('openid.return_to');
    expect(id1).not.toBe(id2);
  });
});

describe('mode / ns / pollution', () => {
  it('63. non-GET method on the callback -> 405', async () => {
    const { completeSteamLogin } = await loadAuth({});
    const deps = makeAuthDeps();
    const event = makeEvent('POST', '');
    const res = await completeSteamLogin(event, deps);
    expect(res.status).toBe(405);
  });
});

describe('Session / allowlist', () => {
  it('68. valid login by a SteamID not in the allowlist -> no session Set-Cookie, Location /?error=not-allowed', async () => {
    const { completeSteamLogin } = await loadAuth({});
    const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
    const { rawQueryString, cookies } = buildValidCallback('test', 'http://localhost:5173', nowMs);
    const deps = makeAuthDeps({ users: {}, nowMs: () => nowMs });
    const event = makeEvent('GET', rawQueryString, cookies);
    const res = await completeSteamLogin(event, deps);
    expect(res.headers['location']).toBe('/?error=not-allowed');
    expect(res.cookies.some((c) => c.startsWith('dst_session='))).toBe(false);
  });

  it('69. valid login by an allowlisted SteamID -> session Set-Cookie matches the exact shape', async () => {
    const { completeSteamLogin } = await loadAuth({
      appEnv: 'prod',
      publicOrigin: 'https://dst.ty.ler.dev',
    });
    const nowMs = Date.parse('2026-06-01T12:00:00.000Z');
    const { rawQueryString, cookies } = buildValidCallback('prod', 'https://dst.ty.ler.dev', nowMs);
    const deps = makeAuthDeps({ nowMs: () => nowMs });
    const event = makeEvent('GET', rawQueryString, cookies);
    const res = await completeSteamLogin(event, deps);
    expect(res.headers['location']).toBe('/');
    const sessionCookie = res.cookies.find((c) => c.startsWith('__Host-dst_session='));
    expect(sessionCookie).toMatch(
      /^__Host-dst_session=[^;]+; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Lax$/,
    );
  });
});

describe('CSRF / headers', () => {
  it('100. POST /api/auth/logout returns the exact clearing Set-Cookie for the env and 204', async () => {
    const { logout } = await loadAuth({});
    const res = logout(makeAuthDeps());
    expect(res.status).toBe(204);
    expect(res.cookies).toEqual(['dst_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax']);

    const prodAuth = await loadAuth({ appEnv: 'prod', publicOrigin: 'https://dst.ty.ler.dev' });
    const prodRes = prodAuth.logout(makeAuthDeps());
    expect(prodRes.status).toBe(204);
    expect(prodRes.cookies).toEqual([
      '__Host-dst_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax',
    ]);
  });
});
