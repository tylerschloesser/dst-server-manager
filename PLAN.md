# PLAN: build dst-server-manager

You are the **execution orchestrator** (one clean Opus session started with `@PLAN.md`). The
design is finished; nothing in here is an open decision. Your job is to dispatch sub-agents,
verify their work **by running commands**, record progress, commit, and push.

Read now, in full: `CLAUDE.md` (invariants) and `docs/decisions.md` (the design; section 16
overrides everything else). Do **not** read the other docs or the code sub-agents write; your
context is the scarce resource. The domain docs are for the sub-agents.

## How to run this plan

**Progress and resuming.** The checkboxes in this file are the progress record. After every task:
run its acceptance commands, tick its box (`- [x]`), commit, push. On a fresh start or after
compaction: re-read this section, find the first unticked task, re-run the acceptance commands of
the last ticked task to confirm the tree is sane, continue. Every phase ends with an annotated tag:
`git tag -a <tag> -m "<phase title>" && git push origin <tag>`.

**Dispatching.** Use the Agent tool with the task's `model` (`sonnet` unless the task says
`opus`). Sub-agents start with zero context. Build each brief from this template, filling it from
the task block, and paste the task block's Do and Acceptance sections verbatim:

> You are implementing one task of the dst-server-manager project in
> `/Users/tyler/repos/dst-server-manager`. You have zero prior context. First read `CLAUDE.md`
> (invariants you must not break) and `docs/decisions.md` (the settled design; section 16 overrides
> any other doc). Then read: <task Docs>. Your task: <task id and title>. <task Do>. You own ONLY
> these paths: <task Owns>; do not create or edit anything else, and do not add, remove or upgrade
> dependencies (if you need one, stop and report it). Done means these commands give these
> results: <task Acceptance>; run them yourself before reporting. Rules: never run `git add`,
> `git commit` or `git push`; never print secrets; no SteamIDs, emails or secrets in any file;
> AWS calls only if the task says so, always with `AWS_PROFILE=admin` and an explicit `--region`,
> never touching anything this project did not create; if AWS credentials are expired or a human
> decision is needed, stop and report. Shell gotchas: zsh `noclobber` (use `>|`), `rm` is
> interactive (use `command rm -f`). Final message, at most 12 lines: what you built, the result
> of each acceptance command, anything you could not do, any dependency you need.

**Verifying.** After a sub-agent reports, run the task's acceptance commands yourself. If one
fails, send the failing command and its output back to the same agent (SendMessage). After two
failed rounds, dispatch a fresh `opus` agent with the same brief plus the failure history. Never
tick a box on a sub-agent's word.

**Parallelism.** Tasks marked with the same `Parallel group` may be dispatched in one message.
They own disjoint paths, and their acceptance commands are package-scoped, because a sibling's
half-written files would break repo-wide commands. Dependencies are all installed in T1.1;
parallel tasks must not touch `package.json` files or the lockfile. If a sub-agent reports a
missing dependency, add it yourself between groups (`pnpm --filter <pkg> add <dep>`), commit, and
resume that agent.

**Committing (you, never sub-agents).** `git status --short` and look at it; `git add` the task's
owned paths; `scripts/check-secrets.sh` must print `check-secrets: ok`; commit with a message
ending in the `Co-Authored-By` line from the session's attribution reminder; `git push`. The
pre-push hook must be active: `git config core.hooksPath` prints `.githooks`.

**Pushes deploy only from Phase 6 on** (the workflow file does not exist before T6.1). From then
on, run `pnpm check` before every push and keep `main` deployable.

**AWS.** Account `063257577013`; other production sites live there. `AWS_PROFILE=admin` and
`--region` on every call. If credentials expire: stop and ask Tyler to run
`! aws sso login --profile admin`. Any AWS step that would touch a resource not created by this
project: stop.

**Human steps.** All inputs were collected in planning (`docs/decisions.md` section 1). The only
human actions left: clicking the SNS confirmation email (T3.4, non-blocking) and the final manual
test (T7.2). Do not invent other questions; the answer is in `docs/decisions.md`.

---

## Phase 0: preflight (orchestrator, no sub-agent) → tag `exec-start`

- [ ] **T0.1 Environment and inputs**
  - Do: run the acceptance commands. Create the session secret only if it is missing:
    ```bash
    umask 077; T=$(mktemp -d); openssl rand -base64 48 | tr -d '\n' >| "$T/s"
    AWS_PROFILE=admin aws ssm put-parameter --region us-east-1 --name /dst/session-secret \
      --type SecureString --value "file://$T/s" --tags Key=project,Value=dst-server-manager \
      --description "Session signing secret (human-managed, not owned by CDK)" >/dev/null; command rm -rf "$T"
    ```
  - Acceptance:
    ```bash
    node -v | grep -q '^v22' && corepack --version && gh auth status >/dev/null && echo tools-ok      # tools-ok
    git config core.hooksPath                                                                        # .githooks
    scripts/check-secrets.sh                                                                         # check-secrets: ok
    AWS_PROFILE=admin aws sts get-caller-identity --region us-east-1 --query Account --output text   # 063257577013
    AWS_PROFILE=admin aws ssm describe-parameters --region us-west-2 --parameter-filters Key=Name,Option=BeginsWith,Values=/dst --query 'sort(Parameters[].Name)' --output text   # /dst/cluster-password /dst/klei-token
    AWS_PROFILE=admin aws ssm describe-parameters --region us-east-1 --parameter-filters Key=Name,Option=BeginsWith,Values=/dst --query 'sort(Parameters[].Name)' --output text   # /dst/session-secret /dst/users
    test -f ~/Downloads/dst-tylerni2026.zip && echo zip-ok                                           # zip-ok
    ```
    If `git config core.hooksPath` is empty, run `git config core.hooksPath .githooks`.

## Phase 1: scaffold → tag `scaffold`

- [ ] **T1.1 Monorepo scaffold** · model `sonnet` · deps: T0.1 · not parallel
  - Docs: `docs/testing.md` §1 and §1bis; `docs/decisions.md` §4 and §16.2; `docs/web.md` §1;
    `docs/infra.md` §1; `docs/game-server.md` §1; `docs/control-plane.md` §1 (file layout only).
  - Do: create the pnpm workspace (`@dst/shared`, `@dst/api`, `@dst/supervisor`, `@dst/web`,
    `@dst/infra`, plus `e2e/` and `scripts/` covered by lint and typecheck). Pin `packageManager`
    (corepack), Node 22 in `engines` and `.nvmrc`. Root scripts exactly as `docs/testing.md` §1:
    `lint`, `typecheck`, `test`, `build`, `e2e`, `check`, `dev`, `lifecycle-test`. TypeScript
    strict base config, ESLint flat config + Prettier, Vitest with the repo-root `vitest.setup.ts`
    network/AWS guard, Playwright installed (`pnpm exec playwright install chromium`) with an
    empty suite that passes. **Install every dependency the docs name for every package now**, at
    the pinned versions in `docs/decisions.md` §4 (later tasks may not add dependencies). Each
    package gets a minimal compiling `src/index.ts` and build script so every root script passes
    on the empty skeleton; `pnpm build` may skip `cdk synth` until T2.6 adds the app, but the
    script wiring must exist. Do not modify `.gitignore` guards, `scripts/check-secrets.sh`,
    `.githooks/`, `docs/`, `CLAUDE.md`, `PLAN.md`, `PROMPT.md`.
  - Owns: root config files (`package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.nvmrc`,
    `tsconfig*.json`, `eslint.config.*`, `.prettierrc*`, `.prettierignore`, `vitest.*`,
    `playwright.config.ts`), `packages/*/package.json`, `packages/*/tsconfig.json`,
    `packages/*/src/index.ts`, `e2e/`, additions (not removals) to `.gitignore`.
  - Acceptance:
    ```bash
    pnpm install --frozen-lockfile                      # exit 0
    pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm e2e ; echo "exit=$?"   # exit=0
    pnpm ls -r --depth -1 | grep -c '@dst/'             # 5
    pnpm --filter @dst/web ls @mantine/core | grep -E '@mantine/core 8\.'                  # one match (v8, not v9)
    pnpm --filter @dst/infra ls aws-cdk-lib | grep -F '2.270.0'                            # one match
    grep -E '^(\*\.zip|cluster_token\.txt|cluster\.ini)$' .gitignore | wc -l               # 3
    ```

- [ ] **T1.2 `@dst/shared`** · model `sonnet` · deps: T1.1 · not parallel
  - Docs: `docs/control-plane.md` §1 (owner of all names); `docs/decisions.md` §3, §5, §6, §7, §16;
    `docs/testing.md` §1bis.
  - Do: all shared types (registry item, state item incl. `desiredByNickname` /
    `startedByNickname`, API response shapes, status and stop-reason unions), constants (resource
    names, regions, ports, thresholds, `CAVES_SHARD_ID`, instance type, `APP_ENV` values),
    `sessionId` mint/parse helper, runtime validators for items read from DynamoDB, and the two
    guard tests with the exact names from `docs/testing.md` §1bis.
  - Owns: `packages/shared/**` except `package.json`.
  - Acceptance:
    ```bash
    pnpm --filter @dst/shared lint && pnpm --filter @dst/shared typecheck && pnpm --filter @dst/shared test ; echo "exit=$?"   # exit=0
    pnpm --filter @dst/shared test -- --reporter=verbose 2>&1 | grep -c 'blocks real network access in unit tests'   # 1
    pnpm --filter @dst/shared test -- --reporter=verbose 2>&1 | grep -c 'blocks real AWS SDK calls in unit tests'    # 1
    ```

## Phase 2: build everything locally, no deploy → tag `local-green`

Group A (dispatch together after T1.2): T2.1, T2.4, T2.6, T2.7. Group B (after T2.1): T2.2, T2.3.
Then T2.5 (after T2.4), T2.8 (after T2.2 and T2.7), T2.9 (after T2.2 and T2.3), T2.10, T2.11.

- [ ] **T2.1 API core** · model `sonnet` · deps: T1.2 · Parallel group A
  - Docs: `docs/control-plane.md` §2-§5, §7, §8; `docs/decisions.md` §6, §10, §16;
    `docs/spikes/cloudfront-oac-lambda-url.md` (what the Lambda event looks like).
  - Do: ports and adapters (state store, world registry, launcher with AZ fallback, parameter
    store, clock, identity), in-memory fakes, the Function URL v2 router, `GET /api/worlds`,
    `POST start` / `POST stop` with every conditional write and race outcome of the state-machine
    matrix, error shapes, the local server entrypoint (`APP_ENV=local|test`, fake launcher that
    walks the states, the `DST_LOCAL_ONLY`-marked dev-login and test-control routes), the esbuild
    script producing `packages/api/dist/lambda/api.js` and `reaper.js`, and compile-ready stubs
    `src/auth/index.ts` and `src/reaper/index.ts` exporting exactly the signatures that
    `docs/auth.md` §6 and `docs/control-plane.md` §6 define (T2.2 and T2.3 replace the bodies).
    Unit tests: the full transition matrix and the interleaved-write race simulations.
  - Owns: `packages/api/**` except `package.json`; after this task `src/auth/**` belongs to T2.2
    and `src/reaper/**` to T2.3.
  - Acceptance:
    ```bash
    pnpm --filter @dst/api lint && pnpm --filter @dst/api typecheck && pnpm --filter @dst/api test && pnpm --filter @dst/api build ; echo "exit=$?"   # exit=0
    ls packages/api/dist/lambda/api.js packages/api/dist/lambda/reaper.js                  # both exist
    grep -c DST_LOCAL_ONLY packages/api/dist/lambda/api.js packages/api/dist/lambda/reaper.js   # both :0
    grep -rl DST_LOCAL_ONLY packages/api/src | wc -l                                       # >= 1
    ```

- [ ] **T2.2 Auth** · model `sonnet` · deps: T2.1 · Parallel group B
  - Docs: `docs/auth.md` (all of it; it is the spec, follow it literally); `docs/decisions.md` §9,
    §16.1, §16.12.
  - Do: the Steam OpenID login redirect and callback verifier (every numbered check, in order),
    state cookie, session tokens (HKDF, env discriminator, constant-time compare), `requireUser`,
    allowlist with fail-closed parsing, secrets loading with caches, CSRF precondition, logout,
    `GET /api/me`, API security headers, and **every numbered unit test in `docs/auth.md` §9**,
    with `fetch` injected as a port. Export the e2e cookie-minting helper as the doc specifies.
  - Owns: `packages/api/src/auth/**`.
  - Acceptance:
    ```bash
    pnpm --filter @dst/api lint && pnpm --filter @dst/api typecheck && pnpm --filter @dst/api test ; echo "exit=$?"   # exit=0
    pnpm --filter @dst/api test -- --reporter=verbose src/auth 2>&1 | grep -cE '✓|√'       # >= 90 (the numbered list in auth.md §9)
    grep -rn "steamcommunity.com/openid/login" packages/api/src/auth | grep -vc test        # >= 1 (hardcoded endpoint)
    grep -rnE "openid\.op_endpoint" packages/api/src/auth | grep -v test | grep -ci fetch   # 0 (never fetch the response's endpoint)
    ```

- [ ] **T2.3 Reaper** · model `sonnet` · deps: T2.1 · Parallel group B
  - Docs: `docs/control-plane.md` §6-§8; `docs/decisions.md` §7, §16.7, §16.13, §16.14.
  - Do: the reaper handler: EC2 filter, rule order orphan → max-age → stale, graceful-then-hard
    max-age, reconcile, `now` override clamped to the future, JSON summary return value. Unit
    tests with a fake clock and fake EC2 for every rule, the AND orphan rule after an in-place
    switch, and the `starting`-with-no-instance grace.
  - Owns: `packages/api/src/reaper/**`.
  - Acceptance:
    ```bash
    pnpm --filter @dst/api lint && pnpm --filter @dst/api typecheck && pnpm --filter @dst/api test ; echo "exit=$?"   # exit=0
    pnpm --filter @dst/api test -- --reporter=verbose src/reaper 2>&1 | grep -ciE 'orphan|max-age|stale'   # >= 6
    ```

- [ ] **T2.4 Supervisor core** · model `sonnet` · deps: T1.2 · Parallel group A
  - Docs: `docs/game-server.md` §1, §7, §8, §12; `docs/decisions.md` §5, §6, §16.
  - Do: the pure, I/O-free core in `packages/supervisor/src/core/`: count-query line builder and
    log parser (nonce, skips the `RemoteCommandInput:` echo), the player-count formula, UNKNOWN
    semantics, the 3-consecutive-zero rule, idle-deadline maths, joinable and pause detectors
    with the exact regexes, the reconcile state machine (start, in-place switch, stop, crash,
    boot timeout, start requested during stopping, final conditional `stopped`), and the port
    interfaces the adapters will implement. Every unit test listed in `docs/game-server.md` §12.
  - Owns: `packages/supervisor/src/core/**`, `packages/supervisor/src/ports.ts`.
  - Acceptance:
    ```bash
    pnpm --filter @dst/supervisor lint && pnpm --filter @dst/supervisor typecheck && pnpm --filter @dst/supervisor test ; echo "exit=$?"   # exit=0
    grep -rn "GetNumPlayers" packages/supervisor/src | grep -vc -i "never\|not\|test"       # 0 (the broken signal is not used)
    grep -rln "node:fs\|node:child_process\|@aws-sdk" packages/supervisor/src/core | wc -l  # 0 (core is pure)
    ```

- [ ] **T2.5 Supervisor adapters, assets, bundle** · model `sonnet` · deps: T2.4 · not parallel with T2.4
  - Docs: `docs/game-server.md` §2-§6, §9-§11, §13; `docs/storage.md` §6, §8;
    `docs/spikes/artifacts/*` (validated prototypes to adapt); `docs/decisions.md` §5, §8, §16.
  - Do: adapters (DynamoDB, S3, SSM, IMDS, systemd/FIFO, clock), tasks (binaries restore with
    streamed extract and build-id refresh, world restore with `VersionId` capture, world
    generation from templates incl. complete `leveldataoverride.lua` for both shards, secret
    injection, stop sequence with all timeouts, save tarball with the exact exclude list and
    password blanking, log scrub and upload, manifest, 10-minute inflight copy), `assets/`
    (`user-data.sh`, `install.sh`, unit files, bash helpers), the pinned Node version + sha256
    (fetch the real values from nodejs.org `SHASUMS256.txt` for the latest Node 22 linux-x64
    `.tar.xz`), and the esbuild bundle `packages/supervisor/dist/supervisor.js` plus the
    `dist/runtime/` directory that CDK deploys. `shellcheck` is optional; `bash -n` is required.
  - Owns: `packages/supervisor/**` except `package.json`, `src/core/**`, `src/ports.ts`.
  - Acceptance:
    ```bash
    pnpm --filter @dst/supervisor lint && pnpm --filter @dst/supervisor typecheck && pnpm --filter @dst/supervisor test && pnpm --filter @dst/supervisor build ; echo "exit=$?"   # exit=0
    ls packages/supervisor/dist/supervisor.js packages/supervisor/dist/runtime/install.sh   # both exist
    for f in packages/supervisor/assets/*.sh packages/supervisor/assets/bin/*; do bash -n "$f" || echo BAD $f; done   # no output
    head -5 packages/supervisor/assets/user-data.sh | grep -c 'shutdown -h +780'            # 1 (dead-man first)
    grep -c 'server_temp' packages/supervisor/src/tasks/*.ts packages/supervisor/assets/bin/* | grep -vc ':0'   # >= 1 (exclude list present)
    ```

- [ ] **T2.6 Infra (CDK)** · model `sonnet` · deps: T1.2 · Parallel group A · **AWS: read-only lookup**
  - Docs: `docs/infra.md` (all); `docs/storage.md` §1-§4; `docs/control-plane.md` §7;
    `docs/auth.md` §8 (security headers); `docs/decisions.md` §2, §3, §7, §12, §16.16-§16.21;
    `docs/spikes/cloudfront-oac-lambda-url.md` (working OAC snippet).
  - Do: the CDK app with `DstCi`, `DstGame`, `DstWeb` exactly as specified, including the explicit
    extra `lambda:InvokeFunction` permission for CloudFront, the `budgetEnabled` context flag, and
    all CDK assertion tests of `docs/infra.md` §7 (using fixture asset paths so tests do not need
    built bundles). The only AWS call allowed: one `AWS_PROFILE=admin pnpm --filter @dst/infra
    exec cdk synth` so the default-VPC lookup is cached in `packages/infra/cdk.context.json`
    (commit it; after that, synth needs no credentials). Do **not** deploy, bootstrap, or diff.
  - Owns: `packages/infra/**` except `package.json`.
  - Acceptance:
    ```bash
    pnpm --filter @dst/infra lint && pnpm --filter @dst/infra typecheck && pnpm --filter @dst/infra test ; echo "exit=$?"   # exit=0
    test -f packages/infra/cdk.context.json && echo ctx-ok                                   # ctx-ok
    grep -rn "new route53.*HostedZone(\|PublicHostedZone(" packages/infra/lib | wc -l        # 0 (zone is imported, never created)
    grep -rn "OpenIdConnectProvider(" packages/infra/lib | grep -vc "from"                   # 0 (provider is imported, never created)
    grep -rn "autoDeleteObjects: true" packages/infra/lib | wc -l                            # 0
    grep -rn "crossRegionReferences" packages/infra/lib packages/infra/bin | wc -l           # 0
    ```

- [ ] **T2.7 Web app** · model `sonnet` · deps: T1.2 · Parallel group A
  - Docs: `docs/web.md` §1-§6, §8; `docs/decisions.md` §10, §11, §16.9, §16.12, §16.21.
  - Do: the SPA exactly as specified: Mantine 8 only (none of the v9 APIs the doc lists), no
    authored CSS files, no router, dark by default without `<ColorSchemeScript>`, the screens,
    states, modals, copy text and accessible names from the doc, `useWorlds` / `useMe` /
    mutations (bodyless POSTs with `X-DST-Request: 1`), polling rules, `useCountdown`, error
    mapping, Vite proxy to the local API. Unit tests for hooks and status derivation.
  - Owns: `packages/web/**` except `package.json`.
  - Acceptance:
    ```bash
    pnpm --filter @dst/web lint && pnpm --filter @dst/web typecheck && pnpm --filter @dst/web test && pnpm --filter @dst/web build ; echo "exit=$?"   # exit=0
    ls packages/web/dist/index.html                                                          # exists
    find packages/web/src -name '*.css' -o -name '*.scss' | wc -l                            # 0
    grep -rn "ColorSchemeScript\|@mantine/modals\|react-router" packages/web/src | wc -l     # 0
    grep -rn "body:" packages/web/src --include=*.ts --include=*.tsx | grep -ci fetch        # 0 (POSTs are bodyless)
    ```

- [ ] **T2.8 End-to-end tests** · model `sonnet` · deps: T2.2, T2.7 · not parallel
  - Docs: `docs/web.md` §7; `docs/auth.md` §9 (cookie minting); `docs/testing.md` §3.
  - Do: Playwright config (webServer starts the local API with `APP_ENV=test` and Vite; phone and
    desktop projects), the cookie-minting support helper, the test-control helper, and **every
    numbered scenario in `docs/web.md` §7**. If a scenario exposes a bug in `packages/web` or the
    local server, report it instead of editing those packages.
  - Owns: `e2e/**`, `playwright.config.ts`.
  - Acceptance:
    ```bash
    pnpm e2e ; echo "exit=$?"                                                                # exit=0
    pnpm exec playwright test --list 2>/dev/null | grep -cE '›'                              # >= 20 (scenarios x 2 viewports)
    ```

- [ ] **T2.9 Scripts** · model `sonnet` · deps: T2.2, T2.3 · can run alongside T2.8
  - Docs: `docs/storage.md` §6, §7; `docs/control-plane.md` §9; `docs/testing.md` §4 (all), §6;
    `docs/decisions.md` §8, §13, §16.22, §16.23.
  - Do: `scripts/import-world.ts` (seed upload, sanitised tarball, registry item; never prints
    the token; works in `mktemp -d`; refuses ids starting with `test-`; idempotent) and
    `scripts/lifecycle-test.ts` with every safety rail, phase, flag (`--cleanup-only`,
    `--skip-reaper`, `--until-phase N`, `--timeout-minutes`, `--keep-going`), teardown and exit
    code from `docs/testing.md` §4, plus `scripts/clean-account-check.sh` from §6. Unit-test the
    pure parts (argument parsing, tarball sanitising on a fixture cluster with a fake token,
    assertion helpers). Do not run either script against AWS in this task.
  - Owns: `scripts/**` except `scripts/check-secrets.sh`.
  - Acceptance:
    ```bash
    pnpm lint && pnpm typecheck && pnpm test ; echo "exit=$?"                                # exit=0
    pnpm tsx scripts/import-world.ts --help | grep -c -- '--id'                              # >= 1
    pnpm tsx scripts/import-world.ts --id test-x --zip /dev/null ; echo "exit=$?"            # non-zero, message says test- ids are reserved
    pnpm lifecycle-test --help | grep -c -- '--until-phase'                                  # >= 1
    bash -n scripts/clean-account-check.sh && echo ok                                        # ok
    ```

- [ ] **T2.10 Security review** · model `opus` · deps: T2.2, T2.5, T2.9 · read-only review
  - Docs: `docs/auth.md`; `docs/research/steam-openid-auth.md` §3; `docs/game-server.md` §5, §10;
    `docs/storage.md` §6, §11; `CLAUDE.md`.
  - Do: review, do not edit. (a) Walk `packages/api/src/auth/` against every numbered check in
    `docs/auth.md` §3 and confirm each has a test that fails when the check is removed (mutate
    locally in a scratch copy or reason precisely; leave the tree unchanged). (b) Confirm the
    test-only secret and local-only routes cannot reach the Lambda bundle. (c) Trace every path
    by which the Klei token or cluster password could reach a log line, an S3 object, DynamoDB,
    or process arguments in `packages/supervisor` and `scripts/`. Write findings to
    `docs/_security-review.md` as a numbered defect list with file, line, severity, and the fix.
  - Owns: `docs/_security-review.md`.
  - Acceptance: `test -f docs/_security-review.md && echo ok` → `ok`. Then **you** dispatch one
    `sonnet` fix task per owning package for every defect of severity medium or higher (owned
    paths = that package), re-run that package's acceptance commands, and resume the reviewer
    (SendMessage) to confirm the fixes. Commit the review file; it is deleted in Phase 8.

- [ ] **T2.11 Green gate** (orchestrator)
  - Acceptance:
    ```bash
    pnpm install --frozen-lockfile && pnpm check ; echo "exit=$?"                            # exit=0
    ls packages/web/dist/index.html packages/supervisor/dist/supervisor.js packages/api/dist/lambda/api.js packages/api/dist/lambda/reaper.js packages/infra/cdk.out/DstWeb.template.json   # all exist
    grep -c DST_LOCAL_ONLY packages/api/dist/lambda/*.js                                     # every file :0
    env -u AWS_PROFILE pnpm build ; echo "exit=$?"                                           # exit=0 (synth needs no credentials)
    scripts/check-secrets.sh                                                                 # check-secrets: ok
    ```
    Tag `local-green`.

## Phase 3: deploy from the laptop (no CI yet) → tag `infra-deployed`

You run these commands yourself; they are long-running but mechanical. Use a sub-agent only to
debug a failure (`opus`, brief = the failing command, its output, `docs/infra.md`).

- [ ] **T3.1 Review the diff, then deploy**
  ```bash
  cd packages/infra
  AWS_PROFILE=admin pnpm exec cdk diff DstCi DstGame DstWeb 2>&1 | tee /tmp/dst-diff.txt | tail -5
  grep -E 'AWS::Route53::(HostedZone|RecordSet)' /tmp/dst-diff.txt    # only RecordSets for dst.ty.ler.dev; NO HostedZone
  grep -c 'AWS::IAM::OIDCProvider' /tmp/dst-diff.txt                  # 0
  AWS_PROFILE=admin pnpm exec cdk deploy DstCi --require-approval never
  AWS_PROFILE=admin pnpm exec cdk deploy DstGame --require-approval never
  AWS_PROFILE=admin pnpm exec cdk deploy DstWeb --require-approval never
  ```
  If `DstWeb` fails **only** on the Budget resource (tag cost filter not yet active), redeploy
  with `-c budgetEnabled=false` and leave T3.4's budget box unticked for Phase 8 to report.
  If anything in the diff touches a Route 53 name other than `dst.ty.ler.dev` or the ACM
  validation record under it: stop, do not deploy.
- [ ] **T3.2 Post-deploy checks**: run every command in `docs/infra.md` §9 (dispatch a `sonnet`
  agent to run the checklist and report a PASS/FAIL table, AWS read-only). Minimum you verify
  yourself:
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' https://dst.ty.ler.dev/                          # 200
  curl -s -o /dev/null -w '%{http_code}\n' https://dst.ty.ler.dev/api/me                    # 401
  curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://dst.ty.ler.dev/api/auth/steam/login | grep -c 'steamcommunity.com/openid/login'   # 1
  curl -s -o /dev/null -w '%{http_code}\n' -X POST https://dst.ty.ler.dev/api/worlds/x/start   # 401 or 403, never 200/500
  U=$(AWS_PROFILE=admin aws lambda get-function-url-config --region us-east-1 --function-name dst-server-manager-api --query FunctionUrl --output text); curl -s -o /dev/null -w '%{http_code}\n' "$U"   # 403
  AWS_PROFILE=admin aws ec2 describe-security-groups --region us-west-2 --filters Name=group-name,Values=dst-server-manager-game --query 'SecurityGroups[0].IpPermissions[].[IpProtocol,FromPort,ToPort]' --output text   # udp 10998 10999 only
  AWS_PROFILE=admin aws s3api get-bucket-versioning --region us-west-2 --bucket dst-server-manager-data-063257577013 --query Status --output text   # Enabled
  ```
- [ ] **T3.3 Import the real world** (the only time the zip is read)
  ```bash
  AWS_PROFILE=admin pnpm tsx scripts/import-world.ts --id tylerni2026 --zip ~/Downloads/dst-tylerni2026.zip   # see docs/storage.md §7 for flags
  AWS_PROFILE=admin aws s3api list-object-versions --region us-west-2 --bucket dst-server-manager-data-063257577013 --prefix worlds/tylerni2026/ --query 'length(Versions)'   # 1
  AWS_PROFILE=admin aws s3 ls --region us-west-2 s3://dst-server-manager-data-063257577013/seed/tylerni2026/   # the zip
  T=$(mktemp -d); AWS_PROFILE=admin aws s3 cp --region us-west-2 s3://dst-server-manager-data-063257577013/worlds/tylerni2026/save.tar.zst "$T/s.tar.zst" >/dev/null
  tar --zstd -tf "$T/s.tar.zst" | grep -cE 'cluster_token|server_temp'                      # 0
  tar --zstd -tf "$T/s.tar.zst" | grep -cE '^(\./)?cluster\.ini$'                           # 1 (contents at archive root)
  command rm -rf "$T"
  curl -s https://dst.ty.ler.dev/api/me -o /dev/null -w '%{http_code}\n'                    # 401 (sanity)
  ```
- [ ] **T3.4 Budget plumbing** (non-blocking; tick what succeeded, note the rest for Phase 8)
  ```bash
  ARN=$(AWS_PROFILE=admin aws sns list-topics --region us-east-1 --query "Topics[?ends_with(TopicArn,':dst-server-manager-budget')].TopicArn" --output text)
  AWS_PROFILE=admin aws sns subscribe --region us-east-1 --topic-arn "$ARN" --protocol email --notification-endpoint "$(git config user.email)" >/dev/null   # never echo the address
  AWS_PROFILE=admin aws ce update-cost-allocation-tags-status --region us-east-1 --cost-allocation-tags-status TagKey=project,Status=Active   # may fail until the tag appears in billing (24 h): not a blocker
  ```
  Tell Tyler once: "AWS sent a subscription confirmation email; click the link." Continue
  without waiting. Tag `infra-deployed`.

## Phase 4: first boot, test world only → tag `first-boot`

- [ ] **T4.1 First boot and debug loop** · model `opus` · deps: Phase 3 · **AWS: yes**
  - Docs: `docs/testing.md` §4; `docs/game-server.md` (all, esp. §13 debugging);
    `docs/spikes/game-server-spike.md` §10 and the artifacts; `docs/control-plane.md` §3.
  - Do: run `AWS_PROFILE=admin pnpm lifecycle-test --until-phase 1` (world `test-lifecycle-a`,
    generated, never the real world). It will likely fail the first time. Debug on the instance
    with SSM Session Manager, fix the code in `packages/supervisor` (and only if unavoidable
    `packages/api` or `packages/infra`), run the package's tests, redeploy the changed stack
    (`cdk deploy DstGame` republishes `runtime/`), re-run. Repeat until phases 0-1 pass twice in a
    row (the second run exercises the binaries tarball path). Always leave the account with no
    running instance: finish with `pnpm lifecycle-test --cleanup-only`. Never print the token or
    password while debugging (no `cat cluster.ini`, no `cat cluster_token.txt`). Record every
    fix and every measured timing in `docs/_first-boot-notes.md`.
  - Owns: `packages/supervisor/**`, `packages/api/**`, `packages/infra/**`, `scripts/**` (fixes
    only), `docs/_first-boot-notes.md`.
  - Acceptance:
    ```bash
    AWS_PROFILE=admin pnpm lifecycle-test --until-phase 1 ; echo "exit=$?"                   # exit=0, PASS table
    AWS_PROFILE=admin aws s3 ls --region us-west-2 s3://dst-server-manager-data-063257577013/binaries/   # dst-binaries.tar.zst exists
    AWS_PROFILE=admin aws ec2 describe-instances --region us-west-2 --filters Name=tag:project,Values=dst-server-manager Name=instance-state-name,Values=pending,running,stopping,stopped --query 'length(Reservations)'   # 0
    pnpm check ; echo "exit=$?"                                                              # exit=0
    ```
    Tag `first-boot`.

## Phase 5: full lifecycle on real AWS → tag `lifecycle-verified`

- [ ] **T5.1 Lifecycle test, all phases** · model `opus` · deps: T4.1 · **AWS: yes**
  - Docs and Owns: same as T4.1, plus `docs/storage.md` §2, §3, §5.
  - Do: run `AWS_PROFILE=admin pnpm lifecycle-test` (about 100 minutes: start, joinable,
    pre-start version recorded, idempotent and concurrent starts, in-place switch, idle
    shutdown, instance gone, post-stop version, restore chain, stop button, tarball content and
    secret-absence checks, bucket policy and lifecycle configuration, reaper stale-heartbeat,
    reaper max-age via the `now` override, reaper orphan, final clean state). Fix what fails,
    redeploy, re-run the failing phases, then one complete uninterrupted run. Append fixes and
    timings to `docs/_first-boot-notes.md`.
  - Acceptance:
    ```bash
    AWS_PROFILE=admin pnpm lifecycle-test ; echo "exit=$?"                                   # exit=0, every row PASS (none SKIP)
    bash scripts/clean-account-check.sh ; echo "exit=$?"                                     # exit=0
    AWS_PROFILE=admin aws s3api list-object-versions --region us-west-2 --bucket dst-server-manager-data-063257577013 --prefix worlds/tylerni2026/ --query 'length(Versions)'   # still 1: tests never touched the real world
    pnpm check ; echo "exit=$?"                                                              # exit=0
    ```
    Tag `lifecycle-verified`.

## Phase 6: turn on CI deploys → tag `ci-live`

- [ ] **T6.1 Deploy workflow** · model `sonnet` · deps: T5.1
  - Docs: `docs/infra.md` §6; `docs/testing.md` §7; `docs/decisions.md` §12, §16.24.
  - Do: write `.github/workflows/deploy.yml` exactly as specified (verify the current major
    version of each action with `gh api repos/<owner>/<repo>/releases/latest`). It deploys
    `DstGame DstWeb` only, never `DstCi`.
  - Owns: `.github/workflows/deploy.yml`.
  - Acceptance (you): everything is already deployed and green, so this push is the first CI
    deploy and must be a no-op for infrastructure.
    ```bash
    pnpm check ; echo "exit=$?"                                                              # exit=0
    git push && sleep 20 && gh run watch "$(gh run list --workflow deploy.yml --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status ; echo "exit=$?"   # exit=0
    curl -s -o /dev/null -w '%{http_code}\n' https://dst.ty.ler.dev/api/me                   # 401
    ```
    Tag `ci-live`. From now on every push deploys: `pnpm check` before every push.

## Phase 7: the real world → tag `real-world-verified`

- [ ] **T7.1 Boot `tylerni2026`** (orchestrator; commands in `docs/testing.md` §5)
  Start it through the real API (the section gives the cookie-minting one-liner), wait for
  `running`, then verify: the `join` block has an IP and the server name; the Klei lobby lists the
  server; `playerCount` is 0; `idleDeadline` is about 30 minutes after `joinableAt`. Do not stop it.
- [ ] **T7.2 Manual test by Tyler** (the one blocking human step). Ask him, in one message:
  1. On your phone open `https://dst.ty.ler.dev`, sign in with Steam, confirm you see the world
     running with the server name, IP, password and countdown.
  2. In DST: Browse Games → search the server name → enter the password shown in the UI (or paste
     the console command). Play for a minute, visit the caves if convenient, then quit normally.
  3. Reply "done". Do not press Stop; the point is to watch it stop on its own.
- [ ] **T7.3 Verify the unattended shutdown** (about 30 minutes after he leaves; wait with a
  background until-loop, not by polling in the foreground)
  ```bash
  AWS_PROFILE=admin aws dynamodb get-item --region us-east-1 --table-name dst-server-manager --key '{"pk":{"S":"STATE"},"sk":{"S":"CLUSTER"}}' --query 'Item.[status.S,lastStopReason.S]' --output text   # stopped idle
  AWS_PROFILE=admin aws s3api list-object-versions --region us-west-2 --bucket dst-server-manager-data-063257577013 --prefix worlds/tylerni2026/ --query 'length(Versions)'   # 2
  AWS_PROFILE=admin aws s3 ls --region us-west-2 --recursive s3://dst-server-manager-data-063257577013/sessions/tylerni2026/ | grep -c manifest.json   # 1
  bash scripts/clean-account-check.sh ; echo "exit=$?"                                       # exit=0
  ```
  If sign-in or joining failed, dispatch an `opus` debug agent with Tyler's description, fix,
  `pnpm check`, push (CI deploys), and repeat T7.1-T7.3. Tag `real-world-verified`.

## Phase 8: hand-over → tag `v1.0.0`

- [ ] **T8.1 Final cleanup** · model `opus` · deps: T7.3 · **AWS: read-only**
  - Docs: `CLAUDE.md`, every `docs/*.md`, `docs/_first-boot-notes.md`, `docs/_security-review.md`.
  - Do: bring `CLAUDE.md` and `docs/*.md` in line with what was actually built (every fix
    recorded in `docs/_first-boot-notes.md`; measured timings replace estimates; commands in the
    runbooks are re-checked against the real script flags). Fold anything still worth keeping
    from the `_` files into the right doc, then delete `PROMPT.md`, `PLAN.md`,
    `docs/_first-boot-notes.md`, `docs/_security-review.md`, `docs/_consistency-report.md` if
    present. Add `docs/follow-ups.md` listing anything left open by T3.4 (budget disabled,
    cost-allocation tag pending, SNS subscription unconfirmed) with the exact command to finish
    each, and link it from `CLAUDE.md`. Add a short "Small follow-up iterations" section to
    `CLAUDE.md` (how to add a world, add a friend, change the instance type, where the runbooks
    are). Run the clean-account check and include its output in your report.
  - Owns: `CLAUDE.md`, `docs/**`, `PROMPT.md`, `PLAN.md` (deletion).
  - Acceptance (you; note this task deletes this file, so copy these commands first):
    ```bash
    test ! -e PROMPT.md && test ! -e PLAN.md && ls docs/_* 2>/dev/null | wc -l               # 0
    pnpm check ; echo "exit=$?"                                                              # exit=0
    bash scripts/clean-account-check.sh ; echo "exit=$?"                                     # exit=0
    scripts/check-secrets.sh                                                                 # check-secrets: ok
    git push && gh run watch "$(gh run list --workflow deploy.yml --limit 1 --json databaseId -q '.[0].databaseId')" --exit-status ; echo "exit=$?"   # exit=0
    ```
    Tag `v1.0.0`, push the tag, and tell Tyler: what was built, the measured click-to-joinable
    time, where the runbooks are, and anything listed in `docs/follow-ups.md`.
