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
the last ticked task to confirm the tree is sane (run `pnpm install --frozen-lockfile && pnpm build`
first if `dist/` directories are missing; they are gitignored), continue. Every phase ends with an
annotated tag, named in the phase heading and again in the phase's last task:
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
> files that look like save data (`cluster.ini`, `cluster_token.txt`, `*.zip`) are never
> committed: tests generate them in a temp directory; in any committed template or test string
> the password line reads exactly `cluster_password = <injected from SSM at boot>` or uses a
> `${...}` interpolation (the pre-push secret guard blocks anything else); AWS calls only if the
> task says so, always with `AWS_PROFILE=admin` and an explicit `--region` (`cdk` itself takes no
> `--region`), never touching anything this project did not create; if AWS credentials are
> expired, the network is unreachable, or a human decision is needed, stop and report. Shell
> gotchas: zsh `noclobber` (use `>|`), `rm` is interactive (use `command rm -f`), a foreground
> `sleep` is refused. Final message, at most 12 lines: what you built, the result of each
> acceptance command, anything you could not do, any dependency you need.

**Verifying.** After a sub-agent reports, run the task's acceptance commands yourself. Expected
results are in the trailing `#` comments; `exit=0` means the printed exit code. If one fails, send
the failing command and its output back to the same agent (SendMessage). After two failed rounds,
dispatch a fresh `opus` agent with the same brief plus the failure history. Never tick a box on a
sub-agent's word. Write temp files under a directory from `mktemp -d`, not a fixed `/tmp` path.

**Long-running commands.** The Bash tool caps at 10 minutes and refuses a foreground `sleep`.
Anything that can exceed ~8 minutes (`cdk deploy DstWeb`, `pnpm lifecycle-test`, waiting for a
CI run, waiting for an idle shutdown) is started with `run_in_background: true` with output
redirected to a log file in your `mktemp -d` directory; you are re-invoked when it exits; then
read only `tail -40` of the log. To wait on external state, use a background until-loop
(`until <check>; do sleep 30; done`), never a foreground sleep.

**Parallelism.** Tasks marked with the same `Parallel group` may be dispatched in one message.
They own disjoint paths, and their acceptance commands are package-scoped, because a sibling's
half-written files would break repo-wide commands. All dependencies are installed in T1.1;
parallel tasks must not touch `package.json` files or the lockfile. If a sub-agent reports a
missing dependency, add it yourself between groups (`pnpm --filter <pkg> add <dep>`, or `-w` for
the root), commit, and resume that agent.

**Committing (you, never sub-agents).** `git status --short` and look at it; `git add` the task's
owned paths; `scripts/check-secrets.sh` must print `check-secrets: ok`; commit with a message
ending in the `Co-Authored-By` line from the session's attribution reminder; `git push`. The
pre-push hook must be active: `git config core.hooksPath` prints `.githooks`. If the guard blocks
a commit, the fix is always to change the offending file, never to weaken the guard.

**Pushes deploy only from Phase 6 on** (the workflow file does not exist before T6.1). From then
on, run `pnpm check` before every push and keep `main` deployable.

**AWS.** Account `063257577013`; other production sites live there. `AWS_PROFILE=admin` and
`--region` on every `aws` call. If credentials expire: stop and ask Tyler to run
`! aws sso login --profile admin`. Any AWS step that would touch a resource not created by this
project: stop.

**Human steps.** All inputs were collected in planning (`docs/decisions.md` section 1). The only
human actions left: clicking the SNS confirmation email (T3.4, non-blocking) and the final manual
test (T7.1-T7.2). Do not invent other questions; the answer is in `docs/decisions.md`.

---

## Phase 0: preflight (orchestrator, no sub-agent) → tag `exec-start`

- [x] **T0.1 Environment and inputs**
  - Do: run the acceptance commands. Create the session secret only if `/dst/session-secret` is
    missing from the us-east-1 listing:
    ```bash
    umask 077; T=$(mktemp -d); openssl rand -base64 48 | tr -d '\n' >| "$T/s"
    AWS_PROFILE=admin aws ssm put-parameter --region us-east-1 --name /dst/session-secret \
      --type SecureString --value "file://$T/s" --tags Key=project,Value=dst-server-manager \
      --description "Session signing secret (human-managed, not owned by CDK)" >/dev/null; command rm -rf "$T"
    ```
  - Acceptance:
    ```bash
    node -v | grep -c '^v22'                                                                          # 1
    for c in corepack pnpm gh jq zstd uuidgen python3 curl unzip openssl; do command -v $c >/dev/null || echo "MISSING $c"; done   # no output
    aws --version 2>&1 | grep -c '^aws-cli/2'                                                         # 1
    gh auth status >/dev/null 2>&1; echo "exit=$?"                                                    # exit=0
    git config core.hooksPath                                                                         # .githooks (if empty: git config core.hooksPath .githooks)
    scripts/check-secrets.sh                                                                          # check-secrets: ok
    AWS_PROFILE=admin aws sts get-caller-identity --region us-east-1 --query Account --output text    # 063257577013
    AWS_PROFILE=admin aws ssm describe-parameters --region us-west-2 --parameter-filters Key=Name,Option=BeginsWith,Values=/dst --query 'sort(Parameters[].Name)' --output text   # /dst/cluster-password /dst/klei-token
    AWS_PROFILE=admin aws ssm describe-parameters --region us-east-1 --parameter-filters Key=Name,Option=BeginsWith,Values=/dst --query 'sort(Parameters[].Name)' --output text   # /dst/session-secret /dst/users
    test -f ~/Downloads/dst-tylerni2026.zip && echo zip-ok                                            # zip-ok
    ```
    If a tool is missing, install it with Homebrew (`brew install jq zstd`). Tag `exec-start`.

## Phase 1: scaffold → tag `scaffold`

- [x] **T1.1 Monorepo scaffold** · model `sonnet` · deps: T0.1 · not parallel
  - Docs: `docs/testing.md` §1 and §1bis; `docs/decisions.md` §4, §16.2, §16.29-§16.35; and the
    package-layout / dependency section of each package: `docs/control-plane.md` §1,
    `docs/game-server.md` §1, `docs/web.md` §1, `docs/infra.md` §1.
  - Do: create the pnpm workspace with exactly five packages (`@dst/shared`, `@dst/api`,
    `@dst/supervisor`, `@dst/web`, `@dst/infra`); `e2e/` and `scripts/` belong to the root package
    and are covered by root lint and typecheck. Pin `packageManager` (corepack), Node 22 in
    `engines` and `.nvmrc`. Root scripts exactly as `docs/testing.md` §1: `lint`, `typecheck`,
    `test`, `build` (packages first, `cdk synth` last), `e2e`, `check`, `dev`, `lifecycle-test`.
    TypeScript strict base config, ESLint flat config + Prettier, Vitest with the repo-root
    `vitest.setup.ts` network/AWS guard, a root `vitest.config.ts` whose `include` is
    `['scripts/**/*.test.ts']` (root `test` = that run **and** every package's tests; every `test`
    script passes `--passWithNoTests`), `playwright.config.ts` at the repo root
    (`testDir: 'e2e/tests'`) with one trivial `e2e/tests/smoke.spec.ts` (an empty Playwright suite
    exits 1), and `pnpm exec playwright install chromium`.
    **Install every dependency now; later tasks may not add any.** The lists in the docs above are
    authoritative; at minimum:
    ```
    root dev:  typescript eslint @eslint/js typescript-eslint prettier eslint-config-prettier
               vitest @playwright/test tsx esbuild concurrently @types/node
    root deps: @dst/shared@workspace:* @dst/api@workspace:* @aws-sdk/client-s3
               @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @aws-sdk/client-ssm
               @aws-sdk/client-ec2 @aws-sdk/client-lambda
    @dst/shared:     @aws-sdk/lib-dynamodb ; dev: @aws-sdk/client-dynamodb
    @dst/api:        @dst/shared@workspace:* @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
                     @aws-sdk/client-ec2 @aws-sdk/client-ssm ; dev: esbuild @types/aws-lambda
    @dst/supervisor: @dst/shared@workspace:* @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb
                     @aws-sdk/client-s3 @aws-sdk/client-ssm ; dev: esbuild
    @dst/web:        the list in docs/web.md §1, verbatim (Mantine ^8, NOT 9) + @dst/shared@workspace:*
    @dst/infra:      aws-cdk-lib@2.270.0 constructs@10.8.1 ; dev: aws-cdk@2.1142.0 + @dst/shared@workspace:*
    ```
    Each package exports TypeScript **source** through an `exports` map (`docs/decisions.md`
    §16.32; the exact entries are in each package's layout section; `@dst/api` must expose `"."`,
    `"./auth"` and `"./test-secret"`). Each package gets a minimal compiling `src/index.ts` and working `lint`,
    `typecheck`, `test`, `build` scripts so every root script passes on the empty skeleton (the
    root `build` skips `cdk synth` while `packages/infra/bin/` does not exist yet). Do not modify
    the existing `.gitignore` lines, `scripts/check-secrets.sh`, `.githooks/`, `docs/`,
    `CLAUDE.md`, `PLAN.md`, `PROMPT.md`.
  - Owns: root config files (`package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.nvmrc`,
    `tsconfig*.json`, `eslint.config.*`, `.prettierrc*`, `.prettierignore`, `vitest.*`,
    `playwright.config.ts`), `packages/*/package.json`, `packages/*/tsconfig.json`,
    `packages/*/vitest.config.ts`, `packages/*/src/index.ts`, `e2e/tests/smoke.spec.ts`,
    additions (not removals) to `.gitignore`.
  - Acceptance:
    ```bash
    pnpm install --frozen-lockfile ; echo "exit=$?"                                        # exit=0
    pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm e2e ; echo "exit=$?"    # exit=0
    ls -d packages/*/package.json | wc -l | tr -d ' '                                      # 5
    node -p "Object.keys(require('./packages/api/package.json').exports).join()"           # .,./auth,./test-secret
    grep -c "scripts/\*\*" vitest.config.ts                                                  # >= 1
    node -p "const d=require('./package.json').dependencies; [d['@dst/api'],d['@dst/shared']].join()"   # workspace:*,workspace:*
    pnpm --filter @dst/web ls @mantine/core | grep -cE '@mantine/core 8\.'                  # 1
    pnpm --filter @dst/infra ls aws-cdk-lib | grep -cF '2.270.0'                            # 1
    grep -cE '^(\*\.zip|cluster_token\.txt|cluster\.ini)$' .gitignore                       # 3
    ```

- [x] **T1.2 `@dst/shared`** · model `sonnet` · deps: T1.1 · not parallel
  - Docs: `docs/control-plane.md` §1, §2, §5.4, §8 (owner of all names); `docs/auth.md` §8.3 (the
    exact CSP string); `docs/decisions.md` §3, §5, §6, §7, §16; `docs/testing.md` §1bis.
  - Do: everything `docs/control-plane.md` §1 lists for this package: types (registry item, state
    item incl. `desiredByNickname` / `startedByNickname`, the API response types of §5.4, status
    and stop-reason unions), constants (resource names, regions, ports, thresholds,
    `CAVES_SHARD_ID`, instance type, `APP_ENV` values, `SPA_CSP` verbatim from `docs/auth.md`
    §8.3), the `sessionId` mint/parse helper, runtime validators for items read from DynamoDB,
    `derive.ts` (per-world status, `stale`, the `active` / `join` block), `state-expressions.ts`
    (every DynamoDB write in the system as pure builders), their tests from §8, and the two guard
    tests with the exact names from `docs/testing.md` §1bis.
  - Owns: `packages/shared/**` except `package.json`, `tsconfig.json`, `vitest.config.ts`.
  - Acceptance:
    ```bash
    pnpm --filter @dst/shared lint && pnpm --filter @dst/shared typecheck && pnpm --filter @dst/shared test ; echo "exit=$?"   # exit=0
    O=$(mktemp -d); pnpm --filter @dst/shared exec vitest run --reporter=json --outputFile="$O/r.json" >/dev/null 2>&1
    jq -e '.numFailedTests == 0 and .numTotalTests >= 30' "$O/r.json" ; echo "exit=$?"      # exit=0
    jq -r '[.testResults[].assertionResults[].title]|join("\n")' "$O/r.json" | grep -cx 'blocks real network access in unit tests'   # 1
    jq -r '[.testResults[].assertionResults[].title]|join("\n")' "$O/r.json" | grep -cx 'blocks real AWS SDK calls in unit tests'    # 1
    ls packages/shared/src/derive.ts packages/shared/src/state-expressions.ts              # both exist
    grep -l "SPA_CSP" packages/shared/src/*.ts | wc -l | tr -d ' '                          # >= 1
    ```
    Tag `scaffold`.

## Phase 2: build everything locally, no deploy → tag `local-green`

Order: **Group A** (dispatch together after T1.2): T2.1, T2.4, T2.6, T2.7. **Group B** (together,
after T2.1): T2.2, T2.3. T2.5 after T2.4. Then, one at a time: T2.8 (needs T2.2, T2.7), T2.9 (needs
T2.2, T2.3, T2.8), T2.10 (needs T2.2, T2.5, T2.9), T2.11.

- [x] **T2.1 API core** · model `sonnet` · deps: T1.2 · Parallel group A
  - Docs: `docs/control-plane.md` §2-§8; `docs/auth.md` §0, §4-§6 (signatures and the `SecretSource`
    port only);
    `docs/decisions.md` §6, §10, §16; `docs/spikes/cloudfront-oac-lambda-url.md` (what the Lambda
    event looks like).
  - Do: ports and adapters (state store, world registry, launcher with AZ fallback, parameter
    store, clock, identity), in-memory fakes, the Function URL v2 router **registering every route
    of `docs/decisions.md` §10 including the five auth routes** (they delegate to
    `src/auth/index.ts`), `GET /api/worlds`, `POST start` / `POST stop` with every conditional
    write and race outcome of the state-machine matrix, error shapes, the Lambda entry files
    `src/handlers/api.ts` and `src/handlers/reaper.ts` (each exports `handler`; thin wiring only:
    the API entry wires the SSM `SecretSource`, the reaper entry calls `runReaper` from
    `src/reaper/index.ts`), the esbuild script
    emitting CommonJS `dist/lambda/api.js` and `dist/lambda/reaper.js`, the local server
    `src/local.ts` (port 8787, `APP_ENV=local|test`, fake launcher that walks the states, the
    `DST_LOCAL_ONLY`-marked dev-login and test-control routes), and compile-ready stubs
    `src/auth/index.ts` and `src/reaper/index.ts` exporting exactly the signatures that
    `docs/auth.md` §6 and `docs/control-plane.md` §6 define (T2.2 and T2.3 replace the bodies; the
    stub `requireUser` returns 401), plus `src/auth/testSecret.ts` (`TEST_SESSION_SECRET`, marked
    `DST_LOCAL_ONLY`, exported only via `@dst/api/test-secret`, imported only by `src/local.ts`;
    never re-exported from `src/auth/index.ts`: `docs/decisions.md` §16.37). Unit tests: the full transition matrix, the interleaved-write
    race simulations, and a router test titled exactly `routes GET /api/me to the auth module`.
  - Owns: `packages/api/**` except `package.json`, `tsconfig.json`, `vitest.config.ts`. When this
    task is ticked, `src/auth/**` passes to T2.2 and `src/reaper/**` to T2.3.
  - Acceptance:
    ```bash
    pnpm --filter @dst/api lint && pnpm --filter @dst/api typecheck && pnpm --filter @dst/api test && pnpm --filter @dst/api build ; echo "exit=$?"   # exit=0
    ls packages/api/dist/lambda/api.js packages/api/dist/lambda/reaper.js                  # both exist
    APP_ENV=prod PUBLIC_ORIGIN=https://dst.ty.ler.dev node -e "for (const f of ['api','reaper']) console.log(typeof require('./packages/api/dist/lambda/'+f+'.js').handler)"   # function function
    grep -rl DST_LOCAL_ONLY packages/api/src | wc -l | tr -d ' '                            # >= 1
    grep -rl 'DST_LOCAL_ONLY\|dst-local-test-secret-not-for-production' packages/api/dist/lambda/ ; echo "exit=$?"   # exit=1 (no file listed)
    O=$(mktemp -d); pnpm --filter @dst/api exec vitest run --reporter=json --outputFile="$O/r.json" >/dev/null 2>&1; jq -e '.numFailedTests == 0 and .numTotalTests >= 40' "$O/r.json"; echo "exit=$?"   # exit=0
    jq -r '[.testResults[].assertionResults[].title]|join("\n")' "$O/r.json" | grep -cx 'routes GET /api/me to the auth module'   # 1
    ```
    Then start the local server as a **background** command
    (`APP_ENV=local PUBLIC_ORIGIN=http://localhost:5173 pnpm --filter @dst/api exec tsx src/local.ts`),
    and check: `curl -s -o /dev/null -w '%{http_code}\n' localhost:8787/api/me` → `401` and
    `curl -s -o /dev/null -w '%{http_code}\n' localhost:8787/api/worlds` → `401`. Stop it with
    `pkill -f 'src/local.ts'` and confirm the same `curl` now fails to connect.

- [ ] **T2.2 Auth** · model `sonnet` · deps: T2.1 · Parallel group B
  - Docs: `docs/auth.md` (all of it; it is the spec, follow it literally);
    `docs/control-plane.md` §1.1, §5.2, §5.3 (constants, routing, error envelope);
    `docs/decisions.md` §9, §16.1, §16.12.
  - Do: fill the bodies behind the T2.1 stubs without changing their signatures: the Steam OpenID
    login redirect and callback verifier (every numbered check, in order), state cookie, session
    tokens (HKDF, env discriminator, constant-time compare), `requireUser`, allowlist with
    fail-closed parsing, secrets loading with caches, CSRF precondition, logout, `GET /api/me`,
    API security headers, the exported cookie-minting helper (the `./auth` export), and **every
    numbered unit test in `docs/auth.md` §9**, with `fetch` injected as a port, grouped in
    `describe` blocks named exactly as §9.2 prescribes. Do not import `testSecret.ts` from any
    file other than tests. T2.3 is editing `src/reaper/**` at the same time: ignore failures there.
  - Owns: `packages/api/src/auth/**`.
  - Acceptance:
    ```bash
    pnpm --filter @dst/api exec eslint src/auth ; echo "exit=$?"                             # exit=0
    O=$(mktemp -d); pnpm --filter @dst/api exec vitest run --reporter=json --outputFile="$O/a.json" src/auth >/dev/null 2>&1
    jq -e '.numFailedTests == 0 and .numTotalTests >= 100' "$O/a.json" ; echo "exit=$?"     # exit=0 (auth.md §9 numbers 100 tests)
    jq -r '[.testResults[].assertionResults[].fullName]|join("\n")' "$O/a.json" | grep -ciE 'forged|replay'   # >= 4
    grep -rn --include='*.ts' --exclude='*.test.ts' "steamcommunity.com/openid/login" packages/api/src/auth | wc -l | tr -d ' '   # >= 1 (hardcoded endpoint)
    grep -rn --include='*.ts' --exclude='*.test.ts' "op_endpoint" packages/api/src/auth | grep -c "fetch(" ; true   # 0 (the response's endpoint is compared, never fetched)
    ```

- [ ] **T2.3 Reaper** · model `sonnet` · deps: T2.1 · Parallel group B
  - Docs: `docs/control-plane.md` §1.2, §2, §6-§8; `docs/decisions.md` §7, §16.7, §16.13, §16.14.
  - Do: fill the body behind the T2.1 stub: EC2 filter, rule order orphan → max-age → stale,
    graceful-then-hard max-age, reconcile, `now` override clamped to the future, JSON summary
    return value. Unit tests with a fake clock and fake EC2 for every case in
    `docs/control-plane.md` §8, including tests titled exactly
    `switched instance is not an orphan` and `starting without an instance is reconciled after the grace`.
    All logic lives in `src/reaper/` (`index.ts` exports `runReaper`); `src/handlers/reaper.ts` is
    T2.1's three-line entry and is not yours. T2.2 is editing `src/auth/**` at the same time:
    ignore failures there.
  - Owns: `packages/api/src/reaper/**`.
  - Acceptance:
    ```bash
    pnpm --filter @dst/api exec eslint src/reaper ; echo "exit=$?"                           # exit=0
    O=$(mktemp -d); pnpm --filter @dst/api exec vitest run --reporter=json --outputFile="$O/r.json" src/reaper >/dev/null 2>&1
    jq -e '.numFailedTests == 0 and .numTotalTests >= 10' "$O/r.json" ; echo "exit=$?"      # exit=0
    jq -r '[.testResults[].assertionResults[].title]|join("\n")' "$O/r.json" | grep -cx 'switched instance is not an orphan'   # 1
    jq -r '[.testResults[].assertionResults[].title]|join("\n")' "$O/r.json" | grep -cx 'starting without an instance is reconciled after the grace'   # 1
    ```
    When **both** T2.2 and T2.3 are ticked, run the package-wide gate before T2.8:
    `pnpm --filter @dst/api lint && pnpm --filter @dst/api typecheck && pnpm --filter @dst/api test && pnpm --filter @dst/api build ; echo "exit=$?"` → `exit=0`,
    and `grep -rl 'DST_LOCAL_ONLY\|dst-local-test-secret-not-for-production' packages/api/dist/lambda/ ; echo "exit=$?"` → `exit=1`.

- [x] **T2.4 Supervisor core** · model `sonnet` · deps: T1.2 · Parallel group A
  - Docs: `docs/game-server.md` §1, §5, §7, §8, §10, §12; `docs/storage.md` §6, §8;
    `docs/control-plane.md` §1.2, §2 (the state item and every supervisor write);
    `docs/decisions.md` §5, §6, §8, §16.
  - Do: the pure, I/O-free core in `packages/supervisor/src/core/` exactly as the doc lays it
    out: count-query line builder and log parser (nonce, skips the `RemoteCommandInput:` echo),
    the player-count formula (`shardplayers` is parsed but never used in the count), UNKNOWN
    semantics, the 3-consecutive-zero rule, idle-deadline maths, joinable and pause detectors with
    the exact regexes, ini editing and world templates, manifest building, the reconcile state
    machine (start, in-place switch, stop, crash, boot timeout, start requested during stopping,
    final conditional `stopped`), and the port types. Every unit test in `docs/game-server.md`
    §12, including tests titled exactly `unknown reading is never treated as zero`,
    `three consecutive zero polls are required`, `player count ignores shard_players`,
    `a world requested during shutdown is started instead of terminating`, and
    `save is not pushed when the world never finished loading`.
  - Owns: `packages/supervisor/src/core/**`, `packages/supervisor/test/**`.
  - Acceptance:
    ```bash
    pnpm --filter @dst/supervisor lint && pnpm --filter @dst/supervisor typecheck && pnpm --filter @dst/supervisor test ; echo "exit=$?"   # exit=0
    O=$(mktemp -d); pnpm --filter @dst/supervisor exec vitest run --reporter=json --outputFile="$O/r.json" >/dev/null 2>&1
    jq -e '.numFailedTests == 0 and .numTotalTests >= 40' "$O/r.json" ; echo "exit=$?"      # exit=0
    for t in 'unknown reading is never treated as zero' 'three consecutive zero polls are required' 'player count ignores shard_players' 'a world requested during shutdown is started instead of terminating' 'save is not pushed when the world never finished loading'; do jq -r '[.testResults[].assertionResults[].title]|join("\n")' "$O/r.json" | grep -cx "$t"; done   # 1 1 1 1 1
    grep -rlE "node:fs|node:child_process|@aws-sdk|Date\.now" packages/supervisor/src/core | wc -l | tr -d ' '   # 0 (core is pure)
    ```

- [ ] **T2.5 Supervisor adapters, assets, bundle** · model `sonnet` · deps: T2.4 · not parallel with T2.4
  - Docs: `docs/game-server.md` §2-§11, §13; `docs/storage.md` §6, §8;
    `docs/control-plane.md` §2 (supervisor writes); `docs/spikes/artifacts/*` (validated
    prototypes to adapt; do not copy `dst-save-push`'s tar layout); `docs/decisions.md` §5, §8, §16.
  - Do: adapters (DynamoDB, S3, SSM, IMDS, systemd/FIFO, log tail, clock), tasks (binaries restore
    with streamed extract and build-id refresh, world restore with `VersionId` capture, world
    generation from the core templates, secret injection, stop sequence with all timeouts, save
    tarball via the single staging + tar command of `docs/storage.md` §6, log scrub and upload,
    manifest, 10-minute inflight copy), `assets/` (`user-data.sh` with `shutdown -h +780` as its
    first command, `install.sh`, unit files, bash helpers), the pinned Node version + sha256 in
    `assets/node.env` (exactly the two-line format of `docs/decisions.md` §16.38; run `curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep linux-x64.tar.xz`;
    if unreachable, stop and report so the orchestrator can run it), the esbuild bundle
    `dist/supervisor.js`, and the staging of `dist/runtime/` that CDK deploys.
  - Owns: `packages/supervisor/**` except `package.json`, `tsconfig.json`, `vitest.config.ts`,
    `src/core/**`, `test/**`.
  - Acceptance:
    ```bash
    pnpm --filter @dst/supervisor lint && pnpm --filter @dst/supervisor typecheck && pnpm --filter @dst/supervisor test && pnpm --filter @dst/supervisor build ; echo "exit=$?"   # exit=0
    ls packages/supervisor/dist/supervisor.js packages/supervisor/dist/runtime/supervisor.js packages/supervisor/dist/runtime/install.sh packages/supervisor/dist/runtime/VERSION   # all exist
    find packages/supervisor/assets -type f \( -name '*.sh' -o -path '*/bin/*' \) | wc -l | tr -d ' '   # >= 8
    find packages/supervisor/assets -type f \( -name '*.sh' -o -path '*/bin/*' \) -print0 | xargs -0 -n1 bash -n ; echo "exit=$?"   # exit=0
    grep -vE '^\s*(#|$)' packages/supervisor/assets/user-data.sh | head -3 | grep -c 'shutdown -h +780'   # 1 (dead-man first)
    grep -rl 'server_temp' packages/supervisor/src packages/supervisor/assets | wc -l | tr -d ' '          # >= 1 (exclude list present)
    grep -cE '^NODE_SHA256=[0-9a-f]{64}$' packages/supervisor/assets/node.env                              # 1
    grep -cE '^NODE_VERSION=v22\.[0-9]+\.[0-9]+$' packages/supervisor/assets/node.env                       # 1
    wc -l < packages/supervisor/assets/node.env | tr -d ' '                                                # 2
    ```

- [x] **T2.6 Infra (CDK)** · model `sonnet` · deps: T1.2 · Parallel group A · **AWS: one read-only lookup**
  - Docs: `docs/infra.md` (all); `docs/storage.md` §1-§4; `docs/control-plane.md` §7;
    `docs/auth.md` §8 (security headers); `docs/decisions.md` §2, §3, §7, §12, §16.16-§16.21,
    §16.29-§16.31; `docs/spikes/cloudfront-oac-lambda-url.md` (working OAC snippet).
  - Do: the CDK app with `DstCi`, `DstGame`, `DstWeb` exactly as specified: Lambdas are
    `lambda.Function` + `Code.fromAsset` (no `NodejsFunction`, no bundling in CDK), the explicit
    extra `lambda:InvokeFunction` permission for CloudFront, the `budgetEnabled` context flag,
    the four context-resolved paths (`apiBundlePath`, `supervisorBundlePath`, `webDistPath`,
    `userDataPath`) with committed fixtures under `packages/infra/test/fixtures/` (including a
    `node.env` fixture beside the user-data fixture, in exactly the two-line format of
    `docs/decisions.md` §16.38, which `readNodeEnv` parses and validates), and every CDK
    assertion test of `docs/infra.md` §7 (tests use the fixtures). The only AWS call allowed is
    the fixture synth below, run once so the default-VPC lookup is cached in
    `packages/infra/cdk.context.json`; leave that file in the working tree (the orchestrator
    commits it). Do **not** deploy, bootstrap, or diff.
    ```bash
    AWS_PROFILE=admin pnpm --filter @dst/infra exec cdk synth -q \
      -c apiBundlePath=test/fixtures/api-bundle -c supervisorBundlePath=test/fixtures/supervisor-bundle \
      -c webDistPath=test/fixtures/web-dist -c userDataPath=test/fixtures/user-data.sh
    ```
  - Owns: `packages/infra/**` except `package.json`, `tsconfig.json`, `vitest.config.ts`.
  - Acceptance:
    ```bash
    pnpm --filter @dst/infra lint && pnpm --filter @dst/infra typecheck && pnpm --filter @dst/infra test ; echo "exit=$?"   # exit=0
    O=$(mktemp -d); pnpm --filter @dst/infra exec vitest run --reporter=json --outputFile="$O/r.json" >/dev/null 2>&1; jq -e '.numFailedTests == 0 and .numTotalTests >= 15' "$O/r.json"; echo "exit=$?"   # exit=0
    test -f packages/infra/cdk.context.json && echo ctx-ok                                   # ctx-ok
    env -u AWS_PROFILE pnpm --filter @dst/infra exec cdk synth -q -c apiBundlePath=test/fixtures/api-bundle -c supervisorBundlePath=test/fixtures/supervisor-bundle -c webDistPath=test/fixtures/web-dist -c userDataPath=test/fixtures/user-data.sh ; echo "exit=$?"   # exit=0 (no credentials, no Docker)
    jq -r '[.Resources[].Type]|join("\n")' packages/infra/cdk.out/DstWeb.template.json | grep -c 'AWS::Route53::HostedZone' ; true    # 0
    jq -r '[.Resources[].Type]|join("\n")' packages/infra/cdk.out/DstWeb.template.json | grep -c 'AWS::Route53::RecordSet'            # 2
    jq -r '[.Resources[].Type]|join("\n")' packages/infra/cdk.out/DstCi.template.json | grep -ciE 'oidcprovider|openidconnectprovider' ; true   # 0 (imported, never created)
    grep -rn "NodejsFunction\|autoDeleteObjects: true\|crossRegionReferences" packages/infra/lib packages/infra/bin | wc -l | tr -d ' '   # 0
    ```

- [ ] **T2.7 Web app** · model `sonnet` · deps: T1.2 · Parallel group A
  - Docs: `docs/web.md` §1-§6, §8; `docs/control-plane.md` §5.3, §5.4 (error codes and response
    shapes; import the types from `@dst/shared`); `docs/decisions.md` §10, §11, §16.9, §16.12, §16.21.
  - Do: the SPA exactly as specified: Mantine 8 only (none of the v9 APIs the doc lists), no
    authored CSS files, no router, dark by default without `<ColorSchemeScript>`, the screens,
    states, modals, copy text and accessible names from the doc, `useWorlds` / `useMe` /
    mutations (bodyless POSTs with `X-DST-Request: 1`, in the single API client module the doc
    names), polling rules, `useCountdown`, error mapping, Vite proxy `/api` → `localhost:8787`.
    Unit tests for hooks and status presentation.
  - Owns: `packages/web/**` except `package.json`, `tsconfig.json`, `vitest.config.ts`.
  - Acceptance:
    ```bash
    pnpm --filter @dst/web lint && pnpm --filter @dst/web typecheck && pnpm --filter @dst/web test && pnpm --filter @dst/web build ; echo "exit=$?"   # exit=0
    ls packages/web/dist/index.html                                                          # exists
    find packages/web/src \( -name '*.css' -o -name '*.scss' \) | wc -l | tr -d ' '          # 0
    grep -rn "ColorSchemeScript\|@mantine/modals\|react-router" packages/web/src | wc -l | tr -d ' '   # 0
    grep -rn "X-DST-Request" packages/web/src | wc -l | tr -d ' '                            # >= 1
    grep -rnE "^\s*body\s*:" packages/web/src | wc -l | tr -d ' '                            # 0 (POSTs are bodyless)
    ```

- [ ] **T2.8 End-to-end tests** · model `sonnet` · deps: T2.2, T2.7 · not parallel
  - Docs: `docs/web.md` §7; `docs/auth.md` §9 (cookie minting, imported from `@dst/api/auth`);
    `docs/testing.md` §3; `docs/decisions.md` §16.34.
  - Do: finish `playwright.config.ts` (the two `webServer` entries of `docs/decisions.md` §16.34;
    phone and desktop projects), the cookie-minting support helper, the test-control helper, and
    **every numbered scenario in `docs/web.md` §7**; delete the smoke spec. If a scenario exposes
    a bug in `packages/web` or the local server, report it (file, expected, actual) instead of
    editing those packages; the orchestrator dispatches the fix to a `sonnet` agent owning that
    package, then resumes you.
  - Owns: `e2e/**`, `playwright.config.ts`.
  - Acceptance:
    ```bash
    pnpm e2e ; echo "exit=$?"                                                                # exit=0
    O=$(mktemp -d); PLAYWRIGHT_JSON_OUTPUT_NAME="$O/p.json" pnpm exec playwright test --reporter=json >/dev/null 2>&1; jq -e '.stats.unexpected == 0 and .stats.expected >= 20' "$O/p.json"; echo "exit=$?"   # exit=0 (scenarios x 2 viewports)
    ```

- [ ] **T2.9 Scripts** · model `sonnet` · deps: T2.2, T2.3, T2.8 · not parallel
  - Docs: `docs/storage.md` §6, §7; `docs/control-plane.md` §9; `docs/testing.md` §4 (all), §5, §6;
    `docs/decisions.md` §8, §13, §16.22, §16.23, §16.33, §16.35.
  - Do: `scripts/import-world.ts`, `scripts/lifecycle-test.ts` (every safety rail, phase, flag,
    teardown and exit code of `docs/testing.md` §4; `assertTestKey` guards every mutating call),
    `scripts/mint-cookie.ts`, and `scripts/clean-account-check.sh` per the contract in
    `docs/testing.md` §6 (asserts, `PASS`/`FAIL <check>` lines, non-zero exit on any FAIL). Every
    script answers `--help` before any precondition, credential check or AWS client construction. Unit tests under `scripts/` for the pure parts
    (argument parsing; tarball sanitising on a cluster **generated in a temp dir** with a fake
    token; assertion helpers), including tests titled exactly `refuses a non-test key`,
    `refuses to overwrite seed/`, `refuses a test- id without --source test`. Do not run any
    script against AWS in this task.
  - Owns: `scripts/**` except `scripts/check-secrets.sh`.
  - Acceptance:
    ```bash
    pnpm exec eslint scripts && pnpm typecheck ; echo "exit=$?"                              # exit=0
    O=$(mktemp -d); pnpm exec vitest run --reporter=json --outputFile="$O/s.json" scripts >/dev/null 2>&1; jq -e '.numFailedTests == 0 and .numTotalTests >= 12' "$O/s.json"; echo "exit=$?"   # exit=0
    for t in 'refuses a non-test key' 'refuses to overwrite seed/' 'refuses a test- id without --source test'; do jq -r '[.testResults[].assertionResults[].title]|join("\n")' "$O/s.json" | grep -cx "$t"; done   # 1 1 1
    env -u AWS_PROFILE pnpm tsx scripts/import-world.ts --help | grep -c -- '--world-id'     # >= 1
    env -u AWS_PROFILE pnpm tsx scripts/mint-cookie.ts --help | grep -c -- '--steam-id'      # >= 1
    env -u AWS_PROFILE pnpm lifecycle-test --help | grep -c -- '--until-phase'               # >= 1
    env -u AWS_PROFILE pnpm tsx scripts/import-world.ts --world-id test-x --display-name x --server-name x 2>&1 | grep -ci 'source test'   # >= 1
    grep -c 'assertTestKey' scripts/lifecycle-test.ts                                        # >= 8
    bash -n scripts/clean-account-check.sh && grep -c 'exit 1' scripts/clean-account-check.sh   # >= 1
    env -u AWS_PROFILE bash scripts/clean-account-check.sh --help | grep -ci 'usage'         # >= 1
    ```

- [ ] **T2.10 Security review** · model `opus` · deps: T2.2, T2.5, T2.9 · read-only review
  - Docs: `docs/auth.md`; `docs/research/steam-openid-auth.md` §3; `docs/game-server.md` §5, §10;
    `docs/storage.md` §6, §11; `CLAUDE.md`.
  - Do: review, do not edit product code. (a) Walk `packages/api/src/auth/` against every
    numbered check in `docs/auth.md` §3; for each, name the test that fails when the check is
    removed (prove it by mutating a scratch copy outside the repo, or by precise reasoning).
    (b) Confirm the test-only secret and local-only routes cannot reach `dist/lambda/`.
    (c) Trace every path by which the Klei token or cluster password could reach a log line, an
    S3 object, DynamoDB, a process argument or a thrown error in `packages/supervisor` and
    `scripts/`. Write `docs/_security-review.md`: first a table with one row per check `C0`-`C20` of
    `docs/auth.md` §3.1 (`| check C7 | covering test | verdict |`), then a numbered defect list, each line starting
    `N. [high|medium|low]` with file, line and fix, or the single line `0. [none-found]`.
  - Owns: `docs/_security-review.md`.
  - Acceptance:
    ```bash
    grep -cE '^\| check C[0-9]+ ' docs/_security-review.md                                   # >= 21
    grep -cE '^[0-9]+\. \[(high|medium|low|none-found)\]' docs/_security-review.md           # >= 1
    git status --short | grep -v '_security-review.md' | wc -l | tr -d ' '                   # 0 (reviewer changed nothing else)
    ```
    Then **you**: for every `high` or `medium` defect dispatch one `sonnet` fix task per owning
    package (Owns = that package's paths, Docs = the review file + that package's domain doc),
    re-run that package's acceptance commands, and resume the reviewer (SendMessage) to confirm
    each fix. If the file says `none-found`, dispatch a second `opus` reviewer with the same brief
    before accepting it. Commit the review file; Phase 8 deletes it.

- [ ] **T2.11 Green gate** (orchestrator)
  - Acceptance:
    ```bash
    pnpm install --frozen-lockfile && pnpm check ; echo "exit=$?"                            # exit=0
    env -u AWS_PROFILE -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY pnpm test ; echo "exit=$?"   # exit=0 (no credentials needed)
    env -u AWS_PROFILE pnpm build ; echo "exit=$?"                                           # exit=0 (synth needs no credentials)
    ls packages/web/dist/index.html packages/supervisor/dist/runtime/supervisor.js packages/api/dist/lambda/api.js packages/api/dist/lambda/reaper.js packages/infra/cdk.out/DstWeb.template.json packages/infra/cdk.out/DstGame.template.json   # all exist
    grep -rl DST_LOCAL_ONLY packages/api/src | head -1                                       # a path (the check is not vacuous)
    grep -rl DST_LOCAL_ONLY packages/api/dist/lambda/ packages/infra/cdk.out/ ; echo "exit=$?"   # exit=1
    grep -rl dst-local-test-secret-not-for-production packages/api/dist/lambda/ packages/infra/cdk.out/ ; echo "exit=$?"   # exit=1
    scripts/check-secrets.sh                                                                 # check-secrets: ok
    ```
    Tag `local-green`.

## Phase 3: deploy from the laptop (no CI yet) → tag `infra-deployed`

You run these commands yourself (see "Long-running commands"). Use a sub-agent only to debug a
failure (`opus`; brief = the failing command, the last 40 log lines, `docs/infra.md`; Owns =
`packages/infra/**`).

- [ ] **T3.1 Review the diff, then deploy**
  Four steps, each its own command (never `cd` outside a subshell):
  ```bash
  # 1. rebuild (dist/ is gitignored) and prove nothing local-only ships
  pnpm install --frozen-lockfile && pnpm build ; echo "exit=$?"                              # exit=0
  grep -rl "DST_LOCAL_ONLY\|dst-local-test-secret-not-for-production" packages/infra/cdk.out/ ; echo "exit=$?"   # exit=1
  # 2. diff
  D=$(mktemp -d); (cd packages/infra && AWS_PROFILE=admin pnpm exec cdk diff DstCi DstGame DstWeb) >| "$D/diff.txt" 2>&1; tail -5 "$D/diff.txt"
  grep -c 'Resources' "$D/diff.txt"                                                          # >= 1 (the diff is not empty or an error)
  grep -c 'AWS::Route53::HostedZone' "$D/diff.txt" ; true                                    # 0
  grep -c 'AWS::Route53::RecordSet' "$D/diff.txt"                                            # 2 (A and AAAA for dst.ty.ler.dev; ACM writes its own validation CNAME)
  grep -ciE 'oidcprovider|openidconnectprovider' "$D/diff.txt" ; true                        # 0
  # 3. deploy, one stack per command, each with run_in_background: true; read tail -40 of its log when it exits
  (cd packages/infra && AWS_PROFILE=admin pnpm exec cdk deploy DstCi   --require-approval never) >| "$D/ci.log"   2>&1
  (cd packages/infra && AWS_PROFILE=admin pnpm exec cdk deploy DstGame --require-approval never) >| "$D/game.log" 2>&1
  (cd packages/infra && AWS_PROFILE=admin pnpm exec cdk deploy DstWeb  --require-approval never) >| "$D/web.log"  2>&1   # 5-15 min (CloudFront + ACM validation)
  ```
  If the diff shows a hosted zone, an OIDC provider, or more than the two alias record sets:
  stop, do not deploy. If `DstWeb` fails **only** on the Budget resource (tag cost filter not
  active yet), redeploy with `-c budgetEnabled=false` and leave the budget box in T3.4 unticked
  for Phase 8 to report. Acceptance: all three
  `AWS_PROFILE=admin aws cloudformation describe-stacks --region <r> --stack-name <name> --query 'Stacks[0].StackStatus' --output text`
  (DstCi and DstWeb in us-east-1; DstGame in us-west-2) print `CREATE_COMPLETE` or `UPDATE_COMPLETE`.
- [ ] **T3.2 Post-deploy checks**: dispatch a `sonnet` agent (AWS read-only) to run every command
  in `docs/infra.md` §9 and report a PASS/FAIL table. You verify at minimum:
  ```bash
  curl -s -o /dev/null -w '%{http_code}\n' https://dst.ty.ler.dev/                          # 200
  curl -s -o /dev/null -w '%{http_code}\n' https://dst.ty.ler.dev/api/me                    # 401
  curl -s -o /dev/null -w '%{redirect_url}\n' https://dst.ty.ler.dev/api/auth/steam/login | grep -c 'steamcommunity.com/openid/login'   # 1
  curl -s -o /dev/null -w '%{http_code}\n' -X POST https://dst.ty.ler.dev/api/worlds/x/start   # 401 or 403
  curl -s -o /dev/null -w '%{redirect_url}\n' 'https://dst.ty.ler.dev/api/auth/steam/callback?openid.mode=id_res&openid.claimed_id=https%3A%2F%2Fsteamcommunity.com%2Fopenid%2Fid%2F76561190000000001' | grep -c 'error='   # 1 (a forged assertion is rejected)
  U=$(AWS_PROFILE=admin aws lambda get-function-url-config --region us-east-1 --function-name dst-server-manager-api --query FunctionUrl --output text); curl -s -o /dev/null -w '%{http_code}\n' "$U"   # 403
  AWS_PROFILE=admin aws ec2 describe-security-groups --region us-west-2 --filters Name=group-name,Values=dst-server-manager-game --query 'SecurityGroups[0].IpPermissions[].[IpProtocol,FromPort,ToPort]' --output text   # udp 10998 10999 (only)
  AWS_PROFILE=admin aws s3api get-bucket-versioning --region us-west-2 --bucket dst-server-manager-data-063257577013 --query Status --output text   # Enabled
  AWS_PROFILE=admin aws lambda get-policy --region us-east-1 --function-name dst-server-manager-api --query Policy --output text | grep -o 'lambda:InvokeFunction[A-Za-z]*' | sort -u | wc -l | tr -d ' '   # 2 (InvokeFunction and InvokeFunctionUrl)
  ```
- [ ] **T3.3 Import the real world** (the only time the zip is read; flags in `docs/control-plane.md` §9)
  ```bash
  AWS_PROFILE=admin pnpm tsx scripts/import-world.ts --world-id tylerni2026 --zip ~/Downloads/dst-tylerni2026.zip ; echo "exit=$?"   # exit=0
  B=dst-server-manager-data-063257577013
  AWS_PROFILE=admin aws s3api list-object-versions --region us-west-2 --bucket $B --prefix worlds/tylerni2026/ --query 'length(Versions)'   # 1
  AWS_PROFILE=admin aws s3 ls --region us-west-2 s3://$B/seed/tylerni2026/                   # the zip
  T=$(mktemp -d); AWS_PROFILE=admin aws s3 cp --region us-west-2 s3://$B/worlds/tylerni2026/save.tar.zst "$T/s.tar.zst" >/dev/null
  tar --zstd -tf "$T/s.tar.zst" | grep -cE 'cluster_token|server_temp|client_temp|cached_userid' ; true   # 0
  tar --zstd -tf "$T/s.tar.zst" | grep -cE '^(\./)?cluster\.ini$'                            # 1 (contents at the archive root)
  mkdir "$T/x" && tar --zstd -xf "$T/s.tar.zst" -C "$T/x" && grep -E '^cluster_password' "$T/x/cluster.ini" | grep -vcE '=[[:space:]]*$' ; true   # 0 (password blank; never print the file)
  command rm -rf "$T"
  AWS_PROFILE=admin aws dynamodb get-item --region us-east-1 --table-name dst-server-manager --key '{"pk":{"S":"WORLD"},"sk":{"S":"tylerni2026"}}' --query 'Item.hasCaves.BOOL'   # true
  ```
- [ ] **T3.4 Budget plumbing** (non-blocking; tick what succeeded, note the rest for Phase 8)
  ```bash
  ARN=$(AWS_PROFILE=admin aws sns list-topics --region us-east-1 --query "Topics[?ends_with(TopicArn,':dst-server-manager-budget')].TopicArn" --output text)
  AWS_PROFILE=admin aws sns subscribe --region us-east-1 --topic-arn "$ARN" --protocol email --notification-endpoint "$(git config user.email)" >/dev/null   # never echo the address
  AWS_PROFILE=admin aws ce update-cost-allocation-tags-status --region us-east-1 --cost-allocation-tags-status TagKey=project,Status=Active   # may fail until the tag appears in billing data (about 24 h): not a blocker
  ```
  - [ ] SNS email subscription requested (tell Tyler once: "AWS sent a subscription confirmation
    email; click the link." Continue without waiting.)
  - [ ] cost-allocation tag `project` activated
  - [ ] budget deployed (`budgetEnabled` not set to false)

  Tag `infra-deployed`.

## Phase 4: first boot, test world only → tag `first-boot`

A run → fix → re-run loop with a **fresh sub-agent per round** so no agent's context carries the
whole debugging history; the history lives in `docs/_first-boot-notes.md` (append-only).
Everything here uses world `test-lifecycle-a`; the real world is not touched.

- [ ] **T4.1 Run** (orchestrator): start in the background
  `AWS_PROFILE=admin pnpm lifecycle-test --until-phase 1 > "$L/boot.log" 2>&1` (`L=$(mktemp -d)`).
  When it exits: `tail -40 "$L/boot.log"`. Exit 0 twice in a row → go to T4.3. Otherwise T4.2.
- [ ] **T4.2 Fix round** (repeat up to 5 rounds, then stop and tell Tyler what is failing) ·
  model `opus` · **AWS: yes**
  - Docs: `docs/_first-boot-notes.md` (history), `docs/game-server.md` (all, esp. §13),
    `docs/testing.md` §4, `docs/control-plane.md` §2-§3, `docs/spikes/game-server-spike.md` §10.
  - Do: you are given the last 40 lines of the failing run. Reproduce with
    `AWS_PROFILE=admin pnpm lifecycle-test --until-phase 1 --keep-going` if needed, debug on the
    instance with SSM Session Manager, find the root cause, fix it in the owning package, run
    that package's tests, rebuild (`pnpm build`) and redeploy the affected stack
    (`cd packages/infra && AWS_PROFILE=admin pnpm exec cdk deploy DstGame --require-approval never`
    republishes `runtime/`; `DstWeb` for API changes). Never print the token or password (no
    `cat cluster.ini`, no `cat cluster_token.txt`, no `set -x`). Always finish with
    `AWS_PROFILE=admin pnpm lifecycle-test --cleanup-only`. **Append** to
    `docs/_first-boot-notes.md`: symptom, root cause, fix, files changed, measured timings.
  - Owns: `packages/supervisor/**`, `packages/api/**`, `packages/infra/**`, `scripts/**`,
    `packages/shared/**` (fixes only), `docs/_first-boot-notes.md`.
  - Acceptance: `pnpm check ; echo "exit=$?"` → `exit=0`; then commit, push, and go back to T4.1.
- [ ] **T4.3 Gate**
  ```bash
  AWS_PROFILE=admin aws s3 ls --region us-west-2 s3://dst-server-manager-data-063257577013/binaries/ | grep -c 'dst-binaries.tar.zst'   # 1 (the second run used the tarball path)
  AWS_PROFILE=admin pnpm lifecycle-test --cleanup-only ; echo "exit=$?"                      # exit=0
  AWS_PROFILE=admin aws ec2 describe-instances --region us-west-2 --filters Name=tag:project,Values=dst-server-manager Name=instance-state-name,Values=pending,running,stopping,stopped --query 'length(Reservations[].Instances[])'   # 0
  pnpm check ; echo "exit=$?"                                                                # exit=0
  ```
  Tag `first-boot`.

## Phase 5: full lifecycle on real AWS → tag `lifecycle-verified`

Same loop. The full run takes about 100 minutes and costs well under $1.

- [ ] **T5.1 Run** (orchestrator): background
  `AWS_PROFILE=admin pnpm lifecycle-test > "$L/full.log" 2>&1`; when it exits, show
  `grep -E '^(PASS|FAIL|SKIP)' "$L/full.log" | cut -d' ' -f1 | sort | uniq -c` and
  `grep -E '^FAIL' "$L/full.log"`. It covers: start, joinable, pre-start version recorded,
  idempotent and concurrent starts, in-place switch, idle shutdown, instance gone, post-stop
  version, restore chain, stop button, tarball content and secret-absence checks, bucket-policy
  and lifecycle configuration (the pruning rule), reaper stale-heartbeat, reaper max-age, reaper
  orphan, final clean state. Any FAIL → T5.2. Exit 0 with no FAIL and no SKIP → T5.3.
- [ ] **T5.2 Fix round** (repeat up to 5 rounds) · model `opus` · same Docs, Do, Owns and
  acceptance as T4.2, plus `docs/storage.md` §2, §3, §5; it is given the FAIL lines and may re-run
  only the failing phases while fixing. Then back to T5.1 for one complete uninterrupted run.
- [ ] **T5.3 Gate**
  ```bash
  bash scripts/clean-account-check.sh ; echo "exit=$?"                                       # exit=0, every line PASS
  bash scripts/clean-account-check.sh 2>&1 | grep -cE '^(PASS|FAIL) '                        # >= 13 (the script really checks things)
  AWS_PROFILE=admin aws s3api list-object-versions --region us-west-2 --bucket dst-server-manager-data-063257577013 --prefix worlds/tylerni2026/ --query 'length(Versions)'   # 1 (tests never touched the real world)
  AWS_PROFILE=admin aws dynamodb get-item --region us-east-1 --table-name dst-server-manager --key '{"pk":{"S":"STATE"},"sk":{"S":"CLUSTER"}}' --query 'Item.status.S' --output text   # stopped
  pnpm check ; echo "exit=$?"                                                                # exit=0
  ```
  Tag `lifecycle-verified`.

## Phase 6: turn on CI deploys → tag `ci-live`

- [ ] **T6.1 Deploy workflow** · model `sonnet` · deps: T5.3
  - Docs: `docs/infra.md` §6; `docs/testing.md` §7; `docs/decisions.md` §12, §16.24.
  - Do: write `.github/workflows/deploy.yml` exactly as specified, pinning each action to its
    current major (the doc names the repos and the `gh api` command). It deploys `DstGame DstWeb`
    only, never `DstCi`, and never runs Playwright.
  - Owns: `.github/workflows/deploy.yml`.
  - Acceptance (you). Everything is already deployed, so this push is the first CI deploy. The
    runtime `BucketDeployment` asset (it contains a `VERSION` git sha) and the Lambda code assets
    may change; nothing structural may.
    ```bash
    pnpm check ; echo "exit=$?"                                                              # exit=0
    (cd packages/infra && AWS_PROFILE=admin pnpm exec cdk diff DstGame DstWeb 2>&1 | grep -cE '\[[-+~]\] AWS::(IAM|EC2|Route53|S3::BucketPolicy|CloudFront|DynamoDB)') ; true   # 0
    git push
    ```
    Then wait in the background for the run of **this** commit (not the previous one):
    ```bash
    SHA=$(git rev-parse HEAD)
    until ID=$(gh run list --workflow deploy.yml --limit 20 --json headSha,databaseId -q ".[]|select(.headSha==\"$SHA\")|.databaseId" | head -1); [ -n "$ID" ]; do sleep 10; done
    until [ "$(gh run view "$ID" --json status -q .status)" = completed ]; do sleep 20; done; echo "$ID"
    ```
    and check:
    ```bash
    gh run view "$ID" --json conclusion -q .conclusion                                       # success
    curl -s -o /dev/null -w '%{http_code}\n' https://dst.ty.ler.dev/api/me                   # 401
    ```
    On failure: `gh run view "$ID" --log-failed | tail -40` → `sonnet` fix agent (Owns: the workflow
    file). Tag `ci-live`. From now on every push deploys: `pnpm check` before every push.

## Phase 7: the real world → tag `real-world-verified`

- [ ] **T7.1 Ask Tyler first** (so the world cannot idle out before he arrives). One message:
  > I'm ready to boot your real world. When you're at your gaming machine with ~15 minutes,
  > reply `go`. Then: (1) on your phone open https://dst.ty.ler.dev, sign in with Steam, and
  > confirm you see the world running with server name, IP, password and a countdown; if it
  > shows Stopped, press Start. (2) In DST: Browse Games → search the server name → enter the
  > password from the UI (or paste the console command). Play a minute, visit the caves if
  > convenient, then quit normally. (3) Reply `done`. Don't press Stop: the point is to watch it
  > stop on its own 30 minutes later.
- [ ] **T7.2 Boot `tylerni2026`** after he replies `go` (full commands and variables: `docs/testing.md` §5)
  ```bash
  C=$(AWS_PROFILE=admin pnpm -s tsx scripts/mint-cookie.ts)      # never echo $C
  curl -s -o /dev/null -w '%{http_code}\n' -X POST -H "Cookie: $C" -H 'Origin: https://dst.ty.ler.dev' -H 'X-DST-Request: 1' https://dst.ty.ler.dev/api/worlds/tylerni2026/start   # 200
  ```
  Background until-loop until `curl -s -H "Cookie: $C" https://dst.ty.ler.dev/api/worlds | jq -r '.active.status'`
  prints `running` (about 3 minutes; give up after 15 and dispatch an `opus` debug agent as in
  T4.2). Then verify with exactly this projection; **never print `.active.join.password` or
  `.active.join.connectCommand`** (it embeds the password; Tyler reads both from the UI), and never
  write `$C` to a file:
  ```bash
  curl -s -H "Cookie: $C" https://dst.ty.ler.dev/api/worlds | jq '{status:.active.status, ip:.active.join.ip, serverName:.active.join.serverName, players:.active.playerCount, deadline:.active.idleDeadline, hasPassword:((.active.join.password // "")|length>0)}'
  # status running, ip an IPv4 address, serverName non-empty, players 0, deadline ~30 min after joinable, hasPassword true
  ```
  Run the Klei lobby check of `docs/testing.md` §5. Tell Tyler it is up.
- [ ] **T7.3 Verify the unattended shutdown** after he replies `done`: background until-loop on
  the state item until `status` is `stopped` (about 30 minutes after he left; give up after 50
  and investigate), then:
  ```bash
  AWS_PROFILE=admin aws dynamodb get-item --region us-east-1 --table-name dst-server-manager --key '{"pk":{"S":"STATE"},"sk":{"S":"CLUSTER"}}' --query 'Item.[status.S,lastStopReason.S]' --output text   # stopped idle
  AWS_PROFILE=admin aws s3api list-object-versions --region us-west-2 --bucket dst-server-manager-data-063257577013 --prefix worlds/tylerni2026/ --query 'length(Versions)'   # 2
  AWS_PROFILE=admin aws s3 ls --region us-west-2 --recursive s3://dst-server-manager-data-063257577013/sessions/tylerni2026/ | grep -c manifest.json   # 1
  bash scripts/clean-account-check.sh ; echo "exit=$?"                                       # exit=0
  bash scripts/clean-account-check.sh 2>&1 | grep -cE '^(PASS|FAIL) '                        # >= 13 (the script really checks things)
  ```
  If sign-in or joining failed: `opus` debug agent with Tyler's description (Docs: `docs/auth.md`,
  `docs/game-server.md` §13; Owns as T4.2), `pnpm check`, push (CI deploys), repeat T7.1-T7.3.
  Tag `real-world-verified`.

## Phase 8: hand-over → tag `v1.0.0`

- [ ] **T8.1 Final cleanup** · model `opus` · deps: T7.3 · **AWS: read-only**
  - Docs: `CLAUDE.md`, every `docs/*.md`, `docs/_first-boot-notes.md`, `docs/_security-review.md`.
  - Do: bring `CLAUDE.md` and `docs/*.md` in line with what was actually built (every fix
    recorded in `docs/_first-boot-notes.md`; measured timings replace estimates; every command
    in the runbooks of `docs/storage.md` §10 and `docs/auth.md` §10 re-checked against the real
    script flags with `--help`). Fold anything still worth keeping from the `_` files into the
    right doc, then delete `PROMPT.md`, `PLAN.md` and every `docs/_*.md`, and replace every
    remaining reference to `PLAN.md`, `PROMPT.md` or other non-existent files in `CLAUDE.md` and `docs/` (including
    `docs/decisions.md`) with self-contained wording. Add `docs/follow-ups.md` listing anything
    left unticked in T3.4 with the exact command to finish it, and link it from `CLAUDE.md`. Add
    a short "Small follow-up iterations" section to `CLAUDE.md` (add a world, add a friend, change
    the instance type, where the runbooks are). Run `bash scripts/clean-account-check.sh` and
    include its output in your report.
  - Owns: `CLAUDE.md`, `docs/**`, `PROMPT.md`, `PLAN.md` (deletion).
  - Acceptance (you; this task deletes this file, so tick the box and copy these commands into
    your reply **before** dispatching):
    ```bash
    test ! -e PROMPT.md && test ! -e PLAN.md && ls docs/_* 2>/dev/null | wc -l | tr -d ' '   # 0
    grep -rln 'PLAN\.md\|PROMPT\.md' CLAUDE.md docs/ | wc -l | tr -d ' '                     # 0
    test -f docs/follow-ups.md && grep -c 'follow-ups.md' CLAUDE.md                          # >= 1
    pnpm check ; echo "exit=$?"                                                              # exit=0
    bash scripts/clean-account-check.sh ; echo "exit=$?"                                     # exit=0
    bash scripts/clean-account-check.sh 2>&1 | grep -cE '^(PASS|FAIL) '                      # >= 13
    scripts/check-secrets.sh                                                                 # check-secrets: ok
    ```
    Commit, push, wait for the CI run of that commit with the `headSha` loop of T6.1 (`success`). Tag `v1.0.0`, push the tag, and tell
    Tyler: what was built, the measured click-to-joinable time, where the runbooks are, and
    anything listed in `docs/follow-ups.md`.
