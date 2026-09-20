import { describe, expect, it } from 'vitest';

import { TABLE_NAME } from './constants';
import {
  r1MaxAgeGraceful,
  r2PostTerminate,
  r3Reconcile,
  s1Claim,
  s2Joinable,
  s3Heartbeat,
  s4StopBegins,
  s5Switch,
  s6FinalStopped,
  s7ErrorNote,
  w1StartFresh,
  w2SetDesired,
  w3ClearDesired,
  w4RollbackLaunch,
} from './state-expressions';

const NOW = new Date('2026-09-19T20:13:55.000Z');

describe('W1-W4 (API)', () => {
  it('w1StartFresh', () => {
    const cmd = w1StartFresh({
      worldId: 'tylerni2026',
      sessionId: '20260919T201355Z-a1b2c3',
      steamId64: '76561197960265729',
      nickname: 'Tyler',
      now: NOW,
    });
    expect(cmd.TableName).toBe(TABLE_NAME);
    expect(cmd.Key).toEqual({ pk: 'STATE', sk: 'CLUSTER' });
    expect(cmd.ConditionExpression).toBe('attribute_not_exists(pk) OR #s = :stopped');
    expect(cmd.ExpressionAttributeNames).toEqual({ '#s': 'status' });
    expect(cmd.UpdateExpression).toContain('#s = :starting');
    expect(cmd.ExpressionAttributeValues).toEqual({
      ':starting': 'starting',
      ':stopped': 'stopped',
      ':w': 'tylerni2026',
      ':u': '76561197960265729',
      ':nick': 'Tyler',
      ':now': NOW.toISOString(),
      ':sid': '20260919T201355Z-a1b2c3',
      ':null': null,
    });
  });

  it('w2SetDesired', () => {
    const cmd = w2SetDesired({
      worldId: 'world-b',
      steamId64: '76561197960265729',
      nickname: 'Tyler',
      expectedStatus: 'running',
      expectedSessionId: '20260919T201355Z-a1b2c3',
      now: NOW,
    });
    expect(cmd.UpdateExpression).toBe(
      'SET desiredWorldId = :w, desiredBy = :u, desiredByNickname = :nick, desiredAt = :now',
    );
    expect(cmd.ConditionExpression).toBe(
      'attribute_exists(pk) AND #s = :expectedStatus AND sessionId = :expectedSessionId',
    );
    expect(cmd.ExpressionAttributeNames).toEqual({ '#s': 'status' });
  });

  it('w3ClearDesired', () => {
    const cmd = w3ClearDesired({
      worldId: 'world-a',
      steamId64: '76561197960265729',
      nickname: 'Tyler',
      now: NOW,
    });
    expect(cmd.UpdateExpression).toBe(
      'SET desiredWorldId = :null, desiredBy = :u, desiredByNickname = :nick, desiredAt = :now',
    );
    expect(cmd.ConditionExpression).toBe(
      'attribute_exists(pk) AND worldId = :w AND #s <> :stopped',
    );
  });

  it('w4RollbackLaunch', () => {
    const cmd = w4RollbackLaunch({
      sessionId: '20260919T201355Z-a1b2c3',
      error: 'InsufficientInstanceCapacity',
    });
    expect(cmd.UpdateExpression).toBe(
      'SET #s = :stopped, desiredWorldId = :null, sessionId = :null, instanceId = :null, ' +
        'publicIp = :null, lastStopReason = :launchFailed, lastError = :msg',
    );
    expect(cmd.ConditionExpression).toBe('sessionId = :sid AND #s = :starting');
    expect(cmd.ExpressionAttributeValues).toMatchObject({
      ':launchFailed': 'launch-failed',
      ':msg': 'InsufficientInstanceCapacity',
    });
  });
});

describe('S1-S7 (supervisor)', () => {
  it('s1Claim', () => {
    const cmd = s1Claim({
      sessionId: 'sid',
      instanceId: 'i-1',
      publicIp: '203.0.113.10',
      now: NOW,
    });
    expect(cmd.UpdateExpression).toBe('SET instanceId = :i, publicIp = :ip, heartbeatAt = :now');
    expect(cmd.ConditionExpression).toBe('sessionId = :sid AND #s = :starting');
  });

  it('s2Joinable', () => {
    const cmd = s2Joinable({
      sessionId: 'sid',
      instanceId: 'i-1',
      worldId: 'world-a',
      idleDeadline: NOW.toISOString(),
      now: NOW,
    });
    expect(cmd.ConditionExpression).toBe('sessionId = :sid AND instanceId = :i AND #s = :starting');
    expect(cmd.UpdateExpression).toContain('#s = :running');
    expect(cmd.ExpressionAttributeValues).toMatchObject({ ':zero': 0, ':null': null });
  });

  it('s3Heartbeat', () => {
    const cmd = s3Heartbeat({
      sessionId: 'sid',
      instanceId: 'i-1',
      playerCount: 2,
      idleDeadline: NOW.toISOString(),
      now: NOW,
    });
    expect(cmd.UpdateExpression).toBe(
      'SET playerCount = :pc, idleDeadline = :dl, heartbeatAt = :now',
    );
    expect(cmd.ConditionExpression).toBe('sessionId = :sid AND instanceId = :i');
    expect(cmd.ExpressionAttributeNames).toBeUndefined();
  });

  it('s4StopBegins never overwrites a reaper-* reason', () => {
    const cmd = s4StopBegins({ sessionId: 'sid', instanceId: 'i-1', reason: 'idle', now: NOW });
    expect(cmd.ConditionExpression).toBe(
      'sessionId = :sid AND instanceId = :i AND ' +
        '(attribute_type(lastStopReason, :nullType) OR NOT begins_with(lastStopReason, :reaperPrefix))',
    );
    expect(cmd.ExpressionAttributeValues).toMatchObject({
      ':nullType': 'NULL',
      ':reaperPrefix': 'reaper-',
    });
  });

  it('s5Switch', () => {
    const cmd = s5Switch({
      instanceId: 'i-1',
      oldSessionId: 'old-sid',
      newSessionId: 'new-sid',
      newWorldId: 'world-b',
      desiredBy: '76561197960265729',
      desiredByNickname: 'Tyler',
      now: NOW,
    });
    expect(cmd.ConditionExpression).toBe(
      'instanceId = :i AND sessionId = :oldSid AND desiredWorldId = :newW',
    );
    expect(cmd.ExpressionAttributeValues).toMatchObject({ ':switch': 'switch' });
    // instanceId is deliberately unchanged (docs/control-plane.md §2, S5).
    expect(cmd.UpdateExpression).not.toContain('instanceId =');
  });

  it('s6FinalStopped requires desiredWorldId to already be NULL', () => {
    const cmd = s6FinalStopped({ sessionId: 'sid', instanceId: 'i-1', reason: 'idle' });
    expect(cmd.ConditionExpression).toBe(
      'sessionId = :sid AND instanceId = :i AND attribute_type(desiredWorldId, :nullType)',
    );
    expect(cmd.ExpressionAttributeValues).toMatchObject({ ':nullType': 'NULL', ':reason': 'idle' });
    // worldId is retained, never nulled (decisions §16.10).
    expect(cmd.UpdateExpression).not.toContain('worldId =');
  });

  it('s7ErrorNote', () => {
    const cmd = s7ErrorNote({ sessionId: 'sid', instanceId: 'i-1', error: 'oops', now: NOW });
    expect(cmd.UpdateExpression).toBe('SET lastError = :e, heartbeatAt = :now');
    expect(cmd.ConditionExpression).toBe('sessionId = :sid AND instanceId = :i');
  });
});

describe('R1-R3 (reaper)', () => {
  it('r1MaxAgeGraceful writes reaper-max-age and does not terminate', () => {
    const cmd = r1MaxAgeGraceful({ sessionId: 'sid', instanceId: 'i-1', now: NOW });
    expect(cmd.ConditionExpression).toBe('sessionId = :sid AND instanceId = :i AND #s <> :stopped');
    expect(cmd.ExpressionAttributeValues).toMatchObject({ ':reaperMaxAge': 'reaper-max-age' });
    expect(cmd.UpdateExpression).not.toContain('#s = :stopped');
  });

  it('r2PostTerminate and r3Reconcile share the S6 shape, pinned only to sessionId', () => {
    const a = r2PostTerminate({
      sessionId: 'sid',
      reason: 'reaper-stale',
      error: 'no live instance',
    });
    const b = r3Reconcile({ sessionId: 'sid', reason: 'reaper-max-age', error: 'reconciled' });
    for (const cmd of [a, b]) {
      expect(cmd.ConditionExpression).toBe('sessionId = :sid');
      expect(cmd.UpdateExpression).toContain('desiredWorldId = :null');
      expect(cmd.UpdateExpression).toContain('lastError = :why');
    }
    expect(a.ExpressionAttributeValues).toMatchObject({
      ':reason': 'reaper-stale',
      ':why': 'no live instance',
    });
    expect(b.ExpressionAttributeValues).toMatchObject({
      ':reason': 'reaper-max-age',
      ':why': 'reconciled',
    });
  });
});

describe('#s aliasing', () => {
  it('every builder that reads or writes status aliases it as #s = status', () => {
    const withStatusRef = [
      w1StartFresh({ worldId: 'w', sessionId: 'sid', steamId64: 'u', nickname: 'n', now: NOW }),
      w2SetDesired({
        worldId: 'w',
        steamId64: 'u',
        nickname: 'n',
        expectedStatus: 'running',
        expectedSessionId: 'sid',
        now: NOW,
      }),
      w3ClearDesired({ worldId: 'w', steamId64: 'u', nickname: 'n', now: NOW }),
      w4RollbackLaunch({ sessionId: 'sid', error: 'e' }),
      s1Claim({ sessionId: 'sid', instanceId: 'i', publicIp: '1.2.3.4', now: NOW }),
      s2Joinable({
        sessionId: 'sid',
        instanceId: 'i',
        worldId: 'w',
        idleDeadline: NOW.toISOString(),
        now: NOW,
      }),
      s4StopBegins({ sessionId: 'sid', instanceId: 'i', reason: 'idle', now: NOW }),
      s5Switch({
        instanceId: 'i',
        oldSessionId: 'o',
        newSessionId: 'n',
        newWorldId: 'w',
        desiredBy: 'u',
        desiredByNickname: 'n',
        now: NOW,
      }),
      s6FinalStopped({ sessionId: 'sid', instanceId: 'i', reason: 'idle' }),
      r1MaxAgeGraceful({ sessionId: 'sid', instanceId: 'i', now: NOW }),
      r2PostTerminate({ sessionId: 'sid', reason: 'reaper-stale', error: 'e' }),
    ];
    for (const cmd of withStatusRef) {
      expect(cmd.ExpressionAttributeNames).toEqual({ '#s': 'status' });
    }
  });

  it('attribute_type(x, :nullType) uses the DynamoDB NULL type indicator', () => {
    for (const cmd of [
      s4StopBegins({ sessionId: 'sid', instanceId: 'i', reason: 'idle', now: NOW }),
      s6FinalStopped({ sessionId: 'sid', instanceId: 'i', reason: 'idle' }),
    ]) {
      expect(cmd.ExpressionAttributeValues).toMatchObject({ ':nullType': 'NULL' });
      expect(cmd.ConditionExpression).toContain('attribute_type(');
    }
  });
});
