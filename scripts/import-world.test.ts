import { describe, expect, it } from 'vitest';

import { assertSeedNotPresent, parseArgs, USAGE } from './import-world';

describe('import-world parseArgs', () => {
  it('returns { help: true } when --help is present, before anything else is validated', () => {
    expect(parseArgs(['--help'])).toEqual({ help: true });
    // Even with otherwise-invalid arguments, --help still short-circuits.
    expect(parseArgs(['--world-id', 'Not Valid', '--help'])).toEqual({ help: true });
  });

  it('prints every documented flag in USAGE', () => {
    for (const flag of [
      '--world-id',
      '--zip',
      '--display-name',
      '--server-name',
      '--no-caves',
      '--idle-minutes',
      '--source',
      '--world-only',
      '--force',
      '--help',
    ]) {
      expect(USAGE).toContain(flag);
    }
  });

  it('requires --world-id', () => {
    expect(() => parseArgs(['--display-name', 'x', '--server-name', 'x'])).toThrow(
      /--world-id is required/,
    );
  });

  it('rejects a world id that does not match WORLD_ID_RE', () => {
    expect(() =>
      parseArgs(['--world-id', 'Not Valid!', '--display-name', 'x', '--server-name', 'x']),
    ).toThrow(/--world-id must match/);
  });

  it('refuses a test- id without --source test', () => {
    expect(() =>
      parseArgs(['--world-id', 'test-x', '--display-name', 'x', '--server-name', 'x']),
    ).toThrow(/--source test/);
  });

  it('accepts a test- id when --source test is given', () => {
    const parsed = parseArgs([
      '--world-id',
      'test-x',
      '--display-name',
      'x',
      '--server-name',
      'x',
      '--source',
      'test',
    ]);
    expect(parsed).toMatchObject({ help: false, worldId: 'test-x', source: 'test' });
  });

  it('requires --display-name and --server-name when --zip is absent', () => {
    expect(() => parseArgs(['--world-id', 'tylerni2026'])).toThrow(
      /--display-name and --server-name are required/,
    );
  });

  it('does not require --display-name/--server-name when --zip is given', () => {
    const parsed = parseArgs(['--world-id', 'tylerni2026', '--zip', '/tmp/x.zip']);
    expect(parsed).toMatchObject({ help: false, zip: '/tmp/x.zip', displayName: null });
  });

  it('requires --zip with --world-only', () => {
    expect(() => parseArgs(['--world-id', 'tylerni2026', '--world-only'])).toThrow(
      /--world-only requires --zip/,
    );
  });

  it('rejects a non-integer or non-positive --idle-minutes', () => {
    expect(() =>
      parseArgs([
        '--world-id',
        'x',
        '--display-name',
        'x',
        '--server-name',
        'x',
        '--idle-minutes',
        '0',
      ]),
    ).toThrow(/--idle-minutes/);
    expect(() =>
      parseArgs([
        '--world-id',
        'x',
        '--display-name',
        'x',
        '--server-name',
        'x',
        '--idle-minutes',
        'nope',
      ]),
    ).toThrow(/--idle-minutes/);
  });

  it('rejects an invalid --source value', () => {
    expect(() =>
      parseArgs([
        '--world-id',
        'x',
        '--display-name',
        'x',
        '--server-name',
        'x',
        '--source',
        'bogus',
      ]),
    ).toThrow(/--source must be one of/);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--world-id', 'x', '--wat'])).toThrow(/unknown argument/);
  });

  it('defaults idleMinutes, source, noCaves, worldOnly and force', () => {
    const parsed = parseArgs(['--world-id', 'x', '--display-name', 'x', '--server-name', 'x']);
    expect(parsed).toMatchObject({
      help: false,
      idleMinutes: 30,
      source: 'import',
      noCaves: false,
      worldOnly: false,
      force: false,
    });
  });
});

describe('assertSeedNotPresent', () => {
  it('refuses to overwrite seed/', () => {
    expect(() =>
      assertSeedNotPresent(['seed/tylerni2026/dst-tylerni2026.zip'], 'tylerni2026'),
    ).toThrow(/refuses to overwrite seed\/tylerni2026\//);
  });

  it('allows the upload when seed/<id>/ is empty', () => {
    expect(() => assertSeedNotPresent([], 'tylerni2026')).not.toThrow();
    expect(() =>
      assertSeedNotPresent(['seed/some-other-world/dst.zip'], 'tylerni2026'),
    ).not.toThrow();
  });
});
