# dst-server-manager

On-demand Don't Starve Together server: `https://dst.ty.ler.dev` lets allowlisted friends (Steam
sign-in) start a world; that boots an ephemeral EC2 instance which stops itself when nobody is
playing. Idle cost is about $0.10/month. `docs/decisions.md` is the source of truth for the design.

**Built, deployed and verified.** All three stacks are live, every push to `main` deploys, the
real-AWS lifecycle test passes 45/45 in ~34-36.5 min, and `tylerni2026` has been booted (164 s to
joinable), played from the game client, and has stopped itself for idle unattended with its save
pushed to S3. Deliberately-open items are in `docs/follow-ups.md`. **The session recap (digest +
LLM "where you left off" summary, `docs/decisions.md` §18) is deployed** (2026-09-27): every
session's `manifest.json` triggers the digest Lambda, and all ten earlier tylerni2026 sessions were
backfilled ($0.19). What is still open is `docs/follow-ups.md` §13. **The per-player map**
(`docs/decisions.md` §19: each player's trail dilated 4 tiles, masked server-side, canvas under
the recap; a "Whose map" select shows any player's map, default the viewer's) **is deployed** (2026-09-27, digest-2; all eleven sessions re-digested with summaries
kept); its exact fog of war is `docs/follow-ups.md` §14.

## Invariants (do not break these)

**This repo is public.**
- Never commit: anything from the save zip, the Klei token, the cluster password, the
  session-signing secret, anyone's email, anyone's SteamID64. They live in SSM (see below) or S3.
- `scripts/check-secrets.sh` must pass before every push. Enable the hook once per clone:
  `git config core.hooksPath .githooks`. Check `git status` / what is staged before every push.
- Example config lines use placeholders, e.g. `cluster_password = <injected from SSM at boot>`.

**The AWS account (`063257577013`) hosts other production sites.**
- There is no default profile or region: every CLI call uses `AWS_PROFILE=admin` and an explicit
  `--region`; every CDK stack sets `env`. If credentials expire, stop and ask Tyler to run
  `! aws sso login --profile admin`.
- Never modify or delete anything this project did not create. Everything this project creates
  is tagged `project=dst-server-manager` (game instances and volumes via `TagSpecifications`).
- DNS: in the existing zone `Z038502736IM0QLQT7VFN` (imported by id), exactly three things —
  the `dst.ty.ler.dev` alias records, the ACM validation CNAME, and **one runtime-owned record,
  `play.dst.ty.ler.dev`** (an A record the supervisor points at the live instance and every stop
  sinks to `192.0.2.1`; never a CDK resource, so the stacks still own exactly two `RecordSet`s —
  `docs/decisions.md` §17). The instance and reaper roles are IAM-scoped to that one name and type
  via `route53:ChangeResourceRecordSetsNormalizedRecordNames`, so "never touch another record" is
  enforced, not just intended. Never create a hosted zone. The GitHub OIDC provider already
  exists: import it, never create it.
- Do not re-bootstrap CDK (us-east-1 v30 and us-west-2 v18 are sufficient).
- Human-managed SSM parameters are never CDK resources: `/dst/klei-token`,
  `/dst/cluster-password`, `/dst/anthropic-api-key` (us-west-2; optional — without it recaps are
  written with the summary marked unavailable), `/dst/users`, `/dst/session-secret` (us-east-1).

**Scale to zero.** No NAT gateway, ALB, idle Elastic IP, RDS, persistent EBS, or anything
always-on. No SSH / port 22; debug with SSM Session Manager. Web stack in us-east-1, game
instance in us-west-2 (x86_64 only; Klei ships no ARM build).

**Cost safety.** A bug must not be able to cost a month of EC2. Never weaken the backstops: the
reaper Lambda, the on-instance dead-man shutdown, terminate-on-shutdown, the tag-scoped budget.
A session must also be able to **end itself**: the supervisor releases its own `desiredWorldId`
(the write S8) on any stop it decides on alone, or the final `stopped` write can never succeed and
the world restarts itself indefinitely. Do not remove it.

**The save is precious.** Stop order is always: DST saves -> save pushed to S3 -> instance
terminates. Backups are S3 versions of `worlds/<id>/save.tar.zst`; deletes are denied by bucket
policy; `seed/` is never modified. The recap digest reads saves and writes only
`sessions/<w>/<s>/digest/*`. Automated tests only ever touch worlds whose id starts with
`test-`, never `tylerni2026`. One world runs at a time (single Klei token).

**Measured facts that contradict the internet** (from `docs/spikes/game-server-spike.md`):
player count is `max(master.clients, caves.clients, master.allplayers + caves.allplayers)` and
never `shard_players:GetNumPlayers()` (it never decays); `c_shutdown(true)` does not cascade to
Caves and the process hangs until its stdin FIFO is closed after `Shutting down`; save tarballs
must exclude `save/server_temp`, `save/client_temp`, `save/cached_userid`; CloudFront OAC to a
Lambda Function URL needs `lambda:InvokeFunction` in addition to `lambda:InvokeFunctionUrl`, and
POSTs must be bodyless (or send `x-amz-content-sha256`).

**Measured facts learned while building it** (each cost a debugging round; the linked section has
the evidence):
- A hand-written `leveldataoverride.lua` must be a **complete** level definition or worldgen dies
  clause by clause and the shard never writes a `save/`. Generated clusters name a **preset** in
  `<Shard>/worldgenoverride.lua` (`SURVIVAL_TOGETHER` / `DST_CAVE`) — `docs/game-server.md` §5.
- DST mirrors the live settings — **password included** — into its own per-shard
  `<Shard>/save/shardindex`, so `cluster.ini` is not the only copy on disk. It is **blanked, never
  excluded**: a shard whose `save/` has no index reads as an empty slot and DST would generate a new
  world over the restored one — `docs/storage.md` §6.
- A stop the supervisor decides on itself (idle, crash) must **release its own desire** (the write
  S8) before the final `stopped` write, or that write's condition can never hold and the world
  restarts itself forever — `docs/control-plane.md` §2, `docs/game-server.md` §8.
- systemd fires `OnFailure=` on **every** failed start, not only past the start limit, so
  `dst-panic.service` must wait for the retry before powering the instance off —
  `docs/game-server.md` §6.
- `rm -f` + `mkfifo` is a race; losing it hands the server a **regular file** as stdin and the world
  boots perfectly and can never become joinable. Both `dst-shard` and `dst-console` guard it —
  `docs/game-server.md` §6.
- A fresh `steamcmd`'s first `app_update` fails with exit 8 / `Missing configuration`, so
  `dst-install-binaries` bootstraps in its own invocation and retries 3× —
  `docs/game-server.md` §4.
- IAM identifies a **public** AMI by an ARN with an **empty account field**, so the API role needs
  `arn:aws:ec2:us-west-2::image/*` — `docs/control-plane.md` §7.
- GitHub issues an **immutable** OIDC subject for this repo (numeric owner/repo ids); the classic
  `repo:<owner>/<repo>:ref:...` form is never presented — `docs/decisions.md` §12.
- There is **no browser -> Steam -> DST auto-connect deep link**, so do not go looking again:
  `steam://connect` works only for the Source titles Valve registered a handler for, Steam
  deliberately ignores arguments passed through `steam://run/<appid>//<args>`, and the DST client
  has no join launch parameter (no `connect_lobby`/`auto_connect` in the game scripts). The page
  offers `steam://run/322330`, which launches the game and nothing more; the join itself is the
  saved `c_connect("play.dst.ty.ler.dev", ...)` or Browse Games — `docs/decisions.md` §17.
- A DNS write must never be able to block a boot or a stop: every Route 53 call in this repo is
  wrapped and logged (`join_dns_failed`), and the sink lives in the supervisor's single `haltNow`
  — `rg 'host\.shutdownNow' packages/supervisor/src` matching only there is what proves every halt
  sinks the record while an in-place switch (same instance, same IP) does not.
- The recap parses saves with **wasmoon** (0.32 s / 156 MB on the 4 MB world file; fengari 3.1 s /
  525 MB), in an empty Lua environment. `map.nodeidtilemap` values are **1-based** into
  `topology.ids` (0 = sea). The boot calendar line is **tab**-separated (`setting\tcycles\t52`).
  Save version ids can start with `.` — zsh globs skip them. A **generated** world's first slot
  has an empty meta (`{clock={},seasons={}}`) and is skipped, not a format error. Recap fixtures
  are always synthetic; real-session summaries never enter the repo — `docs/decisions.md` §18.
- The in-game map is drawn by the camera: screen-down `= (cos h, sin h)` and screen-right
  `= (−sin h, cos h)` in world `(x, z)`, default heading **h = 45°** (`followcamera.lua`). Plotting
  tile x→right, z→down is a **mirror image** that no rotation fixes. The heading (Q/E) is
  client-only and never visible to the server, so the web map opens at 45° with rotate buttons —
  `docs/decisions.md` §19.
- Measured timings: click-to-joinable **333 s cold, 142-164 s warm**; idle deadline to `stopped`
  **49 s**; in-place switch 30-81 s; a full lifecycle run 34-36.5 min, 45/45;
  one digest 15 s / 396 MB and ~$0.02 of LLM.

**Shell and gate gotchas.** Tyler's shell is **zsh**, which does **not** word-split an unquoted
`$VAR` — the bash idiom `R='--region us-west-2'; aws ... $R` passes one argument and fails. Runbooks
use `R=(--region us-west-2)` + `"${R[@]}"`, or a shell function. And `pnpm check` passing locally is
necessary, not sufficient: a local import can resolve from outside the repo (`~/node_modules`), so
**CI is the authority** — `docs/follow-ups.md`.

## Git workflow

- Work directly on `main`. No branches, no PRs. Commit small and often; push often.
- Every push to `main` deploys (`.github/workflows/deploy.yml`), so `main` must always be
  deployable: run `pnpm check` before pushing.
- Annotated tags mark milestones (`git tag -a <name> -m ... && git push origin <name>`). Pushed so
  far: `plan-complete`, `exec-start`, `scaffold`, `local-green`, `infra-deployed`, `first-boot`,
  `lifecycle-verified`, `ci-live`, `real-world-verified`.
- Commit messages end with the `Co-Authored-By` line when Claude wrote the change.
- **After a push, wait for *that commit's* run, selected by `headSha`** — never
  `gh run list --limit 1`, which latches onto the previous completed run and reports its conclusion
  as if it were the new deploy's. The one correct loop is in `docs/infra.md` §6.

## Commands

`pnpm check` (lint, typecheck, unit tests, build, e2e) · `pnpm dev` (local API with in-memory
fakes + Vite) · `pnpm e2e` · `AWS_PROFILE=admin pnpm lifecycle-test` (real AWS, `test-*` worlds
only, never while someone is playing — it also points the shared `play.dst.ty.ler.dev` at a test
world for ~10 min) · `scripts/check-secrets.sh` ·
`AWS_PROFILE=admin bash scripts/clean-account-check.sh` (proves nothing stray is left in the
account; 19 PASS lines, exit 0) · `pnpm tsx scripts/digest-session.ts` (one session's recap;
`--from-dir` offline) · `pnpm tsx scripts/backfill-recaps.ts` (all sessions, dry run unless
`--write`) · `pnpm tsx scripts/recap-prompt-lab.ts` (compare summary prompts on real sessions,
output outside the repo) · `pnpm tsx scripts/gen-recap-data.ts` (regenerate the placeable/names
table from the game's scripts) · `AWS_PROFILE=admin pnpm tsx scripts/mint-guest-link.ts --label <name>`
(a read-only guest link, `docs/auth.md` §12).

**Every script in `scripts/` answers `--help` before any credential check or AWS call** — that is
the authoritative flag list, so run it rather than trusting a doc: `import-world.ts`,
`lifecycle-test.ts`, `mint-cookie.ts`, `mint-guest-link.ts`, `clean-account-check.sh`, `digest-session.ts`,
`backfill-recaps.ts`, `recap-prompt-lab.ts`, `gen-recap-data.ts`.

## Small follow-up iterations

Clear `packages/infra/cdk.out` before any real `diff`/`deploy` (`rm -rf packages/infra/cdk.out &&
pnpm build`); stale fixture assets otherwise defeat the bundle greps of `docs/testing.md` §3.

**Add a world.** One script does the registry item and the S3 side in one pass. Never while someone
is playing; ids are `[a-z0-9-]{1,32}` and `test-` ids need `--source test`.

```bash
AWS_PROFILE=admin pnpm tsx scripts/import-world.ts --world-id <id> --zip ~/Downloads/<cluster>.zip
```

It reads `serverName` and `hasCaves` out of the zip's `cluster.ini`/`Caves/`, uploads the untouched
zip to `seed/<id>/`, builds `worlds/<id>/save.tar.zst`, and writes the `pk=WORLD` item. Without
`--zip` it writes no S3 object, `--display-name` and `--server-name` become required, and the
supervisor **generates** the world from templates on first boot — a path v1 only exercises for
`test-*` worlds. Run `pnpm tsx scripts/import-world.ts --help` for every flag; the S3 half is
`docs/storage.md` §7, the registry half `docs/control-plane.md` §9.

**Add or remove a friend.** One SSM parameter, no deploy; takes effect within 60 s. Send the whole
map — it is a full overwrite — and never commit it. Exact command and how to find a SteamID64:
`docs/auth.md` §10.

**Share with a guest.** Someone not on `/dst/users` can look but not touch: they see worlds,
status, recaps and maps, never the password; every write is 403 `read_only`. One command prints
the link (default 7 days, max 30; never commit or paste it anywhere public):
`AWS_PROFILE=admin pnpm tsx scripts/mint-guest-link.ts --label <name> [--days <n>]`. No per-link
revocation — it expires; the emergency switch is rotating the session secret, which also signs
members out (`docs/auth.md` §12.5, `docs/decisions.md` §20).

**Change the instance type.** `INSTANCE_TYPE` in `packages/shared/src/constants.ts` is the single
definition (`m6i.large` is the upgrade if a world outgrows 4 GiB; x86_64 only — Klei ships no ARM
build). Editing it changes the launch template, so the next deploy creates a new template version
and `RunInstances` picks it up via `Version: '$Latest'`. Two places name the literal and must change
with it: the CDK assertion in `packages/infra/test/game-stack.test.ts` (item 6 of `docs/infra.md`
§7) and the cost table in `docs/decisions.md` §14. `scripts/lifecycle-test.ts` asserts against the
shared constant, so it needs no edit. Then `pnpm check` and push.

**Where the runbooks are.** Disaster recovery (list/restore/roll back a save, recover from
`inflight/`, rebuild from the seed): `docs/storage.md` §10. Friends, SteamIDs, rotating the session
secret: `docs/auth.md` §10. Debugging a live instance over SSM Session Manager, and the three usual
causes of a stuck boot with the log line to grep for each: `docs/game-server.md` §13. Post-deploy
verification: `docs/infra.md` §9. Starting the real world from the CLI: `docs/testing.md` §5.

## Docs

| Doc | Read it when you touch |
|---|---|
| `docs/decisions.md` | anything: every settled decision, names, state schema; §18 the session recap |
| `docs/game-server.md` | `packages/supervisor`: boot, DST processes, idle detection, stop sequence |
| `docs/control-plane.md` | `packages/shared`, `packages/api`: state machine, API, launcher, reaper |
| `docs/auth.md` | Steam OpenID verifier, sessions, allowlist, CSRF; add/remove a friend |
| `docs/storage.md` | S3 layout, backups, world import, **disaster-recovery runbook** |
| `docs/web.md` | `packages/web`, `e2e/` |
| `docs/infra.md` | `packages/infra`, the deploy workflow, DNS, budget |
| `docs/testing.md` | verification strategy, the real-AWS lifecycle test, clean-account check |
| `docs/follow-ups.md` | everything deliberately left open, each with the command that closes it |
| `docs/research/`, `docs/spikes/` | evidence behind the decisions (**read-only history** — never rewritten, even where a value was later corrected) |
