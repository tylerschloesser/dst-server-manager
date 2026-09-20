import { describe, expect, it } from 'vitest';

import { parseArgs, USAGE } from './lifecycle-test';

describe('lifecycle-test parseArgs', () => {
  it('returns { help: true } for --help, before anything else is validated', () => {
    expect(parseArgs(['--help'])).toEqual({ help: true });
    expect(parseArgs(['--until-phase', 'not-a-number', '--help'])).toEqual({ help: true });
  });

  it('prints every documented flag in USAGE', () => {
    for (const flag of [
      '--cleanup-only',
      '--skip-reaper',
      '--until-phase',
      '--timeout-minutes',
      '--keep-going',
      '--help',
    ]) {
      expect(USAGE).toContain(flag);
    }
  });

  it('defaults to a full run with a 150 minute budget', () => {
    expect(parseArgs([])).toEqual({
      help: false,
      cleanupOnly: false,
      skipReaper: false,
      untilPhase: null,
      timeoutMinutes: 150,
      keepGoing: false,
    });
  });

  it('parses every flag', () => {
    const parsed = parseArgs([
      '--cleanup-only',
      '--skip-reaper',
      '--until-phase',
      '3',
      '--timeout-minutes',
      '45',
      '--keep-going',
    ]);
    expect(parsed).toEqual({
      help: false,
      cleanupOnly: true,
      skipReaper: true,
      untilPhase: 3,
      timeoutMinutes: 45,
      keepGoing: true,
    });
  });

  it('rejects an out-of-range --until-phase', () => {
    expect(() => parseArgs(['--until-phase', '11'])).toThrow(/--until-phase/);
    expect(() => parseArgs(['--until-phase', '-1'])).toThrow(/--until-phase/);
  });

  it('rejects a non-positive --timeout-minutes', () => {
    expect(() => parseArgs(['--timeout-minutes', '0'])).toThrow(/--timeout-minutes/);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--wat'])).toThrow(/unknown argument/);
  });
});
