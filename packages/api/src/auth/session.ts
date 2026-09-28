// docs/auth.md §5: session token format, minting and verification. Fully parameterized (the env
// discriminator is an explicit argument, never read from `process.env`) so this module is a pure,
// directly unit-testable implementation of the format; `index.ts` wraps it with the real `APP_ENV`
// to produce the pinned `mintSessionToken`/`verifySessionToken` signatures docs/control-plane.md
// §5.2 defines.
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { AppEnv } from './constants';
import {
  BASE64URL_RE,
  GUEST_LABEL_RE,
  GUEST_MAX_AGE_S,
  MAX_TOKEN_LEN,
  SESSION_MAX_AGE_S,
  STEAMID64_RE,
} from './constants';

export interface MintSessionTokenInput {
  steamId64: string;
  sessionKey: Buffer;
  nowSec: number;
  appEnv: AppEnv;
}

/** docs/auth.md §5.1. `v1.<env>.<payloadB64>.<macB64>`; no `alg` field, no JWT library. */
export function mintSessionTokenImpl(a: MintSessionTokenInput): string {
  const iat = a.nowSec;
  const exp = iat + SESSION_MAX_AGE_S;
  const payload = { sub: a.steamId64, iat, exp }; // exact key order per §5.1
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = `v1.${a.appEnv}.${payloadB64}`;
  const macB64 = createHmac('sha256', a.sessionKey).update(signingInput).digest('base64url');
  return `${signingInput}.${macB64}`;
}

/** docs/auth.md §5.2 steps 1-8, shared by the session token (`v1`) and the guest token (`g1`,
 * docs/auth.md §12): format, env, encoding and MAC, then the payload as a plain object. */
function verifySignedPayload(
  token: string,
  prefix: 'v1' | 'g1',
  key: Buffer,
  appEnv: AppEnv,
): Record<string, unknown> | null {
  // 1
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LEN) return null;
  // 2
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [version, env, payloadB64, macB64] = parts as [string, string, string, string];
  // 3
  if (version !== prefix) return null;
  // 4 — the env discriminator, checked before any crypto.
  if (env !== appEnv) return null;
  // 5
  if (!BASE64URL_RE.test(payloadB64) || !BASE64URL_RE.test(macB64) || macB64.length !== 43) {
    return null;
  }
  // 6 — canonical-encoding check
  if (Buffer.from(payloadB64, 'base64url').toString('base64url') !== payloadB64) return null;
  if (Buffer.from(macB64, 'base64url').toString('base64url') !== macB64) return null;

  // 7
  const expected = createHmac('sha256', key).update(`${prefix}.${env}.${payloadB64}`).digest();
  const got = Buffer.from(macB64, 'base64url');
  if (got.length !== 32 || !timingSafeEqual(got, expected)) return null;

  // 8
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return payload as Record<string, unknown>;
}

/** docs/auth.md §5.2 steps 10-11: `iat`/`exp` are integers, not expired, not issued in the future
 * and never more than `maxAgeS` apart. Returns `exp`, or null. */
function checkLifetime(
  obj: Record<string, unknown>,
  nowSec: number,
  maxAgeS: number,
): number | null {
  // 10
  if (!Number.isSafeInteger(obj['iat']) || !Number.isSafeInteger(obj['exp'])) return null;
  const iat = obj['iat'] as number;
  const exp = obj['exp'] as number;
  // 11
  if (!(exp > nowSec)) return null;
  if (!(iat <= nowSec + 60)) return null;
  if (!(exp - iat <= maxAgeS)) return null;
  return exp;
}

/** docs/auth.md §5.2: ordered, fail on the first miss. */
export function verifySessionTokenImpl(
  token: string,
  sessionKey: Buffer,
  nowSec: number,
  appEnv: AppEnv,
): { steamId64: string } | null {
  const obj = verifySignedPayload(token, 'v1', sessionKey, appEnv);
  if (obj === null) return null;
  // 9
  if (typeof obj['sub'] !== 'string' || !STEAMID64_RE.test(obj['sub'])) return null;
  if (checkLifetime(obj, nowSec, SESSION_MAX_AGE_S) === null) return null;
  return { steamId64: obj['sub'] };
}

export interface MintGuestTokenInput {
  label: string;
  /** Lifetime in seconds, 1..GUEST_MAX_AGE_S. */
  ttlS: number;
  guestKey: Buffer;
  nowSec: number;
  appEnv: AppEnv;
}

/** docs/auth.md §12.1. `g1.<env>.<payloadB64>.<macB64>`, payload `{label,iat,exp}`, signed with
 * the guest key — never the session key, so neither token verifies as the other. Throws on a
 * label or lifetime the verifier would refuse, so a script can never print a dead link. */
export function mintGuestTokenImpl(a: MintGuestTokenInput): string {
  if (!GUEST_LABEL_RE.test(a.label)) throw new Error(`invalid guest label: ${a.label}`);
  if (!Number.isSafeInteger(a.ttlS) || a.ttlS < 1 || a.ttlS > GUEST_MAX_AGE_S) {
    throw new Error(`invalid guest lifetime: ${a.ttlS}`);
  }
  const iat = a.nowSec;
  const exp = iat + a.ttlS;
  const payload = { label: a.label, iat, exp }; // exact key order per §12.1
  const payloadB64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signingInput = `g1.${a.appEnv}.${payloadB64}`;
  const macB64 = createHmac('sha256', a.guestKey).update(signingInput).digest('base64url');
  return `${signingInput}.${macB64}`;
}

/** docs/auth.md §12.2: the §5.2 checks with `g1` for `v1`, the guest key, and step 9 validating
 * `label` instead of `sub`. */
export function verifyGuestTokenImpl(
  token: string,
  guestKey: Buffer,
  nowSec: number,
  appEnv: AppEnv,
): { label: string; exp: number } | null {
  const obj = verifySignedPayload(token, 'g1', guestKey, appEnv);
  if (obj === null) return null;
  // 9
  if (typeof obj['label'] !== 'string' || !GUEST_LABEL_RE.test(obj['label'])) return null;
  const exp = checkLifetime(obj, nowSec, GUEST_MAX_AGE_S);
  if (exp === null) return null;
  return { label: obj['label'], exp };
}
