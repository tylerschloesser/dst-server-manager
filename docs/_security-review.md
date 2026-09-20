# Security review — T2.10

Read-only review. No product code was changed. Every "fails when removed" claim below was
**proved by mutation**: the repo (minus `node_modules`/`dist`/`.git`) was copied to a scratch
directory, one check at a time was neutered there, and `packages/api`'s Vitest suite (baseline:
13 files, **169 tests, all passing**) was re-run. "no test fails" below means the whole 169-test
suite stayed green with the check removed. The scratch copy has been deleted; `git status` is
clean.

Scope: (a) `packages/api/src/auth/` against every numbered check of `docs/auth.md` §3.1;
(b) the test-only secret and the local-only routes vs `dist/lambda/` and `cdk.out/`;
(c) every path by which `/dst/klei-token` or `/dst/cluster-password` could reach a log line, an S3
object, DynamoDB, a process argument or a thrown error in `packages/supervisor` and `scripts/`.

Test names are the Vitest `fullName`s (`<describe> > <title>`) from `docs/auth.md` §9.2.

## (a) `docs/auth.md` §3.1 — checks C0–C20

| check | covering test | verdict |
|---|---|---|
| check C0 | `mode / ns / pollution > 63. non-GET method on the callback -> 405` (`completeSteamLogin.test.ts:189`) | covered — neutering `index.ts:84` fails exactly that test |
| check C1 | `mode / ns / pollution > 62. rawQueryString longer than 4096 chars -> rejected` | covered — neutering `steamOpenId.ts:136` fails it |
| check C2 | `mode / ns / pollution > 59. duplicate openid.claimed_id, evil then good`, `60. duplicate openid.signed`, `61. duplicate state` | covered — neutering `steamOpenId.ts:147` fails all three (58 survives because `params` is last-wins, so "good then evil" is caught by C6/C11 anyway) |
| check C3 | `mode / ns / pollution > 55. mode = "id_res " (trailing space)`, `56. mode missing`; `54. mode = cancel` pins the `cancel` branch | covered — neutering `steamOpenId.ts:155` fails 55 and 56 |
| check C4 | `mode / ns / pollution > 57. ns = openid 1.1 namespace -> rejected` | covered — neutering `steamOpenId.ts:158` fails it |
| check C5 | none | **not covered** — neutering the `missing_param` loop (`steamOpenId.ts:163`) leaves all 169 tests green. C7+C8 subsume every name except `openid.sig`; a missing `openid.sig` is caught only by the real Steam (the fake always answers `is_valid:true`). Defect 3. |
| check C6 | `Forged provider > 5. op_endpoint = evil.example`, `6. trailing slash`, `7. host suffix lookalike`, `8. over http://` | covered — neutering `steamOpenId.ts:167` fails all four |
| check C7 | `Signed-field tampering > 22. signed has an extra field appended -> rejected by strict equality` | covered (equality half). The `REQUIRED_SIGNED` subset half (`steamOpenId.ts:173-175`) is redundant *by design* (§3.1: "so relaxing the equality later still leaves a check") and no test fails when it alone is removed — expected, not a defect. |
| check C8 | `Signed-field tampering > 21. signed names a field absent from the query` (passes via C7) | not independently covered — removing `steamOpenId.ts:180` leaves 169 green, because `EXPECTED_SIGNED`'s names are a subset of `REQUIRED_PARAMS`, so C5+C7 already guarantee presence. Redundant, not a hole. |
| check C9 | `Signed-field tampering > 18.`–`23.` (esp. `23. extra unsigned param is accepted, and is absent from the captured request body`) | structural, not independently observable — rebuilding `signedValues` from *all* `openid.*` params instead of the signed list leaves 169 green, because C7 pins `signed` to one exact string |
| check C10 | `Loose claimed_id > 17. claimed_id !== identity -> rejected` | covered — neutering `steamOpenId.ts:189` fails it |
| check C11 | `Loose claimed_id > 10. domain suffix after the id`, `11. trailing slash`, `12. open-redirect-shaped host`, `14. trailing newline, anchored, no m flag` | covered — un-anchoring `CLAIMED_ID_RE` fails all four |
| check C12 | none | **not covered** — neutering `steamOpenId.ts:199` (`BigInt(steamId64) < STEAMID64_MIN`) leaves 169 green. Case 16 (`.../id/00000000000000000`) is rejected by C11's `7656119` prefix, never reaching C12. Defect 4. |
| check C13 | `return_to > 24. host = dst.ty.ler.dev.evil.com`, `25. path traversal`, `26. scheme = http`, `30. userinfo` | covered — neutering the `return_to` guard fails all four |
| check C14 | `return_to > 27. return_to state=A while the request query has state=B`, `28. extra query param absent from the request URL`; `29.` pins the one-directional rule | covered — neutering `steamOpenId.ts:223` fails 27 and 28 |
| check C15 | `State / login CSRF > 32. state cookie present, return_to has no state param -> rejected` | partly covered — the null half is pinned by 32; the `BASE64URL_RE`/`length === 43` half can be removed with 169 green. Harmless: C16's MAC plus the timing-safe id comparison already constrain the value. |
| check C16 | `State / login CSRF > 31. no state cookie`, `33. cookie id != state query param`, `34. corrupted MAC`, `35. MAC of the wrong length`, `36. issuedAt 600s/601s`, `37. replay with an empty cookie header`, `39. cookie minted with a different stateKey` | covered — each of the four sub-checks (cookie presence, MAC, id equality, age window) has at least one test that fails when it alone is neutered. **But** the "cookie is now spent" half of C16/§3.3 has no test at all — defect 2. |
| check C17 | `Nonce / replay > 40. 10 minutes old`, `41. 10 minutes in the future`, `42. malformed`, `43. exactly 300s/301s`, `44. 60s/61s in the future` | covered — neutering the format check fails 42; neutering the window fails 40, 41, 43, 44 |
| check C18 | `Steam response parsing > 45. is_valid:false`, `46. no substring matching`, `47. no ns line`, `49. 403 -> retryable`, `50. 429 -> retryable`, `52. timeout -> retryable` | covered except the 4096-byte body cap: `53.` passes for the wrong reason (defect 7). Also verified: the POST always goes to the `STEAM_OP_ENDPOINT` constant, `openid.ns`/`openid.mode` are ours not theirs, `redirect: 'manual'`, 5 s abort (`Happy path > 3.`, `4.`). |
| check C19 | `Session / allowlist > 68. valid login by a SteamID not in the allowlist -> no session Set-Cookie`; also `Forged provider > 9.` and `84.`–`88.` for the `requireUser` side | covered — forcing `if (true)` at `index.ts:109` fails 68. Ordering is right: the allowlist is consulted **before** `mintSessionTokenImpl` is ever called. |
| check C20 | `Session / allowlist > 69. session Set-Cookie matches the exact shape`, `70. round-trip`, plus the whole `Happy path` group | covered — 69 pins the exact `__Host-dst_session=…; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax` string, so removing or weakening the mint/cookie step fails it |

### Adjacent checks verified in the same pass (not part of C0–C20)

Session verification (§5.2), mutated step by step: step 4 (env discriminator) → `71.`/`72.` fail;
step 7 (timing-safe MAC) → `73.`/`88.` fail; step 8 → `78.`; step 9 → `79.`; step 11 `exp` → `76.`;
step 11 `iat` → `77.`; step 2 → `80.`; step 3 → `81.`/`82.`. Not independently observable:
step 5 (base64url/length) and step 6 (canonical encoding) cover each other; step 10
(`Number.isSafeInteger`) and step 11's `exp - iat <= SESSION_MAX_AGE_S` fail no test — all three
are unreachable without the HMAC key, so this is defence in depth, not a hole. Step 1's
`MAX_TOKEN_LEN` is defect 7.

CSRF/headers: dropping the `Origin` comparison fails `94.`; dropping the `X-DST-Request`
comparison fails `95.`/`96.`; dropping `API_SECURITY_HEADERS` from `router.ts`'s `finalize()`
fails 7 tests including the 204-without-`content-type` case. Allowlist: removing the entry
validation fails `86.`; removing the allowlist check in `requireUser` fails `84.`–`88.`; treating
a duplicated session cookie as present fails `90.`. The three previously-fixed items were
re-verified as genuinely fixed: the five headers are applied once, centrally, in
`router.ts:77-91`; `hasNoBody()` strips `content-type`/`content-length` from 204/304/bodyless
responses; the base64url corruption helper flips a bit in byte 0
(`steamOpenId.test.ts:86-90`); `hkdfSync` appears in exactly one file (`auth/secrets.ts`) and
`deriveSessionKey` is the single export everything else uses; `local.ts:121-125` returns a real
one-entry allowlist and is `DST_LOCAL_ONLY`.

## (b) The test-only secret and the local-only routes cannot reach `dist/lambda/`

Structural: `src/handlers/api.ts` and `src/handlers/reaper.ts` are the only esbuild entry points
(`packages/api/esbuild.mjs:7`). Neither imports `src/local.ts`, `src/local/localLauncher.ts`,
`src/fakes/*` or `@dst/api/test-secret`; `src/auth/index.ts` does not re-export
`TEST_SESSION_SECRET`; `src/auth/secrets.ts` names neither the constant nor any env-var fallback.
A repo-wide grep confirms `@dst/api/test-secret` is imported only by `src/local.ts:16`,
`e2e/support/session.ts:7` and (as prose) `scripts/mint-cookie.ts`.

Empirical, after a fresh `pnpm --filter @dst/api build` and an offline `cdk synth` into a scratch
output directory (`--no-lookups`, no AWS call, repo `cdk.out/` untouched):

| grep | `packages/api/dist/lambda/` | real `cdk.out` |
|---|---|---|
| `dst-local-test-secret-not-for-production` | 0 hits | 0 hits |
| `DST_LOCAL_ONLY` | 0 hits | 0 hits |
| `/api/dev/login`, `/api/test/control` | 0 hits | 0 hits |
| `TEST_SESSION_SECRET`, `localpass1`, `failNext`, `FakeStateStore`, `LocalFakeLauncher` | 0 hits | 0 hits |

The scratch synth is provably non-vacuous: its `asset.ba00…/api.js` is the real 3.9 MB bundle
(it contains `auth.callback`). Checked-in `packages/infra/cdk.out/` is **not** — see defect 9.

## (c) Klei token / cluster password — every reachable sink

| Sink | Path | Finding |
|---|---|---|
| Process arguments | `assets/bin/dst-shard`, `dst-console`, `dst-stop`, `dst-pack-save`, `install.sh`, `user-data.sh` | clean. No secret is ever an argv element; no helper runs `set -x`. `user-data.sh` (world-readable via IMDS) carries only bucket/region/table/Node version+sha. |
| Disk | `tasks/restore.ts:102-105` writes `cluster_token.txt` mode 0600 then `chown -R dst:dst`; `enforceClusterIni` writes the password into `cluster.ini` | as designed |
| S3 `worlds/` + `inflight/` | `tasks/savePush.ts:54-77` → `assets/bin/dst-pack-save` only; the same staged-copy + blank + single exclude list for the inflight copy | clean, but see defect 5 for the `scripts/` twin |
| S3 `sessions/` | `tasks/logsUpload.ts:45-73`, scrub list from `index.ts:253` | **defect 1** |
| DynamoDB | `adapters/ddb.ts` `errorNote`; the three call sites (`index.ts:662`, `892`, `915`) pass fixed strings | clean |
| `lastError` → `GET /api/worlds` | `routes/worlds.ts:63-66,92` stores `describeError(err)` from `RunInstances` | clean — EC2 errors carry no launch-template body |
| Log lines | `adapters/logger.ts:14-21` substring-redacts every revealed value; `Secret.toString()`/`toJSON()` yield `'***'`; `.reveal()` exists at exactly two call sites (`tasks/restore.ts:127,131`) | sound in the normal path, **defeated on the resume path — defect 1** |
| Thrown errors | `adapters/ssm.ts:27` and `adapters/ssm-parameter-store.ts:48` name the parameter, never the value; `router.ts:242-245` logs `err.name`/`err.message` only | clean |
| `scripts/` | `mint-cookie.ts` prints only the cookie; `lifecycle-test.ts:820-850` reads both secrets only to assert they do **not** appear in downloaded objects, printing hit counts | **defect 8** (vacuous when a value is empty) |
| IAM | instance role: `ssm:GetParameter` on `/dst/klei-token` + `/dst/cluster-password` only, no `/dst/users`, no `/dst/session-secret`, no `s3:PutObject` on `seed/` (`game-stack.ts:150-206`); API role: the three exact ARNs with `kms:ViaService`-scoped `kms:Decrypt` (`web-stack.ts:173-202`) | matches decisions §16.6/§16.17 |
| API response | `shared/src/derive.ts:51-78` puts the password in `active.join` only when `isJoinable(state)`, and only after `requireUser` (`router.ts:111`); `Cache-Control: no-store` on every response; no CORS headers (`98.`) | clean |

## Defects

1. [medium] `packages/supervisor/src/index.ts:253` — `secretsToScrub: revealedSecretValues()` gets the scrub list from the process-lifetime set that `Secret.reveal()` fills, and the only two `.reveal()` calls live in `restoreOrGenerateWorld` (`packages/supervisor/src/tasks/restore.ts:127,131`), which the **resume branch deliberately skips** (`packages/supervisor/src/index.ts:583-591`). `dst-supervisor.service` has `Restart=on-failure`, so after any supervisor crash the replacement process runs with an empty reveal set: `uploadSessionLogs` receives `[]`, `scrubText` (`tasks/logsUpload.ts:12-13`) returns the text unchanged, and `Master/server_log.txt`, `Caves/server_log.txt`, both chat logs and `supervisor.log` are uploaded to `sessions/<worldId>/<sessionId>/` **unscrubbed** — silently, with no warning. `adapters/logger.ts:16` is a no-op in that process for the same reason. Consequence: the exact-match guarantee that `docs/storage.md` §11 and decisions §16.22 state ("asserts … that neither the token value nor the password value it fetched from SSM appears in the file") does not hold on a path the design expects to be taken, and deletes under `sessions/` for a non-`test-` world are denied by the bucket policy (`packages/infra/lib/game-stack.ts:75-90`), so anything that does leak there cannot be removed. Not high only because it additionally requires DST to have written a secret into a log. Fix: stop deriving the list from side effects — in `finishStop` build it explicitly, e.g. `const secretsToScrub = [(await deps.secrets.getClusterPassword()).reveal(), (await deps.secrets.getKleiToken()).reveal()]` (both SSM reads are already cached by `adapters/ssm.ts`), and pass that; it also re-arms `logger.redact()`.
2. [medium] `packages/api/src/auth/index.ts:149` — the single-use property of the state cookie has **no test**. `docs/auth.md` §9.2 case 38 ("Every outcome … emits the state-clearing `Set-Cookie`") is the only number in 1–100 that is absent from `packages/api/src/auth/*.test.ts`. Proof: replacing `const cookiesOut = [clearStateCookie(APP_ENV)];` with `const cookiesOut: string[] = [];` leaves all 169 tests green, so a future edit that drops the clearing would ship silently and leave a MAC-valid `dst_oidc_state` cookie replayable for the rest of its 600 s window — the login-CSRF/replay defence C16 exists for. The code today is correct; only the guard is missing. Fix: add case 38 to `completeSteamLogin.test.ts` asserting `res.cookies[0]` equals the §3.3 clearing string for each of ok / cancelled / retryable / rejected / not-allowed.
3. [low] `packages/api/src/auth/steamOpenId.ts:163` (C5) — the `missing_param` loop fails no test when removed. Only `openid.sig` is uniquely protected by it (every other name is already forced present by C7+C8), and the unit tests' `fetchSteam` fake answers `is_valid:true` unconditionally, so a `sig`-less assertion is accepted in the suite. Fix: one case — drop `openid.sig` from `validQuery()` and assert `rejected` with `fetchSteam` never called.
4. [low] `packages/api/src/auth/steamOpenId.ts:199` (C12) — the `STEAMID64_MIN` range check fails no test when removed; case 16 is rejected one line earlier by `CLAIMED_ID_RE`. Not exploitable (Steam must still sign the assertion at C18), but the check is unguarded. Fix: add a case with `claimed_id = https://steamcommunity.com/openid/id/76561190000000001` (matches the regex, below the individual-account base) → `rejected`.
5. [low] `scripts/lib/save-tarball.ts:36` and `:104` — `blankClusterPassword` and `assertPasswordBlank` build their regexes with the `m` flag but **not** `g`, and `String.replace` with a non-global regex rewrites only the first match. `packages/supervisor/assets/bin/dst-pack-save:21` uses `sed`, which blanks **every** matching line. So the two implementations of decisions §16.36's "one way everywhere" differ: a `cluster.ini` in an imported zip carrying two `cluster_password` lines keeps the second value, `assertPasswordBlank` still passes (it finds the blanked first line), `verifySaveTarball` only inspects member names, and the stale password lands in `worlds/<id>/save.tar.zst`, where deletes are denied by the bucket policy. Fix: use `'gm'` in both, and make `assertPasswordBlank` assert the negative — no line matches `^[ \t]*cluster_password[ \t]*=[ \t]*\S`.
6. [low] `packages/api/src/auth/index.ts:85` — the C0 `405` response carries the §8.2 headers but not the state-clearing `Set-Cookie`, while `docs/auth.md` §3.3 says "**Every** callback response … and the state-cookie clearing `Set-Cookie`". Harmless today (`SameSite=Lax` keeps the cookie off a cross-site non-GET), but it is the one callback exit that leaves a spent-looking cookie alive. Fix: return `cookies: [clearStateCookie(APP_ENV)]` from that branch too, then defect 2's new test can assert "every outcome" literally.
7. [low] Two tests pass for the wrong reason and pin nothing. `packages/api/src/auth/steamOpenId.test.ts:549` (case 53, "body longer than 4096 bytes") sends `'a'.repeat(5000)`, which has no `:` and is therefore rejected by the `kv_parse` branch even with `MAX_KV_BODY_LEN` removed. `packages/api/src/auth/session.test.ts:202` (case 83, "rejected **without computing an HMAC**") sends a token whose MAC is garbage, so it is rejected by step 7 even with `MAX_TOKEN_LEN` removed. Fix: make 53's body a valid `ns:…\nis_valid:true\n` padded past 4096 with a `pad:…` line, and make 83 a genuinely valid oversized token (or spy on `createHmac`).
8. [low] `scripts/lifecycle-test.ts:260-263` — `countOccurrences` returns `0` for an empty needle, and phase 4 feeds it `kleiRes.Parameter?.Value ?? ''`. If either SSM read comes back empty or undefined (wrong region, renamed parameter, stripped permission), the "the Klei token and the cluster password never appear in …" assertion passes vacuously and prints `token hits=0, password hits=0` — the exact output a passing run prints. Fix: `if (kleiToken === '' || clusterPassword === '') throw new Error('secret value empty — leak check would be vacuous')` before the scan.
9. [low] `docs/testing.md` §3's grep 3/4 over `packages/infra/cdk.out/` are vacuous in the repo's as-found state: the checked-in `cdk.out/asset.dc26…/api.js` is the 53-byte fixture stub from `packages/infra/test/fixtures/api-bundle/`, not the Lambda bundle, and `cdk.out/error.txt` reads `CannotFindAsset`. A reviewer running the four commands without a preceding full `pnpm build` gets four passes that prove nothing about what deploys. Relatedly, the `DST_LOCAL_ONLY` marker is only a **comment** in `packages/api/src/auth/testSecret.ts:1` (esbuild strips it) and is absent entirely from `packages/api/src/local/localLauncher.ts` and `packages/api/src/fakes/*`, so grep 2/3 could not detect the fake launcher or the fakes reaching a bundle — contradicting `docs/testing.md` §3's claim that those modules "each import and reference the shared constant `LOCAL_ONLY_MARKER` at module scope". (I verified the real synth is clean; the *check* is what is weak.) Fix: add a not-vacuous precondition (`grep -rlq 'auth\.callback' packages/infra/cdk.out/`) alongside grep 1, and make `testSecret.ts`, `localLauncher.ts` and `src/fakes/index.ts` each reference `LOCAL_ONLY_MARKER` in live code.
10. [low] `packages/api/src/handlers/api.ts:42-48` — the production `AllowlistSource` swallows a malformed `/dst/users` and returns `{}`, so `allowlist.ts`'s classifier never sees the failure: the documented `{"evt":"auth.allowlist","error":"json"}` line (`docs/auth.md` §7 reason `json`) is never emitted in production, and the empty map is then **cached for 60 s** by `getAllowlist` (`allowlist.ts:69`), which §7 says explicitly not to do ("do not store the bad value"). Behaviour still fails closed (everyone gets 403), so this is a diagnosability defect, not an authorization one — and it means unit test 85 exercises a code path the Lambda does not have. Fix: let the adapter `throw` on a parse failure (and on a non-object) and let `allowlist.ts:30` classify it, which is what the port was designed for.
11. [low] `scripts/check-secrets.sh:15-22` — `CONTENT_PATTERNS` covers the Klei token, a real-looking cluster password, private keys, AWS access keys and email addresses, but there is **no SteamID64 pattern**, although CLAUDE.md and `docs/decisions.md` list "anyone's SteamID64" among the things that must never be committed and name this script as the guard. A real 17-digit id pasted into a doc, a test fixture or a runbook example would pass the hook and reach a public repo. Fix: add `'7656119[0-9]{10}'` to `CONTENT_PATTERNS` and add the four committed fakes (`7656119000000000[12]`, `7656119900000000[12]`) to `CONTENT_ALLOW`.
