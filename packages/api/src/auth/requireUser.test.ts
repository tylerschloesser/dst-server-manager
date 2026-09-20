// docs/auth.md §9.2, `Session / allowlist` group, cases 84-92 (plus the cookie-reading cases 88-90
// which double as `requireUser`'s own §6.1 tests). Uses the same dynamic-import pattern as
// `completeSteamLogin.test.ts` for the cases that need the real, wired-up `requireUser` export
// (whose signature is fixed and reads `APP_ENV` from `env.ts`); cases 91 and 92 test
// `getSessionSecret` and the module-load assertion directly.
import { describe, expect, it, vi } from 'vitest';

import { getSessionSecret } from './secrets';
import type { HttpRequest } from '../ports';

const SECRET = 'unit-test-only-secret-value';
const ALLOWED_ID = '76561199000000001';
const OTHER_ALLOWED_ID = '76561199000000002';

/**
 * Flips a bit in the *first* byte of a base64url-encoded value and re-encodes it. A naive
 * "swap the last character" corruption can alias to the identical decoded bytes for a 32-byte MAC
 * (its 43-character base64url encoding has a trailing character with only 4 significant bits), so
 * this corrupts the first byte instead, which is never truncated and therefore always produces a
 * genuinely different decoded value. See `steamOpenId.test.ts`'s `corruptBase64url` for the full
 * explanation.
 */
function corruptBase64url(value: string): string {
  const buf = Buffer.from(value, 'base64url');
  buf[0] = buf[0]! ^ 0x01;
  return buf.toString('base64url');
}

async function loadAuth(env: { appEnv?: string; devSessionSecret?: string } = {}) {
  vi.resetModules();
  process.env['APP_ENV'] = env.appEnv ?? 'test';
  process.env['PUBLIC_ORIGIN'] = 'http://localhost:5173';
  if (env.devSessionSecret !== undefined) {
    process.env['DEV_SESSION_SECRET'] = env.devSessionSecret;
  } else {
    delete process.env['DEV_SESSION_SECRET'];
  }
  return import('./index');
}

function makeEvent(opts: { cookies?: string[]; cookieHeader?: string } = {}): HttpRequest {
  const headers: Record<string, string> = {};
  if (opts.cookieHeader !== undefined) headers['cookie'] = opts.cookieHeader;
  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: '/api/me',
    rawQueryString: '',
    // Omitted (not `[]`) when unset, so the `event.headers.cookie` fallback (§6.1 step 1) is
    // actually exercised — a real Function URL payload always sets both, so this only matters for
    // the "give the same result" comparison test below.
    ...(opts.cookies !== undefined ? { cookies: opts.cookies } : {}),
    headers,
    requestContext: {
      accountId: 'test',
      apiId: 'test',
      domainName: 'test',
      domainPrefix: 'test',
      http: {
        method: 'GET',
        path: '/api/me',
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

describe('Session / allowlist', () => {
  it('84. a valid token for a SteamID removed from /dst/users -> 403 after the 60s cache expires (injected clock)', async () => {
    const { requireUser, mintSessionToken } = await loadAuth();
    let now = Date.parse('2026-06-01T12:00:00.000Z');
    let users: Record<string, string> = { [ALLOWED_ID]: 'Tyler' };
    const deps = {
      secrets: { read: async () => SECRET },
      users: { getUsers: async () => users },
      nowMs: () => now,
      fetchSteam: vi.fn<typeof fetch>(),
    };
    // Derive the same session key `requireUser` will derive, via a real login round trip.
    const { deriveKeys } = await import('./secrets');
    const { sessionKey } = deriveKeys(SECRET, 'test');
    const token = mintSessionToken({
      steamId64: ALLOWED_ID,
      sessionKey,
      nowSec: Math.floor(now / 1000),
    });
    const event = makeEvent({ cookies: [`dst_session=${token}`] });

    const first = await requireUser(event, deps);
    expect(first.ok).toBe(true);

    users = {}; // removed from the allowlist
    now += 61_000; // past ALLOWLIST_TTL_MS
    const second = await requireUser(event, deps);
    expect(second).toEqual({ ok: false, status: 403, code: 'not_allowed' });
  });

  it('85. malformed /dst/users JSON -> 403 for a previously-valid user, stale good map is not reused', async () => {
    const { requireUser, mintSessionToken } = await loadAuth();
    let now = Date.parse('2026-06-01T12:00:00.000Z');
    const { deriveKeys } = await import('./secrets');
    const { sessionKey } = deriveKeys(SECRET, 'test');
    const token = mintSessionToken({
      steamId64: ALLOWED_ID,
      sessionKey,
      nowSec: Math.floor(now / 1000),
    });
    const event = makeEvent({ cookies: [`dst_session=${token}`] });

    let broken = false;
    const deps = {
      secrets: { read: async () => SECRET },
      users: {
        getUsers: async () => {
          if (broken) throw new SyntaxError('Unexpected token in JSON');
          return { [ALLOWED_ID]: 'Tyler' };
        },
      },
      nowMs: () => now,
      fetchSteam: vi.fn<typeof fetch>(),
    };

    const first = await requireUser(event, deps);
    expect(first.ok).toBe(true);

    broken = true;
    now += 61_000;
    const second = await requireUser(event, deps);
    expect(second).toEqual({ ok: false, status: 403, code: 'not_allowed' });

    // Stale good value must not be served on a later call either, even though the cache still
    // holds the old (now expired) good entry.
    now += 1_000;
    const third = await requireUser(event, deps);
    expect(third).toEqual({ ok: false, status: 403, code: 'not_allowed' });
  });

  it('86. a key that is not a SteamID64, or a non-string value, rejects the whole map -> 403', async () => {
    const { requireUser, mintSessionToken } = await loadAuth();
    const now = Date.parse('2026-06-01T12:00:00.000Z');
    const { deriveKeys } = await import('./secrets');
    const { sessionKey } = deriveKeys(SECRET, 'test');
    const token = mintSessionToken({
      steamId64: ALLOWED_ID,
      sessionKey,
      nowSec: Math.floor(now / 1000),
    });
    const event = makeEvent({ cookies: [`dst_session=${token}`] });

    const badKeyDeps = {
      secrets: { read: async () => SECRET },
      users: { getUsers: async () => ({ 'not-a-steamid': 'Tyler' }) },
      nowMs: () => now,
      fetchSteam: vi.fn<typeof fetch>(),
    };
    expect(await requireUser(event, badKeyDeps)).toEqual({
      ok: false,
      status: 403,
      code: 'not_allowed',
    });

    const badValueDeps = {
      secrets: { read: async () => SECRET },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      users: { getUsers: async () => ({ [ALLOWED_ID]: 42 }) as any },
      nowMs: () => now + 1,
      fetchSteam: vi.fn<typeof fetch>(),
    };
    expect(await requireUser(event, badValueDeps)).toEqual({
      ok: false,
      status: 403,
      code: 'not_allowed',
    });
  });

  it('87. SSM GetParameter throws -> 403, not 500, not a crash', async () => {
    const { requireUser, mintSessionToken } = await loadAuth();
    const now = Date.parse('2026-06-01T12:00:00.000Z');
    const { deriveKeys } = await import('./secrets');
    const { sessionKey } = deriveKeys(SECRET, 'test');
    const token = mintSessionToken({
      steamId64: ALLOWED_ID,
      sessionKey,
      nowSec: Math.floor(now / 1000),
    });
    const event = makeEvent({ cookies: [`dst_session=${token}`] });

    const deps = {
      secrets: { read: async () => SECRET },
      users: {
        getUsers: async () => {
          throw new Error('AccessDeniedException');
        },
      },
      nowMs: () => now,
      fetchSteam: vi.fn<typeof fetch>(),
    };
    await expect(requireUser(event, deps)).resolves.toEqual({
      ok: false,
      status: 403,
      code: 'not_allowed',
    });
  });

  it('88. no cookie -> 401; tampered cookie -> 401; valid cookie for a non-allowlisted user -> 403', async () => {
    const { requireUser, mintSessionToken } = await loadAuth();
    const now = Date.parse('2026-06-01T12:00:00.000Z');
    const { deriveKeys } = await import('./secrets');
    const { sessionKey } = deriveKeys(SECRET, 'test');
    const deps = {
      secrets: { read: async () => SECRET },
      users: { getUsers: async () => ({ [ALLOWED_ID]: 'Tyler' }) },
      nowMs: () => now,
      fetchSteam: vi.fn<typeof fetch>(),
    };

    expect(await requireUser(makeEvent(), deps)).toEqual({
      ok: false,
      status: 401,
      code: 'unauthorized',
    });

    const token = mintSessionToken({
      steamId64: ALLOWED_ID,
      sessionKey,
      nowSec: Math.floor(now / 1000),
    });
    const tokenParts = token.split('.');
    const tampered = [
      tokenParts[0],
      tokenParts[1],
      tokenParts[2],
      corruptBase64url(tokenParts[3]!),
    ].join('.');
    expect(await requireUser(makeEvent({ cookies: [`dst_session=${tampered}`] }), deps)).toEqual({
      ok: false,
      status: 401,
      code: 'unauthorized',
    });

    const notAllowedToken = mintSessionToken({
      steamId64: OTHER_ALLOWED_ID,
      sessionKey,
      nowSec: Math.floor(now / 1000),
    });
    expect(
      await requireUser(makeEvent({ cookies: [`dst_session=${notAllowedToken}`] }), deps),
    ).toEqual({ ok: false, status: 403, code: 'not_allowed' });
  });

  it('89. reading from event.cookies and from event.headers.cookie give the same result', async () => {
    const { requireUser, mintSessionToken } = await loadAuth();
    const now = Date.parse('2026-06-01T12:00:00.000Z');
    const { deriveKeys } = await import('./secrets');
    const { sessionKey } = deriveKeys(SECRET, 'test');
    const token = mintSessionToken({
      steamId64: ALLOWED_ID,
      sessionKey,
      nowSec: Math.floor(now / 1000),
    });
    const deps = {
      secrets: { read: async () => SECRET },
      users: { getUsers: async () => ({ [ALLOWED_ID]: 'Tyler' }) },
      nowMs: () => now,
      fetchSteam: vi.fn<typeof fetch>(),
    };

    const viaArray = await requireUser(makeEvent({ cookies: [`dst_session=${token}`] }), deps);
    const viaHeader = await requireUser(makeEvent({ cookieHeader: `dst_session=${token}` }), deps);
    expect(viaArray).toEqual(viaHeader);
    expect(viaArray).toEqual({ ok: true, user: { steamId64: ALLOWED_ID, nickname: 'Tyler' } });
  });

  it('90. two dst_session cookies in one request -> treated as absent -> 401', async () => {
    const { requireUser, mintSessionToken } = await loadAuth();
    const now = Date.parse('2026-06-01T12:00:00.000Z');
    const { deriveKeys } = await import('./secrets');
    const { sessionKey } = deriveKeys(SECRET, 'test');
    const token = mintSessionToken({
      steamId64: ALLOWED_ID,
      sessionKey,
      nowSec: Math.floor(now / 1000),
    });
    const deps = {
      secrets: { read: async () => SECRET },
      users: { getUsers: async () => ({ [ALLOWED_ID]: 'Tyler' }) },
      nowMs: () => now,
      fetchSteam: vi.fn<typeof fetch>(),
    };
    const event = makeEvent({ cookies: [`dst_session=${token}`, `dst_session=${token}`] });
    expect(await requireUser(event, deps)).toEqual({
      ok: false,
      status: 401,
      code: 'unauthorized',
    });
  });

  it('91. production secret loader with the SSM parameter missing -> throws "missing session secret", no env-var fallback', async () => {
    const missingSource = { read: async () => '' };
    await expect(getSessionSecret(missingSource)).rejects.toThrow('missing session secret');

    process.env['DEV_SESSION_SECRET'] = 'should-never-be-consulted';
    await expect(getSessionSecret(missingSource)).rejects.toThrow('missing session secret');
    delete process.env['DEV_SESSION_SECRET'];
  });

  it('92. module load with APP_ENV=prod and DEV_SESSION_SECRET set -> throws', async () => {
    await expect(loadAuth({ appEnv: 'prod', devSessionSecret: 'leaked' })).rejects.toThrow();
    delete process.env['DEV_SESSION_SECRET'];
  });
});
