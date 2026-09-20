// docs/auth.md §5: session token format, minting and verification. Fully parameterized (the env
// discriminator is an explicit argument, never read from `process.env`) so this module is a pure,
// directly unit-testable implementation of the format; `index.ts` wraps it with the real `APP_ENV`
// to produce the pinned `mintSessionToken`/`verifySessionToken` signatures docs/control-plane.md
// §5.2 defines.
import { createHmac, timingSafeEqual } from 'node:crypto';

import type { AppEnv } from './constants';
import { BASE64URL_RE, MAX_TOKEN_LEN, SESSION_MAX_AGE_S, STEAMID64_RE } from './constants';

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

/** docs/auth.md §5.2: ordered, fail on the first miss. */
export function verifySessionTokenImpl(
  token: string,
  sessionKey: Buffer,
  nowSec: number,
  appEnv: AppEnv,
): { steamId64: string } | null {
  // 1
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LEN) return null;
  // 2
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [v1, env, payloadB64, macB64] = parts as [string, string, string, string];
  // 3
  if (v1 !== 'v1') return null;
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
  const expected = createHmac('sha256', sessionKey).update(`v1.${env}.${payloadB64}`).digest();
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
  const obj = payload as Record<string, unknown>;

  // 9
  if (typeof obj['sub'] !== 'string' || !STEAMID64_RE.test(obj['sub'])) return null;
  // 10
  if (!Number.isSafeInteger(obj['iat']) || !Number.isSafeInteger(obj['exp'])) return null;
  const iat = obj['iat'] as number;
  const exp = obj['exp'] as number;
  // 11
  if (!(exp > nowSec)) return null;
  if (!(iat <= nowSec + 60)) return null;
  if (!(exp - iat <= SESSION_MAX_AGE_S)) return null;

  return { steamId64: obj['sub'] };
}
