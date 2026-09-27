import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_MODEL, MODELS, PROMPT_VARIANTS } from '@dst/recap';

import { USAGE, parseArgs } from './recap-prompt-lab';

const SCRIPT = fileURLToPath(new URL('./recap-prompt-lab.ts', import.meta.url));
const REPO = path.resolve(path.dirname(SCRIPT), '..');
const OUT = path.join(os.tmpdir(), 'recap-lab-out');
const base = ['--data', '/tmp/mirror', '--world-id', 'test-a', '--out', OUT];

describe('recap-prompt-lab parseArgs', () => {
  it('--help / -h short-circuit before anything is validated', () => {
    expect(parseArgs(['--help'])).toEqual({ help: true });
    expect(parseArgs(['-h'])).toEqual({ help: true });
    expect(parseArgs(['--out', REPO, '--help'])).toEqual({ help: true });
  });

  it('USAGE lists every flag, every variant and every model', () => {
    for (const flag of [
      '--data',
      '--world-id',
      '--out',
      '--sessions',
      '--variants',
      '--models',
      '--chain',
      '--help',
    ]) {
      expect(USAGE).toContain(flag);
    }
    for (const v of Object.keys(PROMPT_VARIANTS)) expect(USAGE).toContain(v);
    for (const m of Object.keys(MODELS)) expect(USAGE).toContain(m);
  });

  it('requires --data, a valid --world-id and --out', () => {
    expect(() => parseArgs(['--world-id', 'test-a', '--out', OUT])).toThrow(/--data is required/);
    expect(() => parseArgs(['--data', 'd', '--out', OUT])).toThrow(/--world-id is required/);
    expect(() => parseArgs(['--data', 'd', '--world-id', 'Bad_Id', '--out', OUT])).toThrow(
      /--world-id is required/,
    );
    expect(() => parseArgs(['--data', 'd', '--world-id', 'test-a'])).toThrow(/--out is required/);
  });

  it('refuses an --out inside the repository (real-session summaries are never committed)', () => {
    for (const out of [
      REPO,
      path.join(REPO, 'lab-out'),
      path.join(REPO, 'packages', 'recap', 'x'),
      path.relative(process.cwd(), path.join(REPO, 'scripts')) || '.',
    ]) {
      expect(() => parseArgs([...base.slice(0, 4), '--out', out]), out).toThrow(
        /--out must be outside the repository/,
      );
    }
    // a sibling directory whose name merely starts with the repo's name is outside
    expect(parseArgs([...base.slice(0, 4), '--out', `${REPO}-lab`])).toMatchObject({
      out: `${REPO}-lab`,
    });
  });

  it('defaults: all sessions, all variants, the default model, no chain', () => {
    expect(parseArgs(base)).toEqual({
      help: false,
      data: '/tmp/mirror',
      worldId: 'test-a',
      out: OUT,
      sessions: 'all',
      variants: Object.keys(PROMPT_VARIANTS),
      models: [DEFAULT_MODEL],
      chain: false,
    });
  });

  it('parses lists and --chain, and refuses unknown variants, models and flags', () => {
    expect(
      parseArgs([
        ...base,
        '--sessions',
        'last:2',
        '--variants',
        'bullets,prose',
        '--models',
        'claude-haiku-4-5,claude-sonnet-5',
        '--chain',
      ]),
    ).toMatchObject({
      sessions: 'last:2',
      variants: ['bullets', 'prose'],
      models: ['claude-haiku-4-5', 'claude-sonnet-5'],
      chain: true,
    });
    expect(() => parseArgs([...base, '--variants', 'bullets,nope'])).toThrow(
      /unknown variant nope/,
    );
    expect(() => parseArgs([...base, '--models', 'nope'])).toThrow(/unknown model nope/);
    expect(() => parseArgs([...base, '--bogus'])).toThrow(/unknown argument --bogus/);
    expect(() => parseArgs([...base, '--sessions'])).toThrow(/--sessions requires a value/);
  });
});

describe('recap-prompt-lab CLI', () => {
  it('--help prints USAGE and exits 0 with no API key and no network', () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env['ANTHROPIC_API_KEY'];
    const r = spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, '--help'], {
      encoding: 'utf8',
      env,
      timeout: 60_000,
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(USAGE);
  });
});
