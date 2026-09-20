# Game instance (`packages/supervisor`)

Boot, DST binaries, world restore, systemd/FIFO, idle detection, the TypeScript supervisor, stop,
packaging. Authority: `docs/decisions.md` §5, §6 (supervisor side), §8 (instance side); it wins any
tie. Evidence: `docs/spikes/game-server-spike.md`, `docs/spikes/artifacts/` (validated prototypes),
`docs/research/idle-detection.md`, `docs/research/world-generation.md`. The Klei token and the
cluster password never reach a log, a tarball, an argv, or this repo.

## 1. Package layout

```
packages/supervisor/
  src/index.ts      entrypoint: env -> adapters -> loop;   src/config.ts  env + @dst/shared
  src/core/         PURE (no fs, net, Date.now(), aws-sdk): types.ts (Phase, Event, Command,
                    ShardReading, ports), reduce.ts ((state,event) => {state,commands}),
                    idle.ts count.ts parse.ts ini.ts templates.ts manifest.ts
  src/adapters/     ddb s3 ssm imds shards logtail clock proc logger
  src/tasks/        install restore start stop savePush logsUpload inflight
  assets/           user-data.sh (baked into the launch template), install.sh, node.env,
                    bin/ (dst-shard dst-stop dst-console dst-install-binaries dst-pack-binaries
                    dst-pack-save dst-cluster-stop dst-query), systemd/ (dst-master.service
                    dst-caves.service dst-supervisor.service dst-panic.service)
  test/             Vitest, core/ only;   esbuild.mjs
```

## 2. On-disk layout and the `dst` user

```
/opt/dst/                  home of the `dst` system user
  server/  steamcmd/       DST server (steamcmd force_install_dir) and steamcmd itself
  klei/DoNotStarveTogether/<worldId>/   cluster dir (-persistent_storage_root /opt/dst/klei)
  runtime/                 the bundle synced from s3://<data>/runtime/
  run/                     supervisor.env, shard.env, <Shard>.fifo, <Shard>.holder, session.json
  tmp/                     tarball staging (never /tmp — the root volume is only 20 GB)
/usr/local/bin/dst-*       helpers from runtime/bin;  /usr/local/bin/node -> /opt/node/bin/node
/var/log/dst/supervisor.log    /var/log/dst-userdata.log
```

`useradd --system --create-home --home-dir /opt/dst --shell /usr/sbin/nologin dst`. Shards run as
`dst`; the supervisor runs as **root** (it calls `systemctl` and `shutdown`) and `chown -R dst:dst`
everything it writes under `/opt/dst/klei`. The cluster directory is named after the `worldId`
(`-cluster <worldId>`): decisions §8 says the tarball holds the directory's *contents*, so the name
is the instance's choice, and an in-place switch gets a clean directory.

## 3. Boot: user-data (thin, stable)

Baked into the launch template, so it must change as rarely as possible; everything else lives in
`runtime/`. `__…__` placeholders are substituted by CDK from `@dst/shared` constants.

```bash
#!/bin/bash
shutdown -h +780                                   # dead-man, first line (decisions §7.2)
exec > >(tee -a /var/log/dst-userdata.log) 2>&1
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
BUCKET=__BUCKET__; REGION=__REGION__
mkdir -p /opt/dst/run /opt/dst/tmp /var/log/dst
printf 'DST_BUCKET=%s\nDST_REGION=%s\nDST_TABLE=%s\nDST_TABLE_REGION=%s\nDST_ROOT=/opt/dst\n' \
  "$BUCKET" "$REGION" __TABLE__ __TABLE_REGION__ > /opt/dst/run/supervisor.env

dpkg --add-architecture i386
apt-get update -qq
# Do NOT also install amd64 libcurl4-gnutls-dev: not co-installable with the :i386 one, and
# dpkg then aborts the whole transaction leaving every package merely "unpacked" (spike §1).
apt-get install -y -qq \
    lib32gcc-s1 lib32stdc++6 libcurl4-gnutls-dev:i386 \
    ca-certificates curl tar unzip zstd xz-utils jq bc procps

curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /opt/dst/tmp/awscliv2.zip
unzip -q /opt/dst/tmp/awscliv2.zip -d /opt/dst/tmp && /opt/dst/tmp/aws/install >/dev/null

NODE_VERSION=__NODE_VERSION__; NODE_SHA256=__NODE_SHA256__
T="node-$NODE_VERSION-linux-x64.tar.xz"
if ! aws s3 cp "s3://$BUCKET/runtime-cache/$T" /opt/dst/tmp/node.tar.xz --region "$REGION" --no-progress; then
    curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$T" -o /opt/dst/tmp/node.tar.xz
    echo "$NODE_SHA256  /opt/dst/tmp/node.tar.xz" | sha256sum -c -
    aws s3 cp /opt/dst/tmp/node.tar.xz "s3://$BUCKET/runtime-cache/$T" \
        --region "$REGION" --no-progress || true          # cache fill is best-effort
fi
echo "$NODE_SHA256  /opt/dst/tmp/node.tar.xz" | sha256sum -c -   # verified on BOTH paths
mkdir -p /opt/node && tar -xJf /opt/dst/tmp/node.tar.xz -C /opt/node --strip-components=1
ln -sf /opt/node/bin/node /usr/local/bin/node && rm -f /opt/dst/tmp/node.tar.xz

aws s3 sync "s3://$BUCKET/runtime/" /opt/dst/runtime/ --region "$REGION" --delete --no-progress
bash /opt/dst/runtime/install.sh
systemctl start dst-supervisor.service
```

`xz-utils` is the one addition to the spike's apt list (the pinned Node tarball is `.tar.xz`). The
sha256 is checked on the cache path too, so a poisoned `runtime-cache/` object cannot execute. Pin
the version once into `assets/node.env` with
`curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep linux-x64.tar.xz`.
`install.sh` (root, idempotent): create the `dst` user and the directories above; install
`runtime/bin/*` to `/usr/local/bin` mode 0755 and `runtime/systemd/*.service` to
`/etc/systemd/system`; `systemctl daemon-reload`. It enables and starts nothing. If user-data fails
anywhere, `set -e` stops it, no supervisor ever runs, and no heartbeat is written — the reaper's
stale-heartbeat rule terminates the instance within ~15 min (decisions §7.1).

## 4. DST binaries (`tasks/install.ts` -> `dst-install-binaries`)

Owned by the supervisor, not user-data, so it can change without a new launch template. Starts as
soon as the supervisor confirms it owns the session, concurrently with the world download. A
failure in 1–4 is fatal: write `lastError`, stop with reason `crash`, halt.

1. **Warm** — `binaries/dst-binaries.tar.zst` exists: stream, never to disk (spike §10):
   `set -o pipefail; aws s3 cp s3://$BUCKET/binaries/dst-binaries.tar.zst - --region $REGION |
   tar -I zstd -x -C /opt/dst`, then `chown -R dst:dst /opt/dst/server /opt/dst/steamcmd`.
2. `runuser -u dst -- bash -c "cd /opt/dst/steamcmd && HOME=/opt/dst ./steamcmd.sh
   +force_install_dir /opt/dst/server +login anonymous +app_update 343050 +quit"` — **never**
   `validate` here (7.8–13.7 s vs 222 s, spike §5).
3. **Build-id compare**: `binaries/buildid` (GetObject, trimmed) vs `/"buildid"\s*"(\d+)"/` from
   `/opt/dst/server/steamapps/appmanifest_343050.acf`, read *after* step 2. Different or missing
   -> `repackNeeded`.
4. **Cold** — object missing (`NoSuchKey`/404): fetch
   `https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz` into `/opt/dst/steamcmd`
   as `dst`, then the same `app_update 343050 **validate**`. Sets `repackNeeded`.
5. **Repack, only once the world is joinable**, detached, best-effort, never blocking:
   `nice -n 19 ionice -c3 bash -c 'set -o pipefail; tar -C /opt/dst -c server steamcmd |
   zstd -3 -T0 -q | aws s3 cp - s3://$BUCKET/binaries/dst-binaries.tar.zst --region $REGION'`,
   then `PutObject binaries/buildid`. Tarball first — a `buildid` newer than the tarball would
   suppress future repacks. `-3` not `-10` (spike §4); measured 58 s + 25 s. Failure -> `lastError`.

## 5. World restore and generation (`tasks/restore.ts`)

**Restore.** `GetObject worlds/<worldId>/save.tar.zst`; keep `res.VersionId` as
`preStartVersionId`; pipe `res.Body` into `tar -I zstd -x -C /opt/dst/klei/DoNotStarveTogether/<worldId>`
(mkdir first — the tarball holds the cluster *contents*). `NoSuchKey` -> generate; other errors are
fatal. **Generate** (registry `source` is `generated`/`test`; v1 uses it only for `test-*` worlds):
write no `save/` directory anywhere, since DST decides generate-vs-load per shard by its presence
(world-generation §3). `cluster_key` is 32 random hex; `cluster_name` is the registry `serverName`.

```ini
; cluster.ini
[GAMEPLAY]
game_mode = survival
max_players = 6
pvp = false
pause_when_empty = true
vote_kick_enabled = false

[NETWORK]
cluster_name = <serverName>
cluster_description =
cluster_password = <injected from SSM at boot>
cluster_intention = cooperative
lan_only_cluster = false
offline_cluster = false
cluster_language = en
autosaver_enabled = true

[MISC]
console_enabled = true
max_snapshots = 6

[SHARD]
shard_enabled = <hasCaves>
bind_ip = 127.0.0.1
master_ip = 127.0.0.1
master_port = 10888
cluster_key = <32 random hex>

[STEAM]
steam_group_only = false
steam_group_id = 0
steam_group_admins = false
```

```ini
; Master/server.ini
[NETWORK]
server_port = 10999
[SHARD]
is_master = true
[ACCOUNT]
encode_user_path = true
[STEAM]
master_server_port = 27016
authentication_port = 8766
```
```ini
; Caves/server.ini  (only when hasCaves)
[NETWORK]
server_port = 10998
[SHARD]
is_master = false
name = Caves
id = 2                    ; CAVES_SHARD_ID, pinned (decisions §5)
[ACCOUNT]
encode_user_path = true
[STEAM]
master_server_port = 27017
authentication_port = 8767
```

Both `leveldataoverride.lua` files must be **complete** (all five fields): an incomplete or absent
Caves override silently generates a second forest (world-generation §2), invisible to every
process-level health check.

```lua
-- Master/leveldataoverride.lua
return { id = "SURVIVAL_TOGETHER", location = "forest", name = "Survival",
         desc = "The standard Don't Starve experience.", overrides = {} }
```
```lua
-- Caves/leveldataoverride.lua
return { id = "DST_CAVE", location = "cave", name = "The Caves",
         desc = "Delve into the caves... together!", overrides = {} }
```

No `adminlist.txt`: it takes Klei `KU_` ids, not derivable from the SteamID64 allowlist. First-boot
generation can take minutes; the 15-minute boot timeout (§8) covers it.

**`hasCaves = false`**: never start `dst-caves.service`, drop the Caves clause from the joinable
predicate, poll only the Master, use the single-shard count formula. Generate also writes
`shard_enabled = false` and no `Caves/`; restore leaves a restored `shard_enabled` alone and warns
if a `Caves/` directory is present.

**Enforced every boot, restored or generated** (`core/ini.ts`; then `chown dst:dst`):
`cluster.ini [MISC] console_enabled = true` (decisions §5); `[NETWORK] cluster_name` = registry
`serverName`; `cluster_password` = `/dst/cluster-password`, replaced in whichever section already
holds the key, else appended to `[NETWORK]`; `Caves/server.ini [SHARD] id = CAVES_SHARD_ID`
(pinned, decisions §5); `<cluster>/cluster_token.txt` = `/dst/klei-token`, mode 0600.
`pause_when_empty` is **read, not enforced**: if it is not `true`, the pause cross-check (§7) is
disabled for the session and a warning is logged.

## 6. systemd and the FIFO

Reused from `docs/spikes/artifacts/` as-is except as noted. The shard scripts take the cluster name
from `/opt/dst/run/shard.env` (`DST_CLUSTER=<worldId>`), written before every start, so the units
stay static.

| Artifact | Disposition |
|---|---|
| `dst-shard` | reuse; `TylerNi2026` -> `$DST_CLUSTER`. The separate `setsid` FIFO-holder process is load-bearing: an fd held inside the server hangs it forever after `Shutting down` (spike §7). |
| `dst-console` | reuse; `$DST_CLUSTER`. Keep the `[ -p ]` test (a redirect to a missing FIFO silently creates a regular file) and `timeout 5` (opening a FIFO with no reader blocks forever). |
| `dst-stop` | reuse the 3-step shape, add the SIGTERM step (§9); `$DST_CLUSTER`. |
| `dst-cluster-stop` | reuse; used only by `dst-panic.service`. |
| `dst-master.service`, `dst-caves.service` | reuse; add `EnvironmentFile=/opt/dst/run/shard.env`. **Fix the `dst-caves.service` comment**: `c_shutdown(true)` on the Master does NOT cascade (spike §7), so each unit's `ExecStop` is mandatory, not belt-and-braces. Keep `After=dst-master.service` + `PartOf=`: it makes systemd stop Caves *first*, while the Master is alive — the only order that saves Caves. |
| `dst-joinable-watch`, `dst-sample` | not shipped; the supervisor does this in-process. |
| `dst-query` | shipped as an ops helper only (§13); the supervisor never calls it. |
| `dst-save-push` | superseded by `dst-pack-save` (§10): packs to a local file, does not upload. |

```ini
# dst-supervisor.service
[Unit]
Description=DST on-demand supervisor
After=network-online.target
Wants=network-online.target
OnFailure=dst-panic.service
StartLimitIntervalSec=600
StartLimitBurst=5
[Service]
Type=simple
EnvironmentFile=/opt/dst/run/supervisor.env
ExecStart=/usr/local/bin/node /opt/dst/runtime/supervisor.js
Restart=on-failure
RestartSec=5
StandardOutput=append:/var/log/dst/supervisor.log
StandardError=append:/var/log/dst/supervisor.log
TimeoutStopSec=300
KillMode=mixed
[Install]
WantedBy=multi-user.target
```

`dst-panic.service` is `Type=oneshot`, `ExecStart=/bin/bash -c '/usr/local/bin/dst-cluster-stop;
shutdown -h now'`: if the supervisor crash-loops past the start limit, each unit's `ExecStop` still
saves the world to disk and the instance still dies. The S3 push is lost;
`inflight/<worldId>/save.tar.zst` is ≤10 minutes old.

## 7. Count query, joinable, pause

**Log tailing.** One `LogTailer` per shard over `<cluster>/<Shard>/server_log.txt`: keeps a byte
offset, reads new bytes every 500 ms, splits on `\n`, feeds each line to `core/parse.ts`. Every
signal (count replies, joinable, pause, shard loss) comes from this one stream. The shard truncates
its log at start, so a supervisor restart re-reads from 0.

**Query**, per shard, every 30 s, and every 2 s during startup until the first success:

1. `nonce = randomInt(1, 2**31)`.
2. Write via `dst-console <Shard> '<lua>'` — never a direct FIFO open; the helper carries the fifo
   test and the timeout:
```lua
local ok,s,c,a = pcall(function() return TheWorld.shard.components.shard_players:GetNumPlayers(), #GetPlayerClientTable(), #AllPlayers end) print("DSTQ <NONCE> "..tostring(ok).." "..tostring(s).." "..tostring(c).." "..tostring(a))
```
3. Wait up to **5000 ms** for a tailed line matching, anchored on the *answer's* shape:
   ``new RegExp(`DSTQ ${nonce} (true|false) (\\S+) (\\S+) (\\S+)`)``. Drop any line containing
   `RemoteCommandInput:` first — the server echoes the command verbatim before running it, and the
   echo contains the literal `"..tostring(ok).."` (spike §2). Lines end in a TAB; `\S+` handles it.
4. `{ kind:'ok', shardplayers, clients, allplayers }` when `ok === true` and all three parse as
   integers; otherwise (timeout, `ok=false`, a `nil` field, no log file) `{ kind:'unknown' }`.

**Formula** (decisions §5). `shardplayers` is excluded from the zero decision because it never
decays after a disconnect (spike §9) — the most expensive possible bug in this system:

```ts
players = hasCaves
  ? Math.max(master.clients, caves.clients, master.allplayers + caves.allplayers)
  : Math.max(master.clients, master.allplayers);
```

If **any** polled shard reads `unknown` the whole reading is **UNKNOWN**, never zero: it holds the
idle clock and writes `playerCount: null`. Log `shardplayers` at debug level only — disagreement
with `clients` is a health hint, nothing more.

**Joinable predicate** — every clause, against the **Master** log:

| Clause | Regex (per line) |
|---|---|
| registered — the real gate; without it the shard link never completes (spike §1) | `/^\[[0-9:]+\]: Server registered via geo DNS in (\S+)\s*$/` |
| Caves linked (`hasCaves` only) — anchor on the shard **name**, the id varies | `/^\[[0-9:]+\]: World \d+\(Caves\) is now connected\s*$/` |
| a pause edge has been seen | `/^\[[0-9:]+\]: Sim (un)?paused\s*$/` |
| a count round-trip has succeeded on **every** shard | §7 above |

Also parsed: `/^\[[0-9:]+\]: Online Server Started on port: (\d+)\s*$/` (progress),
`/^\[[0-9:]+\]:\s+LOAD BE: done\s*$/` (world deserialized or generated — gates the save push, §9),
`/^\[[0-9:]+\]: \[Shard\] A shard has disconnected: '(\w+)\(\d+\)'/`,
`/^\[[0-9:]+\]: Shutting down\s*$/`.

**Pause cross-check.** `simPaused` = the most recent anchored `Sim paused` (true) / `Sim unpaused`
(false) edge on the Master. `players === 0` with `simPaused === false` is a **disagreement**: hold
the clock, log at warn. If no pause edge has appeared 3 polls after joinable, or `pause_when_empty`
is not `true`, disable the cross-check for the session (count-only) and log once. Never read pause
edges from the Caves log (mirrored 3 s late). `Server Autopaused` never matches.

**Idle maths** (`core/idle.ts`, pure):

```
UNKNOWN                     -> unknownStreak++                              (clock holds)
players > 0                 -> zeroStreak = 0; unknownStreak = 0; lastNonZeroAt = now
players == 0, disagreement  -> unknownStreak = 0                            (clock holds)
players == 0                -> zeroStreak++; unknownStreak = 0
                               if (zeroStreak < 3) lastNonZeroAt = now      (3-zero rule)
idleDeadline = max(joinableAt, lastNonZeroAt) + idleMinutes * 60_000
now >= idleDeadline         -> stop, reason 'idle'
unknownStreak >= 10 (~5 min)-> stop, reason 'crash'
```

`idleMinutes` comes from the world registry item (default 30).

## 8. The supervisor program

Ports declared in `core/types.ts`, implemented in `adapters/`, faked in tests: `StatePort`
(DynamoDB), `RegistryPort`, `ObjectPort` (S3), `SecretPort` (SSM), `ShardPort` (systemd + FIFO +
log tail), `MetaPort` (IMDS + EC2 tags), `ClockPort`, `HostPort` (`shutdown -h now`, spawn).
`core/` imports nothing from `adapters/` and nothing from `aws-sdk`. **Identity** comes from IMDSv2
(`PUT /latest/api/token`, TTL 21600, 2 s timeout, 3 retries): `instance-id`, `public-ipv4`,
`tags/instance/sessionId` — so the launch template must set
`MetadataOptions.InstanceMetadataTags=enabled`; fallback `ec2:DescribeTags` on itself.

**Loop**, two timers, both feeding the same pure reducer
(`reduce(state, event) => { state, commands }`; `index.ts` executes commands via the ports):
- **10 s**: `GetItem pk=STATE sk=CLUSTER`, `ConsistentRead: true` -> `desiredState`; plus
  `systemctl is-active` per started unit -> `shardExited` on `failed`/`inactive`.
- **30 s**: a count poll on every started shard -> `countReading`, then the heartbeat write.

Phases `boot -> installing -> starting -> running -> stopping -> (starting | halted)`:
- `boot`: read identity and the state item. If `sessionId !== ours` or `status !== 'starting'` this
  is an orphan — log, write nothing, `shutdown -h now`. Else write #1, read the registry item for
  `desiredWorldId`, go to `installing`.
- `installing`: §4 and §5 concurrently, then config enforcement and `shard.env`. If
  `desiredWorldId` went null meanwhile, go straight to `stopping(user)` — no shards started.
- `starting`: `systemctl start dst-master.service` (+ `dst-caves.service` if `hasCaves`), poll the
  predicate. **Boot timeout 15 min** from `startedAt` -> `stopping(crash)`,
  `lastError='not joinable within 15m'`. On success write #2, and launch the repack if
  `repackNeeded`.
- `running`: heartbeats, idle maths, the 10-minute inflight copy, and reconciliation —
  `desiredWorldId === worldId` -> nothing; `=== null` -> `stopping(user)`; `=== otherWorld` ->
  `stopping(switch)` with `next = otherWorld`; `sessionId !== ours` -> abandon path. The same
  reconciliation runs while `starting`.

**Every write it makes** (`UpdateItem` on `{pk:'STATE', sk:'CLUSTER'}`, `#s` = `status`, `:sid`/
`:iid` its own — decisions §6: every supervisor write is conditional on `sessionId`/`instanceId`):

| # | When | UpdateExpression | ConditionExpression |
|---|---|---|---|
| 1 | claim, once at boot | `SET instanceId=:iid, publicIp=:ip, heartbeatAt=:now` | `sessionId=:sid AND #s=:starting` |
| 2 | joinable | `SET #s=:running, worldId=:w, joinableAt=:now, playerCount=:zero, idleDeadline=:dl, heartbeatAt=:now REMOVE lastError` | `sessionId=:sid AND instanceId=:iid AND #s=:starting` |
| 3 | heartbeat, 30 s | `SET playerCount=:pc, idleDeadline=:dl, heartbeatAt=:now` | `sessionId=:sid AND instanceId=:iid` |
| 4 | error | `SET lastError=:e, heartbeatAt=:now` | `sessionId=:sid AND instanceId=:iid` |
| 5 | stop begins | `SET #s=:stopping, lastStopReason=:reason, heartbeatAt=:now` | `sessionId=:sid AND instanceId=:iid` |
| 6 | switch commit | `SET sessionId=:newsid, worldId=:b, #s=:starting, startedBy=:desiredBy, startedAt=:now, playerCount=:null, heartbeatAt=:now REMOVE joinableAt, idleDeadline` | `sessionId=:sid AND instanceId=:iid AND desiredWorldId=:b` |
| 7 | final | `SET #s=:stopped, playerCount=:null, lastStopReason=:reason, heartbeatAt=:now REMOVE instanceId, publicIp, joinableAt, idleDeadline` | `sessionId=:sid AND instanceId=:iid AND (attribute_not_exists(desiredWorldId) OR attribute_type(desiredWorldId, :tNull))`, `:tNull='NULL'` |

`ConditionalCheckFailedException`: **#1** -> orphan, halt without writing. **#3/#4/#5** -> re-read;
`sessionId` changed -> abandon path, else retry once. **#6** -> re-read and re-decide (desired may
have changed again or gone null). **#7** -> the designed race (decisions §6): someone asked for a
world during shutdown. Re-read; if `desiredWorldId` names a world run #6 and start it instead of
terminating; if `sessionId` is no longer ours, abandon.

**In-place switch**: full stop of A (§9 — shards, save push, logs + manifest), mint a new
`sessionId` (`crypto.randomUUID()`), `ec2:CreateTags` on this instance to set `sessionId=<new>`
(otherwise the reaper's orphan rule terminates it mid-session, decisions §7.1), write #6, then
restore and start B in a fresh cluster directory under a fresh `sessions/<worldB>/<newSessionId>/`
prefix. Binaries are untouched.

**Abandon path** (the item's `sessionId` is no longer ours — the reaper concluded we were dead):
stop the shards so the world reaches disk, push the tarball to `inflight/<worldId>/save.tar.zst`
and **not** to `worlds/` (never clobber a live save owned by a newer session; decisions §8 makes
`inflight/` manual-recovery-only), upload the session logs under the old prefix, write nothing to
DynamoDB, `shutdown -h now`.

**Crash handling.** `Restart=on-failure` restarts the supervisor; it rehydrates from
`/opt/dst/run/session.json` (rewritten on every phase change and heartbeat: `phase, worldId,
sessionId, startedAt, joinableAt, lastNonZeroAt, zeroStreak, peakPlayers, preStartVersionId,
dstBuildId`), re-reads the state item, re-scans the shard logs from 0 for the latest pause edge and
the joinable lines, and continues — the persisted `lastNonZeroAt` is why a restart cannot silently
reset the idle timer. Past the start limit, `dst-panic.service` takes over.

**In-session safety copy.** Every 10 min while `running`: `dst-pack-save` (§10, same exclude list
and password blanking) under `nice -n 19 ionice -c3`, then
`PutObject inflight/<worldId>/save.tar.zst`. No forced `c_save()` — DST autosaves. Skipped if the
previous copy still runs; failures are logged, never fatal.

## 9. Stop sequence

decisions §5, every step measured. Per shard, **Caves first** — its `c_shutdown` needs a live
Master, and an orphaned Caves can never be saved or stopped (spike §7).

1. `timeout 240 systemctl stop dst-caves.service`, then the same for `dst-master.service`.
2. Each unit's `ExecStop` is `dst-stop <Shard> $MAINPID`:
   1. `c_shutdown(true)` into that shard's FIFO — this, not SIGTERM, is the primary save.
   2. Wait up to **60 s** for `Shutting down` in that shard's log (measured 2.0–3.1 s).
   3. Seen: kill the FIFO holder so stdin EOFs (the process cannot exit otherwise), wait 30 s,
      then `SIGKILL`. **Never EOF a shard that has not printed `Shutting down`** — that
      permanently kills a healthy shard's console.
   4. Not seen in 60 s: `SIGTERM` (it does serialize one slot), wait up to **30 s** for
      `Shutting down`, kill the holder, wait 10 s, `SIGKILL`.
   `TimeoutStopSec=200`, `KillMode=mixed`.
3. A non-zero exit **after** `Shutting down` (the final teardown saw `11/SEGV`) is benign; only a
   failure before it is data loss. `ExecMainStatus` is logged, never acted on.
4. **Push the save** (§10) iff the Master ever logged `LOAD BE: done` — otherwise the world was
   never fully loaded or generated and the restored version is still authoritative.
5. Upload the session logs and `manifest.json` (§10).
6. Write #7 (or #6 on the switch race).
7. `shutdown -h now` (`InstanceInitiatedShutdownBehavior=terminate`).

Budgets: pack 120 s; each upload 120 s, 3 attempts, backoff 1/2/4 s; each DDB write 10 s, 3
attempts. Global stop budget **8 min** from step 1 — anything unfinished is logged and step 7 runs
anyway. The dead-man `shutdown -h +780` and the reaper are the backstops.

## 10. Save tarball, session logs, manifest

`dst-pack-save <clusterDir> <out.tar.zst>` — with both shards stopped, or (inflight) with them
running but never mutating the live cluster:

```bash
set -euo pipefail
STAGE=$(mktemp -d /opt/dst/tmp/stage.XXXX)
sed -E 's/^([[:space:]]*cluster_password[[:space:]]*=).*/\1/' "$CLUSTER/cluster.ini" > "$STAGE/cluster.ini"
tar -C "$CLUSTER" \
    --exclude=./cluster_token.txt --exclude=./cluster.ini \
    --exclude='./*/save/server_temp' --exclude='./*/save/client_temp' \
    --exclude='./*/save/cached_userid' --exclude='./*/backup' \
    --exclude='./*/server_log.txt' --exclude='./*/server_chat_log.txt' \
    -cf "$STAGE/save.tar" .
tar -C "$STAGE" -rf "$STAGE/save.tar" ./cluster.ini       # the blanked copy
zstd -3 -T0 -q -o "$OUT" -f "$STAGE/save.tar"
rm -rf "$STAGE"
```

The three `save/` exclusions are the `E_ROWID_EXIST` fix: carried onto a new public IP they make
the Master's lobby registration fail forever and the Caves shard never link — a cluster healthy by
every local signal and simply unjoinable (spike §5). `cluster_token.txt` is excluded and the
password is blanked, so a save tarball never carries a secret (decisions §5, §8).

Upload with the SDK (`PutObject`), not the CLI, so `VersionId` comes back:
`worlds/<worldId>/save.tar.zst` -> `postStopVersionId`; the restore's `GetObject` gave
`preStartVersionId`. Backups *are* these S3 versions (decisions §8). **Session logs** ->
`sessions/<worldId>/<sessionId>/`: `master/server_log.txt`, `master/server_chat_log.txt`,
`caves/server_log.txt`, `caves/server_chat_log.txt` (Caves only when `hasCaves`), `supervisor.log`
(a copy of `/var/log/dst/supervisor.log` — an addition to decisions §8, because the instance is
gone by the time anyone debugs it) and `manifest.json`:

```ts
interface SessionManifest {
  sessionId: string; worldId: string;
  startedBy: string;                 // NICKNAME from /dst/users, never a SteamID64
  startedAt: string; joinableAt: string | null; stoppedAt: string;   // ISO 8601
  stopReason: 'idle' | 'user' | 'switch' | 'crash';
  peakPlayers: number;               // max over non-UNKNOWN readings
  instanceType: string;              // IMDS
  dstBuildId: string;                // appmanifest_343050.acf
  preStartVersionId: string | null;  // null when the world was generated
  postStopVersionId: string | null;  // null when no save was pushed
}
```

`startedBy` is resolved by reading `/dst/users` (SSM String, **us-east-1**) and looking up the
item's `startedBy`; on a miss, `"unknown"`. Shard logs may hold player names and Klei ids; they
never hold the token or the password. **Secret hygiene, enforced in code:** `adapters/ssm.ts`
returns a `Secret<string>` whose `toString()`/`toJSON()` yield `'***'`; only the INI writer and the
token-file writer call `.reveal()`; `adapters/logger.ts` redacts any revealed value by substring
before writing a line. Secrets are never process arguments (`/proc/*/cmdline` is world-readable)
and no helper touching them runs under `set -x`. `cluster_token.txt` is mode 0600, `dst:dst`.

## 11. Bundle and deploy

- `esbuild.mjs`: `--bundle --platform=node --target=node22 --format=cjs --sourcemap=inline
  --outfile=dist/supervisor.js`, **no `--external`** — the AWS SDK v3 clients (`client-dynamodb`,
  `lib-dynamodb`, `client-s3`, `client-ssm`, `client-ec2`) are dependencies of this package and are
  bundled, so the instance never runs an install.
- `pnpm --filter supervisor build` stages `dist/supervisor.js`, `assets/install.sh`, `assets/bin/*`,
  `assets/systemd/*` and a `VERSION` file (the git sha) into `packages/supervisor/dist/runtime/`;
  `DstGame` deploys that with `new BucketDeployment(this, 'Runtime', { sources:
  [Source.asset('../supervisor/dist/runtime')], destinationBucket: dataBucket,
  destinationKeyPrefix: 'runtime/', prune: true })` — `prune: true` is safe, `runtime-cache/` is a
  different prefix.
- `assets/user-data.sh` is read by CDK, has its `__PLACEHOLDERS__` substituted and goes into the
  launch template: editing user-data means a new launch-template version, editing anything else
  does not.
- **A new runtime version reaches the next boot** because user-data runs
  `aws s3 sync s3://<bucket>/runtime/ --delete` on every start. Running instances are unaffected;
  there is no pinning and no rollback beyond redeploying. The supervisor's first log line is
  `runtime VERSION=<sha>`.

## 12. Unit tests (Vitest, `core/` only, no AWS, no fs)

- `count.ts` — the five measured states of spike §9: `0 0 0`/`0 0 0` -> 0; surface `1 1 1`/`1 1 0`
  -> 1; caves `1 1 0`/`1 1 1` -> 1; mid-migration `1 1 0`/`1 1 0` -> **1**; after disconnect
  `1 0 0`/`1 0 0` -> **0** (the stuck-`shardplayers` case); plus the `hasCaves=false` formula.
- `parse.ts` — the `RemoteCommandInput:` echo does not match, the answer does; trailing TAB
  tolerated; wrong nonce ignored; `ok=false` and `nil` fields -> UNKNOWN; `World 40987672(Caves) is
  now connected` matches while `World 2 is now connected` does not; anchored `Sim paused`/`Sim
  unpaused` match, `Server Autopaused` does not; `LOAD BE: done`; the shard-disconnect line;
  buildid from a sample `appmanifest_343050.acf`.
- `idle.ts` — one zero does not start the clock, three consecutive do; a non-zero between zeros
  resets the streak; UNKNOWN holds without resetting; 10 UNKNOWNs -> crash; `players===0 &&
  !simPaused` holds; `idleDeadline = max(joinableAt, lastNonZeroAt) + idleMinutes`; `idleMinutes=3`
  fires at 3 min; the deadline survives a rehydrate from `session.json`.
- `reduce.ts` — orphan at boot halts with zero writes; desired goes null while `starting` -> stop
  `user` with **no** save push (no `LOAD BE: done`), while `running` -> stop `user` with a push; a
  different world while `running` -> stop `switch` then start B in place under a new sessionId; a
  switch requested while already `stopping` -> start B instead of terminating; write #7's condition
  failing -> start `desiredWorldId` instead of `shutdown`; shard exit while `running` -> stop
  `crash` with a push, while `starting` -> without one; boot timeout at 15 min; `hasCaves=false`
  never starts or polls Caves; every emitted write carries a `sessionId`+`instanceId` condition.
- `ini.ts`/`templates.ts` — setting an existing key preserves comments and order;
  `cluster_password` is replaced in whichever section holds it and appended to `[NETWORK]` when
  absent; `console_enabled` forced to `true`; the Caves `id` pinned; the generated Caves
  `leveldataoverride.lua` has `location = "cave"` and all five fields; a generated cluster has no
  `save/` directory. `manifest.ts` — `startedBy` is a nickname; `peakPlayers` ignores UNKNOWN;
  `preStartVersionId` is null for a generated world.

## 13. Debugging on the instance

```bash
aws ssm start-session --target i-… --region us-west-2 --profile admin
sudo -i
tail -f /var/log/dst/supervisor.log            # supervisor
tail -f /var/log/dst-userdata.log              # bootstrap: apt, node, runtime sync
jq . /opt/dst/run/session.json                 # phase, idle clock, versionIds
systemctl status dst-supervisor dst-master dst-caves
journalctl -u dst-master -n 200 --no-pager
CL=/opt/dst/klei/DoNotStarveTogether/$(sed -n 's/^DST_CLUSTER=//p' /opt/dst/run/shard.env)
grep -nE '^\[[0-9:]+\]: (Sim (un)?paused|Server registered via geo DNS|Shutting down)' $CL/Master/server_log.txt
dst-query Master; dst-query Caves              # one nonce'd count round-trip each
dst-console Master 'c_listallplayers()'        # then read the log for the answer
```

Do not `cat` `cluster.ini` in a shared session — it holds the join password; use
`grep -v -i password $CL/cluster.ini`. Never print `cluster_token.txt`.

A stuck boot is almost always one of: `E_ROWID_EXIST` (`grep -c E_ROWID_EXIST` on the Master log —
a bad save tarball carried `save/server_temp`), the Caves shard never linking (no
`World N(Caves) is now connected`), or a FIFO that became a regular file
(`ls -l /opt/dst/run/*.fifo`).
