# Survey: on-demand game-server projects on AWS

Research for the DST-server-manager project (webapp in us-east-1, EC2 game server in
us-west-2). Goal: extract lifecycle and backstop patterns from existing on-demand
game-server-on-AWS projects, then answer specific design questions for this project.

## Projects surveyed

### 1. doctorray117/minecraft-ondemand
https://github.com/doctorray117/minecraft-ondemand

- **Trigger**: players' DNS lookup of `minecraft.yourdomain.com` is logged by Route 53
  public-hosted-zone query logging → CloudWatch Logs → subscription filter → Lambda.
  Route 53 query logs only ship to **us-east-1**, so the trigger Lambda must live there
  (it can still start resources in any other region).
- **Launch model**: not raw EC2 — **ECS Fargate**, service desired-count 0 → 1. Two
  containers per task: the Minecraft server and a "watchdog" sidecar.
- **State tracking**: no database. State *is* the ECS service desired-count / task state
  (queryable via `DescribeServices`). The watchdog container updates a Route 53 record
  with the task's new public IP once it's up.
- **Idle detection**: watchdog polls the game server locally; after ~10 min with no
  connection ever made, or ~20 min after last client disconnects (both configurable), it
  sets desired-count back to 0.
- **Shutdown sequencing**: Minecraft container saves on SIGTERM when Fargate stops the
  task; no explicit "backup then stop" pipeline beyond that.
- **Backstop**: none independent of the watchdog documented beyond "set up a billing
  alert" as an operator recommendation. This is a real gap other, later projects tried to
  close.
- Forks worth noting: `AndresArcones/minecraft-aws-ondemand`,
  `spacecowboysdev/cdk-minecraft-ondemand` (CDK port of the same architecture).

### 2. vatertime/minecraft-spot-pricing (and forks: gerhalt/mining-camp, Lemmons/minecraft-spot)
https://github.com/vatertime/minecraft-spot-pricing

- **Launch model**: CloudFormation launches a **Spot** EC2 instance that self-joins an ECS
  cluster running the Minecraft image; instance is explicitly ephemeral/disposable.
- **State**: none of the DB/tag kind — all persistent state (world save, config) lives on
  **EFS**, decoupled from the instance lifecycle entirely. This is the cleanest example of
  "compute is cattle, storage is separate and durable."
- **Idle/shutdown/backstop**: not specified in the README; the model relies on the owner
  manually stopping the CloudFormation stack / spot instance. No automated idle detection
  found in this lineage.
- Relevant only for the "ephemeral compute + persistent network storage" pattern, not for
  backstop design.

### 3. Valheim projects
- **samchungy/valheim-aws-spot-server** — Discord slash commands (`/valheim start|stop`)
  → API Gateway → Lambda → EC2 Spot instance. Backs up to S3 via GitHub Actions (not
  the instance itself). No automated idle detection documented; the README's only
  cost-safety note is "delete the Elastic IP config to save more money" — i.e. no
  backstop beyond human diligence.
- **briancaffey / cdk-valheim** (blog: https://briancaffey.github.io/2021/03/18/on-demand-dedicated-serverless-valheim-server-with-cdk-discrod-interactions/)
  — ECS Fargate, desired-count 0/1, controlled by Discord slash commands via API
  Gateway + Lambda (Flask/boto3 calling `update_service`/`describe_services`). Status is
  reported straight from `describe_services` (Desired/Running/Pending counts) — no
  separate state store. Explicitly **manual only**: the author calls out "no automatic
  shutdown safeguard if a user leaves the server running indefinitely" as a known gap,
  with scheduled scaling as a partial mitigation for predictable hours.
- **akolu/valheim-aws**, **samdammers/valheim-aws-template**, **omniphx/valheim-discord-server**
  — same Discord-bot-driven family (Terraform variants), same general shape: Lambda +
  API Gateway fronting a Discord bot, EC2 or Fargate behind it, S3 backups. None of the
  READMEs surfaced an independent backstop beyond manual/scheduled stop.

### 4. gstamp/factorio-server-aws, m-chandler/factorio-spot-pricing
https://github.com/gstamp/factorio-server-aws

- **Trigger**: Lambda + API Gateway exposes a plain URL; hitting it in a browser starts
  the server. This is the simplest possible "start" UX (no Discord dependency) and close
  to what a small webapp would do.
- **Launch model**: persistent EC2 instance (stop/start, not terminate/recreate) —
  inferred from "automatic shutdown behavior when not in use" phrasing (stop, not
  destroy).
- **Backstop**: explicitly **none**. The README disclaims: "If you use it, you are
  responsible for maintaining your setup and monitoring and paying for your AWS bill,"
  and "there are no guarantees it will work or continue working." This is a useful
  negative data point — a popular, still-cloned project ships with zero independent
  backstop.

### 5. feydan/satisfactory-server-aws
https://github.com/feydan/satisfactory-server-aws

- Same shape as the Factorio project: persistent EC2 instance, Lambda+API Gateway URL to
  start, automatic idle shutdown (mechanism undocumented in README), Elastic IP called
  out at "$0.001/hr or $3.60/mo if never used" (pre-Feb-2024 pricing; see IP section
  below for current numbers). Advertised cost: ~$5/month at 2 hrs/day usage. No
  independent backstop documented; billing-alert is the suggested mitigation.

### 6. Palworld projects — most directly relevant to this project's shape

**mhaslinsky/palworld-server** (Terraform, single-VM, Discord-gated) —
https://github.com/mhaslinsky/palworld-server — by far the most detailed and closest
analog to what DST-server-manager needs. Verified by fetching the raw README directly
(not just search snippets). Key patterns:

- **Launch model**: one **persistent** `t3.xlarge` EC2 instance (stop/start, not
  terminate/recreate). World data lives on a **separate EBS volume** (`prevent_destroy`,
  mounted by UUID, not by device name) so the instance itself is treated as disposable /
  rebuildable — root volume is "OS + SteamCMD only, reproducible from `user_data`."
  Three redundant copies of world state: the EBS volume itself, twice-daily DLM
  snapshots (retain 10), and 30-min S3 backups (the only genuinely off-box copy).
- **Start trigger / race-safety**: Discord slash command → Lambda, **Ed25519-signature
  verified** (standard Discord interactions security), whitelisted, calls
  `ec2:StartInstances` directly on a known, fixed instance id. Because there's exactly
  one instance id and `StartInstances` on an already-running instance is a no-op, this
  is naturally idempotent without needing a DynamoDB lock.
- **State tracking**: **no DynamoDB** — the instance pushes a player-roster to an **SSM
  Parameter Store** parameter (one-way, outbound only: the instance role can `PutParameter`
  but nothing external can reach into the box — no inbound port for the REST/RCON API,
  which binds to `127.0.0.1` only). The Discord bot and a separate monitor Lambda read
  that parameter. This is a clean, cheap "heartbeat" state channel: SSM Parameter Store
  standard parameters have no storage cost and API calls are cheap/free tier.
- **Idle detection**: systemd timer on the instance polls `localhost:8212` (game REST
  API) every 2 minutes; explicitly **fails open** — any error talking to the API counts
  as "players present," so a transient blip can never wrongly stop a live game. Tradeoff
  called out explicitly: a *broken* watcher also never stops the box and never
  complains — which is exactly why it's watched from off-box (next point).
- **Shutdown sequencing**: entirely local — after `idle_shutdown_minutes` (30) of zero
  players, the same systemd timer runs `shutdown -h now`. The instance has
  `instance_initiated_shutdown_behavior = "stop"`, so an in-guest OS shutdown becomes an
  **EC2 stop** (compute billing halts), not a terminate. No external scheduler needed for
  the happy path.
- **Independent backstop** (this is the most relevant part for our question): a
  **separate Lambda, on a 15-minute EventBridge schedule, running off-box**, checks two
  things independent of the on-instance idle script: (1) how long ago the roster SSM
  parameter was last written — if it's stale *while the instance is still running* (past
  a boot grace period), the idle watcher itself has died and the box is billing with
  nobody on it; (2) S3 backup freshness/integrity. Both alert to Discord, and the
  **monitor's own failures raise a CloudWatch alarm → SNS**, deliberately on a channel
  that doesn't depend on Discord (or the thing being monitored) being healthy. This
  watchdog was added reactively, after an incident where the local idle watcher died
  silently and the instance ran (and billed) with nobody on it.
- **Public IP**: **Elastic IP**, justified explicitly ("never changes between sessions");
  players "Join with IP" directly (`<eip>:8211`) — same connect-by-IP model DST would use
  via `c_connect`.
- **Idle-month cost breakdown given in the README** (us-east-1, compute stopped): 198 GB
  gp3 across 5 volumes ≈ $15.85, always-on `t4g.nano` presence bot ≈ $3.05, Elastic IP ≈
  $3.65, S3 backups ≈ $0.02, Lambda/EventBridge/SNS ≈ free tier → **floor ≈ $22.60/mo**
  even with compute at zero. Useful concrete counter-example: "scale-to-zero" compute
  does not mean "scale-to-zero total cost" — storage and a stable IP are recurring costs
  regardless of backstop design.

**JohnIAlbright/palworld-aws-terraform** —
https://github.com/JohnIAlbright/palworld-aws-terraform — verified via raw README.

- Persistent `t3.large` EC2, Elastic IP, S3 backups (versioned, 30-day lifecycle).
- **Monitoring**: CloudWatch alarms on CPU >85%, memory >85%, disk >80% (via CloudWatch
  Agent) for 15 min sustained → SNS email. This is resource-health monitoring, not an
  idle/cost backstop per se.
- **"Backstop"-shaped mechanism they do have**: a **nightly EventBridge Scheduler
  (recurring cron) → Lambda** that checks if the instance is running, uses **SSM Run
  Command** to stop the Palworld systemd service gracefully (let it flush world data),
  polls the SSM command result, then calls `ec2:StopInstances`. This is explicitly *not*
  a raw `shutdown -h` — it's an externally-orchestrated save→stop sequence, run from
  outside the instance. Notably this project does **not** appear to have per-session idle
  detection at all — it relies on "always stop it at night" rather than "stop N minutes
  after last player leaves." That's a materially different tradeoff (predictable nightly
  reset vs. true idle detection) and not what we want, but the "Lambda orchestrates SSM
  Run Command save-then-stop" sequencing pattern is directly reusable.

**Other Palworld auto-start/stop projects** (MonkeyStud-lab/kevinnio `palworld-monitor`,
`nomomo/PalWorld-Dedicated-Server-Auto-Start-Stop`) are host-local Python daemons meant
to run on the same box (or even a home PC) — no separate control plane, no backstop
beyond the on-box script. Not useful beyond confirming "poll player count locally, shut
down after N idle minutes" is the near-universal idle-detection pattern across every
game (Minecraft watchdog, Palworld systemd timer, generic scripts all converge on this).

## Cross-cutting patterns observed

- **Idle detection is always local, always poll-based**, reading each game's own
  API/RCON/log for player count, on a 1–5 minute cadence, with a naturally short (10–30
  min) grace timer. No project queries anything more exotic (no NetFlow/VPC Flow Logs
  analysis, no packet counting) — they just ask the game itself.
- **Shutdown sequencing splits into two families**: (a) in-guest `shutdown -h`/systemd
  path relying on `InstanceInitiatedShutdownBehavior=stop` to turn an OS shutdown into an
  EC2 stop (Palworld/mhaslinsky), simple, no extra IAM surface on the control plane; (b)
  externally-orchestrated SSM-Run-Command save-then-`StopInstances` from a Lambda
  (JohnIAlbright's nightly job, and implicitly ECS `desired-count=0` in the Fargate
  projects), which is more auditable/observable from outside but needs the control-plane
  Lambda to have SSM + EC2 stop permissions.
- **Independent backstops are rare and, where present, are homegrown**, not an
  off-the-shelf AWS feature wired up by these projects. Only one project in this survey
  (mhaslinsky/palworld-server) has a genuine off-box "is this idle script even alive"
  watchdog; most either have nothing beyond "set up a billing alert" (doctorray117,
  Factorio, Satisfactory, Valheim forks) or substitute a nightly forced-stop schedule for
  true idle detection (JohnIAlbright). **No surveyed project uses a CloudWatch
  missing-heartbeat alarm wired directly to an EC2 stop/terminate alarm action, and none
  uses a per-session EventBridge Scheduler one-shot max-lifetime schedule.** Both of
  those are documented AWS capabilities (see below) that nobody in this space has
  actually adopted — they're not exotic, just apparently not needed by hobby projects
  willing to eat an occasional billing surprise. For this project's "must not cost a
  month of EC2" hard requirement, we should build one of these rather than copy what's
  already out there.
- **State store**: nobody in this survey uses DynamoDB for instance-lifecycle state. The
  observed options are (a) EC2/ECS API state itself as the source of truth
  (`DescribeServices`/`DescribeInstances`, polled), (b) SSM Parameter Store for a
  one-way instance→control-plane heartbeat/roster (mhaslinsky), (c) nothing at all
  (Factorio/Satisfactory — status = "did the start URL 200"). DynamoDB shows up in the
  broader "start/stop EC2 on schedule" tooling space (e.g. generic scheduler lambdas
  keyed by tag) but not as a lock/idempotency mechanism in any of these game-server
  projects specifically.

## Answers to the specific questions

### 1. Launch model: fresh RunInstances vs stop/start persistent instance

Every game-server-specific project surveyed that uses raw EC2 (as opposed to Fargate)
uses **stop/start of one persistent instance**, not terminate+relaunch. Reasons visible
in these projects:

- **Boot time**: stop/start resumes from a stopped root volume in ~30–60s typically
  (skip OS/package install); a fresh `RunInstances` from a template must re-run
  user_data (install DST via SteamCMD, restore world from S3, etc.) which is the
  multi-minute path every project tries to avoid for a "click start, join in under a
  minute" UX.
- **State drift**: stop/start keeps the same instance id, same attached EBS volumes,
  same instance role — nothing to re-provision or re-attach. mhaslinsky's project
  explicitly treats the *root* volume as disposable/rebuildable but pins the *world*
  data to a separate persistent EBS volume precisely so a rebuild (if ever needed) is
  safe — i.e. even the projects most tolerant of instance replacement keep exactly one
  long-lived instance in the steady state.
- **Idempotency/race-safety**: with a single fixed instance id, "start" is trivially
  idempotent — `StartInstances` on an already-`running`/`pending` instance is a no-op,
  and `StopInstances` on an already-`stopped` instance is a no-op. No project needed a
  DynamoDB conditional-write lock or `ClientToken` dance because there's only ever one
  instance id to act on. `ClientToken` matters for `RunInstances` specifically (dedupe
  duplicate launches within the token's ~1hr window) — irrelevant if you never call
  `RunInstances` after initial provisioning.
- **Cost**: no material cost difference stop/start vs terminate/relaunch for EBS-backed
  instances — you pay for attached EBS either way, and compute billing stops the moment
  the instance isn't `running`, whether via `stop` or `terminate`. The real cost
  distinction is instance-store vs EBS root, not stop vs terminate.

**Recommendation for this project**: single persistent EC2 instance per world (or,
since only one world runs at a time, arguably a single reusable instance whose root
volume/user_data selects which world's save to mount — but that's a DST-specific
decision, out of scope here), stop/start lifecycle, `InstanceInitiatedShutdownBehavior=
stop`. Race-safety for "two people click start at once" or "start world B while A is
running" doesn't need a DynamoDB lock: (a) `StartInstances`/`StopInstances` are already
idempotent per-instance, and (b) the actual concurrency risk is the *orchestration*
(stop A, wait for it to fully stop, then start B) racing against a second click — that
needs a lock, and a DynamoDB item with a conditional `PutItem`/`UpdateItem` (attribute
doesn't-exist or status="idle") guarding a `desiredWorld` / `transition-in-progress` flag
is the standard, well-worn pattern for that (not instance-launch idempotency, but
orchestration-step idempotency). This is a control-plane concern, not something these
game-server projects needed to solve since they all have exactly one world/instance.

### 2. State machine & status reporting

No surveyed project has a rich state machine; they collapse to "is the instance/service
running" plus, in the best case (mhaslinsky), a one-way heartbeat.

Recommended cheap pattern (synthesized from what's out there, extended to cover our
extra states starting/joinable/stopping/player-count):

- **DynamoDB single-item state table** in the control-plane account/region (see Q7)
  holding `{ activeWorld, status: starting|running|stopping|stopped, instanceId,
  lastHeartbeatAt, playerCount }`, updated two ways:
  - **Control plane writes** `starting`/`stopping` transitions itself (it initiates
    them, it knows).
  - **Instance writes back** `running` + player count + heartbeat timestamp via its
    instance role, using `UpdateItem` directly (needs outbound network / VPC endpoint or
    NAT... see IP/network section) **or**, to avoid any need for the game-server subnet
    to reach DynamoDB, mirror mhaslinsky's approach and have the instance push to an
    **SSM Parameter Store** parameter instead (SSM has a public regional endpoint the
    instance can reach with just its public IP + no NAT, and IAM instance-role scoped
    write access) — then a tiny periodic (or on-parameter-change via EventBridge) sync
    isn't even needed: the web Lambda can call `GetParameter` cross-region directly
    instead of maintaining a mirrored DynamoDB row. That's simpler than mhaslinsky's
    split (they use SSM because Discord bot Lambdas already read AWS APIs anyway) and
    avoids a second source of truth.
  - Practically for this project: **DynamoDB item for orchestration lock/target state**
    (owned by the control-plane Lambda, since that needs conditional writes anyway) +
    **SSM Parameter for instance-reported heartbeat/player-count** (owned by the
    instance, one-way, no inbound access needed) is the cheapest combination that covers
    both the race-safety need (DynamoDB) and the "instance reports its own liveness
    cheaply without opening inbound ports" need (SSM), matching what mhaslinsky
    converged on after (per their README) an earlier "over-networked design" was
    rejected in review.
- **Web UI polling cost**: DynamoDB `GetItem` on a single-item table and/or SSM
  `GetParameter` are both effectively free at hobby scale (DynamoDB on-demand: first
  25GB storage free, request costs are fractions of a cent per thousand; SSM standard
  parameters: free). Polling every few seconds from a handful of friends' browsers via
  the existing Lambda is not a cost concern either way.

### 3. Backstop patterns — comparison

None of the surveyed projects combine more than one of these; mhaslinsky is the only one
with any off-box backstop at all (missing-heartbeat check via a 15-min-cron Lambda +
CloudWatch-alarm-on-monitor-failure, i.e. option (a) below, but checking an SSM
parameter's age rather than a native CloudWatch metric).

| Pattern | Idle-month cost | Independent of on-instance script? | Notes |
|---|---|---|---|
| **(a) EventBridge Scheduler recurring rule (e.g. every 10–15 min) → reaper Lambda** that checks instance uptime/tag/heartbeat age and force-stops if over a max lifetime or heartbeat stale | Effectively $0. EventBridge Scheduler gives 14M free invocations/month; a Lambda running every 10 min is ~4,300 invocations/month, trivially inside Lambda's perpetual free tier (1M req + 400,000 GB-s/month) | Yes — fully external, doesn't care if the on-instance script is alive or dead | Simplest to reason about; catches "instance stuck running" regardless of *why* (idle script crashed, hung, wrong region, whatever). Recommended primary backstop. |
| **(b) One-shot EventBridge Scheduler schedule created at start time**, `at(<launch+maxHours>)`, `ActionAfterCompletion=DELETE`, targets the reaper (or directly `StopInstances`) | ~$0 — one-time schedules cost the same per-invocation as recurring ones (no idle cost when no world is running, since the schedule only exists while a world is up and self-deletes after firing) | Yes, if it directly calls EC2 (not just re-checking the on-instance script) | This is a true "dead-man's max lifetime" and is arguably *more* independent than (a) because it doesn't require iterating "is this instance over its budget" logic each tick — it's created once, fires once. Slightly more moving parts: control-plane Lambda needs `scheduler:CreateSchedule` permission and must create/tear down the schedule as part of start/stop. Good as a belt-and-suspenders companion to (a), not a replacement — (a) also catches heartbeat staleness while an instance is still under its max-lifetime budget. |
| **(c) CloudWatch alarm on a metric, with an EC2 alarm action (stop/terminate)** — either a built-in metric (e.g. `NetworkIn`/`CPUUtilization` low for N periods) or a custom heartbeat metric published by the instance, with `TreatMissingData=breaching` | ~$0.10–$0.30/alarm/month while it exists (standard-resolution alarm on a 60s metric = $0.10/mo; AWS's own docs recommend `TreatMissingData=missing` — *not* breaching — specifically for alarms wired to EC2 stop/terminate actions, to avoid false-positive stops during e.g. a metrics-agent hiccup) | Mostly yes, but AWS's own guidance argues against using missing-data-as-breaching for actions that stop/terminate instances, which weakens this as a strict dead-man's switch unless paired with a real heartbeat metric and careful evaluation-period tuning | Doable but the AWS docs' own caution (treat missing data as `missing`, not `breaching`, for alarms with EC2 actions) means a naive "no heartbeat = terminate" alarm risks flapping unless you're careful. More fragile / more tunable knobs than (a). |
| **(d) `InstanceInitiatedShutdownBehavior=terminate` + in-guest dead-man timer** (`shutdown -h +N` scheduled at boot, refreshed by the idle script) | $0 | **No** — this lives on the instance and is exactly the "on-instance idle logic" the backstop is meant to be independent of; if the instance's OS/idle script is wedged, the `shutdown -h +N` timer it depends on is *also* wedged | Explicitly ruled out by the hard requirement — this is not independent, it's just a second copy of the same failure domain. |

**Recommendation**: combine **(a)** a cheap recurring reaper (every 10–15 min,
effectively free) as the primary backstop that checks wall-clock instance age (from a
launch-time tag or the DynamoDB item) against a hard max-session length (e.g. 6–8 hours)
and force-stops regardless of heartbeat state, **plus** using the *same* reaper
invocation to check heartbeat staleness (age of the SSM parameter / DynamoDB
`lastHeartbeatAt`) so a hung idle-script is caught quickly rather than waiting for the
max-lifetime ceiling. This gets you both signals from one Lambda and one schedule, for
effectively $0/month at idle (no alarms, no per-session schedule bookkeeping) and only
the trivial Lambda-invocation cost while a world is actually running. Skip (b) unless
you want tighter time resolution than the polling interval — for a 30-min idle timeout
and an ~8-hour max session, a 10-minute poll is plenty precise. Skip (c) given AWS's own
caution about missing-data-as-breaching on stop/terminate actions, and (d) is
disqualified by the independence requirement.

### 4. AWS Budgets

- **Cost**: budget *monitoring and notifications* (the basic case — get an email/SNS
  alert at a threshold, no automated action) are **free**, no limit mentioned beyond
  general account budget-count soft limits. **Action-enabled** budgets (ones configured
  to automatically apply an IAM/SCP restriction or stop resources) have **your first two
  free per month**, then $0.10/day each thereafter. For this project, a plain
  notification-only budget (email/SNS on threshold breach, no automated action) costs
  **$0**.
- **Scoping by tag**: `CfnBudget`'s `BudgetData.CostFilters` (or the modern `FilterExpression`)
  can filter by `TagKeyValue`/cost-allocation tag, e.g. `project$dst-server-manager` or
  `user:project` = `dst-server-manager`, so a budget can watch spend for just this
  project's tagged resources rather than the whole account.
- **Cost-allocation tag activation delay**: a **user-defined tag must be activated**
  (Billing console → Cost allocation tags → activate) before it can be used as a budget
  filter or seen in Cost Explorer. Timeline observed: up to 24h for a newly-used tag key
  to even appear as activatable, another ~24h to activate, another ~24h to show up in
  Cost Explorer/budget filtering — **budget for ~48–72h of lead time** between first
  applying `project=dst-server-manager` tags to resources and being able to build a
  tag-scoped budget around them. Practical implication: tag every resource (EC2 instance,
  EBS volumes, the CDK stack itself via stack-level tags) from day one, and activate the
  cost-allocation tag immediately, even before the budget is needed — don't wait until
  you want the budget to start tagging.
- **CDK support**: `aws-cdk-lib.aws_budgets.CfnBudget` is a straightforward L1 construct;
  no L2 exists as of current CDK. Fine for a simple cost/notification budget — this is a
  "write the L1 props by hand" case, not a blocker.

### 5. Spot vs on-demand for ~20 hrs/month, ~3-hour sessions

None of the raw-EC2 game-server projects surveyed that care about *reliability* during a
live session use Spot for the actual game instance in its final form — the Spot-specific
projects (vatertime/minecraft-spot-pricing and its forks, m-chandler/factorio-spot-pricing,
samchungy's Valheim spot server) are all early/hobbyist and none document any
interruption-handling logic (no 2-minute-notice listener, no automatic
save-and-relaunch). That's a real gap in those projects — if this project used Spot,
building interruption handling would be *net-new* work with no reference implementation
to lean on from this survey.

General findings on the 2-minute notice: it's real and technically enough time for a
"trap the interruption, force-save, exit cleanly" script (AWS's own best-practices blog
covers listening on the instance metadata endpoint for the interruption notice), but it
adds a distinct failure mode mid-session — a Spot reclaim during an active 3-hour DST
session mid-play would drop everyone with at best "server force-saved and everyone gets
disconnected," at worst a partial save if the handler doesn't finish in time.

**Recommendation: on-demand, not Spot.** At ~20 hours/month on a modest instance size
(DST dedicated server is CPU-light — even `t3.medium`/`t3.small` class is plenty), the
absolute dollar delta between Spot and on-demand for 20 hrs/month is low single digits
(a `t3.medium` on-demand in us-west-2 is roughly $0.0416/hr → ~$0.83/mo at 20 hrs; Spot
might save 50-70% of that, i.e. save under $0.60/month). That saving isn't worth taking
on interruption-handling complexity, the loss-of-session risk to friends mid-game, and
extra code paths in a project whose hard requirement is simplicity/safety, not minimum
dollar cost. Revisit only if instance size or hours-per-month grow enough that Spot
savings become more than pocket change — not the case here.

### 6. Public IP

- **Pricing reality (post Feb 1, 2024)**: AWS now charges **$0.005/hr for every public
  IPv4 address**, auto-assigned or Elastic, **whether attached to a running instance or
  sitting idle** — the historic "Elastic IP is free while attached, costs money only when
  idle" distinction is gone. The only real difference left: an **auto-assigned public
  IPv4 is released when the instance stops** and a new one is issued on next start (so it
  changes every session and costs $0 while stopped, since there's no address to bill),
  whereas an **Elastic IP persists and keeps costing $0.005/hr (~$3.65/mo) even while the
  instance is stopped**, unless you release it.
- **Given DST's connection model**: players either find the server via the Klei public
  lobby listing (which resolves by whatever IP the server reports to Klei's matchmaking
  service at boot — doesn't need a stable DNS name) or via direct `c_connect("ip", port,
  "password")`, which needs *some* current IP but not a stable one — the group can just
  be told the new IP each session (e.g., surfaced by the webapp reading the instance's
  current public IP from `DescribeInstances`/tags after boot, no DNS update required).
  Given that this project already has a webapp that friends check to start the world,
  that same webapp is the natural place to display the current public IP each session —
  there's no need to also push it through DNS.
- **Recommendation**: use an **auto-assigned public IPv4** (default VPC, public subnet,
  no Elastic IP). This avoids the ~$3.65/mo Elastic IP idle cost entirely (which,
  notably, is *exactly* the same as the idle EIP cost mhaslinsky's project pays and
  explicitly accepts as a tradeoff for IP stability) — a cost this project doesn't need
  to pay since the webapp can just surface the new IP each session. This directly
  supports the "nothing always-on / no idle cost floor" hard constraint better than any
  surveyed project's choice.
- **Route53-on-boot pattern**: doctorray117's minecraft-ondemand project is the only one
  found that updates a DNS record on boot (its watchdog container updates a Route53
  record with the new task IP so players always connect to a stable hostname). That
  pattern exists because ECS Fargate tasks get an unpredictable IP on every launch and
  Minecraft clients conventionally connect by hostname. For DST specifically — direct
  connect by IP is a normal, expected flow (`c_connect`), and the webapp is already the
  discovery mechanism — so **a Route53 update-on-boot is not worth the added Lambda
  permission surface (Route53 change-resource-record-sets) and moving part** here;
  displaying the current IP in the webapp is simpler and sufficient.

### 7. Cross-region control (Lambda in us-east-1, EC2 in us-west-2)

- **Lambda calling EC2 API in another region**: no gotcha — every AWS SDK client can
  target any region regardless of where the Lambda executes; doctorray117's own project
  is proof of a *forced* version of this same split (Route53 query logs only ship to
  us-east-1, so their trigger Lambda must live there, yet it starts Fargate tasks in
  whatever region the game server runs in). The only real costs are a few dozen ms of
  extra cross-region API latency (irrelevant for a "click start" UX) and needing IAM
  permissions/resource ARNs scoped to us-west-2 from a us-east-1-executing Lambda role
  (trivial — IAM is global).
- **Where should the DynamoDB state table live?** Put it in **us-west-2**, alongside the
  EC2 instance/network resources it describes, for two reasons: (1) if the instance
  itself ever needs to write to it directly (heartbeat via DynamoDB instead of/alongside
  SSM), same-region access avoids cross-region calls from inside the game-server VPC,
  which would otherwise need a NAT gateway or VPC endpoint (cost/complexity this project
  is explicitly trying to avoid) — a same-region DynamoDB **VPC Gateway Endpoint** is
  free and keeps that traffic off the public internet without a NAT. (2) The us-east-1
  Lambda reading/writing that table cross-region is cheap and fine regardless. If instead
  you go with the SSM-parameter-only heartbeat design (recommended in Q2), the instance
  never needs to reach DynamoDB at all — it only needs SSM's public regional endpoint
  (reachable via its own public IP, no VPC endpoint required) — which simplifies this
  further and makes the DynamoDB table's region a pure control-plane choice; us-west-2
  colocated with the EC2 resources it tracks is still the more conventional / easier to
  reason about choice (state lives next to what it describes), but us-east-1 alongside
  the web Lambda would also work with no real penalty.
- **Where should the reaper live?** us-west-2, colocated with the EC2 instance it acts
  on, for the same VPC-endpoint-friendliness reason (if it needs to check instance
  metadata/tags/security-group state via VPC-internal calls) and so its EventBridge
  Scheduler invocations don't depend on the us-east-1 stack being healthy — keeping the
  safety-critical backstop in the same region as the resource it polices, and
  independent of the primary control-plane region, is a reasonable interpretation of
  "independent of the on-instance idle logic" extended to "independent of the primary
  control plane's region too." No surveyed project actually splits regions this way (all
  of them keep control-plane and game-instance in one region), so there's no precedent
  to validate this against — flagging as this project's own design choice rather than
  something borrowed from prior art.

## Confidence and gaps

- High confidence on: stop/start-persistent-instance being the dominant, well-tested
  launch model; idle-detection being universally poll-the-game-locally; public-IPv4
  pricing equalization since Feb 2024; AWS Budgets pricing tiers; EventBridge
  Scheduler/CloudWatch-alarm pricing and mechanics.
- Lower confidence / not independently verified against primary AWS docs in this pass:
  the exact current (Sept 2026) EventBridge Scheduler free-tier invocation count and
  CloudWatch standard-alarm price ($0.10/mo figure is widely repeated but pull the
  current us-west-2 pricing page before finalizing a cost table for a design doc).
  Several READMEs (Satisfactory, Factorio, early Valheim forks) were thin on
  implementation detail — where a mechanism is described as "undocumented" above, that
  reflects genuinely sparse source material, not a search failure.
- Open question this survey doesn't resolve: whether a per-session one-shot
  EventBridge Scheduler max-lifetime schedule (Q3, option b) is worth its extra
  create/delete bookkeeping over just letting the recurring reaper's age-check handle
  max-lifetime too — no project in this survey uses either, so there's no real-world
  cost/complexity comparison to draw on; this is a judgment call for the design doc, not
  something the prior art settles.

## Sources

- https://github.com/doctorray117/minecraft-ondemand
- https://github.com/AndresArcones/minecraft-aws-ondemand
- https://github.com/spacecowboysdev/cdk-minecraft-ondemand
- https://github.com/vatertime/minecraft-spot-pricing
- https://github.com/gerhalt/mining-camp
- https://github.com/Lemmons/minecraft-spot
- https://github.com/samchungy/valheim-aws-spot-server
- https://briancaffey.github.io/2021/03/18/on-demand-dedicated-serverless-valheim-server-with-cdk-discrod-interactions/
- https://github.com/samdammers/valheim-aws-template
- https://github.com/akolu/valheim-aws
- https://github.com/omniphx/valheim-discord-server
- https://github.com/gstamp/factorio-server-aws
- https://github.com/m-chandler/factorio-spot-pricing
- https://github.com/feydan/satisfactory-server-aws
- https://github.com/mhaslinsky/palworld-server
- https://github.com/JohnIAlbright/palworld-aws-terraform
- https://github.com/MonkeyStud-lab/palworld-monitor
- https://github.com/nomomo/PalWorld-Dedicated-Server-Auto-Start-Stop
- https://docs.aws.amazon.com/scheduler/latest/APIReference/API_CreateSchedule.html
- https://aws.amazon.com/blogs/compute/automatically-delete-schedules-upon-completion-with-amazon-eventbridge-scheduler/
- https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/alarms-and-missing-data.html
- https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/UsingAlarmActions.html
- https://cloudonaut.io/dead-mans-switch-with-cloudwatch/
- https://aws.amazon.com/aws-cost-management/aws-budgets/pricing/
- https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/activating-tags.html
- https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_budgets.CfnBudgetProps.html
- https://aws.amazon.com/blogs/aws/new-aws-public-ipv4-address-charge-public-ip-insights (public IPv4 pricing change)
- https://aws.amazon.com/blogs/networking-and-content-delivery/identify-and-optimize-public-ipv4-address-usage-on-aws/
- https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/spot-instance-termination-notices.html
- https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/prepare-for-interruptions.html
- https://aws.amazon.com/blogs/compute/best-practices-for-handling-ec2-spot-instance-interruptions/
- https://aws.amazon.com/eventbridge/pricing/
- https://aws.amazon.com/cloudwatch/pricing/
