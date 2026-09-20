// @dst/shared: types shared by every package (docs/control-plane.md §1.2, §5.4). No package
// redefines these (decisions §16.2).

/** `pk="STATE", sk="CLUSTER"` cluster state machine (docs/decisions.md §6). */
export type ClusterStatus = 'stopped' | 'starting' | 'running' | 'stopping';

/** docs/decisions.md §6, §16.13. */
export type StopReason =
  'idle' | 'user' | 'switch' | 'crash' | 'reaper-max-age' | 'reaper-stale' | 'launch-failed';

export type WorldSource = 'import' | 'generated' | 'test';

/** World registry item: `pk="WORLD", sk=worldId`. No nullable attributes. */
export interface WorldRegistryItem {
  pk: 'WORLD';
  sk: string;
  worldId: string; // WORLD_ID_RE
  displayName: string; // 1..64 chars, shown in the UI
  serverName: string; // cluster_name players see in the server browser
  hasCaves: boolean;
  idleMinutes: number; // integer >= 1, default DEFAULT_IDLE_MINUTES
  createdAt: string; // ISO 8601 UTC
  source: WorldSource;
}

/**
 * Singleton `pk="STATE", sk="CLUSTER"`. Every attribute is always present; "not applicable" is an
 * explicit DynamoDB NULL, never a missing attribute. All timestamps are ISO 8601 UTC.
 */
export interface ClusterStateItem {
  pk: 'STATE';
  sk: 'CLUSTER';
  status: ClusterStatus;
  worldId: string | null; // world `status` refers to; kept after a stop, for lastStopReason
  desiredWorldId: string | null; // null = "nothing should run"
  desiredBy: string | null; // steamid64, or 'reaper'
  desiredByNickname: string | null; // the API already knows it; 'reaper' for reaper writes
  desiredAt: string | null;
  sessionId: string | null; // SESSION_ID_RE; also the RunInstances ClientToken and S3 log prefix
  startedBy: string | null; // steamid64
  startedByNickname: string | null; // what the UI shows as "started by"
  startedAt: string | null; // when the API wrote `starting`
  instanceId: string | null; // written by the supervisor once it knows its own id
  publicIp: string | null;
  joinableAt: string | null;
  playerCount: number | null; // null = UNKNOWN, never coerced to 0
  idleDeadline: string | null; // max(joinableAt, last non-zero reading) + idleMinutes
  heartbeatAt: string | null; // supervisor writes every PLAYER_POLL_MS
  lastStopReason: StopReason | null;
  lastError: string | null; // <= 200 chars, human readable, never a secret
}

// ---------------------------------------------------------------------------------------------
// API response types (docs/control-plane.md §5.4). These are the exact names @dst/web, the e2e
// suite and scripts/lifecycle-test.ts import; nothing redefines them.
// ---------------------------------------------------------------------------------------------

/** decisions §16.9: exactly three fields, nothing else. */
export interface WorldSummary {
  worldId: string;
  displayName: string;
  status: ClusterStatus;
}

export interface JoinInfo {
  serverName: string;
  ip: string;
  port: number;
  password: string;
  connectCommand: string;
}

export interface ActiveInfo {
  worldId: string;
  status: ClusterStatus;
  stale: boolean;
  startedBy: string | null; // NICKNAME (state.startedByNickname), never a SteamID64
  startedAt: string | null;
  playerCount: number | null;
  idleDeadline: string | null;
  join: JoinInfo | null;
}

export interface WorldsResponse {
  worlds: WorldSummary[];
  active: ActiveInfo | null;
  lastStopReason: StopReason | null; // so the UI can explain a failure
  lastError: string | null;
}

/** `GET /api/me`, or 401. */
export interface MeResponse {
  nickname: string;
}
