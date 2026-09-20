// docs/web.md §7 / docs/auth.md §9.3 / docs/decisions.md §16.32, §16.37: mints a `dst_session`
// cookie for Playwright without ever talking to Steam. The signer (`mintSessionToken`) is
// imported from `@dst/api/auth`, never re-implemented. The test-only secret is imported from the
// separate `@dst/api/test-secret` subpath — that import must never appear outside `e2e/` or a
// test file (decisions §16.37).
//
// The HKDF key-derivation step below (`deriveSessionKey`) is *not* the signer: it reproduces the
// public formula documented in docs/auth.md §4 (`packages/api/src/auth/secrets.ts`'s
// `deriveKeys`), which is not exported from the `@dst/api/auth` subpath. `packages/api/src/local.ts`
// itself inlines the identical derivation for its own `DST_LOCAL_ONLY` `/api/dev/login` route, so
// this mirrors an already-established pattern rather than reimplementing anything cryptographic
// that `@dst/api/auth` is meant to own.
import { hkdfSync } from 'node:crypto';
import { mintSessionToken } from '@dst/api/auth';
import { TEST_SESSION_SECRET } from '@dst/api/test-secret';

/** Obviously-fake SteamID64 (decisions §16 / docs/web.md §7): same constant
 * `packages/api/src/local.ts` uses for its own `DEV_USER_STEAMID64`, so one allowlist entry
 * authorizes both `pnpm dev`'s dev-login route and this suite. */
export const FAKE_STEAM_ID = '76561190000000001';

/** The nickname the local server's allowlist is expected to map `FAKE_STEAM_ID` to (matching
 * `docs/control-plane.md` §5.5's dev-login table entry, nickname "Dev"). Scenario 3
 * (`docs/web.md` §7) asserts this text appears in the header. */
export const TEST_NICKNAME = 'Dev';

/** The `APP_ENV` every e2e run mints tokens under (set at the top of `playwright.config.ts`,
 * before this module — or anything that imports it — is ever loaded). */
const SESSION_APP_ENV = 'test';

const SESSION_COOKIE_NAME = 'dst_session';

function deriveSessionKey(secret: string, appEnv: string): Buffer {
  const ikm = Buffer.from(secret, 'utf8');
  const salt = Buffer.from('dst-v1', 'utf8');
  return Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(`${appEnv}:session`, 'utf8'), 32));
}

/** Mints a `v1.test.<payload>.<hmac>` session token for `steamId64` (default `FAKE_STEAM_ID`)
 * via the real `mintSessionToken` signer. */
export function mintTestSession(steamId64: string = FAKE_STEAM_ID): string {
  const sessionKey = deriveSessionKey(TEST_SESSION_SECRET, SESSION_APP_ENV);
  return mintSessionToken({
    steamId64,
    sessionKey,
    nowSec: Math.floor(Date.now() / 1000),
  });
}

/** docs/web.md §7: the exact cookie shape the fixture adds to the browser context. `value` is
 * filled in by the caller (`mintTestSession()`). */
export function sessionCookie(value: string): {
  name: string;
  value: string;
  domain: string;
  path: string;
  httpOnly: true;
  secure: false;
  sameSite: 'Lax';
} {
  return {
    name: SESSION_COOKIE_NAME,
    value,
    domain: 'localhost',
    path: '/',
    httpOnly: true,
    secure: false,
    sameSite: 'Lax',
  };
}
