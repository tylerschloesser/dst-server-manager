// @dst/api/auth — the subpath imported by e2e/support/session.ts, scripts/mint-cookie.ts and
// scripts/lifecycle-test.ts (docs/decisions.md §16.32, docs/auth.md §9.3). Does NOT re-export
// TEST_SESSION_SECRET (docs/decisions.md §16.37).
//
// This is the compile-ready stub for T2.1: it exports exactly the signatures
// `docs/control-plane.md` §5.2 and `docs/auth.md` §2-§6 define, wired into the router and the
// local dev server, so every other route works end-to-end while auth itself is unimplemented.
// `requireUser` fails closed (always 401) until T2.2 replaces these bodies with the real Steam
// OpenID verifier, session tokens and allowlist.
import type { HttpRequest } from '../ports';

export type User = { steamId64: string; nickname: string };

export interface AuthResponse {
  status: number;
  headers: Record<string, string>;
  cookies: string[];
  body?: string;
}

/** docs/auth.md §4: the secret arrives through a port so this module never branches on `APP_ENV`
 *  and never references the test secret. */
export interface SecretSource {
  read(): Promise<string>;
}

/** docs/auth.md §7: `/dst/users` re-checked on every request (60 s cache), `{steamid64: nickname}`. */
export interface AllowlistSource {
  getUsers(): Promise<Record<string, string>>;
}

export interface AuthDeps {
  secrets: SecretSource;
  users: AllowlistSource;
  nowMs(): number;
  fetchSteam: typeof fetch;
}

export type RequireUserResult =
  { ok: true; user: User } | { ok: false; status: 401 | 403; code: 'unauthorized' | 'not_allowed' };

const NOT_IMPLEMENTED = 'not implemented: T2.2 replaces src/auth/index.ts (docs/auth.md)';

/** GET /api/auth/steam/login: 302 to Steam, sets the state cookie. */
export async function beginSteamLogin(deps: AuthDeps): Promise<AuthResponse> {
  void deps;
  return Promise.reject(new Error(NOT_IMPLEMENTED));
}

/** GET /api/auth/steam/callback: verify, set session, 302 `/` (or an error redirect). */
export async function completeSteamLogin(
  event: HttpRequest,
  deps: AuthDeps,
): Promise<AuthResponse> {
  void event;
  void deps;
  return Promise.reject(new Error(NOT_IMPLEMENTED));
}

/** POST /api/auth/logout: clears the session cookie. */
export function logout(deps: AuthDeps): AuthResponse {
  void deps;
  throw new Error(NOT_IMPLEMENTED);
}

/**
 * docs/auth.md §6. The stub always fails closed with 401 `unauthorized`, which is what makes
 * every route that needs a user (GET /api/me, GET /api/worlds via the Identity port, start/stop)
 * correctly return 401 before T2.2 exists.
 */
export function requireUser(event: HttpRequest, deps: AuthDeps): Promise<RequireUserResult> {
  void event;
  void deps;
  return Promise.resolve({ ok: false, status: 401, code: 'unauthorized' });
}

/** docs/auth.md §5.1. */
export function mintSessionToken(a: {
  steamId64: string;
  sessionKey: Buffer;
  nowSec: number;
}): string {
  void a;
  throw new Error(NOT_IMPLEMENTED);
}

/** docs/auth.md §5.2. */
export function verifySessionToken(
  token: string,
  sessionKey: Buffer,
  nowSec: number,
): { steamId64: string } | null {
  void token;
  void sessionKey;
  void nowSec;
  throw new Error(NOT_IMPLEMENTED);
}
