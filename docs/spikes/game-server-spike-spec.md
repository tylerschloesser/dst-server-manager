# Spike spec: DST game server on EC2

Written by the planning session from the summaries of `docs/research/*.md`. One opus sub-agent
owns this spike end to end and writes results to `docs/spikes/game-server-spike.md`.

## Purpose

Replace forum numbers with measurements for the design the research recommends:

- **Ephemeral instance**, stock **Ubuntu 24.04 x86_64** AMI, us-west-2, default VPC public subnet,
  auto-assigned public IPv4, no SSH (SSM only).
- **DST binaries** cached as a `tar.zst` in S3, restored at boot, then `steamcmd app_update 343050`.
- **World save** as a `tar.zst` in S3, pulled at boot, pushed after `c_shutdown(true)`.
- **systemd units + one FIFO per shard** for console input (no `screen`/`tmux`).
- **Idle detection** by a nonce'd Lua query written to each shard's FIFO and parsed from that
  shard's `server_log.txt`, cross-checked with anchored `Sim paused` / `Sim unpaused` lines.

## Hard rules

- AWS: every CLI call uses `AWS_PROFILE=admin` and an explicit `--region`. Account `063257577013`
  hosts other production sites: never modify or delete anything this spike did not create.
- Every resource is named `dst-spike-*` and tagged `project=dst-server-manager` and
  `purpose=spike` (instances AND their volumes via `TagSpecifications`).
- One DST server at a time (single Klei token). Terminate boot N before starting boot N+1.
- Every instance: `InstanceInitiatedShutdownBehavior=terminate` and a dead-man
  `shutdown -h +240` as the first line of user-data.
- The save zip `~/Downloads/dst-tylerni2026.zip` is only ever **copied**; the original is never
  modified. It contains a Klei token (`cluster_token.txt`) and `cluster_password` (in
  `cluster.ini`): never print, log, echo, or write either anywhere (not in docs, not in chat, not
  in CloudWatch, not in SSM command output). Nothing from the zip is copied into the repo. Before
  writing any log excerpt into `docs/`, grep it for the token and password (match-only, no
  printing) and redact.
- No git add/commit/push. If credentials expire or a human decision is needed: stop, report.

## Resources to create (and later delete)

| Resource | Name | Notes |
|---|---|---|
| S3 bucket (us-west-2) | `dst-spike-063257577013` | private, holds the zip copy, binaries tarball, save tarballs |
| IAM role + instance profile | `dst-spike-instance` | `AmazonSSMManagedInstanceCore` + RW on the spike bucket only |
| Security group (default VPC) | `dst-spike-sg` | inbound UDP 10998-10999 from 0.0.0.0/0 only; no 22; try WITHOUT 27016/27017 first |
| EC2 instances | `dst-spike-boot<N>` | 30 GB gp3 root, Ubuntu 24.04 via SSM public parameter `/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id` |

Keep a running ledger of every created resource id in the results doc as you go.

## Boots

### Boot 1: `c6i.large`, cold install
1. Timeline (UTC timestamps): RunInstances call, `running`, SSM agent online, packages installed
   (record the exact apt package list needed for steamcmd + DST x64 on Ubuntu 24.04, incl. i386
   arch), steamcmd full install of app 343050 done (duration, bytes on disk), save restored,
   both shards launched, **joinable** (see Idle/joinable below).
2. Run the x64 binary (`bin64/dontstarve_dedicated_server_nullrenderer_x64`). Prototype the real
   mechanism: systemd units `dst-master.service` / `dst-caves.service`, each reading stdin from
   its own FIFO. Save the unit files and helper scripts (no secrets) to
   `docs/spikes/artifacts/`.
3. Inspect the save's config (non-secret keys only): is `console_enabled` set, is the Caves
   shard `id` pinned, `pause_when_empty`. Apply the minimal edits the idle-detection research
   requires to the COPY and record exactly which edits were needed.
4. Zero-player tests (idle-detection research section 10 has the full test plan; read that
   section only): the nonce'd query
   `TheWorld.shard.components.shard_players:GetNumPlayers()` / `#GetPlayerClientTable()` /
   `#AllPlayers` resolves on both shards and agrees; **stdin Lua executes while the sim is
   paused**; exact joinable log lines and their order; exact anchored pause lines; query
   round-trip latency; does the query spam or grow the log noticeably at a 30 s poll.
5. Resource fit, empty+paused: RSS per shard, total used memory, CPU % per shard, sampled for
   5 min.
6. Does the server show in the Klei lobby with only UDP 10998-10999 open (check via the Klei
   lobby CDN described in the idle-detection research section 5)? If not, open 27016-27017 UDP
   and re-check. Record the minimal SG.
7. Build the binaries tarball: `tar | zstd` of the DST install dir (+ steamcmd dir): size,
   compression time at zstd -3 and -10 (or `-T0`), upload time to S3.
8. Graceful stop: write `c_shutdown(true)` to the Master FIFO. Measure time until both
   processes exit, whether Caves exits on its own, exit codes and how systemd sees them, which
   save files changed. Then tar.zst the cluster dir (size, time) and upload (time).
   Also once: what a plain `systemctl stop` (SIGTERM) does to a running shard (does it save?).
9. Terminate.

### Boot 2: `t3.medium`, from tarball
Same user-data as the target design: restore binaries tarball from S3, `app_update 343050`
(measure with and without `validate`), restore the save tarball written by boot 1, launch.
Record the full timeline, the RSS/CPU numbers (does 4 GiB fit with headroom? CPU credits?),
and world load time versus boot 1. Graceful stop, terminate.

### Boot 3: `c6i.large`, from tarball (the recommended design's real number)
Full timeline again. This is the headline click-to-joinable number. Leave the server running
and start an on-instance sampler (every 5 s: nonce'd count query on both shards, CPU % and RSS
per shard, to a file on the instance).

### CHECKPOINT: return to the orchestrator
Write everything measured so far to `docs/spikes/game-server-spike.md`, then return (format
below) with the public IP, the server name as shown in the browser, and the instance id. The
orchestrator asks Tyler to join and then resumes you.

### Player phase (after being resumed; Tyler is a real player joining from his game client)
Watch the Master log for his join (poll up to 30 min). Then:
1. Count with one player in Master: all three query values, both shards, plus `Sim unpaused`.
2. Teleport him next to a cave entrance from the server console (e.g. find
   `cave_entrance_open` and set his position); he will jump in. Observe the migration: every
   log line on both shards, the count from both shards every 2 s through the hop, the length of
   any window in which the count reads 0 or the query fails (calibrates "N consecutive zero
   readings"), whether `Sim paused` fires spuriously.
3. Count with one player in Caves only (Master must still report 1).
4. He climbs back up: same observations.
5. He force-quits the game client (hard kill, no clean disconnect): time until the count drops
   to 0 and until `Sim paused` appears.
6. CPU % per shard and RSS with a player active in each shard (from the sampler).
If told Tyler is unavailable, skip this phase and say so in the results.

### Teardown
Graceful stop, terminate, then delete every resource in the ledger: instances (wait for
`terminated`), security group, instance profile + role (detach policies first), bucket (all
objects and versions, then the bucket). Verify each deletion with a describe/list call and
record the output. The orchestrator independently runs a tag-based check afterwards.

## Results doc must contain

- A table of phase timings per boot, and the headline click-to-joinable number for boot 3.
- RSS/CPU table per instance type, empty vs with player. A recommended instance type.
- Tarball sizes and times; `app_update` times (validate vs not).
- Idle detection: confirmed/refuted per candidate, the exact final query line, the exact
  joinable and pause regexes, recommended poll interval and N.
- Shutdown: `c_shutdown(true)` duration, Caves cascade, SIGTERM behaviour.
- Minimal SG ports. Exact apt package list. Config edits needed on the save copy.
- Anything surprising.
- The resource ledger: every resource created, and proof each was deleted.
