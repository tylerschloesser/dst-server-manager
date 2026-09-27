import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MODELS, PROMPT_VARIANTS } from '@dst/recap';

import {
  MANIFEST,
  afterSaveSpec,
  beforeSaveSpec,
  scenarioLogs,
} from '../packages/recap/src/test-support/scenario';
import { saveTarZst } from '../packages/recap/src/test-support/synthetic';
import { USAGE, parseArgs } from './digest-session';

const SCRIPT = fileURLToPath(new URL('./digest-session.ts', import.meta.url));
const S = MANIFEST.sessionId!;

describe('digest-session parseArgs', () => {
  it('--help / -h short-circuit before anything is validated', () => {
    expect(parseArgs(['--help'])).toEqual({ help: true });
    expect(parseArgs(['-h'])).toEqual({ help: true });
    expect(parseArgs(['--world-id', 'Not Valid!', '--bogus', '--help'])).toEqual({ help: true });
  });

  it('USAGE lists every flag, every variant and every model', () => {
    for (const flag of [
      '--world-id',
      '--session-id',
      '--from-dir',
      '--summary',
      '--variant',
      '--model',
      '--out',
      '--help',
    ]) {
      expect(USAGE).toContain(flag);
    }
    for (const v of Object.keys(PROMPT_VARIANTS)) expect(USAGE).toContain(v);
    for (const m of Object.keys(MODELS)) expect(USAGE).toContain(m);
  });

  it('requires a valid --world-id and --session-id', () => {
    expect(() => parseArgs(['--session-id', S])).toThrow(/--world-id is required/);
    expect(() => parseArgs(['--world-id', 'Bad_Id', '--session-id', S])).toThrow(/--world-id/);
    expect(() => parseArgs(['--world-id', 'test-a'])).toThrow(/--session-id is required/);
    expect(() => parseArgs(['--world-id', 'test-a', '--session-id', '../x'])).toThrow(
      /--session-id is required/,
    );
  });

  it('refuses unknown flags, missing values, unknown variants and models', () => {
    const ok = ['--world-id', 'test-a', '--session-id', S];
    expect(() => parseArgs([...ok, '--nope'])).toThrow(/unknown argument --nope/);
    expect(() => parseArgs(['--world-id', '--session-id', S])).toThrow(
      /--world-id requires a value/,
    );
    expect(() => parseArgs([...ok, '--out'])).toThrow(/--out requires a value/);
    expect(() => parseArgs([...ok, '--variant', 'nope'])).toThrow(/unknown --variant nope/);
    expect(() => parseArgs([...ok, '--model', 'nope'])).toThrow(/unknown --model nope/);
  });

  it('parses every flag', () => {
    expect(
      parseArgs([
        '--world-id',
        'test-a',
        '--session-id',
        S,
        '--from-dir',
        '/tmp/mirror',
        '--summary',
        '--variant',
        'prose',
        '--model',
        'claude-haiku-4-5',
        '--out',
        '/tmp/out',
      ]),
    ).toEqual({
      help: false,
      worldId: 'test-a',
      sessionId: S,
      fromDir: '/tmp/mirror',
      summary: true,
      variant: 'prose',
      model: 'claude-haiku-4-5',
      out: '/tmp/out',
    });
    expect(parseArgs(['--world-id', 'test-a', '--session-id', S])).toMatchObject({
      fromDir: null,
      summary: false,
      variant: null,
      model: null,
      out: null,
    });
  });
});

// The script end to end, offline, on a synthetic local mirror (no AWS, no API key).
describe('digest-session CLI (--from-dir)', () => {
  let dir: string;
  const W = 'test-recap';
  const run = (args: string[]) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env['ANTHROPIC_API_KEY'];
    delete env['AWS_PROFILE'];
    return spawnSync(process.execPath, ['--import', 'tsx', SCRIPT, ...args], {
      encoding: 'utf8',
      env,
      timeout: 60_000,
    });
  };

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'recap-digest-session-'));
    const s = path.join(dir, 'sessions', W, S);
    await mkdir(path.join(s, 'master'), { recursive: true });
    await mkdir(path.join(s, 'caves'), { recursive: true });
    await mkdir(path.join(dir, 'worlds', W), { recursive: true });
    const logs = scenarioLogs();
    await writeFile(path.join(s, 'manifest.json'), JSON.stringify(MANIFEST));
    await writeFile(path.join(s, 'master/server_chat_log.txt'), logs.masterChat!);
    await writeFile(path.join(s, 'caves/server_chat_log.txt'), logs.cavesChat!);
    await writeFile(path.join(s, 'master/server_log.txt'), logs.masterServer!);
    await writeFile(path.join(s, 'caves/server_log.txt'), logs.cavesServer!);
    await writeFile(path.join(dir, 'worlds', W, 'vPRE.tar.zst'), saveTarZst(beforeSaveSpec()));
    await writeFile(path.join(dir, 'worlds', W, 'vPOST.tar.zst'), saveTarZst(afterSaveSpec()));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('--help prints USAGE and exits 0 without touching anything', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(USAGE);
  });

  it('without --from-dir and without AWS_PROFILE=admin it refuses (exit 2)', () => {
    const r = run(['--world-id', W, '--session-id', S]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/REFUSED/);
  });

  it('prints recap.json and writes every digest file with --out', async () => {
    const out = path.join(dir, 'out');
    const r = run(['--from-dir', dir, '--world-id', W, '--session-id', S, '--out', out]);
    expect(r.stderr).not.toMatch(/digest-session: /);
    expect(r.status).toBe(0);
    const recap = JSON.parse(r.stdout) as { sessionId: string; status: string; players: unknown[] };
    expect(recap.sessionId).toBe(S);
    expect(recap.status).toBe('ok');
    expect(recap.players).toHaveLength(3);
    expect(r.stdout).not.toContain('KU_');
    const d = path.join(out, 'sessions', W, S, 'digest');
    expect((await readdir(d)).sort()).toEqual([
      'players.json',
      'recap.json',
      'summary.json',
      'trail',
    ]);
    const meta = JSON.parse(await readFile(path.join(d, 'summary.json'), 'utf8')) as {
      reason: string;
    };
    expect(meta.reason).toBe('disabled');
  });

  it('--summary without ANTHROPIC_API_KEY still prints the recap, summary unavailable', () => {
    const r = run(['--from-dir', dir, '--world-id', W, '--session-id', S, '--summary']);
    expect(r.status).toBe(0);
    const body = JSON.parse(r.stdout) as {
      recap: unknown;
      summary: string | null;
      summaryMeta: { status: string; reason: string };
    };
    expect(body.summary).toBeNull();
    expect(body.summaryMeta).toMatchObject({ status: 'unavailable', reason: 'no_api_key' });
  });

  it('a session with no manifest fails with exit 1', () => {
    const r = run(['--from-dir', dir, '--world-id', W, '--session-id', 'nope']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no manifest\.json/);
  });
});
