// Ports for @dst/api (docs/control-plane.md §5.1, §4). Every handler is written against these
// interfaces; `packages/api/src/adapters/` implements them against AWS, `packages/api/src/fakes/`
// implements them in memory for local dev and tests. No package redefines a @dst/shared type.
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import type { ClusterStateItem, ClusterStatus, WorldRegistryItem } from '@dst/shared';

/**
 * The Lambda Function URL payload-v2 shape (docs/control-plane.md §5.2, §5.5). `local.ts`
 * constructs a value of this exact shape from `IncomingMessage` so the router has exactly one
 * code path in both prod and local dev.
 */
export type HttpRequest = APIGatewayProxyEventV2;

/** Internal response shape shared by the router and `src/auth/index.ts`'s `AuthResponse`. The
 *  Lambda entry (`handlers/api.ts`) converts `status` -> `statusCode` for the actual return value;
 *  `local.ts` writes it onto a `ServerResponse`. */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  cookies: string[];
  body?: string;
  isBase64Encoded?: boolean;
}

export interface Clock {
  now(): Date;
}

export interface StateStoreStartFreshInput {
  worldId: string;
  sessionId: string;
  steamId64: string;
  nickname: string;
  now: Date;
}

export interface StateStoreSetDesiredInput {
  worldId: string;
  steamId64: string;
  nickname: string;
  expectedStatus: ClusterStatus;
  expectedSessionId: string;
  now: Date;
}

export interface StateStoreClearDesiredInput {
  worldId: string;
  steamId64: string;
  nickname: string;
  now: Date;
}

export interface StateStoreRollbackLaunchInput {
  sessionId: string;
  error: string;
  now: Date;
}

/** docs/control-plane.md §5.1. `false` means the conditional write lost the race
 * (`ConditionalCheckFailedException`); anything else throws. */
export interface StateStore {
  get(): Promise<ClusterStateItem>; // absent item -> initialClusterState()
  startFresh(a: StateStoreStartFreshInput): Promise<boolean>; // W1
  setDesired(a: StateStoreSetDesiredInput): Promise<boolean>; // W2
  clearDesired(a: StateStoreClearDesiredInput): Promise<boolean>; // W3
  rollbackLaunch(a: StateStoreRollbackLaunchInput): Promise<boolean>; // W4
}

export interface WorldRegistry {
  list(): Promise<WorldRegistryItem[]>; // sorted by displayName; invalid items omitted + logged
  get(worldId: string): Promise<WorldRegistryItem | null>;
}

export interface ParameterStore {
  get(name: string, region: string): Promise<string>; // cached PARAM_CACHE_MS
}

export interface Identity {
  requireUser(req: HttpRequest): Promise<{ steamId64: string; nickname: string }>; // throws ApiError
}

export interface LaunchInput {
  sessionId: string;
  worldId: string;
}

export interface LaunchOutput {
  instanceId: string;
}

/** docs/control-plane.md §4. */
export interface Launcher {
  launch(i: LaunchInput): Promise<LaunchOutput>;
}
