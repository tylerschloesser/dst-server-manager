# dst-server-manager

On-demand Don't Starve Together server: `https://dst.ty.ler.dev` lets allowlisted friends (Steam
sign-in) start a world; that boots an ephemeral EC2 instance which stops itself when nobody is
playing. Idle cost is about $0.10/month. `docs/decisions.md` is the source of truth for the design.

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
- DNS: only the `dst.ty.ler.dev` alias records and the ACM validation CNAME, written into the
  existing zone `Z038502736IM0QLQT7VFN` imported by id. Never create a hosted zone; never touch
  another record. The GitHub OIDC provider already exists: import it, never create it.
- Do not re-bootstrap CDK (us-east-1 v30 and us-west-2 v18 are sufficient).
- Human-managed SSM parameters are never CDK resources: `/dst/klei-token`,
  `/dst/cluster-password` (us-west-2), `/dst/users`, `/dst/session-secret` (us-east-1).

**Scale to zero.** No NAT gateway, ALB, idle Elastic IP, RDS, persistent EBS, or anything
always-on. No SSH / port 22; debug with SSM Session Manager. Web stack in us-east-1, game
instance in us-west-2 (x86_64 only; Klei ships no ARM build).

**Cost safety.** A bug must not be able to cost a month of EC2. Never weaken the backstops: the
reaper Lambda, the on-instance dead-man shutdown, terminate-on-shutdown, the tag-scoped budget.

**The save is precious.** Stop order is always: DST saves -> save pushed to S3 -> instance
terminates. Backups are S3 versions of `worlds/<id>/save.tar.zst`; deletes are denied by bucket
policy; `seed/` is never modified. Automated tests only ever touch worlds whose id starts with
`test-`, never `tylerni2026`. One world runs at a time (single Klei token).

**Measured facts that contradict the internet** (from `docs/spikes/game-server-spike.md`):
player count is `max(master.clients, caves.clients, master.allplayers + caves.allplayers)` and
never `shard_players:GetNumPlayers()` (it never decays); `c_shutdown(true)` does not cascade to
Caves and the process hangs until its stdin FIFO is closed after `Shutting down`; save tarballs
must exclude `save/server_temp`, `save/client_temp`, `save/cached_userid`; CloudFront OAC to a
Lambda Function URL needs `lambda:InvokeFunction` in addition to `lambda:InvokeFunctionUrl`, and
POSTs must be bodyless (or send `x-amz-content-sha256`).

## Git workflow

- Work directly on `main`. No branches, no PRs. Commit small and often; push often.
- Every push to `main` deploys (`.github/workflows/deploy.yml`), so `main` must always be
  deployable: run `pnpm check` before pushing.
- Annotated tags mark milestones (`git tag -a <name> -m ... && git push origin <name>`).
- Commit messages end with the `Co-Authored-By` line when Claude wrote the change.

## Commands

`pnpm check` (lint, typecheck, unit tests, build, e2e) · `pnpm dev` (local API with in-memory
fakes + Vite) · `pnpm e2e` · `AWS_PROFILE=admin pnpm lifecycle-test` (real AWS, `test-*` worlds
only, never while someone is playing) · `scripts/check-secrets.sh`.

## Docs

| Doc | Read it when you touch |
|---|---|
| `docs/decisions.md` | anything: every settled decision, names, state schema |
| `docs/game-server.md` | `packages/supervisor`: boot, DST processes, idle detection, stop sequence |
| `docs/control-plane.md` | `packages/shared`, `packages/api`: state machine, API, launcher, reaper |
| `docs/auth.md` | Steam OpenID verifier, sessions, allowlist, CSRF; add/remove a friend |
| `docs/storage.md` | S3 layout, backups, world import, **disaster-recovery runbook** |
| `docs/web.md` | `packages/web`, `e2e/` |
| `docs/infra.md` | `packages/infra`, the deploy workflow, DNS, budget |
| `docs/testing.md` | verification strategy, the real-AWS lifecycle test, clean-account check |
| `docs/research/`, `docs/spikes/` | evidence behind the decisions (read-only history) |
