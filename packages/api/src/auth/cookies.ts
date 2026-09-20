// docs/auth.md §2, §3.3, §5.3, §6.1: cookie names, the exact `Set-Cookie` strings (attribute order
// as written in the doc), and the shared cookie-parsing logic used by both the callback verifier
// (state cookie) and `requireUser` (session cookie).
import type { AppEnv } from './constants';

export function stateCookieName(appEnv: AppEnv): string {
  return appEnv === 'prod' ? '__Host-dst_oidc_state' : 'dst_oidc_state';
}

export function sessionCookieName(appEnv: AppEnv): string {
  return appEnv === 'prod' ? '__Host-dst_session' : 'dst_session';
}

export function buildStateCookie(appEnv: AppEnv, value: string): string {
  const name = stateCookieName(appEnv);
  return appEnv === 'prod'
    ? `${name}=${value}; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`
    : `${name}=${value}; Max-Age=600; Path=/; HttpOnly; SameSite=Lax`;
}

export function clearStateCookie(appEnv: AppEnv): string {
  const name = stateCookieName(appEnv);
  return appEnv === 'prod'
    ? `${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`
    : `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`;
}

export function buildSessionCookie(appEnv: AppEnv, token: string): string {
  const name = sessionCookieName(appEnv);
  return appEnv === 'prod'
    ? `${name}=${token}; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax`
    : `${name}=${token}; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax`;
}

export function clearSessionCookie(appEnv: AppEnv): string {
  const name = sessionCookieName(appEnv);
  return appEnv === 'prod'
    ? `${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`
    : `${name}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`;
}

/** docs/auth.md §6.1 step 1. Takes only the two fields it needs so callers (including
 * `verifyCallback`'s caller, which passes just the resolved `cookies` array) don't need a full
 * `HttpRequest`. */
export function candidateCookieStrings(event: {
  cookies?: string[];
  headers: Record<string, string | undefined>;
}): string[] {
  if (Array.isArray(event.cookies)) return event.cookies;
  const header = event.headers['cookie'] ?? '';
  return header.split(';');
}

/** docs/auth.md §6.1 steps 2-3, reused by the state-cookie read in the callback verifier (§3.1
 * C16): trim, split on the first `=`, and fail closed (treat as absent) unless exactly one
 * candidate has this name. */
export function extractCookieValue(candidates: string[], name: string): string | null {
  const values: string[] = [];
  for (const raw of candidates) {
    const s = raw.trim();
    const i = s.indexOf('=');
    if (i === -1) continue;
    const cname = s.slice(0, i);
    const cvalue = s.slice(i + 1);
    if (cname === name) values.push(cvalue);
  }
  return values.length === 1 ? values[0]! : null;
}
