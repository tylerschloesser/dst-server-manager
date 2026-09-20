// HKDF key derivation, mirroring the public formula documented in docs/auth.md §4
// (`packages/api/src/auth/secrets.ts`'s `deriveKeys`). This is *not* the signer: the signer
// (`mintSessionToken`/`verifySessionToken`, the actual HMAC step) is always imported from
// `@dst/api/auth` and never re-implemented here. `deriveKeys`/`getDerivedKeys` are internal to
// `packages/api/src/auth/secrets.ts` and are not exported from the `@dst/api/auth` subpath, so
// `scripts/mint-cookie.ts` and `scripts/lifecycle-test.ts` reproduce the same, already-public
// derivation `e2e/support/session.ts` inlines for the identical reason (docs/testing.md §4.2,
// §5.1).
import { hkdfSync } from 'node:crypto';

export type AppEnv = 'prod' | 'test' | 'local';

/** docs/auth.md §4: `sessionKey = HKDF-SHA256(secret, salt='dst-v1', info='<appEnv>:session')`. */
export function deriveSessionKey(secret: string, appEnv: AppEnv): Buffer {
  const ikm = Buffer.from(secret, 'utf8');
  const salt = Buffer.from('dst-v1', 'utf8');
  return Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(`${appEnv}:session`, 'utf8'), 32));
}
