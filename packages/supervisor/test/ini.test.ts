import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  enforceCavesShardId,
  enforceClusterName,
  enforceClusterPassword,
  enforceConsoleEnabled,
  readIniKey,
  readPauseWhenEmpty,
  setIniKeyAnywhereOrInSection,
  setIniKeyInSection,
} from '../src/core/ini';

// decisions §16.35: nothing shaped like a real cluster.ini is ever committed. This fixture is
// generated at test time into a mktemp -d directory (deleted immediately after) purely to prove
// the pure ini.ts functions round-trip through a real file the same way tasks/ will use them.
const OLD_PASSWORD_VALUE = 'old-value'; // never a real secret; only reached via `${...}` below
const SAMPLE_CLUSTER_INI = [
  '; a hand-written cluster.ini',
  '[GAMEPLAY]',
  'game_mode = survival',
  'pause_when_empty = true',
  '',
  '[NETWORK]',
  'cluster_name = Old Name',
  `cluster_password = ${OLD_PASSWORD_VALUE}`,
  '',
  '[MISC]',
  '; comment kept as-is',
  'max_snapshots = 6',
].join('\n');

describe('setIniKeyInSection', () => {
  it('preserves comments and order when replacing an existing key', () => {
    const next = setIniKeyInSection(SAMPLE_CLUSTER_INI, 'NETWORK', 'cluster_name', 'New Name');
    const lines = next.split('\n');
    expect(lines).toContain('cluster_name = New Name');
    expect(lines).toContain('; a hand-written cluster.ini');
    expect(lines).toContain('; comment kept as-is');
    expect(lines.indexOf('[MISC]')).toBeGreaterThan(lines.indexOf('[NETWORK]'));
    expect(next).not.toContain('Old Name');
  });

  it('appends the key at the end of the section when absent', () => {
    const next = setIniKeyInSection(SAMPLE_CLUSTER_INI, 'GAMEPLAY', 'vote_kick_enabled', 'false');
    const lines = next.split('\n');
    const gameplayEnd = lines.indexOf('');
    expect(lines[gameplayEnd - 1]).toBe('vote_kick_enabled = false');
  });

  it('creates the section at the end of the file when it does not exist', () => {
    const next = setIniKeyInSection(SAMPLE_CLUSTER_INI, 'SHARD', 'shard_enabled', 'true');
    expect(next.trimEnd().split('\n').slice(-2)).toEqual(['[SHARD]', 'shard_enabled = true']);
  });

  it('round-trips through a real file written to a mktemp directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dst-ini-test-'));
    try {
      const file = join(dir, 'sample.ini');
      writeFileSync(file, SAMPLE_CLUSTER_INI);
      const written = setIniKeyInSection(
        readFileSync(file, 'utf8'),
        'MISC',
        'console_enabled',
        'true',
      );
      writeFileSync(file, written);
      expect(readFileSync(file, 'utf8')).toContain('console_enabled = true');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('readIniKey', () => {
  it('reads an existing value', () => {
    expect(readIniKey(SAMPLE_CLUSTER_INI, 'GAMEPLAY', 'game_mode')).toBe('survival');
  });

  it('returns null for a missing key or section', () => {
    expect(readIniKey(SAMPLE_CLUSTER_INI, 'GAMEPLAY', 'nope')).toBeNull();
    expect(readIniKey(SAMPLE_CLUSTER_INI, 'NOPE', 'nope')).toBeNull();
  });
});

describe('setIniKeyAnywhereOrInSection', () => {
  it('replaces the key in whichever section already holds it', () => {
    const password = 'p@ss-value';
    const next = setIniKeyAnywhereOrInSection(
      SAMPLE_CLUSTER_INI,
      'cluster_password',
      password,
      'NETWORK',
    );
    expect(next).toContain(`cluster_password = ${password}`);
    expect(next).not.toContain('old-value');
  });

  it('appends to the fallback section when the key is absent everywhere', () => {
    const withoutPassword = SAMPLE_CLUSTER_INI.split('\n')
      .filter((l) => !l.startsWith('cluster_password'))
      .join('\n');
    const password = 'brand-new-value';
    const next = setIniKeyAnywhereOrInSection(
      withoutPassword,
      'cluster_password',
      password,
      'NETWORK',
    );
    const lines = next.split('\n');
    const networkIdx = lines.indexOf('[NETWORK]');
    const miscIdx = lines.indexOf('[MISC]');
    const passwordIdx = lines.indexOf(`cluster_password = ${password}`);
    expect(passwordIdx).toBeGreaterThan(networkIdx);
    expect(passwordIdx).toBeLessThan(miscIdx);
  });
});

describe('enforce* helpers (docs/game-server.md §5 "Enforced every boot")', () => {
  it('enforceConsoleEnabled forces console_enabled to true', () => {
    const withFalse = setIniKeyInSection(SAMPLE_CLUSTER_INI, 'MISC', 'console_enabled', 'false');
    expect(enforceConsoleEnabled(withFalse)).toContain('console_enabled = true');
  });

  it('enforceClusterName sets [NETWORK] cluster_name', () => {
    expect(enforceClusterName(SAMPLE_CLUSTER_INI, 'Tylers World')).toContain(
      'cluster_name = Tylers World',
    );
  });

  it('enforceClusterPassword replaces wherever the key already lives', () => {
    const password = 'from-ssm-value';
    const next = enforceClusterPassword(SAMPLE_CLUSTER_INI, password);
    expect(next).toContain(`cluster_password = ${password}`);
  });

  it('enforceClusterPassword appends to [NETWORK] when the key is absent', () => {
    const withoutPassword = SAMPLE_CLUSTER_INI.split('\n')
      .filter((l) => !l.startsWith('cluster_password'))
      .join('\n');
    const password = 'from-ssm-value-2';
    const next = enforceClusterPassword(withoutPassword, password);
    const lines = next.split('\n');
    expect(lines.indexOf(`cluster_password = ${password}`)).toBeGreaterThan(
      lines.indexOf('[NETWORK]'),
    );
  });

  it('enforceCavesShardId pins the Caves [SHARD] id', () => {
    const cavesIni = '[SHARD]\nis_master = false\nname = Caves\nid = 999\n';
    expect(enforceCavesShardId(cavesIni, 2)).toContain('id = 2');
    expect(enforceCavesShardId(cavesIni, 2)).not.toContain('id = 999');
  });

  it('readPauseWhenEmpty reads true, reads false, and is null when absent', () => {
    expect(readPauseWhenEmpty(SAMPLE_CLUSTER_INI)).toBe(true);
    const falseIni = SAMPLE_CLUSTER_INI.replace(
      'pause_when_empty = true',
      'pause_when_empty = false',
    );
    expect(readPauseWhenEmpty(falseIni)).toBe(false);
    const withoutIt = SAMPLE_CLUSTER_INI.replace('pause_when_empty = true\n', '');
    expect(readPauseWhenEmpty(withoutIt)).toBeNull();
  });
});
