import { describe, expect, it } from 'vitest';
import type { ActiveInfo } from '@dst/shared';
import { decideWorldAction } from './WorldListScreen';

function activeInfo(worldId: string, status: ActiveInfo['status']): ActiveInfo {
  return {
    worldId,
    status,
    stale: false,
    startedBy: null,
    startedAt: null,
    playerCount: null,
    idleDeadline: null,
    join: null,
  };
}

describe('decideWorldAction', () => {
  it('starts directly when everything is stopped', () => {
    expect(decideWorldAction('stopped', null)).toBe('start');
    expect(decideWorldAction('stopped', activeInfo('test-a', 'stopped'))).toBe('start');
  });

  it('asks to switch when starting a different, non-stopped world', () => {
    expect(decideWorldAction('stopped', activeInfo('test-a', 'running'))).toBe('switch');
    expect(decideWorldAction('stopped', activeInfo('test-a', 'starting'))).toBe('switch');
    expect(decideWorldAction('stopped', activeInfo('test-a', 'stopping'))).toBe('switch');
  });

  it('confirms before stopping the running active world', () => {
    expect(decideWorldAction('running', activeInfo('test-a', 'running'))).toBe('stop');
  });

  it('does nothing while starting or stopping (the button is disabled)', () => {
    expect(decideWorldAction('starting', activeInfo('test-a', 'starting'))).toBeNull();
    expect(decideWorldAction('stopping', activeInfo('test-a', 'stopping'))).toBeNull();
  });
});
