// Ports for @dst/api (docs/control-plane.md §5.1, §4). Every handler is written against these
// interfaces; `packages/api/src/adapters/` implements them against AWS, `packages/api/src/fakes/`
// implements them in memory for local dev and tests. No package redefines a @dst/shared type.
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

import type {
  ClusterStateItem,
  ClusterStatus,
  RecapShard,
  StopReason,
  WorldNote,
  WorldRegistryItem,
} from '@dst/shared';

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

export interface StateStoreMaxAgeGracefulInput {
  sessionId: string;
  instanceId: string;
  now: Date;
}

export interface StateStoreFinalizeStoppedInput {
  sessionId: string;
  reason: Extract<StopReason, 'reaper-max-age' | 'reaper-stale'>;
  error: string;
}

/** docs/control-plane.md §5.1. `false` means the conditional write lost the race
 * (`ConditionalCheckFailedException`); anything else throws. */
export interface StateStore {
  get(): Promise<ClusterStateItem>; // absent item -> initialClusterState()
  startFresh(a: StateStoreStartFreshInput): Promise<boolean>; // W1
  setDesired(a: StateStoreSetDesiredInput): Promise<boolean>; // W2
  clearDesired(a: StateStoreClearDesiredInput): Promise<boolean>; // W3
  rollbackLaunch(a: StateStoreRollbackLaunchInput): Promise<boolean>; // W4
  maxAgeGraceful(a: StateStoreMaxAgeGracefulInput): Promise<boolean>; // R1
  finalizeStopped(a: StateStoreFinalizeStoppedInput): Promise<boolean>; // R2 / R3
}

export interface WorldRegistry {
  list(): Promise<WorldRegistryItem[]>; // sorted by displayName; invalid items omitted + logged
  get(worldId: string): Promise<WorldRegistryItem | null>;
}

export interface ParameterStore {
  get(name: string, region: string): Promise<string>; // cached PARAM_CACHE_MS
}

/** docs/auth.md §12.3: who is reading. A guest (a shared read-only link) has no SteamID64. */
export type Viewer =
  { kind: 'member'; steamId64: string; nickname: string } | { kind: 'guest'; label: string };

export interface Identity {
  /** Every write: an allowlisted member, else throws (`read_only` for a guest). */
  requireUser(req: HttpRequest): Promise<{ steamId64: string; nickname: string }>; // throws ApiError
  /** Every read: a member or a guest, else throws. */
  requireViewer(req: HttpRequest): Promise<Viewer>; // throws ApiError
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

/** One session's digest files as the store read them (docs/control-plane.md §5.6). `recap` has
 *  passed only the envelope check (`schemaVersion`, `sessionId`); every field below it is still
 *  untrusted S3 JSON and is copied field by field into a `RecapView` by `recaps/view.ts`, never
 *  spread. `players` is the PRIVATE ref → KU/SteamID64 map and never leaves the API. */
export interface StoredRecap {
  sessionId: string;
  recap: Record<string, unknown>;
  players: unknown;
  summaryMeta: unknown;
  summaryText: string | null;
}

/** `sessions/<worldId>/<sessionId>/digest/*` in the data bucket, newest session first. Sessions
 *  without a readable, valid `recap.json` are skipped (and logged), never returned. */
export interface RecapStore {
  listRecent(worldId: string, limit: number): Promise<StoredRecap[]>;
}

/** Read-only view of an object store, just wide enough for the recap scan. The S3 adapter and the
 *  in-memory fake both implement it, so the scan itself (`recaps/store.ts`) is one code path. */
export interface ObjectReader {
  /** Immediate child "directories" of `prefix` (S3 `CommonPrefixes` with Delimiter '/'), every
   *  page, each ending in '/'. */
  listPrefixes(prefix: string): Promise<string[]>;
  /** The object's body as UTF-8, or `null` when it does not exist. */
  getText(key: string): Promise<string | null>;
  /** The object's body as bytes, or `null` when it does not exist. */
  getBytes(key: string): Promise<Uint8Array | null>;
}

/** One player's map inputs (docs/decisions.md §19), exactly as stored: the unmasked
 *  `map/index.json` of that player's newest session with a map (untrusted JSON, validated by
 *  `recaps/map-view.ts`), each shard's gzipped palette grid, and that player's own trail. */
export interface StoredMap {
  sessionId: string;
  /** Internal only: who the map is of, to find their nickname and whether they are the viewer.
   *  Never returned. */
  steamId64: string;
  /** Their persona in that session's `players.json`, unredacted (`map-view.ts` redacts it). */
  persona: string | null;
  /** Their ref in this session ("p1", …), from the private `players.json`. */
  ref: string;
  index: unknown;
  shards: Partial<
    Record<RecapShard, { tilesGz: Uint8Array; visited: Uint8Array; fresh: Uint8Array | null }>
  >;
}

/** One map per player (by SteamID64): each player's newest session (of the last `RECAP_SCAN_CAP`)
 *  that has a map index and a trail of theirs. Empty when there is none. */
export interface MapStore {
  findAll(worldId: string): Promise<StoredMap[]>;
}

export interface NotePutInput {
  worldId: string;
  text: string;
  updatedAt: string;
  updatedBy: string | null;
}

/** The per-world "next time" note: DynamoDB item `{ pk: NOTE_PK, sk: worldId, text, updatedAt,
 *  updatedBy }` (docs/control-plane.md §5.7). The digest Lambda reads the same item. */
export interface NoteStore {
  get(worldId: string): Promise<WorldNote | null>;
  put(input: NotePutInput): Promise<WorldNote>;
  clear(input: Omit<NotePutInput, 'text'>): Promise<void>;
}
