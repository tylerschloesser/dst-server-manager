// docs/auth.md §4, docs/decisions.md §16.32: `deriveSessionKey` is the one exported entry point
// for the HKDF session-key derivation `secrets.ts`'s `deriveKeys` owns. Every caller outside this
// package (`src/local.ts`, `e2e/support/session.ts`, `scripts/mint-cookie.ts`,
// `scripts/lifecycle-test.ts`) imports this instead of reproducing the formula. These cases pin
// the two properties those callers rely on: determinism (so re-deriving from a re-read secret is
// safe) and env-separation (the cross-env rejection property behind docs/auth.md §5.2 step 4 /
// §9.2 cases 71-72, and docs/decisions.md §9).
//
// `./index` imports `./env`, which validates `APP_ENV`/`PUBLIC_ORIGIN` at module load. Static
// imports are hoisted above any `process.env` assignment in this file, so `./index` is imported
// dynamically, after setting the env, rather than at the top of the file (same pattern as
// `csrfHeaders.test.ts`).
import { beforeAll, describe, expect, it } from 'vitest';

import type { deriveSessionKey as DeriveSessionKey } from './index';

let deriveSessionKey: typeof DeriveSessionKey;

beforeAll(async () => {
  process.env['APP_ENV'] = 'test';
  process.env['PUBLIC_ORIGIN'] = 'http://localhost:5173';
  ({ deriveSessionKey } = await import('./index'));
});

describe('deriveSessionKey', () => {
  it('is deterministic for the same secret and env', () => {
    const a = deriveSessionKey('fixture-secret-value', 'prod');
    const b = deriveSessionKey('fixture-secret-value', 'prod');
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(32);
  });

  it('domain-separates by appEnv (prod vs test), matching docs/auth.md §4 / docs/decisions.md §9', () => {
    const prod = deriveSessionKey('fixture-secret-value', 'prod');
    const test = deriveSessionKey('fixture-secret-value', 'test');
    expect(prod.equals(test)).toBe(false);
  });

  it('differs for a different secret', () => {
    const a = deriveSessionKey('fixture-secret-value', 'prod');
    const b = deriveSessionKey('another-fixture-secret', 'prod');
    expect(a.equals(b)).toBe(false);
  });
});
