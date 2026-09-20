import { describe, expect, it } from 'vitest';

import { assertSecretValuesNonEmpty, parseArgs, scanForSecretLeaks, USAGE } from './lifecycle-test';

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

// Defect 8 (docs/_security-review.md): phase 4's "the secret never appears" leak check must not
// pass vacuously when SSM hands back an empty or missing value.
describe('lifecycle-test assertSecretValuesNonEmpty', () => {
  it('passes when both secret values are non-empty', () => {
    expect(() =>
      assertSecretValuesNonEmpty('real-token-value', 'real-password-value'),
    ).not.toThrow();
  });

  it('throws when the Klei token is empty', () => {
    expect(() => assertSecretValuesNonEmpty('', 'real-password-value')).toThrow(/vacuous/);
  });

  it('throws when the cluster password is empty', () => {
    expect(() => assertSecretValuesNonEmpty('real-token-value', '')).toThrow(/vacuous/);
  });

  it('throws when both secret values are empty (e.g. a missing SSM parameter)', () => {
    expect(() => assertSecretValuesNonEmpty('', '')).toThrow(/vacuous/);
  });
});

// Round 4 (docs/_first-boot-notes.md): the leak check used to sum hits across every downloaded
// object, so a failure could not say which one leaked. It must name the object — and only the
// object and the count (docs/testing.md §4.1 item 4).
describe('lifecycle-test scanForSecretLeaks', () => {
  const TOKEN = 'fixture-klei-token-2b9c11';
  const PASSWORD = 'fixture-password-4f7a02';
  // Interpolated, never a literal: scripts/check-secrets.sh blocks any tracked line where this
  // key is followed by something that looks like a value (docs/storage.md §6, decisions §16.35).
  const PASSWORD_KEY = 'cluster_password';

  it('reports no offenders for a clean set of sources', () => {
    const result = scanForSecretLeaks(
      [
        { label: 'save.tar.zst:cluster.ini', text: `${PASSWORD_KEY} = \n` },
        { label: 's3:sessions/test-x/s1/supervisor.log', text: '{"event":"joinable"}\n' },
      ],
      TOKEN,
      PASSWORD,
    );
    expect(result).toEqual({ tokenHits: 0, passwordHits: 0, offenders: [] });
  });

  it('names the offending object and its hit count, and nothing else', () => {
    const result = scanForSecretLeaks(
      [
        { label: 'save.tar.zst:cluster.ini', text: `${PASSWORD_KEY} = \n` },
        { label: 'save.tar.zst:Master/save/leaky', text: `password="${PASSWORD}"\n` },
      ],
      TOKEN,
      PASSWORD,
    );
    expect(result.tokenHits).toBe(0);
    expect(result.passwordHits).toBe(1);
    expect(result.offenders).toEqual([
      'save.tar.zst:Master/save/leaky (token hits=0, password hits=1)',
    ]);
    for (const offender of result.offenders) {
      expect(offender).not.toContain(PASSWORD);
      expect(offender).not.toContain(TOKEN);
    }
  });

  it('sums every source and lists the worst offender first', () => {
    const result = scanForSecretLeaks(
      [
        { label: 'a', text: `${PASSWORD}\n` },
        { label: 'b', text: `${TOKEN} ${TOKEN} ${PASSWORD}\n` },
      ],
      TOKEN,
      PASSWORD,
    );
    expect(result.tokenHits).toBe(2);
    expect(result.passwordHits).toBe(2);
    expect(result.offenders[0]).toBe('b (token hits=2, password hits=1)');
    expect(result.offenders[1]).toBe('a (token hits=0, password hits=1)');
  });
});
