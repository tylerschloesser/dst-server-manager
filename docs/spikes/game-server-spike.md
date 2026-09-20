# Spike results: DST game server on EC2

Executed 2026-09-20 (UTC) against AWS account `063257577013`, region `us-west-2`.
Spec: `docs/spikes/game-server-spike-spec.md`. Prototype scripts and units (no secrets):
`docs/spikes/artifacts/`.

Server build observed: DST dedicated server app 343050, **build 747465**, save version 5.23.
Cluster: Tyler's real save (Master + Caves, 6 max players, no mods, `pause_when_empty = true`,
`console_enabled = true`).

> Status: COMPLETE. Three boots, one real player, full teardown verified.

---

## Resource ledger

| Resource | Id / name | Created | Deleted |
|---|---|---|---|
| S3 bucket | `dst-spike-063257577013` (us-west-2, private, public-access-block on) | yes | pending |
| IAM role | `dst-spike-instance` (`AmazonSSMManagedInstanceCore` + inline `dst-spike-bucket-rw`) | yes | pending |
| IAM instance profile | `dst-spike-instance` | yes | pending |
| Security group | `sg-0c99be7c27bc87549` (`dst-spike-sg`, vpc-fb98c39e) | yes | pending |
| EC2 instance boot1 | `i-006cf30e928719d62` (c6i.large) + its 30 GB gp3 root volume | yes | **terminated 02:20:06Z** |
| EC2 instance boot2 | `i-0610e0c614196844d` (t3.medium) + its 30 GB gp3 root volume | yes | **terminated 02:37:28Z** |
| EC2 instance boot3 | `i-07c7aa788e70bdded` (c6i.large) + its 30 GB gp3 root volume | yes | pending |

Default VPC `vpc-fb98c39e`, subnet `subnet-83c689f4` (us-west-2a, auto-assign public IP).
AMI `ami-04678417fc39d7171` (Ubuntu 24.04 x86_64, from the Canonical SSM public parameter).
Every instance: `InstanceInitiatedShutdownBehavior=terminate` and `shutdown -h +240` as the first
line of user-data. No SSH key, no port 22; all access via SSM Run Command.

---

## 1. Boot 1 — `c6i.large`, cold install

`RunInstances` at **01:30:51Z**.

| Phase | Wall clock (UTC) | Δ | Cumulative from RunInstances |
|---|---|---|---|
| `RunInstances` returns | 01:30:51 | — | 0 s |
| instance state `running` | 01:31:07 | 16 s | **16 s** |
| SSM agent `Online` | 01:31:14 | 7 s | **23 s** |
| user-data starts | 01:31:09.5 | — | 18.5 s |
| apt (i386 arch + packages) | 01:31:34.8 | **25.3 s** | 43.8 s |
| AWS CLI v2 installed | 01:31:37.7 | 2.8 s | 46.7 s |
| steamcmd bootstrap downloaded | 01:31:38.6 | 0.3 s | 47.6 s |
| `app_update 343050 validate` (full cold install) | 01:35:21.0 | **222.4 s** | 270 s |
| save restored from the zip | 01:35:23.0 | 2.0 s | 272 s |
| units written, both shards started | 01:35:23.4 | 0.4 s | 272.5 s |
| `Online Server Started on port: 10999` | 01:35:29.8 | 6.4 s | 279 s |
| world loaded (`LOAD BE: done`, uptime 00:00:28) | ~01:35:51 | ~21 s | 300 s |
| `Sim paused` (uptime 00:00:35) | ~01:35:58 | | 307 s |
| `[Shard] Secondary Caves(N) ready!` + `World N(Caves) is now connected` (00:00:36) | ~01:35:59 | | **308 s** |

**Boot 1 click-to-joinable ≈ 308 s (5 min 8 s).** 222 s of that — 72 % — is the cold
steamcmd download.

- steamcmd downloaded **4,488,499,525 bytes**; on-disk install `4305 MB` (+ `195 MB` steamcmd
  itself, + `42 MB` cluster). Root volume used 7.5 GB of 30 GB.
- A nonce'd console query already answered `true 0 0 0` on **both** shards at uptime
  `00:00:34`, i.e. ~2 s before the shard link came up. The Lua VM is live before the cluster is
  joinable, so the query alone is not a joinable predicate.

### Exact apt package list (Ubuntu 24.04 x86_64)

```bash
dpkg --add-architecture i386
apt-get update
apt-get install -y \
    lib32gcc-s1 lib32stdc++6 libcurl4-gnutls-dev:i386 \
    ca-certificates curl tar unzip zstd jq bc procps
```

**Gotcha (measured):** also installing the **amd64** `libcurl4-gnutls-dev` alongside the `:i386`
one is not co-installable and makes `dpkg` abort the whole transaction — every package in the
batch is left `install ok unpacked` instead of `installed`. Boot 1 hit this. It happened to be
survivable (unpacked `.so` files are on disk and steamcmd worked), but it is silent breakage
waiting to happen. Install only the `:i386` variant.

The AWS CLI is **not** in the Ubuntu cloud image. Installing v2 from the official zip took 2.8 s;
in the real design it should be baked into the binaries tarball instead.

### Config edits needed on the save copy: **none**

`cluster.ini` already has `console_enabled = true` (asserted in the log startup block as
`PauseWhenEmpty: true` / console active) and `pause_when_empty = true`. The one edit the research
proposed — pinning `[SHARD] id = 2` in `Caves/server.ini` — turns out to be **unnecessary**,
because the joinable line carries the shard *name*:

```
[00:00:31]: [Shard] Secondary shard Caves(40987672) connected: [LAN] 127.0.0.1
[00:00:31]: [Shard] Secondary Caves(40987672) ready!
[00:00:31]: World 40987672(Caves) is now connected
```

The research's proposed regex `World 2 is now connected` would **never** match: the real format is
`World <shardid>(<ShardName>) is now connected`. Anchoring on `World [0-9]+\(Caves\) is now
connected` needs no config change at all.

I did test the pin, because the Master's portal table is keyed on the old shard id and that looked
dangerous:

```
# with id pinned to 2                      # with the original id 40987672
Master: portal[1] <-> 2[1] (disabled)      Master: portal[1] <-> 40987672[1] (disabled)
Master: portal[oceanwhirl...] (active)     Master: portal[oceanwhirl...] (active)
Caves:  portal[1] <-> 1[1] (active)        Caves:  portal[1] <-> 1[1] (active)
Caves:  portal[oceanwhirl...] (disabled)   Caves:  portal[oceanwhirl...] (disabled)
```

Byte-for-byte the same active/disabled pattern either way, so pinning is *harmless* — but there is
no reason to take the risk. **Recommendation: do not touch the save; read the shard name from the
log line.** (The asymmetric `disabled`/`active` pattern is DST's normal 2-shard steady state, not
a fault — it is identical in both runs.)

### Minimal security group

**UDP 10998-10999 from 0.0.0.0/0 is enough.** No 27016/27017 was ever opened, and the cluster
still registered and appeared in the Klei lobby:

```
GET https://lobby-v2-cdn.klei.com/us-east-1-Steam.json.gz   (region read from the Master log:
                                                             "Server registered via geo DNS in us-east-1")
{"name":"Tyler & Ni 2026","connected":0,"maxconnections":6,"serverpaused":false,
 "secondaries":["40987672"],"mode":"survival","season":"winter","platform":1,"port":10999}
```

Note the Klei region is `us-east-1` even though the instance is in `us-west-2` — the lobby region
must be parsed from the log, never assumed. The lobby JSON is served **uncompressed** despite the
`.gz` name (`file` reports "JSON text data"), so a naive `gzip -d` fails; handle both.

Also note `serverpaused: false` while the Master log says `Sim paused`, with zero players. The
lobby's `serverpaused` field does **not** track `Sim paused` — do not use it for idle detection.

**A2S:** confirmed dead. A `TSource Engine Query` to 127.0.0.1:27016 (the Master's own
`master_server_port`, queried from the instance itself) times out. Drop it.

Ports actually bound: `0.0.0.0:10999` and `0.0.0.0:27016` (Master), `0.0.0.0:10998` and
`0.0.0.0:27017` (Caves), `127.0.0.1:10888` (shard link, loopback only as expected).

---

## 2. Idle detection

### The query works, and it works while the sim is paused

**Open question #3 is RESOLVED: yes, stdin Lua executes while the sim is paused.** Five rounds
over five minutes against an empty, `Sim paused` cluster, on both shards, all `true 0 0 0`:

```
round 1  master: DSTQ 884814458 true 0 0 0  (60 ms)   caves: DSTQ 851718856 true 0 0 0  (61 ms)
round 2  master: DSTQ 506410507 true 0 0 0  (61 ms)   caves: DSTQ  11975192 true 0 0 0  (61 ms)
round 3  master: DSTQ 820265630 true 0 0 0  (61 ms)   caves: DSTQ 200296592 true 0 0 0  (60 ms)
round 4  master: DSTQ 369830915 true 0 0 0  (60 ms)   caves: DSTQ 851861471 true 0 0 0  (60 ms)
round 5  master: DSTQ 979649380 true 0 0 0  (61 ms)   caves: DSTQ 436596903 true 0 0 0  (60 ms)
```

`ok == true` on both shards, so `TheWorld.shard.components.shard_players` resolves on a dedicated
server on **both** the Master and the Caves shard. Round-trip is **≤ 61 ms** (and the floor is my
50 ms poll granularity — several samples came back in 6-7 ms).

**Final query line (unchanged from the research, and it is correct):**

```lua
local ok,s,c,a = pcall(function() return TheWorld.shard.components.shard_players:GetNumPlayers(), #GetPlayerClientTable(), #AllPlayers end) print("DSTQ <NONCE> "..tostring(ok).." "..tostring(s).." "..tostring(c).." "..tostring(a))
```

### NEW: the server echoes console input into `server_log.txt`

This is the one thing that will silently break a naive implementation, and the research does not
mention it. Every line written to the FIFO is logged **verbatim** before it runs:

```
[00:01:20]: RemoteCommandInput: "print("DSTQ 777 hello")"$
[00:01:20]: DSTQ 777 hello^I$
```

So `grep "DSTQ $NONCE"` matches the **echo of the command**, not the answer — and the echo
contains the literal text `"..tostring(ok).." `, which parses as garbage. My first implementation
had exactly this bug. **The response regex must be anchored on the answer's shape:**

```
DSTQ (\d+) (true|false) (\S+) (\S+) (\S+)
```

Lines end with a single **trailing TAB** (`^I$` above) — confirmed, as the research predicted from
`debugprint.lua`'s `packstring()`.

### Pause lines

- Anchored `^\[[0-9:]+\]: Sim (un)?paused[[:space:]]*$` matched exactly **1** line on an idle
  cluster, and it carries **no trailing tab** (`[00:00:30]: Sim paused$`) — unlike `print` output.
- `Server Autopaused` / `Server Unpaused`: **0** occurrences on a 2-shard idle cluster, as
  predicted. (The count is expected to explode once a player connects; to be re-checked in the
  player phase.)
- `Sim paused` **is** mirrored into the Caves log, but 3 s later here (Master `00:00:30`,
  Caves `00:00:33`), not ±1 s. Parse the Master's.

### Zero-player client table

```
ROW 1 [Host] perf=0 netid=nil admin=true
ROWEND
```

One `[Host]` row with `performance ~= nil` and `netid == nil`, and `#GetPlayerClientTable()`
correctly reported **0** — Klei's own helper strips the host row, so no manual filtering is needed.

`c_listallplayers()` with zero players printed **absolutely nothing** between two marker prints,
which is exactly the ambiguity ("answered zero" vs "never ran") that motivates the nonce.

### Log growth

**305 bytes per Master query** (most of it the echoed `RemoteCommandInput` line). At a 30 s poll on
two shards that is ~73 KB/hour/shard — irrelevant against a session of a few hours.

---

## 3. Resource fit, empty + `Sim paused` (c6i.large, 2 vCPU / 3812 MB)

21 samples at 5 s over ~2 minutes, plus per-process `/proc` accounting:

| | Master | Caves | Total |
|---|---|---|---|
| RSS | **1280 MB** | **1034 MB** | 2314 MB |
| CPU (% of one core) | **10.3 %** avg, 10.5 % max | **10.0 %** avg, 10.2 % max | ~0.2 vCPU |
| System memory used | | | **2725 MB of 3812 MB** (1086 MB available) |
| load1 | | | 0.09 – 0.31 |

Two things to note against the forum numbers:

- **Idle CPU is ~10 % per shard, not ~30 %.** The `pause_when_empty` sim really does stop doing
  work; the residual is network/housekeeping.
- **Idle RSS is ~1.1-1.3 GB per shard, not ~1 GB total.** An *empty* cluster already uses 2.7 GB
  of a 4 GiB box. `t3.small` (2 GB) is not merely "tight", it cannot hold an empty cluster.

## 4. Tarballs

| Artifact | Input | Setting | Time | Output |
|---|---|---|---|---|
| DST binaries + steamcmd | 4500 MB, 4305 MB of it the game | `zstd -3 -T0` | **58 s** | **3277 MB** |
| DST binaries + steamcmd | same | `zstd -10 -T0` | 87 s | 3221 MB |
| Upload 3.28 GB to S3 (same region) | | | **25 s** (~131 MB/s) | |
| Cluster dir (save) | 39 MB, 81 files | `zstd -3 -T0` | **0.22 s** | **5.9 MB** |
| Upload 5.9 MB to S3 | | | **0.83 s** | |

`zstd -10` buys 1.7 % size for 50 % more CPU time — **use `-3`**. DST's content is mostly
already-compressed assets, so 4.5 GB only shrinks to 3.3 GB (27 %).

## 5. Boot 2 — `t3.medium`, from the tarball

`RunInstances` at **02:20:10Z**. Same user-data as the target design.

| Phase | Δ | Cumulative |
|---|---|---|
| user-data starts | | 22 s |
| apt (i386 + packages) | **42.2 s** | 64 s |
| AWS CLI v2 | 3.5 s | 68 s |
| download `dst-binaries.tar.zst` (3.28 GB) from S3 | **24.9 s** (~131 MB/s) | 93 s |
| `tar -I zstd -x` 3.28 GB → 4.5 GB | **47.2 s** | 140 s |
| `app_update 343050` (no `validate`, already current) | **13.7 s** | 154 s |
| download + extract `cluster.tar.zst` (6.15 MB) | **1.2 s** | 155 s |
| units written, shards started | 0.3 s | **155 s** |
| `Online Server Started on port: 10999` | 7.5 s | 163 s |
| `LOAD BE: done` (world loaded) | ~21 s | ~184 s |
| `Sim paused` | | ~196 s |

The binaries tarball replaces 222 s of steamcmd with **86 s** (download + extract + a 13.7 s
no-op `app_update`) — a **136 s saving**, even on the slower instance type. apt is the next
biggest fixed cost at 42 s and is a pure AMI-bake candidate.

The Master **loaded save slot `0000000030`** — the slot boot 1's `c_shutdown(true)` had written
and pushed to S3. The full save round-trip through S3 works.

Optimisation not taken: the tarball is written to `/tmp` and then read back, so the root volume
eats 3.28 GB of writes plus 4.5 GB of writes. Piping `aws s3 cp - | tar -I zstd -x` would remove
the first 3.28 GB and should cut most of the 47 s extract, which is EBS-bound, not CPU-bound
(zstd and tar each sat at <20 % CPU).

### `app_update` timings (all against an already-current install)

| Invocation | Time |
|---|---|
| cold full install, `app_update 343050 validate` | **222.4 s** (4.49 GB downloaded) |
| `app_update 343050` (no validate), nothing to do | **13.7 s** |

### BLOCKER found on boot 2: `E_ROWID_EXIST`

Boot 2's Master could not register with the Klei master server:

```
[00:00:40]: Sim paused
[00:00:41]: [Http] Curl failed[1] with HTTP_500 ... _{"Error":{"Code":"E_ROWID_EXIST"}}_
[00:00:41]: [Error] Master Server Broadcast Error: E_ROWID_EXIST
[00:00:41]: Master Server Broadcast will try to broadcast a new listing.
   ... repeating every ~5 s
```

and, critically, **the Caves shard never linked**. Caves got as far as

```
[00:00:42]: [Shard] Connecting to master...
[00:00:42]: [Shard] Sending secondary shard information to master...
```

and the Master never answered — no `[Shard] Secondary shard Caves(N) connected`, no
`World N(Caves) is now connected`. On boot 1 the shard handshake happened *immediately after*
`Server registered via geo DNS in us-east-1`; here registration never succeeded, so the cluster
never became joinable even though both Lua VMs were alive and answering console queries.

The previous session's row is Klei-side state: the public lobby CDN already showed **no** listing
for this cluster at the time, yet the server still got `E_ROWID_EXIST`. The previous instance had
been terminated ~2.5 minutes before this Master started.

**Root cause found — and it is a save-tarball bug, not a Klei outage.** The state that collides
is carried in the cluster directory. The failure survived: restarting Caves alone, restarting both
shards, and ~20 minutes of the Master retrying every 5 s (219 consecutive `E_ROWID_EXIST`). What
fixed it, instantly:

```bash
systemctl stop dst-caves dst-master
rm -rf Master/save/server_temp Master/save/client_temp Master/save/cached_userid
rm -rf Caves/save/server_temp  Caves/save/client_temp  Caves/save/cached_userid
systemctl start dst-master dst-caves
```

```
[00:00:38]: Server registered via geo DNS in us-east-1
[00:00:38]: Sim paused
[00:00:41]: [Shard] Secondary Caves(40987672) ready!
[00:00:41]: World 40987672(Caves) is now connected
rowid_errors=0
```

**Registered on the first attempt, zero errors, shard linked 42 s after process start.**

So: `*/save/server_temp` (and the other per-instance scratch) records the server's lobby listing
identity. Restore it onto a **new public IP** and Klei rejects the new listing as a duplicate
row — and because the Master never finishes registering, it never completes the Caves shard
handshake either. A cluster that looks healthy by every local signal is simply not joinable.

**Therefore the save tarball must exclude `*/save/server_temp`, `*/save/client_temp` and
`*/save/cached_userid`.** The save-zip's own `backup.sh` excludes only `backup/` and
`server_log.txt`, so a naive port of it inherits this bug. `artifacts/dst-save-push` has the
correct exclude list. Boot 3 is the end-to-end confirmation: it restores a tarball built with
these exclusions onto a brand-new IP, 30 seconds after boot 2 was terminated.

### t3.medium: CPU credits do not work out

| | |
|---|---|
| credit mode at launch | `unlimited` (account default) |
| `CPUCreditBalance` | **0.0** — pinned at zero |
| `CPUCreditUsage` | ~4.0 per 5 min, against ~2.0 per 5 min earned at the t3.medium baseline |
| `CPUUtilization` (CloudWatch, instance-wide) | 23-35 % |

A brand-new burstable instance starts with no accrued balance, and an **empty, paused** DST
cluster already runs a permanent credit deficit. In `unlimited` mode that deficit is billed as
surplus credits on top of the hourly rate; in `standard` mode the instance would be throttled to
baseline. Either way `t3.medium` is the wrong shape for this workload, and that is before a
single player connects.

RSS on t3.medium was indistinguishable from c6i.large (Master 1203-1256 MB, Caves 979-1025 MB,
system 2695 MB of 3832 MB).

## 6. Boot 3 — `c6i.large`, from the tarball — THE HEADLINE NUMBER

`RunInstances` at **02:37:28Z**, exactly 30 s after boot 2 was terminated — i.e. the worst case
for the `E_ROWID_EXIST` problem, restoring a save tarball built with the corrected exclude list
onto a brand-new public IP.

| Phase | Δ | Cumulative from `RunInstances` |
|---|---|---|
| user-data starts | | 18 s |
| apt | 33.4 s | 52 s |
| AWS CLI v2 | 2.7 s | 54 s |
| download `dst-binaries.tar.zst` (3.28 GB) | 24.5 s | 79 s |
| extract 3.28 GB → 4.5 GB | 42.2 s | 122 s |
| `app_update 343050` (no validate) | **7.8 s** | 130 s |
| download + extract `cluster.tar.zst` (6.23 MB) | 1.0 s | 131 s |
| shards started | 0.2 s | 131 s |
| `Online Server Started on port: 10999` | 5.8 s | 137 s |
| `LOAD BE: done` (world loaded, uptime 00:00:23) | | 154 s |
| `Server registered via geo DNS` + `Sim paused` (00:00:32) | | 163 s |
| `World 40987672(Caves) is now connected` (00:00:33) | | 164 s |
| **`t_JOINABLE` (full predicate satisfied)** | | **165 s** |

# **Click-to-joinable: 165 s (2 min 45 s).**

**`rowid_errors = 0`.** The corrected exclude list is confirmed end to end: a fresh IP 30 seconds
after the previous session, registering on the first attempt.

### The joinable sequence, verbatim (Master, boot 3)

```
[00:00:05]: Online Server Started on port: 10999
[00:00:10]: 	LOAD BE
[00:00:23]: 	LOAD BE: done
[00:00:31]: [Shard] Starting master server
[00:00:31]: [Shard] Shard server started on port: 10888
[00:00:31]: Telling Client our new session identifier: 521AC329037766FE
[00:00:32]: Server registered via geo DNS in us-east-1
[00:00:32]: Sim paused
[00:00:32]: [Shard] Secondary shard Caves(40987672) connected: [LAN] 127.0.0.1
[00:00:33]: [Shard] Secondary Caves(40987672) ready!
[00:00:33]: World 40987672(Caves) is now connected
```

Notes against the research:

- It says `Secondary shard`, **not** the typo `Secondary shar`.
- `Server registered via geo DNS` is the true gate: everything after it (shard handshake
  included) depends on it, as boot 2 proved. It belongs in the joinable predicate.
- The first successful nonce round-trip on both shards landed at 157.3 s / 157.7 s — **before**
  `Sim paused` and the shard link, so the console round-trip is necessary but far from sufficient.

### Lobby entry (boot 3, live)

```json
{"__addr":"35.92.68.74","name":"Tyler & Ni 2026","session":"521AC329037766FE",
 "maxconnections":6,"connected":0,"dedicated":true,"mode":"survival","port":10999,
 "v":747465,"tags":"WS:AA,english,survival,vote,caves","season":"winter",
 "password":false,"serverpaused":false,
 "secondaries":{"40987672":{"__addr":"35.92.68.74","id":"40987672","port":10998}}}
```

The `__rowId` field in that JSON is literally `<host KU id>^<per-server suffix>` — which is the
identity `save/server_temp` was carrying forward, corroborating the `E_ROWID_EXIST` diagnosis.

> **Note for Tyler, not a measurement:** `cluster_password` exists in `cluster.ini` but its value
> is **empty** (`"password": false` in the live lobby entry). The world as shipped in the zip is
> publicly listed and joinable by anyone, contrary to the project brief's "password-protected".
> Worth setting before this becomes a real service.

## 7. Shutdown — the biggest surprise of the spike

### `c_shutdown(true)` saves in ~2 s, then the process hangs forever

```
01:37:57  RemoteCommandInput: "c_shutdown(true)"
01:37:57  c_shutdown   true
01:37:57  Serializing world: session/B9CA9FA2031150BE/0000000029
01:37:57  Serializing world: session/B9CA9FA2031150BE/0000000030
01:37:57  [Shard] Stopping shard mode
01:37:58  lua_close took 0.38 seconds
01:37:59  Shutting down
          ... nothing. SIGTERM ignored. systemd SIGKILLed it at 01:44:17 (6m18s later).
```

**Root cause, confirmed directly from `/proc`:** my first `dst-shard` held the FIFO's write end
open *inside the server process* (`exec 9<>"$FIFO"`, inherited across `exec`) so that stdin would
never EOF. At shutdown the process was left with two threads:

```
/proc/2627/fd/0 -> /opt/dst/run/Master.fifo      (read end)
/proc/2627/fd/9 -> /opt/dst/run/Master.fifo      (write end - the problem)
thread 2627  state=S  syscall=202 (futex)   <- main thread, joining...
thread 2670  state=S  syscall=0   (read)    <- ...the stdin console thread, blocked forever
```

The console thread is blocked in `read()` on a pipe that can never reach EOF because the process
itself holds the only writer. **Fix: hold the write end in a separate, killable process.** Killing
that holder made the hung process exit in **253 ms**.

This is a genuine trap for the systemd+FIFO design and it does not show up with `screen`/`tmux`
(a pty behaves differently). The shipped `dst-shard` / `dst-stop` in `artifacts/` implement the
correct three-step stop:

1. `c_shutdown(true)` into the FIFO (this is what saves),
2. wait for `Shutting down` in that shard's `server_log.txt` (world is fully serialized by then),
3. kill the FIFO holder so stdin EOFs — the process then exits cleanly, `ExecMainStatus=0`,
   `Result=success`.

### SIGTERM **does** save — the forum claim is refuted

`kill -TERM` on the Caves shard produced:

```
01:58:50  Serializing world: session/B9CA9FA2031150BE/0000000029
01:58:50  [Shard] Stopping shard mode
01:58:51  lua_close took 0.34 seconds
01:58:51  Shutting down     <- then hangs, same stdin trap
```

and a new save slot `0000000029` plus an updated `shardindex` landed on disk. So on build 747465
SIGTERM is **not** the data-loss hazard the community claims. Two differences remain, so
`c_shutdown(true)` is still the right primary: SIGTERM wrote **one** save slot where
`c_shutdown(true)` wrote **two**, and SIGTERM on Caves does **not** cascade to the Master.

`TimeoutStopSec` should still be generous, but because of the stdin trap, not because the save is
slow — the save itself is ~1-2 s.

### `c_shutdown(true)` on the Master does **not** cascade to Caves

This is the finding with the most consequence for the design. With both shards healthy and
linked, `c_shutdown(true)` written to the **Master** FIFO only:

```
Master  [00:00:58]: c_shutdown   true
Master  [00:00:58]: Serializing world: session/521AC329037766FE/0000000029
Master  [00:00:58]: Serializing world: session/521AC329037766FE/0000000030
Master  [00:00:58]: [Shard] Stopping shard mode
Master  [00:01:01]: Shutting down                      <- 3.1 s after the command

Caves   [00:00:58]: [Shard] We have been disconnected from the master. Waiting to reconnect...
Caves   [00:01:04]: [Shard] Connecting to master...
Caves   [00:01:14]: [Shard] Connection to master failed. Waiting to reconnect...
        ... repeats every 15 s, forever. Caves never saves and never exits.
```

The widely repeated community claim that shutting down the Master shuts down all shards is
**false** on build 747465. If the manager only told the Master, the Caves world would lose
everything since its last autosave on every single session. **Every shard must be told
individually** — `artifacts/dst-cluster-stop` and the per-unit `ExecStop` do this.

Worse, an **orphaned Caves cannot be rescued afterwards**: once the Master is gone, a
`c_shutdown(true)` written to the Caves FIFO produced no `RemoteCommandInput` line at all and the
shard never exited. Stop both shards while both are still healthy.

### Corollary: EOF permanently kills a healthy shard's console

Killing the FIFO holder of a *running* shard makes its stdin console thread exit for good
(confirmed via `/proc`: the thread blocked in `read()` simply disappears, and no later console
write is ever logged). The shard keeps running and keeps playing, but is permanently unpollable
and unstoppable by console. **Only ever EOF a shard that has already printed `Shutting down`** —
which is the ordering `artifacts/dst-stop` implements.

### Measured shutdown numbers

| Step | Time |
|---|---|
| `c_shutdown(true)` → world fully serialized (`Serializing world` ×2) | **< 1 s** |
| `c_shutdown(true)` → `Shutting down` in the log | **2.0 – 3.1 s** |
| `Shutting down` → process gone, after EOF | **0.25 s** |
| **Total graceful stop per shard** | **~3.5 s** |
| Cluster dir → `tar \| zstd -3` (39 MB, 81 files) | **0.22 s → 5.9 MB** |
| Upload 5.9 MB save tarball to S3 (same region) | **0.83 s** |

So the "up to 5 minutes" figure from the Jamesits Docker README is off by two orders of
magnitude for a 2-shard no-mod world. `TimeoutStopSec=200` is generous but harmless.

### Shard death is visible on the Master

When the Caves process died, the Master logged, within the same second:

```
World 40987672(n/a) is now disconnected
[Shard] A shard has disconnected: 'Caves(40987672)'
```

plus a re-validation of every portal as `(inactive)`. Good, cheap shard-loss signal.

---

## 8. Summary tables (pre-player-phase)

### Phase timings per boot

| Phase | Boot 1 (c6i.large, cold) | Boot 2 (t3.medium, tarball) | Boot 3 (c6i.large, tarball) |
|---|---|---|---|
| RunInstances → user-data start | 18.5 s | 22 s | 18 s |
| apt | 25.3 s (aborted) | 42.2 s | 33.4 s |
| AWS CLI v2 | 2.8 s | 3.5 s | 2.7 s |
| game binaries | 222.7 s (steamcmd cold) | 72.1 s (S3 + extract) | 66.7 s (S3 + extract) |
| `app_update` | (included above) | 13.7 s | 7.8 s |
| save restore | 2.0 s | 1.2 s | 1.0 s |
| shards start → world loaded | ~28 s | ~29 s | ~23 s |
| → registered + shard linked | ~8 s | (blocked) | ~10 s |
| **click-to-joinable** | **308 s** | (blocked by `E_ROWID_EXIST`) | **165 s** |

### RSS / CPU, empty + `Sim paused`

| | c6i.large | t3.medium |
|---|---|---|
| Master RSS | 1259-1280 MB | 1203-1256 MB |
| Caves RSS | 1027-1034 MB | 979-1025 MB |
| Master CPU (% of one core) | 9.1-10.5 % | ~12 % |
| Caves CPU (% of one core) | 9.5-10.2 % | ~13 % |
| System memory used | 2698-2725 MB of 3812 MB | 2695-2701 MB of 3832 MB |
| CPU credits | n/a (non-burstable) | **balance 0, permanent deficit** |

### Idle detection verdicts

| Candidate | Verdict |
|---|---|
| `shard_players:GetNumPlayers()` resolves on a dedicated server, both shards | **CONFIRMED** (`ok=true` on Master and Caves) |
| Console Lua executes while `Sim paused` | **CONFIRMED** — the linchpin assumption holds |
| Nonce round-trip latency | **≤ 70 ms** (6 ms best case) |
| `#GetPlayerClientTable()` strips the `[Host]` row | **CONFIRMED** (reads 0 with 0 players) |
| `c_listallplayers()` with 0 players prints nothing | **CONFIRMED** — motivates the nonce |
| Anchored `Sim paused` regex, no trailing tab | **CONFIRMED** (1 match, `Sim paused$`) |
| `Server Autopaused` noise on an idle 2-shard cluster | **CONFIRMED absent** (0 occurrences) |
| `Sim paused` mirrored to Caves | **CONFIRMED**, but 3 s later, not ±1 s |
| `World 2 is now connected` as the joinable line | **REFUTED** — real form `World <id>(<Name>) is now connected` |
| Server echoes console input to the log | **NEW** — `RemoteCommandInput: "<lua>"`, breaks a naive nonce grep |
| `Server registered via geo DNS` gates the shard link | **NEW** — must be in the joinable predicate |
| A2S on the Steam query port | **REFUTED** (timeout, as expected) |
| Klei lobby `serverpaused` tracks `Sim paused` | **REFUTED** — read `false` while the sim was paused |
| `c_shutdown` on Master cascades to Caves | **REFUTED** — Caves is orphaned and never saves |
| SIGTERM does not save | **REFUTED** — it does serialize one slot |
| Minimal SG = UDP 10998-10999 only | **CONFIRMED** — no 27016/27017 needed, lobby listing works |

---

## 9. Player phase (one real player, Tyler)

Player names and Klei ids are redacted to **player A**; the client's public IP is redacted.

### S2 — one player on the surface (Master)

```
Master: DSTQ <n> true 1 1 1        (shardplayers=1, clients=1, allplayers=1)
Caves : DSTQ <n> true 1 1 0        (shardplayers=1, clients=1, allplayers=0)
```

- `shard_players:GetNumPlayers()` reads **1 on both shards**. Open question #1(b) **CONFIRMED**:
  the `_localPlayers + _secondaryShardPlayers` netvar really does cross the shard boundary.
- **Open question #2 RESOLVED: `TheNet:GetClientTable()` is CLUSTER-WIDE.** The Caves shard
  reported `clients = 1` for a player who was on the Master and had never been in Caves.
  Therefore summing client tables across shards would double-count — `max()` is the correct
  formula, exactly as the research argued.
- `[Join Announcement] player A` appeared in **both** `Master/server_chat_log.txt` and
  `Caves/server_chat_log.txt`, byte-identical. Parse the Master's only. **CONFIRMED.**
- `Sim unpaused` fired on the Master at the join.

### S3 — one player in Caves only

```
Master: DSTQ <n> true 1 1 0        (shardplayers=1, clients=1, allplayers=0)
Caves : DSTQ <n> true 1 1 1        (shardplayers=1, clients=1, allplayers=1)
```

**This is the failure case the whole design exists to avoid, and it is safe.** A player alone in
the caves reads as **1** from the Master on two independent signals. Master-only polling would
*not* have shut the server down on him. Polling both shards is belt-and-braces, not mandatory.

### S4 — migration Master → Caves, every line, wall-clock

```
02:50:47.388 Master  [Shard] Migration request: (KU_x) to Caves(40987672)
02:50:47.400 Master  [Shard] Begin migration #1 for (KU_x)
02:50:47.403 Master  [Shard] #1 Master(1) -> Caves(40987672)
02:50:47.404 Master  [Shard] #1 <- session/<master-session>/<slot>
02:50:47.444 Caves   [Shard] #1 -> session/<caves-session>/<slot>
02:50:47.445 Caves   [Shard] Received migration #1 data for (KU_x)
02:50:47.467 Master  [Shard] Writing save location file for (KU_x)
02:50:47.468 Master  CloseConnectionWithReason: ID_DST_SHARD_SILENT_DISCONNECT
02:50:47.500 Master  [Shard] (KU_x) disconnected from Master(1)
02:50:49.468 Caves   New incoming connection <CLIENT_IP>
02:50:49.888 Caves   Client authenticated: (KU_x) player A
02:50:49.971 Caves   [Shard] Completed incoming migration #1 for (KU_x)
02:50:49.993 Master  [Shard] Completed migration #1 for player (KU_x)
```

**Whole migration: 2.6 s** — far tighter than the ~14 s the research inferred from third-party
logs.

Counts every 2 s straight through the hop:

| time | Master `s c a` | Caves `s c a` | `max()` |
|---|---|---|---|
| 02:50:45 | `1 1 1` | `1 1 0` | 1 |
| 02:50:47 | `1 1 1` | `1 1 0` | 1 |
| **02:50:49** | `1 1 0` | `1 1 0` | **1** |
| **02:50:51** | `1 1 0` | `1 1 0` | **1** |
| **02:50:53** | `1 1 0` | `1 1 0` | **1** |
| **02:50:56** | `1 1 0` | `1 1 0` | **1** |
| 02:50:58 | `1 1 0` | `1 1 1` | 1 |

**THE MEASUREMENT: maximum consecutive 2 s polls where `max()` read 0 = `0`.**

For ~9 seconds there was **no player entity in either world** (`#AllPlayers` summed to 0 across
both shards), yet `shard_players:GetNumPlayers()` and `#GetPlayerClientTable()` both held at
**1 on both shards** for the entire window. The netvar and the client table simply do not dip
during a migration.

So the transient the research was most worried about **does not exist for the recommended
formula**. It exists only for the naive `#AllPlayers` sum — which is precisely why that must not
be the sole signal.

Corroborating, through the whole migration:

- **No `Sim paused` / `Sim unpaused`.** The only two pause edges in the entire Master log were
  `Sim paused` at boot (00:00:32) and `Sim unpaused` at the join (00:09:39).
- **No `[Join Announcement]` / `[Leave Announcement]`** in either chat log.
- `Server Autopaused` / `Server Unpaused`: **0 occurrences** for the whole session, player
  connected or not. The research's warning that these would "explode once a player connects"
  (154 in 45 min in a third-party log) did **not** reproduce on build 747465 — but the anchored
  `Sim paused` regex distinguishes them anyway, so nothing changes.

### Incidental findings about this world

- All 10 surface sinkholes are the **plugged** `cave_entrance` prefab; there is no
  `cave_entrance_open`. That is what the boot-1 portal table was reporting: the Master's
  numbered portals read `(disabled)` and only `oceanwhirlbigportal` reads `(active)`. The
  inverse pattern on the Caves side (`cave_exit` ×10 `(active)`,
  `oceanwhirlbigportalexit` `(disabled)`) is the matching half. The world is therefore
  *down via the ocean whirlportal, up via any cave exit* — a working pair, not a fault.
- Console-driven teleport onto an active shard portal triggers a real migration, which is how the
  measurement above was obtained.

### S4b — migration Caves → Master (the return trip)

```
02:53:31.661 Caves   [Shard] Migration request: (KU_x) to Master(1)
02:53:31.681 Master  [Shard] Begin migration #2 for (KU_x)
02:53:31.682 Master  [Shard] #2 Caves(40987672) -> Master(1)
02:53:31.690 Caves   [Shard] #2 <- session/<caves-session>/<slot>
02:53:31.732 Master  [Shard] #2 -> session/<master-session>/<slot>
02:53:31.733 Master  [Shard] Received migration #2 data for (KU_x)
02:53:31.734 Master  [Shard] Writing save location file for (KU_x)
02:53:31.740 Caves   CloseConnectionWithReason: ID_DST_SHARD_SILENT_DISCONNECT
02:53:31.798 Master  [Shard] (KU_x) disconnected from Caves(40987672)
02:53:33.990 Master  New incoming connection <CLIENT_IP>
02:53:34.410 Master  Client authenticated: (KU_x) player A
02:53:34.442 Master  [Shard] Completed incoming migration #2 for (KU_x)
02:53:34.444 Master  [Shard] Completed migration #2 for player (KU_x)
```

Shard handshake: **2.8 s**. But the *player entity* did not appear in `#AllPlayers` on the Master
until **02:53:48** — a further 14 s of character load after the migration is "Completed". So the
entity-level gap for the return trip was **02:53:33 → 02:53:48 ≈ 15 s, 7 consecutive 2 s polls**,
matching the ~14 s the research inferred.

And again, for all 15 s:

| | Master `s c a` | Caves `s c a` | `max()` |
|---|---|---|---|
| 02:53:33 → 02:53:46 | `1 1 0` | `1 1 0` | **1** |

**Max consecutive 2 s polls where `max()` read 0, across both migrations: `0`.**

This is the headline safety result. `#AllPlayers` alone would have read zero for 9 s going down
and 15 s coming back; `shard_players:GetNumPlayers()` and `#GetPlayerClientTable()` never
flickered on either shard.

### CPU and RSS with a player

| State | Master CPU | Caves CPU | Master RSS | Caves RSS | System used |
|---|---|---|---|---|---|
| empty, `Sim paused` | 9-10 % | 9-10 % | 1259 MB | 1027 MB | 2698 MB |
| player on the surface | **21 %** | 11 % | 1259 MB | 1027 MB | 2757 MB |
| player in the caves | 13 % | **15-22 %** | 1259 MB | 1027 MB | 2752 MB |

(CPU as % of one core; `c6i.large` has 2.)

One active player roughly **doubles the hosting shard's CPU**, from ~10 % to ~21 % of one core —
nowhere near the "90-100 % per shard" the forums claim. RSS did not move at all; total system
memory rose ~55 MB for the player. **Memory is dominated by the world, not by players.**

### S6 — the player leaves: THE MOST IMPORTANT RESULT OF THE SPIKE

Player A force-quit at **02:54:55.497**. What each signal did:

| Signal | Behaviour |
|---|---|
| `[Leave Announcement]` (both chat logs) | at **02:54:55.497**, same instant |
| `[Shard] (KU_x) disconnected from Master(1)` | at 02:54:55.497 |
| `Sim paused` (Master), `Sim paused` (Caves) | at **02:54:55.965 / 02:54:56.002** — **+0.47 s** |
| `#GetPlayerClientTable()` on both shards | `1 → 0` by the next 2 s poll (**< 2 s**) |
| `#AllPlayers` on both shards | `1 → 0` by the next 2 s poll (**< 2 s**) |
| **`shard_players:GetNumPlayers()`** | **STUCK AT 1. On BOTH shards. It never came back down.** |

Verified repeatedly for **2+ minutes** after the player was gone:

```
02:55:58  M: DSTQ <n> true 1 0 0    C: DSTQ <n> true 1 0 0
02:56:10  M: DSTQ <n> true 1 0 0    C: DSTQ <n> true 1 0 0
...
02:57:32  PARTS num=1 clients=0 all=0 nettable=1
```

(`nettable=1` is the `[Host]` row, which `GetPlayerClientTable()` correctly strips — that part
works exactly as documented.)

**`TheWorld.shard.components.shard_players:GetNumPlayers()` does not decay on disconnect.** It is
accurate while players are present and it is beautifully stable through a migration, but it never
returns to zero. The research nominated it as the **primary** signal ("BEST", source-verified).
Used that way inside `max()`, the computed player count would **never** reach 0, the idle timer
would **never** fire, and **the instance would run until the 4-hour dead-man switch** — the single
most expensive failure this design can have.

Caught only because the spike watched a player actually leave.

### The corrected idle formula

```
players = max(master.clients, caves.clients, master.allplayers + caves.allplayers)
```

`shardplayers` is **excluded from the zero decision**. Checked against every measured state:

| State | master `s c a` | caves `s c a` | corrected `max()` | correct? |
|---|---|---|---|---|
| empty at boot | `0 0 0` | `0 0 0` | 0 | yes |
| player on surface | `1 1 1` | `1 1 0` | 1 | yes |
| player in caves | `1 1 0` | `1 1 1` | 1 | yes |
| mid-migration (9 s and 15 s windows) | `1 1 0` | `1 1 0` | **1** | yes |
| after disconnect | `1 0 0` | `1 0 0` | **0** | yes |

`shardplayers` is still worth *logging* — it is the signal that proves the shard link is alive,
and disagreement between it and `clients` is a useful health warning — but it must never be able
to hold the count above zero.

`Sim paused` remains an excellent independent cross-check: it fired 0.47 s after the disconnect
and never fired spuriously during either migration.

> Caveat: the disconnect produced a `[Leave Announcement]`, so the client did manage a clean
> RakNet goodbye despite being force-quit. The pure network-death path (RakNet timeout with no
> goodbye) was therefore **not** exercised. `clients` self-heals via that timeout in principle,
> but the timeout duration is unmeasured — assume up to ~60 s and size N accordingly.

### Recommended poll parameters

| Parameter | Value | Why |
|---|---|---|
| poll interval | **30 s** | query costs ~60 ms and ~305 log bytes; 30 s is free |
| N (consecutive zeros before idle) | **3** (90 s) | measured worst transient for the corrected formula is **0 polls**; the 90 s margin covers the unmeasured RakNet-timeout path |
| UNKNOWN handling | never counts as zero | a missing nonce is UNKNOWN, as the research says |
| cross-check | `Sim paused` must also be the most recent pause edge | independent engine path, fired at +0.47 s |
| joinable predicate | `Server registered via geo DNS` **AND** `World \d+\(Caves\) is now connected` **AND** a nonce round-trip on both shards | registration is the real gate (boot 2) |
| boot timeout | 15 min → give up and shut down | boot 2 would have hung forever otherwise |

---

## 10. Recommendations

**Instance type: `c6i.large` (2 vCPU, 4 GiB), not `t3.medium`.**

- `t3.medium` **was** fully measured (RSS, CPU, world load time, memory headroom) — only its
  final joinable step was blocked by the `E_ROWID_EXIST` bug, which is unrelated to the instance
  type. Its world load time was 20 s (Master, `Loading world` → `LOAD BE: done`), against 23 s on
  `c6i.large`; RSS and memory headroom were within a few MB of `c6i.large`. A re-run would add
  ~10 minutes and produce numbers already in hand, so it was skipped.
- The decisive difference is CPU credits: an **empty, paused** cluster on `t3.medium` already
  runs a permanent credit deficit (`CPUCreditBalance` pinned at 0, usage ~2× accrual). One active
  player adds another ~11 % of a core. `unlimited` mode bills the deficit; `standard` throttles.
- 4 GiB is enough but not roomy: 2.70 GB used empty, 2.76 GB with one player. Memory scales with
  **world age, not players**, so a much older world could need `m6i.large` (8 GiB, ~$0.096/h).
  Budget for that rather than assuming 4 GiB forever.

**Boot pipeline.** Keep the binaries tarball (saves 136 s). The remaining fixed costs are apt
(33-42 s) and the extract (42-47 s). Both are removable:

1. Bake apt packages + AWS CLI into a custom AMI → **-36 s**.
2. Stream `aws s3 cp - | tar -I zstd -x` instead of writing 3.28 GB to disk first → the extract is
   EBS-bound (zstd and tar both <20 % CPU), so this should save a large part of 42 s.

That would put click-to-joinable near **90 s**.

**Always run `app_update 343050` without `validate` on boot** (7.8-13.7 s when current, vs 222 s
for a cold validate). Keep `validate` only for building a fresh binaries tarball.

**Shutdown sequence** (all three steps are load-bearing, all measured):

1. `c_shutdown(true)` into **each** shard's FIFO — it does not cascade.
2. Wait for `Shutting down` in that shard's log (~2-3 s).
3. Kill that shard's FIFO writer so stdin EOFs — otherwise the process hangs forever and ignores
   SIGTERM. Never EOF a shard that has not printed `Shutting down`, or you permanently kill its
   console.

Then push the save **excluding `*/save/server_temp`, `*/save/client_temp`,
`*/save/cached_userid`**, then terminate. Whole graceful stop measured at **6.6 s** for both
shards; save tar+upload **1.0-2.1 s**.

Note: on the final teardown the Caves shard exited with `code=dumped, status=11/SEGV` *after* it
had logged both `Serializing world` lines and `Shutting down`. The save was intact. Treat a
non-zero exit **after** `Shutting down` as benign; only a failure before it is data loss.

---

## 11. Resource ledger — final

| Resource | Id / name | Deleted | Verification |
|---|---|---|---|
| EC2 `dst-spike-boot1` | `i-006cf30e928719d62` | 02:20:06Z | `describe-instances` → `terminated` |
| EC2 `dst-spike-boot2` | `i-0610e0c614196844d` | 02:37:28Z | `describe-instances` → `terminated` |
| EC2 `dst-spike-boot3` | `i-07c7aa788e70bdded` | 02:59:24Z | `describe-instances` → `terminated` |
| Root volumes (3 × 30 GB gp3) | `vol-05a2d2ed529e3090c`, `vol-049cf305677b5126b`, `vol-0f55f363cad8657d0` | with their instances | `describe-volumes` → `InvalidVolume.NotFound` |
| Security group `dst-spike-sg` | `sg-0c99be7c27bc87549` | yes | `describe-security-groups` → `InvalidGroup.NotFound`; lookup by name → empty |
| IAM instance profile `dst-spike-instance` | — | yes | `get-instance-profile` → `NoSuchEntity` |
| IAM role `dst-spike-instance` | — | yes (policies detached first) | `get-role` → `NoSuchEntity` |
| S3 bucket `dst-spike-063257577013` | 3 objects, 3.1 GiB | yes (emptied, 0 residual versions) | `head-bucket` → `404`; `list-buckets` filter → empty |

No non-terminated instance carries `project=dst-server-manager`. The save zip in `~/Downloads`
was never modified; nothing from it was written into the repo. The Klei token and the (empty)
cluster password were never printed, logged, or included in any SSM output.
