# Auth and sessions (`packages/api/src/auth/`)

Implements `docs/decisions.md` §9, the auth routes of §10, and §16.1/§16.12/§16.21. Evidence:
`docs/research/steam-openid-auth.md` (§2 pitfalls, §3 checklist, §3bis tests) and
`docs/spikes/cloudfront-oac-lambda-url.md` (what the Lambda sees behind CloudFront).
**decisions.md wins over both.** Zero auth dependencies: Node 22 `node:crypto`, global `fetch`,
`URL`, `URLSearchParams` only.

This doc owns the env discriminator, the cookies, the redirect set and the security headers (both
the API's own and the SPA's CSP). Related docs: `docs/control-plane.md` (shared constants, the
router, the JSON error envelope, the local dev server) · `docs/web.md` (how the SPA consumes all
this) · `docs/infra.md` (the CloudFront response-headers policy that ships §8.3) ·
`docs/testing.md` (root scripts, lifecycle test).

## 0. Environment, constants, files

Lambda env vars (set by CDK; never read from a header, query param or cookie):

| Var | Prod value | Local/test |
|---|---|---|
| `APP_ENV` | `prod` (set on both Lambdas by CDK) | `local` for `pnpm dev`, `test` for Playwright — the same local entrypoint either way (decisions §16.1) |
| `PUBLIC_ORIGIN` | `https://dst.ty.ler.dev` | `http://localhost:5173` (the Vite dev server, which proxies `/api` to the local API on 8787) |

`APP_ENV` is the **only** env discriminator in the system; its three values are `prod | test |
local` and the string inside a session token is exactly that value. These two are the only env vars
either Lambda needs (plus `NODE_OPTIONS`): everything else — table, bucket, region, launch-template
and SSM parameter names — is a `@dst/shared` constant, not an env var (`docs/control-plane.md` §1.1,
`docs/infra.md` §4.2).

SSM (us-east-1, human-managed, never created by CDK): `/dst/session-secret` (SecureString),
`/dst/users` (String). Names are constants in `@dst/shared`, not env vars.

```ts
// packages/api/src/auth/constants.ts
export const OPENID_NS        = 'http://specs.openid.net/auth/2.0';
export const STEAM_OP_ENDPOINT = 'https://steamcommunity.com/openid/login'; // hardcoded, never from input
export const EXPECTED_SIGNED  = 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle';
export const REQUIRED_SIGNED  = ['op_endpoint','claimed_id','identity','return_to','response_nonce','assoc_handle'] as const;
export const CALLBACK_PATH    = '/api/auth/steam/callback';
export const CLAIMED_ID_RE    = /^https?:\/\/steamcommunity\.com\/openid\/id\/(7656119[0-9]{10})$/;
export const NONCE_RE         = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/;
export const STEAMID64_RE     = /^7656119[0-9]{10}$/;
export const BASE64URL_RE     = /^[A-Za-z0-9_-]+$/;
export const STEAMID64_MIN    = 76561197960265729n;   // individual-account base
export const NONCE_MAX_AGE_S  = 300;
export const NONCE_MAX_SKEW_S = 60;
export const STATE_MAX_AGE_S  = 600;
export const SESSION_MAX_AGE_S = 2592000;             // 30 days
export const MAX_QUERY_LEN    = 4096;
export const MAX_KV_BODY_LEN  = 4096;
export const MAX_TOKEN_LEN    = 1024;
export const SECRET_TTL_MS    = 300_000;              // 5 min
export const ALLOWLIST_TTL_MS = 60_000;               // 60 s
```

Files: `constants.ts`, `steamOpenId.ts` (login + callback verifier), `session.ts` (mint/verify),
`secrets.ts` (SSM + caches), `allowlist.ts`, `requireUser.ts`, `csrf.ts`, `headers.ts`,
`cookies.ts`, `identityProvider.ts`, `testSecret.ts`.

Module-load assertions (throw, so the Lambda fails closed at init):

1. `APP_ENV` ∈ `{'prod','test','local'}`, else throw `invalid APP_ENV`.
2. `PUBLIC_ORIGIN` is non-empty, has no trailing `/`, and matches `/^https:\/\/[a-z0-9.-]+$/`
   when `APP_ENV === 'prod'`, or `/^https?:\/\/[a-z0-9.-]+(:\d{2,5})?$/` otherwise.
3. `if (APP_ENV === 'prod' && process.env.DEV_SESSION_SECRET) throw`.

All comparisons in this document are `===` on constant strings, case-sensitive, no trimming,
no normalisation, unless the text says otherwise.

## 1. What the Lambda sees (spike, §"Viewer headers")

Function URL payload v2. `event.rawQueryString` arrives **byte-for-byte** as the viewer sent it —
use it, never `event.queryStringParameters` (that map collapses duplicates). `event.rawPath` is the
full path (`/api/auth/steam/callback`). `event.headers` keys are lowercase. Cookies arrive both as
`event.cookies` (array of `name=value`) and `event.headers.cookie`. `event.headers.host` is the
**origin** hostname, not `dst.ty.ler.dev` — hence `PUBLIC_ORIGIN`. Viewer IP is
`event.headers['x-forwarded-for']` (first comma-separated entry), never
`requestContext.http.sourceIp`. Responses set cookies through the payload-2.0 `cookies: string[]`
array; CloudFront passes `Set-Cookie` through untouched.

## 2. `GET /api/auth/steam/login`

1. `stateId = randomBytes(32).toString('base64url')` (43 chars).
2. `issuedAt = Math.floor(clock.nowMs() / 1000)`.
3. `mac` = base64url of `HMAC-SHA256(stateKey, stateId + "|" + issuedAt)` — `stateKey` from §4.
4. Cookie value = `stateId + "." + issuedAt + "." + mac` (three dot-separated parts).
5. `Set-Cookie` (exact, attribute order as written):
   - prod: `__Host-dst_oidc_state=<value>; Max-Age=600; Path=/; HttpOnly; Secure; SameSite=Lax`
   - `test`/`local`: `dst_oidc_state=<value>; Max-Age=600; Path=/; HttpOnly; SameSite=Lax`
   `SameSite=Lax` is required and sufficient: the callback is a cross-site top-level GET
   navigation. `Strict` breaks the flow.
6. `returnTo = PUBLIC_ORIGIN + CALLBACK_PATH + '?state=' + encodeURIComponent(stateId)`.
   Only `stateId` goes in the URL — never the MAC, never `issuedAt`.
7. Redirect target = `STEAM_OP_ENDPOINT + '?' + new URLSearchParams([...]).toString()` with
   exactly these six parameters, in this order:

   | Parameter | Value |
   |---|---|
   | `openid.ns` | `http://specs.openid.net/auth/2.0` |
   | `openid.mode` | `checkid_setup` |
   | `openid.identity` | `http://specs.openid.net/auth/2.0/identifier_select` |
   | `openid.claimed_id` | `http://specs.openid.net/auth/2.0/identifier_select` |
   | `openid.return_to` | `returnTo` (step 6) |
   | `openid.realm` | `PUBLIC_ORIGIN` (includes the port when non-default) |

8. Respond `302`, `Location: <target>`, the `Set-Cookie` from step 5, and the headers of §8.
9. No request input of any kind (query, header, cookie) influences `return_to` or `realm`.
   The login route accepts **no** `next`/`returnTo` parameter; success always lands on `/`.

## 3. `GET /api/auth/steam/callback` — the verifier

Pure function, so every case in §9 is a plain unit test:

```ts
type Deps = { nowMs(): number; fetchSteam: typeof fetch; stateKey: Buffer };
async function verifyCallback(rawQueryString: string, cookies: string[], deps: Deps): Promise<CallbackResult>
type CallbackResult =
  | { kind: 'ok'; steamId64: string }
  | { kind: 'cancelled' }
  | { kind: 'retryable'; check: string }   // Steam 403/429/3xx/timeout/network
  | { kind: 'rejected'; check: string };   // everything else
```

`check` is an internal label (e.g. `op_endpoint`, `claimed_id`, `state_mac`) used only for logs.
Order matters: cheap local checks first, the network call last. **On every outcome, including
success, the response clears the state cookie** (§3.3) — the cookie is single-use.

### 3.1 Ordered algorithm

- **C0** `event.requestContext.http.method === 'GET'`, else `405` (rejected, `method`).
- **C1** `rawQueryString.length <= MAX_QUERY_LEN`, else rejected (`query_too_long`).
- **C2 Parse it yourself.** `const all = new URLSearchParams(rawQueryString)`. Count occurrences
  per key: `const counts = new Map<string, number>(); for (const [k] of all) counts.set(k, (counts.get(k) ?? 0) + 1);`
  If any key with `k === 'state' || k.startsWith('openid.')` has a count `> 1` → rejected
  (`duplicate_param`). Then build `const params = new Map<string,string>()` from `all` entries.
  From here, read query values **only** through `params`.
- **C3** `params.get('openid.mode')`: `'id_res'` → continue; `'cancel'` → `{kind:'cancelled'}`;
  anything else (including `'id_res '` with a trailing space, or missing) → rejected (`mode`).
- **C4** `params.get('openid.ns') === OPENID_NS`, else rejected (`ns`).
- **C5** Each of `openid.op_endpoint`, `openid.claimed_id`, `openid.identity`,
  `openid.return_to`, `openid.response_nonce`, `openid.assoc_handle`, `openid.signed`,
  `openid.sig` is present and a non-empty string, else rejected (`missing_param`).
- **C6** `params.get('openid.op_endpoint') === STEAM_OP_ENDPOINT`, else rejected (`op_endpoint`).
  No trailing slash, no `http`, no lookalike host is accepted.
- **C7** `params.get('openid.signed') === EXPECTED_SIGNED`, else rejected (`signed`).
  **Additionally** assert every name in `REQUIRED_SIGNED` is in
  `params.get('openid.signed')!.split(',')`, so relaxing the equality later still leaves a check.
- **C8** `const signedNames = params.get('openid.signed')!.split(',')`; every name `n` has
  `params.has('openid.' + n)`, else rejected (`signed_missing_field`).
- **C9** Build `const signedValues = new Map(signedNames.map(n => [n, params.get('openid.' + n)!]))`.
  **From here on read only `signedValues`, plus `params.get('openid.sig')` and `params.get('state')`.**
- **C10** `signedValues.get('claimed_id') === signedValues.get('identity')`, else rejected (`claimed_vs_identity`).
- **C11** `const m = CLAIMED_ID_RE.exec(signedValues.get('claimed_id')!)`; `m` non-null, else
  rejected (`claimed_id`). `steamId64 = m[1]`. No `m` flag; the dot is escaped; fully anchored;
  no trailing slash allowed.
- **C12** `BigInt(steamId64) >= STEAMID64_MIN`, else rejected (`steamid_range`).
- **C13** `const u = new URL(signedValues.get('return_to')!)` inside `try` (parse failure →
  rejected, `return_to_parse`). Then all of, else rejected (`return_to`):
  `u.protocol === new URL(PUBLIC_ORIGIN).protocol`, `u.host === new URL(PUBLIC_ORIGIN).host`,
  `u.pathname === CALLBACK_PATH`, `u.username === ''`, `u.password === ''`, `u.hash === ''`.
  **Never `startsWith`.**
- **C14** Subset rule (OpenID 2.0 §11.1, one-directional): for each `[k, v]` of `u.searchParams`,
  `params.get(k) === v`, else rejected (`return_to_query`). Extra parameters in the actual
  request URL that are absent from `return_to` are **accepted**.
- **C15** `const stateId = u.searchParams.get('state')` is non-null and matches `BASE64URL_RE`
  with `length === 43`, else rejected (`state_missing`).
- **C16 State cookie.** Read `__Host-dst_oidc_state` (prod) / `dst_oidc_state` (test, local) via
  §6.1. Missing → rejected (`state_cookie`). Split on `.`; exactly 3 parts, else rejected.
  `issuedAt = Number(parts[1])`; must be a safe integer. Recompute `mac` = base64url of
  `HMAC-SHA256(stateKey, parts[0] + "|" + parts[1])`; compare to `parts[2]` with
  `crypto.timingSafeEqual` over the **raw MAC bytes** after a length check (unequal length →
  rejected, `state_mac`). Compare `parts[0]` to `stateId` with `timingSafeEqual` on UTF-8 bytes
  (unequal length → rejected, `state_mismatch`). Then
  `now - issuedAt <= STATE_MAX_AGE_S && issuedAt - now <= NONCE_MAX_SKEW_S`, else rejected
  (`state_expired`). The cookie is now spent; the response clears it regardless of outcome.
- **C17 Nonce freshness.** `const nm = NONCE_RE.exec(signedValues.get('response_nonce')!)`;
  non-null, else rejected (`nonce_format`). `t = Math.floor(Date.parse(nm[1]) / 1000)`;
  `Number.isFinite(t)`, else rejected. Require `now - t <= NONCE_MAX_AGE_S` **and**
  `t - now <= NONCE_MAX_SKEW_S` (both inclusive: exactly 300 s old passes, 301 s fails), else
  rejected (`nonce_window`).
- **C18 `check_authentication` POST.** §3.2. Network failure/timeout → `{kind:'retryable'}`.
- **C19** Allowlist (§7): `Object.hasOwn(users, steamId64)`, else the not-allowed outcome.
  Never mint a session first and check later.
- **C20** Mint the session (§5), set the cookie, `302` to `/`.

### 3.2 The `check_authentication` POST

```ts
const body = new URLSearchParams();
for (const n of signedNames) body.set('openid.' + n, signedValues.get(n)!); // includes openid.signed
body.set('openid.sig', params.get('openid.sig')!);
body.set('openid.ns', OPENID_NS);                 // ours, not theirs — ns is not signed
body.set('openid.mode', 'check_authentication');  // ours, replaces id_res
const res = await deps.fetchSteam(STEAM_OP_ENDPOINT, {      // the CONSTANT, never op_endpoint
  method: 'POST',
  headers: {
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'text/plain',
    referer: 'https://steamcommunity.com/',   // node-steam-signin PR#5: gets past Steam's WAF
    origin: 'https://steamcommunity.com',
  },
  body,
  redirect: 'manual',
  signal: AbortSignal.timeout(5000),
});
```

No credentials, no cookie jar, no redirect following. Then:

- `res.status !== 200` → `403`/`429`/any `3xx`/`5xx` → `{kind:'retryable', check:'steam_status'}`.
- `const text = await res.text()`; `text.length > MAX_KV_BODY_LEN` → rejected (`kv_too_long`).
- Key-Value Form parse: `text.replace(/\r\n/g, '\n').split('\n')`, drop empty lines, split each
  line on the **first** `:` only; a line with no `:` → rejected (`kv_parse`); later duplicate keys
  overwrite earlier ones.
- Require `kv.ns === OPENID_NS` **and** `kv.is_valid === 'true'` — exact values, never
  `includes()`/substring/regex over the body, else rejected (`is_valid`).

### 3.3 Responses

Every callback response carries the §8 headers, `Cache-Control: no-store`, and the state-cookie
clearing `Set-Cookie`:

- prod: `__Host-dst_oidc_state=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`
- test/local: `dst_oidc_state=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`

| Outcome | Status | `Location` | Session cookie |
|---|---|---|---|
| `ok` and allowlisted | 302 | `/` | set (§5.3) |
| `ok` but not allowlisted | 302 | `/?error=not-allowed` | none |
| `cancelled` | 302 | `/?login=cancelled` | none |
| `retryable` | 302 | `/?error=steam-unavailable` | none |
| `rejected` (any check) | 302 | `/?error=login-failed` | none |

The body is empty. **No detail leaks**: the `check` label, the SteamID64 and the assertion never
appear in the response. `Location` is always one of these five literal strings — never
user-supplied, so there is no open redirect.

### 3.4 Logging

One JSON line per callback via `console.log`:
`{"evt":"auth.callback","outcome":"ok|cancelled|retryable|rejected|not-allowed","check":"<label|null>","steamId64":"<id|null>","ip":"<first x-forwarded-for>"}`.
**Never log** `rawQueryString`, the full callback URL, `openid.sig`, any `openid.*` value, the
`Cookie` header, a session or state cookie value, or the session secret. The callback URL contains
a replayable assertion.

## 4. Secrets (`secrets.ts`)

`getSessionSecret(): Promise<string>` — module-scope cache `{ value, fetchedAtMs }`, TTL
`SECRET_TTL_MS` (5 min), plus an in-flight promise so concurrent calls make one SSM request.

- `APP_ENV === 'prod'`: `ssm:GetParameter { Name: '/dst/session-secret', WithDecryption: true }`
  in `us-east-1`. **No environment-variable fallback.** Empty or missing →
  `throw new Error('missing session secret')`. The API role's `ssm:GetParameter` is scoped to three
  exact parameter ARNs and no wildcard — `/dst/session-secret` and `/dst/users` (us-east-1) and
  `/dst/cluster-password` (us-west-2, read by `GET /api/worlds`, not by this module), each with a
  `kms:Decrypt` statement conditioned on `kms:ViaService=ssm.<region>.amazonaws.com`
  (decisions §16.17; exact statements in `docs/control-plane.md` §7).
- `APP_ENV === 'test' | 'local'`: `process.env.DEV_SESSION_SECRET ?? TEST_SESSION_SECRET`, the
  committed constant in `packages/api/src/auth/testSecret.ts`
  (`export const TEST_SESSION_SECRET = 'dst-local-test-secret-not-for-production';`). Harmless in
  a public repo — see §9.4.

Key derivation (both keys from the one secret, domain-separated):

```ts
const ikm  = Buffer.from(secret, 'utf8');
const salt = Buffer.from('dst-v1', 'utf8');
const sessionKey = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(`${APP_ENV}:session`, 'utf8'), 32));
const stateKey   = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(`${APP_ENV}:state`,   'utf8'), 32));
```

Derived keys are cached alongside the secret and re-derived whenever it is re-read.

## 5. Session tokens (`session.ts`)

### 5.1 Format

```
v1.<env>.<payloadB64>.<macB64>
payloadB64 = base64url(JSON.stringify({ sub, iat, exp }))     // keys in exactly this order
macB64     = base64url(HMAC-SHA256(sessionKey, `v1.${env}.${payloadB64}`))   // 43 chars
```

`sub` is the SteamID64 string, `iat`/`exp` are integer Unix seconds, `exp = iat + 2592000`.
There is no `alg` field and no JWT library — the `alg`-confusion class of bug cannot exist.
base64url = RFC 4648 §5 alphabet `[A-Za-z0-9_-]`, **no `=` padding** (`Buffer.toString('base64url')`).

### 5.2 `verifySessionToken(token, sessionKey, nowSec)` — ordered, fail on the first miss

1. `typeof token === 'string' && token.length > 0 && token.length <= MAX_TOKEN_LEN`.
2. `const p = token.split('.')`; `p.length === 4`.
3. `p[0] === 'v1'`.
4. **`p[1] === APP_ENV`** — the env discriminator, checked **before any crypto**.
5. `BASE64URL_RE.test(p[2]) && BASE64URL_RE.test(p[3]) && p[3].length === 43`.
6. Canonical-encoding check: `Buffer.from(p[2], 'base64url').toString('base64url') === p[2]`, same
   for `p[3]`.
7. `expected` = `crypto.createHmac('sha256', sessionKey).update('v1.' + p[1] + '.' + p[2]).digest()`;
   `got` = `Buffer.from(p[3], 'base64url')`; require `got.length === 32` and
   `crypto.timingSafeEqual(got, expected)`. Never `===` on the MAC strings.
8. `JSON.parse(Buffer.from(p[2], 'base64url').toString('utf8'))` inside `try`; must be a non-null
   non-array object.
9. `STEAMID64_RE.test(payload.sub)`.
10. `Number.isSafeInteger(payload.iat) && Number.isSafeInteger(payload.exp)`.
11. `payload.exp > nowSec` (expiry), `payload.iat <= nowSec + 60`,
    `payload.exp - payload.iat <= SESSION_MAX_AGE_S`.

Returns `{ steamId64: payload.sub }` or `null`. No sliding refresh: a token is valid for 30 days
from issue and then the user signs in again.

### 5.3 Cookie strings (exact, attribute order as written)

| | Set on login | Clear on logout |
|---|---|---|
| prod | `__Host-dst_session=<token>; Max-Age=2592000; Path=/; HttpOnly; Secure; SameSite=Lax` | `__Host-dst_session=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax` |
| test, local | `dst_session=<token>; Max-Age=2592000; Path=/; HttpOnly; SameSite=Lax` | `dst_session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax` |

`__Host-` requires `Secure`, `Path=/` and no `Domain`, which is what stops a sibling subdomain of
`ty.ler.dev` from forcing the cookie. `SameSite=Lax` (not `Strict`) so a Discord link lands
logged-in and the Steam callback navigation carries the cookie.

### 5.4 `POST /api/auth/logout`

CSRF precondition (§8) → clear cookie (table above) → `204`, no body. Valid without a session
cookie (idempotent). No server state to delete.

## 6. `requireUser(event)`

```ts
type User = { steamId64: string; nickname: string };
async function requireUser(event): Promise<{ ok: true; user: User } | { ok: false; status: 401 | 403; code: 'unauthorized' | 'not_allowed' }>
```

### 6.1 Cookie parsing

1. Candidate strings: `event.cookies` if it is an array, else
   `(event.headers?.cookie ?? '').split(';')`.
2. For each, `trim()`, find the first `=`; no `=` → skip; `name = s.slice(0, i)`,
   `value = s.slice(i + 1)`.
3. Collect **all** values whose `name` equals the env's session cookie name (`__Host-dst_session`
   in prod, `dst_session` otherwise). If the count is `!== 1` → treat as absent (fail closed; a
   duplicated cookie name is an attack signal, not an accident).

### 6.2 Flow

1. No cookie, or `verifySessionToken` returns `null` → `{ ok: false, status: 401, code: 'unauthorized' }`.
2. `const users = await getUsers()` (§7). `Object.hasOwn(users, steamId64) === false` →
   `{ ok: false, status: 403, code: 'not_allowed' }`. This is the revocation path: removing a
   friend from `/dst/users` takes effect within 60 s.
3. Otherwise `{ ok: true, user: { steamId64, nickname: users[steamId64] } }`.

Error responses use the one API error envelope defined in `docs/control-plane.md` §5.3:
`Content-Type: application/json; charset=utf-8`, body
`{"error":{"code":"unauthorized","message":"…"}}`, plus the §8 headers. Never distinguish "bad
signature" from "expired" from "no cookie" in the response body. `GET /api/me` returns
`{ nickname }` only (decisions.md §10); the state item stores both `startedBy` (SteamID64) and
`startedByNickname`, and only the nickname is ever serialised.

### 6.3 `IdentityProvider`

```ts
export type Identity = { steamId64: string };
export interface IdentityProvider {
  readonly id: string;                                   // 'steam'
  beginLogin(): { location: string; setCookies: string[] };
  completeLogin(rawQueryString: string, cookies: string[]): Promise<CallbackResult>;
}
```

Everything downstream of `completeLogin` (session minting, allowlist, `requireUser`) is
provider-agnostic and works on `Identity`. Adding Google would be one new implementation plus one
route pair; **none is built** (decisions.md §15).

## 7. Allowlist (`allowlist.ts`)

`getUsers(): Promise<Record<string, string>>` reads SSM String `/dst/users` (us-east-1),
module-scope cache with `ALLOWLIST_TTL_MS` = 60 s and an in-flight promise.

Validation, **fails closed** — on any failure return `{}` (so every user gets 403), log
`{"evt":"auth.allowlist","error":"<reason>"}` once per fetch, and **do not** store the bad value
and **do not** serve a stale good value:

1. SSM error / parameter missing → `{}` (reason `ssm`).
2. `JSON.parse` throws → `{}` (reason `json`).
3. Not a non-null, non-array object → `{}` (reason `shape`).
4. Any key not matching `STEAMID64_RE`, or any value not a non-empty string of length ≤ 32 → `{}`
   (reason `entry`).

Never log the map contents; log `Object.keys(users).length` at most.

## 8. CSRF and security headers

### 8.1 CSRF precondition — every non-GET route

Checked **before** `requireUser`, on `POST /api/auth/logout`, `POST /api/worlds/{id}/start`,
`POST /api/worlds/{id}/stop`:

1. `event.headers.origin === PUBLIC_ORIGIN` (exact string; absent → fail; never fall back to `Referer`).
2. `event.headers['x-dst-request'] === '1'`.

Failure → `403`, body `{"error":{"code":"csrf_failed","message":"…"}}` (the shared envelope,
`docs/control-plane.md` §5.3). These POSTs are **bodyless** (the target is in the
path), which is why no `x-amz-content-sha256` is needed (spike test d). `SameSite=Lax` already
blocks the cookie on cross-site POSTs; a cross-origin `fetch` cannot set `X-DST-Request` without a
CORS preflight, and this API emits **no CORS headers at all** — SPA and API are same-origin, so a
same-origin fetch setting a custom header needs no preflight. Do not add a double-submit token.

> decisions.md §10 says "no fetch wrapper is needed" — that is about `x-amz-content-sha256` only.
> The SPA still must send `X-DST-Request: 1` (and `credentials: 'same-origin'`) on every POST.
> decisions.md §16.12 settles this explicitly.

Also §16.12: the auth redirects are the **closed set** `/`, `/?login=cancelled`,
`/?error=not-allowed`, `/?error=steam-unavailable`, `/?error=login-failed` — the five literals of
§3.3 and nothing else, ever.

### 8.2 Headers on every API response

```
Cache-Control: no-store
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

`Referrer-Policy: no-referrer` on the callback matters specifically: the landing page would
otherwise leak the assertion URL in `Referer`. CloudFront must not cache `/api/*`
(`CachingDisabled`) — a cached callback or `/api/me` would mix accounts.

### 8.3 SPA headers (for the infra doc to implement)

A CloudFront **response headers policy** on the default (S3) behaviour only — `/api/*` sets its own
headers (§8.2). Values verbatim; the CSP string lives in `@dst/shared` as `SPA_CSP` so `DstWeb`
imports it instead of duplicating it (`docs/infra.md` §4.3):

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'none'; base-uri 'self'; object-src 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Strict-Transport-Security: max-age=31536000; includeSubDomains   (override: true)
X-Frame-Options: DENY
```

`style-src 'unsafe-inline'` is required by Mantine's runtime style injection. `script-src 'self'`
holds **only if the SPA ships no inline script**: do **not** render Mantine's `<ColorSchemeScript>`.
Per decisions §16.21 the SPA uses `<MantineProvider defaultColorScheme="dark">`, no color-scheme
toggle, and plain `Modal` (no `@mantine/modals`). `connect-src 'self'` suffices because the API is
same-origin. `includeSubDomains` is correct and harmless: HSTS with it applies to subdomains of
`dst.ty.ler.dev`, not to siblings under `ty.ler.dev`.

## 9. Test design

### 9.1 Faking Steam

`verifyCallback` takes `fetchSteam` as a port (`Deps`), so no HTTP happens in unit tests. Build
`validQuery(overrides?)` returning a correct Steam-shaped parameter set for the fake SteamID
`76561190000000001`, and mutate one field per case. Assert both the outcome **and**, where stated,
that `fetchSteam` was **never called**. Clock is injected (`nowMs`), never `Date.now()`.

### 9.2 Numbered unit tests (`packages/api/src/auth/*.test.ts`)

**Happy path**
1. Valid assertion, fake returns `200 "ns:http://specs.openid.net/auth/2.0\nis_valid:true\n"` → `{kind:'ok', steamId64:'76561190000000001'}`.
2. `claimed_id` over `http://` instead of `https://` → still ok.
3. Captured request: URL is exactly `https://steamcommunity.com/openid/login`, method POST, body contains `openid.mode=check_authentication`, `openid.ns` = the 2.0 NS, and every signed field verbatim.
4. Captured request has `redirect: 'manual'`, a 5 s `AbortSignal`, and the `referer`/`origin` `steamcommunity.com` headers.

**Forged provider (§2.1)**
5. `op_endpoint = 'https://evil.example/openid/login'` → rejected, `fetchSteam` never called.
6. `op_endpoint = 'https://steamcommunity.com/openid/login/'` (trailing slash) → rejected.
7. `op_endpoint = 'https://steamcommunity.com.evil.example/openid/login'` → rejected.
8. `op_endpoint = 'http://steamcommunity.com/openid/login'` → rejected.
9. `fetchSteam` stubbed to answer `is_valid:true` for any input, claimed_id = a non-allowlisted ID → rejected at the allowlist step, no session cookie.

**Loose `claimed_id` (§2.2)**
10. `.../id/76561190000000001.evil.com/` → rejected.
11. `.../id/76561190000000001/` (trailing slash) → rejected.
12. `https://evil.com/?u=https://steamcommunity.com/openid/id/76561190000000001` → rejected.
13. `https://steamcommunityXcom/openid/id/76561190000000001` → rejected (escaped dot).
14. `.../id/76561190000000001\n` → rejected (anchored, no `m` flag).
15. `.../id/123` → rejected.
16. `.../id/00000000000000000` → rejected (below the individual base / regex).
17. `claimed_id !== identity` → rejected.

**Signed-field tampering (§2.3)**
18. `signed` omits `claimed_id` → rejected, `fetchSteam` never called.
19. `signed` omits `return_to` → rejected.
20. `signed` omits `response_nonce` → rejected.
21. `signed` names a field absent from the query → rejected.
22. `signed` has an extra field appended → rejected by the strict equality.
23. An extra non-signed `openid.foo=bar` with `signed` untouched → still ok, and `openid.foo` is **absent** from the captured `check_authentication` body.

**`return_to` (§2.4)**
24. host = `dst.ty.ler.dev.evil.com` → rejected (proves no prefix matching).
25. path = `/api/auth/steam/callback/../../x` → rejected (compare `u.pathname` after parsing).
26. scheme = `http` → rejected (in prod config).
27. `return_to` has `state=A` while the request query has `state=B` → rejected.
28. `return_to` has an extra query param absent from the request URL → rejected.
29. Request URL has extra params not in `return_to` → **accepted** (§11.1 is one-directional).
30. `return_to` with userinfo (`https://u:p@dst.ty.ler.dev/...`) → rejected.

**State / login CSRF (§2.10)**
31. No state cookie → rejected.
32. State cookie present, `state` query param missing → rejected.
33. Cookie id ≠ `state` query param → rejected.
34. Cookie with a corrupted MAC → rejected.
35. Cookie with a MAC of the wrong length → rejected, no `timingSafeEqual` throw.
36. Cookie `issuedAt` older than 600 s → rejected; at exactly 600 s → accepted.
37. Replay the same full callback twice with an empty cookie header on the second call → second rejected.
38. Every outcome (ok, cancelled, retryable, rejected, not-allowed) emits the state-clearing `Set-Cookie`.
39. A state cookie minted with a different `stateKey` (different env) → rejected.

**Nonce (§2.5)**
40. `response_nonce` 10 minutes old → rejected, `fetchSteam` never called.
41. `response_nonce` 10 minutes in the future → rejected.
42. `response_nonce` malformed (`not-a-date-suffix`) → rejected.
43. Exactly 300 s old → accepted; 301 s old → rejected.
44. 60 s in the future → accepted; 61 s → rejected.

**Steam response parsing (§2.6)**
45. `200 "ns:...\nis_valid:false\n"` → rejected.
46. `200 "error:is_valid:true\n"` → rejected (no substring matching).
47. `200 "is_valid:true"` with no `ns` line → rejected.
48. `200` with CRLF line endings → accepted.
49. `403` → `{kind:'retryable'}`, distinct from `rejected`.
50. `429` → `{kind:'retryable'}`.
51. `302` → rejected or retryable, never ok.
52. Timeout (`AbortError`) → `{kind:'retryable'}`.
53. Body longer than 4096 bytes → rejected.

**mode / ns / pollution (§2.7–2.9)**
54. `mode = 'cancel'` → `{kind:'cancelled'}`, no session cookie.
55. `mode = 'id_res '` (trailing space) → rejected.
56. `mode` missing → rejected.
57. `ns = 'http://openid.net/signon/1.1'` → rejected.
58. Duplicate `openid.claimed_id` (good then evil) → rejected.
59. Duplicate `openid.claimed_id` (evil then good) → rejected.
60. Duplicate `openid.signed` → rejected.
61. Duplicate `state` → rejected.
62. `rawQueryString` longer than 4096 chars → rejected.
63. Non-GET method on the callback → 405.

**Login route**
64. The redirect `Location` has exactly the six `openid.*` parameters of §2 with exactly those values.
65. `return_to` = `PUBLIC_ORIGIN + '/api/auth/steam/callback?state=' + stateId`; `realm` = `PUBLIC_ORIGIN`; neither changes when the request carries a hostile `Host`, `Origin` or `X-Forwarded-Host` header.
66. The state `Set-Cookie` matches `/^__Host-dst_oidc_state=[^;]+; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax$/` under `APP_ENV=prod`, and the `dst_oidc_state=...; Max-Age=600; Path=/; HttpOnly; SameSite=Lax` form under `APP_ENV=test`.
67. Two successive logins produce different `stateId`s.

**Session / allowlist**
68. Valid login by a SteamID **not** in the allowlist → no session `Set-Cookie`, `Location: /?error=not-allowed`.
69. Valid login by an allowlisted SteamID → `Set-Cookie` matches `/^__Host-dst_session=[^;]+; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Lax$/`.
70. Round-trip: mint then verify → the same `steamId64`; `exp - iat === 2592000`.
71. Token minted under `APP_ENV=test` is rejected by a verifier running `APP_ENV=prod`, **even when both are given the identical raw secret string**.
72. Token minted under `APP_ENV=prod` is rejected by a verifier running `APP_ENV=test`.
73. One flipped bit in the MAC → rejected.
74. One flipped bit in the payload → rejected.
75. Truncated MAC (42 chars) and over-long MAC (44 chars) → rejected, no throw.
76. `exp` in the past → rejected.
77. `iat` more than 60 s in the future → rejected.
78. Payload that is not JSON, is `null`, or is an array → rejected, no throw.
79. Payload `sub` = `'7656119000000000x'` or a number → rejected.
80. Token with 3 or 5 dot-separated parts → rejected.
81. Token with `v2` prefix → rejected.
82. Token with padded or non-canonical base64 (`=`, `+`, `/`) → rejected.
83. Token longer than 1024 chars → rejected without computing an HMAC.
84. Valid token for a SteamID since removed from `/dst/users` → `requireUser` returns 403 on the next call (after the 60 s cache expires, driven by the injected clock).
85. Malformed `/dst/users` JSON → `requireUser` returns 403 for a previously-valid user, and a previously-good cached map is **not** reused.
86. `/dst/users` with a key that is not a SteamID64, or a non-string value → whole map rejected → 403.
87. SSM `GetParameter` throws → 403, not 500, and not a crash.
88. `requireUser` with no cookie → 401; with a tampered cookie → 401; with a valid cookie for a non-allowlisted user → 403.
89. Cookie read from `event.cookies` and from `event.headers.cookie` give the same result.
90. Two `dst_session` cookies in one request → treated as absent → 401.
91. Production secret loader with the SSM parameter missing → throws `missing session secret`; there is **no** env-var fallback.
92. Module load with `APP_ENV=prod` and `DEV_SESSION_SECRET` set → throws.

**CSRF / headers**
93. `POST /api/worlds/test-lifecycle-a/start` with no `Origin` → 403.
94. Same with `Origin: https://evil.example` → 403.
95. Same with the right `Origin` but no `X-DST-Request` → 403.
96. Same with `X-DST-Request: true` (not `1`) → 403.
97. Correct `Origin` + `X-DST-Request: 1` but no session cookie → 401 (CSRF passes, auth fails).
98. No response from any route contains `Access-Control-Allow-Origin` or any other `access-control-*` header.
99. Every API response carries the five headers of §8.2.
100. `POST /api/auth/logout` returns the exact clearing `Set-Cookie` for the env and 204.

### 9.3 Playwright

`e2e/support/session.ts` mints a token with `env = 'test'` and `TEST_SESSION_SECRET` (same
`mintSessionToken` the API uses, imported from `packages/api`), then:

```ts
await context.addCookies([{
  name: 'dst_session', value: token, domain: 'localhost', path: '/',
  httpOnly: true, secure: false, sameSite: 'Lax',
  expires: Math.floor(Date.now() / 1000) + 2592000,
}]);
```

The local API (`packages/api/src/local.ts`, port 8787) runs with `APP_ENV=test`,
`PUBLIC_ORIGIN=http://localhost:5173`, and an in-memory allowlist fake containing the fake test
SteamIDs. Steam is never contacted. The real Steam flow is one manual, non-CI smoke test. The
same entrypoint under `APP_ENV=local` additionally serves `GET /api/dev/login`, which mints a
cookie for the fake user `dev-user` — it is local-only code carrying the `DST_LOCAL_ONLY` marker
(decisions §16.4, `docs/control-plane.md` §5.5), never reachable from a Lambda bundle.

`scripts/lifecycle-test.ts` (decisions.md §13) mints an `env=prod` token by reading
`/dst/session-secret` with `AWS_PROFILE=admin` and drives the real CloudFront URL. It never prints
the secret or the token.

### 9.4 Why a test-minted cookie can never be valid in production — three independent reasons

1. **Env discriminator, checked before any crypto.** §5.2 step 4 rejects `p[1] !== APP_ENV`. The
   prod Lambda gets `APP_ENV=prod` from CDK; `APP_ENV` is never read from a header, query
   parameter or cookie.
2. **Env inside the key derivation.** HKDF `info` is `` `${APP_ENV}:session` ``, so the derived key
   differs even if the identical raw secret were configured in both places. Test 71 pins this.
3. **Different key material with no path between them.** Prod loads the secret only from SSM
   `/dst/session-secret` (decrypted, IAM-scoped to that one ARN) with no env-var fallback and
   throws when it is missing; `TEST_SESSION_SECRET` is a committed constant that prod code can
   never reach, and module load throws if `DEV_SESSION_SECRET` is set with `APP_ENV=prod`.

## 10. Runbook

All commands: `AWS_PROFILE=admin`, `--region us-east-1`.

**Find a SteamID64.** Ask the friend for their profile URL. `https://steamcommunity.com/profiles/<17 digits>`
is the ID directly. A vanity URL (`.../id/<name>`) is not — have them open Steam → Profile →
Edit Profile, where the numeric ID is in the page URL, or have them attempt a sign-in: the failed
attempt logs `{"evt":"auth.callback","outcome":"not-allowed","steamId64":"..."}` to
`/aws/lambda/dst-server-manager-api`, which is the easiest path. No Steam Web API key is used.

**Add or remove a friend** — one command; send the whole map, it is a full overwrite:

```
AWS_PROFILE=admin aws ssm get-parameter --region us-east-1 --name /dst/users \
  --query Parameter.Value --output text                       # read the current map first
AWS_PROFILE=admin aws ssm put-parameter --region us-east-1 --name /dst/users \
  --type String --overwrite \
  --value '{"76561190000000001":"Tyler","76561190000000002":"Sam"}'
```

Takes effect within 60 s, no deploy. `--tags` cannot be combined with `--overwrite`; the
`project=dst-server-manager` tag is set once at creation (PLAN.md Phase 0). Nicknames are what the
UI shows as "started by". Never commit this JSON; `docs/allowlist.example.json` holds the shape
with fake IDs.

**Rotate the session secret** — one command; everyone signs in again (there is no key-id list):

```
AWS_PROFILE=admin aws ssm put-parameter --region us-east-1 --name /dst/session-secret \
  --type SecureString --overwrite --value "$(openssl rand -base64 48)"
```

Do not echo the value. Propagation ≤ 5 min (the secret cache TTL); afterwards every existing
session cookie and every in-flight state cookie fails verification and users see the sign-in
screen. Rotate on any suspicion of exposure; no schedule otherwise.

**Not allowlisted, what the user sees.** The Steam sign-in succeeds, the browser lands on
`/?error=not-allowed`, and the SPA shows a neutral line: "This Steam account isn't on the list."
No session cookie is set, no SteamID64 is echoed to the page, and nothing distinguishes it from
any other failed sign-in to a bystander.
