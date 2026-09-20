import { describe, expect, it } from 'vitest';

import {
  buildGeneratedClusterFiles,
  CAVES_LEVELDATAOVERRIDE_LUA,
  CLUSTER_PASSWORD_PLACEHOLDER,
  generateCavesServerIni,
  generateClusterIni,
  MASTER_LEVELDATAOVERRIDE_LUA,
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

describe('level data overrides', () => {
  it('the Caves override has location = "cave" and all five fields', () => {
    expect(CAVES_LEVELDATAOVERRIDE_LUA).toContain('location = "cave"');
    for (const field of ['id', 'location', 'name', 'desc', 'overrides']) {
      expect(CAVES_LEVELDATAOVERRIDE_LUA).toContain(`${field} =`);
    }
  });

  it('the Master override has location = "forest" and all five fields', () => {
    expect(MASTER_LEVELDATAOVERRIDE_LUA).toContain('location = "forest"');
    for (const field of ['id', 'location', 'name', 'desc', 'overrides']) {
      expect(MASTER_LEVELDATAOVERRIDE_LUA).toContain(`${field} =`);
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
      expect.arrayContaining(['Caves/server.ini', 'Caves/leveldataoverride.lua']),
    );
  });
});
