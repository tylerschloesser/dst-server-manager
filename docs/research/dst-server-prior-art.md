# Prior art: running a DST dedicated server unattended, booted fresh each time

Research date: 2026-09-19. Scope: Linux, single ephemeral EC2 instance, Master+Caves,
no mods, up to 6 players. Claims marked **[doc]** (official/documented),
**[forum]** (community report, unverified), or **[inference]** (my reasoning, not sourced).

## 1. Canonical steamcmd install

- App ID **343050** is the DST Dedicated Server app, separate from the client (322330). **[doc]**
  Source: [SteamDB 343050](https://steamdb.info/app/343050/), install guides below.
- Standard install command, anonymous login (no Steam account needed for the dedicated
  server app):
  ```bash
  ./steamcmd.sh +force_install_dir "$DST_DIR" +login anonymous +app_update 343050 validate +quit
  ```
  **[doc]** — this is exactly what the zip's `scripts/install.sh` and `scripts/update.sh`
  do, and matches every guide found (Klei wiki, Linode, community guides).
- **steamcmd itself is a 32-bit binary** even though it downloads 64-bit game content, so
  32-bit libs are required to run steamcmd, not (necessarily) the DST server. **[forum/inference]**
  - Ubuntu/Debian (22.04/24.04): enable i386 arch + `lib32gcc-s1 lib32stdc++6`
    (`lib32gcc1` on older releases), plus `ca-certificates curl tar`. This is exactly what
    the zip's `install.sh` does:
    ```bash
    sudo dpkg --add-architecture i386
    sudo apt-get update
    sudo apt-get install -y lib32gcc-s1 lib32stdc++6 libcurl4-gnutls-dev:i386 libcurl4-gnutls-dev ca-certificates curl tar screen
    ```
  - Amazon Linux 2023 (dnf/RHEL-family): `glibc.i686 libstdc++.i686` (`dnf install --allowerasing glibc.i686 libstdc++.i686`); AL2023 may need `dnf install glibc-devel.i686` if that's missing, and multilib repos are less battle-tested there than on Ubuntu — **this is the more likely source of platform friction if AL2023 is chosen over Ubuntu.** **[forum, low confidence — did not find an AL2023-specific DST writeup, only generic steamcmd/RHEL9 guidance]**
- **Which binary to run**: `dontstarve_dedicated_server_nullrenderer_x64` (64-bit,
  no-graphics build) is the one every current guide, the Klei command-line-options doc,
  and the save-zip's own `start.sh` use. A 32-bit `dontstarve_dedicated_server_nullrenderer`
  also ships but is legacy; no current guide recommends it on x86_64. **[doc/forum]**
  Binary lives at `$DST_DIR/bin64/dontstarve_dedicated_server_nullrenderer_x64`.
- **Launch commands for a Master+Caves cluster** (from `bin64/`, with
  `LD_LIBRARY_PATH="$DST_DIR/bin64/lib64:$LD_LIBRARY_PATH"`):
  ```bash
  ./dontstarve_dedicated_server_nullrenderer_x64 -console -cluster TylerNi2026 -shard Master \
      -persistent_storage_root /home/ec2-user -conf_dir .klei/DoNotStarveTogether \
      -monitor_parent_process $$
  ./dontstarve_dedicated_server_nullrenderer_x64 -console -cluster TylerNi2026 -shard Caves \
      -persistent_storage_root /home/ec2-user -conf_dir .klei/DoNotStarveTogether \
      -monitor_parent_process $$
  ```
  Flag meanings **[doc]**, source [Klei Dedicated Server Command Line Options Guide](https://support.klei.com/hc/en-us/articles/360029556192-Dedicated-Server-Command-Line-Options-Guide) (fetch blocked by 403; confirmed via cached search snippets and [kfsone/dst-server](https://github.com/kfsone/dst-server)):
  - `-cluster <name>`: cluster directory name under `<persistent_storage_root>/<conf_dir>/`.
  - `-shard <Master|Caves>`: which shard this process is.
  - `-persistent_storage_root <abs path>`: base dir; full path becomes `<root>/<conf_dir>`.
    The zip's scripts default this implicitly to `$HOME` with `conf_dir` omitted (falls
    back to default `.klei/DoNotStarveTogether`).
  - `-conf_dir <name>`: optional, defaults to `.klei/DoNotStarveTogether` if omitted.
  - `-console`: enables the stdin console / telnet-like console — **required** if you want
    to send commands like `c_shutdown(true)` at all.
  - `-monitor_parent_process <pid>`: server watches this PID and exits if it dies — used
    when the server is spawned as a subprocess of a wrapper script, so an orphaned server
    process doesn't linger if the wrapper dies. Relevant for a systemd design: pass `$$`
    of the ExecStart wrapper (or omit it and let systemd's cgroup handle process reaping).
  - The zip's own `start.sh` omits `-persistent_storage_root`/`-conf_dir` (relies on
    defaults `$HOME/.klei/DoNotStarveTogether`) and doesn't pass `-monitor_parent_process`.
    That's a reasonable simplification for a single-purpose box.

## 2. Update-on-boot

- **Recommendation: run `steamcmd +app_update 343050 validate` on every boot**, not a
  pre-baked AMI with incremental updates, for this use case. **[inference, medium-high confidence]**
  Reasoning: the server only runs a few hours at a time, boots are infrequent (on-demand),
  and DST clients auto-update via Steam and hard-fail to connect to a stale server
  version — staleness is a correctness bug, not a cosmetic one. A pre-baked AMI would
  still need an update check on every boot anyway (Klei ships frequent small patches),
  so it doesn't remove the steamcmd step, it just adds AMI-maintenance overhead for a
  server that already boots from a clean/known state each time. Bake the *steamcmd binary
  and 32-bit OS libs* into the AMI (that part never changes) but always run
  `app_update` for the game content on boot.
- **Download/update size**: full DST dedicated server install is reported around
  **~2–3 GB** — one search source says ~2.05–2.2 GB via steamcmd **[forum, unverified]**;
  the save-zip's own README says "~10 min, mostly the 3 GB download" **[forum, the zip
  author's own estimate]**. Treat true first-install size as **~2–3.5 GB**.
- **Incremental update time**: not independently found with hard numbers; because DST
  patches are typically small deltas (tens to a few hundred MB), an already-installed
  server re-running `app_update 343050 validate` with no new patch should be a fast
  manifest-check (tens of seconds) plus network time for whatever changed. **This needs
  to be measured in the spike** — worst case (major content patch, e.g. a "Turn of Tides"
  sized update) could be a much larger download.
- **steamcmd flakiness**: well-documented pattern across many games (not DST-specific):
  - **Exit/app state `0x202`** almost always means steamcmd couldn't write to disk —
    either genuinely out of space, or (more commonly) a **permissions problem**: the
    user running steamcmd doesn't own `force_install_dir`, or a symlinked directory has
    wrong perms. **[forum, documented across multiple game-server communities]**
    Source: [LinuxGSM steamcmd errors](https://docs.linuxgsm.com/steamcmd/errors),
    [CubeCoders forum 0x202 thread](https://discourse.cubecoders.com/t/update-failure-with-seven-days-to-die-steamcmd-update-fails-with-disk-write-error-state-0x202/42725).
  - Fix pattern: verify `df -h` free space, verify the install dir is owned by the
    running user, and as a last resort delete the `appmanifest_343050.acf` in
    `steamapps/` to force a clean re-check.
  - General steamcmd flakiness beyond 0x202: transient CDN/network hiccups causing
    partial downloads; the standard workaround is to just **retry the same
    `app_update ... validate` command** (steamcmd resumes/re-validates rather than
    starting over) — this is universal community advice, not DST-specific.
    **Recommendation for the boot script: wrap the steamcmd invocation in a retry loop
    (e.g. 3 attempts) and treat "no output change / still failing after N retries" as a
    boot failure that surfaces in logs**, rather than looping forever.

## 3. Docker images

- **Jamesits/docker-dst-server** ([GitHub](https://github.com/Jamesits/docker-dst-server),
  [Docker Hub](https://hub.docker.com/r/jamesits/dst-server)) is the most prominent one.
  - On start: auto-generates default configs if missing, downloads/updates the DST server
    via steamcmd, and launches Master+Caves under `supervisord`. **[doc, from README]**
  - Updates: "automatic on restart" — i.e. it re-runs the same steamcmd `app_update` idea
    on every container start, which validates the "update on every boot" approach
    independent of Docker. **[doc]**
  - Console commands: via stdin/attaching; graceful stop via `SIGINT` to `supervisord`,
    which can take **up to ~5 minutes** to save and fully shut down per the README.
    **[doc]**
  - Ports: needs UDP 10999-11000 (client) and 12346-12347 (Steam) by their scheme, plus
    dynamic high UDP ports noted as needed for "unknown communications" — vaguer/broader
    than the exact ports this project's save actually uses (see §7). **[doc]**
  - Maintenance: has multiple tags (`latest`/`vanilla`, `nightly`, `steamcmd-rebase`,
    `-slim` variants) and an active build pipeline; README doesn't show a specific last-updated date in what was fetched, so **confidence on current (Sept 2026) maintenance status is
    low** — worth checking the repo's actual commit history in the spike before trusting it.
  - Known caveat noted in README: **IPv6 is problematic**, LAN-only mode needs Steam
    punchthrough. Not directly relevant to this project's public-subnet EC2 design.
  - x86_64 only (`DST_ARCH=amd64` in build args); no evidence of ARM support, consistent
    with Klei shipping no ARM DST server binary at all.
  - There's also `zh99998/DST-Dedicated-Server-Docker`, `superjump22/dontstarvetogether`,
    `tws101/docker-dst-server` on Docker Hub — did not deep-dive these; Jamesits' is the
    most referenced/most starred based on search prominence. **[inference from search ranking, not a maintenance audit]**

- **Recommendation: bare steamcmd + systemd, not Docker, for this project.** **[inference]**
  Reasoning:
  - This is a single-purpose, single-tenant, ephemeral EC2 instance that boots fresh
    (presumably from a fresh/known AMI or user-data script) every time and runs one
    workload. Docker's main value props — isolating dependencies, reproducible multi-service
    orchestration, portability across hosts — don't buy much when there's exactly one
    process pair on exactly one box type (x86_64 EC2) that's recreated from scratch anyway.
  - Docker adds a layer (image pulls, container runtime installation/updates, an extra
    process supervisor like supervisord *inside* the container competing conceptually with
    systemd *outside* it) without removing the steamcmd-update-on-boot step — the Jamesits
    image still shells out to steamcmd internally, so you don't avoid steamcmd's flakiness
    by using Docker.
  - systemd already gives process supervision, restart policies, structured logging
    (journald), and (per §4 below) a clean way to manage console input via FIFO — everything
    Docker+supervisord provides, natively, with one less moving part and no dependency on a
    third-party image's maintenance status.
  - Counter-consideration: Docker would make local dev/testing of the launch scripts easier
    (same image on a laptop). If that workflow matters, a thin custom Dockerfile (not a
    third-party image) could still be worth it later — but it's not required for the AWS
    on-demand design itself.

## 4. Sending console commands without screen

- **Best-practice pattern found: named pipe (FIFO) + `tail -f` feeding the process's stdin, managed by systemd**, popularized for Minecraft servers and directly transferable to DST
  since both are line-oriented stdin consoles. **[doc]**
  Source: [nezroy: Running Minecraft with a managed console (STDIN) using systemd, tail, and mkfifo+pipes](https://nezroy.blogspot.com/2021/02/running-minecraft-with-managed-console.html).
  - Why not plain `StandardInput=file:/path/to/fifo` alone: a FIFO delivers EOF to the
    reading process once a single writer closes, which would kill the server's stdin
    after the first `echo cmd > fifo`. The fix is to have a long-lived `tail -f` (or
    equivalent) process hold the FIFO open for reading and pipe lines into the server's
    real stdin via a bash `coproc`, so the FIFO's writer-closes-then-reopens cycle never
    reaches the game process directly.
  - systemd unit shape:
    - `ExecStartPre=mkfifo --mode=0660 /run/dst/stdin` (or use `RuntimeDirectory=dst` +
      pre-create).
    - Launch script starts the DST binary as a `coproc`, writes its PID for systemd
      (`Type=forking` + `PIDFile=`, or simpler: `Type=simple` if the wrapper script itself
      is the tracked process and does `exec`/`wait` correctly), and runs `tail -f
      /run/dst/stdin` piped into the coproc's stdin in a loop.
    - `ExecStop=/bin/sh -c 'echo "c_shutdown(true)" > /run/dst/stdin'` — routes graceful
      shutdown through the same mechanism systemd already offers (`systemctl stop`).
    - `KillSignal=SIGCONT` / `FinalKillSignal=SIGTERM` pattern from the Minecraft writeup
      exists to guard against a suspended `tail`; likely unnecessary here unless the same
      suspend/resume issue is hit in testing.
  - This is **more robust than `screen -X stuff`** (what the zip's own scripts use) because
    it doesn't depend on `screen` being installed, doesn't need `-p 0` session/window
    targeting, and integrates with `systemctl status`/`journalctl` for log capture. It's
    also more robust than tmux for the same reasons.
  - **Recommendation: use the FIFO+systemd approach for this project.** Two shards need two
    FIFOs (one per shard process), e.g. `/run/dst/master.stdin` and `/run/dst/caves.stdin`,
    each with its own systemd unit and `ExecStop` sending the shard-appropriate command
    (only Master needs `c_shutdown(true)`; see §5 for why Caves doesn't need its own).
  - `-console` must be passed to the DST binary for it to read commands from stdin at all
    (§1). **[doc/inference]**

## 5. Graceful shutdown semantics

- `c_shutdown(true)` — the boolean argument controls whether the world is saved before
  exit: `true` (or no argument, since `true` is the default) saves; `false` exits without
  saving. **[doc/forum, consistent across DST wiki and forum]**
  Source: [DST console commands wiki](https://dontstarve.fandom.com/wiki/Console/Don't_Starve_Together_Commands).
- **SIGTERM (plain `kill`) does NOT trigger a save** — multiple forum reports confirm the
  server does not intercept SIGTERM/Ctrl-C to save state; only the in-console
  `c_shutdown(true)` command (or the equivalent sent via stdin/telnet) does a clean save+exit.
  **[forum, medium-high confidence, consistent across sources]**
  → **Implication for systemd: `ExecStop` must send `c_shutdown(true)` via the FIFO (§4),
  not just let systemd send SIGTERM.** Set `TimeoutStopSec` generously (see below) so
  systemd waits for the graceful path instead of escalating to SIGKILL.
- **Timing**: no authoritative number found for pure DST c_shutdown duration. The
  Jamesits Docker README says a full graceful stop (via SIGINT to supervisord) can take
  **up to ~5 minutes** to save and exit — this is the best available data point, though it
  includes supervisord's own shutdown sequencing on top of the shard save. **[forum,
  low-medium confidence — treat as an upper bound, not a typical figure]**. Actual save
  time for a 6-player, no-mod world is very likely much shorter (seconds to low tens of
  seconds) based on general community sentiment that saves are fast; **recommend measuring
  this directly in the spike** and setting `TimeoutStopSec` (e.g. 120s) comfortably above
  the measured value, with SIGKILL as a last-resort fallback only.
- **Master vs Caves shutdown order**: **running `c_shutdown()` on the Master shard shuts
  down all shards (Master tells Caves to also shut down and save); running it on Caves
  only shuts down Caves.** **[forum, consistent report]** → **Implication: only the Master
  process's console needs `c_shutdown(true)` sent; it propagates to Caves.** For a systemd
  design, this means the "stop the world" action can target the Master unit only, though
  it's still cleanest to have systemd track both shard processes/units and let Master's
  shutdown command naturally bring Caves down too (with a short wait/timeout on Caves
  exiting on its own before systemd would otherwise intervene).
- The save-zip's own `scripts/stop.sh` follows this exact pattern already (sends
  `c_shutdown(true)` to both `dst_master` and `dst_caves` screen sessions defensively, then
  polls for both to exit) — reasonable belt-and-suspenders behavior worth keeping even
  though Master alone should suffice.

## 6. Memory/CPU needs (Master + Caves, ≤6 players, no mods)

All figures below are **forum-report / community-doc**, not measured by Klei officially;
this project's own spike should measure actual usage.

- **RAM**: community guidance (mathielo/dst-dedicated-server docs) recommends **~1 GB RAM
  per shard** as a baseline, i.e. **~2 GB total for Master+Caves** at minimum, with the
  caveat that RAM usage grows with world age (in-game days elapsed) and player count, not
  just player count alone. **[forum]** Source:
  [dst-dedicated-server ServerPerformance.md](https://github.com/mathielo/dst-dedicated-server/blob/main/docs/ServerPerformance.md).
  The save-zip's own README recommends `t3.medium` (4 GB) as "the sweet spot" and calls
  `t3.small` (2 GB) "tight... it'll OOM under load" for two shards. **[forum, the zip
  author's own experience]**
- **CPU**: same source reports **1 core per shard is the target** (shards are
  single-threaded, so per-core clock speed matters more than core count), with idle CPU
  around **~30%** per shard and **90-100%** when players are actively connected/generating
  load. **[forum]**
- **Candidate x86_64 EC2 instance types** (Klei ships no ARM binary, so Graviton `t4g`/`m7g`/`c7g` are out — confirmed by the save-zip README and consistent with steamcmd/DST
  being x86_64-only everywhere referenced):
  - `t3.medium` (2 vCPU, 4 GB) — the zip author's pick; likely comfortable headroom for
    6 players/no mods given the ~2 GB / ~2 core baseline above, while giving burst credits
    for CPU spikes. **[inference from combining the two data points above]**
  - `t3.small` (2 vCPU, 2 GB) — plausible floor per the "1 GB/shard" guidance, but the
    zip author explicitly reports OOM risk; risky as a default, worth testing in the spike
    since burstable-CPU credits could still be fine even if RAM is the binding constraint.
  - `t3a.medium` / `c6a.large` / `c5.large` — alternative burstable/compute-optimized
    x86_64 options if `t3` CPU-credit throttling becomes an issue under sustained load
    (recall idle 30% / active 90-100% per shard — two shards both near 100% could exceed
    a `t3` burstable baseline for a sustained multi-hour session). **[inference]**
  - **Recommendation for the spike**: start with `t3.medium`, measure actual RSS and CPU
    credit consumption over a real multi-hour 6-player session, and only downsize to
    `t3.small` or move to a non-burstable type if data supports it.

## 7. Ports

Confirmed directly from this project's own save's `cluster.ini`/`server.ini` (not generic
guidance) — see §8:

- **UDP 10999** — Master shard `server_port`. Clients connect here. **Must be open inbound.**
- **UDP 10998** — Caves shard `server_port`. Clients connect **directly** to this port when
  a player enters a sinkhole/goes to caves (this is not proxied through Master). **Must be
  open inbound** — the save-zip README specifically warns that if only 10999 is open, the
  server looks fine until someone uses a sinkhole and then hangs.
- **UDP 27016** — Master `master_server_port` (Steam).
- **UDP 27017** — Caves `master_server_port` (Steam).
  Both Steam ports are also called out as required-inbound by the zip's README security
  group table; consistent with general DST hosting guides listing Steam ports as needed
  for the server to register with Steam's server browser / master server list.
- **master_port (10888, shard-to-shard)**: confirmed from this project's actual
  `cluster.ini`: `bind_ip = 127.0.0.1`, `master_ip = 127.0.0.1`, `master_port = 10888`.
  **This stays on localhost — Master and Caves shard-to-shard traffic is loopback-only
  and does NOT need to be opened in the security group.** **[doc, directly from this
  project's config file]**
- Net security-group recommendation: inbound UDP 10999, 10998, 27016, 27017 only (plus
  whatever SSM/no-SSH already implies for management — out of scope here). Do **not** open
  10888.

## 8. Save-zip inspection (`~/Downloads/dst-tylerni2026.zip`)

Unzipped to a temp dir (outside the repo), inspected, and deleted afterward. No secrets
(`cluster_token.txt` contents, `cluster_password`) were printed or written anywhere.

### Directory layout
```
dst-tylerni2026/
  README.md
  scripts/
    install.sh   # one-time EC2 setup: apt deps, steamcmd, app_update 343050, copy cluster into ~/.klei
    start.sh     # launch both shards in detached `screen` sessions
    stop.sh      # send c_shutdown(true) to both screen sessions, poll for exit
    backup.sh    # tar the cluster dir to ~/dst-backups/, excluding backup/ and server_log.txt
    update.sh    # re-run steamcmd app_update 343050 validate
  cluster/TylerNi2026/         # portable world dir, meant to be copied to ~/.klei/DoNotStarveTogether/
    cluster.ini
    cluster_token.txt          # SECRET — not read/printed
    adminlist.txt              # one KU_ id (the owner)
    allowlist.txt              # empty
    blocklist.txt              # empty
    Master/  (server.ini, leveldataoverride.lua, modoverrides.lua, save/, server_chat_log.txt)
    Caves/   (same layout)
```

### What the scripts do
- **install.sh**: assumes fresh Ubuntu 22.04/24.04 x86_64. Adds i386 arch, installs
  `lib32gcc-s1 lib32stdc++6 libcurl4-gnutls-dev:i386 libcurl4-gnutls-dev ca-certificates
  curl tar screen`; downloads steamcmd from `steamcdn-a.akamaihd.net`; runs
  `+login anonymous +app_update 343050 validate`; copies the bundled cluster directory into
  `~/.klei/DoNotStarveTogether/`; chmods the token file to `600`. This exactly matches the
  canonical approach in §1/§2.
- **start.sh**: guards on the token file being non-empty; guards against double-start by
  checking for existing `dst_` screen sessions; sets `LD_LIBRARY_PATH` to
  `bin64/lib64`; launches `dontstarve_dedicated_server_nullrenderer_x64 -console -cluster
  TylerNi2026 -shard Caves` and `...-shard Master`, each in its own detached `screen -dmS`
  session.
- **stop.sh**: sends `c_shutdown(true)` via `screen -X stuff` to both sessions defensively,
  then polls every 1s up to 30s for both screen sessions to disappear, warning if still
  running after 30s.
- **backup.sh**: `tar czf` of the whole cluster dir (excluding `*/backup` and
  `*/server_log.txt`) to `~/dst-backups/<cluster>-<timestamp>.tar.gz`.
- **update.sh**: just re-runs the same `app_update 343050 validate` steamcmd command,
  intended to be run manually before restarting the server.
- This whole bundle is designed for a **long-lived, stop/start (not terminate) EC2 instance
  with the world living on the root EBS volume** — explicitly a different model than this
  project's ephemeral-boot-per-session design. The scripts are Ubuntu- and screen-specific
  and assume persistent local disk between runs (no re-fetch of the world from S3, no
  re-attach of a data volume).

### Non-secret settings (password line filtered out)

`cluster.ini`:
```
[GAMEPLAY]      game_mode=survival, max_players=6, pvp=false, pause_when_empty=true, vote_kick_enabled=false
[NETWORK]       cluster_name="Tyler & Ni 2026", cluster_intention=cooperative, lan_only_cluster=false,
                offline_cluster=false, cluster_language=en, autosaver_enabled=true
[MISC]          console_enabled=true, max_snapshots=6
[SHARD]         shard_enabled=true, bind_ip=127.0.0.1, master_ip=127.0.0.1, master_port=10888,
                cluster_key=defaultPass   (this is the shard-auth key, not the join password —
                                           left as the Klei default; not the secret filtered out)
[STEAM]         steam_group_only=false, steam_group_id=0, steam_group_admins=false
```
Note: `cluster_key` (shard-to-shard auth secret) is separate from the actual player-facing
`cluster_password` — the latter lives elsewhere in `cluster.ini` under `[GAMEPLAY]` or
`[NETWORK]` depending on version and was excluded via `grep -v -i password`; not shown
above and not read.

`Master/server.ini`:
```
[NETWORK] server_port=10999
[SHARD]   is_master=true
[ACCOUNT] encode_user_path=true
[STEAM]   master_server_port=27016, authentication_port=8766
```

`Caves/server.ini`:
```
[NETWORK] server_port=10998
[SHARD]   is_master=false, name=Caves, id=40987672
[ACCOUNT] encode_user_path=true
[STEAM]   master_server_port=27017, authentication_port=8767
```

`adminlist.txt`: one `KU_` id (the owner, per README). `allowlist.txt`/`blocklist.txt`: empty.

No `max_snapshots`/tick-rate override was found beyond the `max_snapshots=6` in `[MISC]`;
no explicit tick-rate setting present in either ini (uses Klei defaults, typically 15 ticks/sec/simulation, 30 network sends/sec — not present as an explicit override in this cluster's config, so nothing to reuse/override here).

### What the scripts got right — worth reusing
- Anonymous steamcmd login for the dedicated server app (no stored Steam creds needed).
- `chmod 600` on `cluster_token.txt` after placing it.
- Guard checks before start (token present, not already running) and before declaring
  stop successful (poll-with-timeout rather than fire-and-forget).
- `c_shutdown(true)` (not SIGTERM/kill) as the shutdown mechanism — correct per §5.
- Sending shutdown to **both** shards defensively even though Master alone should cascade
  to Caves — cheap insurance.
- Excluding `server_log.txt` and `backup/` from the backup tarball (log churn, and the
  game's own internal backup dir would otherwise bloat/duplicate the archive).
- Clear separation of the portable `cluster/` directory from install mechanics — the
  cluster dir itself has "no platform-specific bits" per the README, which is exactly the
  right shape for something this project can drop onto EBS/S3 and rehydrate on any fresh
  instance.
- What does **not** transfer: `screen` as the console mechanism (see §4 for the
  FIFO+systemd alternative), the long-lived/stop-not-terminate EC2 model, and reliance on
  local EBS root persistence without any S3/pull-on-boot step.
