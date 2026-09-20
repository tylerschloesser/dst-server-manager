# First-boot notes

Append-only log of the Phase 4 fix rounds (`PLAN.md` T4.x): what broke the first time a real
instance was asked to launch, why, and what was changed. Newest round at the bottom. Nothing
secret goes in here: no Klei token, no cluster password, no SteamID64, no email.

## Round 1 (T4.2) — `POST start` returned 503 `launch_failed`

**Symptom.** `AWS_PROFILE=admin pnpm lifecycle-test --until-phase 1` exited 1 with a single
failure:

```
FAIL  phase 1  POST start test-lifecycle-a returns 200  (1354ms) - status 503
```

Phase 0 passed completely (5 assertions). The cluster state item showed the state machine had
rolled back exactly as decisions.md §6 / W4 specifies — `status=stopped`, `desiredWorldId` null,
`lastStopReason=launch-failed`, `lastError` = `UnauthorizedOperation: You are not authorized to
perform this operation. User: …/dst-server-manager-api` (truncated to 160 chars by the launcher's
`describeError`). Nothing in the state machine was wrong.

**Root cause.** The API Lambda's `RunInstances` call was denied by IAM. CloudTrail
(`lookup-events --region us-west-2 --lookup-attributes AttributeKey=EventName,AttributeValue=RunInstances`)
gave the resource the role was missing, which the truncated `lastError` had cut off:

```
not authorized to perform: ec2:RunInstances on resource:
arn:aws:ec2:us-west-2::image/ami-04678417fc39d7171
```

Note the **empty account field**. The launch template's AMI is Canonical's public Ubuntu 24.04
image (owner `099720109477`, resolved from the SSM public parameter at deploy time), and IAM
identifies an AMI that the calling account does not own by an ARN with no account id. The
`DstWeb` API role granted `ec2:RunInstances` on
`arn:aws:ec2:us-west-2:<account>:image/*`, which matches nothing for a public AMI, so every launch
was denied at the image resource. Everything else in the statement list of
`docs/control-plane.md` §7 (`launch-template/*`, `subnet/*`, `security-group/*`,
`network-interface/*`, the tag-conditioned `instance/*` + `volume/*`, `ec2:CreateTags` with
`ec2:CreateAction=RunInstances`, `iam:PassRole` on `dst-server-manager-instance`,
`ec2:Describe{Instances,Subnets,Vpcs}`) was already correct and deployed; nothing else was
missing. Verified action-by-action against what the launcher adapter actually calls
(`packages/api/src/adapters/ec2-launcher.ts`: `DescribeVpcs`, `DescribeSubnets`, `RunInstances`
with `TagSpecifications` for instance and volume — no other EC2 or IAM call).

Checked and deliberately **not** granted: KMS. The launch template creates an encrypted gp3 root
volume with the AWS-managed `aws/ebs` key, whose key policy grants
`kms:Encrypt|Decrypt|ReEncrypt*|GenerateDataKey*|CreateGrant|DescribeKey` to `Principal: "*"`
conditioned on `kms:ViaService=ec2.us-west-2.amazonaws.com` + `kms:CallerAccount=<account>`, so no
identity-based KMS statement is needed for the launch.

**Fix.** One ARN in the `RunInstancesResources` statement of the `DstWeb` stack:
`arn:aws:ec2:${GAME_REGION}:${ACCOUNT_ID}:image/*` → `arn:aws:ec2:${GAME_REGION}::image/*`
(account-agnostic image ARN, still region- and action-scoped; this is *narrower* in practice than
adding a wildcard account). No other permission was added or widened; the reaper's
tag-conditioned `ec2:TerminateInstances` grant is unchanged and the two roles still follow the
same `addToRolePolicy` + `sid` pattern.

**Files changed.**

- `packages/infra/lib/web-stack.ts` — the image ARN, plus a comment recording why the account
  field must be empty.
- `packages/infra/test/web-stack.test.ts` — new CDK assertion `17ter.` over the
  `ApiServiceRoleDefaultPolicy` document: the exact `RunInstancesResources` resource set
  (including `arn:aws:ec2:us-west-2::image/*`), the tag conditions on the instance/volume
  `RunInstances` statement, `ec2:CreateTags` conditioned on `ec2:CreateAction=RunInstances`,
  `iam:PassRole` scoped to the instance role with `iam:PassedToService=ec2.amazonaws.com`, the
  three `Describe*` actions, and the reaper's tag-conditioned terminate. Reverting the one-ARN
  fix makes this test fail (checked).
- `docs/_first-boot-notes.md` — this file.

**Deploy.** `cdk diff DstWeb` showed exactly one change: that IAM statement (plus a
`BucketDeployment` source-key change in the dependency stack `DstGame` from the rebuilt runtime
bundle). No hosted zone, no OIDC provider, no record-set changes.
`cdk deploy DstWeb --require-approval never`: DstGame 21 s, DstWeb 28 s, 78 s total.

## Round 1b (T4.2, same fix round) — the instance powered itself off ~35 s into every boot

With the IAM fix deployed, `POST start` returned 200 and the instance launched with the right tags,
type and security group (11 of 12 assertions passed), but phase 1 then failed:

```
FAIL  phase 1  status reaches running within 15min with valid join info  (900065ms)
              — timed out waiting for status=running after 900s
```

Observed three times: the instance boots, `user-data` completes (apt + Node + `runtime/` sync in
~51 s), the supervisor starts, writes S1 (`instanceId`, `publicIp`, `heartbeatAt`), and the
machine powers off ~25-35 s later. The console output ends in a clean systemd poweroff
(`reboot: Power down` at 81.9 s of uptime); `terminate-on-shutdown` then terminates the instance,
and the reaper reconciles the state item to `stopped` with `lastStopReason=reaper-stale`,
`lastError="reaper: reconciled — no live instance"` — which is also why the supervisor's own
`lastError` never survives to be read. No `TerminateInstances` call appears in CloudTrail, so the
poweroff came from inside the instance; nothing was uploaded under `sessions/`.

**How it was caught.** The instance is gone before anyone can log in, so: a `shutdown` wrapper was
installed at `/usr/local/sbin/shutdown` (it shadows `/sbin/shutdown` in the service PATH and only
appends to a log) over SSM Session-Manager-style `AWS-RunShellScript`, ~16 s after launch and well
before the supervisor starts. The instance then stays alive when the supervisor asks to halt.
(Careful: `> /sbin/shutdown` follows that symlink and overwrites `/bin/systemctl`. Write the
shadowing wrapper, never the symlink.)

**Two defects, both on the instance:**

1. **`dst-install-binaries` does not retry `steamcmd`.** The cold path (no
   `binaries/dst-binaries.tar.zst` in S3 yet — true on a first boot) downloads a fresh steamcmd,
   which self-updates on its first invocation (`Restarting steamcmd by request...`) and then fails
   the `app_update` in that same invocation with exit **8** and, in
   `/opt/dst/Steam/logs/content_log.txt`, `Failed installing AppID 343050 (Missing configuration)`
   — measured 3 s into the run in one case, ~23 s (22 % downloaded) in another, so it is a
   transient, not a config error. `installBinaries()` treats a non-zero exit as fatal, so the
   supervisor died with `supervisor_fatal Command failed: /usr/local/bin/dst-install-binaries`.
   The same command run a second time always succeeded (measured: exit 0, 225 s cold, and the
   supervisor's own auto-restart got to 53 % before being stopped by hand).
2. **`dst-panic.service` fired on the *first* supervisor crash, not on a crash loop.** systemd
   triggers `OnFailure=` whenever the unit enters `failed` state — which happens before every
   scheduled auto-restart, not only once `StartLimitBurst` is exhausted. The journal is explicit:

   ```
   dst-supervisor.service: Main process exited, code=exited, status=1/FAILURE
   dst-supervisor.service: Triggering OnFailure= dependencies.
   Starting dst-panic.service ...
   dst-supervisor.service: Scheduled restart job, restart counter is at 1.
   ```

   So `dst-cluster-stop; shutdown -h now` ran while `Restart=on-failure` was still going to retry
   (and the retry would have worked). This contradicts `docs/game-server.md` §6/§8, which state
   that the panic handler takes over only "past the start limit".

**Fix.**

- `packages/supervisor/assets/bin/dst-install-binaries`: a fresh steamcmd now bootstraps in an
  invocation of its own (`./steamcmd.sh +quit`, non-fatal), and the `app_update` runs through a
  `steam_app_update()` helper that retries up to 3 times with a 10 s pause. Both the warm and the
  cold path use it; the warm path still never passes `validate`, the cold path still does.
- `packages/supervisor/assets/systemd/dst-panic.service`: the handler now waits up to 120 s
  (24 × 5 s) for `dst-supervisor.service` to become active again and exits 0 if it does, so a
  single crash is retried as designed; only a supervisor that stays dead (start limit reached)
  gets `dst-cluster-stop; shutdown -h now`. `TimeoutStartSec=300` bounds the wait. The backstops
  are untouched: the dead-man `shutdown -h +780`, terminate-on-shutdown, and the reaper's
  stale-heartbeat rule (~15 min) all still collect a wedged instance.

**Files changed.** `packages/supervisor/assets/bin/dst-install-binaries`,
`packages/supervisor/assets/systemd/dst-panic.service`, `docs/_first-boot-notes.md`.

**Doc follow-up (not done here — `docs/` is owned by another task):** `docs/game-server.md` §6
quotes the old `dst-panic.service` `ExecStart` line and §4 does not mention the steamcmd retry;
both should be updated to match the shipped assets.

**Deploy.** `cdk diff DstGame` showed only the `BucketDeployment` source-object key (the rebuilt
runtime bundle); `cdk deploy DstGame --exclusively`: 21 s. A new runtime reaches the next boot
because user-data always runs `aws s3 sync s3://<bucket>/runtime/ --delete`.

## Round 1c (T4.2, same fix round) — world generation died in Lua: no task set

With the steamcmd retry and the panic guard deployed, the boot got much further — the instance
stayed alive, `binaries_installed` was logged (`dstBuildId=24700372`, cold install 15:04:11 ->
15:08:10, i.e. **~239 s**), and both shard units started — but phase 1 still timed out at 15 min.
`dst-query` never answered (`attempt to index global 'TheWorld' (a nil value)`), because both
shards had failed to generate a world. Both `server_log.txt` files show:

```
# Generating SURVIVAL Mode Level
DoLuaFile Error: #[string "scripts/map/level.lua"]:92: Must specify the task set for a level!
@scripts/map/level.lua:92 in (method) ChooseTasks
```

**Root cause.** The generated `leveldataoverride.lua` templates carried
`overrides = {}` (the five fields of `docs/game-server.md` §5, all present). An empty `overrides`
table is not enough on the current DST build (747465): worldgen asserts on a missing task set and
the shard never writes a `save/`, so the world is never joinable and the boot burns the full
15-minute timeout. This affects only the generate path — i.e. `test-*` worlds in v1 — but that is
exactly what the lifecycle test exercises.

**Fix.** `packages/supervisor/src/core/templates.ts`: the Master override now carries
`overrides = { task_set = "default" }` and the Caves override `overrides = { task_set =
"cave_default" }` — the task sets Klei's own `SURVIVAL_TOGETHER` and `DST_CAVE` levels use.
A new unit test, `each override names its task set`
(`packages/supervisor/test/templates.test.ts`), pins both strings.

**Files changed.** `packages/supervisor/src/core/templates.ts`,
`packages/supervisor/test/templates.test.ts`, `docs/_first-boot-notes.md`.

**Doc follow-up:** `docs/game-server.md` §5 quotes both override files verbatim without
`task_set`, and calls the five fields "complete"; `docs/research/world-generation.md` §2 is the
source of that claim. Both need the measured correction.

**Measured timings so far (cold first boot, `c6i.large`, no `binaries/dst-binaries.tar.zst`):**
user-data (apt + AWS CLI + Node + runtime sync) **51 s**; SSM agent online **~16 s** after
launch; cold steamcmd install with `validate` **225-239 s**; supervisor claim (S1) within **2 s**
of the unit starting.

## Round 1d (T4.2, same fix round) — `leveldataoverride.lua` is the wrong file to hand-write

Adding `task_set` moved the failure one clause along:

```
DoLuaFile Error: #[string "scripts/map/storygen.lua"]:865: Must specify a layout mode for your level.
```

**Root cause.** `leveldataoverride.lua` is not a partial override at all. Klei's own
`scripts/shardindex.lua` (extracted from `data/databundles/scripts.zip` on the instance) states
it verbatim:

```
-- leveldataoverride is for GAME USE. It contains a _complete level definition_ and is used by the
--   clusters to transfer level settings reliably from the client to the cluster servers. It
--   completely overrides existing saved world data.
-- worldgenoverride is for USER USE. It contains optionally:
--   a) a preset name. If present, this preset will be loaded and completely override existing
--      save data, including the above.
--   b) a partial list of overrides that are layered on top of whatever savedata we have ...
```

So any hand-written `leveldataoverride.lua` has to be a *complete* level definition (task set,
layout mode, story setpieces, required prefabs, ...) and worldgen asserts on the first field it
misses. The file meant for this job is `<Shard>/worldgenoverride.lua`, whose accepted keys — per
`SanityCheckWorldGenOverride` in the same file — are `override_enabled`, `preset`,
`worldgen_preset`, `settings_preset` and `overrides`. The stock preset ids are `SURVIVAL_TOGETHER`
(`scripts/map/levels/forest.lua`) and `DST_CAVE` (`scripts/map/levels/caves.lua`).

**Fix.** `packages/supervisor/src/core/templates.ts` no longer writes `leveldataoverride.lua` at
all. A generated cluster now gets

```lua
-- Master/worldgenoverride.lua
return { override_enabled = true, preset = "SURVIVAL_TOGETHER" }
-- Caves/worldgenoverride.lua
return { override_enabled = true, preset = "DST_CAVE" }
```

Naming `DST_CAVE` explicitly is also what keeps the Caves shard from generating a second forest
(the no-override default is the forest survival level), which is the risk
`docs/game-server.md` §5 warns about — the mechanism is the same, the file is different.
`packages/supervisor/test/templates.test.ts` now has `world gen overrides` in place of
`level data overrides`: both presets, `override_enabled`, and an assertion that neither file
contains a partial level definition (`location =`, `task_set`).

**Files changed.** `packages/supervisor/src/core/templates.ts`,
`packages/supervisor/test/templates.test.ts`, `docs/_first-boot-notes.md`.

**Doc follow-up:** `docs/game-server.md` §5 and §12 and `docs/research/world-generation.md` §2
describe the `leveldataoverride.lua` approach and its "all five fields" rule; the shipped
behaviour is now preset-based `worldgenoverride.lua`, and the doc text needs that correction
(`docs/` is outside this task's owned paths).

## Round 1e (T4.2, same fix round) — the count query could never see its own reply

With preset-based generation the world actually came up: the Master logged
`LOAD BE: done` (00:00:44), `Server registered via geo DNS in us-east-1` (00:00:49),
`Sim paused`, and `World 2(Caves) is now connected` (00:00:50), and Caves logged
`LOAD BE: done` + `Sim paused`. Both shards answered the count query in their logs
(`DSTQ <nonce> true 0 0 0`). And still `status` stayed `starting` until the 15-minute timeout.

**Root cause.** `queryShard()` in `packages/supervisor/src/index.ts` wrote the nonce'd Lua line to
the shard's FIFO and then polled `ShardLogState.findCountReply(nonce)` every 100 ms for 5 s — but
**nothing advanced that shard's `LogTailer` during the wait**. The tailers are polled only at the
top of the surrounding loop (every 2 s while `starting`, every 30 s while `running`), so the reply
bytes were still unread when the deadline passed. Every reading was therefore `unknown`, the
joinable clause "a count round-trip has succeeded on **every** shard"
(`docs/game-server.md` §7) could never become true, and the boot always ended in
`lastStopReason=crash`, `lastError='not joinable within 15m'`. The DSTQ lines in the log at
12-second intervals are the signature: 5 s Master timeout + 5 s Caves timeout + the 2 s sleep.

This would also have broken `running`: with every reading `unknown`, `unknownStreak` reaches 10
after ~5 min and the session stops with reason `crash`.

**Fix.** `queryShard()` takes a `pollLog: () => void` callback and calls it on every wait
iteration (and once more after the deadline, so a reply that lands in the final millisecond still
counts). All four call sites — both in the `starting` poll loop and in the `running` count poll —
pass that shard's own tailer's `poll()`.

**Files changed.** `packages/supervisor/src/index.ts`, `docs/_first-boot-notes.md`.

**Note on coverage:** `packages/supervisor/test/` covers `core/` only (pure code, per
`docs/game-server.md` §12), and `queryShard` lives in `index.ts`, so no unit test pins this; the
lifecycle test's phase 1 is what catches it. If a later task wants a regression test, the natural
shape is to move the query round trip into `core/` behind a clock + "read new lines" port.

## Round 1f (T4.2, same fix round) — heartbeat cadence drifted past the 40 s assertion

With the tailer fix the world became joinable on the cold boot in **333 s** and 12 of 13 phase-1
assertions passed. The last one failed:

```
FAIL  phase 1  idleDeadline - joinableAt is 180s +/- 5s; heartbeat advances without stale
              (41069ms) — heartbeat did not advance
```

`idleDeadline - joinableAt` was right; what failed is that `heartbeatAt` did not change inside the
test's 40-second window.

**Root cause.** `runRunningLoop` scheduled its three periodic jobs by *accumulating nominal tick
sizes* (`msSinceCountPoll += RUNNING_TICK_MS` per 1 s tick, fire at 30 s). Everything the loop
awaits inside a cycle — two `systemctl is-active` calls, up to 5 s per shard for a count round
trip, the DynamoDB heartbeat and the `session.json` write — is time that is not counted, so the
real period is 30 s *plus* the work. On the first boot that work is at its heaviest, because the
background binaries repack (tar + zstd of ~4 GB, `nice`/`ionice`) starts exactly when the world
first becomes joinable, and the period stretched past the 40 s the test allows. The API's `stale`
rule (2 min) was never in danger, but a heartbeat that drifts is still wrong: it is the reaper's
liveness signal.

**Fix.** `packages/supervisor/src/index.ts`: the running loop now keeps `lastDesiredPollAt`,
`lastCountPollAt` and `lastInflightAt` timestamps and compares them with `clock.now()` each tick,
so each deadline is relative to the previous poll's *start* and work inside a cycle cannot push
the next one out. Cadence is now ~30 s wall-clock as documented.

**Files changed.** `packages/supervisor/src/index.ts`, `docs/_first-boot-notes.md`.

### Round 1f, continued — the real cause: a second, blocking `installBinaries()`

The wall-clock scheduling above is right on its own merits, but it was not the cause. Sampling the
state item every 15 s during the next run showed `heartbeatAt` frozen at the S2 (joinable) value
for **46 s+**, and the instance's `supervisor.log` showed why:

```
16:02:14 runtime_version
16:03:04 binaries_installed  dstBuildId=24700372 repackNeeded=true
16:03:52 joinable            worldId=test-lifecycle-a
16:04:44 binaries_installed  dstBuildId=24700372 repackNeeded=true      <-- again!
```

`runSession()` discarded the result of the install it does in the `installing` phase and then, at
the joinable point, called `installBinaries()` **a second time** just to learn `repackNeeded` —
`await`ed, before `runRunningLoop()` starts. So after every first-of-its-kind boot the loop was
blocked for the length of a full install (52 s on the warm path here, minutes on the cold one),
during which no heartbeat could be written; the warm path also re-streams and re-extracts the
~3.3 GB binaries tarball over the files of a server that is already running.

**Fix.** `packages/supervisor/src/index.ts` keeps the `repackNeeded` from the session's single
install in a local and, at the joinable point, only kicks off the detached repack — no second
install. `repackNeeded` stays false on a resume and after an in-place switch, matching the
previous `skipInstall` behaviour.

**Files changed.** `packages/supervisor/src/index.ts`, `docs/_first-boot-notes.md`.

**Also measured:** with `binaries/dst-binaries.tar.zst` now populated by the first successful
repack, click-to-joinable dropped from **333 s** (cold) to **162 s** (warm) — in line with the
spike's 308 s / 165 s.

## Round 1 result (T4.2) — first boot green

`AWS_PROFILE=admin pnpm lifecycle-test --until-phase 1` → **exit 0, 13 of 13 assertions passed**
(phase 0: 5, phase 1: 8), then teardown, then `--cleanup-only`. After it: no instance tagged
`project=dst-server-manager` is `pending`/`running`, the state item is `status=stopped`, the world
registry holds only `tylerni2026`, and the data bucket has no `test-*` objects.

Six defects were fixed in this round, in the order they were hit:

| # | Where | Defect |
|---|---|---|
| 1 | `packages/infra/lib/web-stack.ts` | API role's `ec2:RunInstances` image ARN carried an account id; a public AMI's ARN has none → every launch denied (503 `launch_failed`) |
| 2 | `assets/bin/dst-install-binaries` | no retry around steamcmd; a fresh steamcmd's first `app_update` fails with exit 8 / `Missing configuration` |
| 3 | `assets/systemd/dst-panic.service` | `OnFailure=` fires on every failed start, so one supervisor crash powered the instance off instead of letting `Restart=on-failure` retry |
| 4 | `src/core/templates.ts` | hand-written `leveldataoverride.lua` cannot be partial; worldgen died. Now preset-based `worldgenoverride.lua` |
| 5 | `src/index.ts` (`queryShard`) | the count query never polled the log tailer while waiting, so every reading was UNKNOWN and nothing ever became joinable |
| 6 | `src/index.ts` (`runSession`/`runRunningLoop`) | a second, blocking `installBinaries()` after joinable (no heartbeat for its duration); loop schedules now wall-clock based |

**Measured timings (`c6i.large`, us-west-2, one world with caves, generated):**

| Step | Cold (no binaries tarball) | Warm |
|---|---|---|
| user-data (apt + AWS CLI + Node + `runtime/` sync) | 51 s | 51 s |
| SSM agent online after launch | ~16 s | ~16 s |
| steamcmd install (`validate` when cold) | 225-239 s | ~50 s |
| world generation to `LOAD BE: done` (Master) | ~44 s | n/a (restore) |
| **`POST start` → `status=running`** | **333 s** | **142-162 s** |
| binaries repack (tar+zstd+upload, ~3.3 GB, detached) | ~80 s after joinable | skipped |

Deploys used in this round: `DstWeb` once (the IAM statement), `DstGame` five times (runtime
bundle only — `cdk diff` showed nothing but the `BucketDeployment` source-object key each time).
