# DST on-demand server: planning session

You are the **planning session**. Your deliverables are `PLAN.md` plus the context files a
separate, clean Claude session needs to execute it. Do not build the product here. Research,
spike, settle every decision with me, then write the plan.

## Goal

I play Don't Starve Together with friends on weak laptops, so we need a hosted dedicated
server. I want a small webapp at `https://dst.ty.ler.dev` where an allowlisted friend signs
in, sees a list of "worlds", and starts one. Starting a world boots an EC2 instance running
the DST dedicated server for that world. The instance shuts itself down when nobody is
playing. While idle, the whole stack should cost close to nothing.

## Verified facts (checked 2026-09-19, don't re-derive)

- **AWS**: account `063257577013`, `AWS_PROFILE=admin` (SSO, admin). There is no default
  profile and no default region: every CLI call needs the profile and an explicit `--region`,
  and every CDK stack sets `env` explicitly. If credentials expire, stop and ask me to run
  `! aws sso login --profile admin`.
- The account hosts other production sites. Never modify or delete anything this project did
  not create. Tag everything `project=dst-server-manager`.
- A GitHub OIDC provider (`token.actions.githubusercontent.com`) **already exists** in the
  account. Import it, never create it.
- CDK bootstrap: us-east-1 is v30, us-west-2 is v18. Check whether v18 is new enough for the
  CDK version you pick. Re-bootstrapping is fine, but tell me first. Both regions have a
  default VPC.
- Route 53: the public zone `ty.ler.dev` is in this account (`Z038502736IM0QLQT7VFN`).
- Repo: `git@github.com:tylerschloesser/dst-server-manager.git`. It is **public**, empty, and
  has no commits yet. `gh` is authenticated. Pushes go over SSH, so workflow files push fine.
- Local: node 22.18, pnpm via corepack (pin `packageManager`), no global `cdk` (make it a
  devDependency).
- **The save**: `~/Downloads/dst-tylerni2026.zip` (9.8 MB, 66 MB unzipped). Cluster
  `TylerNi2026`, Master + Caves shards, survival, 6 players, no mods, password-protected,
  `pause_when_empty = true`, `max_snapshots = 6`. UDP ports: 10999 (Master) and 10998 (Caves);
  clients connect to **both** directly. Steam ports are 27016/27017. Klei ships no ARM build,
  so the instance must be x86_64.
- The zip also contains a `README.md` and `scripts/` written for a *different* hosting
  approach (one long-lived instance, world on its EBS root, `screen`). Read them as hints and
  prior art, **not as requirements**.
- The zip contains secrets: `cluster_token.txt` (a Klei credential) and `cluster_password`
  in `cluster.ini`. Nothing else is using that token right now.

## Decisions already made

- Standalone TypeScript CDK in a pnpm monorepo. Vite + React webapp.
- Web stack in **us-east-1** (the CloudFront cert lives there). Game EC2 in **us-west-2**.
- **Public repo, so nothing sensitive is ever tracked.** The sign-in allowlist lives in an
  SSM parameter that I edit with one CLI command. SteamID64s are public identifiers, so if
  hardcoding them is meaningfully simpler, propose it in design review and I'll decide.
  Emails are never tracked. The Klei token is an SSM SecureString. Saves and backups go to
  S3. Never commit the save, the token, the cluster password, a session-signing secret, or
  anyone's email. Add `.gitignore` guards and a secret check that runs before anything is
  pushed.
- Scale-to-zero only: no NAT gateway, no ALB, no idle Elastic IP, no RDS, nothing always-on.
  Public subnet of the default VPC is fine. No SSH and no port 22; use SSM Session Manager
  for debugging.
- Auth: **"Sign in with Steam" is my preferred option.** We all own DST on Steam, and it
  needs no app registration. Steam uses OpenID 2.0, not OIDC, so Cognito can't federate it.
  Expect a small Lambda that verifies the assertion and issues our own session cookie. Naive
  Steam OpenID implementations have a history of auth-bypass bugs, so research the known
  pitfalls (the `check_authentication` round trip, strict `claimed_id`, `return_to` and
  `op_endpoint` validation) and put the fix for each into the plan. The allowlist is then a
  list of SteamID64s. Showing who started a world by persona name needs a free Steam Web API
  key; tell me if that's worth it. Fall back to Google-only sign-in (we all have Google, so
  skip Apple) only if Steam turns out to be meaningfully worse, and tell me why.
- I don't want to write CSS. Research a React component library with good defaults. It
  should be usable from a phone.
- Any allowlisted user can start or stop any world. There are no roles.

## Requirements

**Worlds**
- A world is a DST cluster directory. The first world is the zip above. I want this to stay
  flexible as I add worlds (most will have caves). A hardcoded world registry is fine. Tell
  me whether generating a brand-new world from the UI is feasible and what it would take.
- Only one world runs at a time, because my Klei token likely allows one server. Starting
  world B while A is running first stops A **gracefully** (save, back up, stop), then starts
  B. Start and stop must be idempotent and safe if two people click at once.
- The server must update DST on boot, or guarantee it is current some other way. Clients
  auto-update through Steam and cannot join a stale server.

**Lifecycle**
- "Idle" means zero connected players. Shut down after 30 continuous idle minutes. The clock
  starts when the server becomes joinable, so a fresh start with no joins lives about 30
  minutes. Work out how to detect player count reliably, and validate it in a spike.
- Shutdown order: DST saves (`c_shutdown(true)`), then the backup to S3 completes, then the
  instance stops or terminates. The UI has a stop button, though I don't expect to use it.
- Add a backstop that does not depend on the on-instance idle logic: something that kills a
  project instance that has run too long or stopped reporting, plus an AWS Budget alert.
  A bug must not be able to cost me a month of EC2.

**Storage and backups**
- Propose the simplest and cheapest storage for world saves (for example, S3 with an
  ephemeral instance versus a persistent EBS volume). Include what each option does to the
  time from clicking start to the server being joinable. A few minutes is acceptable. Show
  me the tradeoff.
- Back up before each start and after each stop. DST has its own rollback, so nothing more
  aggressive is needed. Prune old backups, but never the latest one for a world. No
  automated restore; I'll fix disasters by hand, so document where things live.
- Upload the original zip once to a seed location that is never mutated.
- Persist each session's server logs and `server_chat_log.txt` to S3. I'll probably add an
  LLM session summary later. Design for that, but don't build it.

**Webapp**
- World list. Per-world status (stopped, starting, running, stopping). Start and stop. While
  a world is running, show how to join (server name and IP), the player count if it is cheap
  to get, and the time until auto-stop.
- Sign-in is checked against the allowlist on the server side.

**Deploy**
- A simple GitHub Actions deploy on push to `main`, using OIDC. Scope the role's trust to
  this repo and to `main`.
- DNS: **no delegated zone.** CDK writes the `dst.ty.ler.dev` records (the CloudFront alias
  and the ACM validation CNAME) straight into the existing `ty.ler.dev` zone, imported by id
  with `HostedZone.fromHostedZoneAttributes`. Do not create a hosted zone, and never touch
  any other record in that zone, because it serves other production sites.

## Delegation: you orchestrate, sub-agents do the reading

This session runs on Fable. Your context is the scarce resource, so spend it on synthesis,
decisions, the design review with me, and PLAN.md. Everything that involves reading a lot
(web pages, docs, the save zip, CLI output, logs) goes to a sub-agent via the Agent tool with
an explicit `model`.

- **Model choice.** `sonnet` for bounded work with a clear question: surveys, prior-art
  collection, pricing lookups, inspecting the zip, checking the CDK bootstrap version
  requirement. `opus` for work that needs judgment or carries risk: the Steam OpenID security
  research, the storage tradeoff, running the AWS spike, drafting domain docs. Never spawn a
  fable sub-agent in this session. When unsure, use opus.
- **Files are the channel, not chat.** Every sub-agent writes its full findings, with source
  URLs, to a file you name up front (`docs/research/<topic>.md`, `docs/spikes/<name>.md`).
  Its final message back to you is at most 15 lines: the recommendation, the key numbers,
  its confidence, open questions, and the file path. Say this in every brief. Do not read
  the full file unless a decision depends on a detail the summary lacks, and then read only
  that part.
- **Don't do the research yourself.** No WebSearch, WebFetch, unzipping, or log reading in
  the main session. If a summary leaves a gap, send a follow-up to the same agent
  (SendMessage) or spawn a narrow new one. Once you delegate a question, don't also
  investigate it.
- **Briefs are self-contained.** Sub-agents start with zero context. Each brief states the
  question, why it matters to this project, the relevant lines from "Verified facts" and
  "Decisions already made" (copy them in, don't reference this file), what is out of scope,
  the output path, and the return format. Any brief that touches AWS also carries: the
  profile and region rules, the `project=dst-server-manager` tag, and "never modify anything
  this project did not create". Any brief that touches the zip also carries: never print,
  log, or write the Klei token or cluster password anywhere, and never copy zip contents
  into the repo.
- **Sub-agents can't talk to me.** If one hits expired credentials or needs a human decision,
  it stops and reports back, and you ask me.
- **Parallelism.** Launch independent agents in a single message. Research topics are
  independent. Anything that boots DST with my Klei token is **not**: one server at a time.
- **You commit.** Sub-agents write files but never run `git add`, `commit`, or `push`. You
  check what is staged and push (see Git workflow).

## How to run this session

1. **Research**, one sub-agent per topic, all launched in parallel:
   - prior art for running DST dedicated servers: steamcmd, Docker images, update-on-boot,
     how the zip's `README.md` and `scripts/` do it (sonnet);
   - on-demand game-server projects on AWS and their lifecycle/backstop patterns (sonnet);
   - player-count and idle detection for DST, with candidate signals to spike (opus);
   - Steam OpenID 2.0 sign-in: known auth-bypass bugs and the fix for each, session cookie
     design, whether the Web API key is worth it, and the comparison with Google (opus);
   - React component library with good defaults that works on a phone (sonnet);
   - storage options and their effect on time-to-joinable, plus itemized pricing inputs for
     the cost table (opus);
   - dynamic world generation from the UI: feasibility and what it would take (sonnet);
   - CDK version choice and whether us-west-2 bootstrap v18 is new enough (sonnet).

   Chat context does not survive into the execution session, so the files in
   `docs/research/` are the record. Commit them as they land.
2. **Spike** on real AWS wherever a measured fact beats a forum post. From the research
   summaries, write a spike spec (what to measure, how, instance sizes to try), then hand it
   to **one opus sub-agent** that owns the spike end to end: boot the server from a *copy* of
   my save, measure time to joinable, RAM and instance-size fit, the update-on-boot cost,
   and the idle-detection signal, tag everything, write `docs/spikes/`, and tear it all down.
   It returns the measured numbers and a list of every resource it created and deleted.
   Then **you** run the tag-based check that proves the account is clean, in both regions,
   and show me the output. That check is small, and it should not be done by the agent that
   made the mess.
3. **Design review with me before writing the plan.** This happens in the main session,
   built from the sub-agent summaries. Present:
   - the architecture;
   - every decision you made and why;
   - the items I asked you to propose (storage, auth, UI library, idle detection, dynamic
     world generation);
   - an **itemized monthly cost** for an idle month and for a month with about 20 hours of
     play;
   - everything that needs a human, such as our SteamID64s for the allowlist, a Steam Web
     API key, or an OAuth client if we fall back to Google.

   Collect those human inputs from me now so the execution session never blocks. Ask me
   anything that is still open. PLAN.md must contain zero open decisions.
4. **Write the files**:
   - First, you write `docs/decisions.md`: every settled decision from the design review,
     the human inputs I gave you (non-secret ones only), and one line of rationale each.
     Commit it immediately. It is the source of truth for the sub-agents below and your
     recovery point if this session compacts.
   - `docs/<domain>.md`, one per domain, referenced from `CLAUDE.md`. Drafted by opus
     sub-agents in parallel, one per domain, each reading `docs/decisions.md` plus the
     relevant research and spike files. Disjoint files.
   - `CLAUDE.md`, kept thin: invariants only. You write it.
   - `PLAN.md`. You write it. This is what your context was saved for.
   - Last, a fresh opus sub-agent reviews PLAN.md cold, as the execution session would see
     it: is every task executable with zero chat context, do the referenced docs exist and
     agree with the plan, are all acceptance criteria runnable commands, is there any open
     decision left? It returns a list of defects. Fix them.

   Commit and push as you go (see Git workflow).

## Git workflow (this session, the execution session, and `CLAUDE.md`)

- Work directly on `main`. **No branches, no PRs.** Commit small and often, and push often.
- Create annotated tags at important milestones and push them. Examples: `plan-complete`,
  then in execution `infra-deployed`, `first-boot`, `lifecycle-verified`, `v1.0.0`. PLAN.md
  names the tag each phase ends with.
- The repo is public, so the very first commit includes the `.gitignore` guards. Check what
  is staged before every push. Nothing from the save zip is ever added.
- Once the deploy workflow exists, every push to `main` deploys. The plan must account for
  that. Keep `main` deployable from that point on, and order the phases so a half-built
  stack is never pushed.
- Record this workflow in `CLAUDE.md` so it holds for my later iterations too.

## What PLAN.md must be

- It is executed by one clean Opus session via `@PLAN.md`, acting as a thin orchestrator. It
  dispatches sonnet sub-agents for as much as possible and keeps its own context small. It
  verifies by running commands, not by reading the code sub-agents produce.
- Sub-agents start with zero context, so every task is self-contained and lists:
  - its id, model and dependencies;
  - whether it can run in parallel with other tasks;
  - which docs to read;
  - which files it owns;
  - acceptance criteria written as runnable commands with expected results.
- Progress is recorded in the repo (checkboxes or a progress file). It is committed and
  pushed to `main` after every task, and each phase ends with a milestone tag, so execution
  can resume after compaction or a restart. Sub-agents working in parallel own disjoint
  files. The orchestrator does the committing.
- Anything needing a human that you couldn't collect during design review goes in Phase 0,
  batched.
- **Everything built is verified, and the verification steps are part of the plan:**
  - Local checks that need no AWS credentials: lint, typecheck, unit tests, build, and
    Playwright against the local app. Solve how Playwright gets past sign-in *without*
    putting a backdoor in production. With our own session cookie, a test-only signing
    secret should be enough. Unit-test the Steam assertion verifier against forged and
    replayed responses.
  - A lifecycle test on real AWS after deploy, run against a throwaway world with a
    shortened idle timeout. It covers: start, server joinable, pre-start backup exists, idle
    shutdown, instance gone, post-stop backup exists, world switch, backup pruning, and the
    backstop.
  - One final boot of the real world.
  - A last manual step for me: join from the game client.
- My real save is never at risk during testing.
- Final phase, run by an opus or fable sub-agent:
  - delete `PROMPT.md` and `PLAN.md`;
  - bring `CLAUDE.md` and `docs/` in line with what was actually built;
  - confirm no spike or test resources remain;
  - leave the repo ready for small follow-up iterations by me.
