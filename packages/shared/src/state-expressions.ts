// @dst/shared: every DynamoDB write in the system, as pure builders (docs/control-plane.md §2).
// Each function returns a plain UpdateCommandInput — never a client — so the API, the reaper, the
// supervisor and the tests all share one definition of every write. The @aws-sdk/lib-dynamodb
// import is type-only; this module makes no AWS call.
import type { UpdateCommandInput } from '@aws-sdk/lib-dynamodb';

import { TABLE_NAME } from './constants';
import type { ClusterStatus, StopReason } from './types';

const KEY = { pk: 'STATE', sk: 'CLUSTER' } as const;
const STATUS_NAME = { '#s': 'status' };

function iso(now: Date): string {
  return now.toISOString();
}

// ---------------------------------------------------------------------------------------------
// W1-W4 — API (docs/control-plane.md §2)
// ---------------------------------------------------------------------------------------------

export interface W1StartFreshInput {
  worldId: string;
  sessionId: string;
  steamId64: string;
  nickname: string;
  now: Date;
}

/** W1 — start world W from `stopped` (a missing item counts as `stopped`). */
export function w1StartFresh(input: W1StartFreshInput): UpdateCommandInput {
  return {
    TableName: TABLE_NAME,
    Key: KEY,
    UpdateExpression:
      'SET #s = :starting, worldId = :w, desiredWorldId = :w, desiredBy = :u, ' +
      'desiredByNickname = :nick, desiredAt = :now, sessionId = :sid, startedBy = :u, ' +
      'startedByNickname = :nick, startedAt = :now, instanceId = :null, publicIp = :null, ' +
      'joinableAt = :null, playerCount = :null, idleDeadline = :null, heartbeatAt = :null, ' +
      'lastStopReason = :null, lastError = :null',
    ConditionExpression: 'attribute_not_exists(pk) OR #s = :stopped',
    ExpressionAttributeNames: STATUS_NAME,
    ExpressionAttributeValues: {
      ':starting': 'starting',
      ':stopped': 'stopped',
      ':w': input.worldId,
      ':u': input.steamId64,
      ':nick': input.nickname,
      ':now': iso(input.now),
      ':sid': input.sessionId,
      ':null': null,
    },
  };
}

export interface W2SetDesiredInput {
  worldId: string;
  steamId64: string;
  nickname: string;
  expectedStatus: ClusterStatus;
  expectedSessionId: string;
  now: Date;
}

/** W2 — start (or re-assert) world W while something is already active, or a stop is racing it. */
export function w2SetDesired(input: W2SetDesiredInput): UpdateCommandInput {
  return {
    TableName: TABLE_NAME,
    Key: KEY,
    UpdateExpression:
      'SET desiredWorldId = :w, desiredBy = :u, desiredByNickname = :nick, desiredAt = :now',
    ConditionExpression:
      'attribute_exists(pk) AND #s = :expectedStatus AND sessionId = :expectedSessionId',
    ExpressionAttributeNames: STATUS_NAME,
    ExpressionAttributeValues: {
      ':w': input.worldId,
      ':u': input.steamId64,
      ':nick': input.nickname,
      ':now': iso(input.now),
      ':expectedStatus': input.expectedStatus,
      ':expectedSessionId': input.expectedSessionId,
    },
  };
}

export interface W3ClearDesiredInput {
  worldId: string;
  steamId64: string;
  nickname: string;
  now: Date;
}

/** W3 — stop world W: null the desire only (W must be the active `worldId`). */
export function w3ClearDesired(input: W3ClearDesiredInput): UpdateCommandInput {
  return {
    TableName: TABLE_NAME,
    Key: KEY,
    UpdateExpression:
      'SET desiredWorldId = :null, desiredBy = :u, desiredByNickname = :nick, desiredAt = :now',
    ConditionExpression: 'attribute_exists(pk) AND worldId = :w AND #s <> :stopped',
    ExpressionAttributeNames: STATUS_NAME,
    ExpressionAttributeValues: {
      ':null': null,
      ':u': input.steamId64,
      ':nick': input.nickname,
      ':now': iso(input.now),
      ':w': input.worldId,
      ':stopped': 'stopped',
    },
  };
}

export interface W4RollbackLaunchInput {
  sessionId: string;
  error: string;
}

/** W4 — `RunInstances` failed after W1: back to `stopped`, `lastStopReason=launch-failed`. */
export function w4RollbackLaunch(input: W4RollbackLaunchInput): UpdateCommandInput {
  return {
    TableName: TABLE_NAME,
    Key: KEY,
    UpdateExpression:
      'SET #s = :stopped, desiredWorldId = :null, sessionId = :null, instanceId = :null, ' +
      'publicIp = :null, lastStopReason = :launchFailed, lastError = :msg',
    ConditionExpression: 'sessionId = :sid AND #s = :starting',
    ExpressionAttributeNames: STATUS_NAME,
    ExpressionAttributeValues: {
      ':stopped': 'stopped',
      ':null': null,
      ':launchFailed': 'launch-failed',
      ':msg': input.error,
      ':sid': input.sessionId,
      ':starting': 'starting',
    },
  };
}

// ---------------------------------------------------------------------------------------------
// S1-S8 — supervisor (docs/control-plane.md §2; behaviour in docs/game-server.md)
// ---------------------------------------------------------------------------------------------

export interface S1ClaimInput {
  sessionId: string;
  instanceId: string;
  publicIp: string;
  now: Date;
}

/** S1 — claim, once at boot. */
export function s1Claim(input: S1ClaimInput): UpdateCommandInput {
  return {
    TableName: TABLE_NAME,
    Key: KEY,
    UpdateExpression: 'SET instanceId = :i, publicIp = :ip, heartbeatAt = :now',
    ConditionExpression: 'sessionId = :sid AND #s = :starting',
    ExpressionAttributeNames: STATUS_NAME,
    ExpressionAttributeValues: {
      ':i': input.instanceId,
      ':ip': input.publicIp,
      ':now': iso(input.now),
      ':sid': input.sessionId,
      ':starting': 'starting',
    },
  };
}

export interface S2JoinableInput {
  sessionId: string;
  instanceId: string;
  worldId: string;
  idleDeadline: string;
  now: Date;
}

/** S2 — joinable: status -> `running`. */
export function s2Joinable(input: S2JoinableInput): UpdateCommandInput {
  return {
    TableName: TABLE_NAME,
    Key: KEY,
    UpdateExpression:
      'SET #s = :running, worldId = :w, joinableAt = :now, playerCount = :zero, ' +
      'idleDeadline = :dl, heartbeatAt = :now, lastError = :null',
    ConditionExpression: 'sessionId = :sid AND instanceId = :i AND #s = :starting',
    ExpressionAttributeNames: STATUS_NAME,
    ExpressionAttributeValues: {
      ':running': 'running',
      ':w': input.worldId,
      ':now': iso(input.now),
      ':zero': 0,
      ':dl': input.idleDeadline,
      ':null': null,
      ':sid': input.sessionId,
      ':i': input.instanceId,
      ':starting': 'starting',
    },
  };
}

export interface S3HeartbeatInput {
  sessionId: string;
  instanceId: string;
  playerCount: number | null;
  idleDeadline: string | null;
  now: Date;
}

/** S3 — heartbeat, every `PLAYER_POLL_MS`. */
export function s3Heartbeat(input: S3HeartbeatInput): UpdateCommandInput {
  return {
    TableName: TABLE_NAME,
    Key: KEY,
    UpdateExpression: 'SET playerCount = :pc, idleDeadline = :dl, heartbeatAt = :now',
    ConditionExpression: 'sessionId = :sid AND instanceId = :i',
    ExpressionAttributeValues: {
      ':pc': input.playerCount,
      ':dl': input.idleDeadline,
      ':now': iso(input.now),
      ':sid': input.sessionId,
      ':i': input.instanceId,
    },
  };
}

export interface S4StopBeginsInput {
  sessionId: string;
  instanceId: string;
  reason: StopReason;
  now: Date;
}

/** S4 — stop begins: status -> `stopping`. Never overwrites a `reaper-*` reason (decisions §16.13). */
export function s4StopBegins(input: S4StopBeginsInput): UpdateCommandInput {
  return {
    TableName: TABLE_NAME,
    Key: KEY,
    UpdateExpression: 'SET #s = :stopping, lastStopReason = :r, heartbeatAt = :now',
    ConditionExpression:
      'sessionId = :sid AND instanceId = :i AND ' +
      '(attribute_type(lastStopReason, :nullType) OR NOT begins_with(lastStopReason, :reaperPrefix))',
    ExpressionAttributeNames: STATUS_NAME,
    ExpressionAttributeValues: {
      ':stopping': 'stopping',
      ':r': input.reason,
      ':now': iso(input.now),
      ':sid': input.sessionId,
      ':i': input.instanceId,
      ':nullType': 'NULL',
      ':reaperPrefix': 'reaper-',
    },
  };
}

export interface S5SwitchInput {
  instanceId: string;
  oldSessionId: string;
  newSessionId: string;
  newWorldId: string;
  desiredBy: string;
  desiredByNickname: string;
  now: Date;
}

/** S5 — in-place switch: same instance, new sessionId, `worldId := desiredWorldId`. */
export function s5Switch(input: S5SwitchInput): UpdateCommandInput {
  return {
    TableName: TABLE_NAME,
    Key: KEY,
    UpdateExpression:
      'SET #s = :starting, worldId = :newW, sessionId = :newSid, startedBy = :desiredBy, ' +
      'startedByNickname = :desiredByNickname, startedAt = :now, joinableAt = :null, ' +
      'playerCount = :null, idleDeadline = :null, lastStopReason = :switch, heartbeatAt = :now',
    ConditionExpression: 'instanceId = :i AND sessionId = :oldSid AND desiredWorldId = :newW',
    ExpressionAttributeNames: STATUS_NAME,
    ExpressionAttributeValues: {
      ':starting': 'starting',
      ':newW': input.newWorldId,
      ':newSid': input.newSessionId,
      ':desiredBy': input.desiredBy,
      ':desiredByNickname': input.desiredByNickname,
      ':now': iso(input.now),
      ':null': null,
      ':switch': 'switch',
      ':i': input.instanceId,
      ':oldSid': input.oldSessionId,
    },
  };
}

export interface S6FinalStoppedInput {
  sessionId: string;
  instanceId: string;
  reason: StopReason;
}

/** S6 — supervisor's final `stopped` write; conditional on `desiredWorldId` already being null. */
export function s6FinalStopped(input: S6FinalStoppedInput): UpdateCommandInput {
  return {
    TableName: TABLE_NAME,
    Key: KEY,
    UpdateExpression:
      'SET #s = :stopped, sessionId = :null, instanceId = :null, publicIp = :null, ' +
      'joinableAt = :null, playerCount = :null, idleDeadline = :null, heartbeatAt = :null, ' +
      'lastStopReason = :reason',
    ConditionExpression:
      'sessionId = :sid AND instanceId = :i AND attribute_type(desiredWorldId, :nullType)',
    ExpressionAttributeNames: STATUS_NAME,
    ExpressionAttributeValues: {
      ':stopped': 'stopped',
      ':null': null,
      ':reason': input.reason,
      ':sid': input.sessionId,
      ':i': input.instanceId,
      ':nullType': 'NULL',
    },
  };
}

export interface S7ErrorNoteInput {
  sessionId: string;
  instanceId: string;
  error: string;
  now: Date;
}

/** S7 — error note. */
export function s7ErrorNote(input: S7ErrorNoteInput): UpdateCommandInput {
  return {
    TableName: TABLE_NAME,
    Key: KEY,
    UpdateExpression: 'SET lastError = :e, heartbeatAt = :now',
    ConditionExpression: 'sessionId = :sid AND instanceId = :i',
    ExpressionAttributeValues: {
      ':e': input.error,
      ':now': iso(input.now),
      ':sid': input.sessionId,
      ':i': input.instanceId,
    },
  };
}

export interface S8ReleaseDesireInput {
  sessionId: string;
  instanceId: string;
  worldId: string;
  now: Date;
}

/**
 * S8 — the supervisor releases the desire it is itself serving, at the start of a stop it decided
 * on alone (`idle`, `crash`): nothing else ever nulls `desiredWorldId` on that path.
 *
 * Without it an idle stop cannot finish. S6 is conditional on `desiredWorldId` already being null,
 * which is true only when a **user** pressed stop (W3) or the reaper went graceful (R1). A world
 * that idles out is still its own `desiredWorldId`, so S6's condition fails, and the failure branch
 * — "someone asked for a world during shutdown, start it instead of terminating" — restarts the
 * very world that just timed out, forever (measured: docs/_first-boot-notes.md round 3).
 *
 * `desiredWorldId = :w` in the condition is what keeps the designed race intact: a start that lands
 * before this write names a different world, so the condition fails and nothing is released; a
 * start that lands after it sets the desire again, S6 then fails as designed and the supervisor
 * switches to that world instead of halting. `desiredBy`/`desiredByNickname` are deliberately left
 * alone — they still record who last asked for a world.
 */
export function s8ReleaseDesire(input: S8ReleaseDesireInput): UpdateCommandInput {
  return {
    TableName: TABLE_NAME,
    Key: KEY,
    UpdateExpression: 'SET desiredWorldId = :null, desiredAt = :now',
    ConditionExpression: 'sessionId = :sid AND instanceId = :i AND desiredWorldId = :w',
    ExpressionAttributeValues: {
      ':null': null,
      ':now': iso(input.now),
      ':sid': input.sessionId,
      ':i': input.instanceId,
      ':w': input.worldId,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// R1-R3 — reaper (docs/control-plane.md §2, §6)
// ---------------------------------------------------------------------------------------------

export interface R1MaxAgeGracefulInput {
  sessionId: string;
  instanceId: string;
  now: Date;
}

/** R1 — max age, graceful: null the desire so the supervisor saves and shuts down cleanly. */
export function r1MaxAgeGraceful(input: R1MaxAgeGracefulInput): UpdateCommandInput {
  return {
    TableName: TABLE_NAME,
    Key: KEY,
    UpdateExpression:
      'SET desiredWorldId = :null, desiredBy = :reaper, desiredByNickname = :reaper, ' +
      'desiredAt = :now, lastStopReason = :reaperMaxAge',
    ConditionExpression: 'sessionId = :sid AND instanceId = :i AND #s <> :stopped',
    ExpressionAttributeNames: STATUS_NAME,
    ExpressionAttributeValues: {
      ':null': null,
      ':reaper': 'reaper',
      ':now': iso(input.now),
      ':reaperMaxAge': 'reaper-max-age',
      ':sid': input.sessionId,
      ':i': input.instanceId,
      ':stopped': 'stopped',
    },
  };
}

export interface ReaperFinalizeInput {
  sessionId: string;
  reason: Extract<StopReason, 'reaper-max-age' | 'reaper-stale'>;
  error: string;
}

/**
 * Shared shape of R2 (post-terminate) and R3 (reconcile): the same `SET` as S6, plus nulling the
 * desire and recording why. `COND` is `sessionId` only — the session the reaper observed, so a
 * newer session is never clobbered.
 */
function reaperFinalize(input: ReaperFinalizeInput): UpdateCommandInput {
  return {
    TableName: TABLE_NAME,
    Key: KEY,
    UpdateExpression:
      'SET #s = :stopped, sessionId = :null, instanceId = :null, publicIp = :null, ' +
      'joinableAt = :null, playerCount = :null, idleDeadline = :null, heartbeatAt = :null, ' +
      'lastStopReason = :reason, desiredWorldId = :null, lastError = :why',
    ConditionExpression: 'sessionId = :sid',
    ExpressionAttributeNames: STATUS_NAME,
    ExpressionAttributeValues: {
      ':stopped': 'stopped',
      ':null': null,
      ':reason': input.reason,
      ':why': input.error,
      ':sid': input.sessionId,
    },
  };
}

/** R2 — reaper, post-terminate. */
export function r2PostTerminate(input: ReaperFinalizeInput): UpdateCommandInput {
  return reaperFinalize(input);
}

/** R3 — reaper, reconcile (no live instance matches the state). */
export function r3Reconcile(input: ReaperFinalizeInput): UpdateCommandInput {
  return reaperFinalize(input);
}
