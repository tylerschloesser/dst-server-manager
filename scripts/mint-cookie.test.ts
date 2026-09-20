import { describe, expect, it } from 'vitest';

import { parseArgs, USAGE } from './mint-cookie';

describe('mint-cookie parseArgs', () => {
  it('returns { help: true } for --help', () => {
    expect(parseArgs(['--help'])).toEqual({ help: true });
    expect(parseArgs(['-h'])).toEqual({ help: true });
  });

  it('prints --steam-id and --help in USAGE', () => {
    expect(USAGE).toContain('--steam-id');
    expect(USAGE).toContain('--help');
  });

  it('defaults steamId to null when --steam-id is absent', () => {
    expect(parseArgs([])).toEqual({ help: false, steamId: null });
  });

  it('captures an explicit --steam-id (an obviously-fake test id)', () => {
    expect(parseArgs(['--steam-id', '76561190000000001'])).toEqual({
      help: false,
      steamId: '76561190000000001',
    });
  });

  it('requires a value for --steam-id', () => {
    expect(() => parseArgs(['--steam-id'])).toThrow(/--steam-id requires a value/);
    expect(() => parseArgs(['--steam-id', '--wat'])).toThrow(/--steam-id requires a value/);
  });

  it('rejects an unknown flag', () => {
    expect(() => parseArgs(['--wat'])).toThrow(/unknown argument/);
  });
});
