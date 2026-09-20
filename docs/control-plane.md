# Control plane

Scope: `packages/shared`; the non-auth parts of `packages/api` (router, `/api/worlds`, start/stop,
ports/adapters, local dev server); the reaper Lambda; `scripts/import-world`.
Source of truth: `docs/decisions.md` §3, §4, §6, §7, §10. Auth (sign-in, session cookie, allowlist,
CSRF) is `docs/auth.md`; on-instance behaviour is `docs/supervisor.md`; S3 is `docs/storage.md`;
Lambda-behind-CloudFront facts are `docs/spikes/cloudfront-oac-lambda-url.md`.

Invariants:

- One world at a time; one DynamoDB item (`pk="STATE"`, `sk="CLUSTER"`) is the entire control state.
- **Only the API launches instances, and only from `stopped`.** A switch never launches; the
  supervisor converges in place on the same instance.
- Every write is conditional. A failed condition is never fatal: re-read and re-decide.
- No response body and no log line ever contains a SteamID64, an email, the Klei token, the session
  secret, or (outside the `join` block) the cluster password.

## 1. `packages/shared`

`src/`: `constants.ts` (names, regions, ports, intervals, thresholds), `types.ts`, `ids.ts`,
`validate.ts` (runtime validation of items read from DynamoDB), `state-expressions.ts` (every
DynamoDB write in the system, as pure builders), `derive.ts` (derived status, staleness, the active
block), `index.ts` (re-exports). No runtime dependencies — the `@aws-sdk/lib-dynamodb` import is
type-only and the validators are hand written.

### 1.1 Constants

```ts
export const PROJECT = 'dst-server-manager', ACCOUNT_ID = '063257577013';
export const CONTROL_REGION = 'us-east-1';   // API, reaper, DynamoDB
export const GAME_REGION = 'us-west-2';      // EC2, data bucket, game SSM params
export const TABLE_NAME = 'dst-server-manager', LAUNCH_TEMPLATE_NAME = 'dst-server-manager-game';
export const SECURITY_GROUP_NAME = 'dst-server-manager-game';
export const INSTANCE_ROLE_NAME = 'dst-server-manager-instance';
export const DATA_BUCKET = 'dst-server-manager-data-063257577013';
export const INSTANCE_TYPE = 'c6i.large';    // m6i.large is the upgrade path
export const INSTANCE_NAME_TAG = 'dst-game';
export const MASTER_PORT = 10999, CAVES_PORT = 10998;
export const PARAM_KLEI_TOKEN = '/dst/klei-token';             // us-west-2, SecureString
export const PARAM_CLUSTER_PASSWORD = '/dst/cluster-password'; // us-west-2, SecureString
export const PARAM_USERS = '/dst/users';                       // us-east-1, String
export const PARAM_SESSION_SECRET = '/dst/session-secret';     // us-east-1, SecureString

export const DEFAULT_IDLE_MINUTES = 30;
export const PLAYER_POLL_MS = 30_000;         // supervisor player-count poll
export const ZERO_READINGS_REQUIRED = 3;      // consecutive zero polls before "empty"
export const DESIRED_POLL_MS = 10_000;        // supervisor poll of the state item
export const STALE_HEARTBEAT_MS = 120_000;    // 2 min -> API sets stale:true
export const MAX_SESSION_MS = 12 * 3_600_000; // 12 h -> reaper nulls desiredWorldId
export const MAX_SESSION_GRACE_MS = 600_000;  // +10 min -> reaper terminates
export const REAPER_HEARTBEAT_STALE_MS = 600_000;    // 10 min with no heartbeat
export const REAPER_BOOT_GRACE_MS = 900_000;         // 15 min: too young to judge
export const STARTING_WITHOUT_INSTANCE_MS = 180_000; // 3 min in `starting`, no instance
export const PARAM_CACHE_MS = 60_000;         // in-process SSM cache (password, allowlist)
export const WORLD_ID_RE = /^[a-z0-9-]{1,32}$/, TEST_WORLD_PREFIX = 'test-';
```

### 1.2 Types

```ts
export type ClusterStatus = 'stopped' | 'starting' | 'running' | 'stopping';
export type StopReason = 'idle' | 'user' | 'switch' | 'crash'
  | 'reaper-max-age' | 'reaper-stale' | 'launch-failed';
export type WorldSource = 'import' | 'generated' | 'test';

export interface WorldRegistryItem {          // pk="WORLD", sk=worldId; no nullable attributes
  pk: 'WORLD'; sk: string;
  worldId: string;        // WORLD_ID_RE
  displayName: string;    // 1..64 chars, shown in the UI
  serverName: string;     // cluster_name players see in the server browser
  hasCaves: boolean;
  idleMinutes: number;    // integer >= 1, default DEFAULT_IDLE_MINUTES
  createdAt: string;      // ISO 8601 UTC
  source: WorldSource;
}

/** Singleton pk="STATE", sk="CLUSTER". Every attribute is always present; "not applicable" is an
 *  explicit DynamoDB NULL, never a missing attribute. All timestamps are ISO 8601 UTC. */
export interface ClusterStateItem {
  pk: 'STATE'; sk: 'CLUSTER';
  status: ClusterStatus;
  worldId: string | null;         // world `status` refers to; kept after a stop, for lastStopReason
  desiredWorldId: string | null;  // null = "nothing should run"
  desiredBy: string | null;       // steamid64, or 'reaper'
  desiredAt: string | null;
  sessionId: string | null;       // uuid v4; also the RunInstances ClientToken and S3 log prefix
  startedBy: string | null;       // steamid64
  startedAt: string | null;       // when the API wrote `starting`
  instanceId: string | null;      // written by the supervisor once it knows its own id
  publicIp: string | null;
  joinableAt: string | null;
  playerCount: number | null;     // null = UNKNOWN, never coerced to 0
  idleDeadline: string | null;    // max(joinableAt, last non-zero reading) + idleMinutes
  heartbeatAt: string | null;     // supervisor writes every PLAYER_POLL_MS
  lastStopReason: StopReason | null;
  lastError: string | null;       // <= 200 chars, human readable, never a secret
}
```

`ids.ts`: `isValidWorldId(id)` (WORLD_ID_RE), `isTestWorldId(id)`, `newSessionId()` =
`crypto.randomUUID()` — it must stay <= 64 ASCII chars because it is the `RunInstances` `ClientToken`.

### 1.3 Validation

```ts
export class InvalidItemError extends Error { constructor(path: string, detail: string) }
export function initialClusterState(): ClusterStateItem;   // status 'stopped', all else null
export function parseClusterState(raw: Record<string, unknown> | undefined): ClusterStateItem;
export function parseWorldItem(raw: Record<string, unknown>): WorldRegistryItem;
```

- `parseClusterState(undefined)` returns `initialClusterState()` — a missing item **is** `stopped`. A
  present-but-malformed item **throws**; it is never coerced to `stopped`, because that would let the
  API launch a second instance.
- Checks: `status` and `lastStopReason` in their unions; `worldId`/`desiredWorldId` match
  `WORLD_ID_RE` when non-null; `playerCount` a non-negative integer or null; timestamps parse with
  `Date.parse`. Missing nullable attributes read as `null` (forward compatible).
- `parseWorldItem` throws; `GET /api/worlds` catches per item, logs
  `{"event":"world_item_invalid","worldId":…}` and omits it.

## 2. DynamoDB table and every write

Table `dst-server-manager` (us-east-1), on-demand, `pk` (S) hash + `sk` (S) range, no GSI, no TTL.
Access through `DynamoDBDocumentClient` with `marshallOptions.removeUndefinedValues: false` so JS
`null` round-trips as DynamoDB `NULL`; state reads use `ConsistentRead: true`. Because nulls are
explicit, "is null" is `attribute_type(desiredWorldId, :nullType)` with `:nullType = 'NULL'` (`=`
against a NULL operand is not reliable), and `#s` is always
`ExpressionAttributeNames: { '#s': 'status' }` (`status` is reserved). All builders live in
`state-expressions.ts` and return `UpdateCommandInput` without a client, so the API, the reaper, the
supervisor and the tests share one definition. **Bootstrap:** neither CDK nor `import-world` creates
the state item; the first successful start does (W1 tolerates a missing item), and every other write
requires it to exist.

**W1 — API, start world W from `stopped`.** On failure: re-read and re-dispatch through §3.2
(nothing launched yet, so nothing to undo).

```
SET #s = :starting, worldId = :w, desiredWorldId = :w, desiredBy = :u, desiredAt = :now,
    sessionId = :sid, startedBy = :u, startedAt = :now, instanceId = :null, publicIp = :null,
    joinableAt = :null, playerCount = :null, idleDeadline = :null, heartbeatAt = :null,
    lastStopReason = :null, lastError = :null
COND: attribute_not_exists(pk) OR #s = :stopped
```

**W2 — API, start W while something is active.** Pinning both `status` and `sessionId` (rather than
`#s <> :stopped`) is what makes the "start arriving as the supervisor writes its final `stopped`"
race safe. On failure: re-read and re-dispatch.

```
SET  desiredWorldId = :w, desiredBy = :u, desiredAt = :now
COND: attribute_exists(pk) AND #s = :expectedStatus AND sessionId = :expectedSessionId
```

**W3 — API, stop world W (W is the active world).** On failure: re-read; if `status` is now
`stopped` or `worldId` is no longer W, answer 200 no-op.

```
SET  desiredWorldId = :null, desiredBy = :u, desiredAt = :now
COND: attribute_exists(pk) AND worldId = :w AND #s <> :stopped
```

**W4 — API, rollback after `RunInstances` failed.** On failure: log `launch_rollback_skipped` and
still return the launch error; the reaper's reconcile rule is the backstop.

```
SET  #s = :stopped, desiredWorldId = :null, sessionId = :null, instanceId = :null,
     publicIp = :null, lastStopReason = :launchFailed, lastError = :msg
COND: sessionId = :sid AND #s = :starting
```

**S1–S4 — supervisor** (behaviour in `docs/supervisor.md`; expressions live here). S1 records
`instanceId`/`publicIp`/`heartbeatAt`, condition `sessionId = :sid AND #s = :starting`. S2 sets
`#s = :running, joinableAt, idleDeadline, playerCount, heartbeatAt`. S3 (every 30 s) sets
`playerCount, idleDeadline, heartbeatAt`. S4 sets `#s = :stopping, lastStopReason = :r, heartbeatAt`.
S2–S4 all condition on `sessionId = :sid AND instanceId = :i`. A failed condition means this
supervisor no longer owns the session: it stops writing and shuts down.

**S5 — supervisor, in-place switch.**

```
SET  #s = :starting, worldId = :newW, sessionId = :newSid, startedBy = :desiredBy,
     startedAt = :now, joinableAt = :null, playerCount = :null, idleDeadline = :null,
     lastStopReason = :switch, heartbeatAt = :now
COND: instanceId = :i AND sessionId = :oldSid AND desiredWorldId = :newW
```

`instanceId` is deliberately unchanged — the reaper's orphan rule keys on it (§6).

**S6 — supervisor, final `stopped`.**

```
SET  #s = :stopped, sessionId = :null, instanceId = :null, publicIp = :null, joinableAt = :null,
     playerCount = :null, idleDeadline = :null, heartbeatAt = :now, lastStopReason = :reason
COND: sessionId = :sid AND instanceId = :i AND attribute_type(desiredWorldId, :nullType)
```

`worldId` is retained so the UI can say which world stopped and why (derived status is unaffected:
a `stopped` cluster makes every world `stopped`). On failure the supervisor re-reads; a non-null
`desiredWorldId` means someone asked for a world during shutdown, so it performs S5 and starts that
world instead of terminating.

**R1 — reaper, max-age graceful.** `SET desiredWorldId = :null, desiredBy = :reaper, desiredAt = :now`
/ `COND: sessionId = :sid AND instanceId = :i AND #s <> :stopped`.

**R2 (post-terminate) / R3 (reconcile) — reaper.** Same `SET` as S6, plus `desiredWorldId = :null`
and `lastError = :why`, with `lastStopReason` = `reaper-max-age` (hard max age) or `reaper-stale`
(stale heartbeat, orphan, reconcile). `COND: sessionId = :sid` — the session the reaper observed, so
a newer session is never clobbered. On failure: log and do nothing.

## 3. State machine

```
    W1 + RunInstances       S2 joinable        S4 (idle | user | crash | switch)
  stopped ------------> starting ---------> running --------------------------> stopping
    ^  ^                   ^                                                      |   |
    |  |                   |  S5: switch in place — same instance, new sessionId,  |   |
    |  |                   +------------------------------------------------------+   |
    |  |                      worldId := desiredWorldId. Taken when the stop sequence  |
    |  |                      ends with desiredWorldId non-null (S6's condition fails  |
    |  |                      because a start landed during shutdown).                 |
    |  +-- S6 (cond desiredWorldId IS NULL, then `shutdown -h now`) -----------------  +
    +----- R2 / R3 (reaper terminated the instance, or reconciled) ----------------->  +

  W4: starting -> stopped, lastStopReason = launch-failed.
  A switch is only ever entered by W2 (desired=B while A runs); the API never launches mid-session.
```

### 3.1 Preconditions for both mutations

1. `requireUser(req) -> { steamId64, nickname }` (port; implemented in `docs/auth.md`) — else 401
   `unauthorized` / 403 `not_allowed`.
2. The CSRF precondition on POSTs (`Origin === PUBLIC_ORIGIN`, header `X-DST-Request: 1`), defined in
   `docs/auth.md` and enforced before these handlers run -> 403 `csrf_failed`.
3. `{id}` matches `WORLD_ID_RE` (else 400 `invalid_world_id`) and exists in the registry (else 404
   `world_not_found`).

Both handlers run an attempt loop — read state, decide, write conditionally, and on
`ConditionalCheckFailedException` re-read and decide again — up to **3 attempts**, then 409
`state_conflict`. Success returns **200** with exactly the `GET /api/worlds` body (§5.4) built from
the state just written, so the SPA updates without a second round trip.

### 3.2 `POST /api/worlds/{W}/start`

| Current state | Write | HTTP | Notes |
|---|---|---|---|
| item absent, or `stopped` | W1 then `RunInstances` | 200 | the only path that launches |
| `starting` W | W2 | 200 | idempotent re-assert; also cancels a pending stop |
| `starting` X (X≠W) | none | 409 `world_busy` | no queueing while booting |
| `running` W | W2 | 200 | re-asserts desire; cancels a pending stop |
| `running` X | W2 | 200 | in-place switch, no launch |
| `stopping` W | W2 | 200 | supervisor restarts W instead of terminating |
| `stopping` X | W2 | 200 | supervisor switches to W instead of terminating |

### 3.3 `POST /api/worlds/{W}/stop`

| Current state | Write | HTTP |
|---|---|---|
| `stopped`, or item absent | none | 200 no-op |
| non-stopped, `worldId === W` | W3 | 200 |
| non-stopped, `worldId !== W` | none | 200 no-op |

Stopping a world that is only *desired* (a queued switch) is a no-op by design; a switch is cancelled
by pressing Start on the world that is currently running.

### 3.4 Races (each one is a unit test)

- **Two users start the same world from `stopped`.** Both attempt W1 with different `sessionId`s;
  DynamoDB serialises them. The winner calls `RunInstances`; the loser re-reads `starting W`, takes
  the W2 row, returns 200. Exactly one instance, because `RunInstances` is only reachable after W1.
- **Two users start different worlds from `stopped`.** One W1 wins (`starting A`); the loser re-reads
  and hits the `starting X` row -> 409 `world_busy`.
- **Stop and start at once.** Either W1 wins and W3 then nulls the desire (the instance boots and the
  supervisor immediately runs the stop sequence — safe), or the stop sees `stopped` and no-ops.
- **Start arriving exactly as the supervisor writes S6.** (a) W2 first -> S6's
  `attribute_type(desiredWorldId,'NULL')` fails -> the supervisor does S5 and starts W on the same
  instance. (b) S6 first -> W2's `#s = :stopping AND sessionId = :sid` fails -> the API re-reads
  `stopped` and retries as W1. Never lost, never double-launched.
- **Reaper vs supervisor.** R1–R3 pin `sessionId`, so a supervisor that moved to a new session (S5)
  is unaffected.

## 4. Launcher

`packages/api/src/adapters/ec2-launcher.ts`, `@aws-sdk/client-ec2` pinned to `region: GAME_REGION`.
Port: `interface Launcher { launch(i: { sessionId: string; worldId: string }): Promise<{ instanceId: string }> }`.

Subnet selection, cached for the life of the Lambda container: `DescribeVpcs Filters=[isDefault=true]`
-> default VPC; `DescribeSubnets Filters=[vpc-id=<id>, default-for-az=true]` -> sort by
`AvailabilityZone` for determinism, then rotate the starting index by `hash(sessionId) % n` so
retries spread across AZs.

```ts
RunInstancesCommand({
  LaunchTemplate: { LaunchTemplateName: LAUNCH_TEMPLATE_NAME, Version: '$Default' },
  MinCount: 1, MaxCount: 1,
  ClientToken: attempt === 0 ? sessionId : `${sessionId}-az${attempt}`,
  SubnetId: subnets[i].SubnetId,
  TagSpecifications: [{ ResourceType: 'instance', Tags: tags },
                      { ResourceType: 'volume',   Tags: tags }],
});
// tags = project=dst-server-manager, role=game, sessionId=<sessionId>, Name=dst-game
```

Instance type, AMI, security group, instance profile, block device and
`InstanceInitiatedShutdownBehavior=terminate` come from the launch template; the launcher overrides
none of them. The token varies per attempt because changing `SubnetId` under one token yields
`IdempotentParameterMismatch`. Retry: on `InsufficientInstanceCapacity` or `Unsupported` (type not
offered in that AZ) try the next subnet, at most `min(subnets.length, 4)` attempts; any other error
fails immediately. Total failure -> W4 with
`lastError = `${err.name}: ${truncate(err.message, 160)}`` and **503**
`{"error":{"code":"launch_failed","message":"Could not start an instance right now"}}`.

## 5. API

### 5.1 Ports and adapters

```ts
export interface Clock { now(): Date }
export interface StateStore {
  get(): Promise<ClusterStateItem>;                                  // absent -> initialClusterState()
  startFresh(a: { worldId; sessionId; steamId64; now }): Promise<boolean>;  // W1
  setDesired(a: { worldId; steamId64; expectedStatus; expectedSessionId; now }): Promise<boolean>; // W2
  clearDesired(a: { worldId; steamId64; now }): Promise<boolean>;    // W3
  rollbackLaunch(a: { sessionId; error; now }): Promise<boolean>;    // W4
}
export interface WorldRegistry {
  list(): Promise<WorldRegistryItem[]>;            // Query pk="WORLD", sorted by displayName
  get(worldId: string): Promise<WorldRegistryItem | null>;
}
export interface ParameterStore { get(name: string, region: string): Promise<string> } // PARAM_CACHE_MS
export interface Identity { requireUser(req: HttpRequest): Promise<{ steamId64: string; nickname: string }> }
```

`false` means `ConditionalCheckFailedException`; anything else throws. Adapters in
`packages/api/src/adapters/`: `dynamo-state-store.ts`, `dynamo-world-registry.ts`, `ec2-launcher.ts`,
`ssm-parameter-store.ts`, `system-clock.ts`. Fakes in `packages/api/src/fakes/` are shared by
`local.ts` and the tests; the in-memory state store evaluates conditions exactly as DynamoDB would
and exposes a hook to interleave writes for the race tests.

### 5.2 Routing (no framework)

`packages/api/src/index.ts` exports `handler(event: APIGatewayProxyEventV2)` (Function URL payload
v2, behind CloudFront). Per the OAC spike: method from `event.requestContext.http.method`, path from
`event.rawPath` (CloudFront does not rewrite `/api/*`), cookies from `event.cookies`, viewer IP from
`x-forwarded-for` — **never `requestContext.http.sourceIp`** (that is CloudFront's). `headers.host`
is the function URL's host, so the public origin comes from the `PUBLIC_ORIGIN` env var.

`router.ts` is a table of `{ method, pattern: RegExp, handler }`: `^/api/worlds$` (GET),
`^/api/worlds/([a-z0-9-]{1,32})/start$` (POST), `^/api/worlds/([a-z0-9-]{1,32})/stop$` (POST),
`^/api/me$` (GET), plus the auth routes. A path that matches with a different method -> 405; no match
-> 404. Every response carries `content-type: application/json; charset=utf-8` and
`cache-control: no-store`.

### 5.3 Errors

Body: `{ "error": { "code": "world_busy", "message": "Another world is starting" } }`. Codes ->
status: `invalid_world_id` 400 · `unauthorized` 401 · `not_allowed`, `csrf_failed` 403 ·
`world_not_found`, `not_found` 404 · `method_not_allowed` 405 · `world_busy`, `state_conflict` 409 ·
`launch_failed` 503 · `internal` 500.

Unexpected throws are caught at the top of the handler, logged as
`{"event":"unhandled","name":…,"message":…}`, and returned as 500 `internal` with a fixed message.

### 5.4 `GET /api/worlds`

```ts
interface WorldSummary { worldId; displayName; hasCaves; idleMinutes; source; status: ClusterStatus }
interface JoinInfo { serverName: string; ip: string; port: number; password: string; connectCommand: string }
interface ActiveInfo {
  worldId: string; status: ClusterStatus; stale: boolean;
  startedBy: string | null;   // NICKNAME from the allowlist, never a SteamID64
  startedAt: string | null; playerCount: number | null; idleDeadline: string | null;
  join: JoinInfo | null;
}
interface WorldsResponse {
  worlds: WorldSummary[]; active: ActiveInfo | null;
  lastStopReason: StopReason | null; lastError: string | null;   // so the UI can explain a failure
}
```

Shaping lives in `derive.ts` (pure, unit tested):

- Per-world `status`: `world.worldId === state.worldId ? state.status : 'stopped'`; when
  `state.status === 'stopped'`, every world is `stopped`. `active` is `null` in that case (and when
  `state.worldId === null`). `test-*` worlds are returned like any other; filtering is the SPA's choice.
- `stale = status !== 'stopped' && heartbeatAt !== null && now - heartbeatAt > STALE_HEARTBEAT_MS`.
  During boot `heartbeatAt` is still null, so a normal start never shows stale; a boot that never
  reports is the reaper's job, not this flag's.
- `startedBy` maps `state.startedBy` (steamid64) through the allowlist to a nickname; an unknown id
  becomes `null`. The raw id never leaves the Lambda.
- `join` is non-null only when `status === 'running' && publicIp !== null`: `serverName` from the
  registry, `ip` = `publicIp`, `port` = `MASTER_PORT` (10999), `password` from SSM
  `/dst/cluster-password` in **us-west-2** (`PARAM_CACHE_MS` cache, fetched lazily only when a `join`
  block is produced and only after `requireUser` succeeded), and
  ``connectCommand = `c_connect("${ip}", 10999, "${password}")` ``.

### 5.5 Local dev server (`packages/api/src/local.ts`)

`node:http` on port 8787 (the Vite dev server proxies `/api`). It converts `IncomingMessage` into the
same payload-v2 shape and calls the same `router`, so there is exactly one code path. Wiring: fake
state store, fake registry (seeded with `tylerni2026` plus two `test-*` worlds), fake parameter store
(`/dst/cluster-password` -> `localpass1`), system clock, `env=test` identity (the Playwright cookie;
see `docs/auth.md`), and a fake launcher whose 1 s ticker drives the state item exactly as the
supervisor would (S1…S6), so every UI state is reachable locally:

| Env var | Default | Effect |
|---|---|---|
| `DST_LOCAL_BOOT_SECONDS` | 12 | `starting` -> `running` (sets `instanceId=i-local1`, `publicIp=203.0.113.10`, `joinableAt`) |
| `DST_LOCAL_STOP_SECONDS` | 8 | `stopping` -> `stopped`, or -> `starting B` when `desiredWorldId` changed |
| `DST_LOCAL_IDLE_MINUTES` | world value | shortens the auto-stop countdown |
| `DST_LOCAL_PLAYERS` | `0,1,2,2,1,0` | player-count cycle, one step per 5 s; `idleDeadline` = last non-zero + idle |
| `DST_LOCAL_LAUNCH_FAIL` | unset | `launch()` throws `InsufficientInstanceCapacity` -> W4 path |
| `DST_LOCAL_STALE` | unset | the ticker stops writing `heartbeatAt` after joinable -> `stale: true` |

There are no dev-only routes: the switches are env vars, so nothing extra exists in production.

## 6. Reaper (`packages/api/src/reaper/index.ts`)

EventBridge `rate(5 minutes)`, always enabled. Event: `{ now?: string }`;
`now = new Date(Math.max(Date.now(), Date.parse(event.now ?? '') || 0))` — an override may only move
time **forward**, i.e. only ever make the reaper more aggressive. The function is invocable only with
IAM credentials.

1. `state = parseClusterState(GetItem{pk:'STATE', sk:'CLUSTER'}, ConsistentRead)`.
2. `DescribeInstances` in us-west-2, paginated,
   `Filters: [{'tag:project': PROJECT}, {'tag:role': 'game'}, {'instance-state-name': ['pending','running']}]`.
3. Per instance, first matching rule wins (at most one action per instance per tick):
   1. **orphan** — `InstanceId !== state.instanceId` **and** `tag:sessionId !== state.sessionId` ->
      terminate, then R2 with `reaper-stale`. The `and` matters: an in-place switch changes
      `sessionId` while keeping the instance, and the instance tag keeps the original sessionId.
   2. **max age, hard** — `now - LaunchTime > MAX_SESSION_MS + MAX_SESSION_GRACE_MS` -> terminate,
      then R2 with `reaper-max-age`.
   3. **max age, graceful** — `now - LaunchTime > MAX_SESSION_MS` and `desiredWorldId !== null` ->
      R1 only (the supervisor then saves and shuts down cleanly); no terminate this tick.
   4. **stale heartbeat** — `now - LaunchTime > REAPER_BOOT_GRACE_MS` and (`heartbeatAt === null` or
      `now - heartbeatAt > REAPER_HEARTBEAT_STALE_MS`) -> terminate, then R2 with `reaper-stale`.
4. **Reconcile** — `state.status !== 'stopped'`, no live instance matches the state (by `instanceId`
   or by `sessionId` tag; instances terminated in step 3 count as not live), and (`status !== 'starting'`
   or `now - startedAt > STARTING_WITHOUT_INSTANCE_MS`) -> R3 with `reaper-stale`.

Idempotency: `TerminateInstances` on an already-terminating instance succeeds,
`InvalidInstanceID.NotFound` is caught and ignored, and every write is conditional on the session the
reaper observed, so a concurrent legitimate start is never clobbered. A second invocation over
unchanged inputs performs zero writes.

Logging: one JSON line per instance (`{"event":"reap","instanceId","rule","ageSec","action"}`) plus a
summary (`{"event":"reaper_done","instances":n,"terminated":n,"writes":n}`). Never log the state item
verbatim, and never log tag values other than `sessionId`.

## 7. IAM

**API Lambda** (`dst-server-manager-api`, us-east-1):

- `ec2:RunInstances` (us-west-2) on `launch-template/<lt-id>`, `subnet/*`, `security-group/*`,
  `network-interface/*`, `image/*`, `volume/*`, `instance/*`; the `instance/*` and `volume/*`
  statements add `StringEquals { "aws:RequestTag/project": "dst-server-manager",
  "aws:RequestTag/role": "game" }` and `ForAllValues:StringEquals aws:TagKeys
  [project, role, sessionId, Name]`.
- `ec2:CreateTags` on `instance/*` and `volume/*` in us-west-2, with
  `StringEquals { "ec2:CreateAction": "RunInstances" }` — tagging on create only, never retagging.
- `iam:PassRole` on `arn:aws:iam::063257577013:role/dst-server-manager-instance` only, with
  `StringEquals { "iam:PassedToService": "ec2.amazonaws.com" }`.
- `ec2:DescribeInstances`, `ec2:DescribeSubnets`, `ec2:DescribeVpcs` on `*` (Describe* cannot be
  resource-scoped).
- `dynamodb:GetItem`, `dynamodb:UpdateItem`, `dynamodb:Query` on
  `arn:aws:dynamodb:us-east-1:063257577013:table/dst-server-manager` only. No `PutItem`, no
  `DeleteItem`, no `Scan`.
- `ssm:GetParameter` on three exact parameter ARNs — `/dst/users` and `/dst/session-secret`
  (us-east-1), `/dst/cluster-password` (us-west-2). No wildcard, and **not** `/dst/klei-token`.
- `kms:Decrypt` on `arn:aws:kms:<region>:063257577013:key/*` in both regions with
  `StringEquals { "kms:ViaService": "ssm.<region>.amazonaws.com" }` (SecureString reads).

**Reaper Lambda** (`dst-server-manager-reaper`, us-east-1): `ec2:DescribeInstances` on `*`;
`ec2:TerminateInstances` on `arn:aws:ec2:us-west-2:063257577013:instance/*` with
`StringEquals { "ec2:ResourceTag/project": "dst-server-manager" }`; `dynamodb:GetItem` and
`dynamodb:UpdateItem` on the one table. Nothing else — no RunInstances, no PassRole, no SSM.

## 8. Unit tests (Vitest, no AWS credentials)

`packages/shared`: `validate.test.ts` — absent item -> `stopped`, malformed item throws (bad status,
bad worldId, negative playerCount, unparseable timestamp), missing nullable -> null, valid item
round-trips. `derive.test.ts` — per-world status (active / other / all-stopped); `stale`
true/false/boot-null; `join` only when running with an ip; `connectCommand` text; nickname mapping
and unknown id -> null; a regex assertion that `JSON.stringify(response)` contains no 17-digit id.
`state-expressions.test.ts` — snapshot every builder's Update/Condition expression; assert `#s`
aliasing and `attribute_type(…, 'NULL')`.

`packages/api`: `start-stop-matrix.test.ts` — every row of §3.2 and §3.3 against the in-memory store
(resulting item, whether `launch()` was called, status, body). `races.test.ts` — the four races of
§3.4 via the interleave hook: same-world double start (exactly one `launch()`), different-world
double start (one 409), stop+start in both orders, W2-vs-S6 in both orders. `launcher.test.ts` —
RunInstances params (template name, ClientToken, all four tags on both instance and volume), AZ
fallback on `InsufficientInstanceCapacity` with a changed token, non-capacity error fails fast,
failure writes W4 and returns 503. `router.test.ts` — path/method table, 404/405, 400 on a bad id,
404 on an unknown world, `cache-control: no-store` everywhere, viewer IP from `x-forwarded-for`.
`reaper.test.ts` — fake clock + fake EC2: orphan; a switched instance is **not** an orphan; max age
graceful then hard at +10 min; stale heartbeat only after the 15 min boot grace; reconcile for
`running` with no instance and for `starting` younger/older than 3 min; `now` override only moves
forward; a repeat run performs zero writes.

## 9. `scripts/import-world`

```
pnpm tsx scripts/import-world.ts --world-id <id> --display-name <name> --server-name <name> \
  [--no-caves] [--idle-minutes 30] [--source import|generated|test] [--force]
```

Validates `--world-id` against `WORLD_ID_RE` and refuses a `test-` id unless `--source test`. Writes
one item: `PutCommand { TableName: TABLE_NAME, Item: <WorldRegistryItem with pk:'WORLD', sk:worldId,
createdAt: new Date().toISOString()>, ConditionExpression: 'attribute_not_exists(pk)' }` (the
condition is omitted with `--force`). `ConditionalCheckFailedException` -> exit 1 with
"world already registered; pass --force to replace". It never touches the state item and never
launches anything. Uploading the save to `worlds/<worldId>/save.tar.zst` is a separate step
documented in `docs/storage.md`; a world with no save object is generated on first boot by the
supervisor.
