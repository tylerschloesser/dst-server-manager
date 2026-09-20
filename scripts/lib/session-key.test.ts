import { describe, expect, it } from 'vitest';

import { deriveSessionKey } from './session-key';

describe('deriveSessionKey', () => {
  it('is deterministic for the same secret and env', () => {
    const a = deriveSessionKey('fixture-secret-value', 'prod');
    const b = deriveSessionKey('fixture-secret-value', 'prod');
    expect(a.equals(b)).toBe(true);
    expect(a.length).toBe(32);
  });

  it('domain-separates by appEnv, matching docs/auth.md §4 (cross-env rejection depends on this)', () => {
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
