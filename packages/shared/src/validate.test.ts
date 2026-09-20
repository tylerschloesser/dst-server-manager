import { describe, expect, it } from 'vitest';

import {
  InvalidItemError,
  initialClusterState,
  parseClusterState,
  parseWorldItem,
} from './validate';

describe('parseClusterState', () => {
  it('treats an absent item as stopped', () => {
    expect(parseClusterState(undefined)).toEqual(initialClusterState());
  });

  it('throws on a bad status', () => {
    expect(() => parseClusterState({ status: 'paused' })).toThrow(InvalidItemError);
  });

  it('throws on a bad worldId', () => {
    expect(() => parseClusterState({ status: 'running', worldId: 'Not Valid' })).toThrow(
      InvalidItemError,
    );
  });

  it('throws on a negative playerCount', () => {
    expect(() => parseClusterState({ status: 'running', playerCount: -1 })).toThrow(
      InvalidItemError,
    );
  });

  it('throws on an unparseable timestamp', () => {
    expect(() => parseClusterState({ status: 'running', heartbeatAt: 'not-a-date' })).toThrow(
      InvalidItemError,
    );
  });

  it('reads a missing nullable attribute as null', () => {
    const state = parseClusterState({ status: 'stopped' });
    expect(state.worldId).toBeNull();
    expect(state.desiredWorldId).toBeNull();
    expect(state.lastStopReason).toBeNull();
    expect(state.playerCount).toBeNull();
  });

  it('round-trips a fully populated item', () => {
    const raw = {
      status: 'running',
      worldId: 'tylerni2026',
      desiredWorldId: 'tylerni2026',
      desiredBy: '76561197960265729',
      desiredByNickname: 'Tyler',
      desiredAt: '2026-09-19T20:00:00.000Z',
      sessionId: '20260919T201355Z-a1b2c3',
      startedBy: '76561197960265729',
      startedByNickname: 'Tyler',
      startedAt: '2026-09-19T20:01:00.000Z',
      instanceId: 'i-0123456789abcdef0',
      publicIp: '203.0.113.10',
      joinableAt: '2026-09-19T20:05:00.000Z',
      playerCount: 2,
      idleDeadline: '2026-09-19T20:35:00.000Z',
      heartbeatAt: '2026-09-19T20:10:00.000Z',
      lastStopReason: null,
      lastError: null,
    };
    expect(parseClusterState(raw)).toEqual({ pk: 'STATE', sk: 'CLUSTER', ...raw });
  });
});

describe('parseWorldItem', () => {
  const valid = {
    worldId: 'tylerni2026',
    displayName: "Tyler's World",
    serverName: 'DST Server',
    hasCaves: true,
    idleMinutes: 30,
    createdAt: '2026-09-19T00:00:00.000Z',
    source: 'import',
  };

  it('parses a valid item', () => {
    expect(parseWorldItem(valid)).toEqual({ pk: 'WORLD', sk: 'tylerni2026', ...valid });
  });

  it('throws on an invalid worldId', () => {
    expect(() => parseWorldItem({ ...valid, worldId: 'Bad Id' })).toThrow(InvalidItemError);
  });

  it('throws on a non-boolean hasCaves', () => {
    expect(() => parseWorldItem({ ...valid, hasCaves: 'yes' })).toThrow(InvalidItemError);
  });

  it('throws on idleMinutes < 1', () => {
    expect(() => parseWorldItem({ ...valid, idleMinutes: 0 })).toThrow(InvalidItemError);
  });

  it('throws on an unparseable createdAt', () => {
    expect(() => parseWorldItem({ ...valid, createdAt: 'not-a-date' })).toThrow(InvalidItemError);
  });

  it('throws on an invalid source', () => {
    expect(() => parseWorldItem({ ...valid, source: 'nonsense' })).toThrow(InvalidItemError);
  });
});
