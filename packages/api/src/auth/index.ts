// @dst/api/auth — the subpath imported by e2e/support/session.ts, scripts/mint-cookie.ts and
// scripts/lifecycle-test.ts (docs/decisions.md §16.32, docs/auth.md §9.3). Does NOT re-export
// TEST_SESSION_SECRET (docs/decisions.md §16.37).
//
// This is the real implementation (T2.2) behind the T2.1 stub: it exports exactly the signatures
// `docs/control-plane.md` §5.2 and `docs/auth.md` §2-§6 define, wired into the router and the
// local dev server. All of the actual logic lives in the sibling files (`env.ts`, `constants.ts`,
// `cookies.ts`, `headers.ts`, `secrets.ts`, `session.ts`, `allowlist.ts`, `steamOpenId.ts`,
// `requireUser.ts`), which are parameterized by `AppEnv`/`publicOrigin` rather than reading
// `process.env` themselves; this file is the one place that reads the real `APP_ENV` and
// `PUBLIC_ORIGIN` (via `env.ts`, which validates them at module load — docs/auth.md §0) and
// threads them through.
import { createHmac, randomBytes } from 'node:crypto';

import { getAllowlist } from './allowlist';
import type { AppEnv } from './constants';
import { CALLBACK_PATH, OPENID_NS, STEAM_OP_ENDPOINT } from './constants';
import {
  buildSessionCookie,
  buildStateCookie,
  candidateCookieStrings,
  clearSessionCookie,
  clearStateCookie,
} from './cookies';
import { APP_ENV, PUBLIC_ORIGIN } from './env';
import { API_SECURITY_HEADERS } from './headers';
import { requireUserImpl } from './requireUser';
import { deriveKeys, getDerivedKeys } from './secrets';
import { mintSessionTokenImpl, verifySessionTokenImpl } from './session';
import { verifyCallback } from './steamOpenId';
import type { AuthDeps, AuthResponse, RequireUserResult } from './types';
import type { HttpRequest } from '../ports';

export type { AllowlistSource } from './allowlist';
export type { AppEnv } from './constants';
export type { SecretSource } from './secrets';
export type { AuthDeps, AuthResponse, RequireUserResult, User } from './types';

/** docs/spikes/cloudfront-oac-lambda-url.md: the real viewer IP is `x-forwarded-for`, never
 * `requestContext.http.sourceIp`. Duplicated (rather than imported) from `router.ts`'s `viewerIp`
 * to avoid a circular import (`router.ts` imports `* as auth from './auth'`). */
function firstForwardedFor(event: HttpRequest): string | null {
  const xff = event.headers['x-forwarded-for'];
  if (typeof xff !== 'string' || xff.length === 0) return null;
  const first = xff.split(',')[0]?.trim();
  return first !== undefined && first.length > 0 ? first : null;
}

/** GET /api/auth/steam/login: 302 to Steam, sets the state cookie (docs/auth.md §2). No request
 * input of any kind influences `return_to` or `realm` — this function doesn't even take an
 * `event` — so there is no open-redirect surface here. */
export async function beginSteamLogin(deps: AuthDeps): Promise<AuthResponse> {
  const stateId = randomBytes(32).toString('base64url'); // 43 chars
  const issuedAt = Math.floor(deps.nowMs() / 1000);
  const { stateKey } = await getDerivedKeys(deps.secrets, APP_ENV);
  const mac = createHmac('sha256', stateKey).update(`${stateId}|${issuedAt}`).digest('base64url');
  const cookieValue = `${stateId}.${issuedAt}.${mac}`;

  const returnTo = `${PUBLIC_ORIGIN}${CALLBACK_PATH}?state=${encodeURIComponent(stateId)}`;
  const qs = new URLSearchParams([
    ['openid.ns', OPENID_NS],
    ['openid.mode', 'checkid_setup'],
    ['openid.identity', 'http://specs.openid.net/auth/2.0/identifier_select'],
    ['openid.claimed_id', 'http://specs.openid.net/auth/2.0/identifier_select'],
    ['openid.return_to', returnTo],
    ['openid.realm', PUBLIC_ORIGIN],
  ]);

  return {
    status: 302,
    headers: { ...API_SECURITY_HEADERS, location: `${STEAM_OP_ENDPOINT}?${qs.toString()}` },
    cookies: [buildStateCookie(APP_ENV, cookieValue)],
  };
}

/** GET /api/auth/steam/callback: verify, set session, 302 `/` (or an error redirect). Every
 * outcome — including a bad method — carries the §8.2 headers and clears the state cookie
 * (docs/auth.md §3.3): it is single-use. */
export async function completeSteamLogin(
  event: HttpRequest,
  deps: AuthDeps,
): Promise<AuthResponse> {
  // C0 — verifyCallback has no access to the HTTP method, so this is checked here. Still clears
  // the state cookie (docs/auth.md §3.3: "Every callback response ... clears it") — defect 6.
  if (event.requestContext.http.method !== 'GET') {
    return {
      status: 405,
      headers: { ...API_SECURITY_HEADERS },
      cookies: [clearStateCookie(APP_ENV)],
    };
  }

  const cookies = candidateCookieStrings(event);
  const { sessionKey, stateKey } = await getDerivedKeys(deps.secrets, APP_ENV);

  const result = await verifyCallback(event.rawQueryString, cookies, {
    nowMs: deps.nowMs,
    fetchSteam: deps.fetchSteam,
    stateKey,
    appEnv: APP_ENV,
    publicOrigin: PUBLIC_ORIGIN,
  });

  let location: string;
  let outcome: string;
  let check: string | null = null;
  let steamId64: string | null = null;
  let sessionCookie: string | null = null;

  if (result.kind === 'ok') {
    steamId64 = result.steamId64;
    // C19 — allowlist. Never mint a session first and check later.
    const users = await getAllowlist(deps.users, deps.nowMs);
    if (Object.hasOwn(users, result.steamId64)) {
      // C20 — mint the session.
      const token = mintSessionTokenImpl({
        steamId64: result.steamId64,
        sessionKey,
        nowSec: Math.floor(deps.nowMs() / 1000),
        appEnv: APP_ENV,
      });
      sessionCookie = buildSessionCookie(APP_ENV, token);
      location = '/';
      outcome = 'ok';
    } else {
      location = '/?error=not-allowed';
      outcome = 'not-allowed';
    }
  } else if (result.kind === 'cancelled') {
    location = '/?login=cancelled';
    outcome = 'cancelled';
  } else if (result.kind === 'retryable') {
    location = '/?error=steam-unavailable';
    outcome = 'retryable';
    check = result.check;
  } else {
    location = '/?error=login-failed';
    outcome = 'rejected';
    check = result.check;
  }

  // docs/auth.md §3.4: never log rawQueryString, the full callback URL, any openid.* value, the
  // Cookie header, a session/state cookie value, or the session secret.
  console.log(
    JSON.stringify({
      evt: 'auth.callback',
      outcome,
      check,
      steamId64,
      ip: firstForwardedFor(event),
    }),
  );

  const cookiesOut = [clearStateCookie(APP_ENV)];
  if (sessionCookie !== null) cookiesOut.push(sessionCookie);

  return {
    status: 302,
    headers: { ...API_SECURITY_HEADERS, location },
    cookies: cookiesOut,
  };
}

/** POST /api/auth/logout: clears the session cookie. CSRF is checked by the router before this is
 * called (docs/auth.md §8.1). Valid without a session cookie (idempotent); no server state to
 * delete. */
export function logout(deps: AuthDeps): AuthResponse {
  void deps;
  return {
    status: 204,
    headers: { ...API_SECURITY_HEADERS },
    cookies: [clearSessionCookie(APP_ENV)],
  };
}

/** docs/auth.md §6. */
export function requireUser(event: HttpRequest, deps: AuthDeps): Promise<RequireUserResult> {
  return requireUserImpl(event, deps, APP_ENV);
}

/** docs/auth.md §5.1. The cookie-minting helper also used, unmodified, by
 * `e2e/support/session.ts` and `scripts/mint-cookie.ts` (docs/auth.md §9.3). */
export function mintSessionToken(a: {
  steamId64: string;
  sessionKey: Buffer;
  nowSec: number;
}): string {
  return mintSessionTokenImpl({ ...a, appEnv: APP_ENV });
}

/** docs/auth.md §5.2. */
export function verifySessionToken(
  token: string,
  sessionKey: Buffer,
  nowSec: number,
): { steamId64: string } | null {
  return verifySessionTokenImpl(token, sessionKey, nowSec, APP_ENV);
}

/** docs/auth.md §4: the session-key half of `secrets.ts`'s `deriveKeys`, exported so every caller
 * that needs a `sessionKey` for a specific `appEnv` (rather than the running Lambda's own
 * `APP_ENV`) — `src/local.ts`'s dev-login route, `e2e/support/session.ts`, and
 * `scripts/mint-cookie.ts` / `scripts/lifecycle-test.ts` — imports the one real implementation
 * instead of reproducing the HKDF formula (decisions §16.32). Does not export `stateKey`: nothing
 * outside the Lambda's own request handling needs it. */
export function deriveSessionKey(secret: string, appEnv: AppEnv): Buffer {
  return deriveKeys(secret, appEnv).sessionKey;
}
