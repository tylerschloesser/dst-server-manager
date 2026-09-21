# Game instance (`packages/supervisor`)

Boot, DST binaries, world restore, systemd/FIFO, idle detection, the TypeScript supervisor, stop,
packaging. Authority: `docs/decisions.md` §5, §6 (supervisor side), §8 (instance side) and §16
(Clarifications); it wins any tie. Evidence: `docs/spikes/game-server-spike.md`,
`docs/spikes/artifacts/` (validated prototypes), `docs/research/idle-detection.md`,
`docs/research/world-generation.md`. The Klei token and the cluster password never reach a log, a
tarball, an argv, or this repo.

Related docs: `docs/control-plane.md` (shared types/constants, **every DynamoDB expression this
package writes**, reaper rules) · `docs/storage.md` (S3 layout, **the save-tarball format and
exclude list**, manifest schema) · `docs/infra.md` (launch template, instance IAM as deployed) ·
`docs/testing.md` (root scripts, lifecycle test).

## 1. Package layout

```
packages/supervisor/
  src/index.ts      entrypoint: env -> adapters -> loop;   src/config.ts  env + @dst/shared
  src/core/         PURE (no fs, net, Date.now(), aws-sdk): types.ts (Phase, Event, Command,
                    ShardReading, ports), reduce.ts ((state,event) => {state,commands}),
                    idle.ts count.ts parse.ts ini.ts templates.ts manifest.ts lobby.ts
  src/adapters/     ddb s3 ssm imds shards logtail clock proc logger
  src/tasks/        install restore start stop savePush logsUpload inflight
  assets/           user-data.sh (baked into the launch template), install.sh, node.env,
                    bin/ (dst-shard dst-stop dst-console dst-install-binaries dst-pack-binaries
                    dst-pack-save dst-cluster-stop dst-query), systemd/ (dst-master.service
                    dst-caves.service dst-supervisor.service dst-panic.service)
  test/             Vitest, core/ only;   esbuild.mjs
```

**Dependencies** of `@dst/supervisor`, in full: `@dst/shared@workspace:*`,
`@aws-sdk/client-dynamodb`, `@aws-sdk/lib-dynamodb`, `@aws-sdk/client-s3`, `@aws-sdk/client-ssm`,
`@aws-sdk/client-route-53`; devDependency `esbuild`. **No `@aws-sdk/client-ec2`** — the instance
makes no EC2 API call at all: it has no `ec2:*` IAM permission (decisions §16.7, `docs/infra.md`
§3.5), its `sessionId` comes from IMDS instance tags (§8), and it ends itself with
`shutdown -h now`. Route 53 is the one API outside S3/DynamoDB/SSM it does call, for the single
record of decisions §17, and its IAM statement is scoped to that one name and type.

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
`runtime/`. `__…__` placeholders are substituted by CDK (`docs/infra.md` §3.6) from `@dst/shared`
constants — `__DATA_BUCKET__`, `__GAME_REGION__`, `__TABLE_NAME__`, `__CONTROL_REGION__` — plus
`__NODE_VERSION__` / `__NODE_SHA256__` read from `assets/node.env`. The placeholder names match the
constant names exactly, so a rename is caught by one `grep`.

```bash
#!/bin/bash
shutdown -h +780                                   # dead-man, first line (decisions §7.2)
exec > >(tee -a /var/log/dst-userdata.log) 2>&1
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
BUCKET=__DATA_BUCKET__; REGION=__GAME_REGION__
mkdir -p /opt/dst/run /opt/dst/tmp /var/log/dst
printf 'DST_BUCKET=%s\nDST_REGION=%s\nDST_TABLE=%s\nDST_TABLE_REGION=%s\nDST_ROOT=/opt/dst\n' \
  "$BUCKET" "$REGION" __TABLE_NAME__ __CONTROL_REGION__ > /opt/dst/run/supervisor.env

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

**`assets/node.env` format** (decisions §16.38 — this file is written here and parsed by CDK in
`docs/infra.md` §3.6, so the format is pinned in both places, verbatim):

> `assets/node.env` is exactly two `KEY=value` lines, no quotes, no `export`, no comments:
> `NODE_VERSION=v22.x.y` and `NODE_SHA256=<64 lowercase hex>`. `readNodeEnv` splits on the first
> `=` per line and throws if either key is missing or `NODE_SHA256` is not 64 hex characters.

`NODE_VERSION` keeps its leading `v` because user-data interpolates it straight into both the
tarball name (`node-$NODE_VERSION-linux-x64.tar.xz`) and the `https://nodejs.org/dist/$NODE_VERSION/`
path. The file is checked with
`grep -cE '^NODE_VERSION=v22\.[0-9]+\.[0-9]+$' packages/supervisor/assets/node.env` and
`grep -cE '^NODE_SHA256=[0-9a-f]{64}$' packages/supervisor/assets/node.env`, each `1`.
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
   `validate` here (7.8–13.7 s vs 222 s, spike §5) — through the `steam_app_update()` retry helper
   below, which both paths use.
3. **Build-id compare**: `binaries/buildid` (GetObject, trimmed) vs `/"buildid"\s*"(\d+)"/` from
   `/opt/dst/server/steamapps/appmanifest_343050.acf`, read *after* step 2. Different or missing
   -> `repackNeeded`.
4. **Cold** — object missing (`NoSuchKey`/404): fetch
   `https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz` into `/opt/dst/steamcmd`
   as `dst`, run **one throwaway `./steamcmd.sh +quit` bootstrap** (see below), then the same
   `app_update 343050 **validate**`. Sets `repackNeeded`.
5. **Repack, only once the world is joinable**, detached, best-effort, never blocking:
   `nice -n 19 ionice -c3 bash -c 'set -o pipefail; tar -C /opt/dst -c server steamcmd |
   zstd -3 -T0 -q | aws s3 cp - s3://$BUCKET/binaries/dst-binaries.tar.zst --region $REGION'`,
   then `PutObject binaries/buildid`. Tarball first — a `buildid` newer than the tarball would
   suppress future repacks. `-3` not `-10` (spike §4); measured ~80 s after joinable on a
   `c6i.large`. Failure -> `lastError`. **Only the session's single `installBinaries()` result
   decides `repackNeeded`** — the supervisor keeps it in a local and, at the joinable point, only
   kicks off the detached repack. Calling `installBinaries()` a second time there (which an early
   version did, just to learn `repackNeeded`) blocks the running loop for the length of a whole
   install — no heartbeat for 46 s+ on the warm path, minutes on the cold one — and re-extracts the
   ~3.3 GB tarball over the files of a server that is already running.

**`steamcmd` is not reliable on its first attempt** (measured, first real boot). A freshly
downloaded steamcmd self-updates (`Restarting steamcmd by request...`) and the `app_update` that
follows *in that same invocation* then fails with exit **8** and, in
`/opt/dst/Steam/logs/content_log.txt`, `Failed installing AppID 343050 (Missing configuration)` —
seen 3 s in on one run and ~23 s (22 % downloaded) in on another, so it is transient, not a config
error. The next invocation always succeeded. Treating that non-zero exit as fatal killed the
supervisor on every cold boot. So `assets/bin/dst-install-binaries`:

- lets a fresh steamcmd **bootstrap in an invocation of its own** (`./steamcmd.sh +quit`,
  non-fatal, cold path only);
- runs every `app_update` through `steam_app_update()`, which **retries up to 3 times with a 10 s
  pause** and only then fails the session.

The warm path still never passes `validate`; the cold path still does.

**Measured** (`c6i.large`, us-west-2, one world with caves): cold steamcmd install with `validate`
**225–239 s**; warm `app_update` without it **~50 s**; user-data (apt + AWS CLI + Node +
`runtime/` sync) **51 s**; SSM agent online ~16 s after launch; supervisor claim (S1) within 2 s of
the unit starting. End-to-end `POST start` → `status=running`: **333 s cold, 142–164 s warm**
(§9 has the stop-side numbers).

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

**The level is chosen by naming a preset in `<Shard>/worldgenoverride.lua`.** Not
`leveldataoverride.lua` — that file is **not a partial override at all**, and hand-writing it does
not work. Klei's own `scripts/shardindex.lua` (extracted from `data/databundles/scripts.zip` on
the instance) says so verbatim:

```
-- leveldataoverride is for GAME USE. It contains a _complete level definition_ and is used by the
--   clusters to transfer level settings reliably from the client to the cluster servers. It
--   completely overrides existing saved world data.
-- worldgenoverride is for USER USE. It contains optionally:
--   a) a preset name. If present, this preset will be loaded and completely override existing
--      save data, including the above.
--   b) a partial list of overrides that are layered on top of whatever savedata we have ...
```

**Measured on the first real boot** (`docs/research/world-generation.md` §2 is the origin of the
superseded "all five fields" rule): a hand-written `leveldataoverride.lua` is rejected clause by
clause by worldgen — `overrides = {}` gives
`map/level.lua:92 Must specify the task set for a level!`, adding `task_set` then gives
`map/storygen.lua:865 Must specify a layout mode for your level.`, and so on for every field of a
complete level definition. The shard never writes a `save/`, the world is never joinable, and the
boot burns the whole 15-minute timeout while every process-level health check looks fine. So the
supervisor writes **no `leveldataoverride.lua` at all**:

```lua
-- Master/worldgenoverride.lua
return { override_enabled = true, preset = "SURVIVAL_TOGETHER" }
```
```lua
-- Caves/worldgenoverride.lua  (only when hasCaves)
return { override_enabled = true, preset = "DST_CAVE" }
```

`SURVIVAL_TOGETHER` (`scripts/map/levels/forest.lua`) and `DST_CAVE`
(`scripts/map/levels/caves.lua`) are the stock forest and caves presets; the keys this file may
carry, per `SanityCheckWorldGenOverride` in the same Klei source, are `override_enabled`, `preset`,
`worldgen_preset`, `settings_preset` and `overrides`. **Naming `DST_CAVE` explicitly is still what
keeps the Caves shard from silently generating a second forest** (the no-override default is the
forest survival level) — the hazard `world-generation` §2 warns about is real, only the file and
the mechanism are different.

No `adminlist.txt`: it takes Klei `KU_` ids, not derivable from the SteamID64 allowlist. First-boot
generation is fast in practice — **~44 s from shard start to `LOAD BE: done`** on a `c6i.large` —
but the 15-minute boot timeout (§8) is the backstop.

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
| `dst-shard` | reuse; `TylerNi2026` -> `$DST_CLUSTER`. The separate `setsid` FIFO-holder process is load-bearing: an fd held inside the server hangs it forever after `Shutting down` (spike §7). **Plus the FIFO guard below.** |
| `dst-console` | reuse; `$DST_CLUSTER`. Keep the `[ -p ]` test (a redirect to a missing FIFO silently creates a regular file) and `timeout 5` (opening a FIFO with no reader blocks forever). **Plus the loser cleanup below.** |
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

**The FIFO must never be replaced by a regular file, and `rm -f` + `mkfifo` is a race.** Measured
in T5.2: on an in-place switch the supervisor is already polling the console of the world that just
stopped (nothing removes a fifo at stop), so its `dst-console` can pass `[ -p "$FIFO" ]` against the
**old** fifo, lose the CPU, and only then open the path — which `dst-shard`'s `rm -f` has deleted by
then, so the redirect's `O_CREAT` creates a **regular file** owned by root. `dst-shard`'s `mkfifo`
then fails with `EEXIST`; with `set -u` and no `set -e` the script carried on and handed the server
a regular file as stdin. The world boots and registers **perfectly** and can never become joinable:
every later `dst-console` fails its own `[ -p ]` test forever, no count query is ever answered
(281 failed writes over one 10-minute hang in the run that found this). The window is a few
milliseconds, which is why phase 1 never failed and phase 2 failed about one run in three. Both
scripts now guard it:

- **`dst-shard`** — never hand the server anything but a fifo. The `rm -f` + `mkfifo` pair is a
  5-attempt loop that re-checks `[ -p "$FIFO" ]` after each try (so a regular file left by a racing
  writer is deleted and replaced), and the script `exit 1`s rather than starting the server if it
  still has no fifo. Losing the race is now a **failed unit start**, which the supervisor's
  `systemctl is-active` check turns into an ordinary crash-stop.
- **`dst-console`** — clean up after the loser. Shell cannot make `[ -p ]` and the redirect atomic,
  so after the write it re-checks: if the path is no longer a fifo, this redirect created it —
  `rm -f` it (unblocking the racing `mkfifo`) and exit non-zero with a message, rather than leaving
  a booby trap on disk.

`dst-panic.service` is `Type=oneshot` with `TimeoutStartSec=300` and

```ini
ExecStart=/bin/bash -c 'for i in $(seq 1 24); do sleep 5; systemctl is-active --quiet dst-supervisor.service && exit 0; done; /usr/local/bin/dst-cluster-stop; shutdown -h now'
```

(one line, verbatim from `assets/systemd/dst-panic.service` — do not wrap it.)

**The wait is load-bearing.** systemd triggers `OnFailure=` whenever the unit enters `failed`
state — which happens *before every scheduled auto-restart*, not only once `StartLimitBurst` is
exhausted. Measured on the first real boot: one supervisor crash fired the panic handler and
powered the instance off ~25-35 s into the session, while `Restart=on-failure` was still going to
retry (and the retry would have worked). The journal is explicit
(`Triggering OnFailure= dependencies` … `Scheduled restart job, restart counter is at 1`). So the
handler now waits up to 120 s (24 × 5 s) for `dst-supervisor.service` to become active again and
exits 0 if it does: a single crash is retried as designed, and only a supervisor that **stays**
dead (start limit reached) gets `dst-cluster-stop; shutdown -h now`. Then each shard unit's
`ExecStop` still saves the world to disk and the instance still dies; the S3 push is lost and
`inflight/<worldId>/save.tar.zst` is ≤10 minutes old. None of the backstops is weakened: the
dead-man `shutdown -h +780`, terminate-on-shutdown, and the reaper's stale-heartbeat rule (~15 min)
all still collect a wedged instance.

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
   **The wait must advance that shard's `LogTailer` on every iteration** (`queryShard` takes a
   `pollLog: () => void` and calls it each 100 ms poll, and once more after the deadline so a reply
   landing in the final millisecond still counts). Measured on the first real boot: without it the
   tailers only moved at the top of the surrounding loop (every 2 s while `starting`, 30 s while
   `running`), so the reply bytes were still unread when the deadline passed, **every** reading was
   UNKNOWN, the "round trip succeeded on every shard" clause below could never become true, and the
   boot always ended in `lastStopReason=crash` / `lastError='not joinable within 15m'`. The
   signature in the log is DSTQ lines at 12-second intervals (5 s + 5 s + the 2 s sleep). It would
   also have broken `running`: 10 UNKNOWNs (~5 min) stops the session with reason `crash`.
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
`/^\[[0-9:]+\]: Shutting down\s*$/`, and the lobby-broadcast error line below.

**Lobby registration (`core/lobby.ts`) — the second way to be "healthy but never joinable".**
`Server registered via geo DNS` is the real gate, and the Klei lobby can refuse to issue it while
every other signal stays green. The Master then logs, every ~5 s and forever:

```
[Http] Curl failed[1] with HTTP_500, retrying (2 times). Response: _{"Error":{"Code":"E_ROWID_EXIST"}}_
[Error] Master Server Broadcast Error: E_ROWID_EXIST
```

There are **two causes with opposite cures**, so the supervisor reports before it acts:

- Re-registering the same Klei cluster token seconds after the previous world left the lobby.
  Nothing on the instance can release the row — measured refusing for **17+ minutes** with the
  per-session scratch already deleted. The only thing that works is to wait, which DST's own retry
  loop already does.
- A cluster carrying *another* server's lobby identity in `save/server_temp` + `save/client_temp` +
  `save/cached_userid` (a tarball restored onto a new public IP, spike §5). Waiting never fixes it;
  deleting those three and restarting the shards fixes it instantly.

So: after `LOBBY_REPORT_THRESHOLD = 3` errors (~15 s) log `lobby_registration_failing` at `warn`
and write `lastError = "Klei lobby registration failing (E_ROWID_EXIST); retrying"` (S7) —
**nothing is restarted on the strength of that**. Only after `LOBBY_RECOVERY_THRESHOLD = 36`
(~3 min of uninterrupted failure) clear `lobbyScratchPaths()` and restart the shards, at most
`MAX_LOBBY_RECOVERIES = 2` times. Those three paths are three of the save tarball's own excludes
(§10), so the recovery cannot lose world data. Measured: 6 s past worldgen, 91 s mid-worldgen.

**Operational note.** Fast repeated start/stop cycles provoke `E_ROWID_EXIST`; back off the Klei
token for 15-20 minutes after a run that churned sessions, or the next run's first boot can fail on
a lobby row that is still held. The one-session-at-a-time usage this system is built for does not
provoke it.

**Per-poll log line.** The `running` loop logs one `count_poll` line per 30 s poll with the raw
per-shard readings, `players`, `simPaused`, `zeroStreak`, `unknownStreak`, `lastNonZeroAt`,
`idleDeadline` and `secondsToDeadline` — two lines a minute, uploaded with the session. Without it
a world that will not stop itself leaves a session log in which the idle clock is invisible.

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
log tail), `MetaPort` (IMDS + EC2 tags), `ClockPort`, `HostPort` (`shutdown -h now`, spawn),
`DnsPort` (the one runtime Route 53 record, decisions §17).
`core/` imports nothing from `adapters/` and nothing from `aws-sdk`. **Identity** comes from IMDSv2
(`PUT /latest/api/token`, TTL 21600, 2 s timeout, 3 retries): `instance-id`, `public-ipv4`,
`instance-type`, `tags/instance/sessionId` — so the launch template must set
`MetadataOptions.InstanceMetadataTags=enabled` (decisions §16.7). There is **no `ec2:DescribeTags`
fallback**: the instance role has no `ec2:*` permission at all (`docs/infra.md` §3.5), so a failed
IMDS tag read is fatal — log, halt, let the reaper's boot-grace rule collect the instance.

**Loop**, two timers, both feeding the same pure reducer
(`reduce(state, event) => { state, commands }`; `index.ts` executes commands via the ports):
- **10 s**: `GetItem pk=STATE sk=CLUSTER`, `ConsistentRead: true` -> `desiredState`; plus
  `systemctl is-active` per started unit -> `shardExited` on `failed`/`inactive`.
- **30 s**: a count poll on every started shard -> `countReading`, then the heartbeat write.

Both deadlines are **wall-clock**: the loop keeps `lastDesiredPollAt`, `lastCountPollAt` and
`lastInflightAt` and compares them with `clock.now()` each tick. Accumulating nominal tick sizes
instead lets everything the cycle awaits — two `systemctl is-active` calls, up to 5 s per shard for
a count round trip, the DynamoDB heartbeat, the `session.json` write — push the next poll out, and a
drifting heartbeat is wrong on its own merits: it is the reaper's liveness signal.

**No heartbeat is written while `starting`** (deliberate, recorded rather than changed): `heartbeatAt`
freezes for the whole of a boot *and* for the whole of an in-place switch's new session. On a first
boot the reaper's 15-minute instance-age grace covers it (decisions §16.8), but after a switch the
instance is already older than that, so a new world that took more than ~10 minutes to become
joinable would be terminated by the reaper mid-boot. Writing S3 during `starting` would fix that and
would also weaken a cost-safety backstop, so it is a decision for Tyler, not a fix
(`docs/follow-ups.md`).

Phases `boot -> installing -> starting -> running -> stopping -> (starting | halted)`:
- `boot`: read identity and the state item. If `sessionId !== ours` or `status !== 'starting'` this
  is an orphan — log, write nothing, halt. Else write S1, **point `play.dst.ty.ler.dev` at this
  instance's public IP** (decisions §17 — immediately after the claim succeeds and before anything
  slow, so the TTL-60 record propagates during the ~2.5 min that install, restore and boot take;
  logged as `join_dns_published`, and a failure is `join_dns_failed` and nothing more), read the
  registry item for `desiredWorldId`, go to `installing`. A **resume** after a supervisor crash
  republishes it too: the IP has not changed, but the reaper may have sunk the record while this
  process was down.
- `installing`: §4 and §5 concurrently, then config enforcement and `shard.env`. If
  `desiredWorldId` went null meanwhile, go straight to `stopping(user)` — no shards started.
- `starting`: `systemctl start dst-master.service` (+ `dst-caves.service` if `hasCaves`), poll the
  predicate. **Boot timeout 15 min** from `startedAt` -> `stopping(crash)`,
  `lastError='not joinable within 15m'`. On success write S2, and launch the repack if
  `repackNeeded`. Two "healthy but never joinable" failures are reported here rather than left to
  the timeout (both §7): the **first** console write that fails per shard per session logs
  `shard_console_unwritable` at `warn` and writes `lastError = "<Shard> console is unwritable (see
  supervisor.log)"` (S7) — it used to be a `debug` line repeated hundreds of times with nothing
  connecting it to "never joinable" — and lobby-registration failures cross their report and
  recovery thresholds. `boot_timeout` additionally logs **every clause** of the predicate
  (`registered`, `cavesLinked`, `pauseEdgeSeen`, `masterOk`, `cavesOk`, `loadCompleted`,
  `broadcastErrors`, `lastBroadcastError`, `lobbyRecoveries`); `lastError` keeps its exact
  documented string.
- `running`: heartbeats, idle maths, the 10-minute inflight copy, and reconciliation —
  `desiredWorldId === worldId` -> nothing; `=== null` -> `stopping(user)`; `=== otherWorld` ->
  `stopping(switch)` with `next = otherWorld`; `sessionId !== ours` -> abandon path. The same
  reconciliation runs while `starting`.

**Every write it makes.** The exact `UpdateExpression`/`ConditionExpression` text of **S1, S2, S3,
S4, S5, S6, S7 and S8** lives in `docs/control-plane.md` §2 and is built by the shared
`state-expressions.ts` builders — this package imports them and defines none of its own. Two
consequences of that contract: "not applicable" is always an explicit `:null`, **never a `REMOVE`**
(the state item has no missing attributes), and every write is conditional on `sessionId`/
`instanceId` being its own (decisions §6).

| Label | When |
|---|---|
| **S1** | claim, once at boot — `instanceId`, `publicIp`, `heartbeatAt` |
| **S2** | joinable — `running`, `joinableAt`, `idleDeadline`, `playerCount=0`, `lastError=:null` |
| **S3** | heartbeat, every 30 s — `playerCount`, `idleDeadline`, `heartbeatAt` |
| **S7** | error note — `lastError`, `heartbeatAt` |
| **S4** | stop begins — `stopping`, `lastStopReason`, `heartbeatAt` |
| **S8** | **release its own desire**, immediately after S4 on a session-ending stop that is not a `user` stop — nulls `desiredWorldId`, stamps `desiredAt`, touches nothing else |
| **S5** | switch commit — new `sessionId`, `worldId=B`, `starting`, `startedBy`/`startedByNickname` from `desiredBy`/`desiredByNickname` |
| **S6** | final `stopped` — keeps `worldId`, nulls `sessionId`, `instanceId`, `publicIp`, `joinableAt`, `playerCount`, `idleDeadline`, `heartbeatAt` (decisions §16.10) |

(`publicIp` going null at S6 is why the join hostname exists: the address the UI had is gone with
the session, but the name a friend saved is not.)

S4 **never overwrites a `reaper-*` `lastStopReason`** (decisions §16.13): if the reaper already
recorded `reaper-max-age` when it nulled `desiredWorldId`, the supervisor keeps that reason through
S4 and S6 and stops normally.

**S8 is not optional.** S6 is conditional on `desiredWorldId` already being null, and on a stop the
supervisor decided on alone (`idle`, `crash`, boot-timeout) nothing else ever nulls it — a user stop
(W3) and the reaper's graceful path (R1) are the only other writers of that attribute. Measured in
T5.2 without S8: an idle world reached its deadline, S6's condition failed, the designed
start-during-shutdown branch read the world's own id back out of `desiredWorldId`, and the
supervisor **restarted the world that had just timed out** under a new `sessionId` — every ~3.5
minutes, indefinitely. `status` never reached `stopped`. That is a cost-safety hole, not just a
failed assertion: no session could ever stop itself, so every session ran until a human pressed
stop or the 12-hour reaper rule fired. S8 is issued **early**, right after S4 rather than just
before S6, so a start arriving during the tens of seconds of shard stop, save push and log upload
sets the desire again and still wins the S6 race exactly as decisions §6 says. A `next` that names
the world being stopped collapses to `null` — that is this session's own desire, not a switch
target. `core/reduce.ts` mirrors the same rule, so the pure model and the loop agree.

`ConditionalCheckFailedException`: **S1** -> orphan, halt without writing. **S3/S7/S4** -> re-read;
`sessionId` changed -> abandon path, else retry once (for S4, a `reaper-` reason is not a failure —
keep it and continue). **S5** -> re-read and re-decide (desired may have changed again or gone
null). **S6** -> the designed race (decisions §6): someone asked for a world during shutdown.
Re-read; if `desiredWorldId` names a world run S5 and start it instead of terminating; if
`sessionId` is no longer ours, abandon.

**In-place switch**: full stop of A (§9 — shards, save push, logs + manifest), mint a new
`sessionId` with the shared `newSessionId()` (`YYYYMMDDTHHMMSSZ-<6 hex>`, decisions §16.3), write
S5, then restore and start B in a fresh cluster directory under a fresh
`sessions/<worldB>/<newSessionId>/` prefix. Binaries are untouched.

**The instance is never re-tagged.** There is no `ec2:CreateTags` call here and the instance role
has no such permission (decisions §16.7, `docs/infra.md` §3.5): the `sessionId` tag stays the
**launch** session for the instance's whole life. The reaper is safe because its orphan rule
requires **both** a different instance id **and** a different `sessionId` tag — after a switch the
instance id still matches, so it is not an orphan.

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

1. Write **S4** (`stopping`, `lastStopReason`). Log `stop_begin`.
2. Write **S8** — release the desire — whenever the stop ends the session and is not a `user` stop
   (§8). Log `desire_released`. Here, not just before step 7: doing it early is what keeps the
   start-during-shutdown race intact.
3. `timeout 240 systemctl stop dst-caves.service`, then the same for `dst-master.service`.
   Log `shards_stopped`. Each unit's `ExecStop` is `dst-stop <Shard> $MAINPID`:
   1. `c_shutdown(true)` into that shard's FIFO — this, not SIGTERM, is the primary save.
   2. Wait up to **60 s** for `Shutting down` in that shard's log (measured 2.0–3.1 s).
   3. Seen: kill the FIFO holder so stdin EOFs (the process cannot exit otherwise), wait 30 s,
      then `SIGKILL`. **Never EOF a shard that has not printed `Shutting down`** — that
      permanently kills a healthy shard's console.
   4. Not seen in 60 s: `SIGTERM` (it does serialize one slot), wait up to **30 s** for
      `Shutting down`, kill the holder, wait 10 s, `SIGKILL`.
   `TimeoutStopSec=200`, `KillMode=mixed`. A non-zero exit **after** `Shutting down` (the final
   teardown saw `11/SEGV`) is benign; only a failure before it is data loss. `ExecMainStatus` is
   logged, never acted on.
4. **Push the save** (§10) iff the Master ever logged `LOAD BE: done` — otherwise the world was
   never fully loaded or generated and the restored version is still authoritative. Log
   `save_pushed`, or `save_push_skipped_world_never_loaded`.
5. Upload the session logs and `manifest.json` (§10). Log `logs_uploaded`.
6. Write S6 (or S5 on the switch race — log `switch_commit`).
7. **`haltNow`**: sink `play.dst.ty.ler.dev` to `192.0.2.1` (decisions §17; logged
   `join_dns_sunk`, or `join_dns_failed` and carry on), then `shutdown -h now`
   (`InstanceInitiatedShutdownBehavior=terminate`). Log `halting`.

`haltNow` is the **only** place this program calls `HostPort.shutdownNow` — `rg 'host\.shutdownNow'
packages/supervisor/src` must match only its own body, and a unit test asserts it — which is how
"every halt sinks the record" is proved rather than argued. It also gives the rule for the case
that must *not* sink: an **in-place switch** keeps the same instance and the same IP, and a switch
returns `{ kind: 'switch' }` without halting, so the record keeps pointing at the instance that is
still running. The sink is last, after S8, the save push and the final `stopped` write, so it
cannot come between any of them; and it is wrapped in a `try`, because losing the sink costs a
stale record the reaper will fix, while losing the poweroff costs a month of EC2.

Budgets: pack 120 s; each upload 120 s, 3 attempts, backoff 1/2/4 s; each DDB write 10 s, 3
attempts. Global stop budget **8 min** from step 1 — anything unfinished is logged and step 7 runs
anyway. The dead-man `shutdown -h +780` and the reaper are the backstops — including for the DNS
sink: an instance that dies by the panic unit, the dead-man or a hard crash never reaches step 7,
and the reaper sinks the record on the next tick that ends the session (`docs/control-plane.md`
§6).

**Every step logs.** `session_begin`, `join_dns_published`, `shards_started`, `stop_begin`,
`desire_released`, `shards_stopped`, `save_pushed` / `save_push_skipped_world_never_loaded`,
`logs_uploaded`, `switch_commit`, `join_dns_sunk`, `halting`. Before they existed, a healthy
switch jumped straight from `joinable`
(world A) to `joinable` (world B) in `supervisor.log`, with a silent hole where the shard stop, the
save push, S5 and B's start belong — which is most of why the switch bug of §6 took five runs to
reproduce. The whole timeline is now readable off these lines.

**Measured** (`c6i.large`, us-west-2): idle deadline reached → `save_pushed` **4 s**; idle deadline
→ `status=stopped` (the full stop sequence) **49 s**; instance `terminated` 20–30 s after the final
state write; in-place switch → the new world `running` **30–81 s over 12 switches** (median ~40 s),
of which the stop of the old world (shards + save push + logs + S5) is **4–32 s**; a `POST stop`
from the UI → `stopped` with a second save version **31 s**.

## 10. Save tarball, session logs, manifest

`dst-pack-save <clusterDir> <out.tar.zst>` — with both shards stopped, or (inflight) with them
running but never mutating the live cluster:

The archive **format, exclude list and root layout are owned by `docs/storage.md` §6** — the
cluster directory's *contents* at the archive root, no wrapper directory (decisions §16.22). The
tarball is produced **one way everywhere** (decisions §16.36): stage a copy of the cluster
directory, blank the password in the staged `cluster.ini` **and in every staged
`<Shard>/save/shardindex`**, then run the single §6 tar command with its single exclude list,
unchanged. `dst-pack-save` and `scripts/import-world.ts` (`docs/storage.md` §7 step 5) therefore
yield the **same member set and the same archive root** — there is no second exclude list and no
second command to keep in sync:

```bash
set -euo pipefail
STAGE=$(mktemp -d /opt/dst/tmp/stage.XXXXXX)
trap 'rm -rf "$STAGE"' EXIT
cp -R "$CLUSTER/." "$STAGE"
KEY=cluster_password
sed -E -i "s/^([[:space:]]*${KEY}[[:space:]]*=).*\$/\\1 /" "$STAGE/cluster.ini"

# cluster.ini is NOT the only copy of the password on disk — see below.
SKEY=password
SHARD_INDEX_SED='s/((\[")?'"$SKEY"'("\])?[[:space:]]*=[[:space:]]*)"[^"]*"/\1""/g'
find "$STAGE" -type f -name shardindex -path '*/save/shardindex' \
    -exec sed -E -i "$SHARD_INDEX_SED" {} +

# the command and exclude list of docs/storage.md §6, verbatim, over the staged copy
ZSTD_CLEVEL=3 ZSTD_NBTHREADS=0 tar --zstd -c -f "$OUT" -C "$STAGE" \
    --exclude='cluster_token.txt' \
    --exclude='*/save/server_temp' \
    --exclude='*/save/client_temp' \
    --exclude='*/save/cached_userid' \
    --exclude='*/server_log.txt' \
    --exclude='*/server_chat_log.txt' \
    --exclude='*/backup' \
    .
```

**`cluster.ini` is not the only copy of the password on disk.** DST keeps a per-shard save index at
`<Shard>/save/shardindex` — a Lua table literal — and **mirrors the live server settings into it,
the password included**. DST writes it, from `cluster.ini`, on the shard's first boot; nothing in
this repo puts it there, which is why every audit of our own sinks found the `worlds/`/`inflight/`
path clean. Measured in T5.2: of 28 files in a live cluster, **3** held the value —
`cluster.ini`, `Master/save/shardindex`, `Caves/save/shardindex` — and the tarball
`dst-pack-save` produced still carried **2** of them into `worlds/<id>/save.tar.zst`, where
`s3:DeleteObject` is denied by the bucket policy and the object therefore cannot be removed. Every
existing check passed: right member set, no `cluster_token.txt`, blank `cluster.ini` password line.

**It is blanked, never excluded.** The three `save/` excludes are per-instance scratch that DST
regenerates; `shardindex` is not. A shard whose `save/` carries **no index reads as an empty slot,
and DST would generate a new world over the restored one** — the one failure mode "the save is
precious" cannot tolerate. Blanking is safe in the other direction too: the value there is a
mirror, not the source. The supervisor rewrites `cluster.ini` from `/dst/cluster-password` on every
boot (`core/ini.ts`'s `enforceClusterPassword`) and DST re-populates `shardindex` from
`cluster.ini`. Both spellings DST's serializer can emit are covered (`password="…"` and
`["password"]="…"`); the key goes through a shell variable so `scripts/check-secrets.sh` stays
happy; the live cluster is only ever read. Measured on one shard index: 1994 → 1984 bytes, the
value gone and nothing else touched. `scripts/lib/save-tarball.ts` carries the exact
`String.replace` twin (`blankShardIndexPassword`) plus `assertShardIndexPasswordsBlank`, verified
byte-identical on the same fixtures.

Staging is also what makes the inflight copy safe while the shards are running: the live cluster is
never mutated, only read.

The three `save/` exclusions are the `E_ROWID_EXIST` fix: carried onto a new public IP they make
the Master's lobby registration fail forever and the Caves shard never link — a cluster healthy by
every local signal and simply unjoinable (spike §5). `*/backup` is DST's rotated log directory, not
the `c_rollback` snapshots (which live in `*/save/session/` and are kept). `cluster_token.txt` is
excluded and the password is blanked **in `cluster.ini` and in every `<Shard>/save/shardindex`**, so
a save tarball never carries a secret (decisions §5, §8).
**Do not port `docs/spikes/artifacts/dst-save-push` verbatim** — its exclude list is right, its
wrapper-directory layout is not (decisions §16.22).

Upload with the SDK (`PutObject`), not the CLI, so `VersionId` comes back:
`worlds/<worldId>/save.tar.zst` -> `postStopVersionId`; the restore's `GetObject` gave
`preStartVersionId`. Backups *are* these S3 versions (decisions §8). **Session logs** ->
`sessions/<worldId>/<sessionId>/`: `master/server_log.txt`, `master/server_chat_log.txt`,
`caves/server_log.txt`, `caves/server_chat_log.txt` (Caves only when `hasCaves`), `supervisor.log`
(a copy of `/var/log/dst/supervisor.log` — required by decisions §16.22, because the instance is
gone by the time anyone debugs it) and `manifest.json`. **The manifest schema is owned by
`docs/storage.md` §8**; the TypeScript shape the supervisor writes is:

```ts
interface SessionManifest {
  sessionId: string; worldId: string;   // sessionId: YYYYMMDDTHHMMSSZ-<6 hex>
  startedBy: string;                 // NICKNAME, never a SteamID64
  startedAt: string; joinableAt: string | null; stoppedAt: string;   // ISO 8601
  stopReason: StopReason;            // @dst/shared; the instance only ever writes
                                     // idle | user | switch | crash
  peakPlayers: number;               // max over non-UNKNOWN readings
  instanceType: string;              // IMDS
  dstBuildId: string;                // appmanifest_343050.acf
  preStartVersionId: string | null;  // null when the world was generated
  postStopVersionId: string | null;  // null when no save was pushed
}
```

`startedBy` is the state item's `startedByNickname`, copied verbatim; on a null, `"unknown"`. **The
instance never reads `/dst/users` and has no IAM access to it** (decisions §16.6) — the API already
resolved the nickname, and on an in-place switch S5 copies `desiredByNickname` into
`startedByNickname`.

**Log scrubbing before upload** (decisions §16.22): every file going to `sessions/` —
the four DST logs and `supervisor.log` — is checked by **exact match** (`grep -F`) against the
token value and the password value fetched from SSM; any matching line is redacted before the
`PutObject`. Shard logs may hold player names and Klei ids; they must never hold the token or the
password. **The scrub list is resolved from `SecretPort` at upload time**
(`tasks/logsUpload.ts`'s `resolveSecretsToScrub`), never from the process-lifetime set that
`Secret.reveal()` fills as a side effect: those reveals only happen in `restoreOrGenerateWorld`,
which the crash-resume branch deliberately skips, so after any supervisor restart
(`Restart=on-failure`) the replacement process would have uploaded every session log **unscrubbed
and silently**. Both SSM reads are already cached, so resolving them here costs nothing, and the
reveals re-arm the logger's redaction for the rest of the stop sequence.
**Secret hygiene, enforced in code:** `adapters/ssm.ts`
returns a `Secret<string>` whose `toString()`/`toJSON()` yield `'***'`; the INI writer, the
token-file writer and the scrub-list resolver are the only callers of `.reveal()`;
`adapters/logger.ts` redacts any revealed value by substring before writing a line. Secrets are
never process arguments (`/proc/*/cmdline` is world-readable) and no helper touching them runs under
`set -x`. `cluster_token.txt` is mode 0600, `dst:dst`.

## 11. Bundle and deploy

- `esbuild.mjs`: `--bundle --platform=node --target=node22 --format=cjs --sourcemap=inline
  --outfile=dist/supervisor.js`, **no `--external`** — the four AWS SDK v3 clients (`client-dynamodb`,
  `lib-dynamodb`, `client-s3`, `client-ssm`) are dependencies of this package and are
  bundled, so the instance never runs an install.
- `pnpm --filter @dst/supervisor build` stages `dist/supervisor.js`, `assets/install.sh`,
  `assets/bin/*`, `assets/systemd/*` and a `VERSION` file (the git sha) into
  **`packages/supervisor/dist/runtime/`** — the exact directory `DstGame`'s `BucketDeployment`
  reads (`docs/infra.md` §3.2, `destinationKeyPrefix: 'runtime'`, `prune: true`). `prune: true` is
  safe: it only lists and deletes under `runtime/`, and `runtime-cache/` is a different prefix.
- `assets/user-data.sh` is read by CDK — through the context-resolved `userDataPath`, default
  `../supervisor/assets/user-data.sh`, with `assets/node.env` read from the same directory
  (`docs/infra.md` §1.1, §3.6) — has its `__PLACEHOLDERS__` substituted and goes into the launch
  template: editing user-data means a new launch-template version, editing anything else does not.
  `packages/infra`'s tests and its one credentialed fixture synth point `userDataPath` at a
  committed placeholder instead, so the infra package never depends on this one having been built.
- **A new runtime version reaches the next boot** because user-data runs
  `aws s3 sync s3://<bucket>/runtime/ --delete` on every start. Running instances are unaffected;
  there is no pinning and no rollback beyond redeploying. The supervisor's first log line is
  `runtime VERSION=<sha>`.

## 12. Unit tests (Vitest, `core/` only, no AWS, no fs)

**No save-shaped fixture is ever committed** (decisions §16.35). `core/` is pure, so most tests need
no files at all; where one does (`ini.ts`, `templates.ts`), the `cluster.ini`, `cluster_token.txt`
or `*.zip` is **generated at test time into a `mktemp -d` directory** and deleted.

**There is no unit test of the tar archive's shape here.** The tar command and its exclude list are
shell (`assets/bin/dst-pack-save`, §10; the single definition is `docs/storage.md` §6), not `core/`,
so nothing in `test/` can exercise them without the script existing. What §10 *is* pinned by:
`ini.ts`'s password-blanking test below, and the lifecycle test's member-set assertion against a
real tarball (`docs/testing.md` §4.4 phase 4 — `cluster.ini` and `Master/` at the archive root, no
`cluster_token.txt`, no `*/save/server_temp`, no `*/backup`). `.gitignore` and `scripts/check-secrets.sh` block tracking exactly those names, so a
committed fixture cluster would fail the pre-push hook. In any committed template or test string the
password line reads exactly `cluster_password = <injected from SSM at boot>` or uses a `${…}`
interpolation — `scripts/check-secrets.sh` rejects any other value on that key's line.

Five test titles below are quoted **verbatim** because `docs/testing.md` §2 names them as
must-haves and they are verified by an exact `grep` over the collected test names: `unknown reading is never treated as zero`, `three consecutive zero polls are
required`, `player count ignores shard_players`, `a world requested during shutdown is started
instead of terminating`, `save is not pushed when the world never finished loading`. Do not reword
them.

- `count.ts` — the five measured states of spike §9: `0 0 0`/`0 0 0` -> 0; surface `1 1 1`/`1 1 0`
  -> 1; caves `1 1 0`/`1 1 1` -> 1; mid-migration `1 1 0`/`1 1 0` -> **1**; after disconnect
  `1 0 0`/`1 0 0` -> **0** — that last one is titled exactly
  `player count ignores shard_players` (the stuck-`shardplayers` case); plus the `hasCaves=false`
  formula.
- `parse.ts` — the `RemoteCommandInput:` echo does not match, the answer does; trailing TAB
  tolerated; wrong nonce ignored; `ok=false` and `nil` fields -> UNKNOWN; `World 40987672(Caves) is
  now connected` matches while `World 2 is now connected` does not; anchored `Sim paused`/`Sim
  unpaused` match, `Server Autopaused` does not; `LOAD BE: done`; the shard-disconnect line;
  buildid from a sample `appmanifest_343050.acf`.
- `idle.ts` — one zero does not start the clock, three consecutive do (titled exactly
  `three consecutive zero polls are required`); a non-zero between zeros
  resets the streak; UNKNOWN holds without resetting, titled exactly
  `unknown reading is never treated as zero`; 10 UNKNOWNs -> crash; `players===0 &&
  !simPaused` holds; `idleDeadline = max(joinableAt, lastNonZeroAt) + idleMinutes`; `idleMinutes=3`
  fires at 3 min; the deadline survives a rehydrate from `session.json`.
- `reduce.ts` — orphan at boot halts with zero writes; desired goes null while `starting` -> stop
  `user` with **no** save push (no `LOAD BE: done`), titled exactly
  `save is not pushed when the world never finished loading`, while `running` -> stop `user` with a
  push; a different world while `running` -> stop `switch` then start B in place under a new
  sessionId; a switch requested while already `stopping` -> start B instead of terminating, titled
  exactly `a world requested during shutdown is started instead of terminating`; write S6's condition
  failing -> start `desiredWorldId` instead of `shutdown`; shard exit while `running` -> stop
  `crash` with a push, while `starting` -> without one; boot timeout at 15 min; `hasCaves=false`
  never starts or polls Caves; every emitted write carries a `sessionId`+`instanceId` condition.
- `ini.ts`/`templates.ts` — setting an existing key preserves comments and order;
  `cluster_password` is replaced in whichever section holds it and appended to `[NETWORK]` when
  absent; `console_enabled` forced to `true`; the Caves `id` pinned; a generated cluster has no
  `save/` directory. The `world gen overrides` group pins the **preset** approach of §5: both
  preset ids (`SURVIVAL_TOGETHER`, `DST_CAVE`), `override_enabled`, and an assertion that neither
  file contains a partial level definition (`location =`, `task_set`). There is no
  `level data overrides` test any more and no `leveldataoverride.lua` is written.
  `manifest.ts` — `startedBy` is a nickname; `peakPlayers` ignores UNKNOWN;
  `preStartVersionId` is null for a generated world.
- `lobby.ts` — the report threshold (3 errors) and the recovery threshold (36) fire at the right
  counts, only the `Master Server Broadcast Error:` line is a countable error, and at most
  `MAX_LOBBY_RECOVERIES` recoveries are attempted (§7).

- `tasks/joinDns.ts` + `adapters/route53.ts` (decisions §17) — the change batch is exactly one
  `UPSERT` of one `A` record, TTL 60, with the normalized name (lowercase, no trailing dot: the
  IAM condition of `docs/infra.md` §3.5 fails closed otherwise); `publishJoinRecord` writes the
  instance IP and `haltNow` writes the sink; **neither throws when Route 53 fails**, and `haltNow`
  powers the instance off anyway. Plus two assertions over `src/index.ts`'s own source, because
  importing that module would run `runSupervisor()`: it never calls `shutdownNow` itself, and
  every `haltNow` is immediately followed by a return that ends the supervisor — which is what
  makes "every halt sinks, a switch never does" checkable.

**What `core/`-only coverage does not reach.** `queryShard` and the phase loops live in `index.ts`,
so the log-tailer bug of §7 and the double-install of §4 are caught by the lifecycle test's phase 1,
not by a unit test. If a later task wants a regression test, the natural shape is to move the query
round trip into `core/` behind a clock plus a "read new lines" port.

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

A stuck boot is almost always one of three things, and each now has a log line to grep for. Start
with `boot_timeout` in `supervisor.log`: it prints every clause of the joinable predicate (§8), which
usually names the cause outright.

| Cause | Grep for | Check |
|---|---|---|
| Klei lobby refusing to register (`E_ROWID_EXIST`) | `lobby_registration_failing` / `lobby_registration_stuck` in `supervisor.log`; `grep -c E_ROWID_EXIST` on the Master log | the tarball carried `save/server_temp` (fix: §10's excludes), or the token is re-registering too fast (fix: wait, §7) |
| the Caves shard never linking | absence of `World N(Caves) is now connected` in the Master log | `systemctl status dst-caves`, `journalctl -u dst-caves` |
| a FIFO that became a regular file | `shard_console_unwritable` in `supervisor.log` | `ls -l /opt/dst/run/*.fifo` — every one must start with `p` |

`ls -l /opt/dst/run/` is worth a glance regardless: a line beginning `-rw` instead of `prw` for a
`*.fifo` is the §6 race, and the world will never become joinable however healthy it looks.
