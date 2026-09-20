// @dst/shared: runtime validation of items read from DynamoDB (docs/control-plane.md §1.3).
// A missing state item **is** `stopped`; a present-but-malformed item **throws** — it is never
// coerced to `stopped`, because that would let the API launch a second instance.
import { WORLD_ID_RE } from './constants';
import type {
  ClusterStateItem,
  ClusterStatus,
  StopReason,
  WorldRegistryItem,
  WorldSource,
} from './types';

export class InvalidItemError extends Error {
  readonly path: string;
  readonly detail: string;

  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = 'InvalidItemError';
    this.path = path;
    this.detail = detail;
  }
}

const CLUSTER_STATUSES: readonly ClusterStatus[] = ['stopped', 'starting', 'running', 'stopping'];
const STOP_REASONS: readonly StopReason[] = [
  'idle',
  'user',
  'switch',
  'crash',
  'reaper-max-age',
  'reaper-stale',
  'launch-failed',
];
const WORLD_SOURCES: readonly WorldSource[] = ['import', 'generated', 'test'];

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value);
}

function requireString(raw: Record<string, unknown>, key: string): string {
  const value = raw[key];
  if (typeof value !== 'string') {
    throw new InvalidItemError(key, `expected a string, got ${typeof value}`);
  }
  return value;
}

function nullableString(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new InvalidItemError(key, `expected a string or null, got ${typeof value}`);
  }
  return value;
}

function nullableTimestamp(raw: Record<string, unknown>, key: string): string | null {
  const value = nullableString(raw, key);
  if (value === null) return null;
  if (Number.isNaN(Date.parse(value))) {
    throw new InvalidItemError(key, `not a parseable ISO 8601 timestamp: ${value}`);
  }
  return value;
}

function nullableWorldId(raw: Record<string, unknown>, key: string): string | null {
  const value = nullableString(raw, key);
  if (value === null) return null;
  if (!WORLD_ID_RE.test(value)) {
    throw new InvalidItemError(key, `does not match WORLD_ID_RE: ${value}`);
  }
  return value;
}

function nullablePlayerCount(raw: Record<string, unknown>, key: string): number | null {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new InvalidItemError(
      key,
      `expected a non-negative integer or null, got ${String(value)}`,
    );
  }
  return value;
}

function nullableStopReason(raw: Record<string, unknown>, key: string): StopReason | null {
  const value = raw[key];
  if (value === undefined || value === null) return null;
  if (!isOneOf(value, STOP_REASONS)) {
    throw new InvalidItemError(key, `not a valid StopReason: ${String(value)}`);
  }
  return value;
}

export function initialClusterState(): ClusterStateItem {
  return {
    pk: 'STATE',
    sk: 'CLUSTER',
    status: 'stopped',
    worldId: null,
    desiredWorldId: null,
    desiredBy: null,
    desiredByNickname: null,
    desiredAt: null,
    sessionId: null,
    startedBy: null,
    startedByNickname: null,
    startedAt: null,
    instanceId: null,
    publicIp: null,
    joinableAt: null,
    playerCount: null,
    idleDeadline: null,
    heartbeatAt: null,
    lastStopReason: null,
    lastError: null,
  };
}

export function parseClusterState(raw: Record<string, unknown> | undefined): ClusterStateItem {
  if (raw === undefined) return initialClusterState();

  const status = raw['status'];
  if (!isOneOf(status, CLUSTER_STATUSES)) {
    throw new InvalidItemError('status', `not a valid ClusterStatus: ${String(status)}`);
  }

  return {
    pk: 'STATE',
    sk: 'CLUSTER',
    status,
    worldId: nullableWorldId(raw, 'worldId'),
    desiredWorldId: nullableWorldId(raw, 'desiredWorldId'),
    desiredBy: nullableString(raw, 'desiredBy'),
    desiredByNickname: nullableString(raw, 'desiredByNickname'),
    desiredAt: nullableTimestamp(raw, 'desiredAt'),
    sessionId: nullableString(raw, 'sessionId'),
    startedBy: nullableString(raw, 'startedBy'),
    startedByNickname: nullableString(raw, 'startedByNickname'),
    startedAt: nullableTimestamp(raw, 'startedAt'),
    instanceId: nullableString(raw, 'instanceId'),
    publicIp: nullableString(raw, 'publicIp'),
    joinableAt: nullableTimestamp(raw, 'joinableAt'),
    playerCount: nullablePlayerCount(raw, 'playerCount'),
    idleDeadline: nullableTimestamp(raw, 'idleDeadline'),
    heartbeatAt: nullableTimestamp(raw, 'heartbeatAt'),
    lastStopReason: nullableStopReason(raw, 'lastStopReason'),
    lastError: nullableString(raw, 'lastError'),
  };
}

export function parseWorldItem(raw: Record<string, unknown>): WorldRegistryItem {
  const worldId = requireString(raw, 'worldId');
  if (!WORLD_ID_RE.test(worldId)) {
    throw new InvalidItemError('worldId', `does not match WORLD_ID_RE: ${worldId}`);
  }

  const displayName = requireString(raw, 'displayName');
  if (displayName.length < 1 || displayName.length > 64) {
    throw new InvalidItemError('displayName', 'must be 1..64 characters');
  }

  const serverName = requireString(raw, 'serverName');
  if (serverName.length < 1) {
    throw new InvalidItemError('serverName', 'must be non-empty');
  }

  const hasCaves = raw['hasCaves'];
  if (typeof hasCaves !== 'boolean') {
    throw new InvalidItemError('hasCaves', `expected a boolean, got ${typeof hasCaves}`);
  }

  const idleMinutes = raw['idleMinutes'];
  if (typeof idleMinutes !== 'number' || !Number.isInteger(idleMinutes) || idleMinutes < 1) {
    throw new InvalidItemError(
      'idleMinutes',
      `expected an integer >= 1, got ${String(idleMinutes)}`,
    );
  }

  const createdAt = requireString(raw, 'createdAt');
  if (Number.isNaN(Date.parse(createdAt))) {
    throw new InvalidItemError('createdAt', `not a parseable ISO 8601 timestamp: ${createdAt}`);
  }

  const source = raw['source'];
  if (!isOneOf(source, WORLD_SOURCES)) {
    throw new InvalidItemError('source', `not a valid WorldSource: ${String(source)}`);
  }

  return {
    pk: 'WORLD',
    sk: worldId,
    worldId,
    displayName,
    serverName,
    hasCaves,
    idleMinutes,
    createdAt,
    source,
  };
}
