// @dst/shared: derived per-world status, staleness, and the active/join block
// (docs/control-plane.md §5.4). Pure — no I/O, no SSM reads; callers supply the cluster password
// once they have already fetched it.
import { MASTER_PORT, STALE_HEARTBEAT_MS } from './constants';
import type {
  ActiveInfo,
  ClusterStateItem,
  ClusterStatus,
  JoinInfo,
  WorldRegistryItem,
  WorldsResponse,
  WorldSummary,
} from './types';

/** The world equal to `state.worldId` has `state.status`; every other world is `stopped`. */
export function deriveWorldStatus(
  world: WorldRegistryItem,
  state: ClusterStateItem,
): ClusterStatus {
  return world.worldId === state.worldId ? state.status : 'stopped';
}

/** decisions §16.9: exactly `worldId`/`displayName`/`status`, nothing else. */
export function deriveWorldSummaries(
  worlds: readonly WorldRegistryItem[],
  state: ClusterStateItem,
): WorldSummary[] {
  return worlds.map((world) => ({
    worldId: world.worldId,
    displayName: world.displayName,
    status: deriveWorldStatus(world, state),
  }));
}

/**
 * decisions §16.8: stale only when `heartbeatAt` is non-null and older than `STALE_HEARTBEAT_MS`.
 * A `stopped` cluster (`heartbeatAt` always null, per S6) and a booting one (`heartbeatAt` still
 * null) are never stale — a boot that never reports is the reaper's job, not this flag's.
 */
export function isStale(state: ClusterStateItem, now: Date): boolean {
  if (state.status === 'stopped') return false;
  if (state.heartbeatAt === null) return false;
  return now.getTime() - Date.parse(state.heartbeatAt) > STALE_HEARTBEAT_MS;
}

/** `join` is non-null only once the world is `running` with a public IP. */
export function isJoinable(state: ClusterStateItem): boolean {
  return state.status === 'running' && state.publicIp !== null;
}

export function buildJoinInfo(a: { serverName: string; ip: string; password: string }): JoinInfo {
  return {
    serverName: a.serverName,
    ip: a.ip,
    port: MASTER_PORT,
    password: a.password,
    connectCommand: `c_connect("${a.ip}", ${MASTER_PORT}, "${a.password}")`,
  };
}

export interface DeriveActiveInput {
  /** The registry item for `state.worldId`, or null if it could not be looked up. Only consulted
   *  to build the `join` block. */
  activeWorld: WorldRegistryItem | null;
  state: ClusterStateItem;
  now: Date;
  /** The cluster password, already read from SSM by the caller (this function does no I/O); pass
   *  `null` when no join block will be produced. */
  password: string | null;
}

export function deriveActive(input: DeriveActiveInput): ActiveInfo | null {
  const { activeWorld, state, now, password } = input;
  if (state.status === 'stopped' || state.worldId === null) return null;

  const join =
    isJoinable(state) && activeWorld !== null && password !== null && state.publicIp !== null
      ? buildJoinInfo({ serverName: activeWorld.serverName, ip: state.publicIp, password })
      : null;

  return {
    worldId: state.worldId,
    status: state.status,
    stale: isStale(state, now),
    startedBy: state.startedByNickname, // NICKNAME — state.startedBy (the steamid64) never leaves
    startedAt: state.startedAt,
    playerCount: state.playerCount,
    idleDeadline: state.idleDeadline,
    join,
  };
}

export interface DeriveWorldsResponseInput {
  worlds: readonly WorldRegistryItem[];
  activeWorld: WorldRegistryItem | null;
  state: ClusterStateItem;
  now: Date;
  password: string | null;
}

export function deriveWorldsResponse(input: DeriveWorldsResponseInput): WorldsResponse {
  return {
    worlds: deriveWorldSummaries(input.worlds, input.state),
    active: deriveActive({
      activeWorld: input.activeWorld,
      state: input.state,
      now: input.now,
      password: input.password,
    }),
    lastStopReason: input.state.lastStopReason,
    lastError: input.state.lastError,
  };
}
