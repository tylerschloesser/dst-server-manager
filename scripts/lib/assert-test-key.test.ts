import { describe, expect, it } from 'vitest';

import { assertTestKey, TEST_WORLD_ID_RE } from './assert-test-key';

describe('assertTestKey', () => {
  it('refuses a non-test key', () => {
    expect(() => assertTestKey('worlds/tylerni2026/save.tar.zst')).toThrow(
      /refuses a non-test key/,
    );
    expect(() => assertTestKey('seed/test-lifecycle-a/dst.zip')).toThrow(/refuses a non-test key/);
    expect(() => assertTestKey('tylerni2026')).toThrow(/refuses a non-test key/);
    expect(() => assertTestKey('')).toThrow(/refuses a non-test key/);
    expect(() => assertTestKey('binaries/dst-binaries.tar.zst')).toThrow(/refuses a non-test key/);
  });

  it('allows a bare test world id', () => {
    expect(() => assertTestKey('test-lifecycle-a')).not.toThrow();
    expect(() => assertTestKey('test-prune')).not.toThrow();
  });

  it('allows an S3 key under worlds/, inflight/ or sessions/ scoped to a test world', () => {
    expect(() => assertTestKey('worlds/test-lifecycle-a/save.tar.zst')).not.toThrow();
    expect(() => assertTestKey('inflight/test-lifecycle-b/save.tar.zst')).not.toThrow();
    expect(() =>
      assertTestKey('sessions/test-lifecycle-a/20260919T201355Z-a1b2c3/manifest.json'),
    ).not.toThrow();
  });

  it('refuses a test world id longer than the pinned pattern', () => {
    const tooLong = `test-${'a'.repeat(28)}`;
    expect(TEST_WORLD_ID_RE.test(tooLong)).toBe(false);
    expect(() => assertTestKey(tooLong)).toThrow(/refuses a non-test key/);
  });
});
