import { describe, expect, it } from 'vitest';

import { DEFAULT_DAYS, parseArgs, USAGE } from './mint-guest-link';

describe('mint-guest-link parseArgs', () => {
  it('returns { help: true } for --help, even beside invalid flags', () => {
    expect(parseArgs(['--help'])).toEqual({ help: true });
    expect(parseArgs(['-h', '--days', '99'])).toEqual({ help: true });
  });

  it('documents every flag in USAGE', () => {
    for (const flag of ['--label', '--days', '--help']) expect(USAGE).toContain(flag);
  });

  it('requires --label, and defaults --days to 7', () => {
    expect(() => parseArgs([])).toThrow(/--label is required/);
    expect(parseArgs(['--label', 'bob'])).toEqual({
      help: false,
      label: 'bob',
      days: DEFAULT_DAYS,
    });
    expect(DEFAULT_DAYS).toBe(7);
  });

  it('validates the label the verifier will check', () => {
    expect(() => parseArgs(['--label', 'Bob'])).toThrow(/\[a-z0-9-\]/);
    expect(() => parseArgs(['--label', 'a'.repeat(33)])).toThrow(/\[a-z0-9-\]/);
    expect(() => parseArgs(['--label'])).toThrow(/--label requires a value/);
  });

  it('accepts 1..30 whole days and nothing else', () => {
    expect(parseArgs(['--label', 'x', '--days', '1'])).toMatchObject({ days: 1 });
    expect(parseArgs(['--label', 'x', '--days', '30'])).toMatchObject({ days: 30 });
    for (const bad of ['0', '31', '1.5', '-1', 'seven']) {
      expect(() => parseArgs(['--label', 'x', '--days', bad])).toThrow(/--days/);
    }
  });

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--label', 'x', '--wat'])).toThrow(/unknown argument/);
  });
});
