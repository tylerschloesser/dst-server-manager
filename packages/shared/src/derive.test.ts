import { describe, expect, it } from 'vitest';

import { JOIN_HOSTNAME, STALE_HEARTBEAT_MS } from './constants';
import { deriveActive, deriveWorldsResponse, deriveWorldStatus, isStale } from './derive';
import type { ClusterStateItem, WorldRegistryItem } from './types';
import { initialClusterState } from './validate';

function world(overrides: Partial<WorldRegistryItem> = {}): WorldRegistryItem {
  return {
    pk: 'WORLD',
    sk: overrides.worldId ?? 'world-a',
    worldId: 'world-a',
    displayName: 'World A',
    serverName: 'World A Server',
    hasCaves: true,
    idleMinutes: 30,
    createdAt: '2026-01-01T00:00:00.000Z',
    source: 'import',
    ...overrides,
  };
}

function state(overrides: Partial<ClusterStateItem> = {}): ClusterStateItem {
  return { ...initialClusterState(), ...overrides };
}

describe('deriveWorldStatus', () => {
  it('is the cluster status for the active world', () => {
    const s = state({ status: 'running', worldId: 'world-a' });
    expect(deriveWorldStatus(world({ worldId: 'world-a' }), s)).toBe('running');
  });

  it('is stopped for every other world', () => {
    const s = state({ status: 'running', worldId: 'world-a' });
    expect(deriveWorldStatus(world({ worldId: 'world-b' }), s)).toBe('stopped');
  });

  it('is stopped for every world when the cluster is stopped', () => {
    const s = state({ status: 'stopped', worldId: 'world-a' });
    expect(deriveWorldStatus(world({ worldId: 'world-a' }), s)).toBe('stopped');
  });
});

describe('isStale', () => {
  it('is false while stopped, regardless of heartbeatAt', () => {
    const s = state({ status: 'stopped', heartbeatAt: new Date(0).toISOString() });
    expect(isStale(s, new Date())).toBe(false);
  });

  it('is false during boot, before the first heartbeat (boot-null)', () => {
    const s = state({ status: 'starting', heartbeatAt: null });
    expect(isStale(s, new Date())).toBe(false);
  });

  it('is false when the heartbeat is recent', () => {
    const now = new Date('2026-01-01T00:10:00.000Z');
    const s = state({
      status: 'running',
      heartbeatAt: new Date(now.getTime() - 1000).toISOString(),
    });
    expect(isStale(s, now)).toBe(false);
  });

  it('is true when the heartbeat is older than STALE_HEARTBEAT_MS', () => {
    const now = new Date('2026-01-01T00:10:00.000Z');
    const s = state({
      status: 'running',
      heartbeatAt: new Date(now.getTime() - STALE_HEARTBEAT_MS - 1).toISOString(),
    });
    expect(isStale(s, now)).toBe(true);
  });
});

describe('deriveActive', () => {
  it('is null when the cluster is stopped', () => {
    expect(
      deriveActive({ activeWorld: null, state: state(), now: new Date(), password: null }),
    ).toBeNull();
  });

  it('produces no join block until running with a public IP', () => {
    const s = state({ status: 'starting', worldId: 'world-a' });
    const active = deriveActive({
      activeWorld: world(),
      state: s,
      now: new Date(),
      password: 'secret',
    });
    expect(active?.join).toBeNull();
  });

  it('produces a join block with the exact connectCommand text once running with an IP', () => {
    const s = state({ status: 'running', worldId: 'world-a', publicIp: '203.0.113.10' });
    const active = deriveActive({
      activeWorld: world(),
      state: s,
      now: new Date(),
      password: 'sw0rdfish',
    });
    expect(active?.join).toEqual({
      serverName: 'World A Server',
      host: JOIN_HOSTNAME,
      ip: '203.0.113.10',
      port: 10999,
      password: 'sw0rdfish',
      connectCommand: 'c_connect("play.dst.ty.ler.dev", 10999, "sw0rdfish")',
    });
  });

  // The point of the runtime A record (docs/decisions.md §17): two sessions on two different
  // instances produce the *same* command, so a friend can save it once and reuse it forever.
  it('builds the same connectCommand for two sessions with different public IPs', () => {
    const command = (publicIp: string): string | undefined =>
      deriveActive({
        activeWorld: world(),
        state: state({ status: 'running', worldId: 'world-a', publicIp }),
        now: new Date(),
        password: 'sw0rdfish',
      })?.join?.connectCommand;

    expect(command('203.0.113.10')).toBe(command('198.51.100.7'));
    expect(command('203.0.113.10')).toContain(JOIN_HOSTNAME);
    expect(command('203.0.113.10')).not.toContain('203.0.113.10');
  });

  it('reports startedBy as the nickname, never the steamid64', () => {
    const s = state({
      status: 'running',
      worldId: 'world-a',
      startedBy: '76561197960265729',
      startedByNickname: 'Tyler',
    });
    const active = deriveActive({
      activeWorld: world(),
      state: s,
      now: new Date(),
      password: null,
    });
    expect(active?.startedBy).toBe('Tyler');
  });
});

describe('deriveWorldsResponse', () => {
  it('worlds[] items carry exactly worldId, displayName and status', () => {
    const s = state({ status: 'running', worldId: 'world-a' });
    const response = deriveWorldsResponse({
      worlds: [
        world({ worldId: 'world-a' }),
        world({ worldId: 'world-b', displayName: 'World B' }),
      ],
      activeWorld: world({ worldId: 'world-a' }),
      state: s,
      now: new Date(),
      password: 'sw0rdfish',
    });
    for (const w of response.worlds) {
      expect(Object.keys(w).sort()).toEqual(['displayName', 'status', 'worldId']);
    }
  });

  it('never leaks a 17-digit SteamID64 anywhere in the response', () => {
    const s = state({
      status: 'running',
      worldId: 'world-a',
      publicIp: '203.0.113.10',
      startedBy: '76561197960265729',
      startedByNickname: 'Tyler',
      desiredBy: '76561197960265729',
      desiredByNickname: 'Tyler',
    });
    const response = deriveWorldsResponse({
      worlds: [world({ worldId: 'world-a' })],
      activeWorld: world({ worldId: 'world-a' }),
      state: s,
      now: new Date(),
      password: 'sw0rdfish',
    });
    expect(JSON.stringify(response)).not.toMatch(/\d{17}/);
  });
});
