# Testing

Implements `docs/decisions.md` section 13 and sections 16.4 / 16.23 / 16.24. Owns the cross-cutting
verification strategy, the root-level command contract, and `scripts/lifecycle-test.ts`.

Related docs (each owns its own unit-test list, and the shapes asserted here):
`docs/control-plane.md` (shared types/constants, API JSON, DynamoDB expressions, reaper) ·
`docs/auth.md` (sessions, `APP_ENV`, headers) · `docs/game-server.md` (supervisor) ·
`docs/storage.md` (S3, tarball, manifest) · `docs/web.md` (SPA **and the Playwright suite**) ·
`docs/infra.md` (CDK assertions, the deploy workflow). This doc names only the must-haves from
decisions 13. Two rules shape everything:

1. **Everything local is credential-free.** `pnpm check` must pass with no AWS profile, no network,
   and no environment beyond the repo. If a unit test can reach AWS or the internet, it is a bug.
2. **Everything on real AWS is verified by a command, not by reading code.** Every check below is a
   shell command with an expected exit code, output substring, or JSON field value.

All AWS CLI examples use `AWS_PROFILE=admin` and an explicit `--region`. Account `063257577013`.
Shorthands used below (define them in your shell first):

```bash
B=dst-server-manager-data-063257577013   # data bucket, us-west-2
T=dst-server-manager                     # DynamoDB table, us-east-1
ORIGIN=https://dst.ty.ler.dev
```

## 1. Root command contract

### 1.0 The root package

The repo root is itself a package (it is not in `pnpm-workspace.yaml`'s `packages:` globs). It owns
the lint/test toolchain, Playwright, and everything `scripts/` and `e2e/` import. Its complete
dependency list:

```
dependencies:
  @dst/shared@workspace:*   @dst/api@workspace:*        # so scripts/ and e2e/ can import them
  @aws-sdk/client-s3   @aws-sdk/client-dynamodb   @aws-sdk/lib-dynamodb
  @aws-sdk/client-ssm  @aws-sdk/client-ec2        @aws-sdk/client-lambda
devDependencies:
  typescript  eslint  @eslint/js  typescript-eslint  prettier  eslint-config-prettier
  vitest  @playwright/test  tsx  esbuild  concurrently
  aws-cdk-lib  constructs                         # types only, for repo-wide typecheck
```

- The two `workspace:*` dependencies are decisions §16.32: `scripts/lifecycle-test.ts`,
  `scripts/mint-cookie.ts` and `e2e/support/session.ts` **import** the session signer from
  `@dst/api/auth` and never re-implement it. Each package exposes TypeScript source through an
  `exports` map — `@dst/api` maps `"."`, `"./auth"` and `"./test-secret"`, `@dst/shared` maps `"."`
  (`docs/control-plane.md` §1.0) — and `tsx`, Vitest and esbuild all resolve it. Only `e2e/` uses
  `@dst/api/test-secret`; both `scripts/` importers use `@dst/api/auth` alone and read the real
  secret from SSM (decisions §16.37).
- `@aws-sdk/client-lambda` is what phase 8 of §4 uses to invoke the reaper directly;
  `client-ec2`/`client-s3`/`client-dynamodb`/`client-ssm` are the rest of the lifecycle script's
  assertions.
- `concurrently` is what makes `pnpm dev` run the local API and Vite in parallel.
- `esbuild` is the repo's one bundler (decisions §16.29). It is a devDependency here and of
  `@dst/api` and `@dst/supervisor`, the two packages with an `esbuild.mjs`. **`packages/infra` has
  no bundler at all** — CDK deploys pre-built directories (`docs/infra.md` §4.2).

### 1.1 Scripts

These pnpm scripts must exist at the repo root and behave exactly as stated; the orchestrator
verifies each by running it and checking the exit code.

| Command | Must do | Pass condition |
|---|---|---|
| `pnpm dev` | local API (`packages/api/src/local.ts`, `APP_ENV=local`, port 8787) + `vite dev` (port 5173) in parallel | both serve; `docs/web.md` §6 |
| `pnpm lint` | ESLint flat config + Prettier check over every package and `e2e/`, `scripts/` | exit 0, no warnings (`--max-warnings 0`) |
| `pnpm typecheck` | `tsc --noEmit` in every package (TypeScript strict) | exit 0 |
| `pnpm test` | Vitest `run` (never watch) at the **root** *and* `pnpm -r test` — see below | exit 0; no AWS credentials or network used |
| `pnpm build` | build every package first — web (Vite), the `@dst/api` esbuild bundles, the supervisor bundle — and run `cdk synth` **last** (decisions §16.30) | exit 0; artifacts below exist |
| `pnpm e2e` | Playwright against the local app (`APP_ENV=test`), starting its own servers | exit 0 |
| `pnpm check` | `lint` → `typecheck` → `test` → `build` → `e2e`, in that order, stopping at the first failure | exit 0 |
| `scripts/check-secrets.sh` | scan tracked + staged files (already written; pre-push hook + CI) | exit 0, prints `check-secrets: ok` |
| `pnpm lifecycle-test` | `tsx scripts/lifecycle-test.ts` — section 4, **requires** `AWS_PROFILE=admin` | exit 0 and a PASS table |
| `pnpm tsx scripts/import-world.ts` | register a world + upload its save (`docs/control-plane.md` §9, `docs/storage.md` §7) | not a root script; run directly |

The order is load-bearing: `cdk synth` reads the other packages' output directories as assets and
throws if one is missing (`docs/infra.md` §1.1, §3.2, §4.2), so it runs after everything else.

**`pnpm test` is two runs, and `scripts/` is one of them** (decisions §16.40). `scripts/` and `e2e/`
are not workspace packages, so `pnpm -r test` alone would never execute the safety-refusal tests of
`docs/control-plane.md` §9 / §4.1 rule 2. Therefore:

- a **root `vitest.config.ts`** exists whose `include` is `['scripts/**/*.test.ts']` and whose
  `setupFiles` is `['./vitest.setup.ts']` — the same shared setup file every package uses (§1bis),
  so the network/AWS guard covers `scripts/` too;
- the root `test` script is `vitest run --passWithNoTests && pnpm -r test`, so `pnpm test` covers
  **every package *and* `scripts/`**;
- **every** package's `test` script passes `--passWithNoTests` (`vitest run --passWithNoTests`).
  An empty Vitest run exits 1 exactly as an empty Playwright suite does, so without the flag a
  freshly scaffolded package fails its own acceptance before it has a single test. The flag is
  harmless once tests exist and is never removed later.
- `e2e/` is **not** in the root Vitest `include` — it is Playwright's, via `pnpm e2e` (§7).

`pnpm build` must leave, at minimum, these four artifacts (each `ls` exits 0), and must run with no
AWS credentials and **without Docker** — nothing bundles inside CDK (decisions §16.29) and `cdk
synth` uses only deterministic names and the Canonical SSM public-parameter *lookup token*,
resolved at deploy time, so synth never calls AWS:

```bash
ls packages/web/dist/index.html packages/supervisor/dist/supervisor.js \
   packages/api/dist/lambda/api.js packages/api/dist/lambda/reaper.js \
   packages/infra/cdk.out/DstWeb.template.json
pnpm check ; echo "exit=$?"                                                 # exit=0
env -u AWS_PROFILE -u AWS_ACCESS_KEY_ID -u AWS_SECRET_ACCESS_KEY pnpm test  # exit 0
AWS_PROFILE=definitely-not-a-profile pnpm test                              # exit 0 (unused)
scripts/check-secrets.sh | grep -q 'check-secrets: ok'                      # exit 0
```

`pnpm check` is the local gate before every push. It is *not* what CI runs (section 7).

### 1bis. Unit tests must fail on real network or AWS access

One repo-root `vitest.setup.ts`, referenced from every package's Vitest config via `setupFiles`:

- `vi.stubGlobal('fetch', ...)` throwing `Error('network access is blocked in unit tests')`; same
  for `globalThis.WebSocket`; stub `node:http`/`node:https` `request`/`get` and undici's `Agent` so
  an SDK that bypasses `fetch` throws the same message.
- set, before any import: `AWS_EC2_METADATA_DISABLED=true`, `AWS_SDK_LOAD_CONFIG=0`,
  `AWS_SHARED_CREDENTIALS_FILE=/dev/null`, `AWS_CONFIG_FILE=/dev/null`, `AWS_REGION=us-east-1`,
  bogus `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, and `delete process.env.AWS_PROFILE`.

Two guard tests in `packages/shared`, with these exact names so the orchestrator can prove the
guard is wired rather than trust it: `blocks real network access in unit tests` (fetch rejects with
the guard message) and `blocks real AWS SDK calls in unit tests` (a real `@aws-sdk/client-dynamodb`
`DescribeTableCommand` rejects with the guard error, not a credential error). Both names must
appear in `pnpm test --reporter=verbose 2>&1` (`grep -c '<name>'` → `1`).

Fakes, not SDK mocks: the API handler is written against ports (state store, registry, EC2
launcher, parameter store, clock — decisions 10) and tests inject in-memory adapters.

## 2. Test pyramid

Minimum scenarios that MUST exist. The owning doc holds the full list; a missing must-have is a
failed package.

| Package | Fakes / harness | Must-have scenarios | Owner doc |
|---|---|---|---|
| `shared` | none | slug validation (`[a-z0-9-]{1,32}`), `sessionId` format (`YYYYMMDDTHHMMSSZ-<6 hex>`), status enum, state-item schema round trip, the network guard tests | `docs/control-plane.md` |
| `api` (auth) | fixture assertions captured in `docs/research/steam-openid-auth.md` §3bis; `fetch` port faked | forged signature rejected; replayed `response_nonce` rejected; nonce outside ±300 s rejected; `check_authentication` posted only to the hardcoded Steam endpoint; loose/mismatched `claimed_id` rejected; unsigned field injection rejected; duplicate params rejected; state cookie single-use; `return_to`/`realm` built from `PUBLIC_ORIGIN`, never from headers; allowlist miss → `/?error=not-allowed`; the router wires it, in a test titled exactly `routes GET /api/me to the auth module` (`docs/control-plane.md` §8) | `docs/auth.md` |
| `api` (session) | HKDF with a fixed test secret | HMAC tamper rejected; expiry honoured; **cross-env rejection: a token minted with `APP_ENV=test` is rejected by a verifier with `APP_ENV=prod`, and vice versa, even when both use the same raw secret**; cookie name/flags differ per env | `docs/auth.md` |
| `api` (state machine) | in-memory store that can *simulate a failed conditional write*, fake clock | every transition of decisions 6: start from `stopped`; start of the already-active world → 200 no-op; start another world while `running`/`stopping` → `desiredWorldId` only, no launch; start while `starting` a different world → 409; stop of a non-active world → 200 no-op; launch failure → `stopped` + `launch-failed`; **races**: conditional-write loss on start → re-read and fall through; supervisor final `stopped` write losing to a new desire → starts that world instead of terminating; every supervisor write scoped to its own `sessionId`/`instanceId`; `stale: true` when `heartbeatAt` > 2 min | `docs/control-plane.md` |
| `api` (reaper) | fake clock, fake EC2 + store | orphan (**instance id mismatch AND `sessionId` tag mismatch**) → terminate, plus a test titled exactly `switched instance is not an orphan`; rule order orphan → max-age → stale, first match wins; age > 12 h → `desiredWorldId` nulled **and `lastStopReason=reaper-max-age` written**, no terminate; age > 12 h 10 min → terminate `reaper-max-age`; heartbeat > 10 min **and** instance > 15 min → terminate `reaper-stale`; instance < 15 min old with a stale heartbeat → untouched; reconcile `running` with no live instance → `stopped`; reconcile `starting` only after 3 min, in a test titled exactly `starting without an instance is reconciled after the grace`; `now` override clamped to `max(realNow, eventNow)` so it can never make the reaper *less* aggressive; the returned `{ nulledDesire, terminated, reconciled }` matches | `docs/control-plane.md` |
| `supervisor` | log fixtures from `docs/spikes/game-server-spike.md`, fake FIFO, fake clock, fake S3 | five titles are verbatim (`docs/game-server.md` §12): `unknown reading is never treated as zero`, `three consecutive zero polls are required`, `player count ignores shard_players`, `a world requested during shutdown is started instead of terminating`, `save is not pushed when the world never finished loading`; plus `playerCount = max(master.clients, caves.clients, master.allplayers + caves.allplayers)` on every row of spike §9's table; `RemoteCommandInput:` echo skipped when matching the nonce; joinable predicate (geo-DNS registration + Caves connected + nonce round trip on every shard); idle deadline = `max(joinableAt, last non-zero) + idleMinutes`; **shard crash → stop path with `crash`**; stop sequence ordering (per-shard `c_shutdown(true)` → `Shutting down` → close that FIFO) incl. the 60 s → SIGTERM → 30 s → SIGKILL fallback; non-zero exit after `Shutting down` is benign; the staged `cluster.ini`'s password line blanked (`ini.ts`); `hasCaves=false` runs Master only. The tar **exclude list** is shell, not `core/`, so it is proven end to end by §4.4 phase 4's member-set assertion, not by a unit test (`docs/game-server.md` §12) | `docs/game-server.md` |
| `web` | MSW-style fake `/api/worlds`, fake timers | derived per-world status; countdown from `idleDeadline`; poll interval 5 s / 30 s and paused when hidden; stop/switch confirmation modal; sign-in screen when 401 | `docs/web.md` |
| `infra` | `aws-cdk-lib/assertions` `Template` | bucket policy deny with the exact `NotResource` exemptions; all three lifecycle rules (`worlds/` 10/30, `inflight/` 3/7, bucket-wide abort-MPU 7 d that expires nothing); SG = UDP 10998-10999 only; **both** Lambda permissions (`InvokeFunctionUrl` *and* `InvokeFunction`, each with `AWS:SourceArn` = the distribution); launch-template + `RunInstances` tag specs; `CachingDisabled` + `AllViewerExceptHostHeader`; no SSM parameter resources in any template; DNS: exactly **two** `AWS::Route53::RecordSet`s, the `dst.ty.ler.dev` A and AAAA aliases (ACM writes its validation CNAME itself — decisions §16.31); both Lambdas' handlers are `api.handler` / `reaper.handler`; all four asset paths come from committed fixtures, so no test needs another package to have been built | `docs/infra.md` |
| `e2e/` | local API (`APP_ENV=test`) + Vite, started by Playwright | sign-in, world list, start → starting → running (local fake launcher), countdown visible, stop confirmation, switch confirmation, join info + copy button; both Playwright projects — `phone` (`devices['Pixel 5']`) and `desktop` (1280×800) — per `docs/web.md` §7 | `docs/web.md` |

## 3. Playwright with no production backdoor

Mechanism (decisions 9 and 16.1): the local API entrypoint `packages/api/src/local.ts` runs with
`APP_ENV=test` and the **test-only** session secret `TEST_SESSION_SECRET`, the committed literal in
`packages/api/src/auth/testSecret.ts` (`docs/auth.md` §4 — it is not a secret); Playwright mints
`dst_session` itself.

**Why the literal can never appear in `dist/lambda/` (decisions §16.37):** the secret reaches the
API only through a `SecretSource` port, so `secrets.ts` has no `APP_ENV` branch naming it; the
constant is exported solely through the subpath `@dst/api/test-secret`, is **not** re-exported from
`src/auth/index.ts`, and is imported only by `src/local.ts`, `e2e/` and tests — and
`src/handlers/api.ts` (the only thing esbuild bundles) imports none of those, so the module is not
in the entry's import graph at all and the fourth grep below is a structural fact rather than a
hope in tree-shaking.

Production derives its key by HKDF with `info` containing `prod` and rejects
any token whose env string differs from its own, so a test token is rejected twice over even if the
test literal leaks. The affordances that exist only locally — the dev-login route, the
`/api/test/control` route and the fake EC2 launcher (`docs/control-plane.md` §5.5) — live in
modules that each import and reference the shared constant `LOCAL_ONLY_MARKER = 'DST_LOCAL_ONLY'`
at module scope, so no bundler can tree-shake or rename it away (decisions 16.4). That gives the
orchestrator exact commands. Run them **after `pnpm build`**, so both directories exist:

```bash
grep -rl DST_LOCAL_ONLY packages/api/src | head -1            # exit 0 — check is not vacuous
grep -rl DST_LOCAL_ONLY packages/api/dist/lambda/ ; echo "exit=$?"   # exit=1 (not in the bundles)
grep -rl DST_LOCAL_ONLY packages/infra/cdk.out/ ; echo "exit=$?"     # exit=1 (not in what deploys)
grep -rl dst-local-test-secret-not-for-production \
  packages/api/dist/lambda/ packages/infra/cdk.out/ ; echo "exit=$?"   # exit=1 (test literal absent)
```

All four are kept even though, with one bundler, the second and third now look at the **same
bytes**: `packages/api/dist/lambda/` is the esbuild output and `cdk.out/` holds the staged copy of
that directory plus its zip (decisions §16.29, `docs/infra.md` §4.2). The first proves the check is
not vacuous — if the marker vanished from `src/` the other three would pass for the wrong reason.
The third is what closes review defect B3: `cdk.out/` is what CloudFormation uploads, so it is the
artifact the claim "absent from the built Lambda bundles" is actually about. The fourth pins the
test-only session secret literal out of both. A non-empty `cdk.out/` is a precondition; if the
third command's directory is missing, the check has silently not run.

Live proof against production, asserted by the lifecycle script (section 4, phase 0): a request to
`$ORIGIN/api/me` carrying a token minted with the `test` env and a random secret returns **401**.

## 4. `scripts/lifecycle-test.ts`

`AWS_PROFILE=admin pnpm lifecycle-test [flags]`, run with `tsx`. It exercises the real system end to
end through `$ORIGIN/api/...` and asserts against DynamoDB, EC2 and S3 with the AWS SDK.

Flags: `--cleanup-only` (teardown only, and also purge the retained prune evidence),
`--skip-reaper` (skip phases 7-9; ~50 min instead of ~100), `--until-phase N` (run phases 0..N, then
teardown; `--until-phase 1` is **the first-boot check** — the first time a real instance ever
launches), `--timeout-minutes N` (default 150; on expiry it aborts into teardown and exits 2),
`--keep-going` (record a failure and continue), `--help` (prints the usage line and every flag
above, exits 0, makes no AWS call — decisions §16.33).

**`--help` is parsed and answered first, before anything else** (decisions §16.40): before the §4.1
safety rails, before the `AWS_PROFILE` precondition, before any credential resolution and before any
AWS SDK client is constructed. So `env -u AWS_PROFILE -u AWS_ACCESS_KEY_ID pnpm tsx
scripts/lifecycle-test.ts --help` exits 0 even though the script otherwise *requires*
`AWS_PROFILE=admin`. The same ordering is required of `scripts/mint-cookie.ts` (§5.1),
`scripts/import-world.ts` (`docs/control-plane.md` §9) and `scripts/clean-account-check.sh` (§6) —
including `bash scripts/clean-account-check.sh --help`, which must make no AWS call.
Output: one line per assertion (`PASS`/`FAIL`/`SKIP`, phase, name, elapsed), then a final table.
Exit 0 only if every executed assertion passed and teardown succeeded; 1 on assertion failure; 2 on
timeout; 3 on a refused precondition.

### 4.1 Safety rails (evaluated before anything else)

1. **The cluster must be idle.** Read `pk=STATE, sk=CLUSTER`; if `status !== 'stopped'`, print
   `REFUSED: cluster status is <status> — someone may be playing` and exit 3. Also refuse if any
   instance tagged `project=dst-server-manager`, `role=game` is `pending`/`running`. The script uses
   the single Klei token like any session, so **it must never run while anyone is playing**; there
   is no lock beyond this check and the API's conditional writes.
2. **`test-` only.** Every world id it registers, starts, stops or deletes must match
   `/^test-[a-z0-9-]{0,27}$/`. A central `assertTestKey(key)` guards every mutating S3/DynamoDB call
   and throws on anything else, before the call is made. `worlds/tylerni2026/`, `seed/` and any
   non-`test-` registry item are never read and never written. A unit test named exactly
   `refuses a non-test key` pins this (the `scripts/` suite; the other two required names are
   `refuses to overwrite seed/` and `refuses a test- id without --source test` —
   `docs/control-plane.md` §9).
3. **Teardown always runs** (`try/finally`), including on timeout or `SIGINT`/`SIGTERM`. See 4.5.
4. **Nothing sensitive is ever printed.** Klei token, cluster password, session secret, minted
   cookie and SteamID stay in memory; the join `password` is `***` in all output. Token/password
   leak checks compare downloaded bytes and print only the boolean.

### 4.2 Auth

The script reads `/dst/session-secret` (SSM SecureString, us-east-1, `--with-decryption`) and
`/dst/users` (SSM String, us-east-1) with the admin profile, takes the **first** SteamID64 key,
derives the prod session key by HKDF exactly as `packages/api` does — `import { mintSessionToken }
from '@dst/api/auth'`, resolved through the root package's `workspace:*` dependency and the
package's `exports` map (`"."`, `"./auth"`, `"./test-secret"`; decisions §16.32,
`docs/control-plane.md` §1.0), **never a re-implementation** — and mints a `__Host-dst_session`
cookie. It imports **only** `@dst/api/auth`: the secret comes from SSM, never from
`@dst/api/test-secret`, which no script ever imports (decisions §16.37).
`scripts/mint-cookie.ts` (§5) uses the same code path. Every request sets `Origin: $ORIGIN` and `X-DST-Request: 1`, as the CSRF check
requires.

This is not a backdoor: the capability used is `ssm:GetParameter` with admin credentials, and
whoever holds admin on `063257577013` can already terminate the instance, read the table and
rewrite the Lambda. No code path is added to production; the API still verifies the same HMAC it
always does. A test route in the deployed Lambda *would* be a backdoor — hence section 3's grep.

### 4.3 Test worlds

Registered by the script itself (`pk=WORLD`), not by deploy, not by `scripts/import-world`:
`test-lifecycle-a` (`hasCaves=true`, `source=test`, `idleMinutes=3`) and `test-lifecycle-b`
(`hasCaves=false`, `source=test`, `idleMinutes=3`). Neither has a save at first run, so the
supervisor's generate-from-templates path runs (decisions 5) — deliberate: it is the only automated
exercise of that path.

### 4.4 Phases

Timeouts are sized from the spike: click-to-joinable is **165 s** from the binaries tarball and
**308 s** cold; first-boot world *generation* has no measurement, so allow **15 min** and treat the
supervisor's own 15-min boot timeout as the backstop. Polling helper:
`waitFor(predicate, timeout, interval=10s)` over `GET /api/worlds` or a `GetItem` on the state
singleton; every wait logs elapsed time so slow phases are visible.

**Phase 0 — preflight (≤ 1 min).**
`GET $ORIGIN/api/me` with the minted cookie → 200 and a `nickname`. With no cookie → 401. With an
`APP_ENV=test` token → 401 (section 3). Registry writes for A and B; `GET /api/worlds` lists both.

**Phase 1 — first start of A (≤ 15 min).**
`POST /api/worlds/test-lifecycle-a/start` → 200. Then:

- state `status` becomes `starting` within 10 s; `worldId=test-lifecycle-a`; `sessionId` non-empty.
- within 60 s exactly one instance exists (`$IID`) with tags `project=dst-server-manager`,
  `role=game`, `Name=dst-game`, `sessionId=<the state's sessionId>`, `InstanceType` equal to the
  shared constant (`c6i.large`), `State.Name` in `pending|running`.
- its security group allows **only** UDP 10998-10999 from `0.0.0.0/0`:

  ```bash
  SG=$(AWS_PROFILE=admin aws ec2 describe-instances --region us-west-2 --instance-ids "$IID" \
    --query 'Reservations[0].Instances[0].SecurityGroups[0].GroupId' --output text)
  AWS_PROFILE=admin aws ec2 describe-security-groups --region us-west-2 --group-ids "$SG" \
    --query 'SecurityGroups[0].IpPermissions' --output json | jq -e \
    'length==1 and .[0].IpProtocol=="udp" and .[0].FromPort==10998 and .[0].ToPort==10999
     and (.[0].IpRanges|map(.CidrIp))==["0.0.0.0/0"]'        # exit 0
  ```
- **idempotency**: while `starting`, a second `POST .../start` → 200 and the instance count stays 1.
- **concurrency**: fire 5 `POST .../start` in parallel → each is 200 or 409, and
  `describe-instances` (states `pending,running`) still returns exactly **one** instance id.
- within 15 min `status = running`; `active.join` has a non-empty `ip`, `port` 10999, a non-empty
  `password` (never printed) and `connectCommand === 'c_connect("<ip>", 10999, "<password>")'`.
- `playerCount === 0`; `idleDeadline - joinableAt` is 180 s ± 5 s (`idleMinutes=3`); `heartbeatAt`
  advances within 40 s and the API does not report `stale`.

Record `sessionA1 = sessionId`, `launchA1 = instance LaunchTime`.

**Phase 2 — switch A → B in place (≤ 10 min).**
`POST /api/worlds/test-lifecycle-b/start` while A is `running`. Assertions:

- no second instance is launched: the running instance id stays `$IID`, and within 10 min
  `status === 'running'`, `worldId === 'test-lifecycle-b'`, a **new** `sessionId`, same `instanceId`.
- a **new** version of `worlds/test-lifecycle-a/save.tar.zst` appears (`list-object-versions` count
  0 → 1; record `postStopA1`).
- `sessions/test-lifecycle-a/<sessionA1>/manifest.json` has `stopReason === 'switch'`,
  `preStartVersionId === null` (A had no save before its first session),
  `postStopVersionId === postStopA1`, `peakPlayers === 0`, `instanceType === 'c6i.large'`,
  non-empty `dstBuildId`; `master/server_log.txt` and `caves/server_log.txt` exist and are non-empty.

**Phase 3 — idle shutdown of B (≤ 8 min after joinable).**
Do nothing; by `idleDeadline + 4 min` expect `lastStopReason === 'idle'`, `status === 'stopped'`,
`desiredWorldId === null`; `describe-instances --instance-ids $IID --query
'Reservations[0].Instances[0].State.Name'` → `shutting-down` then `terminated`; one version of
`worlds/test-lifecycle-b/save.tar.zst` exists; B's manifest has `stopReason === 'idle'` and
`preStartVersionId === null` (B's first session).

**Phase 4 — save-tarball content (≤ 2 min, no instance).**
Download B's save to a temp dir; `tar --zstd -tf` must list `cluster.ini` and `Master/`, and must
**not** list `Caves/` (B has `hasCaves=false`), `cluster_token.txt`, `*/save/server_temp`,
`*/save/client_temp`, `*/save/cached_userid`, `*/backup`, or any log file. `cluster.ini` and
`Master/` are at the **archive root** — no wrapper directory (decisions 16.22). Extract and assert the password line
matches `^cluster_password[[:space:]]*=[[:space:]]*$` (blank). Leak check: `grep -R -F -c -- "$TOK"`
for the Klei token value and for the cluster password over both the extracted tree and every
downloaded `sessions/test-*` object — the four DST logs **and `supervisor.log`** (decisions 16.22) —
→ `0` in each case; the script prints the count, never the value.

**Phase 5 — second session of A: restore chain and the stop button (≤ 12 min).**
Start A again; `status` reaches `running` within 10 min (existing save, no generation — the 165 s
measured path). Then `sessions/test-lifecycle-a/<sessionA2>/manifest.json` must have
`preStartVersionId === postStopA1` — the proof that restore and the backup chain line up. Then
`POST /api/worlds/test-lifecycle-a/stop` → 200; within 5 min `lastStopReason === 'user'`,
`status === 'stopped'`, instance `terminated`, a **second** version of A's save exists, and it is
recorded as `postStopVersionId` in A's second manifest.

**Phase 6 — backup and delete-protection configuration (≤ 1 min, no instance).**

```bash
A="AWS_PROFILE=admin aws s3api"; R="--region us-west-2 --bucket $B"
$A get-bucket-versioning $R --query Status --output text                       # Enabled
$A get-bucket-lifecycle-configuration $R --output json | jq -e '.Rules[]
  | select(.Filter.Prefix=="worlds/")
  | select(.NoncurrentVersionExpiration.NewerNoncurrentVersions==10
           and .NoncurrentVersionExpiration.NoncurrentDays==30)'               # exit 0
$A get-bucket-lifecycle-configuration $R --output json | jq -e '.Rules[]
  | select(.Filter.Prefix=="inflight/")
  | select(.NoncurrentVersionExpiration.NewerNoncurrentVersions==3
           and .NoncurrentVersionExpiration.NoncurrentDays==7)'                # exit 0
# Deny probe: a key that does NOT exist and is NOT test-prefixed, so nothing real is at risk.
# An explicit Deny is evaluated before object existence: without it this would return 204.
$A delete-object $R --key "sessions/deny-probe-$(uuidgen)/nothing.txt" 2>&1 | grep -q AccessDenied
$A delete-object-version $R --key sessions/deny-probe/nothing.txt \
  --version-id nOtaRealVersionId 2>&1 | grep -q AccessDenied                   # exit 0
# Positive control: the exempted test prefix IS deletable (else the deny proves nothing)
$A put-object $R --key sessions/test-deny-probe/probe.txt --body /dev/null &&
$A delete-object $R --key sessions/test-deny-probe/probe.txt                   # exit 0
```

**Pruning proof.** PUT 12 versions of a 16-byte object to `worlds/test-prune/save.tar.zst` and
assert `list-object-versions --query 'length(Versions)'` returns `12`. Deletion is **not** asserted:
lifecycle expiry runs asynchronously (roughly daily), so it is not observable on a minute scale. The
assertion is "configuration correct + 12 versions exist"; the script prints the key so a later
manual run of the same command can confirm the count has dropped to 11 (current + 10 noncurrent).
This one key is **retained** by normal teardown so that check is possible; `--cleanup-only` purges
it, so run the manual check first.

**Phase 7 — reaper: stale heartbeat (≤ 35 min; skipped by `--skip-reaper`).**
Start A, wait for `running`, then kill the supervisor while DST keeps running:

```bash
CID=$(AWS_PROFILE=admin aws ssm send-command --region us-west-2 \
  --document-name AWS-RunShellScript --instance-ids "$IID" \
  --parameters 'commands=["systemctl stop dst-supervisor"]' \
  --query Command.CommandId --output text)
AWS_PROFILE=admin aws ssm get-command-invocation --region us-west-2 \
  --command-id "$CID" --instance-id "$IID" --query Status --output text     # Success
```

Bound, computed from decisions 7: the rule needs `heartbeatAt` older than **10 min** *and* the
instance older than **15 min**; heartbeats stop around launch + 4 min, so the rule first holds at
`max(launch+14, launch+15) = launch+15 min`, and the `rate(5 minutes)` schedule adds ≤ 5 min →
**terminate by launch + 20 min**. The instance is then `shutting-down`, not `pending`/`running`, so
reconcile lands on the following run → **state `stopped` by launch + 25 min**. The script waits 30
min from launch and asserts `State.Name === 'terminated'`, `status === 'stopped'`,
`lastStopReason === 'reaper-stale'`. No new save version is expected — the supervisor was killed.

**Phase 8 — reaper: max age (≤ 12 min; skipped by `--skip-reaper`).**
Start A, wait for `running`, stop the supervisor by SSM as above (so its convergence loop cannot
race the reaper), then invoke the reaper directly with the `now` override. The reaper returns a JSON
summary `{ nulledDesire: [instanceId], terminated: [{instanceId, reason}], reconciled }`
(decisions 16.14) so the result is assertable:

```bash
inv() { AWS_PROFILE=admin aws lambda invoke --region us-east-1 \
  --function-name dst-server-manager-reaper --cli-binary-format raw-in-base64-out \
  --payload "{\"now\":\"$1\"}" "$2"; }                                  # StatusCode 200
inv "$NOW_PLUS_12H01M" /tmp/reaper1.json
jq -e '.terminated|length == 0' /tmp/reaper1.json                       # exit 0
jq -e --arg i "$IID" '.nulledDesire|index($i) != null' /tmp/reaper1.json   # exit 0
inv "$NOW_PLUS_12H11M" /tmp/reaper2.json
jq -e --arg i "$IID" '.terminated[]|select(.instanceId==$i).reason == "reaper-max-age"' /tmp/reaper2.json
```

Between the two invokes, assert state `desiredWorldId === null` and the instance still `running`;
after the second, wait for `terminated` and `lastStopReason === 'reaper-max-age'`. A far-future
`now` also satisfies the stale rule, so this phase doubles as proof that the reaper evaluates rules
in the order fixed by decisions 16.13 (orphan → max-age → stale) and the first match wins.

**Phase 9 — reaper: orphan (≤ 10 min; skipped by `--skip-reaper`).**
With state `stopped`, `RunInstances` directly from the launch template
(`--launch-template LaunchTemplateName=dst-server-manager-game`) with `TagSpecifications`
`project=dst-server-manager`, `role=game`, `Name=dst-game`, `sessionId=test-orphan-<uuid>`. The next
scheduled reaper run must terminate it: within 10 min `State.Name` is `shutting-down` or
`terminated`, and the state item is untouched (`status` stays `stopped`, nothing nulled).

**Phase 10 — final.** No instance tagged `project=dst-server-manager` is `pending`/`running`;
state `status === 'stopped'`, `desiredWorldId === null`.

### 4.5 Teardown (`finally`, always)

1. If any `test-*` world is active, `POST .../stop`, then wait up to 5 min for `stopped`.
2. Terminate any instance tagged `project=dst-server-manager`, `role=game` whose `sessionId` this
   run created, and `aws ec2 wait instance-terminated`.
3. Delete every version and delete-marker under `worlds/test-lifecycle-*`, `inflight/test-*`,
   `sessions/test-*` (`list-object-versions --prefix`, then `delete-objects` in batches of 1000).
   `worlds/test-prune/` is kept unless `--cleanup-only`.
4. Delete the `pk=WORLD` items whose `sk` starts with `test-`.
5. Re-assert the `test-` guard on every key and id before deleting; a violation aborts teardown
   loudly rather than deleting anything. Then print the PASS/FAIL table and exit.

`--cleanup-only` runs exactly these steps (plus `worlds/test-prune/`) — use it after an aborted run.

### 4.6 Runtime and cost

Full run ~95-110 min, ~1.4 instance-hours: EC2 $0.12 + IPv4 $0.01 + EBS/S3/requests <$0.03 →
**≈ $0.16**. With `--skip-reaper`, ~45-55 min and ≈ $0.08. Both are well under $1; the dominant
cost is `c6i.large` at $0.085/h.

## 5. The final real-world boot (manual, not automated)

Done once, after the lifecycle test passes. This is the execution plan's **Phase 7**; its milestone
tag is `real-world-verified`. (`v1.0.0` comes later, after the final cleanup phase.)

**Ask Tyler first, then start the world.** `tylerni2026` uses the default `idleMinutes = 30`
(decisions §6), so a world started before he is ready can auto-stop before he joins and the one
blocking human step then fails for a reason that is not a bug. The order is: message him — *"I'm
about to start your world; reply `go` when you're at the keyboard"* — wait for the reply, **then**
run step 1. Tell him too: if the UI shows Stopped when he opens it, press Start; it idles out after
30 minutes.

Shell variables used below (define them first; `$B` and `$T` are §0's):

```bash
B=dst-server-manager-data-063257577013   # data bucket, us-west-2
T=dst-server-manager                     # DynamoDB table, us-east-1
ORIGIN=https://dst.ty.ler.dev
SESSION_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)   # before step 1; used in step 6
IP=                                      # filled in from step 2's output, used in step 3
```

### 5.1 `scripts/mint-cookie.ts`

There is no other way to drive the real API from the CLI: `scripts/lifecycle-test.ts` refuses every
non-`test-` world id by design (§4.1 rule 2). This script exists for exactly this moment
(decisions §16.33).

```
AWS_PROFILE=admin pnpm tsx scripts/mint-cookie.ts [--steam-id <steamid64>] [--help]
```

- Reads `/dst/session-secret` (SecureString, us-east-1, with decryption) and `/dst/users` (String,
  us-east-1) with the admin profile.
- `--steam-id` is **optional**; the default is the **first key of `/dst/users`**. A value that is
  not in `/dst/users` is refused with a non-zero exit (the API would 403 it anyway).
- Imports the signer — `mintSessionToken` from `@dst/api/auth` (§4.2) — and never re-implements
  HKDF or the HMAC.
- Prints **only** the cookie header value, one line, nothing else:
  `__Host-dst_session=<token>`. It never prints the session secret, the SteamID64, the allowlist,
  or the token on its own.
- `--help` prints the usage line and both flags, exits 0, makes no AWS call.

Start the world with it:

```bash
C=$(AWS_PROFILE=admin pnpm tsx scripts/mint-cookie.ts)
curl -s -X POST -H "Cookie: $C" -H "Origin: $ORIGIN" -H 'X-DST-Request: 1' \
  "$ORIGIN/api/worlds/tylerni2026/start" -o /dev/null -w '%{http_code}\n'      # 200
```

All three headers are required: the cookie authenticates, and `Origin` + `X-DST-Request: 1` are the
CSRF precondition (`docs/auth.md` §8.1). The POST is bodyless.

### 5.2 Steps

1. Start `tylerni2026` — the `curl` above, or from the UI at `$ORIGIN`.
2. Wait for `running` and read the join info (set `IP` from it):
   ```bash
   AWS_PROFILE=admin aws dynamodb get-item --region us-east-1 --table-name $T \
     --key '{"pk":{"S":"STATE"},"sk":{"S":"CLUSTER"}}' \
     --query 'Item.[status.S,worldId.S,publicIp.S,joinableAt.S]' --output text
   # running  tylerni2026  <ip>  <iso8601>
   ```

   To check the same thing through the API, use **exactly this projection** — never `jq '.active'`,
   and never select `.active.join.password` or `.active.join.connectCommand` (the connect command
   embeds the password). Tyler reads both from the UI; neither may ever reach a terminal transcript
   or a log (§4.1 rule 4):

   ```bash
   curl -s -H "Cookie: $C" "$ORIGIN/api/worlds" | jq -e '{
     status:       .active.status,
     ip:           .active.join.ip,
     serverName:   .active.join.serverName,
     playerCount:  .active.playerCount,
     idleDeadline: .active.idleDeadline,
     hasPassword:  ((.active.join.password // "") | length > 0)
   }'
   ```

   `hasPassword` must be `true`; `status` `running`; `ip` an IP; `serverName` non-empty.
3. Confirm the Klei lobby listing (the lobby region is chosen by ping, not by AWS region — the
   spike saw `us-east-1` for a `us-west-2` instance — so check several):
   ```bash
   for R in us-east-1 us-west-2 eu-central-1 ap-southeast-1; do
     curl -s --compressed "https://lobby-v2-cdn.klei.com/$R-Steam.json.gz" \
       | jq --arg ip "$IP" -e '[.GET[] | select(.__addr==$ip)] | length == 1' >/dev/null \
       && echo "listed in $R"; done        # prints exactly one "listed in <region>"
   ```
   The row must show `"password": true`, `"connected": 0`, `"dedicated": true`, and a `secondaries`
   entry on port 10998.
4. Tyler joins from the game client with the `connectCommand` shown in the UI. Confirm
   `active.playerCount` goes to 1 within ~60 s and the UI countdown stops advancing.
5. Tyler leaves. Confirm `playerCount` returns to 0 within ~2 min and `idleDeadline` moves to
   `lastNonZero + 30 min`.
6. Leave it alone and confirm the automatic shutdown afterwards:
   ```bash
   AWS_PROFILE=admin aws dynamodb get-item --region us-east-1 --table-name $T \
     --key '{"pk":{"S":"STATE"},"sk":{"S":"CLUSTER"}}' \
     --query 'Item.[status.S,lastStopReason.S]' --output text       # stopped  idle
   AWS_PROFILE=admin aws ec2 describe-instances --region us-west-2 \
     --filters Name=tag:project,Values=dst-server-manager \
               Name=instance-state-name,Values=pending,running \
     --query 'length(Reservations[].Instances[])' --output text     # 0
   AWS_PROFILE=admin aws s3api list-object-versions --region us-west-2 --bucket $B \
     --prefix worlds/tylerni2026/save.tar.zst --output json \
     | jq -e '(.Versions|length) >= 2 and ([.Versions[]|select(.IsLatest)][0].LastModified > "'"$SESSION_START"'")'
   ```
   (≥ 2 versions: the seed import plus this stop; the current one is newer than the session start.)
7. Sanity: the session prefix exists with a manifest whose `stopReason` is `idle` and whose
   `preStartVersionId` is the version that was current before the boot.

Only after all seven steps does the milestone tag `real-world-verified` apply. `v1.0.0` is tagged
later still, after the final cleanup phase (§6 and the doc realignment).

## 6. Clean-account check — `scripts/clean-account-check.sh`

The account hosts other production sites, so the end of execution must **prove** nothing stray is
left. This is a script with a contract, not a checklist a human reads (decisions §16.33):

- It **asserts**. Every check either passes or fails; nothing is left to interpretation.
- It prints **one line per check**, `PASS <check>` or `FAIL <check> — <what it found>`, then a final
  count line (`N checks, M failed`).
- It **exits non-zero if any check failed** (and 0 only when all passed). `bash scripts/
  clean-account-check.sh ; echo "exit=$?"` is therefore a real gate.
- `--help` prints the usage line and every flag, exits 0, and makes no AWS call. It is **parsed and
  answered before any precondition, credential check or AWS client construction** (decisions
  §16.40), so `env -u AWS_PROFILE bash scripts/clean-account-check.sh --help` exits 0.
- It runs every regional check in **both** regions, `us-east-1` and `us-west-2`.
- It uses `describe-instances` with explicit `instance-state-name` filters as the source of truth,
  and `resourcegroupstaggingapi` only as a cross-check: the tagging API lags and keeps listing
  terminated instances for hours.
- **Exactly two hardcoded exceptions**, and no others: the S3 key
  `worlds/test-prune/save.tar.zst` (the retained pruning evidence of §4.4 phase 6), and
  `resourcegroupstaggingapi` ARNs matching
  `^arn:aws:ec2:[a-z0-9-]+:063257577013:instance/` whose `describe-instances` state is
  `terminated` **or which EC2 no longer knows at all** (`InvalidInstanceID.NotFound`). Everything
  else that turns up is a `FAIL`.
- The two halves of that second exception are both required, and for opposite reasons. The tagging
  API lags and keeps listing instances for hours, but EC2 **forgets** a terminated instance after
  about an hour — after which `describe-instances` no longer returns it and its state string is
  empty, not `terminated`. An instance id EC2 cannot resolve does not exist and cannot be costing
  anything, so it is clean. Only `InvalidInstanceID.NotFound` counts: any other API error is a
  `FAIL`, never silently treated as clean.

The checks, one `PASS`/`FAIL` line each:

1. no instance tagged `project=dst-server-manager` in a live state, per region;
2. no instance named `dst-spike-*` in a live state, per region (spike leftovers);
3. no security group named `dst-spike-*`, per region;
4. no volume tagged `project=dst-server-manager`, per region;
5. launch templates **tagged `project=dst-server-manager`**: exactly `dst-server-manager-game`
   in us-west-2, and none in us-east-1. Untagged launch templates are out of scope: this account
   hosts other production sites and us-west-2 already contained `InstanceLaunchTemplate`
   (created 2026-09-07, untagged, referenced nowhere in this repo) before any of this project
   existed. `CLAUDE.md` forbids touching anything this project did not create, so an unscoped
   "and nothing else there" is not a contract this check can ever satisfy;
6. `resourcegroupstaggingapi` lists only the expected ARNs, per region (terminated instances excepted);
7. the IAM role `dst-spike-instance` does not exist;
8. the IAM instance profile `dst-spike-instance` does not exist;
9. the bucket `dst-spike-063257577013` does not exist;
10. no `worlds/test-` objects except the one exception key;
11. no `inflight/test-` objects;
12. no `sessions/test-` objects;
13. no `pk=WORLD` item whose `sk` begins with `test-`.

**Minimum output: 19 `PASS`/`FAIL` lines.** There are **13 distinct checks**, and checks 1-6 are
regional and run once per region (2 regions), so 6 × 2 + 7 = **19** lines, plus the final
`N checks, M failed` count line (which is not a `PASS`/`FAIL` line). The acceptance below asserts
the weaker `>= 13` on purpose — it is the count of *distinct* checks and stays true if two regional
checks are ever consolidated into one line — but a script printing fewer than 19 has silently
dropped a region.

The commands each check runs (`LIVE` is the live-state filter; every instance count uses
`length(Reservations[].Instances[])`, never `length(Reservations)`, which counts reservations):

```bash
LIVE=pending,running,stopping,stopped
for R in us-east-1 us-west-2; do
  AWS_PROFILE=admin aws ec2 describe-instances --region $R \
    --filters Name=tag:project,Values=dst-server-manager Name=instance-state-name,Values=$LIVE \
    --query 'length(Reservations[].Instances[])' --output text          # 0
  AWS_PROFILE=admin aws ec2 describe-instances --region $R \
    --filters 'Name=tag:Name,Values=dst-spike-*' Name=instance-state-name,Values=$LIVE \
    --query 'length(Reservations[].Instances[])' --output text          # 0  (spike leftovers, by name)
  AWS_PROFILE=admin aws ec2 describe-security-groups --region $R \
    --filters 'Name=group-name,Values=dst-spike-*' --query 'length(SecurityGroups)' --output text   # 0
  AWS_PROFILE=admin aws ec2 describe-volumes --region $R \
    --filters Name=tag:project,Values=dst-server-manager --query 'length(Volumes)' --output text    # 0
  AWS_PROFILE=admin aws ec2 describe-launch-templates --region $R \
    --query 'LaunchTemplates[].LaunchTemplateName' --output text  # us-west-2: only dst-server-manager-game; us-east-1: none
  AWS_PROFILE=admin aws resourcegroupstaggingapi get-resources --region $R \
    --tag-filters Key=project,Values=dst-server-manager \
    --query 'ResourceTagMappingList[].ResourceARN' --output text
  # For each EC2 instance ARN returned, look the instance up with
  #   aws ec2 describe-instances --region $R --instance-ids <id> \
  #     --query 'Reservations[].Instances[].State.Name' --output text
  # and treat it as clean only when that prints `terminated` (the tagging API lags for hours).
  # Any other ARN must be one of the expected surviving resources below, else FAIL.
done
AWS_PROFILE=admin aws iam get-role --role-name dst-spike-instance 2>&1 | grep -q NoSuchEntity   # exit 0
AWS_PROFILE=admin aws iam get-instance-profile --instance-profile-name dst-spike-instance 2>&1 \
  | grep -q NoSuchEntity                                                                        # exit 0
AWS_PROFILE=admin aws s3api head-bucket --bucket dst-spike-063257577013 2>&1 | grep -q '404'    # exit 0
# no test data left (the retained prune key is the only allowed test-* object)
AWS_PROFILE=admin aws s3api list-object-versions --region us-west-2 --bucket $B \
  --prefix worlds/test- --query 'Versions[].Key' --output text  # only worlds/test-prune/save.tar.zst, or None
for P in inflight/test- sessions/test-; do AWS_PROFILE=admin aws s3api list-object-versions \
  --region us-west-2 --bucket $B --prefix $P --query 'length(Versions)' --output text; done  # None/0
AWS_PROFILE=admin aws dynamodb query --region us-east-1 --table-name $T \
  --key-condition-expression 'pk = :p AND begins_with(sk, :s)' \
  --expression-attribute-values '{":p":{"S":"WORLD"},":s":{"S":"test-"}}' \
  --query 'Count' --output text                                     # 0
```

The script's own acceptance, runnable before any of it has been pointed at a real account:

```bash
bash -n scripts/clean-account-check.sh ; echo "exit=$?"                  # exit=0 (syntax)
env -u AWS_PROFILE -u AWS_ACCESS_KEY_ID bash scripts/clean-account-check.sh --help \
  | grep -c -- '--help'                                                  # >= 1, no AWS call
AWS_PROFILE=admin bash scripts/clean-account-check.sh 2>&1 \
  | grep -cE '^(PASS|FAIL) '                                             # >= 13 (19 in practice)
AWS_PROFILE=admin bash scripts/clean-account-check.sh 2>&1 | grep -c '^FAIL ' ; true   # 0
grep -c 'exit 1' scripts/clean-account-check.sh                          # >= 1
AWS_PROFILE=admin bash scripts/clean-account-check.sh ; echo "exit=$?"   # exit=0 when clean
```

Expected surviving resources, and nothing else. Check 6 must implement this as an **allowlist** —
an ARN that matches nothing here is a `FAIL`, and the check is only meaningful if it would fail on
an unexpected tagged resource:

| Region | Expected tagged ARNs |
|---|---|
| us-east-1 | `s3:::dst-server-manager-site-063257577013`; `dynamodb:…:table/dst-server-manager`; `lambda:…:function:dst-server-manager-{api,reaper}`; `logs:…:log-group:/aws/lambda/dst-server-manager-{api,reaper}`; `events:…:rule/dst-server-manager-reaper`; `cloudfront::…:distribution/*`; `acm:…:certificate/*`; `sns:…:dst-server-manager-budget`; `ssm:…:parameter/dst/{users,session-secret}` |
| us-west-2 | `s3:::dst-server-manager-data-063257577013`; `ec2:…:launch-template/*` (the tagged one); `ec2:…:security-group/*` (the tagged one); `ssm:…:parameter/dst/{klei-token,cluster-password}` |
| either | the CDK `BucketDeployment` custom-resource Lambda and its log group, `…:function:Dst{Web,Game}-CustomCDKBucketDeployment*` and `…:log-group:/aws/lambda/Dst{Web,Game}-CustomCDKBucketDeployment*` (decisions §16.16 — expected, not an application Lambda) |

Volumes and instances are covered by checks 1 and 4 and by the terminated/forgotten exception
above; a **live** tagged instance or any tagged volume is a `FAIL` there, so check 6 does not need
to re-judge them. The instance role, the GitHub deploy role and the budget itself carry no
resource tags the tagging API returns, so they are not listed; the stacks themselves are
CloudFormation, not tagged resources.

## 7. CI

Per decisions 12 the workflow (`.github/workflows/deploy.yml`, push to `main`) runs, in order:
checkout, pnpm install `--frozen-lockfile`, `scripts/check-secrets.sh`, `pnpm lint`,
`pnpm typecheck`, `pnpm test`, `pnpm build`, then OIDC assume-role and
`cdk deploy DstGame DstWeb --require-approval never`. It runs the scripts individually rather than
`pnpm check`, and **`pnpm e2e` is deliberately not in it.**

**Settled (decisions 16.24): `pnpm e2e` is not in the deploy workflow, and `.github/workflows/
deploy.yml` is the only workflow in v1.** No second workflow is created. `pnpm e2e` runs locally as
the last step of `pnpm check` before every push, and that is the whole of its role.

Why, for the record: this is deploy-on-push with no branch protection and no staging, so a flaky
browser test would block a deploy for a reason unrelated to the change; Playwright adds a browser
download plus two servers to a job whose point is to be a fast deterministic gate; and e2e runs
against the *local* app with a test-only secret, so it says nothing about the deployed stack that
the lifecycle test does not say better.

The pre-push hook (`git config core.hooksPath .githooks`) runs `scripts/check-secrets.sh --pre-push`
on every push, so the CI run is a second line of defence, not the first.

**Waiting for a run: always select it by `headSha`, never `--limit 1`.** `gh run list` is ordered by
start time, so immediately after a push the newest *registered* run is still the **previous** one —
an until-loop on `.[0].status` exits at once and reports the old run's conclusion as if it were the
new deploy's. The one correct shape, used identically by `docs/infra.md` §6 and §9:

```bash
SHA=$(git rev-parse HEAD)
until ID=$(gh run list --workflow deploy.yml --limit 20 --json headSha,databaseId \
  -q ".[]|select(.headSha==\"$SHA\")|.databaseId" | head -1); [ -n "$ID" ]; do sleep 10; done
until [ "$(gh run view "$ID" --json status -q .status)" = completed ]; do sleep 20; done
gh run view "$ID" --json conclusion -q .conclusion                      # success
# on failure: gh run view "$ID" --log-failed | tail -40
```
