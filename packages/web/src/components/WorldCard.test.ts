import { describe, expect, it } from 'vitest';
import type { ActiveInfo, WorldSummary } from '@dst/shared';
import { actionButtonColor, actionButtonLabel, derivedWorldStatus } from './WorldCard';

const worldA: WorldSummary = { worldId: 'test-a', displayName: 'A', status: 'stopped' };
const worldB: WorldSummary = { worldId: 'test-b', displayName: 'B', status: 'stopped' };

function activeInfo(status: ActiveInfo['status']): ActiveInfo {
  return {
    worldId: 'test-a',
    status,
    stale: false,
    startedBy: null,
    startedAt: null,
    playerCount: null,
    idleDeadline: null,
    join: null,
  };
}

describe('derivedWorldStatus', () => {
  it('is stopped when there is no active world', () => {
    expect(derivedWorldStatus(worldA, null)).toBe('stopped');
  });

  it('is stopped for a world that is not the active one', () => {
    expect(derivedWorldStatus(worldB, activeInfo('running'))).toBe('stopped');
  });

  it("mirrors the active world's status", () => {
    expect(derivedWorldStatus(worldA, activeInfo('running'))).toBe('running');
    expect(derivedWorldStatus(worldA, activeInfo('starting'))).toBe('starting');
    expect(derivedWorldStatus(worldA, activeInfo('stopping'))).toBe('stopping');
  });
});

describe('actionButtonLabel / actionButtonColor', () => {
  it('shows Start (green) when stopped or starting', () => {
    expect(actionButtonLabel('stopped')).toBe('Start');
    expect(actionButtonColor('stopped')).toBe('green');
    expect(actionButtonLabel('starting')).toBe('Start');
    expect(actionButtonColor('starting')).toBe('green');
  });

  it('shows Stop (red) when running or stopping', () => {
    expect(actionButtonLabel('running')).toBe('Stop');
    expect(actionButtonColor('running')).toBe('red');
    expect(actionButtonLabel('stopping')).toBe('Stop');
    expect(actionButtonColor('stopping')).toBe('red');
  });
});
