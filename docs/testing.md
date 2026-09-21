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

`pnpm check` is the local gate before every push. It is *not* what CI runs (section 7), and **CI is
the authority**: a local `pnpm typecheck` can resolve an import from **outside the repo** and pass
while CI fails. Measured once during execution — `undici` resolved from `~/node_modules` on this
machine, so the local gate was green and the first CI run was red. A green `pnpm check` is
necessary, not sufficient; the clean-checkout, frozen-lockfile install in CI is what decides.

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
| `web` | no jsdom and no testing-library — **the unit tests exercise extracted pure functions, not rendered components** (`*.test.ts`, never `*.test.tsx`): derived per-world status, the countdown maths, the poll-interval selector, the error-to-notification mapping, the API client's status handling. Anything that needs a DOM is covered by Playwright instead (§7 of `docs/web.md`). Rendered-component coverage is a follow-up (`docs/follow-ups.md`) | derived per-world status; countdown from `idleDeadline`; poll interval 5 s / 30 s and paused when hidden; stop/switch confirmation modal; sign-in screen when 401 | `docs/web.md` |
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
`/api/test/control` route and the fake EC2 launcher (`docs/control-plane.md` §5.5) — are all
registered in `packages/api/src/local.ts`, which imports the shared constant
`LOCAL_ONLY_MARKER = 'DST_LOCAL_ONLY'` and uses it in **live** code (a module-scope guard that
throws unless `APP_ENV` is `local`/`test`), so no bundler can tree-shake or rename that string away
(decisions 16.4). **In `testSecret.ts`, `local/localLauncher.ts` and `fakes/*` the marker is a
comment or absent** — see "Second" below for what that does and does not prove. The greps: run them
**after `pnpm build`**, so both directories exist.

```bash
rm -rf packages/infra/cdk.out && pnpm build        # see "not vacuous" below — do this first
grep -rl DST_LOCAL_ONLY packages/api/src | head -1            # exit 0 — check is not vacuous
grep -rlq 'auth\.callback' packages/infra/cdk.out/ ; echo "exit=$?"  # exit=0 — cdk.out holds the REAL bundle
grep -rl DST_LOCAL_ONLY packages/api/dist/lambda/ ; echo "exit=$?"   # exit=1 (not in the bundles)
grep -rl DST_LOCAL_ONLY packages/infra/cdk.out/ ; echo "exit=$?"     # exit=1 (not in what deploys)
grep -rl dst-local-test-secret-not-for-production \
  packages/api/dist/lambda/ packages/infra/cdk.out/ ; echo "exit=$?"   # exit=1 (test literal absent)
```

All of these are kept even though, with one bundler, the `dist/lambda/` and `cdk.out/` greps now
look at the **same bytes**: `packages/api/dist/lambda/` is the esbuild output and `cdk.out/` holds
the staged copy of that directory plus its zip (decisions §16.29, `docs/infra.md` §4.2). The `src/`
grep proves the check is not vacuous — if the marker vanished from `src/` the others would pass for
the wrong reason. The `cdk.out/` grep is what closes review defect B3: `cdk.out/` is what
CloudFormation uploads, so it is the artifact the claim "absent from the built Lambda bundles" is
actually about. The last one pins the test-only session secret literal out of both.

**Two ways these greps can pass for nothing, and the guards against both.**
`cdk.out/` accumulates one asset directory per synth and is never cleaned, and the one credentialed
fixture synth (`docs/infra.md` §5) stages the **53-byte fixture stub** from
`packages/infra/test/fixtures/api-bundle/` as an `api.js` of its own. A stale fixture asset sitting
beside the real bundle is indistinguishable to `grep -rl`, which reports only that *nothing*
matched — so `rm -rf packages/infra/cdk.out` before the build (and before any real `cdk diff` /
`deploy`) is part of the check, not hygiene. The
`grep -rlq 'auth\.callback' packages/infra/cdk.out/` line is the positive control: that string
exists only in the real 4 MB API bundle, so a `cdk.out/` that holds nothing but fixture stubs (or
`error.txt: CannotFindAsset`) fails the check loudly instead of passing it silently. `cdk.out/` is
git-ignored, so nothing here depends on a committed artifact.

Second: the `DST_LOCAL_ONLY` marker is a **comment** in `packages/api/src/auth/testSecret.ts` (and
esbuild strips comments), and it is absent from `packages/api/src/local/localLauncher.ts` and
`packages/api/src/fakes/*` — so the marker greps could not detect the fake launcher or the fakes
reaching a bundle. The structural argument in the paragraph above is what actually holds
(`src/handlers/api.ts` imports none of those modules, so they are not in the entry's import graph),
and the last grep — for the secret's literal, which esbuild cannot strip — is the one that would
catch `testSecret.ts` arriving. Making `localLauncher.ts` and `src/fakes/index.ts` each reference
`LOCAL_ONLY_MARKER` in **live** code would make the marker greps load-bearing too:
`docs/follow-ups.md`.

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
   is no lock beyond this check and the API's conditional writes. Since decisions §17 that rule
   binds harder: `play.dst.ty.ler.dev` is a **single global record**, not a per-world one, so for
   the ~10 minutes phases 1-3 run, the hostname friends have saved points at a `test-` world and
   then at the sink. The script only *reads* the record — the supervisor and the reaper write it —
   but a run started while someone is playing would hijack the name as well as the Klei token.
   **One exemption, added in T5.2: `--cleanup-only`, and only `--cleanup-only`, may proceed over a
   non-stopped cluster when the active `worldId` starts with `test-`.** `--cleanup-only` is
   documented as the recovery path after an aborted run, and an aborted run is precisely when a
   `test-` world is left `starting`/`running` with its instance alive — so this rail used to refuse
   the one invocation that exists to clean that up (`REFUSED: cluster status is starting`, exit 3),
   leaving no supported recovery. A real world still refuses, every other invocation still refuses
   on any non-stopped cluster, and `assertTestKey` still guards every mutating call. Teardown step 1
   also adopts the live session's `sessionId`, so step 2's narrowly scoped terminate can still
   collect the instance and cleanup cannot return leaving a billable one behind.
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
   leak checks compare downloaded bytes and print only counts. Phase 4 scans **each object
   separately** through a pure, unit-tested `scanForSecretLeaks()` and prints one
   `LEAKED IN <label> (token hits=N, password hits=M)` line per offender, with the same labels in
   the thrown error — `save.tar.zst:<path inside the archive>` or `s3:<key>`. **The label and the
   counts, and nothing else**: never the value, never the matching line, never a surrounding
   excerpt. (It used to sum hits over every downloaded object into one total, which named neither
   the file nor even which secret it came from — the difference between a one-line diagnosis and a
   post-mortem on artefacts teardown has already deleted.) `assertSecretValuesNonEmpty` refuses to
   run a vacuous check: an empty or missing SSM value would otherwise make the assertion pass with
   exactly the output a real pass prints.

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

Timeouts were sized from the spike (click-to-joinable 165 s warm, 308 s cold) and the measured
numbers came out close: **333 s cold, 142-164 s warm**, with world generation adding ~44 s to
`LOAD BE: done`. The 15-minute phase budget stands, with the supervisor's own 15-min boot timeout as
the backstop. Polling helper: `waitFor(predicate, timeout, interval=10s)` over `GET /api/worlds` or
a `GetItem` on the state singleton; every wait logs elapsed time so slow phases are visible.

**The run must be re-runnable, so phase 0 resets its own baseline first.** Phase 2 wants exactly 1
version of A's save, phase 3 exactly 1 of B's, phase 5 exactly 2 of A's, and phase 4's leak check
downloads every `sessions/test-*` object it can find — all written against a zero baseline that
only the *previous* run's teardown established. Teardown is best-effort and does not run at all if
the process is killed, so `resetTestArtefacts()` deletes exactly what teardown step 3 deletes
(`worlds/test-lifecycle-a/`, `worlds/test-lifecycle-b/`, `inflight/test-`, `sessions/test-`, shared
with teardown as `TEST_DATA_PREFIXES`) plus the `test-` registry rows, **before the first
assertion**, and prints what it purged. `worlds/test-prune/` is deliberately *not* in that list: a
run that fails before phase 6 must not destroy the retained evidence. Two full runs back to back
with no `--cleanup-only` in between is the acceptance for this.

**Phase 0 — preflight (≤ 1 min).**
`resetTestArtefacts()` (above) as the first assertion. Then `GET $ORIGIN/api/me` with the minted
cookie → 200 and a `nickname`. With no cookie → 401. With an `APP_ENV=test` token → 401 (section 3).
Registry writes for A and B; `GET /api/worlds` lists both — **polled for up to 60 s**, not asserted
on the first response: the API lists the registry with a plain (eventually consistent) DynamoDB
`Query`, so the write it just made is not guaranteed visible on the replica that serves the read.

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
- within 15 min `status = running`; `active.join` has a non-empty `ip`, `host ===
  'play.dst.ty.ler.dev'`, `port` 10999, a non-empty `password` (never printed) and
  `connectCommand === 'c_connect("play.dst.ty.ler.dev", 10999, "<password>")'` — the hostname, not
  the IP (decisions §17).
- **the join record follows the instance**: `ListResourceRecordSets` for `play.dst.ty.ler.dev`/`A`
  returns exactly the running session's `publicIp`, with `TTL === 60`, within 2 min. Asserted
  against the **Route 53 API, not a resolver** — `dig` would be answered from a TTL-60 cache and
  make this flaky for up to a minute.
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
- `test-lifecycle-b after the switch: idleDeadline - joinableAt is 180s ± 5s` — phase 1's check, for
  a world that arrived by a switch rather than a boot. Added in T5.2; it is what ruled out "the
  post-switch world's idle clock is anchored on the wrong world" in seconds rather than minutes.

Measured: the switch takes **30-81 s** (median ~40 s over 12 switches), never launches a second
instance, and is safe to repeat — a stress harness drove B→A→B→… for 9 consecutive switches on one
live instance.

**Phase 3 — idle shutdown of B (≤ 8 min after joinable).**
Do nothing; by `idleDeadline + 4 min` expect `lastStopReason === 'idle'`, `status === 'stopped'`,
`desiredWorldId === null`; `describe-instances --instance-ids $IID --query
'Reservations[0].Instances[0].State.Name'` → `shutting-down` then `terminated`; one version of
`worlds/test-lifecycle-b/save.tar.zst` exists; B's manifest has `stopReason === 'idle'` and
`preStartVersionId === null` (B's first session). And **the join record returns to the sink**:
`play.dst.ty.ler.dev` reads `192.0.2.1` within 3 min of the terminate (decisions §17) — the proof
that a stop cannot leave the name pointing at a released EC2 address.

**Inside the idle wait, a *new* `sessionId` on the same world fails immediately** with
`test-lifecycle-b restarted itself under a new sessionId (… -> …) instead of stopping for idle`.
That is the S8 defect's exact signature (`docs/game-server.md` §8): without it the phase only ever
reported an 8-minute timeout, and teardown's own `POST stop` then left `lastStopReason=user` in the
item, so the post-mortem looked like "the idle machinery never fired" when in fact it fired on time
and the **stop** could not finish. **This is the only test in the system that ever waits for an
idle stop**, which is why that cost-safety hole survived everything else. Measured with S8
deployed: `stop_begin` → `save_pushed` 4 s, all four phase-3 assertions in 252 s.

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

`S3` below is a shell **function** and `R` an **array**: `A="AWS_PROFILE=admin aws s3api"` + `$A`
never works (the leading assignment is not re-parsed as one from an expansion), and
`R="--region … --bucket …"` + `$R` is bash-only — zsh does not word-split an unquoted expansion, so
it arrives as a single argument. Both forms below are correct in bash and zsh:

```bash
S3() { AWS_PROFILE=admin aws s3api "$@" --region us-west-2 --bucket "$B"; }
S3 get-bucket-versioning --query Status --output text                          # Enabled
S3 get-bucket-lifecycle-configuration --output json | jq -e '.Rules[]
  | select(.Filter.Prefix=="worlds/")
  | select(.NoncurrentVersionExpiration.NewerNoncurrentVersions==10
           and .NoncurrentVersionExpiration.NoncurrentDays==30)'               # exit 0
S3 get-bucket-lifecycle-configuration --output json | jq -e '.Rules[]
  | select(.Filter.Prefix=="inflight/")
  | select(.NoncurrentVersionExpiration.NewerNoncurrentVersions==3
           and .NoncurrentVersionExpiration.NoncurrentDays==7)'                # exit 0
# Deny probe: a key that does NOT exist and is NOT test-prefixed, so nothing real is at risk.
# An explicit Deny is evaluated before object existence: without it this would return 204.
S3 delete-object --key "sessions/deny-probe-$(uuidgen)/nothing.txt" 2>&1 | grep -q AccessDenied
# The s3:DeleteObjectVersion half is asserted from the policy document, not fired live (below).
S3 get-bucket-policy --query Policy --output text | jq -e '
  [.Statement[] | select(.Sid=="DenyDeleteOutsideScratchPrefixes")][0]
  | .Effect=="Deny" and (.Principal=="*" or .Principal.AWS=="*")
    and ((.Action|sort)==["s3:DeleteObject","s3:DeleteObjectVersion"])
    and ((.NotResource|length)==6)'                                            # exit 0
# Positive control: the exempted test prefix IS deletable (else the deny proves nothing)
S3 put-object --key sessions/test-deny-probe/probe.txt --body /dev/null &&
S3 delete-object --key sessions/test-deny-probe/probe.txt                      # exit 0
```

**There is no `aws s3api delete-object-version` subcommand** (the versioned delete is
`delete-object --version-id <id>`), and more importantly **`s3:DeleteObjectVersion` cannot be probed
live the way `s3:DeleteObject` can.** A version-less delete of a nonexistent key reaches policy
evaluation and is denied; a versioned delete needs a `VersionId`, and S3 rejects one that does not
exist with `InvalidArgument` **before** it evaluates the bucket policy — measured, with both a
malformed and a well-formed-looking id. The only request that would certainly reach the policy is a
delete of a **real** version of a **real** non-test object, i.e. of `worlds/tylerni2026/save.tar.zst`
— precisely the thing the policy exists to protect, and which would destroy the save outright if the
policy were ever wrong. So the script **asserts the statement instead of firing the bullet**:
`Sid`, `Effect: Deny`, `Principal: *`, both actions, and the exact six-prefix `NotResource` set.
That is strictly stronger than the probe it replaces, which could not have caught an over-broad
`NotResource` either. (Measured aside, for anyone tempted to tighten this: the literal
`--version-id null` *does* reach the policy and comes back `AccessDenied` on
`s3:DeleteObjectVersion`, because `null` is a syntactically valid version id. It is a candidate
sharpening, not a requirement — `docs/follow-ups.md`.)

Both probes must also **assume nothing about statement order or count**: `enforceSSL` emits its own
`Deny` with no `Sid`, and it comes first in the deployed policy (`docs/storage.md` §3).

The positive control must **clean up after itself**: on a versioned bucket a version-less
`DeleteObject` only adds a *delete marker*, so it left an entry under `sessions/test-` whose latest
version has no body — which phase 4 of a later run then tried to download (`NoSuchKey`, not a leak).
The script removes both the marker and the version it created, so the control leaves nothing behind,
like the deny probe above it. Belt and braces: `listAllVersions` records `IsDeleteMarker` and phase
4's scan skips markers.

**Pruning proof.** **Delete every existing version of the key first** (`deleteAllVersions(PRUNE_KEY)`,
which re-asserts `assertTestKey` and prints how many stale versions it purged), then PUT 12 versions
of a 16-byte object to `worlds/test-prune/save.tar.zst` and assert
`list-object-versions --query 'length(Versions)'` returns `12`. The reset is what makes the absolute
count true on run *n* for every *n*: this key is deliberately **retained** by normal teardown, so
without it the first run wrote 12 and passed, the second saw 24, and every run after that failed
forever (`expected 12 versions, got 24` — measured; it is also why phases 7-10 had never once
executed). Deletion is **not** asserted:
lifecycle expiry runs asynchronously (roughly daily), so it is not observable on a minute scale. The
assertion is "configuration correct + 12 versions exist"; the script prints the key so a later
manual run of the same command can confirm the count has dropped to 11 (current + 10 noncurrent).
This one key is **retained** by normal teardown so that check is possible; `--cleanup-only` purges
it, so run the manual check first.

**Phases 7 and 8 first widen world A's idle window.** A is registered with `idleMinutes = 3` (§4.3)
for phases 1-3, and the supervisor reads it once per session — so everything between `joinable` and
the SSM command landing had to fit inside 180 s, or the session idle-stopped itself and the phase
failed with `lastStopReason=idle` without exercising the reaper at all.
`widenWorldAIdleWindow()` re-registers A with `idleMinutes = 30` before these phases start it.
Nothing after phase 1 asserts A's 180 s deadline and no reaper rule looks at the idle clock; the
pre-run reset re-registers A, so this cannot leak into the next run.

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

**`$NOW_PLUS_12H01M` must be anchored on the instance's `LaunchTime`, not on the phase start.** The
reaper compares `now - instance.launchTime` against `MAX_SESSION_MS` and
`MAX_SESSION_MS + MAX_SESSION_GRACE_MS`. Starting A and waiting for `running` takes ~150 s, so a
`phaseStart + 12h01m` override left the instance 11 h 58 m old, rule 3 would not have fired, and
`nulledDesire` would have come back empty — a phase that had never once executed would have failed
on the harness's arithmetic rather than on the reaper. Measured with the anchor fixed: both invokes
plus `terminated` plus `reaper-max-age` in 33 s.

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
   run created, and **wait for `instance-terminated`** — `TerminateInstances` returns while the
   instance is still shutting down, and a second run started straight afterwards would be refused by
   §4.1 rail 1 on a still-`pending` instance.
3. Delete every version and delete-marker under `worlds/test-lifecycle-*`, `inflight/test-*`,
   `sessions/test-*` (`list-object-versions --prefix`, then `delete-objects` in batches of 1000).
   `worlds/test-prune/` is kept unless `--cleanup-only`.
4. Delete the `pk=WORLD` items whose `sk` starts with `test-`, querying with `ConsistentRead` so
   teardown cannot miss a row this run wrote moments earlier and leave it for
   `clean-account-check.sh` to report.
5. Re-assert the `test-` guard on every key and id before deleting; a violation aborts teardown
   loudly rather than deleting anything. Then print the PASS/FAIL table and exit.

`--cleanup-only` runs exactly these steps (plus `worlds/test-prune/`) — use it after an aborted run.

### 4.6 Runtime and cost

**Measured: a full run (phase 0 through teardown, all 11 phases) is ~36.5 min** — two
back-to-back runs took 36.5 and 36.4 min, 42 of 42 assertions each, exit 0. The two join-record
assertions of decisions §17 (phases 1 and 3) bring the count to **44**, measured 44/44 on the run
that shipped them; neither adds a wait the run was not already taking (1.0 s and 0.4 s — the
record was already correct both times). The original 95-110 min
estimate was conservative; the `--timeout-minutes` default of 150 is left as it is, since a wedged
boot is exactly what the timeout is for. Cost is unchanged: ~1.4 instance-hours at worst,
EC2 $0.12 + IPv4 $0.01 + EBS/S3/requests <$0.03 → **≈ $0.16**; with `--skip-reaper` roughly half
of that. The dominant cost is `c6i.large` at $0.085/h.

The slowest phases and why: phase 7 waits out the reaper's real stale rule (**~18 min**, bound 25),
phase 1 boots a generated world (142 s warm), phase 5 restores one (153 s), phase 3 waits out a
3-minute idle deadline plus the stop (252 s), phase 9 waits for a scheduled reaper tick (77 s).

**Leave the Klei token alone for 15-20 minutes between runs.** Fast repeated start/stop cycles
provoke `E_ROWID_EXIST` on the Klei lobby (`docs/game-server.md` §7), which can keep a world from
ever becoming joinable for 17+ minutes and fails phase 1 for a reason that is not a bug.

## 5. The final real-world boot (manual, not automated)

Done once, after the lifecycle test passes; its milestone tag is `real-world-verified`.
**Completed:** `tylerni2026` booted to joinable in **164 s** (warm binaries cache), was listed in
the Klei lobby, was joined and played from the game client, and then stopped itself for idle,
unattended, with the save pushed to S3 — the whole stop sequence taking **49 s** from the idle
deadline to `status=stopped`. The same seven steps are the recipe for **re-running it by hand**,
which is the supported way to start the real world from a terminal.

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
later still, after the final cleanup (§6 and the doc realignment).

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
  # TAG-SCOPED on purpose (check 5): an unfiltered listing also returns us-west-2's pre-existing,
  # untagged `InstanceLaunchTemplate`, which belongs to another site in this shared account.
  AWS_PROFILE=admin aws ec2 describe-launch-templates --region $R \
    --filters Name=tag:project,Values=dst-server-manager \
    --query 'LaunchTemplates[].LaunchTemplateName' --output text  # us-west-2: dst-server-manager-game; us-east-1: empty
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
# `length(Versions)` ERRORS on an empty prefix (Versions is absent, not []), so default it:
for P in inflight/test- sessions/test-; do AWS_PROFILE=admin aws s3api list-object-versions \
  --region us-west-2 --bucket $B --prefix $P --query 'length(Versions || `[]`)' --output text; done  # 0
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
