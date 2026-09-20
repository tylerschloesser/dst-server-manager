# Control plane

Scope: `@dst/shared` (`packages/shared`); the non-auth parts of `@dst/api` (router, `/api/worlds`,
start/stop, ports/adapters, local dev server); the reaper Lambda; `scripts/import-world.ts`.
Source of truth: `docs/decisions.md` §3, §4, §6, §7, §10, and §16 (Clarifications, which override
every doc including this one).

Related docs: `docs/auth.md` (sign-in, session cookie, allowlist, CSRF, security headers) ·
`docs/game-server.md` (on-instance behaviour) · `docs/storage.md` (S3 layout, tarball, manifest) ·
`docs/web.md` (SPA + e2e) · `docs/infra.md` (CDK, IAM as deployed) · `docs/testing.md` (root
scripts, lifecycle test) · `docs/spikes/cloudfront-oac-lambda-url.md`.

Invariants:

- One world at a time; one DynamoDB item (`pk="STATE"`, `sk="CLUSTER"`) is the entire control state.
- **Only the API launches instances, and only from `stopped`.** A switch never launches; the
  supervisor converges in place on the same instance.
- Every write is conditional. A failed condition is never fatal: re-read and re-decide.
- No response body and no log line ever contains a SteamID64, an email, the Klei token, the session
  secret, or (outside the `join` block) the cluster password.

## 1. `@dst/shared` (`packages/shared`)

Every API type and constant in this section is defined **once** here and imported by `@dst/api`,
`@dst/supervisor`, `@dst/web`, `@dst/infra` and the scripts (decisions §16.2). No package
redefines them.

`src/`: `constants.ts` (names, regions, ports, intervals, thresholds), `types.ts`, `ids.ts`,
`validate.ts` (runtime validation of items read from DynamoDB), `state-expressions.ts` (every
DynamoDB write in the system, as pure builders), `derive.ts` (derived status, staleness, the active
block), `index.ts` (re-exports). No runtime dependencies — the `@aws-sdk/lib-dynamodb` import is
type-only and the validators are hand written.

### 1.0 Dependencies and workspace wiring

The two packages this doc owns, in full (every other package's list lives in its own doc:
`docs/game-server.md` §1, `docs/web.md` §1, `docs/infra.md` §1, `docs/testing.md` §1):

| Package | dependencies | devDependencies |
|---|---|---|
| `@dst/shared` | *(none)* — `@aws-sdk/lib-dynamodb` is a **type-only** devDependency | `@aws-sdk/lib-dynamodb`, `@aws-sdk/client-dynamodb` |
| `@dst/api` | `@dst/shared@workspace:*`, `@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `@aws-sdk/client-ec2`, `@aws-sdk/client-ssm` | `esbuild` |

`esbuild` is the repo's **one** bundler (decisions §16.29): a devDependency of `@dst/api`,
`@dst/supervisor` and the root package — the three places with an `esbuild.mjs` or a script that
needs it. **`packages/infra` has none**, and nothing bundles inside CDK.

**Workspace wiring** (decisions §16.32). `e2e/` and `scripts/` are not workspace packages, so their
imports resolve through the **root** `package.json`, which depends on both:

```json
"dependencies": { "@dst/shared": "workspace:*", "@dst/api": "workspace:*" }
```

and each package exports TypeScript **source** through an `exports` map — `tsx`, Vitest and esbuild
all resolve it, and nothing in this repo ever consumes a compiled `@dst/*` package:

```json
// packages/shared/package.json
"exports": { ".": "./src/index.ts" }

// packages/api/package.json
"exports": {
  ".": "./src/index.ts",
  "./auth": "./src/auth/index.ts",
  "./test-secret": "./src/auth/testSecret.ts"
}
```

`"./auth"` exists so `e2e/support/session.ts`, `scripts/mint-cookie.ts` and
`scripts/lifecycle-test.ts` import the session signer from `@dst/api/auth` rather than
re-implementing it (`docs/auth.md` §9.3, `docs/testing.md` §4.2). `"./test-secret"` is the **only**
way to reach `TEST_SESSION_SECRET` (decisions §16.37): `src/auth/index.ts` does not re-export it, so
it stays out of `src/handlers/api.ts`'s import graph and out of `dist/lambda/`. Only `src/local.ts`,
`e2e/` and tests import it; `scripts/` never does. `packages/supervisor`, `packages/web` and
`packages/infra` each declare `@dst/shared@workspace:*` the same way.

`@aws-sdk/client-dynamodb` is a devDependency of `@dst/shared` purely so its guard test can issue a
real `DescribeTableCommand` and prove the network block is wired (`docs/testing.md` §1bis) — the
shared package ships no runtime AWS call.

### 1.1 Constants

```ts
export const PROJECT = 'dst-server-manager', ACCOUNT_ID = '063257577013';
export const CONTROL_REGION = 'us-east-1';   // API, reaper, DynamoDB, site bucket
export const GAME_REGION = 'us-west-2';      // EC2, data bucket, game SSM params
export const TABLE_NAME = 'dst-server-manager', LAUNCH_TEMPLATE_NAME = 'dst-server-manager-game';
export const SECURITY_GROUP_NAME = 'dst-server-manager-game';
export const INSTANCE_ROLE_NAME = 'dst-server-manager-instance';
export const DATA_BUCKET = 'dst-server-manager-data-063257577013';
export const SITE_BUCKET = 'dst-server-manager-site-063257577013';
export const API_FUNCTION_NAME = 'dst-server-manager-api';
export const REAPER_FUNCTION_NAME = 'dst-server-manager-reaper';
export const DOMAIN_NAME = 'dst.ty.ler.dev';
export const PUBLIC_ORIGIN_PROD = 'https://dst.ty.ler.dev';
export const HOSTED_ZONE_ID = 'Z038502736IM0QLQT7VFN', ZONE_NAME = 'ty.ler.dev';
export const INSTANCE_TYPE = 'c6i.large';    // m6i.large is the upgrade path
export const INSTANCE_NAME_TAG = 'dst-game';
export const MASTER_PORT = 10999, CAVES_PORT = 10998;
export const CAVES_SHARD_ID = 2;             // pinned Caves shard id (decisions §16.5)
export const LOCAL_ONLY_MARKER = 'DST_LOCAL_ONLY'; // decisions §16.4; see §5.5
export const SPA_CSP = '…';                  // exact string in docs/auth.md §8.3; DstWeb imports it
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
export const PARAM_CACHE_MS = 60_000;         // in-process SSM cache for the cluster password
                                              // (allowlist / session-secret TTLs: docs/auth.md §0)
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
  desiredByNickname: string | null;   // the API already knows it; 'reaper' for reaper writes
  desiredAt: string | null;
  sessionId: string | null;       // SESSION_ID_RE (§1.2 ids.ts); also the RunInstances
                                  // ClientToken and the S3 session log prefix
  startedBy: string | null;       // steamid64
  startedByNickname: string | null;   // what the UI shows as "started by"; the instance NEVER
                                      // reads /dst/users (decisions §16.6)
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

`ids.ts`: `isValidWorldId(id)` (WORLD_ID_RE), `isTestWorldId(id)`, and

```ts
export const SESSION_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{6}$/;
/** decisions §16.3: `YYYYMMDDTHHMMSSZ-<6 lowercase hex>` in UTC, e.g. 20260919T201355Z-a1b2c3 */
export function newSessionId(now: Date): string;   // never crypto.randomUUID()
```

The format is deliberate: it sorts chronologically (so an `sessions/<worldId>/` prefix lists in
order), it is a valid EC2 `ClientToken` (23 chars, well under the 64-char limit), and it is the S3
session log prefix. The API mints one at launch; the supervisor mints a new one for the session it
starts after an in-place switch (§S5). AZ-fallback retries use `ClientToken=<sessionId>-az<n>`.

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
SET #s = :starting, worldId = :w, desiredWorldId = :w, desiredBy = :u, desiredByNickname = :nick,
    desiredAt = :now, sessionId = :sid, startedBy = :u, startedByNickname = :nick,
    startedAt = :now, instanceId = :null, publicIp = :null,
    joinableAt = :null, playerCount = :null, idleDeadline = :null, heartbeatAt = :null,
    lastStopReason = :null, lastError = :null
COND: attribute_not_exists(pk) OR #s = :stopped
```

**W2 — API, start W while something is active.** Pinning both `status` and `sessionId` (rather than
`#s <> :stopped`) is what makes the "start arriving as the supervisor writes its final `stopped`"
race safe. On failure: re-read and re-dispatch.

```
SET  desiredWorldId = :w, desiredBy = :u, desiredByNickname = :nick, desiredAt = :now
COND: attribute_exists(pk) AND #s = :expectedStatus AND sessionId = :expectedSessionId
```

**W3 — API, stop world W (W is the active world).** On failure: re-read; if `status` is now
`stopped` or `worldId` is no longer W, answer 200 no-op.

```
SET  desiredWorldId = :null, desiredBy = :u, desiredByNickname = :nick, desiredAt = :now
COND: attribute_exists(pk) AND worldId = :w AND #s <> :stopped
```

**W4 — API, rollback after `RunInstances` failed.** On failure: log `launch_rollback_skipped` and
still return the launch error; the reaper's reconcile rule is the backstop.

```
SET  #s = :stopped, desiredWorldId = :null, sessionId = :null, instanceId = :null,
     publicIp = :null, lastStopReason = :launchFailed, lastError = :msg
COND: sessionId = :sid AND #s = :starting
```

**S1–S8 — supervisor** (behaviour in `docs/game-server.md`, which uses these same labels; the
expressions live here and nowhere else). Every one of them **SETs an explicit `:null`; none uses
`REMOVE`**, because the state item never has a missing attribute (§1.2).

| Label | When | UpdateExpression | ConditionExpression |
|---|---|---|---|
| **S1** | claim, once at boot | `SET instanceId = :i, publicIp = :ip, heartbeatAt = :now` | `sessionId = :sid AND #s = :starting` |
| **S2** | joinable | `SET #s = :running, worldId = :w, joinableAt = :now, playerCount = :zero, idleDeadline = :dl, heartbeatAt = :now, lastError = :null` | `sessionId = :sid AND instanceId = :i AND #s = :starting` |
| **S3** | heartbeat, every 30 s | `SET playerCount = :pc, idleDeadline = :dl, heartbeatAt = :now` | `sessionId = :sid AND instanceId = :i` |
| **S4** | stop begins | `SET #s = :stopping, lastStopReason = :r, heartbeatAt = :now` | `sessionId = :sid AND instanceId = :i AND (attribute_type(lastStopReason, :nullType) OR NOT begins_with(lastStopReason, :reaperPrefix))` |
| **S7** | error note | `SET lastError = :e, heartbeatAt = :now` | `sessionId = :sid AND instanceId = :i` |
| **S8** | release its own desire, right after S4 on a self-decided stop (`idle`, `crash`) | `SET desiredWorldId = :null, desiredAt = :now` | `sessionId = :sid AND instanceId = :i AND desiredWorldId = :w` |

S4's extra clause implements decisions §16.13: the supervisor **never overwrites a `reaper-*`
reason** (`:reaperPrefix = 'reaper-'`); if the condition fails only for that clause it re-reads,
keeps the reaper's reason and carries on with the stop. A failed condition on `sessionId`/
`instanceId` means this supervisor no longer owns the session: it stops writing and shuts down.

**S5 — supervisor, in-place switch.**

```
SET  #s = :starting, worldId = :newW, sessionId = :newSid, startedBy = :desiredBy,
     startedByNickname = :desiredByNickname, startedAt = :now, joinableAt = :null,
     playerCount = :null, idleDeadline = :null, lastStopReason = :switch, heartbeatAt = :now
COND: instanceId = :i AND sessionId = :oldSid AND desiredWorldId = :newW
```

`instanceId` is deliberately unchanged — the reaper's orphan rule keys on it (§6). The supervisor
copies `desiredByNickname` into `startedByNickname`; it never resolves a nickname itself, because
**the instance has no access to `/dst/users`** (decisions §16.6). The instance's `sessionId` **tag**
is its launch session and is *not* re-tagged here (decisions §16.7) — the AND orphan rule in §6
covers it.

**S6 — supervisor, final `stopped`.**

```
SET  #s = :stopped, sessionId = :null, instanceId = :null, publicIp = :null, joinableAt = :null,
     playerCount = :null, idleDeadline = :null, heartbeatAt = :null, lastStopReason = :reason
COND: sessionId = :sid AND instanceId = :i AND attribute_type(desiredWorldId, :nullType)
```

`worldId` is retained so the UI can say which world stopped and why (decisions §16.10; derived
status is unaffected: a `stopped` cluster makes every world `stopped`). `heartbeatAt` is nulled, not
stamped — a `stopped` cluster has no heartbeat, and §5.4's `stale` is then structurally false. On
failure the supervisor re-reads; a non-null `desiredWorldId` means someone asked for a world during
shutdown, so it performs S5 and starts that world instead of terminating.

**S8 — supervisor, release its own desire.** S6's condition can only hold once something has
nulled `desiredWorldId`, and on a stop the supervisor decided on alone (`idle`, `crash`,
boot-timeout) nothing else ever does: a user stop (W3) and the reaper's graceful path (R1) are the
only other writers of that attribute. A world that idles out is still its own `desiredWorldId`, so
without S8 **S6's condition always fails and the failure branch above restarts the very world that
just timed out**, under a new `sessionId`, forever — measured, `docs/_first-boot-notes.md` round 3.
No session could stop itself; only the 12 h reaper and the dead-man ever ended one.

```
SET  desiredWorldId = :null, desiredAt = :now
COND: sessionId = :sid AND instanceId = :i AND desiredWorldId = :w
```

Issued immediately after S4, and only when the stop is session-ending and not a `user` stop (a
switch keeps the desire, which is the whole point of a switch). The `desiredWorldId = :w` clause is
what preserves §3.4's start-during-shutdown race: a start that lands **before** S8 names a
different world, so the condition fails and nothing is released; a start that lands **after** it
sets the desire again, S6 then fails as designed, and the supervisor switches to that world instead
of halting. `desiredBy` / `desiredByNickname` are deliberately left alone — they still record who
last asked for a world.

**R1 — reaper, max-age graceful.**
`SET desiredWorldId = :null, desiredBy = :reaper, desiredByNickname = :reaper, desiredAt = :now,
lastStopReason = :reaperMaxAge` / `COND: sessionId = :sid AND instanceId = :i AND #s <> :stopped`.
Writing the reason here (decisions §16.13) is what makes the graceful path attributable; S4's
`reaper-` guard stops the supervisor from overwriting it.

**R2 (post-terminate) / R3 (reconcile) — reaper.** Same `SET` as S6, plus `desiredWorldId = :null`
and `lastError = :why`, with `lastStopReason` = `reaper-max-age` (hard max age) or `reaper-stale`
(stale heartbeat, orphan, reconcile-without-a-specific-cause). `COND: sessionId = :sid` — the
session the reaper observed, so a newer session is never clobbered. On failure: log and do nothing.

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
  S8 runs immediately after S4 on a self-decided stop (idle | crash), releasing the desire the
  supervisor is itself serving; without it S6's condition can never hold and the stop loops back
  into S5 forever. A `user` stop needs no S8 (W3 already nulled the desire) and a `switch` must
  not have one (the desire IS world B).
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
  LaunchTemplate: { LaunchTemplateName: LAUNCH_TEMPLATE_NAME, Version: '$Latest' },
  MinCount: 1, MaxCount: 1,
  ClientToken: attempt === 0 ? sessionId : `${sessionId}-az${attempt}`,
  SubnetId: subnets[i].SubnetId,
  TagSpecifications: [{ ResourceType: 'instance', Tags: tags },
                      { ResourceType: 'volume',   Tags: tags }],
});
// tags = project=dst-server-manager, role=game, sessionId=<sessionId>, Name=dst-game
```

Instance type, AMI, security group, instance profile, block device, IMDS options and
`InstanceInitiatedShutdownBehavior=terminate` come from the launch template; the launcher overrides
none of them. `Version: '$Latest'` (never `$Default`, never a pinned number) — see
`docs/infra.md` §3.6. The launch template carries `project`, `role`, `Name`; this request repeats
all three and adds `sessionId` (decisions §16.16). The template has no `NetworkInterfaces` block,
which is why `SubnetId` can be passed top-level here and why the public IPv4 comes from the default
subnet's `MapPublicIpOnLaunch`. The token varies per attempt because changing `SubnetId` under one token yields
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
  startFresh(a: { worldId; sessionId; steamId64; nickname; now }): Promise<boolean>;  // W1
  setDesired(a: { worldId; steamId64; nickname; expectedStatus; expectedSessionId; now }): Promise<boolean>; // W2
  clearDesired(a: { worldId; steamId64; nickname; now }): Promise<boolean>;    // W3
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

`packages/api/src/handlers/api.ts` exports `handler(event: APIGatewayProxyEventV2)` (Function URL
payload v2, behind CloudFront). **One bundler, and what is tested is what ships** (decisions
§16.29): `@dst/api`'s `esbuild.mjs` bundles `src/handlers/api.ts` and `src/handlers/reaper.ts` to
**CommonJS** `packages/api/dist/lambda/api.js` and `packages/api/dist/lambda/reaper.js`
(`--platform=node --target=node22 --format=cjs`, AWS SDK bundled, no `--external`), each exporting
`handler`. **That directory is what deploys**: `DstWeb` uploads it verbatim with
`Code.fromAsset(apiBundlePath)` and handlers `api.handler` / `reaper.handler` (`docs/infra.md`
§4.2) — CDK bundles nothing. Per the OAC spike: method from `event.requestContext.http.method`, path from
`event.rawPath` (CloudFront does not rewrite `/api/*`), cookies from `event.cookies`, viewer IP from
`x-forwarded-for` — **never `requestContext.http.sourceIp`** (that is CloudFront's). `headers.host`
is the function URL's host, so the public origin comes from the `PUBLIC_ORIGIN` env var.

**`src/handlers/api.ts` holds no logic** (decisions §16.39). It is the wiring file and nothing else:
construct the adapters of §5.1, construct the SSM `SecretSource` (`docs/auth.md` §4), build the
`Identity` from `src/auth/`, hand them to `router.ts`, export `handler`. All auth logic lives in
`packages/api/src/auth/` (`index.ts` + `*.test.ts` beside it), all reaper logic in
`packages/api/src/reaper/` (§6).

These are the **exact** signatures `src/auth/index.ts` exports and the router calls; a compile-ready
stub can be copied from here verbatim (bodies from `docs/auth.md` §2, §3, §5, §6):

```ts
// packages/api/src/auth/index.ts — the @dst/api/auth subpath. Does NOT re-export TEST_SESSION_SECRET.
export type User = { steamId64: string; nickname: string };
export type AuthResponse = { status: number; headers: Record<string, string>;
                             cookies: string[]; body?: string };

export function beginSteamLogin(deps: AuthDeps): Promise<AuthResponse>;                 // GET /api/auth/steam/login
export function completeSteamLogin(event: HttpRequest, deps: AuthDeps): Promise<AuthResponse>; // GET /api/auth/steam/callback
export function logout(deps: AuthDeps): AuthResponse;                                   // POST /api/auth/logout
export function requireUser(event: HttpRequest, deps: AuthDeps):
  Promise<{ ok: true; user: User } | { ok: false; status: 401 | 403;
            code: 'unauthorized' | 'not_allowed' }>;                                    // docs/auth.md §6
export function mintSessionToken(a: { steamId64: string; sessionKey: Buffer;
                                      nowSec: number }): string;                        // docs/auth.md §5.1
export function verifySessionToken(token: string, sessionKey: Buffer,
                                   nowSec: number): { steamId64: string } | null;       // docs/auth.md §5.2
```

`AuthDeps` is `{ secrets: SecretSource; users: AllowlistSource; nowMs(): number; fetchSteam: typeof fetch }`
— the same port style as §5.1, so the tests and `local.ts` inject fakes and nothing reads a global.

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

These names are the ones `@dst/web`, the e2e suite and `scripts/lifecycle-test.ts` import; none of
them redefines a shape.

```ts
/** decisions §16.9: exactly three fields, nothing else. */
interface WorldSummary { worldId: string; displayName: string; status: ClusterStatus }
interface JoinInfo { serverName: string; ip: string; port: number; password: string; connectCommand: string }
interface ActiveInfo {
  worldId: string; status: ClusterStatus; stale: boolean;
  startedBy: string | null;   // NICKNAME (state.startedByNickname), never a SteamID64
  startedAt: string | null; playerCount: number | null; idleDeadline: string | null;
  join: JoinInfo | null;
}
interface WorldsResponse {
  worlds: WorldSummary[]; active: ActiveInfo | null;
  lastStopReason: StopReason | null; lastError: string | null;   // so the UI can explain a failure
}
interface MeResponse { nickname: string }                        // GET /api/me, or 401
```

`POST /api/worlds/{id}/start` and `.../stop` return **200 with exactly a `WorldsResponse`** built
from the state they just wrote (decisions §16.9), so the SPA needs no second round trip.

Shaping lives in `derive.ts` (pure, unit tested):

- Per-world `status`: `world.worldId === state.worldId ? state.status : 'stopped'`; when
  `state.status === 'stopped'`, every world is `stopped`. `active` is `null` in that case (and when
  `state.worldId === null`). `test-*` worlds are returned like any other; filtering is the SPA's choice.
- `stale = status !== 'stopped' && heartbeatAt !== null && now - heartbeatAt > STALE_HEARTBEAT_MS`
  (decisions §16.8). During boot `heartbeatAt` is still null, so a normal start never shows stale; a
  boot that never reports is the reaper's job (15-minute boot grace), not this flag's.
- `startedBy` is `state.startedByNickname` verbatim — the API wrote it when it started the world, so
  no allowlist lookup happens here. `state.startedBy` (the steamid64) never leaves the Lambda.
- `join` is non-null only when `status === 'running' && publicIp !== null`: `serverName` from the
  registry, `ip` = `publicIp`, `port` = `MASTER_PORT` (10999), `password` from SSM
  `/dst/cluster-password` in **us-west-2** (`PARAM_CACHE_MS` cache, fetched lazily only when a `join`
  block is produced and only after `requireUser` succeeded), and
  ``connectCommand = `c_connect("${ip}", 10999, "${password}")` ``.

### 5.5 Local dev server (`packages/api/src/local.ts`)

`node:http` on **port 8787** (the Vite dev server on 5173 proxies `/api`; `docs/web.md` §6). It
converts `IncomingMessage` into the same payload-v2 shape and calls the same `router`, so there is
exactly one code path. It is started with `APP_ENV=local` by `pnpm dev` and with `APP_ENV=test` by
Playwright (decisions §16.1); it is **never** bundled into a Lambda. Wiring: fake state store, fake
registry (seeded with exactly two worlds, `test-a` and `test-b`), fake parameter store
(`/dst/cluster-password` -> `localpass1`), system clock, the `docs/auth.md` identity for the current
`APP_ENV`, the **test `SecretSource`** — the only place `@dst/api/test-secret` is imported outside
`e2e/` and tests, returning `process.env.DEV_SESSION_SECRET ?? TEST_SESSION_SECRET`
(decisions §16.37, `docs/auth.md` §4) — and a fake launcher whose 1 s ticker drives the state item exactly as the supervisor
would (S1…S8), so every UI state is reachable locally:

| Env var | Default | Effect |
|---|---|---|
| `DST_LOCAL_BOOT_SECONDS` | 12 | `starting` -> `running` (sets `instanceId=i-local1`, `publicIp=203.0.113.10`, `joinableAt`) |
| `DST_LOCAL_STOP_SECONDS` | 8 | `stopping` -> `stopped`, or -> `starting B` when `desiredWorldId` changed |
| `DST_LOCAL_IDLE_MINUTES` | world value | shortens the auto-stop countdown |
| `DST_LOCAL_PLAYERS` | `0,1,2,2,1,0` | player-count cycle, one step per 5 s; `idleDeadline` = last non-zero + idle |
| `DST_LOCAL_LAUNCH_FAIL` | unset | `launch()` throws `InsufficientInstanceCapacity` -> W4 path |
| `DST_LOCAL_STALE` | unset | the ticker stops writing `heartbeatAt` after joinable -> `stale: true` |

#### Local-only routes (decisions §16.4)

Two routes exist **only in this file** — the Lambda entrypoints (`handlers/api.ts`,
`handlers/reaper.ts`) never import it, so no bundler can pull them in. Both are registered through a
helper that references the shared constant `LOCAL_ONLY_MARKER` (`'DST_LOCAL_ONLY'`) at module scope,
so the string survives minification and the orchestrator can prove by `grep` that it is present in
`packages/api/src` and **absent** from `packages/api/dist/lambda/` and `packages/infra/cdk.out/`
(`docs/testing.md` §3). Registration throws if `APP_ENV` is not in the allowed set below, so even a
mistaken import fails closed at init.

| Route | Method | `APP_ENV` | Request | Effect |
|---|---|---|---|---|
| `/api/dev/login` | GET | `local` only | none | mints a session cookie for the fake user `dev-user` / nickname `"Dev"` and 302s to `/`. Developers visit `http://localhost:5173/api/dev/login`; the SPA never links to it |
| `/api/test/control` | POST | `test` or `local` | JSON body (below) | patches the fakes; exempt from the session and CSRF checks |

```jsonc
{ "reset": true }                                   // back to: two worlds (test-a, test-b), stopped
{ "state": { "status": "running", "worldId": "test-a", "playerCount": 2,
             "idleDeadlineInSeconds": 1814 } }      // patch the cluster state item
{ "heartbeatAgeSeconds": 300 }                      // -> API reports stale: true
{ "failNext": { "route": "start", "status": 409 } } // one-shot forced error
{ "bootMs": 1000 }                                  // fake launcher starting -> running delay
```

The env-var switches above are the `pnpm dev` equivalent of the same knobs; `/api/test/control` is
what Playwright drives (`docs/web.md` §7). Nothing in either path exists in production.

## 6. Reaper (`packages/api/src/reaper/`)

**The rules live in `packages/api/src/reaper/`** — `index.ts` exporting `runReaper`, with its tests
next to it (`packages/api/src/reaper/index.test.ts`). **`src/handlers/reaper.ts` is a three-line
Lambda entry** that imports `runReaper`, wires the real adapters, and exports `handler` (decisions
§16.39). Nothing in `handlers/` holds reaper logic, and nothing in `reaper/` touches the AWS SDK
directly — it takes ports, exactly as §5.1 does.

This is the **exact** exported signature; a compile-ready stub can be copied from here verbatim:

```ts
// packages/api/src/reaper/index.ts
export interface ReaperDeps {
  store: StateStore;                  // §5.1, plus the reaper's R1/R2/R3 conditional writes
  ec2: { describeGameInstances(): Promise<ReaperInstance[]>;
         terminate(instanceId: string): Promise<void> };
  clock: Clock;                       // §5.1
}
export interface ReaperInstance { instanceId: string; launchTime: Date; sessionIdTag: string | null }

export async function runReaper(event: { now?: string }, deps: ReaperDeps): Promise<ReaperResult>;
```

EventBridge `rate(5 minutes)`, always enabled. Event: `{ now?: string }`; the override is **clamped
to `max(realNow, eventNow)`** (decisions §16.13):
`now = new Date(Math.max(Date.now(), Date.parse(event.now ?? '') || 0))` — it may only move time
**forward**, i.e. only ever make the reaper more aggressive. The function is invocable only with
IAM credentials.

It returns a JSON summary so a direct invoke is assertable (decisions §16.14):

```ts
interface ReaperResult {
  nulledDesire: string[];                              // instance ids given the graceful R1
  terminated: { instanceId: string; reason: StopReason }[];
  reconciled: boolean;                                 // whether R3 ran
}
```

1. `state = parseClusterState(GetItem{pk:'STATE', sk:'CLUSTER'}, ConsistentRead)`.
2. `DescribeInstances` in us-west-2, paginated,
   `Filters: [{'tag:project': PROJECT}, {'tag:role': 'game'}, {'instance-state-name': ['pending','running']}]`.
3. Per instance, evaluated in this order — **orphan -> max-age -> stale heartbeat** — and the first
   match decides both the action and the reason (at most one action per instance per tick;
   decisions §16.13):
   1. **orphan** — `InstanceId !== state.instanceId` **and** `tag:sessionId !== state.sessionId` ->
      terminate, then R2 with `reaper-stale`. The `and` matters (decisions §16.7): an in-place
      switch changes `state.sessionId` while keeping the instance, and the instance's `sessionId`
      tag is its **launch** session and is never re-tagged — so the instance id still matches.
      While `starting`, `state.instanceId` is null and the tag matches instead.
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
true/false/boot-null; `join` only when running with an ip; `connectCommand` text; `startedBy` is
`startedByNickname` and `worlds[]` items carry exactly `worldId`/`displayName`/`status`; a regex
assertion that `JSON.stringify(response)` contains no 17-digit id.
`ids.test.ts` — `newSessionId()` matches `SESSION_ID_RE`, is 23 chars, sorts by time, and two calls
in the same second differ.
`state-expressions.test.ts` — snapshot every builder's Update/Condition expression; assert `#s`
aliasing and `attribute_type(…, 'NULL')`.

`packages/api`: `start-stop-matrix.test.ts` — every row of §3.2 and §3.3 against the in-memory store
(resulting item, whether `launch()` was called, status, body). `races.test.ts` — the four races of
§3.4 via the interleave hook: same-world double start (exactly one `launch()`), different-world
double start (one 409), stop+start in both orders, W2-vs-S6 in both orders. `launcher.test.ts` —
RunInstances params (template name, ClientToken, all four tags on both instance and volume), AZ
fallback on `InsufficientInstanceCapacity` with a changed token, non-capacity error fails fast,
failure writes W4 and returns 503. `router.test.ts` — path/method table, 404/405, 400 on a bad id,
404 on an unknown world, `cache-control: no-store` everywhere, viewer IP from `x-forwarded-for`,
plus a test titled **exactly** `routes GET /api/me to the auth module`.
`src/reaper/index.test.ts` — fake clock + fake EC2: orphan; a test titled **exactly**
`switched instance is not an orphan`; max age graceful (R1 writes `reaper-max-age`) then hard at
+10 min; stale heartbeat only after the 15 min boot grace; rule order orphan -> max-age -> stale
when several match; reconcile for `running` with no instance, and a test titled **exactly**
`starting without an instance is reconciled after the grace` for the `starting` case younger/older
than 3 min; `now` override only moves forward; the returned `ReaperResult` matches the action taken;
a repeat run performs zero writes.

Three titles above are quoted **verbatim** because the execution plan greps for them character for
character (`grep -cx`): `routes GET /api/me to the auth module`,
`switched instance is not an orphan`, `starting without an instance is reconciled after the grace`.
Do not reword them.

## 9. `scripts/import-world`

One script, `scripts/import-world.ts`, run with `tsx`. It does the registry write (here) and the S3
side (`docs/storage.md` §7) in one pass:

```
pnpm tsx scripts/import-world.ts --world-id <id> [--zip <path>] \
  [--display-name <name>] [--server-name <name>] [--no-caves] [--idle-minutes 30] \
  [--source import|generated|test] [--world-only] [--force] [--help]
```

`--help` prints the usage line and **every** flag above, exits 0, and makes no AWS call
(decisions §16.33 — every script in `scripts/` supports it). **`--help` is parsed and answered
before any precondition, credential check or AWS client construction** (decisions §16.40), so
`env -u AWS_PROFILE pnpm tsx scripts/import-world.ts --help` exits 0 with no credentials at all.
The same rule holds for `scripts/lifecycle-test.ts`, `scripts/mint-cookie.ts` and
`scripts/clean-account-check.sh` (`docs/testing.md` §4, §5.1, §6).

With `--zip`, `--server-name` and `hasCaves` are read out of the zip's `cluster.ini` / `Caves/`
directory and `--display-name` defaults to the server name; the flags are overrides
(`docs/storage.md` §7 step 3). Without `--zip` both `--display-name` and `--server-name` are
required and no S3 object is written. `--world-only` skips the `seed/` upload and this registry
write (used by the disaster-recovery path, `docs/storage.md` §10.5).

Validates `--world-id` against `WORLD_ID_RE` and refuses a `test-` id unless `--source test`. Writes
one item: `PutCommand { TableName: TABLE_NAME, Item: <WorldRegistryItem with pk:'WORLD', sk:worldId,
createdAt: new Date().toISOString()>, ConditionExpression: 'attribute_not_exists(pk)' }` (the
condition is omitted with `--force`). `ConditionalCheckFailedException` -> exit 1 with
"world already registered; pass --force to replace". It never touches the state item and never
launches anything. The `seed/` upload and the `worlds/<worldId>/save.tar.zst` tarball are the same
script's S3 half, documented in `docs/storage.md` §7; a world with no save object is generated on
first boot by the supervisor.

**Unit tests** (`scripts/`, Vitest, no AWS) — these three exist with **exactly** these names, so the
safety refusals are provable rather than assumed:

- `refuses a non-test key` — `assertTestKey` throws for any key or id outside `test-*`.
- `refuses to overwrite seed/` — a second import for an id whose `seed/<id>/` already exists is
  refused (`docs/storage.md` §7).
- `refuses a test- id without --source test` — `--world-id test-x` with no `--source test` exits
  non-zero and says so on stderr.

**Fixtures are generated at test time** (decisions §16.35): the zip, `cluster.ini` and
`cluster_token.txt` these tests need are written into a `mktemp -d` directory and never committed —
`.gitignore` and `scripts/check-secrets.sh` block tracking `*.zip`, `cluster.ini` and
`cluster_token.txt`, so a committed fixture cluster would fail the pre-push hook. In any committed
template or test string the password line reads exactly
`cluster_password = <injected from SSM at boot>` or uses a `${…}` interpolation.
