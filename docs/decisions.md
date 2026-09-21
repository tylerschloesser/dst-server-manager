# Decisions

Settled in the planning session's design review with Tyler on 2026-09-19. **This file is the
source of truth.** Where a research or spike doc disagrees with it, this file wins. Evidence
lives in `docs/research/*.md` and `docs/spikes/*.md`. Nothing here is open.

**Built, deployed and verified.** The three stacks are live, CI deploys on every push to `main`,
the real-AWS lifecycle test passes 42/42, and `tylerni2026` has been booted, played from the game
client, and has stopped itself for idle with its save pushed to S3. Where execution proved a
decision wrong, the decision is **corrected in place and the correction is marked** — see §5
(world generation, measured boot times), §6 (the S8 write), §8 (`shardindex`), §12 (the OIDC
subject) and §16.20 (the budget). Anything deliberately left open is in `docs/follow-ups.md`.

Never in this repo (public): the save, the Klei token, the cluster password, the session-signing
secret, anyone's email, anyone's SteamID64. `scripts/check-secrets.sh` runs as a pre-push hook
(`git config core.hooksPath .githooks`) and in CI.

## 1. Human inputs already collected

| Input | Where it lives | Status |
|---|---|---|
| Klei cluster token | SSM SecureString `/dst/klei-token`, us-west-2 | **stored** (planning session) |
| Cluster password (generated, 10 chars, shared by all worlds) | SSM SecureString `/dst/cluster-password`, us-west-2 | **stored** |
| Allowlist `{ "<steamid64>": "<nickname>" }` | SSM String `/dst/users`, us-east-1 | **stored** (2 users; the lifecycle test may act as any of them) |
| Session-signing secret | SSM SecureString `/dst/session-secret`, us-east-1 | **stored** (generated during execution: random, never printed) |
| Budget alert email | SNS subscription, created once by CLI from `git config user.email`; Tyler clicks the confirmation link | **subscribed and confirmed** |
| Save zip | `~/Downloads/dst-tylerni2026.zip` on Tyler's machine | **uploaded** to `seed/tylerni2026/` |

All four SSM parameters are **human-managed: CDK never creates or owns them**, so a deploy can
never overwrite them. All are tagged `project=dst-server-manager`.

Tyler's answers: generate a cluster password and show it in the UI · backups via S3 versioning +
lifecycle · world switch happens in place on the same instance · max session 12 h · leave CDK
bootstrap v18 in us-west-2 alone · budget $5/month · alerts to his git email · no Steam Web API
key · allowlist in SSM, not in the repo · "create world from the UI" is designed for, not built.

## 2. Architecture

```
Browser -> https://dst.ty.ler.dev -> CloudFront (one distribution)
             /*      -> private S3 site bucket (OAC)            Vite + React + Mantine SPA
             /api/*  -> Lambda Function URL (AWS_IAM + OAC)      Node 22 API (us-east-1)
                          DynamoDB table (us-east-1)             world registry + cluster state
                          EC2 API in us-west-2                   RunInstances / Describe / Terminate
EventBridge rule rate(5 minutes) -> reaper Lambda (us-east-1)    independent backstop
AWS Budget ($5, tag-scoped) -> SNS topic -> email

us-west-2: data bucket, launch template, security group, instance role/profile. No Lambdas.
Game instance: ephemeral c6i.large, Ubuntu 24.04, runs a supervisor that converges on the
desired state stored in DynamoDB. No inbound control channel, no SSH, SSM Session Manager only.
```

Regions: web/control stack **us-east-1**, game stack **us-west-2**. Every stack sets `env`
explicitly. Account `063257577013`. CLI calls always use `AWS_PROFILE=admin` and `--region`.

## 3. Names (deterministic; no `crossRegionReferences`)

| Thing | Name |
|---|---|
| CDK stacks | `DstCi` (us-east-1), `DstGame` (us-west-2), `DstWeb` (us-east-1) |
| Data bucket (us-west-2) | `dst-server-manager-data-063257577013` |
| Site bucket (us-east-1) | `dst-server-manager-site-063257577013` |
| DynamoDB table (us-east-1) | `dst-server-manager` |
| Launch template | `dst-server-manager-game` |
| Security group | `dst-server-manager-game` |
| Instance role / profile | `dst-server-manager-instance` |
| API Lambda / reaper Lambda | `dst-server-manager-api` / `dst-server-manager-reaper` |
| GitHub deploy role | `dst-server-manager-github-deploy` |
| SNS topic / Budget | `dst-server-manager-budget` / `dst-server-manager-monthly` |
| SSM parameters | `/dst/klei-token`, `/dst/cluster-password` (us-west-2); `/dst/users`, `/dst/session-secret` (us-east-1) |
| Tags | everything `project=dst-server-manager`; game instances and their volumes also `role=game`, `sessionId=<id>`, `Name=dst-game` via launch-template + RunInstances `TagSpecifications` |

World ids are URL-safe slugs `[a-z0-9-]{1,32}`. Ids starting with `test-` are reserved for
automated tests. The first real world is `tylerni2026`.

## 4. Repo layout and tooling

pnpm monorepo (corepack, `packageManager` pinned), Node 22, TypeScript strict, ESLint flat config
+ Prettier, Vitest, Playwright, `tsx` for scripts. No global `cdk`; `aws-cdk` is a devDependency.

```
packages/shared      types + constants shared by everything (status enum, state schema, names)
packages/api         Lambda handlers: api (auth, worlds, start/stop) and reaper; local dev server
packages/supervisor  on-instance TypeScript supervisor + assets/ (bash helpers, systemd units, user-data)
packages/web         Vite + React 19 + Mantine 8 SPA
packages/infra       CDK app (DstCi, DstGame, DstWeb)
e2e/                 Playwright tests against the local app
scripts/             check-secrets.sh, import-world, lifecycle test, ops helpers
docs/                domain docs, research, spikes
```

Pinned: `aws-cdk-lib@2.270.0`, `aws-cdk@2.1142.0`, `constructs@10.8.1`, `@mantine/*@^8` (NOT v9),
`@tanstack/react-query@^5`, `@tabler/icons-react`, React 19. Everything else: latest stable at
scaffold time, locked by `pnpm-lock.yaml`. No router (two screens). No CSS files are authored.

## 5. Game instance

- **Ephemeral**: `RunInstances` from the launch template per session; the instance terminates
  itself (`InstanceInitiatedShutdownBehavior=terminate`). No persistent EBS, no custom AMI, no
  Elastic IP, no Spot. Auto-assigned public IPv4. Default VPC, any default public subnet.
- **`c6i.large`**, on-demand, Ubuntu 24.04 x86_64 (AL2023 has no 32-bit userspace for steamcmd),
  AMI resolved from the Canonical SSM public parameter at deploy time, 20 GB gp3 root. The
  instance type is one constant in `packages/shared` (`m6i.large` is the upgrade if an old world
  outgrows 4 GiB). `t3.medium` rejected: permanent CPU-credit deficit even when empty (spike).
- **Security group**: inbound UDP 10998-10999 from anywhere. Nothing else. (Spike: Steam ports
  are not needed.) Master 10999, Caves 10998, fixed for every world since one runs at a time.
- **Boot pipeline** (user-data is a thin, stable bootstrap; the real logic is the runtime bundle
  that CDK deploys to `s3://<data>/runtime/`): dead-man `shutdown -h +780` first; apt packages
  (exact list in the spike doc) and AWS CLI v2; Node 22 (pinned tarball with sha256, cached at
  `runtime-cache/`, origin nodejs.org); fetch `runtime/`; start `dst-supervisor.service`.
- **Binaries**: `binaries/dst-binaries.tar.zst` streamed from S3 straight into `tar` (no temp
  file), then `steamcmd +app_update 343050` **without** `validate`. If the Steam build id changed,
  the supervisor re-creates and uploads the tarball in the background (`nice`/`ionice`) once the
  world is joinable. Missing tarball -> cold steamcmd install with `validate`, then upload. A fresh
  steamcmd's first `app_update` fails transiently (exit 8, `Missing configuration`), so it
  bootstraps in its own invocation and the `app_update` is retried up to 3 times
  (`docs/game-server.md` §4). **Measured click-to-joinable: 333 s cold, 142-164 s from the
  tarball** (the spike's 308 s / 165 s were close).
- **DST processes**: bare steamcmd + systemd, no Docker. `dst-master.service` and
  `dst-caves.service` run `bin64/dontstarve_dedicated_server_nullrenderer_x64`, each with stdin
  from its own FIFO held open by a writer. Worlds with `hasCaves=false` run only the Master.
- **Secrets at boot**: the supervisor writes `cluster_token.txt` from `/dst/klei-token` and sets
  `cluster_password` in `cluster.ini` from `/dst/cluster-password`. Neither is ever in a save
  tarball, a log upload, or supervisor output. It also enforces `console_enabled = true` and a
  pinned Caves shard `id`.
- **Joinable** = Master log shows the Caves shard ready + `Sim paused`, confirmed by a successful
  count-query round trip on every shard (exact regexes: spike doc section 6).
- **Player count** = `max(master.clients, caves.clients, master.allplayers + caves.allplayers)`
  from a nonce'd Lua line written to each shard's FIFO and parsed from that shard's log, skipping
  the `RemoteCommandInput:` echo. **Never use `shard_players:GetNumPlayers()`** (spike: it never
  decays after a player leaves). A missing reply is UNKNOWN, never zero. Cross-check: anchored
  `Sim paused` / `Sim unpaused`.
- **Idle**: poll every 30 s; a reading counts as zero only after 3 consecutive zero polls. The
  idle deadline is `max(joinableAt, last non-zero reading) + idleMinutes` (world attribute,
  default 30). At the deadline -> stop with reason `idle`. A shard process that dies -> stop path
  with reason `crash` (push whatever save exists).
- **Stop sequence** (measured, every step load-bearing): `c_shutdown(true)` into EACH shard's
  FIFO (it does not cascade) -> wait for `Shutting down` in that shard's log -> only then close
  that shard's FIFO writer (otherwise the process hangs) -> a non-zero exit after `Shutting down`
  is benign -> push the save -> upload session logs -> final state write -> `shutdown -h now`.
  If `Shutting down` does not appear within 60 s: SIGTERM (spike: SIGTERM saves), 30 s, SIGKILL.
- **In-session safety copy**: every 10 minutes while running, tar the cluster dir to
  `inflight/<worldId>/save.tar.zst` (no forced `c_save()`; DST autosaves daily in-game). Manual
  recovery only.
- **World switch is in place**: stop A (full stop sequence incl. save push and logs), then pull
  B and start B on the same instance, new `sessionId`-scoped log prefix, same instance.
- **New world generation** (design-for): a registry item with no `worlds/<id>/save.tar.zst` makes
  the supervisor write a cluster from templates and DST generates on first boot. v1 uses this path
  only for `test-*` worlds. No UI form in v1. **Corrected during execution (T4.2).** This bullet
  originally said "complete `leveldataoverride.lua` for BOTH shards". That file is not a partial
  override at all — Klei's own `scripts/shardindex.lua` says it must be a *complete level
  definition*, and a hand-written one is rejected clause by clause by worldgen (`Must specify the
  task set for a level!`, then `Must specify a layout mode for your level.`, …); the shard never
  writes a `save/` and the boot burns the full 15-minute timeout. The templates now write
  `<Shard>/worldgenoverride.lua` naming a **preset** — `SURVIVAL_TOGETHER` for the Master,
  `DST_CAVE` for Caves — and no `leveldataoverride.lua` at all. Naming `DST_CAVE` explicitly is
  still what stops the Caves shard silently generating a second forest. Details:
  `docs/game-server.md` §5.

## 6. State and control (DynamoDB single table, on-demand, `pk`/`sk` strings)

**World registry item** `pk="WORLD"`, `sk=<worldId>`:
`worldId`, `displayName`, `serverName` (the `cluster_name` players see), `hasCaves` (bool),
`idleMinutes` (number, default 30), `createdAt` (ISO), `source` (`import` | `generated` | `test`).
Worlds are added by script (`scripts/import-world`), never hardcoded, never by deploy.

**Cluster state singleton** `pk="STATE"`, `sk="CLUSTER"` (one world at a time, so one item):

| Attribute | Writer | Meaning |
|---|---|---|
| `desiredWorldId` (string or null), `desiredBy` (steamid64), `desiredAt` | API (reaper may null it) | what should be running |
| `status` | API (`stopped`->`starting` only), then supervisor, reaper on reconcile | `stopped` \| `starting` \| `running` \| `stopping` |
| `worldId` | same | the world `status` refers to |
| `sessionId`, `startedBy`, `startedAt` | API at launch; supervisor on switch | current session |
| `instanceId`, `publicIp`, `joinableAt` | supervisor | |
| `playerCount` (number or null), `idleDeadline`, `heartbeatAt` | supervisor, every 30 s | |
| `lastStopReason` | supervisor / reaper | `idle` \| `user` \| `switch` \| `crash` \| `reaper-max-age` \| `reaper-stale` \| `launch-failed` |
| `lastError` | anyone | short string or null |

Per-world status shown in the UI is derived: the world equal to `worldId` has `status`; every
other world is `stopped`. If `heartbeatAt` is older than 2 minutes while not `stopped`, the API
adds `stale: true`.

**Semantics (all conditional writes; idempotent; race-safe):**
- **Start W, status `stopped`**: conditional update `status = stopped` -> `starting`, set
  `desiredWorldId=W`, `worldId=W`, new `sessionId`, `startedBy`; then `RunInstances` with
  `ClientToken=sessionId`. Launch failure -> back to `stopped`, `lastStopReason=launch-failed`.
  Condition failed -> re-read and fall through to the cases below.
- **Start W, already `starting`/`running` W**: 200 no-op.
- **Start W while another world is `running`** (switch) or while `stopping`: conditional update
  of `desiredWorldId=W` only. No new instance. If the condition fails because it just became
  `stopped`, retry as a fresh start.
- **Start W while `starting` a different world**: 409 busy.
- **Stop W**: if W is the active world, set `desiredWorldId=null`; otherwise 200 no-op.
- **Supervisor** polls the state item every 10 s and converges. Its final
  `status=stopped` write is conditional on `desiredWorldId` being null; if that fails, someone
  asked for a world during shutdown, so it starts that world instead of terminating. Every
  supervisor write is conditional on `sessionId`/`instanceId` being its own.
- **A stop the supervisor decides on itself must release its own desire first.** A world that idles
  out (or crashes) is still its own `desiredWorldId` — nobody asked for anything to change — so the
  final `stopped` write's condition can never hold and the branch above restarts the world that
  just timed out, forever. **Added during execution (T5.2) as the write S8**: right after the
  `stopping` write, and only when the stop ends the session and is not a user stop, null
  `desiredWorldId` under the condition that it still names this world. That condition is what keeps
  the start-during-shutdown race intact. Expressions: `docs/control-plane.md` §2.
- Any allowlisted user may start or stop any world. No roles.

## 7. Backstops (independent of the on-instance idle logic)

1. **Reaper Lambda**, EventBridge `rate(5 minutes)`, always enabled ($0). For every
   pending/running instance in us-west-2 tagged `project=dst-server-manager`, `role=game`:
   orphan (its `sessionId`/`instanceId` does not match the state item) -> terminate; age > 12 h ->
   null `desiredWorldId` (graceful), and terminate once age > 12 h 10 min; `heartbeatAt` older
   than 10 min and instance older than 15 min -> terminate. Then reconcile: state not `stopped`
   but no live instance (and, for `starting`, older than 3 min) -> `stopped` with reason.
   Its IAM permission to terminate is conditioned on the project tag. The handler accepts an
   optional `now` override in its event for testing; it can only make the reaper more aggressive
   and the Lambda is invocable only with IAM credentials.
2. **On-instance dead-man**: `shutdown -h +780` as the first user-data line + terminate-on-shutdown.
3. **AWS Budget** $5/month filtered to tag `project=dst-server-manager` (cost-allocation tag
   activated by the execution session; reporting lags 24-72 h), alerts at 50 % and 100 % actual
   and 100 % forecast -> SNS -> email.

## 8. Storage (data bucket, us-west-2, versioned, Block Public Access, SSE-S3)

```
seed/tylerni2026/dst-tylerni2026.zip     the original zip, uploaded once, never touched again
worlds/<worldId>/save.tar.zst            the live save: ONE versioned key per world
inflight/<worldId>/save.tar.zst          10-minute in-session safety copy
sessions/<worldId>/<sessionId>/          manifest.json, master/server_log.txt, caves/server_log.txt,
                                         master/server_chat_log.txt, caves/server_chat_log.txt
binaries/dst-binaries.tar.zst            DST + steamcmd cache (+ binaries/buildid)
runtime/                                 supervisor bundle, bash helpers, unit files (CDK BucketDeployment)
runtime-cache/                           pinned Node tarball
```

- **Backups are S3 versions.** "After each stop" = the save push creates a new version.
  "Before each start" = the supervisor records the `VersionId` it restored as `preStartVersionId`
  in the session manifest (a copy would be byte-identical); the manifest also records
  `postStopVersionId`. Lifecycle, scoped to `worlds/` only:
  `NoncurrentVersionExpiration { NoncurrentDays: 30, NewerNoncurrentVersions: 10 }` -> the current
  version plus the 10 newest older versions are kept forever, regardless of age; S3 never expires
  the current version. `inflight/`: same rule with 3 versions and 7 days. `seed/` and `sessions/`
  have **no** expiration rule.
- **Deletes are denied by bucket policy** (`s3:DeleteObject`, `s3:DeleteObjectVersion`) for
  everyone, using `NotResource` to exempt only `runtime/*`, `runtime-cache/*`, `binaries/*`,
  `worlds/test-*`, `inflight/test-*`, `sessions/test-*`. Lifecycle is not subject to bucket
  policy. With versioning, an accidental overwrite of `seed/` cannot destroy the original. The
  instance and API roles get no write access to `seed/`.
- **Save tarball**: `tar.zst` of the cluster directory contents (`cluster.ini`, `Master/`,
  `Caves/`, ...), **excluding** `cluster_token.txt`, `*/save/server_temp`, `*/save/client_temp`,
  `*/save/cached_userid` (spike: these poison Klei registration on a new IP) and the log files.
  The `cluster_password` line is blanked before tar — **and so is the mirrored `password` value in
  every `<Shard>/save/shardindex`** (added T5.2: DST writes the live settings, password included,
  into its own per-shard save index, so an otherwise clean tarball still shipped the value to a key
  whose deletes are denied). `shardindex` is **blanked, never excluded**: a shard whose `save/` has
  no index reads as an empty slot and DST would generate a new world over the restored one.
- **Session manifest** (`manifest.json`): `sessionId`, `worldId`, `startedBy` (nickname, not
  SteamID), `startedAt`, `joinableAt`, `stoppedAt`, `stopReason`, `peakPlayers`, `instanceType`,
  `dstBuildId`, `preStartVersionId`, `postStopVersionId`. Designed so a later feature can
  LLM-summarize a session from one prefix. Not built now.
- No automated restore. `docs/storage.md` documents where everything lives and the manual
  restore commands.

## 9. Auth

- **Sign in with Steam** (OpenID 2.0), hand-rolled verifier in `packages/api`, zero auth
  dependencies. Implements every item of the verification checklist in
  `docs/research/steam-openid-auth.md` section 3 and the unit tests in section 3bis (forged,
  replayed, wrong endpoint, loose `claimed_id`, unsigned fields, duplicate params, ...). The
  `check_authentication` POST goes only to the hardcoded `https://steamcommunity.com/openid/login`.
  `return_to` and `realm` are built from the env var `PUBLIC_ORIGIN=https://dst.ty.ler.dev`, never
  from request headers (the Lambda sees the origin's Host, not the viewer's).
- **Login CSRF / replay**: single-use signed state cookie (10 min) whose id is bound into
  `return_to?state=`, cleared on callback; `response_nonce` timestamp within +-300 s. No nonce table.
- **Session**: stateless `v1.<env>.<payload>.<HMAC-SHA256>`; key derived by HKDF from
  `/dst/session-secret` with `info` containing the env; the verifier rejects any token whose
  `env` differs from its own. 30 days. Cookie `__Host-dst_session` (HttpOnly, Secure,
  SameSite=Lax, Path=/) in prod; plain `dst_session` without `Secure` in `env=test|local`.
- **Allowlist**: `/dst/users` JSON `{steamid64: nickname}` re-checked on every request (60 s
  in-memory cache) -> removal revokes within a minute. Nicknames are how the UI shows "started
  by". No Steam Web API key.
- **CSRF on mutations**: `Origin` must equal `PUBLIC_ORIGIN` and header `X-DST-Request: 1` must be
  present.
- **Tests get past sign-in with no production backdoor**: the local API runs with `env=test`
  and a test-only secret; Playwright mints a cookie with it. A prod verifier rejects it by `env`
  and by key derivation even if the raw secret leaked.
- Identity is abstracted as `IdentityProvider -> { steamId64 }` so another provider could be
  added; none is built.

## 10. API (Lambda Function URL behind CloudFront `/api/*`)

| Route | Notes |
|---|---|
| `GET /api/auth/steam/login` | 302 to Steam, sets state cookie |
| `GET /api/auth/steam/callback` | verify, set session, 302 `/` (or `/?error=not-allowed`) |
| `POST /api/auth/logout` | clears cookie |
| `GET /api/me` | `{ nickname }` or 401 |
| `GET /api/worlds` | `{ worlds: [...], active: { worldId, status, stale, startedBy, startedAt, playerCount, idleDeadline, join: { serverName, host, ip, port, password, connectCommand } } }` |
| `POST /api/worlds/{id}/start` | **bodyless** |
| `POST /api/worlds/{id}/stop` | **bodyless**, no-op unless `{id}` is the active world |

- Function URL `AuthType=AWS_IAM` + CloudFront OAC (sigv4, always sign). Cache policy
  `CachingDisabled`, origin request policy `AllViewerExceptHostHeader` (mandatory).
- **CDK 2.270's `FunctionUrlOrigin.withOriginAccessControl()` grants only
  `lambda:InvokeFunctionUrl`; CloudFront also needs `lambda:InvokeFunction`** (both scoped by
  `AWS:SourceArn` to the distribution). Add it explicitly. `AccessDeniedException` = permissions,
  `InvalidSignatureException` = body hash.
- POSTs with a body need `x-amz-content-sha256`; bodyless POSTs do not (measured). All v1
  mutations are bodyless, so no fetch wrapper is needed.
- Viewer IP comes from `x-forwarded-for`, never `requestContext.sourceIp`.
- The join password is read from `/dst/cluster-password` (us-west-2) and returned only to
  authenticated, allowlisted users. `connectCommand` is
  `c_connect("play.dst.ty.ler.dev", 10999, "<password>")` — the **hostname**, never the session's
  IP, so the command is the same every session (§17). `join.host` is that hostname and `join.ip`
  is this session's raw address, kept as the fallback the UI shows while DNS is still catching up.
- The handler is written against ports (state store, registry, EC2 launcher, parameter store,
  clock) with AWS adapters for prod and in-memory fakes for local dev and tests. The local fake
  launcher walks `starting -> running` on a timer so every UI state is reachable locally.

## 11. Web

Mantine 8 (`AppShell`, `Card`, `Badge`, `Button` loading state, `Modal` for stop/switch
confirmation, `Notifications`, `Skeleton`, `CopyButton`), dark mode by default, phone-first.
TanStack Query polls `GET /api/worlds`: every 5 s while anything is not `stopped`, every 30 s
otherwise, paused when the tab is hidden. Countdown to auto-stop from `idleDeadline` with a small
`useCountdown` hook. Sign-in screen with one "Sign in with Steam" button. Vite dev server proxies
`/api` to the local API.

## 12. Infra and deploy

- **DNS**: no hosted zone is created. `HostedZone.fromHostedZoneAttributes` with
  `Z038502736IM0QLQT7VFN` / `ty.ler.dev`; CDK writes only the ACM validation CNAME and the
  `dst.ty.ler.dev` A + AAAA aliases — the stacks own exactly **two** `AWS::Route53::RecordSet`
  resources and that count is asserted. There is exactly one more record in this zone that belongs
  to this project, `play.dst.ty.ler.dev`, and it is written **at runtime** by the instance and the
  reaper, never by CloudFormation (§17). No other record is ever touched, and the IAM condition
  keys on both roles make that enforceable rather than a convention.
- **OIDC**: the provider already exists; import with `fromOpenIdConnectProviderArn`. `DstCi`
  creates `dst-server-manager-github-deploy`, trust `sub =
  repo:tylerschloesser@2300885/dst-server-manager@1377732613:ref:refs/heads/main`,
  `aud = sts.amazonaws.com`, permission only `sts:AssumeRole` on the `cdk-hnb659fds-*` roles in
  both regions. `DstCi` is deployed once locally and is **not** deployed by the workflow.
  **Corrected during execution (T6.1).** This section was written against the classic
  `repo:<owner>/<repo>:ref:...` subject, but GitHub issues an **immutable** subject for this repo
  that embeds the numeric owner and repository ids, so the classic form is never presented and the
  trust policy silently matched nothing — the first CI runs failed with "Not authorized to perform
  sts:AssumeRoleWithWebIdentity". Re-derive with
  `gh api repos/tylerschloesser/dst-server-manager/actions/oidc/customization/sub`; the exact value
  in use was read from CloudTrail's `AccessDenied` `AssumeRoleWithWebIdentity` event
  (`userIdentity.userName`). The immutable form is the stronger one: a repo renamed or re-created
  under the same name gets new ids and cannot inherit this trust. Still `StringEquals`, never
  `StringLike`.
- **Bootstrap**: us-east-1 v30 and us-west-2 v18 are both sufficient. Do not re-bootstrap.
- **Workflow** (`.github/workflows/deploy.yml`, on push to `main`): install with frozen lockfile,
  `scripts/check-secrets.sh`, lint, typecheck, unit tests, build, then
  `cdk deploy DstGame DstWeb --require-approval never`.
- **Ordering**: everything is built and green locally first; stacks are deployed locally with the
  admin profile and verified; the workflow file is committed **last**, so `main` never deploys a
  half-built stack. After that, `main` stays deployable.
- Git: work on `main`, no branches or PRs, small commits, push often, annotated milestone tags:
  `plan-complete`, `exec-start`, `scaffold`, `local-green`, `infra-deployed`, `first-boot`,
  `lifecycle-verified`, `ci-live`, `real-world-verified`, `v1.0.0`.

## 13. Testing

- **Local, no AWS credentials**: lint, typecheck, Vitest (Steam verifier vs forged/replayed
  assertions; session tokens incl. cross-env rejection; state-machine semantics of section 6;
  supervisor idle logic incl. UNKNOWN readings, shard crash, 3-zero rule; reaper rules with a fake
  clock; CDK assertions for the bucket policy, lifecycle rules, SG ports, both Lambda
  permissions, tag specs), build, Playwright against the local app (phone and desktop viewports).
- **Lifecycle test on real AWS** (`scripts/lifecycle-test.ts`, admin profile, goes through the
  real CloudFront URL with a session cookie it mints from `/dst/session-secret`): worlds
  `test-lifecycle-a` (caves, generated, `idleMinutes=3`) and `test-lifecycle-b` (no caves).
  Covers: start, joinable, `preStartVersionId` recorded, idle shutdown, instance gone, new save
  version exists, world switch in place, lifecycle/bucket-policy config asserted, reaper
  stale-heartbeat kill, reaper max-age via the `now` override. Cleans up its `test-*` objects.
  **As built: 11 phases (0-10), 42 assertions, ~36.5 min and ≈$0.16 per full run** — and it is
  re-runnable back to back without `--cleanup-only`, which required a pre-run reset of its own
  `test-*` artefacts (`docs/testing.md` §4.4).
- **Real world**: one final boot of `tylerni2026`, then Tyler joins from the game client. **Done:**
  164 s to joinable, played from the game client, stopped itself for idle unattended with the save
  pushed to S3.
- Tyler's real save is never used by automated tests. The seed zip is never modified.

## 14. Cost (us-west-2 compute; AWS Price List API, 2026-09-19)

| Item | Idle month | ~20 h of play (~24 instance-hours) |
|---|---|---|
| EC2 `c6i.large` $0.085/h | $0 | $2.04 |
| Public IPv4 $0.005/h | $0 | $0.12 |
| EBS gp3 20 GB, prorated | $0 | $0.05 |
| S3 (~3.3 GB binaries cache + saves, versions, logs) | $0.09 | $0.10 |
| Data transfer out (< 100 GB free tier) | $0 | $0 |
| CloudFront, Lambda, DynamoDB, EventBridge, SSM, ACM, Budgets, Route 53 alias queries | $0 | ~$0.01 |
| CloudWatch Logs | <$0.01 | ~$0.03 |
| **Total** | **~$0.10** | **~$2.35** |

## 15. Explicitly not in v1

Create-world form, Steam Web API key / avatars, Google sign-in, LLM session summaries, automated
restore, Spot, custom AMI, per-world passwords, roles/permissions.

## 16. Clarifications (added after the domain docs were drafted; these override any doc that differs)

**Identity and naming**
1. `APP_ENV` is the env discriminator: `prod` | `test` | `local`. The deployed Lambda sets
   `APP_ENV=prod`. `pnpm dev` runs the local API entrypoint with `local`; Playwright runs the same
   entrypoint with `test`. The string inside session tokens is the same value.
2. Workspace packages are named `@dst/shared`, `@dst/api`, `@dst/supervisor`, `@dst/web`,
   `@dst/infra`. API types and constants are defined once in `@dst/shared` and imported
   everywhere; no package redefines them. `docs/control-plane.md` owns their names.
3. `sessionId` format is `YYYYMMDDTHHMMSSZ-<6 lowercase hex>` (UTC), e.g.
   `20260919T201355Z-a1b2c3`: sortable, a valid EC2 `ClientToken`, and the S3 log prefix. The API
   mints it at launch; the supervisor mints a new one for the session it starts after an in-place
   switch. AZ fallback retries use `ClientToken=<sessionId>-az<n>`.
4. Local-only code (dev login route, test control route) lives only in the local server
   entrypoint and carries the marker constant `DST_LOCAL_ONLY`; the orchestrator proves by `grep`
   that the marker is absent from the built Lambda bundles.
5. Caves shard id is pinned to `2` (`CAVES_SHARD_ID` in `@dst/shared`). The cluster directory on
   the instance is named after the `worldId`.

**State and API**
6. The state item also carries `desiredByNickname` and `startedByNickname`, written by the API
   (it already knows the nickname). The supervisor copies `desiredByNickname` to
   `startedByNickname` on an in-place switch and uses it for the session manifest. **The instance
   never reads `/dst/users`** and has no IAM access to it. The reaper writes `desiredBy="reaper"`.
7. The instance's `sessionId` tag is its **launch** session and is never re-tagged (the instance
   role has no `ec2:CreateTags`). It reaches the supervisor via IMDS instance tags
   (`InstanceMetadataTags=enabled`). **Orphan rule**: an instance is an orphan only if BOTH its
   instance id differs from `state.instanceId` AND its `sessionId` tag differs from
   `state.sessionId`. (While `starting`, `state.instanceId` is null and the tag matches; after a
   switch, the instance id matches.)
8. `stale` is reported only when `heartbeatAt` is non-null and older than 2 minutes. A boot that
   never reports is the reaper's job (15-minute boot grace).
9. `POST start` / `POST stop` return `200` with the same body as `GET /api/worlds`; `409` with
   code `world_busy` or `state_conflict`; `503` `launch_failed`. `GET /api/worlds` additionally
   exposes top-level `lastStopReason` and `lastError`. `active` is `null` when status is
   `stopped`. Each `worlds[]` item is `{ worldId, displayName, status }`.
10. The final `stopped` write keeps `worldId` (so `lastStopReason` has an owner) and nulls
    `sessionId`, `instanceId`, `publicIp`, `joinableAt`, `playerCount`, `idleDeadline`,
    `heartbeatAt`.
11. "Stop W" only acts when W is the active `worldId`. Stopping a queued switch target is a
    no-op; a queued switch is cancelled by pressing Start on the running world.
12. Auth redirects are the closed set `/`, `/?login=cancelled`, `/?error=not-allowed`,
    `/?error=steam-unavailable`, `/?error=login-failed`. The SPA still sends `X-DST-Request: 1` on
    every POST ("no fetch wrapper" in section 10 refers only to the body hash).

**Reaper**
13. Rules are evaluated per instance in the order orphan -> max-age -> stale heartbeat; the first
    match decides the action and the reason. A graceful max-age stop also records
    `lastStopReason=reaper-max-age` (the reaper writes it when it nulls `desiredWorldId`; the
    supervisor does not overwrite a `reaper-*` reason). Reconcile-to-stopped without a specific
    cause uses `reaper-stale`. The `now` override is clamped to `max(realNow, eventNow)`.
14. The reaper returns a JSON summary `{ nulledDesire, terminated: [{instanceId, reason}],
    reconciled }` so direct-invoke tests can assert on it.
15. A boot that does not become joinable within 15 minutes takes the stop path with
    `lastStopReason=crash` and a `lastError`. **The save is pushed only if the Master logged a
    completed world load** (`LOAD BE: done`), so a failed boot can never overwrite a good save.

**Infra**
16. "No Lambdas in us-west-2" means no application Lambdas; the `BucketDeployment`
    custom-resource Lambda is expected. The launch template sets tags `project`, `role`, `Name`;
    `RunInstances` repeats them and adds `sessionId`. The launch template has no
    `NetworkInterfaces` block; `RunInstances` passes `SubnetId`, and the public IP comes from the
    default subnet's `MapPublicIpOnLaunch`.
17. The API role gets `ssm:GetParameter` on `/dst/cluster-password` in us-west-2 plus
    `kms:Decrypt` conditioned on `kms:ViaService=ssm.us-west-2.amazonaws.com` (and the same for
    `/dst/session-secret` in us-east-1). The API Lambda has no S3 access.
18. Site bucket: `RemovalPolicy.RETAIN`, no `autoDeleteObjects`. Lambdas run on ARM64, Node 22.
    DynamoDB via `TableV2`.
19. The data bucket also has one bucket-wide lifecycle rule that only aborts incomplete
    multipart uploads after 7 days. It expires no objects.
20. If `CfnBudget` rejects the tag cost filter because the cost-allocation tag is not active
    yet, deploy with context `budgetEnabled=false`, finish everything else, then activate the tag
    and redeploy without the flag, recording it in `docs/follow-ups.md` until it is done.
    Everything else proceeds; the reaper and the dead-man do not depend on the budget.
    **Not needed in the end:** the `project` cost-allocation tag activated and
    `dst-server-manager-monthly` deployed with its tag filter on the first try, and the SNS email
    subscription was confirmed. `budgetEnabled` was never set to `false`.
21. CSP: `script-src 'self'`; therefore the SPA must not use Mantine's inline
    `<ColorSchemeScript>`; `defaultColorScheme="dark"`, no toggle, plain `Modal` (no
    `@mantine/modals`).

**Storage**
22. The save tarball has the cluster directory's **contents at the archive root** (no wrapper
    directory; do not copy the spike's `dst-save-push` verbatim). Excludes additionally `*/backup`
    (old rotated logs; not the `c_rollback` snapshots). `supervisor.log` is uploaded to the
    session prefix alongside the four DST log files. Before any upload, logs are scrubbed by
    exact match against the token and password values.
23. The lifecycle test keeps only `worlds/test-prune/save.tar.zst` (evidence for the asynchronous
    pruning rule); `--cleanup-only` removes it. The delete-denied probe targets a nonexistent
    non-`test-` key, so it leaves no residue.
24. Playwright (`pnpm e2e`) is part of `pnpm check` locally but not part of the deploy workflow.
25. Local development: Vite on `http://localhost:5173` proxies `/api` to the local API on port
    8787; the local `PUBLIC_ORIGIN` is `http://localhost:5173`. The local fake registry seeds two
    worlds, `test-a` and `test-b`.
26. `RunInstances` uses launch-template version `$Latest`. Lambda entry files are
    `packages/api/src/handlers/{api,reaper}.ts`, bundled to `packages/api/dist/lambda/{api,reaper}.js`.
    The supervisor bundle is `packages/supervisor/dist/supervisor.js`, staged with its assets into
    `packages/supervisor/dist/runtime/`, which is what CDK deploys to `runtime/`.
27. One script registers worlds: `pnpm tsx scripts/import-world.ts --world-id <id> [--zip <path>] ...`
    (flags in `docs/control-plane.md` section 9). Lifecycle-test worlds use `source=test`.
28. SPA response headers: `Referrer-Policy: no-referrer`, HSTS with `includeSubDomains`, CSP as in
    `docs/auth.md` section 8.

**Build and test plumbing (added after a cold review of the execution plan, before any code)**
29. **One bundler, and what is tested is what ships.** `@dst/api`'s esbuild script produces
    `packages/api/dist/lambda/api.js` and `reaper.js` (CommonJS, Node 22, AWS SDK bundled). CDK
    deploys exactly that directory: `lambda.Function` with `Code.fromAsset(<apiBundlePath>)` and
    handlers `api.handler` / `reaper.handler`. **No `NodejsFunction`, no bundling inside CDK, no
    Docker.** The `DST_LOCAL_ONLY` and test-secret greps run against both `packages/api/dist/lambda/`
    and `packages/infra/cdk.out/`.
30. Every file CDK reads from another package is resolved through context, with these defaults:
    `apiBundlePath=../api/dist/lambda`, `supervisorBundlePath=../supervisor/dist/runtime`,
    `webDistPath=../web/dist`, `userDataPath=../supervisor/assets/user-data.sh`. CDK assertion tests and the one credentialed synth that caches
    `cdk.context.json` point all four at committed fixtures under `packages/infra/test/fixtures/` (`api-bundle/`,
    `supervisor-bundle/`, `web-dist/`, `user-data.sh`), so the infra package never depends on
    another package's files except in the real `pnpm build` and deploy.
    `pnpm build` builds the packages first and runs `cdk synth` last.
31. `cdk` commands take no `--region` (each stack sets `env`). The stack owns two Route 53 record
    sets (`A` and `AAAA` for `dst.ty.ler.dev`); the ACM validation CNAME is written by ACM through
    the hosted-zone id and is not a CloudFormation record.
32. Workspace wiring: the root package depends on `@dst/shared` and `@dst/api` via `workspace:*`
    so `e2e/` and `scripts/` can import them (session minting is imported from `@dst/api`, never
    re-implemented). Packages export TypeScript source through an `exports` map (`tsx`, Vitest and
    esbuild resolve it); nothing consumes a compiled `@dst/*` package.
33. Scripts: `scripts/import-world.ts`, `scripts/lifecycle-test.ts`, `scripts/mint-cookie.ts`
    (prints only a `Cookie:` header value for an allowlisted user, minted from `/dst/session-secret`
    with the admin profile; used to start the real world from the CLI), and
    `scripts/clean-account-check.sh` (asserts; one `PASS`/`FAIL <check>` line per item; exits
    non-zero on any violation; the only hardcoded exceptions are `worlds/test-prune/save.tar.zst`
    and tagged EC2 ARNs whose instance state is `terminated`). Every script supports `--help`
    (usage and every flag, exit 0, no AWS call).
34. Playwright config is `playwright.config.ts` at the repo root with `testDir: 'e2e/tests'`. Its
    web servers are the local API
    (`APP_ENV=test PUBLIC_ORIGIN=http://localhost:5173 pnpm --filter @dst/api exec tsx src/local.ts`,
    port 8787) and Vite (port 5173).
35. Test fixtures that look like save files (`cluster.ini`, `cluster_token.txt`, `*.zip`) are
    generated at test time in a temp directory and never committed; `.gitignore` and
    `scripts/check-secrets.sh` forbid tracking them. In any committed template or test string the
    password line reads exactly `cluster_password = <injected from SSM at boot>` or uses a `${...}`
    interpolation.
36. The save tarball is produced one way everywhere (`docs/storage.md` section 6): stage a copy of
    the cluster directory, blank the password in the staged `cluster.ini`, run the single tar
    command with the single exclude list. `import-world` and the supervisor's `dst-pack-save` both
    do exactly this.
37. **The test-only session secret never enters the Lambda's import graph.** It lives in
    `packages/api/src/auth/testSecret.ts` (constant `TEST_SESSION_SECRET`, marked
    `DST_LOCAL_ONLY`), exported only through the subpath `@dst/api/test-secret`, and imported only
    by `src/local.ts`, `e2e/` and tests. `src/auth/index.ts` does not re-export it. The secret is
    supplied through a `SecretSource` port: the Lambda entry wires the SSM source (reads only
    `/dst/session-secret`); `local.ts` wires the test source. `@dst/api`'s `exports` map is
    `"."`, `"./auth"`, `"./test-secret"`. The grep for the secret's literal in `dist/lambda/` and
    `cdk.out/` must find nothing.
38. `packages/supervisor/assets/node.env` is exactly two `KEY=value` lines, no quotes, no
    `export`, no comments: `NODE_VERSION=v22.x.y` and `NODE_SHA256=<64 lowercase hex>`. CDK's
    `readNodeEnv` reads it from the directory of `userDataPath`, splits on the first `=` per line,
    and throws if a key is missing or the hash is not 64 hex characters.
39. Reaper logic lives in `packages/api/src/reaper/` (`index.ts` exporting `runReaper`, plus its
    tests); `src/handlers/reaper.ts` is a three-line Lambda entry. Likewise all auth logic lives in
    `src/auth/`; `src/handlers/api.ts` only wires ports and the router.
40. The root Vitest config includes `scripts/**/*.test.ts`; root `pnpm test` runs it and every
    package's tests. Every `test` script passes `--passWithNoTests`. Every script answers
    `--help` before any precondition, credential check, or AWS client construction.

## 17. Stable join hostname and the "Launch DST" button

**Decided 2026-09-21, after the system was live.** The page is the entrypoint, so the join step
should not be a fresh copy/paste every session.

**The problem.** The instance gets a new auto-assigned public IPv4 on every boot — deliberately:
an idle Elastic IP costs $3.65/month, 36× the whole idle bill, and was rejected in
`docs/research/on-demand-game-servers.md`. So the `c_connect("<ip>", ...)` string the site showed
was different every session.

**Measured, so it is never re-litigated: there is no browser → Steam → DST auto-connect link.**
`steam://connect/<ip>:<port>` only works for the Source-engine titles Valve registered a handler
for; Steam deliberately **ignores** arguments passed through `steam://run/<appid>//<args>`; and the
DST client has no join launch parameter (the game scripts contain no `connect_lobby` /
`auto_connect` — the only join paths are the server browser and `c_connect` →
`TheNet:StartClient`). Removing the console step entirely would take a client-side Workshop mod
installed on every friend's machine, plus a public join-info endpoint. Out of scope for v1.

**What ships instead**, which is most of the value:

1. **`play.dst.ty.ler.dev`** — an **A record, TTL 60**, in the existing zone. `c_connect` accepts a
   hostname, so the join command becomes **constant forever**: copy it once, keep it, reuse it
   every session.
2. **A `steam://run/322330` "Launch DST" button** on the join panel, in both the `starting` and
   `running` states (the client takes a while to load, so launching early is useful).

Flow: page → Start → Launch DST → paste the *same saved* command (or Browse Games by name, which
never needed the IP).

**The record is written at runtime, never as a CDK resource** — like the four human-managed SSM
parameters. The stacks keep owning exactly two `AWS::Route53::RecordSet`s. A CDK-owned record would
be re-materialized by a deploy in the middle of a live session, resetting it.

- **Boot**: the supervisor `UPSERT`s the record to its own public IP immediately after it owns the
  session (S1 claimed, or a resume onto a session already its own) and before DST starts, so it
  propagates during the ~2.5 min boot.
- **Shutdown**: every halt path `UPSERT`s it to the sink **`192.0.2.1`** (RFC 5737 TEST-NET-1,
  routes nowhere) rather than deleting it. `UPSERT` is idempotent and needs no knowledge of the
  current value, where a Route 53 `DELETE` must match the existing RRSet exactly; and a sink beats
  a stale record, because a record left pointing at a released EC2 address would aim friends at
  whatever stranger AWS hands that IP to next. The sink lives in one place, `haltNow`, which is the
  supervisor's only `shutdownNow` call site.
- **An in-place world switch must not sink it** — same instance, same IP. That falls out of the
  placement: a switch does not halt.
- **Backstop**: the reaper sinks it too, at most once per run, on every branch that terminates or
  finalizes `stopped` — for the instance that dies without getting an AWS call out
  (`dst-panic.service`, the dead-man `shutdown`, a hard crash, a reaper termination). Never on a
  no-op run.
- **A failed Route 53 call is logged, never fatal.** The raw IP is still in the state item and
  still shown in the UI, and DNS must never be able to block a boot or — far worse — a stop.
- **IAM**: both roles get `route53:ChangeResourceRecordSets` on the zone ARN, narrowed by
  `ForAllValues:StringEquals` on
  `route53:ChangeResourceRecordSetsNormalizedRecordNames = [play.dst.ty.ler.dev]` and
  `...RecordTypes = [A]`. That condition is what makes "this project may only touch its own record"
  an IAM fact: the instance, the least-trusted component here, cannot rewrite `dst.ty.ler.dev`.
  The normalized name is lowercase with no trailing dot.

**Rejected**: a DynamoDB-stream Lambda mirroring `publicIp` into DNS (cleanest separation, but a
new always-present resource for something the supervisor already knows first-hand); reconciling in
the reaper alone (`rate(5 minutes)` is too slow for a 2.7 min boot and would leave a live IP
published for up to 5 min after a stop); an Elastic IP (cost). `docs/research/` stays as written —
its "a Route 53 update-on-boot is not worth it" call is reversed here, and the research directory
is read-only history.

**Residual**: an instance killed with no AWS call out leaves the record pointing at a released
address for up to one reaper tick (5 min) plus the 60 s TTL. Accepted; the alternative is a
systemd `ExecStop` unit, and the reaper is already the documented backstop for exactly those
paths.
