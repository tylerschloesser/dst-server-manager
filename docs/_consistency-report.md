# Consistency pass over the seven domain docs

Temporary; the orchestrator deletes it. `decisions.md` was not edited. `scripts/check-secrets.sh`
prints `check-secrets: ok`.

Legend: **[16.n]** = decisions.md §16 clarification; **[own:x]** = made to match the owning doc.

---

## docs/control-plane.md (24 edits)

1. Header: `docs/supervisor.md` → `docs/game-server.md`; added a "Related docs" pointer list; scope
   now names `@dst/shared` / `@dst/api` / `scripts/import-world.ts`. **[16.2]**
2. §1 heading `packages/shared` → `@dst/shared`, with the "defined once, imported everywhere"
   statement. **[16.2]**
3. §1.1: added `SITE_BUCKET`, `API_FUNCTION_NAME`, `REAPER_FUNCTION_NAME`, `DOMAIN_NAME`,
   `PUBLIC_ORIGIN_PROD`, `HOSTED_ZONE_ID`/`ZONE_NAME`, `CAVES_SHARD_ID` **[16.5]**,
   `LOCAL_ONLY_MARKER` **[16.4]**, `SPA_CSP`. These are the names `infra.md` and `web.md` were
   already using under different spellings (`ACCOUNT`, `WEB_REGION`, `PROJECT_TAG`,
   `GAME_INSTANCE_TYPE`); infra.md was changed to these, not the reverse.
4. §1.1 `PARAM_CACHE_MS` comment no longer claims to cover the allowlist (auth.md owns that TTL).
5. §1.2 `ClusterStateItem`: added `desiredByNickname` and `startedByNickname`, with the note that
   the instance never reads `/dst/users`. **[16.6]**
6. §1.2 `sessionId` comment: "uuid v4" → `SESSION_ID_RE`. **[16.3]**
7. `ids.ts`: `newSessionId()` was `crypto.randomUUID()`; now `YYYYMMDDTHHMMSSZ-<6 lowercase hex>`
   with `SESSION_ID_RE`, plus who mints it and the `-az<n>` ClientToken rule. **[16.3]**
8. W1/W2/W3 now also write `desiredByNickname` / `startedByNickname`. **[16.6]**
9. S1–S4 prose replaced by an explicit table using the labels **S1, S2, S3, S4, S7** so
   `game-server.md` can reference them one-for-one; added **S7** (the error write game-server.md had
   as "#4" with no counterpart here).
10. S4 gained the `NOT begins_with(lastStopReason, 'reaper-')` guard — the supervisor must not
    overwrite a `reaper-*` reason. **[16.13]**
11. S2 `REMOVE lastError` → `SET lastError = :null` (the doc's own "no missing attributes" rule;
    game-server.md was using `REMOVE` throughout). **[own:control-plane]**
12. S5: added `startedByNickname = :desiredByNickname` and the "instance is never re-tagged" note.
    **[16.6, 16.7]**
13. S6: `heartbeatAt = :now` → `heartbeatAt = :null`, with the §16.10 attribute list spelled out.
    **[16.10]**
14. R1: now also writes `lastStopReason = reaper-max-age` (and `desiredByNickname`). **[16.13]**
15. §4 launcher: `Version: '$Default'` → `'$Latest'`. **[own:infra §3.6, which says "never
    `$Default`"]**
16. §4: added the launch-template-tags / no-`NetworkInterfaces` / `SubnetId` rationale. **[16.16]**
17. §5.1 `StateStore` methods take `nickname`.
18. §5.2 entry file `packages/api/src/index.ts` → `packages/api/src/handlers/api.ts`, tied to
    infra.md's `NodejsFunction` entry and testing.md's `dist/lambda/api.js`. **[own:infra]**
19. §5.4 `WorldSummary` trimmed from six fields to exactly `{ worldId, displayName, status }`;
    added `MeResponse`; added "POST returns a full `WorldsResponse`". **[16.9]**
20. §5.4 `startedBy` is now `state.startedByNickname` (was an allowlist lookup in the API).
    **[16.6]**
21. §5.5: **the doc said "There are no dev-only routes"**, contradicting §16.4, web.md and
    testing.md. Replaced with a "Local-only routes" subsection defining `GET /api/dev/login`
    (`APP_ENV=local`) and `POST /api/test/control` (`APP_ENV` `test`|`local`), their request shapes
    and the `DST_LOCAL_ONLY` marker. **[16.4]**
22. §5.5: port 8787/5173 stated explicitly; fake registry seeds exactly two worlds `test-a` /
    `test-b` (was `tylerni2026` + two test worlds, which broke web.md's "both world articles"
    e2e assertions). **[own:web §7]**
23. §6: entry `packages/api/src/reaper/index.ts` → `handlers/reaper.ts`; `now` clamp called out;
    added the `ReaperResult` return type; rule order stated as orphan → max-age → stale; orphan
    AND-rule rationale expanded. **[16.13, 16.14, 16.7]**
24. §9 `import-world`: unified the two conflicting CLIs (`--world-id` here vs `--id/--zip/--name/
    --world-only` in storage.md) into one flag list. §8 test lists updated for the new
    `startedByNickname`, `WorldSummary` shape, `newSessionId`, reaper order and `ReaperResult`.

## docs/game-server.md (14 edits)

1. Header: added §16 to the authority list and a "Related docs" list naming who owns the DynamoDB
   expressions and the tarball format.
2. §3 user-data placeholders `__BUCKET__/__REGION__/__TABLE__/__TABLE_REGION__` →
   `__DATA_BUCKET__/__GAME_REGION__/__TABLE_NAME__/__CONTROL_REGION__`, matching what infra.md
   substitutes (infra.md also gained `__NODE_VERSION__`/`__NODE_SHA256__`). **[own:infra §3.6]**
3. §8: the numbered write table (#1–#7, with `REMOVE` clauses) replaced by a label table pointing at
   control-plane.md's S1–S7 expressions; the `REMOVE` convention is gone. **[own:control-plane]**
4. §8: added "S4 never overwrites a `reaper-*` reason". **[16.13]**
5. §8: prose write references `#1/#2/#3/#4/#5/#6/#7` renumbered to `S1…S7` throughout (also §9
   step 6 and the §12 reduce tests).
6. §8 in-place switch: **removed the `ec2:CreateTags` re-tagging call** and the claim that the
   reaper would otherwise kill the instance; replaced with the AND orphan rule. **[16.7]**
7. §8 switch: `crypto.randomUUID()` → shared `newSessionId()`. **[16.3]**
8. §8 IMDS: removed the `ec2:DescribeTags` fallback (the instance role has no `ec2:*`).
   **[16.7, own:infra §3.5]**
9. §10 `dst-pack-save`: rewritten to storage.md's exclude patterns, `ZSTD_CLEVEL=3
   ZSTD_NBTHREADS=0 tar --zstd` form and archive-root layout; added "do not port the spike's
   `dst-save-push` verbatim". **[16.22, own:storage §6]**
10. §10 manifest: `startedBy` no longer resolved by reading `/dst/users`; it is
    `state.startedByNickname`. **[16.6]**
11. §10 manifest `stopReason` typed as the shared `StopReason` (was a narrower inline union that
    contradicted storage.md's schema). **[own:storage §8]**
12. §10: added the pre-upload log scrubbing rule (exact match on token/password, covering
    `supervisor.log` too). **[16.22]**
13. §10: `supervisor.log` described as required by §16.22 rather than "an addition to §8".
14. §11: `pnpm --filter supervisor build` → `@dst/supervisor`; bundle output pinned to
    `packages/supervisor/dist/runtime` and `destinationKeyPrefix: 'runtime'`. **[own:infra §3.2]**

## docs/storage.md (14 edits)

1. Header: added §16.22–16.23 and a "Related docs" list.
2. §1 key table: `sessions/` row now lists `supervisor.log`. **[16.22]**
3. §2: **"Exactly two rules" → three rules**; the per-rule `AbortIncompleteMultipartUpload` entries
   were replaced by one bucket-wide abort-only rule; rule ids renamed to infra.md's
   (`worlds-noncurrent`, `inflight-noncurrent`, `abort-mpu`). **[16.19]**
4. §2 rationale paragraph updated for the bucket-wide rule.
5. §4: instance role does not read `inflight/*` (infra.md granted it; now both say write-only).
6. §4: API Lambda row now says "no S3 access at all" citing §16.17.
7. §6: archive-root layout flagged as §16.22 and named as the single definition that game-server.md
   and import-world reproduce.
8. §6: the "`docs/spikes/artifacts/dst-save-push` has the correct list" line now warns that its
   *layout* is wrong and must not be copied verbatim. **[16.22]**
9. §7: `scripts/import-world --id … --zip …` → `pnpm tsx scripts/import-world.ts --world-id …
   --zip …`, pointing at control-plane.md §9 for the flag list. **[own:control-plane]**
10. §7 step 3: `--name` → `--display-name`; noted `--server-name`/`--no-caves` as overrides.
11. §8: added `supervisor.log` to the prefix listing and the scrubbing note; `sessionId` example
    `20260919T2013Z-a7f3k2` → `20260919T201355Z-a7f3k2`. **[16.3, 16.22]**
12. §8: `stopReason` comment now describes the shared union and what the instance can write.
13. §9: `pnpm -C packages/infra exec cdk deploy DstGame` → `pnpm --filter @dst/infra exec cdk deploy
    DstGame --region us-west-2`. **[16.2, own:infra]**
14. §10.5 and §11: import-world invocation fixed; `startedBy` sourced from `startedByNickname`;
    scrubbing extended to `supervisor.log`.

## docs/auth.md (11 edits)

1. Header: added §16.1/§16.12/§16.21 and a "Related docs" list; stated what this doc owns.
2. §0 `PUBLIC_ORIGIN` local value `http://localhost:3001` → `http://localhost:5173` (the Vite dev
   server origin, which is what the CSRF check compares against). **[own:web §6 / control-plane
   §5.5 — judgment call, see below]**
3. §0: `APP_ENV` described as the one discriminator with its three values and which command sets
   which. **[16.1]**
4. §0: added "only `APP_ENV` and `PUBLIC_ORIGIN` are env vars; everything else is a `@dst/shared`
   constant" — infra.md was setting six more. **[own:auth + control-plane §1.1]**
5. §0/§4: `packages/shared` → `@dst/shared`. **[16.2]**
6. §4: the "role grants `ssm:GetParameter` on that one ARN and `/dst/users` only" claim replaced by
   the three-parameter + cross-region KMS description. **[16.17]**
7. §6 `requireUser` returns `code: 'unauthorized' | 'not_allowed'` instead of
   `error: 'unauthenticated' | 'not-allowed'`. **[own:control-plane §5.3]**
8. §6.2 and §8.1 error bodies switched from `{"error":"forbidden"}` / `{"error":"<error>"}` to the
   shared `{"error":{"code","message"}}` envelope. **[own:control-plane §5.3]**
9. §6.2: `startedBy` description updated for `startedByNickname`. **[16.6]**
10. §8.1: added the closed redirect set. **[16.12]**
11. §8.3: `<MantineProvider forceColorScheme="dark">` → `defaultColorScheme="dark"`, plus "no
    `<ColorSchemeScript>`, no toggle, plain `Modal`"; added `X-Frame-Options: DENY` (infra.md ships
    it) and a note that the CSP is exported as `SPA_CSP`; justified `includeSubDomains`.
    **[16.21]** §9.3: local API path/port/origin fixed and the dev-login route cross-referenced.

## docs/web.md (9 edits)

1. Header: "Related docs" list; added §16 to the source-of-truth line.
2. Type names: `WorldStatus`, `World`, `ActiveWorld` → `ClusterStatus`, `WorldSummary`,
   `ActiveInfo` (+ `JoinInfo`, `WorldsResponse`, `MeResponse`, `StopReason`); `packages/shared` →
   `@dst/shared`. **[16.2, own:control-plane §5.4]**
3. §1: added the explicit "do not render `<ColorSchemeScript>`, ship no inline script" rule with
   the CSP reason. **[16.21]**
4. §4: the "ignore the POST response body" note now says the 200 body is a full `WorldsResponse`.
   **[16.9]**
5. §6: `DST_ENV=local` → `APP_ENV=local`. **[16.1]**
6. §6: local entrypoint `packages/api/src/local/server.ts` → `packages/api/src/local.ts`.
   **[own:control-plane §5.5]**
7. §6: dev-login guards now defer to control-plane.md §5.5 and name the `DST_LOCAL_ONLY` marker.
   **[16.4]**
8. §7: `DST_ENV=test` → `APP_ENV=test`, with `PUBLIC_ORIGIN=http://localhost:5173`; the test secret
   is `TEST_SESSION_SECRET` from `packages/api/src/auth/testSecret.ts`, not an unnamed env var.
   **[own:auth §4]**
9. §7: the duplicated `/api/test/control` request-shape block now points at control-plane.md §5.5;
   `reset()` documented as restoring `test-a` / `test-b`.

## docs/infra.md (20 edits)

1. Header sibling list: `docs/supervisor.md` → `docs/game-server.md`; added web.md and testing.md;
   marked auth.md as owning every security header.
2. §0: root script names deferred to testing.md §1; `pnpm --filter infra` → `@dst/infra`
   (10 occurrences). **[16.2]**
3. §1.1: `ACCOUNT`→`ACCOUNT_ID`, `WEB_REGION`→`CONTROL_REGION`, `PROJECT_TAG`→`PROJECT`,
   `GAME_INSTANCE_TYPE`→`INSTANCE_TYPE`. **[own:control-plane §1.1]**
4. §1.1: `supervisorBundlePath` default `../../supervisor/dist-bundle` →
   `../../supervisor/dist/runtime`. **[own:game-server §11]**
5. §3.1: the `worlds/` rule (which was missing from the snippet's list in effect) and the
   `inflight/` rule gained `expiredObjectDeleteMarker: true`; the abort-MPU rule annotated as
   bucket-wide. **[16.19, own:storage §2]**
6. §3.5 instance role: `ReadWriteSaves` split so `inflight/*` is write-only; `dynamodb:Query`
   dropped; added the explicit "no `/dst/users`, no `ec2:CreateTags`, no `ec2:DescribeTags`,
   no `ec2:*` at all" paragraph. **[16.6, 16.7, own:storage §4 + game-server]**
7. §3.6: user-data substitution list fixed to the game-server placeholder names and extended with
   the two Node placeholders from `assets/node.env`. **[own:game-server §3]**
8. §3.6: added the §16.16 note that the template holds project/role/Name and RunInstances adds
   `sessionId`.
9. §4.2 API env: `DST_ENV: 'prod'` → `APP_ENV: 'prod'`; removed `TABLE_NAME`, `DATA_BUCKET`,
   `GAME_REGION`, `LAUNCH_TEMPLATE_NAME`, `GAME_INSTANCE_TYPE`, `USERS_PARAM`,
   `SESSION_SECRET_PARAM`, `CLUSTER_PASSWORD_PARAM` — auth.md §0 and control-plane §1.1 both say
   these are shared constants, not env vars, and `DATA_BUCKET` contradicted "the API has no S3
   access". **[16.1, 16.17]**
10. §4.2 reaper env: `TABLE_NAME`/`GAME_REGION`/`PROJECT_TAG`/`MAX_SESSION_HOURS` → `APP_ENV` +
    `NODE_OPTIONS`.
11. §4.2 IAM orientation paragraph expanded to match control-plane §7 statement for statement
    (adds `ec2:CreateTags` with `ec2:CreateAction`, `ec2:DescribeVpcs`, the cross-region SSM+KMS
    pairing) and now says **no S3 access at all** rather than "no `s3:Delete*`". **[16.17]**
12. §4.3 response-headers policy: `STRICT_ORIGIN_WHEN_CROSS_ORIGIN` → `NO_REFERRER` and
    `includeSubdomains: false` → `true`, to match auth.md §8.3 (whose stated reason for
    `includeSubDomains` is also correct: HSTS covers subdomains of `dst.ty.ler.dev`, not siblings
    of it). CSP constant referenced as `SPA_CSP` from `@dst/shared`. **[own:auth §8.3]**
13. §5: `packages/shared` → `@dst/shared` with the control-plane constant names.
14. §5: `pnpm -r build` → `pnpm build`. **[own:testing §1]**
15. §6 workflow: `pnpm -r lint|typecheck|test|build` → `pnpm lint|typecheck|test|build`.
    **[own:testing §1/§7]**
16. §6: the "Playwright is not run here" bullet now cites §16.24 and says `pnpm e2e` is part of
    `pnpm check` locally. **[16.24]**
17. §7 assertion 4: two lifecycle rules → three, including the abort-only rule. **[16.19]**
18. §7 assertion 8: added "no statement with any `ec2:` action" and "`/dst/users` not included".
19. §7 assertion 17: API env asserted as exactly `{APP_ENV, PUBLIC_ORIGIN, NODE_OPTIONS}`, neither
    role has `s3:*`; new 17bis for the site bucket RETAIN / no autoDeleteObjects and the two header
    values. **[16.17, 16.18]**
20. §3.2 `Source.asset` note: `pnpm --filter supervisor build` → `@dst/supervisor` (part of
    `pnpm build`).

## docs/testing.md (14 edits)

1. Header: added §16.4/16.23/16.24 and a "Related docs" ownership list.
2. §1: added a `pnpm dev` row (web.md tells implementers to run it) and an
   `import-world.ts` row; `pnpm lifecycle-test` cross-reference "section 6" → "section 4".
3. §1: `pnpm e2e` row notes `APP_ENV=test`.
4. §2 `shared` row: added the `sessionId` format test and an owner doc.
5. §2 session row: `env=test`/`env=prod` → `APP_ENV=…`. **[16.1]**
6. §2 reaper row: added the AND orphan rule, the rule order, R1 writing `reaper-max-age`, the `now`
   clamp wording and the `ReaperResult` assertion. **[16.7, 16.13, 16.14]**
7. §2 infra row: two lifecycle rules → three. **[16.19]**
8. §2 e2e row: viewports `390×844` / `1440×900` → `devices['Pixel 5']` / `1280×800`.
   **[own:web §7]**
9. §3: `DST_SESSION_SECRET` from `.env.example` → `TEST_SESSION_SECRET` in
   `packages/api/src/auth/testSecret.ts`; the grep command rewritten accordingly. **[own:auth §4]**
10. §3: the local-only affordances listed as the dev-login route, `/api/test/control` and the fake
    launcher, citing §16.4 and control-plane §5.5.
11. §4.3: test worlds `source=generated` → `source=test` (control-plane §9 refuses a `test-` id
    unless `--source test`; game-server §5 treats both as the generate path). **[own:control-plane]**
12. §4.4 phase 0: `env=test` → `APP_ENV=test`.
13. §4.4 phase 4: added `*/backup` to the must-not-list set and the archive-root assertion; leak
    check extended to `supervisor.log`. **[16.22]**
14. §4.4 phase 8: reaper summary `{ now, evaluated, nulledDesire, terminated, reconciled }` trimmed
    to the three fields of §16.14; the rule-order sentence now cites §16.13.

---

## Judgment calls (step 4 — conflicts decisions.md does not settle)

1. **`PUBLIC_ORIGIN` locally.** auth.md said `http://localhost:3001`; web.md and control-plane.md
   say Vite serves on 5173 and proxies to the API on 8787. Since the CSRF check compares the
   *browser's* `Origin`, `http://localhost:5173` is the only value that can work. Applied in
   auth.md §0 and §9.3, web.md §7.
2. **Launch-template version on `RunInstances`.** control-plane.md said `$Default`, infra.md said
   `$Latest` with an explicit "never `$Default`" rationale (CloudFormation lags the default-version
   pointer). Chose `$Latest` everywhere.
3. **HSTS `includeSubDomains` and `Referrer-Policy` on the SPA behaviour.** infra.md had
   `includeSubdomains: false` + `strict-origin-when-cross-origin`; auth.md (the owner) specifies
   `includeSubDomains` + `no-referrer`. Chose auth.md's values; infra.md's stated reason for
   `false` was also factually wrong (HSTS `includeSubDomains` on `dst.ty.ler.dev` covers
   `*.dst.ty.ler.dev`, not siblings under `ty.ler.dev`).
4. **`scripts/import-world` CLI.** Two incompatible interfaces existed (control-plane's
   `--world-id/--display-name/--server-name/--source/--force`, storage's `--id/--zip/--name/
   --world-only`). Merged into one `pnpm tsx scripts/import-world.ts` flag list, keeping every
   behaviour both docs described, with `--zip` making `--server-name`/`--display-name` optional.
5. **Lambda entry / bundle paths.** Three layouts existed. Settled on infra.md's
   `packages/api/src/handlers/{api,reaper}.ts` as the entry files (CDK owns the entry), with
   testing.md's `packages/api/dist/lambda/{api,reaper}.js` kept as the esbuild output that the
   `DST_LOCAL_ONLY` grep targets. Both now coexist without contradiction.
6. **Supervisor bundle directory.** `dist-bundle` (infra) vs `dist/runtime` (game-server, and
   consistent with testing.md's `dist/supervisor.js`). Chose `packages/supervisor/dist/runtime`.
7. **Local fake registry seed.** control-plane seeded three worlds (`tylerni2026` + two `test-*`);
   web.md's e2e asserts exactly two world cards after `reset()`. Chose two: `test-a`, `test-b`
   (which web.md's own `/api/test/control` example already used).
8. **Lifecycle-test world `source`.** testing.md used `source=generated` for `test-lifecycle-a/b`;
   control-plane.md refuses a `test-` id unless `--source test`. Chose `source=test`, which
   game-server.md §5 treats identically for the generate-from-templates path.

## Not fixed / worth a second look

- `docs/decisions.md` §16.10 enumerates the attributes the final `stopped` write nulls but does not
  mention `sessionId` or `joinableAt`. Both S6 (control-plane) and the game-server table nulled
  them already and still do; I kept that and made the two docs identical rather than removing
  behaviour decisions.md does not forbid.
- `SPA_CSP` is listed in control-plane.md §1.1 as a name with the value elided ("exact string in
  docs/auth.md §8.3"), to avoid a second copy of the CSP that could drift. The implementer must
  copy auth.md §8.3's literal into `@dst/shared`.
