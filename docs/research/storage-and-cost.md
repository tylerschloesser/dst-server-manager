# Storage design and cost model — DST on-demand server

Research note. Written 2026-09-19. Prices verified against the AWS Price List API and AWS
pricing/docs pages on that date; every figure is tagged **[V]** (verified, source given) or
**[E]** (estimate / judgement call — the spike must measure it).

Regions: EC2 / EBS / game-data S3 in **us-west-2**; web stack (S3 site, CloudFront, Lambda,
DynamoDB, ACM) in **us-east-1**.

---

## 0. TL;DR

| Question | Answer |
|---|---|
| Binaries (**4.49 GB** on disk, 3.04 GB download [V]) | **S3 tarball + stock AMI + incremental `app_update` at boot**, tarball re-uploaded only when Steam actually patched. No custom AMI to maintain. |
| World save (66 MB) | **S3, versioned, one key per world.** The instance is fully ephemeral; the root volume is the only block storage and it dies with the instance. |
| OS | **Ubuntu 24.04, not Amazon Linux 2023** — AL2023 ships no 32-bit userspace and `steamcmd` is a 32-bit binary (§2.2). This surprised me. |
| Instance | **`c6i.large`** ($0.085/h) to start. DST shards are single-threaded and run near 100% with players on, so burstable is the wrong family (§5.1). |
| Backup pruning | **S3 Versioning + `NoncurrentVersionExpiration{NewerNoncurrentVersions:10, NoncurrentDays:30}`.** S3 itself guarantees the latest is never deleted. Zero pruning code. |
| Click-to-joinable | **~3–5 min [E]**, of which **1–3 min is DST loading Master + Caves** — the storage choice is *not* the dominant term, and options 2–5 are within ~1 min of each other. |
| Idle month | **≈ $0.10** — S3 storage only; nothing else in the stack has a standing charge. |
| 20 h month | **≈ $2.37** on `c6i.large`; ≈ $1.96 on `t3.medium`; ≈ $1.17 on spot. **≈ $15/year** all in. |
| Biggest cost risk | Data transfer out to players — but it lands at only ~9–17 GB/month against a **100 GB/month account-wide** free allowance that this account currently uses **none** of [V]. |

---

## 1. The two storage problems are not the same problem

| | Binaries | World save |
|---|---|---|
| Size | **4.49 GB installed, 3.04 GB download** [V, §2.1] | 66 MB unzipped / 9.8 MB zipped [given] |
| Mutable? | Yes, by Klei, on Klei's schedule | Yes, by the game, constantly |
| Authoritative copy | **Steam** — we are only ever caching | **Us** — if we lose it, it is gone |
| If we lose it | Re-download, lose ~4 min | Catastrophic, irrecoverable |
| Goal | Minimise *time* | Minimise *risk*, then time |

That asymmetry is the whole design. The binaries want a cache optimised for cold-start
latency with no durability requirement at all. The save wants a durable store optimised for
never being wrong, where latency is irrelevant (10 MB is ~1 second from S3 in-region).

**Conclusion up front: the world save goes in S3 and nothing else is worth discussing.**
A 10 MB object in S3 costs $0.0002/month, downloads in about a second in-region for free, and
gives eleven nines of durability plus versioning. Every EBS-based option for the *save* is
strictly worse: more money, more failure modes, AZ pinning, and worse durability
(EBS is 99.8–99.9% annual durability for a single volume; S3 Standard is 99.999999999%
[V, https://aws.amazon.com/s3/faqs/ and https://docs.aws.amazon.com/ebs/latest/userguide/ebs-volumes.html]).

So options 3 and 4 below are really only arguments about the *binaries*, and they're weak ones.

---

## 2. Facts that drive the timing estimates

### 2.1 DST dedicated server: measured facts

**Size of app 343050 [V]** — read directly from Steam's app metadata
(`curl https://api.steamcmd.net/v1/info/343050`, 2026-09-19; steamdb.info 403s on fetch):

| Depot | OS | Installed | Compressed download |
|---|---|---|---|
| `343052` (game) | linux | **4.377 GB** | **2.999 GB** |
| `1006` (redist) | linux | 0.111 GB | 0.037 GB |
| **Linux total** | | **≈ 4.49 GB on disk** | **≈ 3.04 GB over the wire** |

Public branch `buildid 24700372`, last updated **2026-08-13** [V, same source].

Two consequences:
- **The root volume needs ~30 GiB, not 10.** 4.5 GB of game + ~0.3 GB steamcmd + Steam's update
  staging area (it downloads before it applies, so budget another ~3 GB) + OS + logs. 30 GiB gp3
  costs $0.08/GB-mo prorated over ~24 h/month = 8 cents. Don't be clever here.
- **A zstd tarball of the installed tree will be roughly 3.0–3.5 GB [E]**, not much below the
  4.5 GB on-disk size, because Steam's depot data is *already* compressed (4.377 → 2.999 GB is
  Valve's own compression). Use `zstd -10`; level 19 will burn minutes of CPU for ~nothing.

**Update cadence [V]:** app 343050 moves in lockstep with the client (322330) — same build ids,
same day. 2026 public releases ran **~2–5 per month** with quiet gaps of 3–5 weeks
(https://dontstarve.wiki.gg/wiki/Don't_Starve_Together/Version_History/2026). Branches are
`public`, `updatebeta`, and the legacy `beforemacoschanges`; test builds land every 2–5 days but
move `updatebeta`, not `public`. Incremental `public` update size is **[E]**: tens to a few
hundred MB for hotfixes, possibly 1 GB+ for a content drop, because the data sits in large zip
bundles that recompress wholesale.

**`login anonymous` is sufficient** for 343050 [V, Klei/wiki dedicated-server guide]. A Klei
**cluster token** is separately mandatory for an online server, and can be passed as
`-token <token>` rather than written to `cluster_token.txt` — which is exactly what you want
with an SSM SecureString. (Watch for a trailing newline in the token; it causes
`E_EXPIRED_TOKEN` [V, Klei forums].)

**Startup time to joinable [V, from published `server_log.txt` files]:**

| World | Time to `Sim unpaused` (both shards) | Source |
|---|---|---|
| Existing save, day 6 | **0:41** | [V] https://github.com/rawii22/DSTSaves/blob/master/DoNotStarveTogether/Cluster_3/Master/server_log.txt |
| Existing save, day 22, 2 mods | **0:59** | [V] https://github.com/Hansen-L/dst_saves/blob/master/Master/server_log.txt |
| First run, **generating** a new world | 6:36 | [V] https://github.com/rawii22/DSTSaves/blob/master/DoNotStarveTogether/Cluster_3/Caves/backup/server_log/server_log_2019-01-06-00-21-59.txt |
| A few hundred days old (Tyler's case) | **1–3 min [E]** | extrapolated |

Caves is **not** slower than Master — both shards unpause together once Caves links to Master [V].
Worldgen at 6:36 only matters for creating a *new* world, never for a normal start.

**Shutdown [V]:** a clean save-and-exit can take **up to ~5 minutes**; the widely-used
`jamesits/dst-server` compose file sets `stop_grace_period: 6m`
(https://hub.docker.com/r/jamesits/dst-server). This matters twice: the stop path must not
hard-kill, and it is why **spot is a bad fit** — a spot interruption gives 2 minutes, less than
the worst-case save.

**Save layout and cadence [V]:** cluster root holds `cluster.ini`, `cluster_token.txt`,
`adminlist.txt`, `whitelist.txt`, `blocklist.txt`, `Master/`, `Caves/`. Each shard holds
`server.ini`, `modoverrides.lua`, `leveldataoverride.lua`, `server_log.txt`,
`server_chat_log.txt`, `backup/server_log/`, and `save/` containing `shardindex`, `modindex`,
`server_temp/server_save`, `session/<id>/<10-digit snapshot>` and per-player folders.
Individual snapshots are **1.8–2.7 MB per shard** at days 6–29; a whole two-shard cluster with
6 snapshots each is **24–30 MiB** [V, https://github.com/Hansen-L/dst_saves]. Tyler's 66 MB
unzipped world is consistent with a much older one; **50–100 MB [E]** at a few hundred days,
levelling off once the map is explored. `max_snapshots` defaults to 6 [V].

**The server autosaves once per in-game day, and the logs show `Serializing world` entries
exactly 8 minutes apart** [V]. It also saves on clean shutdown, and `c_save()` forces one [V].
That 8-minute cadence is the natural bound on data loss without extra machinery — see §4.6.

**Memory [V/E]:** ~1 GB per shard plus OS is the standard guidance
(https://github.com/mathielo/dst-dedicated-server/blob/main/docs/ServerPerformance.md);
jamesits suggests "1 GiB + 60 MiB per active user"; one report gives 300–500 MB per shard
process. **Unmodded Master + Caves with 6 players: 1.2–2.0 GB total [E].** So **4 GiB is
sufficient** and 8 GiB is headroom for an aged world. Note the 32-bit binary OOMs at ~3–3.5 GB
per process — **use `bin64/dontstarve_dedicated_server_nullrenderer_x64`** [V, Klei forums].

**Networking [V]:** all game traffic is **UDP**; nothing listens on TCP. Convention is 10999
(Master) and 10998 or 11000 (Caves) `server_port`, plus per-shard `master_server_port`
(e.g. 12346/12347) and unique `authentication_port`. Do **not** remap ports through NAT —
security-group rules must be 1:1. The inter-shard bus (`[SHARD] master_port`, default 10888)
stays on `bind_ip=127.0.0.1` and must not be opened. A documented AWS failure mode is "server
listed externally but invisible in the game browser" caused by wrong SG inbound rules
[V, https://forums.kleientertainment.com/forums/topic/51213-dst-dedicated-server-on-aws-ec2-instance/].

**The server MUST be current at boot**: clients auto-update through Steam and refuse to join a
different version. So **every option below runs `app_update` at boot regardless.** The only
thing the storage choice changes is *how much that update has to download*.

### 2.2 EC2 launch and boot — and why it has to be Ubuntu, not AL2023

| Phase | Time | Source |
|---|---|---|
| `RunInstances` API call returns | ~1.5 s | [V] https://www.daemonology.net/blog/2021-08-12-EC2-boot-time-benchmarking.html |
| … until `DescribeInstances` says `running` | ~6.9 s | [V] same |
| AL2023: launch call → user-data executing | ~14 s total | [V] same (fastest general-purpose AMI measured) |
| Ubuntu 24.04 equivalent | **~25–40 s [E]** | same benchmark family |

My first instinct was AL2023 — it is measurably the fastest to user-data. **It doesn't work.**

> **Amazon Linux 2023 ships no i686 user space at all**, and `glibc.i686` was removed.
> [V] https://docs.aws.amazon.com/linux/al2023/release-notes/removed-i686-AL2023.8-AL2.html
> and https://repost.aws/questions/QUTMOyTk4MT0KJB947GyFIAw/i686-package-on-amazon-linux-2023

And `steamcmd.sh` unconditionally execs the **32-bit** bootstrapper `linux32/steamcmd`. There is
no flag to avoid it. So steamcmd cannot run natively on AL2023, and since *every* option here
runs `app_update` at boot, AL2023 is out.

**Use Ubuntu 24.04 LTS.** The AMI id is likewise a public SSM parameter, so the launch template
still needs zero maintenance:

```
/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id
  → ami-04678417fc39d7171 (us-west-2, refreshed 2026-09-04)   [V, queried via SSM]
```

A launch template referencing `resolve:ssm:/aws/service/canonical/...` always boots a current,
patched AMI with no AMI lifecycle work — a real advantage of the stock-AMI options that the
custom-AMI option gives up.

(Escape hatches if AL2023's ~15 s boot is ever worth chasing: run steamcmd in a Debian container,
or replace it with the 64-bit `DepotDownloader`. Both trade ~20 s of boot for a new dependency.
Not worth it.)

**Required packages on Ubuntu 24.04 [V]:**
- for steamcmd: `lib32gcc-s1`, `lib32stdc++6` (https://packages.ubuntu.com/noble/steamcmd)
- for the game: `libcurl3-gnutls` (provides `libcurl-gnutls.so.4`)
- **known gotcha:** the bundled `bin64/lib64/librtmp.so.0` links against `libnettle.so.6`, which
  Ubuntu 22.04+ no longer ships, and the x64 binary can fail to start as a result
  [V, https://forums.kleientertainment.com/klei-bug-tracker/dont-starve-together/dontstarve_dedicated_server_nullrenderer_x64-fails-to-start-due-to-odd-dependencies-on-nettle-on-linux-r46035/].
  The community fix is to delete the bundled `librtmp.so.0`. **Bake that fix into the cached
  tarball** so it is applied once rather than rediscovered at 9pm.

The apt step is ~10–40 MB and **15–45 s [E]**.

### 2.3 EBS volumes created from snapshots are lazily loaded

This is the effect that makes "pre-baked custom AMI" less magical than it sounds.

> "When you create an Amazon EBS volume … from an EBS snapshot … the data blocks must be
> downloaded from Amazon S3 to the new volume. … During this time, the volume being
> initialized might experience increased I/O latency and decreased performance."
> — [V] https://docs.aws.amazon.com/ebs/latest/userguide/ebs-initialize.html

AWS's own measured numbers for initializing a restored volume:

| Method | Read bandwidth | Latency | Source |
|---|---|---|---|
| `dd` (single-threaded) | ~9 MB/s | ~70 ms/op | [V] https://aws.amazon.com/blogs/storage/addressing-i-o-latency-when-restoring-an-amazon-ebs-volume-from-a-ebs-snapshot/ |
| `fio` (32 deep, multi-threaded) | ~45 MB/s | ~90 ms/op | [V] same |
| Fast Snapshot Restore | full gp3 perf | ~1.5 ms | [V] same |

Those figures are from a large gp2 test and are pessimistic for a small gp3 root volume, but
the shape is right: **first-touch reads of snapshot-backed blocks are latency-bound, not
bandwidth-bound**, because each miss is a synchronous S3 fetch. DST loading a world reads a
large number of moderately-sized asset files, largely serially — exactly the access pattern
that lazy loading punishes.

Estimate for our case: DST touches perhaps **1.5–2.5 GB [E]** of game files during startup.
At a realistic 40–120 MB/s of lazy-load throughput for that access pattern, that is
**~20–60 s of extra wall clock [E]**, paid *inside* the "DST world load" phase where it is
partly hidden behind CPU-bound world deserialization. It is not free, and it is the reason
the custom AMI is not dramatically faster than pulling a tarball from S3.

**Fast Snapshot Restore: dismissed.** $0.75 per snapshot per AZ per *hour*, billed
continuously whether or not you launch anything:
`1 snapshot × 1 AZ × 730 h × $0.75 = $547.50/month`
[V] https://docs.aws.amazon.com/ebs/latest/userguide/ebs-fast-snapshot-restore.html
(the doc's own worked example: "$540" for 30 days). That is roughly **200× the entire rest of
this project's bill**. Never.

*EBS Provisioned Rate for Volume Initialization* (100–300 MiB/s, per-GiB one-time charge) is a
newer and far saner mitigation if a custom AMI is ever chosen — it is charged per volume
creation on the full snapshot data size, not per hour
[V] https://docs.aws.amazon.com/ebs/latest/userguide/ebs-initialize.html. It is still solving a
problem that option 5 simply doesn't have.

### 2.4 S3 → EC2 in-region is fast and free

- Same-region S3 ↔ EC2 transfer: **$0.00/GB** [V] https://aws.amazon.com/s3/pricing/
- `aws s3 cp` with default concurrency sustains **~375 MB/s**; `s5cmd` saturates whatever the
  instance's link gives you [V] https://www.doit.com/blog/save-time-and-money-on-s3-data-transfers-surpass-aws-cli-performance-by-up-to-80x
- Network on the candidate instances: `t3.*` "up to 5 Gbit", `c6i.large`/`c7i.large`/`m6i.large`
  "up to 12.5 Gbit" [V, Price List API `networkPerformance` attribute]

So a ~3.2 GB zstd-compressed tarball pulls in **~12–30 s [E]** and `zstd -d -T0` decompresses at
several hundred MB/s on 2 vCPUs — call it **~15–30 s [E]** for 4.5 GB of output. Total
**~30–60 s**, written to *freshly allocated* blocks on the root volume.

That last point matters and is easy to miss:

> "Empty volumes deliver their maximum performance immediately after creation and do not
> require initialization." — [V] https://docs.aws.amazon.com/ebs/latest/userguide/ebs-initialize.html

Blocks you write yourself have **no** lazy-load penalty. The custom AMI's game files are
snapshot-backed and pay the penalty on every read; the S3-tarball's game files are locally
written and pay nothing. This substantially closes, and may reverse, the gap between options
2 and 5.

---

## 3. The six options

Phases used in every estimate (times are **[E]** unless linked to §2):

| Phase | Symbol | Baseline |
|---|---|---|
| `RunInstances` → `running` | **P1** | ~8 s [V §2.2] |
| OS boot → user-data running (Ubuntu 24.04) | **P2** | ~20–30 s [E §2.2] |
| `apt install` deps from in-region mirror | **P3** | 15–45 s [E §2.2] |
| Binaries: fetch and/or update | **P4** | varies — this is the question |
| World: fetch ~15 MB from S3 + extract | **P5** | ~5 s |
| DST launches Master + Caves until `Sim unpaused` | **P6** | **60–180 s** [V-anchored §2.1] |

**A note on what "joinable" means.** There are two paths for a friend to get in, and they have
different latencies:

- **Direct connect** — `c_connect("<public-ip>", 10999)` from the in-game console, or the
  "Add server" flow. Available the instant the Master shard binds its port. **This is the path
  the webapp should support**: show the public IP and a copy-to-clipboard `c_connect(...)` line,
  and click-to-joinable is exactly P1…P6 with nothing added.
- **Klei server browser** — the server registers with Klei's lobby service after startup, and
  the client's browse list is cached/refreshed on its own schedule. This adds an unbounded,
  uncontrollable tail (tens of seconds to a couple of minutes [E]) and is not worth designing
  around.

Surfacing the IP also sidesteps the fact that the auto-assigned public IPv4 changes every
session — which is the correct trade, since an Elastic IP would cost $3.65/month of idle charge
(§5.2) to avoid a copy-paste.

### Option 1 — Fully ephemeral, full steamcmd download every boot

Stock Ubuntu 24.04 → `apt install` deps → download steamcmd → `app_update 343050` from cold →
pull world from S3 → run → push world on stop → terminate.

| Phase | Time |
|---|---|
| P1 + P2 | ~30–38 s |
| P3 install deps (`lib32gcc-s1`, `lib32stdc++6`, `libcurl3-gnutls`, `zstd`) | 15–45 s |
| P4 **full steamcmd download of 3.04 GB → 4.49 GB on disk** [V §2.1] | **180–420 s** |
| P5 world | 5 s |
| P6 DST Master + Caves load | 60–180 s |
| **Total** | **~5–12 min** |

- **Idle cost:** $0. Nothing persists but the S3 save.
- **20 h cost:** instance-hours only (plus ~7× the boot overhead).
- **Complexity:** lowest possible. One user-data script. No AMI, no volume, no extra state.
- **Failure modes:** entirely dependent on the Steam CDN. Steam throttles anonymous content
  downloads unpredictably; steamcmd is single-connection-ish and its throughput on EC2 is
  variable. A Steam outage means **no world at all**, not a stale world.
- **Risk to save:** identical to every other option (save is in S3).
- **Verdict:** too slow and too dependent on a third party's CDN for the happy path — but it is
  the correct *fallback* path when the S3 cache is missing or corrupt. Keep it as the cold path.

### Option 2 — Pre-baked custom AMI (steamcmd + deps + DST pre-installed)

| Phase | Time |
|---|---|
| P1 + P2 | ~30–38 s |
| P3 | 0 (baked) |
| P4 incremental `app_update` (fresh AMI) | 20–60 s |
| P4 incremental `app_update` (AMI 2 months stale, major patch) | 90–300 s |
| P5 world | 5 s |
| P6 DST load **+ lazy-load penalty on snapshot-backed game files (§2.3)** | 80–240 s |
| **Total (fresh AMI)** | **~2.5–6 min** |

- **Idle cost:** AMI snapshot storage. ~5 GB of stored snapshot data at **$0.05/GB-month**
  [V, Price List API `USW2-EBS:SnapshotUsage`] = **$0.20–0.30/month**, plus a second copy while
  a rebuild is in flight. Small but it is a *standing* charge, and it only goes up as you keep
  old AMIs around.
  (Reality check: this account already carries 57.16 GB of us-west-2 EBS snapshots costing
  $2.86 in Aug 2026 [V, Cost Explorer] — snapshot sprawl is a real thing that happens.)
- **20 h cost:** instance-hours + $0.25 of snapshots.
- **How the AMI gets rebuilt** — three sub-options:
  - *EC2 Image Builder*: proper pipelines, recipes, versioning, scheduled rebuilds. It is also
    a whole extra service, an IAM surface, and its own failure modes, for one AMI. Overkill.
  - *Scripted bake*: a `make bake` that runs an instance, installs, `CreateImage`, deregisters
    the previous one. ~100 lines. Reasonable, but it's 100 lines of the exact thing you're
    trying not to own, and it needs to be run by *someone* on a cadence.
  - *Self-refreshing*: after a session, if `app_update` downloaded more than N MB, the instance
    calls `CreateImage` on itself and a Lambda deregisters the old AMI + deletes its snapshot.
    Elegant, and genuinely the best version of this option — but it means granting the game
    instance `ec2:CreateImage`/`ec2:DeregisterImage`/`ec2:DeleteSnapshot`, and it introduces a
    self-modifying-infrastructure loop that can wedge (orphaned AMIs, a bad snapshot becoming
    the new base, the "which AMI is current?" pointer living in SSM Parameter Store and going
    stale). Every one of those failure modes is a debugging session you'll have at 9pm while
    six people wait.
- **Staleness behaviour:** graceful but unbounded. The longer between bakes, the longer P4 gets,
  asymptotically approaching option 1's full download after a major content patch.
- **Failure modes:** AMI id pointer drift; AMI deregistered but still referenced; region/AZ
  copies; snapshot deleted while AMI exists; lazy-load slowness that looks like "DST is slow"
  and is very hard to attribute.
- **Verdict:** works, is reasonably fast, but carries a permanent maintenance obligation and a
  latency penalty (§2.3) that erases most of its advantage over option 5.

### Option 3 — One persistent instance, stopped and started

Root EBS persists with binaries *and* world; S3 used only for backups.

| Phase | Time |
|---|---|
| `StartInstances` → `running` | ~10–20 s (slower than a cold `RunInstances`) |
| P2 boot from an already-initialized volume | ~15–25 s |
| P3 | 0 (already installed) |
| P4 incremental `app_update` | 20–90 s |
| P5 world | 0 (already local) |
| P6 DST load, no lazy-load penalty, page cache is *not* preserved across a stop | 60–180 s |
| **Total** | **~1.8–5.3 min — the fastest option** |

- **Idle cost:** a 30 GiB gp3 root volume at **$0.08/GB-month** [V, Price List API
  `volumeApiName=gp3`] = **$2.40/month, forever, whether or not anybody plays.**
  Stopped instances are explicitly still charged for EBS
  [V] https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-lifecycle.html.
  You could shrink to 16 GiB ($1.28/mo) — 4.49 GB of game + OS + staging is tight but fits.
- **This is the only option that violates the stated hard constraint.** "While idle, the whole
  stack should cost close to nothing" — $2.40/month of idle EBS is ~20× the entire idle cost of
  the recommended design, and in a zero-play month it *is* the bill.
- **State drift:** the single worst property. The box accumulates: a half-finished manual fix, a
  `apt upgrade` that broke something, a stray log filling the disk, an edited `cluster.ini` that
  nobody remembers editing. There is no "known-good" to reset to. Ephemeral instances are
  self-healing by construction; this one is not.
- **AZ pinning:** the volume lives in one AZ. If that AZ is out of `c6i.large` capacity,
  `StartInstances` fails and you cannot fall back — you're stuck until capacity returns.
  Ephemeral options just launch in a different AZ.
- **Accidental termination:** destroys the root volume (and therefore the world, unless the
  post-stop backup ran). Mitigable with `DisableApiTermination` and
  `DeleteOnTermination=false`, but those are two more things to get right, and
  `DeleteOnTermination=false` on the root volume leaves you paying for orphaned volumes.
- **Verdict:** rejected. It buys ~30–60 s of start time for a permanent idle charge, a
  drift problem, and an AZ single point of failure.

### Option 4 — Ephemeral instance + persistent data EBS volume

Same idea as 3 but the OS is disposable and a data volume carries binaries and/or world.

| Phase | Time |
|---|---|
| P1 + P2 | ~30–38 s |
| `AttachVolume` + wait + `mount` | 10–25 s |
| P3 (still needed — OS is stock) | 15–45 s |
| P4 incremental `app_update` | 20–90 s |
| P5 | 0 |
| P6 DST load | 60–180 s |
| **Total** | **~2.3–6.3 min** |

- **Idle cost:** 16 GiB gp3 = **$1.28/month** [V] standing. Same constraint violation as option 3.
- **AZ pinning:** identical to option 3, and now it also constrains where the *instance* can
  launch, which is worse because you've given up the one benefit (a warm, ready box).
- **Attach/mount complexity:** you must poll for `attached`, handle NVMe device-name
  non-determinism (`/dev/nvme1n1` ordering is not guaranteed — you need
  `lsblk`/`nvme id-ctrl` or a symlink lookup), handle a volume still attached to a zombie
  instance from a previous failed run, and handle "volume is in AZ b, instance launched in AZ
  c". That is real, fiddly, stateful code.
- **Verdict:** rejected. All of option 3's costs, none of option 3's speed benefit, plus new
  orchestration code.

### Option 5 — Binaries cached as an S3 tarball, stock AMI ★ recommended

Stock Ubuntu 24.04 → `apt install` deps → `s5cmd`/`aws s3 cp` the ~3.2 GB zstd tarball → extract
→ `app_update` (incremental, because the tarball includes
`steamapps/appmanifest_343050.acf` and the whole `~/Steam` state) → pull world → run. On stop:
push world, and if `app_update` changed anything, re-tar and re-upload the binaries **after**
the world is safely uploaded and **after** the server is down — entirely off the critical path.

| Phase | Time |
|---|---|
| P1 + P2 | ~30–38 s |
| P3 deps | 15–45 s |
| P4a pull ~3.2 GB tarball from S3 in-region (§2.4) | 12–30 s |
| P4b `zstd -d -T0` + untar to 4.5 GB | 15–30 s |
| P4c incremental `app_update` (cache ≤ a few weeks old) | 15–60 s |
| P5 world (~15 MB) | ~5 s |
| P6 DST Master + Caves load, **no lazy-load penalty** (§2.3) | 60–180 s |
| **Total** | **~2.6–6.5 min** |

- **Idle cost:** ~3.2 GB in S3 Standard at **$0.023/GB-month** [V] https://aws.amazon.com/s3/pricing/
  = **$0.074/month**. That is ~3× cheaper than the custom AMI's snapshot storage and ~30×
  cheaper than the persistent EBS options.
- **20 h cost:** instance-hours + $0.07 of S3 + a handful of requests. The monthly tarball
  re-upload is ~3.2 GB of PUT (in-region, free transfer; multipart PUT requests round to
  fractions of a cent).
- **Complexity:** low, and — critically — it is *ordinary application code*, not infrastructure
  lifecycle. `tar`, `zstd`, `aws s3 cp`. No AMI registry, no snapshot GC, no volume attach state
  machine, no AZ constraint. The launch template points at a public SSM AMI parameter and is
  never touched again.
- **Self-healing:** if the tarball is missing, corrupt, or fails its checksum, the script falls
  through to option 1 (full steamcmd download) and then re-seeds the cache. The cold path is
  slow but always available. You cannot get into an unrecoverable state.
- **Staleness behaviour:** identical in shape to the custom AMI — a stale cache means a bigger
  delta — but the refresh is automatic and free rather than a manual bake. After every session
  that pulled a patch, the cache is current again. In practice, with any regular play, the
  cache is never more than one session stale.
- **Failure modes:** a torn/partial tarball (fix: upload to a temp key, then `CopyObject` to the
  live key — S3 PUT is atomic, so readers never see a partial object; plus a stored SHA-256 in
  object metadata); two instances racing to re-upload (can't happen — only one world runs at a
  time, and you should still guard with a conditional write / DynamoDB lock).
- **Verdict: recommended.** Within noise of the custom AMI on speed, cheaper, and the only
  option whose failure mode is "slower today" rather than "broken until someone fixes it".

### Option 6 — EFS

| | |
|---|---|
| Storage | **$0.30/GB-month** Standard, **$0.16/GB-month** One Zone [V, Price List API `AmazonEFS`, us-west-2] |
| 4.5 GB of binaries, idle | **$1.35/month** (Standard) or $0.72 (One Zone) — standing, forever |
| Elastic Throughput reads | **$0.03/GB** [V, same] → ~$0.14 *per boot* just to read the game files |
| Mount targets | one ENI per AZ; ENIs are free but they are always-on VPC objects in a "nothing always-on" design |
| Latency | NFS over the network. DST's startup reads thousands of small files; per-file round trips are exactly EFS's weakness. Expect P6 to get **worse**, not better. |

**Dismissed.** It is 25× the storage cost of S3, charges you per byte read on every boot, is
slower for this access pattern, and adds VPC plumbing. There is no dimension on which it wins.

### Scorecard

| # | Option | Click-to-joinable [E] | Idle $/mo | 20 h $/mo (`c6i.large`) | Complexity | Worst failure mode |
|---|---|---|---|---|---|---|
| 1 | Fully ephemeral, full download | 5–12 min | **$0.00** | $2.29 | **Lowest** | Steam CDN slow/down → no world at all |
| 2 | Custom AMI | 2.5–6 min | $0.25 | $2.55 | High (bake pipeline) | AMI pointer drift; silent lazy-load slowness |
| 3 | Persistent stopped instance | **1.8–5.3 min** | **$2.40** | $4.70 | Medium | State drift; AZ capacity lockout; termination = data loss |
| 4 | Persistent data volume | 2.3–6.3 min | $1.28 | $3.60 | High (attach state machine) | AZ pinning + orphaned/zombie attachment |
| **5** | **S3 binaries tarball, stock AMI** | **2.6–6.5 min** | **$0.07** | **$2.37** | **Low** | Bad tarball → falls back to option 1 (slow, not broken) |
| 6 | EFS | 3–7 min (likely worse) | $1.35 | $3.80 | Medium | Slow small-file reads; always-on mount targets |

Note how tightly clustered options 2–5 are on time: **the spread between the best and worst of
them is under a minute**, and **P6 (DST loading Master + Caves) is the largest single term in
every one of them**. Optimising storage past option 5 is optimising the wrong thing. If start
time ever needs to come down further, the lever is P6 — a faster single-thread CPU — not the
storage layer.

### Recommendation

**Option 5 for the binaries. S3 for the save. Option 1 as the automatic fallback path.**

Concretely:
- Launch template → `resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id`
  (**Ubuntu, not AL2023** — §2.2)
- Root volume: **30 GiB gp3**, `DeleteOnTermination=true`, default 3,000 IOPS / 125 MiB/s
  (both included free with gp3 [V] https://docs.aws.amazon.com/ebs/latest/userguide/general-purpose.html).
  4.49 GB game + ~3 GB Steam update staging + OS + logs — 30 GiB costs 8 cents a month at this
  duty cycle, so don't shave it.
- `s3://dst-data-<acct>/binaries/343050/linux-x86_64.tar.zst` + `.sha256`, containing the whole
  `~/Steam` tree (so `appmanifest_343050.acf` makes the next `app_update` incremental) with the
  `librtmp.so.0` fix already applied (§2.2)
- Fall through to a full `steamcmd` download if the object is absent or the checksum fails
- Re-upload the tarball post-session only when `app_update` reported changes
- Use the **`bin64`** server binary (§2.1)

See §6 for what the spike must measure to confirm this.

---

## 4. S3 layout, backup and pruning

### 4.1 Buckets and regions

Two buckets, because they have different regions, different access patterns and different
blast radii:

| Bucket | Region | Contents | Public? |
|---|---|---|---|
| `dst-web-<acct>` | **us-east-1** | Static SPA build. CloudFront OAC origin. | via CloudFront only |
| `dst-data-<acct>` | **us-west-2** | Seed, worlds, binaries cache, session logs. | never |

**The data bucket goes in us-west-2, next to the instance.** Rationale: EC2↔S3 same-region is
free and fast [V §2.4]; cross-region would cost **$0.02/GB** and add latency to the one transfer
that's on the critical path (and to every 5-minute in-session sync). The us-east-1 Lambda reads
it cross-region, but that's a handful of small control-plane calls per session (~70 ms extra
each) — irrelevant.

### 4.2 Key layout

```
s3://dst-data-<acct>/
├── seed/                                   # IMMUTABLE. Written once, by hand. Never by code.
│   └── <world-id>/original.zip             #   Tyler's untouched 9.8 MB upload.
│
├── worlds/
│   └── <world-id>/
│       ├── save.tar.zst                    # VERSIONED. The current world, and its whole history.
│       │                                   #   metadata: phase=pre-start|post-stop|seed-import,
│       │                                   #   session-id, cluster-day, dst-build, sha256
│       └── inflight/<session-id>/          # 5-min in-session sync. Raw files, `aws s3 sync`.
│           └── <cluster tree>              #   Crash-recovery source only. Lifecycle-expired at 14 d.
│
├── binaries/
│   └── 343050/
│       ├── linux-x86_64.tar.zst            # The boot cache. Overwritten in place.
│       └── linux-x86_64.sha256
│
└── sessions/
    └── <world-id>/<session-id>/
        ├── meta.json                       # stable schema — the LLM-summary hook
        ├── logs/server_log_master.txt.gz
        ├── logs/server_log_caves.txt.gz
        ├── logs/server_chat_log_master.txt.gz
        ├── logs/server_chat_log_caves.txt.gz
        └── summary.json                    # written later, by the summariser feature
```

`<session-id>` should be **time-sortable**: `20260919T2013Z-<6 random chars>` (a ULID is also
fine). This makes `sessions/<world>/` list in chronological order for free, which is exactly
what a future "summarise the last N sessions" job wants. `meta.json` carries
`{world_id, session_id, started_at, ended_at, instance_id, instance_type, dst_build,
day_at_start, day_at_end, players: [...], end_reason}` — enough for the summariser to
contextualise the chat log without parsing the server log.

Note there is deliberately **no `backups/<id>/<timestamp>-pre-start` prefix**. See §4.3.

### 4.3 Versioning vs timestamped keys — and the "never prune the latest" rule

The requirement is: *prune old backups, but never the latest one for a world, even if nobody
plays for a year.* This rules out the obvious design.

**Age-based expiration on timestamped keys does not work.** A lifecycle rule of
`Expiration{Days: 365}` on `backups/<id>/*` deletes objects 365 days after *creation*. It has no
concept of "newest". If nobody plays for a year, every backup ages past the threshold and S3
deletes **all of them, including the latest**. There is no lifecycle filter that expresses
"except the most recent". To use timestamped keys you must write and correctly maintain your
own pruning code, and a bug in that code is unrecoverable data loss.

**S3 Versioning + `NoncurrentVersionExpiration` does work**, and S3 enforces it for you. Two
documented guarantees, both quoted verbatim from
[V] https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-configuration-examples.html:

> "The `NoncurrentVersionExpiration` action doesn't apply to the current object versions. It
> removes only the noncurrent versions."

> "Be aware that more than 10 newer noncurrent versions must exist before Amazon S3 can expire
> a given version. … **For the deletion to occur, both the `NoncurrentDays` and the
> `NewerNoncurrentVersions` values must be exceeded.**"

So with:

```json
{
  "ID": "world-save-retention",
  "Filter": { "Prefix": "worlds/" },
  "Status": "Enabled",
  "NoncurrentVersionExpiration": {
    "NewerNoncurrentVersions": 10,
    "NoncurrentDays": 30
  }
}
```

- The **current version is structurally ineligible** for expiration. The latest save can never
  be deleted by lifecycle, at any age, ever.
- Because *both* conditions must be exceeded, the **10 most recent noncurrent versions are also
  kept regardless of age**. A world untouched for five years still has its latest save plus ten
  predecessors.
- Prune older-than-30-days versions beyond the newest ten: automatic, zero code.

Edge case worth reasoning through: if something issued a plain `DeleteObject` (no version id) on
the key, S3 would insert a delete marker as the new *current* version and the real latest save
would become noncurrent. Would lifecycle then eat it? No — it would be noncurrent version #1,
and `NewerNoncurrentVersions: 10` protects it indefinitely. And the bucket policy below makes
that call impossible in the first place. Belt and braces.

Every write is `PutObject` to the same key `worlds/<id>/save.tar.zst`. Pre-start writes a
version tagged `phase=pre-start`; post-stop writes one tagged `phase=post-stop`. That is
~2 versions per session; at 7 sessions/month you keep roughly 1–2 months of rolling history plus
a permanent floor of 11 versions.

**Additional benefits of versioning here:**
- The "current pointer" is atomic. With timestamped keys you need a separate `current` object or
  a naming convention, and there is a window where `current` points at something that isn't
  there. With versioning there is no window.
- Backup history is one `ListObjectVersions` call, already newest-first, with your metadata
  attached. The API surface for "show me the backups for this world" is free.
- Accidental overwrite is *also* protected, not just accidental delete.

**And then take the delete capability away from the app entirely.** The orchestrator role never
needs to delete anything under `worlds/`; lifecycle does all pruning. So:

```json
{
  "Sid": "AppMayNeverDestroyASave",
  "Effect": "Deny",
  "Principal": "*",
  "Action": ["s3:DeleteObject", "s3:DeleteObjectVersion",
             "s3:PutBucketVersioning", "s3:PutLifecycleConfiguration"],
  "Resource": "arn:aws:s3:::dst-data-<acct>/worlds/*",
  "Condition": { "StringNotEqualsIfExists": {
      "aws:PrincipalArn": "arn:aws:iam::<acct>:role/dst-break-glass" } }
}
```

Now no bug in the Lambda or the instance script can destroy a world, because the credentials
they hold cannot express the operation. That, combined with the lifecycle guarantee, is a much
stronger safety story than "we wrote careful pruning code".

**Cost of versioning:** each noncurrent version is billed as a full object at normal rates
[V] https://aws.amazon.com/s3/pricing/. At ~15 MB per version × ~25 retained versions × 3 worlds
≈ 1.1 GB ≈ **$0.026/month**. Irrelevant.

**Where age-based expiration *is* fine:** `sessions/` (logs are not the save) and
`worlds/*/inflight/` (crash-recovery scratch). Use plain `Expiration` there.

```json
{ "ID": "inflight-scratch",  "Filter": {"Prefix": "worlds/"},
  "Status": "Enabled", "Expiration": {"Days": 14} }        // scope to */inflight/* via tag or
                                                            // a dedicated top-level prefix
{ "ID": "session-logs",      "Filter": {"Prefix": "sessions/"},
  "Status": "Enabled", "Expiration": {"Days": 730} }
{ "ID": "mpu-hygiene",       "Filter": {"Prefix": ""},
  "Status": "Enabled", "AbortIncompleteMultipartUpload": {"DaysAfterInitiation": 7} }
```

(Practical note: lifecycle `Filter.Prefix` can't express `worlds/*/inflight/`, so put the
in-session scratch at a top-level `inflight/<world-id>/<session-id>/` prefix instead of nesting
it under `worlds/`. Adjust the tree in §4.2 accordingly if you want the rule to be a one-liner.)

**Don't tier the backups.** Standard-IA is $0.0125/GB-mo vs Standard's $0.023 — saving $0.01 on
a ~1 GB bucket — while adding a 30-day minimum duration, a 128 KB minimum billable size (most of
the log files are smaller than that and would be billed at 128 KB), and $0.01 per 1,000
transition requests [V] https://aws.amazon.com/s3/pricing/. The transitions would cost more than
the storage saved. Keep everything in Standard.

### 4.4 Making `seed/` immutable

Two candidates:

**Bucket policy Deny (recommended).**

```json
{
  "Sid": "SeedIsWriteOnce",
  "Effect": "Deny",
  "Principal": "*",
  "Action": ["s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion",
             "s3:PutObjectAcl", "s3:PutObjectTagging"],
  "Resource": "arn:aws:s3:::dst-data-<acct>/seed/*",
  "Condition": { "StringNotEqualsIfExists": {
      "aws:PrincipalArn": "arn:aws:iam::<acct>:role/dst-seed-admin" } }
}
```

Six lines of IaC, prefix-scoped, no bucket-wide semantics change, trivially auditable, trivially
reversible. It protects against exactly the threat that matters here: **a bug in our own code**.
An explicit `Deny` beats any `Allow`, so it holds even if the Lambda's IAM policy is later
widened by accident.

**S3 Object Lock (not recommended here).** [V] https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-overview.html

- Requires versioning (fine, we want it anyway) but is **enabled bucket-wide**, changing the
  semantics of the *whole* bucket including the saves you do want to prune. You'd then have to
  be careful that no default retention leaks onto `worlds/`.
- Per-object protection is the right granularity (a **legal hold** on each seed object — "remains
  in place until you explicitly remove it", no expiry to choose), but that's an extra API call
  per seed upload and an extra concept to remember when someone adds world #4 in eight months.
- **Compliance mode is a foot-gun**: "The only way to delete an object under the compliance mode
  before its retention date expires is to delete the associated AWS account." For a hobby
  project's seed files, that risk is strictly larger than the risk it mitigates.
- No extra charge for Object Lock itself [V — no line item in the S3 pricing feed], so this is
  purely a complexity argument.

**Verdict: bucket policy.** Note the honest caveat: an account administrator can edit the bucket
policy, so this is protection from *application bugs*, not from a determined human. That is the
correct threat model. If protection-from-yourself is later wanted, the upgrade path is
governance-mode Object Lock with a legal hold on `seed/*` objects — and that decision doesn't
have to be made now, because Object Lock can be enabled on an existing versioned bucket.

Also: the seed is written **once, by hand** (`aws s3 cp`), never by the application. The
application's only interaction with `seed/` is an initial `GetObject` during world import. Give
the app role `s3:GetObject` on `seed/*` and nothing else.

### 4.5 Archive format: tar.zst, not zip

| | `zip` | `tar.zst` |
|---|---|---|
| Unix permissions / modes | stored in an optional "external attributes" field; preserved by `info-zip` on Unix, **silently dropped** by Python `zipfile`, Go `archive/zip` and most language stdlibs | native, always |
| Symlinks | poorly / inconsistently supported | native |
| mtimes | 2-second DOS granularity | full precision |
| Streaming | needs the central directory at the end → awkward to stream | fully streamable: `aws s3 cp - | zstd -d | tar -x` |
| Ratio on DST saves (Lua/JSON-ish text) | deflate | **noticeably better**, especially `--long=27` |
| Decompression speed | ~100–200 MB/s | **~1 GB/s+** |
| Multi-core | no | `-T0` |

Use **`tar --zstd`** (or `tar -c … | zstd -19 --long=27`) for `worlds/*/save.tar.zst` and
**`zstd -10`** for the binaries tarball (level 19 on 4 GB of already-compressed game assets costs
minutes of CPU for very little gain; level 10 is the right trade).

**Do permissions matter?** Barely — the whole cluster tree is owned by one service user and is
644/755. But preserving them means extract-and-run works without a `chmod` pass, and `tar` gets
it right for free. Extract with `--no-same-owner` so the numeric uid in the archive doesn't have
to exist on the new instance.

Keep `seed/<world>/original.zip` **as a zip, untouched** — it is Tyler's artifact, not ours. The
one-time import job reads the zip, normalises it into a cluster tree, and writes version 1 of
`worlds/<id>/save.tar.zst`. The zip is never read again except for a from-scratch re-import.

### 4.6 Protecting the save during a session

The stated risk: *the instance dies before pushing to S3.* Layered mitigations, cheapest first:

1. **Periodic in-session sync.** Every 5 minutes: send `c_save()` to the server's stdin (forces a
   clean, consistent write [V §2.1] — do not copy while DST is mid-write), then
   `aws s3 sync <cluster-dir> s3://…/inflight/<world>/<session>/`. Delta sync of a ~66 MB tree
   after the first pass moves kilobytes.
   For calibration: **DST autosaves once per in-game day, and published logs show `Serializing
   world` entries exactly 8 minutes apart** [V §2.1], and it keeps `max_snapshots = 6` rolling
   snapshots of its own. So *without* the forced `c_save()`, a plain sync bounds loss at ~8
   minutes anyway; the `c_save()` is what buys the tighter 5-minute bound. If `c_save()` turns
   out to cause a visible hitch (spike item 7), just drop it and sync on a 10-minute timer —
   you lose at most one in-game day, which is the same thing DST's own snapshot cadence gives you.
2. **Ordered shutdown, orchestrator-driven.** The control plane sends `c_shutdown(true)`, waits
   for both shards to exit, waits for the post-stop `PutObject` to be **acknowledged**, and only
   then calls `TerminateInstances`. The instance must never terminate itself before that ack.
   **Budget generously: a clean DST save-and-exit can take up to ~5 minutes** [V §2.1], which is
   why the reference Docker image uses a 6-minute stop grace period. A stop hook that kills at
   30 or 60 seconds will corrupt or lose the final save.
3. **Recovery check at start.** If `inflight/<world>/<any session>/` exists with a timestamp
   newer than the current version of `worlds/<id>/save.tar.zst`, the previous session crashed.
   Surface it in the UI and offer to resume from the in-flight copy rather than silently picking
   either one.
4. **EventBridge reconciliation.** An EC2 instance-state-change rule → Lambda: if an instance
   reaches `terminated`/`shutting-down` without a recorded post-stop backup, mark the world
   `needs-recovery` so nobody starts it and overwrites the in-flight data.
   (EventBridge rules on the default bus for AWS service events are free [V/E §5.3].)
5. **The bucket policy from §4.3** means even a comprehensively broken orchestrator cannot
   delete a version. Worst case is a bad *new* version — and the good one is still there,
   one `ListObjectVersions` away.

Note that (1) is also what makes spot *survivable*: a spot interruption notice gives two minutes,
which is **not** enough for a full clean shutdown (up to ~5 min, above) but is plenty for
`c_save()` + a delta sync to the in-flight prefix. That is the right ordering if spot is ever
adopted — save the data, don't try to shut down gracefully. Still not worth it for the first cut
(§5.1).

---

## 5. Itemized pricing inputs

All figures for **us-west-2** unless noted. Verified 2026-09-19 via the AWS Price List API
(`aws pricing get-products`) and the linked pricing pages.

### 5.1 Compute — EC2 on-demand, Linux, shared tenancy, us-west-2

All **[V]**, AWS Price List API, `regionCode=us-west-2, operatingSystem=Linux, tenancy=Shared,
preInstalledSw=NA, capacitystatus=Used`. Cross-check: https://aws.amazon.com/ec2/pricing/on-demand/

| Type | vCPU | RAM | Network | On-demand $/h | Spot $/h (2026-09-19) | Spot disc. | 20 h + 4 h overhead ≈ 24 h |
|---|---|---|---|---|---|---|---|
| `t3.medium` | 2 | 4 GiB | up to 5 Gb | **0.0416** | 0.0173–0.0192 | ~56% | $1.00 |
| `t3a.medium` | 2 | 4 GiB | up to 5 Gb | **0.0376** | 0.0172–0.0220 | ~53% | $0.90 |
| `t3.large` | 2 | 8 GiB | up to 5 Gb | **0.0832** | 0.0310–0.0385 | ~59% | $2.00 |
| `t3a.large` | 2 | 8 GiB | up to 5 Gb | **0.0752** | 0.0371–0.0441 | ~44% | $1.80 |
| `c7a.medium` | 1 | 2 GiB | up to 12.5 Gb | **0.05132** | 0.0101–0.0204 | ~63% | $1.23 |
| **`c6i.large`** | 2 | 4 GiB | up to 12.5 Gb | **0.0850** | 0.0304–0.0390 | ~56% | **$2.04** |
| `c7i.large` | 2 | 4 GiB | up to 12.5 Gb | **0.08925** | 0.0309–0.0435 | ~53% | $2.14 |
| `c7i-flex.large` | 2 | 4 GiB | up to 12.5 Gb | **0.08479** | 0.0285–0.0409 | ~57% | $2.03 |
| `c7a.large` | 2 | 4 GiB | up to 12.5 Gb | **0.10264** | 0.0371–0.0604 | ~41% | $2.46 |
| `m6a.large` | 2 | 8 GiB | up to 12.5 Gb | **0.0864** | 0.0346–0.0468 | ~55% | $2.07 |
| `m6i.large` | 2 | 8 GiB | up to 12.5 Gb | **0.0960** | 0.0358–0.0491 | ~52% | $2.30 |
| `m7i-flex.large` | 2 | 8 GiB | up to 12.5 Gb | **0.09576** | 0.0400–0.0487 | ~50% | $2.30 |
| `m7a.large` | 2 | 8 GiB | up to 12.5 Gb | **0.11592** | 0.0491–0.0551 | ~55% | $2.78 |
| `t4g.medium` (ARM — **cannot run DST**) | 2 | 4 GiB | up to 5 Gb | 0.0336 | — | — | — |

Spot: **[V]** `aws ec2 describe-spot-price-history --region us-west-2 --product-descriptions
Linux/UNIX`, 2026-09-19. `us-west-2d` is consistently the cheapest AZ. Typical discount 50–60%.

**Billing granularity [V]:** per-second, 60-second minimum
(https://aws.amazon.com/ec2/pricing/). Stopped instances incur **no** compute charge
[V] https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-lifecycle.html. So the
start/stop churn of this design is free; only EBS-while-stopped costs anything, which is why
options 3/4 lose.

#### T-family credits — does the burstable surcharge bite?

[V] https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-credits-baseline-concepts.html

| | vCPU | credits/h earned | baseline per vCPU | max accrual |
|---|---|---|---|---|
| `t3.medium` / `t3a.medium` | 2 | 24 | 20% | 576 |
| `t3.large` / `t3a.large` | 2 | 36 | 30% | 864 |

Unlimited-mode surcharge: **$0.05 per vCPU-hour** for T3 and T3a on Linux
[V, Price List API `productFamily=CPU Credits`; matches the on-demand pricing page].
**T3/T3a launch in `unlimited` mode by default** [V, same doc].

DST is largely single-threaded per shard, so the realistic worst case is roughly one vCPU pinned
(Master busy, Caves mostly idle) — 60 credits/hour spent:

- `t3.medium`: spends 60/h, earns 24/h → 36/h surplus → 3 h session = 108 surplus credits =
  1.8 vCPU-h × $0.05 = **$0.09**
- `t3.large`: spends 60/h, earns 36/h → 24/h surplus → 3 h = 72 credits = 1.2 vCPU-h ×
  $0.05 = **$0.06**

**The catch that makes this worse for an ephemeral design**, and which is easy to miss — two
verbatim facts from the same doc [V]:

> "T8i, T4g, T3a, and T3 instances **do not earn launch credits**. These instances launch as
> `unlimited` by default, and therefore can burst immediately upon start without any launch
> credits."

> "The hourly instance price automatically covers all CPU usage spikes if the average CPU
> utilization of the instance is at or below the baseline **over a rolling 24-hour period or the
> instance lifetime, whichever is shorter**."

So: a freshly launched T3 has **zero accrued credits** (launch credits were a T2-Standard
feature), and because our instance only *lives* ~3 hours, the averaging window is those 3 hours —
there is no idle time to amortise against. A persistent stopped instance (option 3) would carry
its balance across stop/start for 7 days and could well pay $0; **a fresh ephemeral one pays the
full surcharge every session.** Budget it: **~$0.09/session ≈ $0.63/month at 7 sessions**, which
turns `t3.medium`'s $1.00 into ~$1.63 — still the cheapest option, but the gap to `c6i.large`
($2.04) narrows to ~$0.40/month.

**And the community evidence points the same way.** The most-cited DST server performance write-up
says, of VPS selection, verbatim:

> "make sure to get one that does not work based on CPU credits … shards idle at about ~30% CPU;
> when players connect they keep at 90~100% constantly"
> — [V] https://github.com/mathielo/dst-dedicated-server/blob/main/docs/ServerPerformance.md

That is one measurement on an unknown (probably weak) core, so treat the absolute numbers as
**[E]** — on a modern Ice Lake / Sapphire Rapids core, expect Master at 25–50% of a core and
Caves at 15–35%, i.e. **0.4–0.9 core sustained [E]**, with spikes to 100% at autosave and world
load. But the shape is unambiguous: **this is a sustained-load workload, which is precisely what
burstable instances are not for.** Each shard is single-threaded [V, same source], so
`tick_rate` (default 15, max 60) directly trades CPU and bandwidth for smoothness.

Given that (a) the t3 cost advantage is ~$5/year, (b) `c6i.large` has much better single-thread
performance, which attacks P6 — the dominant term in click-to-joinable — and (c) fixed
performance means no mid-session throttling when six people are fighting a boss,
**`c6i.large` is the recommended starting point** and `t3.medium` is the cost-optimised
alternative *only* if the spike shows sustained CPU is comfortably under baseline, which the
evidence above suggests it will not be. Both have 4 GiB, which §2.1 says is sufficient for an
unmodded Master + Caves (1.2–2.0 GB [E]); if the spike shows otherwise, the 8 GiB step is
**`m6a.large` at $0.0864** — cheaper than `t3.large` *and* far better CPU, which is a neat
illustration of how bad a deal the T family is once you actually use the CPU.

**Spot:** saves ~$1/month at this volume. The blocker is not price, it's that the 2-minute
interruption notice is shorter than DST's worst-case ~5-minute clean save (§2.1). Not worth it
for the first cut. Revisit once the 5-minute in-session sync (§4.6) is proven, at which point
the interruption handler can `c_save()` + sync and simply abandon the instance.

### 5.2 Storage and network — us-west-2

| Item | Unit price | Status / source | Assumption |
|---|---|---|---|
| Public IPv4, **in use** | **$0.005/h** | [V] Price List API `USW2-PublicIPv4:InUseAddress`; https://aws.amazon.com/vpc/pricing/ | 24 h/mo → **$0.12**; $0 idle (auto-assigned, exists only while running) |
| Public IPv4, **idle EIP** | $0.005/h | [V] `USW2-PublicIPv4:IdleAddress` | **$3.65/mo if you ever allocate one.** Don't. Auto-assign only. |
| EBS **gp3** storage | **$0.08/GB-mo** | [V] Price List API `volumeApiName=gp3` | 30 GiB root × 24/730 h = **$0.079/mo** (ephemeral). Persistent = $2.40/mo. |
| gp3 included baseline | 3,000 IOPS + 125 MiB/s, **free** | [V] https://docs.aws.amazon.com/ebs/latest/userguide/general-purpose.html | no extra provisioning needed |
| gp3 extra IOPS / throughput | $0.005/IOPS-mo, $0.04/MiBps-mo | [V] Price List API | not used |
| EBS **snapshot** (standard) | **$0.05/GB-mo** | [V] `USW2-EBS:SnapshotUsage` | custom-AMI option only: ~5 GB → **$0.25/mo** |
| EBS snapshot archive | $0.0125/GB-mo (+ $0.03/GB retrieval) | [V] `USW2-EBS:SnapshotArchiveStorage` | n/a |
| **Fast Snapshot Restore** | **$0.75 per snapshot per AZ per hour** | [V] https://docs.aws.amazon.com/ebs/latest/userguide/ebs-fast-snapshot-restore.html | **$547.50/mo for one snapshot in one AZ. Dismissed.** |
| Data transfer **out to internet** | **$0.09/GB** (first 10 TB) | [V] Price List API `AWSDataTransfer`, from "US West (Oregon)" | see §5.4 |
| Free tier, data transfer out | **100 GB/month, aggregated across all services and Regions**, permanent | [V] https://aws.amazon.com/ec2/pricing/on-demand/ | the whole DTO bill probably lands here — but see §5.4 |
| EC2 ↔ S3, **same region** | **$0.00/GB** | [V] https://aws.amazon.com/s3/pricing/ | binaries + save transfers are free |
| Cross-AZ within region | $0.01/GB | [V] Price List API | n/a (single instance) |
| VPC interface endpoint | $0.01/h + $0.01/GB | [V] Price List API `USW2-VpcEndpoint-Hours` | **$7.30/mo each — do not create any.** SSM reaches its endpoints over the public IP; no endpoints needed. |
| NAT gateway | — | — | **not used** (public subnet, auto-assigned IPv4) |

### 5.3 S3, web stack and control plane

| Item | Unit price | Status / source | Assumption → monthly |
|---|---|---|---|
| **S3 Standard** (us-west-2, first 50 TB) | **$0.023/GB-mo** | [V] https://aws.amazon.com/s3/pricing/ | 3.2 GB binaries + ~1.2 GB saves/versions/logs = 4.4 GB → **$0.10** |
| S3 Standard-IA | $0.0125/GB-mo, 30-day + 128 KB minimums | [V] same | not used (§4.3) |
| S3 Glacier IR / Flexible / Deep Archive | $0.004 / $0.0036 / $0.00099 per GB-mo | [V] same | not used |
| S3 PUT/COPY/POST/LIST | **$0.005/1,000** | [V] same | ~6,000/mo (syncs + multipart) → **$0.03** |
| S3 GET | **$0.0004/1,000** | [V] same | ~5,000/mo → **$0.002** |
| S3 lifecycle transition requests | $0.01–$0.05/1,000 | [V] same | $0 (no transitions) |
| S3 Versioning | $0 to enable; noncurrent versions billed as full objects | [V] https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html | ~25 versions × 15 MB × 3 worlds ≈ 1.1 GB → **$0.026** (included in the row above) |
| S3 Object Lock | **no extra charge** | [V — verified by absence in the S3 pricing feed + docs] | not used |
| **CloudFront** pay-as-you-go free tier | **1 TB DTO + 10M HTTP(S) requests/mo, perpetual** | [V] https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/ | a tiny SPA for 6 people → **$0.00** |
| CloudFront flat-rate plans (new, 2026) | Free $0 (1M req + **100 GB**), Pro $15, Business $200, Premium $1,000 | [V] https://aws.amazon.com/cloudfront/pricing/ ; https://aws.amazon.com/about-aws/whats-new/2026/09/cloudfront-flat-rate-pricing-plans-api/ | **⚠ Do not switch to a plan.** The "Free plan" (100 GB) is *worse* than pay-as-you-go's 1 TB free tier. Stay on pay-as-you-go. |
| CloudFront DTO beyond free (US/CA/MX) | $0.085/GB | [V] same | $0 |
| CloudFront HTTPS requests beyond free | $0.0100/10,000 | [V] same | $0 |
| **Lambda** duration, x86 | $0.0000166667/GB-s | [V] https://aws.amazon.com/lambda/pricing/ | within free tier |
| Lambda duration, **arm64** | **$0.0000133334/GB-s (~20% cheaper)** | [V] Lambda pricing feed | use arm64 |
| Lambda requests | $0.20/1M | [V] same | within free tier |
| Lambda free tier | 1M req + 400,000 GB-s/mo, **always free** | [V] same | a few thousand invocations → **$0.00** |
| **Lambda Function URL** | **$0 extra** | [V — no line item] | **recommended over API Gateway** |
| API Gateway **HTTP API** | $1.00/1M (first 300M) | [V] https://aws.amazon.com/api-gateway/pricing/ | ~$0.00 at our volume, but a needless dependency |
| API Gateway **REST API** | $3.50/1M | [V] same | no |
| API Gateway free tier | 1M calls/mo — **12 months only, not perpetual** | [V] same | ⚠ don't build a cost model on it |
| **DynamoDB** on-demand writes | $0.625/1M WRU | [V] https://aws.amazon.com/dynamodb/pricing/on-demand/ | a few hundred/mo → **$0.00** |
| DynamoDB on-demand reads | $0.125/1M RRU | [V] same | **$0.00** |
| DynamoDB storage | $0.25/GB-mo, **first 25 GB always free** | [V] same | **$0.00** |
| **Route 53** hosted zone | $0.50/mo (already paid by other sites) | [V] https://aws.amazon.com/route53/pricing/ | **$0.00 marginal** |
| Route 53 **alias → CloudFront queries** | **free** — "Alias A/AAAA records mapped to … Amazon CloudFront distributions do not incur a charge" | [V] same | **$0.00** |
| Route 53 standard queries | $0.40/1M | [V] same | n/a (alias) |
| **ACM** public certificate | **free** | [V] https://aws.amazon.com/certificate-manager/pricing/ | $0.00 (⚠ *exportable* public certs cost $7/domain — don't use that option) |
| **SSM Parameter Store**, standard | **free** | [V] https://aws.amazon.com/systems-manager/pricing/ | Klei token as SecureString → **$0.00** |
| SSM advanced parameters | $0.05/param/mo + $0.05/10k ops | [V] same | not needed (4 KB limit is plenty for a Klei token) |
| **KMS** `aws/ssm` AWS-managed key | **no key-month charge** | [V] https://aws.amazon.com/kms/pricing/ | **$0.00** |
| KMS requests | $0.03/10,000, **first 20,000/mo free** | [V] same | ~10 decrypts/mo → **$0.00** |
| KMS customer-managed key | $1.00/key-mo | [V] same | **don't create one** |
| **CloudWatch Logs** ingestion, Standard | $0.50/GB | [V] https://aws.amazon.com/cloudwatch/pricing/ | Lambda logs only, <0.1 GB → within free tier |
| CloudWatch Logs, Infrequent Access | $0.25/GB | [V] same | ⚠ **game logs go to S3 at $0.023/GB, not CloudWatch at $0.50/GB — 22× cheaper** |
| CloudWatch Logs storage | $0.03/GB-mo | [V] same | negligible |
| CloudWatch alarms, standard resolution | **$0.10/alarm-mo** | [V] same | 3 alarms, free tier covers 10 alarm-metrics → **$0.00** |
| CloudWatch custom metrics | $0.30/metric-mo (first 10k) | [V] same | use 0 custom metrics if possible; free tier covers 10 |
| CloudWatch free tier | 5 GB logs, 10 custom metrics, 10 alarm metrics | [V] same | covers us |
| **EventBridge** — AWS service events on default bus | **free** | [V] https://aws.amazon.com/eventbridge/pricing/ ("AWS management events are ingested by the event bus for free") | EC2 state-change rules → **$0.00** |
| EventBridge custom events | $1.00/1M | [V] same | n/a |
| EventBridge **scheduled rules** on default bus | **free** | **[E]** — no line item on the pricing page; verified only by absence | idle-shutdown scheduling |
| **EventBridge Scheduler** | $1.00/1M invocations, **first 14M/mo free** | [V] same | **$0.00** |
| **AWS Budgets** — monitoring + notifications | **free, unlimited** | [V] https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/ | **$0.00** |
| Budget **actions** | first **2** action-enabled budgets free, then $0.10/budget/day | [V] same | keep to ≤2 if you want auto-stop actions |
| **SSM Session Manager** on EC2 | **free** — "No additional charges for usage on Amazon EC2 instances" | [V] https://aws.amazon.com/systems-manager/pricing/ | **$0.00** |
| SSM Advanced Instance Tier | **removed 2026-06-30** — no longer exists | [V] same | the old "advanced tier costs money" worry is obsolete |
| **EFS** Standard / One Zone (for reference) | $0.30 / $0.16 per GB-mo; Elastic Throughput reads $0.03/GB, writes $0.06/GB | [V] Price List API `AmazonEFS`, us-west-2 | **dismissed (§3, option 6)** |

### 5.4 Data transfer out — the one number that could surprise you

Klei publishes no per-player figure. The best available data point is a hosting provider's
statement that **"a full 6-player server barely nudges 1 Mbps upload"**
[V] https://low.ms/blog/how-to-host-dont-starve-together-dedicated-server — which implies
**~20 KB/s (0.17 Mbps) upstream per player** at the default `tick_rate` of 15. Bandwidth scales
roughly linearly with player count and with `tick_rate` **[E]**; shard-to-shard traffic is
loopback and costs nothing.

| Scenario | KB/s/player | 6 players | per hour | 20 h/month |
|---|---|---|---|---|
| **Baseline (1 Mbps @ 6 players) [V-anchored]** | 20 | 120 KB/s | 0.42 GB | **8.5 GB** |
| 2× for combat / entity-heavy play [E] | 40 | 240 KB/s | 0.85 GB | **17 GB** |
| 3× headroom, or `tick_rate` raised to 30 [E] | 60 | 360 KB/s | 1.27 GB | **25 GB** |

Against the **100 GB/month account-wide** free allowance
[V] https://aws.amazon.com/ec2/pricing/on-demand/, all three scenarios fit with a wide margin —
**if the rest of the account doesn't consume it.**

I checked: for **August 2026 the account recorded $0.00 and 0 units** across the EC2 / S3 /
CloudFront "Data Transfer — Internet (Out)" usage-type groups
[V, `aws ce get-cost-and-usage`, 2026-08-01→2026-09-01]. Total account spend that month was
**$6.29**, almost all of it Route 53 ($3.03) and 57.16 GB of legacy us-west-2 EBS snapshots
($2.86). So the 100 GB allowance is effectively **entirely unused** and DST will fit inside it.

**If it ever didn't**, the marginal cost is $0.09/GB → baseline **$0.77/month**, worst case
**$2.25/month**. Worth a CloudWatch `NetworkOut` alarm and a Budget, but this is no longer the
scary line item it looked like before the numbers came in. Keep `tick_rate` at the default 15
unless someone complains about smoothness — raising it costs both CPU and egress.

(Unrelated but worth a look: that 57 GB of EBS snapshots costs $34/year and may be orphaned.)

### 5.5 Cost model

#### (i) Idle month — nobody plays at all

| Line | Cost |
|---|---|
| EC2 compute | $0.00 |
| Public IPv4 (auto-assigned, no EIP) | $0.00 |
| EBS (fully ephemeral — no persistent volumes) | $0.00 |
| S3 storage: 3.2 GB binaries + 1.2 GB saves/versions/logs | $0.101 |
| S3 requests | ~$0.00 |
| DynamoDB / Lambda / CloudFront / EventBridge / Budgets / SSM / ACM / KMS | $0.00 (free tiers) |
| Route 53 (zone already paid; CloudFront alias queries free) | $0.00 marginal |
| CloudWatch | $0.00 (within free tier) |
| **Total** | **≈ $0.10 / month** |

With the **custom AMI** instead: +$0.25 snapshot → ~$0.35.
With a **persistent 30 GiB volume**: +$2.40 → ~$2.50, i.e. **25× the recommended design.**

#### (ii) Month with ~20 hours of play

Assumptions: 7 sessions averaging ~2.9 h. Each session bills ≈ 20 h of play + **3.5 h of the
30-minute idle-shutdown timer** (7 × 0.5 h) + ~0.5 h of boot/shutdown overhead = **~24 billed
instance-hours**. That idle-timer tail is 15% of the compute bill and is worth noting — dropping
it to 15 minutes would save ~$0.15/month.

| Line | `c6i.large` | `t3.medium` | `c6i.large` spot |
|---|---|---|---|
| EC2 compute (24 h) | $2.04 | $1.00 | $0.84 |
| T3 unlimited surcharge (§5.1) | — | ~$0.63 | — |
| Public IPv4 (24 h × $0.005) | $0.12 | $0.12 | $0.12 |
| EBS gp3 root, 30 GiB × 24/730 h | $0.08 | $0.08 | $0.08 |
| Data transfer out (~9–17 GB, inside the 100 GB free tier) | $0.00 | $0.00 | $0.00 |
| S3 storage | $0.10 | $0.10 | $0.10 |
| S3 requests (syncs, uploads, multipart) | $0.03 | $0.03 | $0.03 |
| Everything else (Lambda, DDB, CF, R53, SSM, KMS, EventBridge, Budgets, CW) | $0.00 | $0.00 | $0.00 |
| **Total** | **≈ $2.37** | **≈ $1.96** | **≈ $1.17** |

Sensitivities worth keeping in mind:
- **If the 100 GB DTO allowance were consumed by something else**: +$0.77 (baseline) to +$2.25
  (worst case). Still the largest swing factor, but smaller than feared once the real bandwidth
  number came in (§5.4).
- **If 8 GiB of RAM turns out to be required** (`m6a.large` at $0.0864): **+$0.03**. Negligible —
  do not optimise instance size for cost, optimise it for P6 and for not running out of memory.
- **Custom AMI instead of the S3 tarball**: +$0.18/month and a permanent maintenance obligation.
- **Persistent instance (option 3)**: +$2.33/month, and a $2.40 floor in zero-play months.
- **Shortening the idle-shutdown timer from 30 to 15 minutes**: −$0.15/month. Not worth
  degrading the "did everyone really quit?" heuristic for.

**Annualised**, assuming ~6 active months and ~6 dead months:
`6 × $2.37 + 6 × $0.10 ≈ **$14.80/year**`. The Route 53 hosted zone this account already pays
for ($6/year) costs almost half as much as the entire project.

---

## 6. Open questions the spike must close

Ordered by how much they could change the design. Several questions from the original brief are
already closed by §2.1/§2.2 (install size, login mode, autosave cadence, shutdown duration, AL2023
viability) and are not repeated here.

1. **P6 — DST Master + Caves load time on Tyler's *real* world.** Published logs give 41 s at day
   6 and 59 s at day 22 [V §2.1]; the extrapolation to 1–3 min for a few-hundred-day world is the
   weakest link in the whole estimate, and it is the **largest single term in click-to-joinable**.
   Measure it on `t3.medium` / `c6i.large` / `c7i.large`, and log Master-ready and Caves-ready
   separately. Do this first — everything else in §3 is rounding error next to it.
2. **Sustained CPU % per shard with 6 real players.** The one published measurement says shards
   sit at 90–100% with players connected [V §5.1], which would rule out the T family outright.
   Confirm on a modern core. Also check whether a fresh T3 (zero accrued credits, §5.1) throttles
   in the first minutes.
3. **Peak RSS** of Master + Caves with 6 players on the real world → confirms 4 GiB is enough
   (`c6i.large`) or forces 8 GiB (`m6a.large`, +$0.03/month).
4. **Compressed tarball size** at `zstd -10` vs `zstd -19 --long=27` on the 4.49 GB tree, and
   **P4a/P4b wall-clock**: `aws s3 cp` vs `s5cmd`, and decompress time on 2 vCPUs. (Installed size
   is already verified; only the compression ratio is open.) On `t3.medium`, also confirm a
   ~3.2 GB pull doesn't exhaust network credits.
5. **`app_update` delta time** at 0 / 7 / 30 days of staleness, and across a real Klei patch.
   If a 30-day-stale cache updates in under a minute, option 5 is conclusively right. If a patch
   day costs 5 minutes, add a scheduled warm-up that refreshes the tarball after Klei ships,
   rather than only after a session.
6. **Ubuntu 24.04 P2** (launch → user-data) actually measured, and whether the apt step can be
   eliminated by shipping the `lib32*` / `libcurl3-gnutls` files inside the tarball.
7. **Does `c_save()` cause a visible hitch**, and how long does it block? If yes, fall back to a
   10-minute plain sync (§4.6) — DST's own 8-minute autosave already bounds the loss.
8. **Bytes out per player-hour** from CloudWatch `NetworkOut` → confirms §5.4's 20 KB/s/player.
9. **Confirm the `librtmp.so.0` / `libnettle.so.6` gotcha** still bites on Ubuntu 24.04 and that
   deleting the bundled library is the right fix to bake into the tarball (§2.2).
10. **Lazy-load A/B** (optional, to close option 2 vs option 5 with data): bake one AMI and
    compare P6 from it against the tarball path. If the gap is under ~20 s, option 5 wins
    outright and the question never needs revisiting.

---

## Sources

- AWS Price List API (`aws pricing get-products`), service codes `AmazonEC2`, `AmazonVPC`,
  `AWSDataTransfer`, `AmazonEFS`; `aws ec2 describe-spot-price-history`;
  `aws ce get-cost-and-usage` — all us-west-2, queried 2026-09-19
- https://aws.amazon.com/ec2/pricing/on-demand/
- https://aws.amazon.com/ec2/pricing/
- https://aws.amazon.com/ebs/pricing/
- https://aws.amazon.com/vpc/pricing/
- https://aws.amazon.com/s3/pricing/
- https://aws.amazon.com/efs/pricing/
- https://aws.amazon.com/cloudfront/pricing/ and .../pay-as-you-go/
- https://aws.amazon.com/about-aws/whats-new/2026/09/cloudfront-flat-rate-pricing-plans-api/
- https://aws.amazon.com/lambda/pricing/
- https://aws.amazon.com/api-gateway/pricing/
- https://aws.amazon.com/dynamodb/pricing/on-demand/
- https://aws.amazon.com/route53/pricing/
- https://aws.amazon.com/certificate-manager/pricing/
- https://aws.amazon.com/systems-manager/pricing/
- https://aws.amazon.com/kms/pricing/
- https://aws.amazon.com/cloudwatch/pricing/
- https://aws.amazon.com/eventbridge/pricing/
- https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/lifecycle-configuration-examples.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lock-overview.html
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/Versioning.html
- https://docs.aws.amazon.com/ebs/latest/userguide/ebs-initialize.html
- https://docs.aws.amazon.com/ebs/latest/userguide/ebs-fast-snapshot-restore.html
- https://docs.aws.amazon.com/ebs/latest/userguide/general-purpose.html
- https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-instance-lifecycle.html
- https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/burstable-credits-baseline-concepts.html
- https://aws.amazon.com/blogs/storage/addressing-i-o-latency-when-restoring-an-amazon-ebs-volume-from-a-ebs-snapshot/
- https://www.daemonology.net/blog/2021-08-12-EC2-boot-time-benchmarking.html
- https://www.doit.com/blog/save-time-and-money-on-s3-data-transfers-surpass-aws-cli-performance-by-up-to-80x
- https://docs.aws.amazon.com/linux/al2023/release-notes/removed-i686-AL2023.8-AL2.html
- https://repost.aws/questions/QUTMOyTk4MT0KJB947GyFIAw/i686-package-on-amazon-linux-2023

**DST-specific:**

- `https://api.steamcmd.net/v1/info/343050` — app 343050 depot sizes and build ids (fetched
  2026-09-19; steamdb.info returns 403 to automated fetches)
- https://dontstarve.wiki.gg/wiki/Guides/Don%E2%80%99t_Starve_Together_Dedicated_Servers
- https://dontstarve.wiki.gg/wiki/Don't_Starve_Together/Version_History/2026
- https://github.com/mathielo/dst-dedicated-server/blob/main/docs/ServerPerformance.md
- https://github.com/mathielo/dst-dedicated-server/blob/main/DSTClusterConfig/cluster.ini
- https://github.com/Jamesits/docker-dst-server (Dockerfile, FAQ) and
  https://hub.docker.com/r/jamesits/dst-server
- https://github.com/rawii22/DSTSaves — real `server_log.txt` files used for startup timings
- https://github.com/Hansen-L/dst_saves — real cluster tree used for save sizes
- https://forums.kleientertainment.com/forums/topic/140715-2022-updated-dedicated-server-quick-setup-guide-linux/
- https://forums.kleientertainment.com/forums/topic/113417-dont-starve-together-32-bit-dedicated-server-issue/
- https://forums.kleientertainment.com/klei-bug-tracker/dont-starve-together/dontstarve_dedicated_server_nullrenderer_x64-fails-to-start-due-to-odd-dependencies-on-nettle-on-linux-r46035/
- https://forums.kleientertainment.com/forums/topic/51213-dst-dedicated-server-on-aws-ec2-instance/
- https://forums.kleientertainment.com/forums/topic/70769-guide-to-fight-against-lag/ (`tick_rate`)
- https://support.klei.com/hc/en-us/articles/360036287551-Out-of-Memory-Error-DST
- https://low.ms/blog/how-to-host-dont-starve-together-dedicated-server (bandwidth)
- https://packages.ubuntu.com/noble/steamcmd
- https://accounts.klei.com/account/game/servers?game=DontStarveTogether (cluster token)

Note: several Klei forum and support URLs return 403 to automated fetches; those claims were read
through search snippets or a text proxy rather than fetched directly.
