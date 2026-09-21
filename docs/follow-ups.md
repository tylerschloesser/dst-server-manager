# Follow-ups

Everything here is **deliberately open**. The system is built, deployed and verified: three stacks
live, CI deploying on every push to `main`, the real-AWS lifecycle test green (42/42 as last
measured; 44 assertions since decisions §17 added the two join-record checks), and `tylerni2026`
booted, played and stopped unattended with its save in S3. Nothing below blocks anything; each item
says what it is, why it was left, and the exact command or file that closes it.

This file is public. No SteamID64, email, token or password goes in it.

## 0. Closed — nothing outstanding from the deploy phase

| Item | State |
|---|---|
| SNS email subscription on `dst-server-manager-budget` | **created and confirmed.** `aws sns list-subscriptions-by-topic` returns a real ARN, not `PendingConfirmation` |
| `project` cost-allocation tag | **Active.** `aws ce list-cost-allocation-tags --tag-keys project` → `project UserDefined Active` |
| Budget `dst-server-manager-monthly` | **deployed with its tag filter** (`user:project$dst-server-manager`, $5/month, 50 %/100 % actual + 100 % forecast). `-c budgetEnabled=false` was never needed |

Cost reporting still lags 24-72 h behind spend, so a budget showing $0 right after activity is
normal.

## 1. `scripts/check-secrets.sh` has no SteamID64 pattern

`CLAUDE.md` and `docs/decisions.md` both list "anyone's SteamID64" among the things that must never
be committed **and name this script as the guard**. It is not: `CONTENT_PATTERNS` covers the Klei
token, a real-looking `cluster_password` value, private keys, AWS access keys and email addresses,
and nothing else. A real 17-digit id pasted into a doc, a test fixture or a runbook example passes
the pre-push hook and reaches a public repo. (Security review defect 11, left open deliberately:
adding it after the fixtures existed would have needed allowlist entries in the same change, and the
review was read-only.)

**To close it**, in `scripts/check-secrets.sh`:

- add `'7656119[0-9]{10}'` to `CONTENT_PATTERNS`;
- add the four committed fake ids to `CONTENT_ALLOW` — they live in
  `e2e/support/session.ts`, `packages/api/src/auth/*.test.ts` and `packages/shared/src/derive.test.ts`
  (`grep -rlE '7656119[0-9]{10}' packages --include='*.ts' e2e scripts` finds every one);
- then `scripts/check-secrets.sh` must still print `check-secrets: ok`, and a scratch file holding
  any 17-digit id matching that pattern, `git add`ed, must make it fail.

The guard is the only thing missing — nothing sensitive is committed today.

## 2. The `cdk.out` greps of `docs/testing.md` §3 can be vacuous

`grep -rl` reports only that *nothing matched*, so a `cdk.out/` holding the wrong bytes passes every
"the marker is absent" check for the wrong reason. Two ways that happens:

- **A stale fixture asset.** `packages/infra/cdk.out/` accumulates one asset directory per synth and
  is never pruned, and the one credentialed fixture synth (`docs/infra.md` §5) stages the 53-byte
  stub from `packages/infra/test/fixtures/api-bundle/` as an `api.js` of its own. Beside the real
  4 MB bundle it is indistinguishable to the grep. **Mitigation used throughout execution:**
  `rm -rf packages/infra/cdk.out && pnpm build` before any diff, deploy or grep. Both
  `docs/testing.md` §3 and `docs/infra.md` §5 now say so, and §3 gained a positive control that
  makes the check non-vacuous:
  `grep -rlq 'auth\.callback' packages/infra/cdk.out/` — that string exists only in the real API
  bundle, so a `cdk.out/` full of stubs (or an `error.txt: CannotFindAsset`) now fails loudly.
- **The marker is only a comment.** `LOCAL_ONLY_MARKER = 'DST_LOCAL_ONLY'` appears in
  `packages/api/src/auth/testSecret.ts` as a **comment**, which esbuild strips, and is absent from
  `packages/api/src/local/localLauncher.ts` and `packages/api/src/fakes/*` entirely — so the marker
  greps could never have detected the fake launcher or the fakes reaching a bundle. What actually
  holds today is the structural argument (`src/handlers/api.ts` imports none of those modules) plus
  the grep for the test-secret **literal**, which esbuild cannot strip. **To close it:** make
  `testSecret.ts`, `src/local/localLauncher.ts` and `src/fakes/index.ts` each reference
  `LOCAL_ONLY_MARKER` in *live* code (e.g. a `void LOCAL_ONLY_MARKER;` at module scope, or include
  it in an exported name), then re-run the four greps of `docs/testing.md` §3.

(Security review defect 9. The review also called `cdk.out/` "checked-in"; it is `.gitignore`d —
only `cdk.context.json` is committed — so nothing here depends on a committed artifact.)

## 3. `packages/web` has no jsdom and no testing-library

Its Vitest files are `*.test.ts`, never `*.test.tsx`: they exercise **extracted functions** — the
countdown maths, `lib/format.ts`, the query/mutation option builders, the API client's status
handling, the derived per-world status — not rendered components. Rendering is covered only by the
Playwright suite (`docs/web.md` §7), which is not in CI (decisions §16.24). So a purely visual
regression that Playwright's assertions do not name can ship.

**To close it:** add `jsdom` and `@testing-library/react` + `@testing-library/user-event` as
devDependencies of `packages/web`, set `environment: 'jsdom'` in `packages/web/vitest.config.ts`,
and add `*.test.tsx` files for `WorldCard`, `JoinPanel` and the two modals against the exact
accessible names `docs/web.md` §3 fixes. Keep the existing function-level tests; they are cheaper
and they are what the status/countdown logic actually needs.

## 4. Playwright's `reuseExistingServer` can test the wrong app

`playwright.config.ts` sets `reuseExistingServer: !process.env.CI` on both web servers. Playwright
checks that the **port answers**, not that the right app is behind it, so any unrelated dev server
holding `5173` (or `8787`) silently becomes the system under test. It produced a loud, baffling
failure once during execution — but the same mechanism can just as easily produce a **false pass**,
and `pnpm e2e` is the last step of `pnpm check`.

**Diagnose:** `lsof -i :5173 -i :8787` before believing an `pnpm e2e` result that surprises you.
**To close it:** either set `reuseExistingServer: false` unconditionally (costs a few seconds per
run), or have `e2e/support/fixtures.ts` assert in a `beforeAll` that
`GET http://localhost:8787/api/worlds` returns exactly the two seeded worlds `test-a` and `test-b`
(`docs/control-plane.md` §5.5) — a cheap identity check that fails fast against a foreign server.

## 5. The local gate can resolve an import from outside the repo

`pnpm typecheck` passed locally while the **first CI run failed**: `undici` resolved from
`~/node_modules` on this machine, so a missing dependency was invisible locally. Node's resolution
walks parent directories all the way up, and the repo is not at `/`.

**CI is the authority.** A green `pnpm check` is necessary, not sufficient; the clean-checkout,
`--frozen-lockfile` install in `.github/workflows/deploy.yml` is what decides.
**To reproduce the hazard deliberately:** `ls ~/node_modules` — anything there is on the local
resolution path. **To close it:** run the gate in a clean tree before a risky push —
`git clone --depth 1 . /tmp/dst-clean && cd /tmp/dst-clean && pnpm install --frozen-lockfile && pnpm check` —
or add a CI-only job that runs `pnpm typecheck` with `NODE_PATH=` and a pristine `~`. Not worth
automating for a two-person server; worth knowing when CI disagrees with your laptop.

## 6. us-west-2 contains a pre-existing launch template that is not ours

`InstanceLaunchTemplate` (created 2026-09-07, **untagged**, referenced nowhere in this repo) belongs
to another site in this shared account. **It must never be touched, modified or deleted.**
`aws ec2 describe-launch-templates --region us-west-2` lists it beside
`dst-server-manager-game`, which is why **`docs/testing.md` §6 check 5 is tag-scoped**
(`--filters Name=tag:project,Values=dst-server-manager`): an unscoped "and nothing else there"
assertion is not a contract this project can ever satisfy, and `CLAUDE.md` forbids touching anything
this project did not create.

Nothing to close. It is recorded so nobody later "tidies up" a stray-looking template, and so nobody
mistakes the tag scoping for a weakened check.

## 7. ~40 code comments point at two deleted docs

`docs/_first-boot-notes.md` (the append-only log of the first-boot fix rounds) and
`docs/_security-review.md` were working files for the build and have been deleted; everything durable
in them is folded into `docs/decisions.md`, `docs/game-server.md`, `docs/control-plane.md`,
`docs/storage.md`, `docs/testing.md`, `docs/auth.md` and this file. But comments in `packages/**` and
`scripts/**` still cite them by path — they explain *why* a line exists and are worth keeping, only
the reference now dangles.

```bash
grep -rln '_first-boot-notes\|_security-review' packages scripts --include='*.ts' --include='*.sh' \
  packages/supervisor/assets | grep -v cdk.out      # the files to re-point
```

**To close it:** repoint each citation at the permanent section that now carries the fact — round 1
→ `docs/game-server.md` §4/§5/§6, round 2 → `docs/game-server.md` §6/§7, round 3 →
`docs/game-server.md` §8 / `docs/control-plane.md` §2 (S8), round 4 → `docs/storage.md` §6 /
`docs/game-server.md` §10, security-review defects → `docs/follow-ups.md` §1/§2 or the fixed
behaviour's own doc section. Cosmetic; it changes no behaviour, so it was not done in the cleanup
pass (which owns `docs/**` only).

## 8. No heartbeat is written while `starting` — a decision, not a bug

`heartbeatAt` freezes for the whole of a boot *and* for the whole of an in-place switch's new
session. On a first boot the reaper's 15-minute instance-age grace covers it (decisions §16.8), but
**after a switch the instance is already older than that**, so a new world that took more than ~10
minutes to become joinable would be terminated by the reaper mid-boot. That is exactly the failure
mode of the FIFO race in `docs/game-server.md` §6 — now fixed, but the exposure is structural.

Writing S3 during `starting` would fix it *and* would weaken a cost-safety backstop (an instance
that boots forever would keep proving it is alive), which `CLAUDE.md` forbids doing casually. So it
is **Tyler's call**, not a fix round's. If it is ever wanted, the shape that keeps the backstop is a
*bounded* one: write `heartbeatAt` during `starting` only until `startedAt + 15 min`, after which the
supervisor's own boot timeout has already fired. File: `packages/supervisor/src/index.ts`, the
`starting` poll loop.

## 9. No stored object carries the cluster password — verified, nothing to do

DST mirrors the live settings — password included — into its own `<Shard>/save/shardindex`
(`docs/storage.md` §6), so until that file was blanked in the staged copy, any save tarball written
by a booted world would have carried the value into S3, where `s3:DeleteObject` and
`s3:DeleteObjectVersion` are **denied by the bucket policy** (`docs/storage.md` §3) and could not be
removed without that section's deliberate policy edit.

**That never happened in this account.** The blanking landed before `tylerni2026` was ever booted
under this system, and every `test-*` object was purged by the lifecycle test's teardown. Every
save-bearing object in the bucket was scanned by hand against the live `/dst/cluster-password` and
`/dst/klei-token` values (both confirmed non-empty first, so the scan cannot pass vacuously):

| Object | Versions | Password hits | Token hits |
|---|---|---|---|
| `worlds/tylerni2026/save.tar.zst` | 2 (seed import + first real stop) | 0 | 0 |
| `inflight/tylerni2026/save.tar.zst` | 3 (the 10-minute safety copies) | 0 | 0 |
| `sessions/tylerni2026/<sessionId>/*` | manifest + 5 logs | 0 | 0 |
| `worlds/test-prune/save.tar.zst` | 12 | n/a — 3-byte dummies, not saves | n/a |

The seed zip in `seed/` is Tyler's own original export and never contained this system's password;
its `shardindex` password fields were already blank.

**So there is nothing to rotate and nothing to delete.** Rotating `/dst/cluster-password` remains a
one-command operation if ever wanted (`aws ssm put-parameter --overwrite`, us-west-2, no deploy —
the supervisor injects the new value on the next boot), but no stored object justifies it.

## 9b. The automated leak check does not cover `inflight/`

The lifecycle test's phase-4 leak check scans the extracted save tarball and every
`sessions/test-*` object, but **not** `inflight/`, and the 10-minute safety copy is written by a
different call site from the stop-path pack. The three real `inflight/tylerni2026` versions were
clean when checked by hand (above, and each contains its 2 blanked `shardindex` files), so the
staging path is shared in practice — but nothing asserts that, and a future change to the inflight
path would not be caught.

To close it, add `inflight/test-` to the prefixes that phase 4's `scanForSecretLeaks` walks in
`scripts/lifecycle-test.ts`, alongside the `sessions/test-` listing.

## 10. The `s3:DeleteObjectVersion` deny probe could be sharpened

`scripts/lifecycle-test.ts` phase 6 asserts the **shape** of the
`DenyDeleteOutsideScratchPrefixes` statement rather than firing a live versioned delete, because a
`VersionId` that does not exist is rejected with `InvalidArgument` **before** the bucket policy is
evaluated, and the only request guaranteed to reach the policy would be a delete of a real version of
a real non-test object — i.e. of the save the policy exists to protect. That assertion is already
strictly stronger than the probe it replaced.

Measured during the cleanup pass: the literal `--version-id null` **does** reach the policy and comes
back `AccessDenied` on `s3:DeleteObjectVersion`, because `null` is a syntactically valid version id.

```bash
AWS_PROFILE=admin aws s3api delete-object --region us-west-2 \
  --bucket dst-server-manager-data-063257577013 \
  --key "sessions/deny-probe-$(uuidgen)/nothing.txt" --version-id null 2>&1 | grep -q AccessDenied
```

**To close it:** add that as a live probe *beside* the statement assertion in phase 6 — not instead
of it, since only the assertion can catch an over-broad `NotResource`. Note there is no
`aws s3api delete-object-version` subcommand; the versioned delete is
`delete-object --version-id <id>`.

## 11. A halt that never owned the join record still sinks it

`haltNow` (`packages/supervisor/src/tasks/joinDns.ts`) sinks `play.dst.ty.ler.dev` to `192.0.2.1`
on **every** poweroff, which is exactly what makes the coverage provable by one grep
(`docs/game-server.md` §9). Four of the eight call sites, though, belong to a supervisor that never
published the record in the first place: `imds_identity_failed`, `boot_orphan`,
`claim_failed_boot_orphan` (all before the S1 claim), and `finishStop`'s `abandoned` branch (the
state item has since been taken by another session). If one of those fires **while a different
instance is legitimately running a world**, the sink points the name away from that live session,
and nothing republishes it until the next boot — the reaper only ever sinks, never points. Friends
fall back to the raw IP the UI still shows, so it is a degradation rather than an outage, and all
four are anomaly paths that have never been seen outside a deliberate test.

Left as it is because the alternative trades a provable invariant for a flag, and the failure mode
in the other direction — a record left pointing at a released EC2 address that AWS hands to a
stranger (decisions §17) — is worse than a name that briefly resolves nowhere.

**To close it**, give `haltNow` an explicit ownership argument rather than reintroducing a second
`shutdownNow` call site:

- `haltNow(deps, { ownsJoinRecord: boolean })`, sinking only when `true`;
- `false` at the four sites above, `true` at `finishStop`'s `halting` return, the mid-install
  supersede and the two post-claim failures (`claimed_state_missing_worldId`,
  `world_registry_missing`);
- the grep in `packages/supervisor/test/joinDns.test.ts` stays exactly as it is — it asserts that
  `src/index.ts` never calls `shutdownNow` itself, which is still the property that matters.
