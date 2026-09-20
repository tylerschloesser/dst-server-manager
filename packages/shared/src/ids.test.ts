import { describe, expect, it } from 'vitest';

import { SESSION_ID_RE, isTestWorldId, isValidWorldId, newSessionId, parseSessionId } from './ids';

describe('isValidWorldId', () => {
  it('accepts lowercase slugs up to 32 chars', () => {
    expect(isValidWorldId('tylerni2026')).toBe(true);
    expect(isValidWorldId('a')).toBe(true);
    expect(isValidWorldId('a'.repeat(32))).toBe(true);
  });

  it('rejects anything outside [a-z0-9-]{1,32}', () => {
    expect(isValidWorldId('')).toBe(false);
    expect(isValidWorldId('a'.repeat(33))).toBe(false);
    expect(isValidWorldId('Tyler')).toBe(false);
    expect(isValidWorldId('has space')).toBe(false);
    expect(isValidWorldId('under_score')).toBe(false);
  });
});

describe('isTestWorldId', () => {
  it('is true only for ids starting with test-', () => {
    expect(isTestWorldId('test-lifecycle-a')).toBe(true);
    expect(isTestWorldId('tylerni2026')).toBe(false);
  });
});

describe('newSessionId', () => {
  it('matches SESSION_ID_RE and is 23 characters', () => {
    const id = newSessionId(new Date('2026-09-19T20:13:55.123Z'));
    expect(id).toMatch(SESSION_ID_RE);
    expect(id).toHaveLength(23);
    expect(id.startsWith('20260919T201355Z-')).toBe(true);
  });

  it('sorts chronologically', () => {
    const earlier = newSessionId(new Date('2026-01-01T00:00:00Z'));
    const later = newSessionId(new Date('2026-06-15T12:30:00Z'));
    expect(earlier < later).toBe(true);
  });

  it('two calls in the same second differ', () => {
    const now = new Date('2026-09-19T20:13:55Z');
    const a = newSessionId(now);
    const b = newSessionId(now);
    expect(a).not.toBe(b);
  });
});

describe('parseSessionId', () => {
  it('round-trips with newSessionId', () => {
    const now = new Date('2026-09-19T20:13:55Z');
    const id = newSessionId(now);
    const parsed = parseSessionId(id);
    expect(parsed).not.toBeNull();
    expect(parsed?.timestamp.toISOString()).toBe(now.toISOString());
    expect(parsed?.hex).toMatch(/^[0-9a-f]{6}$/);
  });

  it('returns null for a malformed id', () => {
    expect(parseSessionId('not-a-session-id')).toBeNull();
    expect(parseSessionId('20260919T201355Z-ZZZZZZ')).toBeNull();
  });
});
