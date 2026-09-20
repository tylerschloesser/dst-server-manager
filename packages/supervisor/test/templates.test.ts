import { describe, expect, it } from 'vitest';

import {
  buildGeneratedClusterFiles,
  CAVES_WORLDGENOVERRIDE_LUA,
  CLUSTER_PASSWORD_PLACEHOLDER,
  generateCavesServerIni,
  generateClusterIni,
  MASTER_WORLDGENOVERRIDE_LUA,
  MASTER_SERVER_INI,
} from '../src/core/templates';

describe('generateClusterIni', () => {
  it('never writes a real password value, only the SSM-injected placeholder', () => {
    const ini = generateClusterIni({
      serverName: 'My World',
      hasCaves: true,
      clusterKey: 'a'.repeat(32),
    });
    expect(ini).toContain(CLUSTER_PASSWORD_PLACEHOLDER);
  });

  it('interpolates serverName, hasCaves and the cluster key', () => {
    const ini = generateClusterIni({
      serverName: 'My World',
      hasCaves: false,
      clusterKey: 'deadbeef',
    });
    expect(ini).toContain('cluster_name = My World');
    expect(ini).toContain('shard_enabled = false');
    expect(ini).toContain('cluster_key = deadbeef');
  });
});

describe('generateCavesServerIni', () => {
  it('pins the given Caves shard id', () => {
    expect(generateCavesServerIni(2)).toContain('id = 2');
  });
});

describe('world gen overrides', () => {
  // Measured on the first real boot (docs/_first-boot-notes.md round 1): a hand-written
  // `leveldataoverride.lua` must be a COMPLETE level definition and worldgen rejects a partial
  // one ("Must specify the task set for a level!", then "Must specify a layout mode for your
  // level."). A generated cluster therefore names a preset in `worldgenoverride.lua` instead.
  it('each shard names its stock preset and enables the override', () => {
    expect(MASTER_WORLDGENOVERRIDE_LUA).toContain('override_enabled = true');
    expect(MASTER_WORLDGENOVERRIDE_LUA).toContain('preset = "SURVIVAL_TOGETHER"');
    expect(CAVES_WORLDGENOVERRIDE_LUA).toContain('override_enabled = true');
    expect(CAVES_WORLDGENOVERRIDE_LUA).toContain('preset = "DST_CAVE"');
  });

  it('neither override is a partial level definition', () => {
    for (const lua of [MASTER_WORLDGENOVERRIDE_LUA, CAVES_WORLDGENOVERRIDE_LUA]) {
      expect(lua).not.toContain('location =');
      expect(lua).not.toContain('task_set');
    }
  });
});

describe('buildGeneratedClusterFiles', () => {
  it('a generated cluster has no save/ directory', () => {
    const files = buildGeneratedClusterFiles({
      serverName: 'World',
      hasCaves: true,
      clusterKey: 'a'.repeat(32),
    });
    for (const file of files) {
      expect(file.path).not.toMatch(/(^|\/)save(\/|$)/);
      expect(file.content).not.toMatch(/(^|\/)save(\/|$)/);
    }
  });

  it('includes Master/server.ini verbatim', () => {
    const files = buildGeneratedClusterFiles({
      serverName: 'World',
      hasCaves: false,
      clusterKey: 'x',
    });
    const master = files.find((f) => f.path === 'Master/server.ini');
    expect(master?.content).toBe(MASTER_SERVER_INI);
  });

  it('hasCaves=false never generates a Caves/ file', () => {
    const files = buildGeneratedClusterFiles({
      serverName: 'World',
      hasCaves: false,
      clusterKey: 'x',
    });
    expect(files.some((f) => f.path.startsWith('Caves/'))).toBe(false);
  });

  it('hasCaves=true generates both Caves files', () => {
    const files = buildGeneratedClusterFiles({
      serverName: 'World',
      hasCaves: true,
      clusterKey: 'a'.repeat(32),
    });
    expect(files.map((f) => f.path)).toEqual(
      expect.arrayContaining(['Caves/server.ini', 'Caves/worldgenoverride.lua']),
    );
  });
});
