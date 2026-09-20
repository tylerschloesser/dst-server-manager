# Sign in with Steam (OpenID 2.0) — security research & implementation plan

Research date: 2026-09-19. Target: `https://dst.ty.ler.dev`, Vite+React SPA on S3/CloudFront,
API on Lambda (Node 22, us-east-1), CDK, **public** GitHub repo, ~6 allowlisted friends.

Every claim below is tagged **[V]** = source-verified (primary source linked) or **[I]** = inference /
engineering judgement by the author of this document.

---

## 0. Executive summary

| Question | Verdict |
|---|---|
| Steam vs Google | **Steam.** Not meaningfully worse. Zero app registration, no secrets to rotate, allowlist is a public ID rather than an email. Google stays documented as a drop-in fallback. |
| Library vs hand-rolled | **Hand-rolled ~130 lines**, written against the checklist in §3, cross-checked line-by-line against `xPaw/SteamOpenID.php` and `DoctorMcKay/node-steam-signin`. Zero dependencies. |
| Nonce / login-CSRF | Signed, single-use, 10-minute **`state` cookie bound into `return_to`** + `response_nonce` timestamp window. No DynamoDB needed. |
| Session | **Stateless HMAC-SHA256 cookie**, `__Host-dst_session`, 30 days, secret in SSM SecureString, allowlist re-checked every request. |
| API behind CloudFront | **Lambda Function URL + OAC (AWS_IAM)**; SPA sets `x-amz-content-sha256` on mutating requests (caveat still live in 2026). Pragmatic fallback: `AuthType: NONE` + CloudFront secret origin header. |
| Steam Web API key | **Not worth it.** Use an SSM JSON map `steamid64 -> nickname`. |
| Allowlist location | **SSM**, not the public repo. |

---

## 1. The Steam OpenID 2.0 flow, precisely

Steam is an OpenID 2.0 **OP Identifier** provider. It publishes only the "login" endpoint; there is no
OAuth, no OIDC, no `id_token`, no client secret, and no app registration. **[V]**
Steam's own developer page points at the endpoint and the OpenID 2.0 spec
(<https://steamcommunity.com/dev>).

### 1.1 Step 1 — redirect the browser to Steam

`GET https://steamcommunity.com/openid/login` with these query parameters:

| Parameter | Value |
|---|---|
| `openid.ns` | `http://specs.openid.net/auth/2.0` |
| `openid.mode` | `checkid_setup` |
| `openid.identity` | `http://specs.openid.net/auth/2.0/identifier_select` |
| `openid.claimed_id` | `http://specs.openid.net/auth/2.0/identifier_select` |
| `openid.return_to` | `https://dst.ty.ler.dev/api/auth/steam/callback?state=<state>` |
| `openid.realm` | `https://dst.ty.ler.dev` |

**[V]** Both reference implementations send exactly this set:
`xPaw/SteamOpenID.php::GetAuthParameters()` (omits `realm`, which is optional) and
`DoctorMcKay/node-steam-signin::getUrl()` (includes `realm`).
`identifier_select` is OpenID 2.0 §14.2.1 / §9: the RP does not know the user's identifier yet, so the
OP picks it. **[V]** <https://openid.net/specs/openid-authentication-2_0.html>

**Gotcha — realm must include a non-default port.** Steam changed this; `node-steam-signin` had to
relax `canonicalizeRealm` from `/^(https?:\/\/[^:/]+)/` to `/^(https?:\/\/[^/]+)/` because
"they require port now". **[V]** <https://github.com/DoctorMcKay/node-steam-signin/pull/8>. For
`https://dst.ty.ler.dev` (port 443 implicit) this is a non-issue; it *will* bite anyone testing against
`http://localhost:3001`, where realm must be `http://localhost:3001`. **[V]**
<https://github.com/DoctorMcKay/node-steam-signin/pull/9>

The realm must also be a prefix of `return_to` (spec §9.2 / §16.1) or Steam returns
"realm and return_to do not match". **[V]** OpenID 2.0 §9.2.

### 1.2 Step 2 — what Steam sends back

Steam 302s the browser to `return_to` with these appended query parameters (`openid.mode=id_res` on
success; `cancel` if the user declines):

```
openid.ns            = http://specs.openid.net/auth/2.0
openid.mode          = id_res
openid.op_endpoint   = https://steamcommunity.com/openid/login
openid.claimed_id    = https://steamcommunity.com/openid/id/76561198000000000
openid.identity      = https://steamcommunity.com/openid/id/76561198000000000
openid.return_to     = <exactly the URL we sent>
openid.response_nonce= 2026-09-19T20:11:35Zabcd1234
openid.assoc_handle  = 1234567890
openid.signed        = signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle
openid.sig           = <base64>
```

**[V]** The exact `openid.signed` string Steam emits is asserted as a constant in
`xPaw/SteamOpenID.php`:
`const EXPECTED_SIGNED = 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle';`
(<https://github.com/xPaw/SteamOpenID.php>).

**Important consequence:** `openid.ns` and `openid.mode` are **not** in Steam's signed list. They are
attacker-controllable in the callback URL. Never trust them; set them yourself when building the
verification POST. **[V]** (derived from the signed-list constant above; `node-steam-signin` does
exactly this — "Set these params here to avoid any potential for malicious user input overwriting them").

Note `claimed_id` is served over **https** today even though a lot of old blog posts and old library
regexes say `http://steamcommunity.com/openid/id/...`. Accept both schemes or you will break.
**[V]** <https://github.com/liamcurry/passport-steam/issues/80>

### 1.3 Step 3 — stateless `check_authentication`

Steam **does not support associations.** Attempting `openid.mode=associate` returns
`error: Associations not supported` / `unsupported-type`, or fails with
"Required parameter missing: assoc_type"; libraries then fall back to stateless mode and work.
**[V]** <https://github.com/jbufu/openid4java/issues/192>,
<https://github.com/jaredhanson/passport-openid/issues/1>.
**Confirmed: stateless (direct) verification is the only option.** Both reference implementations are
stateless-only.

Verification request (OpenID 2.0 §11.4.2):

```
POST https://steamcommunity.com/openid/login          <-- HARDCODED. Never taken from the response.
Content-Type: application/x-www-form-urlencoded

  exact copies of every field listed in openid.signed (plus openid.sig, openid.signed, openid.assoc_handle)
  openid.ns   = http://specs.openid.net/auth/2.0      <-- set by us
  openid.mode = check_authentication                  <-- set by us, replaces id_res
```

**[V]** §11.4.2: "Exact copies of all fields from the authentication response, except for
`openid.mode`." <https://openid.net/specs/openid-authentication-2_0.html>

Response is Key-Value Form (§4.1.1): lines of `key:value` separated by `\n`. Success looks like:

```
ns:http://specs.openid.net/auth/2.0
is_valid:true
```

Steam rate-limits this endpoint and returns 403/429 when annoyed — handle it as a retryable error, not
as an auth failure. **[V]** `xPaw/SteamOpenID.php` has a dedicated branch:
"For some bizzare reason Valve rate limits the OpenID endpoint".

`node-steam-signin` also sends `Referer: https://steamcommunity.com/` and
`Origin: https://steamcommunity.com` on this POST; this was added as a fix in PR #5, presumably to get
past a Steam WAF rule. **[V]** <https://github.com/DoctorMcKay/node-steam-signin> (`index.js`, merged
PR #5). Copy that. **[I]** It is harmless and may prevent intermittent 403s
(cf. issue #7, intermittent "Access Denied").

---

## 2. Known auth-bypass bugs, and the fix for each

### 2.1 The big one: attacker-supplied `op_endpoint` → forged identity

**Bug.** The RP reads `openid.op_endpoint` out of the callback query string and POSTs
`check_authentication` *to that URL*. An attacker runs their own "OpenID provider", crafts a callback
URL pointing at it with `openid.claimed_id = .../openid/id/<victim's steamid>`, and their server answers
`is_valid:true`. The RP logs them in as anyone.

**Exploit.** Public, working exploit server:
<https://github.com/scholtzm/steam-fake-openid-provider> — "Fake Steam OpenID validation endpoint that
can bypass certain libraries and allows the attacker to supply arbitrary identity". Confirmed present in
**`passport-steam`** (fixed), **`steam-login`** (fixed), **`omniauth-steam`**
(<https://github.com/reu/omniauth-steam/issues/24>), and **SocialiteProviders/Steam v1**
(GitLab advisory GMS-2021-57, "Authentication bypass via attacker provided openid server",
<https://advisories.gitlab.com/pkg/composer/socialiteproviders/steam/GMS-2021-57>). **[V]**

The exploit author's note is worth internalising: *"OpenID (by design) allows this and this is not an
exploit related to OpenID itself."* Generic OpenID 2.0 libraries perform discovery on whatever
identifier comes back — which is correct OpenID, and catastrophic for a single-provider app. **[V]**

**Fix.** Two independent checks, both mandatory:
1. The `check_authentication` POST URL is a **compile-time constant**
   `https://steamcommunity.com/openid/login`. Never derived from the response.
2. `openid.op_endpoint` must **string-equal** `https://steamcommunity.com/openid/login`, and
   `op_endpoint` must appear in `openid.signed`.

> This is also the main argument against dropping in a *general-purpose* OpenID 2.0 library (`openid`
> npm, `openid4java`, LightOpenID): they are built to do discovery, which is exactly the dangerous
> behaviour. `node-steam-openid` mitigates this by string-checking `op_endpoint` *before* calling
> `openid.RelyingParty.verifyAssertion()`. **[V]** (source read, §3.4 below).

### 2.2 Loose `claimed_id` matching

**Bug.** Checking the claimed identifier with `startsWith`, `indexOf`, `strpos`, or an unanchored
regex, then extracting the SteamID with a naive `replace()`.

**Exploits.**
- `https://steamcommunity.com/openid/id/76561198000000000.evil.com/` passes a `startsWith` check.
- `https://evil.com/?x=https://steamcommunity.com/openid/id/765...` passes an unanchored
  `indexOf`/`/steamcommunity\.com\/openid\/id\/(\d+)/` regex.
- `https://steamcommunity.com.evil.com/openid/id/765...` passes a regex with an unescaped `.`.
- `node-steam-openid`'s `fetchIdentifier()` derives the SteamID with
  `steamOpenId.replace("https://steamcommunity.com/openid/id/", "")` — if the anchored regex before it
  were ever removed or the scheme were `http`, this yields a garbage "SteamID" that is then passed
  straight to the Steam Web API. The fake-provider author explicitly called out that
  "`GetPlayerSummaries` accepts SteamIDs in arbitrary format", which is what turns a sloppy extraction
  into a full bypass. **[V]** <https://github.com/scholtzm/steam-fake-openid-provider>
- PHP-specific: `preg_match('/...$/')` without the `D` modifier lets `$` match before a trailing
  newline, so `...id/76561198000000000\n<junk>` passes. xPaw uses `/D` for exactly this reason. **[V]**
  In JavaScript, `$` without the `m` flag anchors at true end-of-string, so JS is not affected — but
  **never** use the `m` flag here. **[I]**

**Fix.** One fully-anchored regex, `.` escaped, no `m` flag, SteamID64 range enforced:

```ts
const CLAIMED_ID_RE = /^https?:\/\/steamcommunity\.com\/openid\/id\/(7656119[0-9]{10})$/;
```

Then additionally `BigInt(id) >= 76561197960265729n` (the individual-account base) and the extracted
digits are the *only* thing carried forward. **[V]** range from the SteamID64 format;
`xPaw` uses `76561[0-9]{12}`, `node-steam-signin` uses `(\d+)` then hands it to the `steamid` package.
Prefer the stricter `7656119[0-9]{10}`. **[I]**

Also require `openid.claimed_id === openid.identity` (Steam always sends them equal). **[V]** xPaw.

### 2.3 Missing / unchecked `openid.signed`

**Bug.** The OP (or a MITM shaping the URL) signs only harmless fields; the RP verifies the signature,
gets `is_valid:true`, and then reads an **unsigned** `claimed_id` that the attacker put in the URL.

**Exploit.** Strip `claimed_id` from `openid.signed`, set `openid.claimed_id` to the victim's ID. The
signature is genuinely valid over the reduced field set, and Steam returns `is_valid:true`. The RP reads
the unsigned value. Equally: unsigned `return_to` means an assertion issued for another site can be
replayed at yours; unsigned `response_nonce` means a successful login can be reused forever.

**[V]** `node-steam-signin` documents precisely these three in code comments:
```js
let requireSigned = [
  'claimed_id',     // The user's SteamID. If not signed, the SteamID could be spoofed.
  'return_to',      // The return URL. If not signed, a login from another (malicious) site could be used.
  'response_nonce'  // The response nonce. If not signed, a successful login could be reused.
];
```
Spec §10.1 requires `openid.signed` to cover at least `op_endpoint`, `return_to`, `response_nonce`,
`assoc_handle`, plus `claimed_id` and `identity` when present. **[V]** OpenID 2.0 §10.1.

**Fix (strictest form).** Require `openid.signed` to **string-equal** the known Steam constant
`signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle`. **[V]** xPaw does this.
**[I]** This is stricter than the spec and will break if Valve ever changes the list — acceptable for a
6-user app, and it fails closed. Belt-and-braces: *also* assert the required subset is present, so a
future Valve change degrades to the spec-minimum check rather than a hard outage if you relax the
equality.

**Only ever read values that are in `signed`.** Build a `signedValues: Map<string,string>` and forbid
the rest of the code from touching the raw query.

### 2.4 `return_to` not verified (assertion relay across sites)

**Bug.** The RP never compares `openid.return_to` to its own callback URL.

**Exploit.** Reported against `passport-steam` in 2019:
*"the owner of `hackerswebsite.example` can use a secret to auth on any website with `passport-steam`"*
— i.e. the attacker logs into their own site with Steam, captures the signed assertion (whose
`return_to` points at *their* domain), then replays those query parameters at your callback. Every
signature check passes, because the assertion is genuine; it just was not issued for you.
**[V]** <https://github.com/liamcurry/passport-steam/issues/92>

**Fix.**
- Parse `openid.return_to` (the **signed** copy) and require scheme + host + port + path to equal
  `https` / `dst.ty.ler.dev` / (none) / `/api/auth/steam/callback` **exactly**.
- Spec §11.1: "The URL scheme, authority, and path MUST be the same between the two URLs. Any query
  parameters that are present in the `openid.return_to` URL MUST also be present with the same values
  in the URL of the HTTP request the RP received." **[V]** OpenID 2.0 §11.1. Implement that subset
  check literally.
- **Do not use `startsWith`.** xPaw uses `str_starts_with` and therefore has to require the return URL
  contain a path, with the comment *"Ensure this URL contains a path (e.g., /login/callback) to prevent
  prefix attacks"* — otherwise `https://dst.ty.ler.dev` prefixes `https://dst.ty.ler.dev.evil.com`.
  **[V]** xPaw constructor. Exact-equality avoids the whole class.
- `node-steam-signin` only canonicalises `return_to` down to the realm and compares realms — weaker
  than path equality. **[V]** (source read). Tighten it.

### 2.5 Replay of a valid assertion (nonce)

**Bug.** No nonce tracking. Spec §11.3: *"To prevent replay attacks, the agent checking the signature
keeps track of the nonce values included in positive assertions and never accepts the same value more
than once for the same OP Endpoint URL."* **[V]** OpenID 2.0 §11.3.

In **stateless** mode the nonce check is the OP's job *in principle*, but Valve's endpoint has
historically returned `is_valid:true` for the same assertion repeatedly. **[I]** — treat that as
unverified and defend yourself. Neither `node-steam-signin` nor `node-steam-openid` tracks nonces.
**[V]** (source read.)

**Exploit.** A callback URL leaks via browser history on a shared device, a `Referer` header, a
CloudFront access log, a Slack link preview, or a screenshot; anyone holding it logs in as that user.

**Fix (see §4).** Timestamp window on `response_nonce` + a single-use signed `state` bound into
`return_to`. Optional DynamoDB seen-nonce table.

### 2.6 `is_valid` substring matching

**Bug.** `if (body.includes('is_valid:true'))` or a regex over the whole body.

**Exploit.** Requires a hostile response body, so it only bites in combination with §2.1 — but it is
free to fix and OpenID KV-form permits arbitrary keys, so a key whose *value* contains
`is_valid:true` (e.g. `error:something is_valid:true`) defeats substring matching. **[I]**

**Fix.** Split on `\n` (after normalising `\r\n`), and require an **exact line match** `is_valid:true`.
Also require a line `ns:http://specs.openid.net/auth/2.0`, and HTTP status exactly 200.
**[V]** `node-steam-signin`: `.some(line => line == 'is_valid:true')`; xPaw: full KV parse then
`$KeyValues['is_valid'] !== 'true'` **and** an `ns` check.

### 2.7 `openid.mode` not checked / `cancel` treated as success

**Bug.** Not requiring `openid.mode === 'id_res'`. `cancel` (user declined) or `error` responses
contain no signature, and a naive "did we get openid params?" check may fall through to a
partially-populated session. **[V]** Both reference implementations check `mode === 'id_res'` as the
first thing they do.

**Fix.** `if (q.get('openid.mode') !== 'id_res') reject`. Handle `cancel` as a clean "you cancelled"
redirect, not an error page with details.

### 2.8 `openid.ns` not checked

**Bug.** Accepting an OpenID **1.1** response. OpenID 1.1 has no `op_endpoint` and a different
signature scheme, so a library supporting both may skip the checks you rely on. **[V]** `xPaw`,
`node-steam-openid` both check `openid.ns === 'http://specs.openid.net/auth/2.0'`.

**Fix.** Require the exact 2.0 namespace in the callback, *and* hardcode `openid.ns` in the
`check_authentication` body (remember from §1.2 that `ns` is not signed, so the callback copy is
advisory only).

### 2.9 Parameter pollution / duplicate parameters

**Bug.** `?openid.claimed_id=<good>&openid.claimed_id=<evil>`. Different parsers pick different
occurrences: `URLSearchParams.get()` returns the **first**; PHP's `$_GET` keeps the **last**; some
frameworks produce an array. If the validation layer and the "who is this user" layer disagree, you have
a bypass. **[I]** (classic HPP; no Steam-specific CVE found, but xPaw defends against it explicitly:
`GetArguments()` rejects any parameter that is not a plain string — i.e. rejects arrays. **[V]**)

**Fix.** Reject the request if **any** `openid.*` parameter appears more than once
(`new URLSearchParams(qs).getAll(k).length > 1`). Build one canonical `Map<string,string>` and use it
everywhere, including for the `check_authentication` body.

### 2.10 Login CSRF

**Bug.** No `state`. The attacker completes a Steam login themselves, then makes the victim's browser
issue a top-level GET to `https://dst.ty.ler.dev/api/auth/steam/callback?openid...` (an `<img>` won't
work — it must be a navigation, so a link, a redirect, or `window.location`). The victim is now silently
signed in **as the attacker**, and anything they do (start a world, save a setting) happens in the
attacker's account. **[I]** — standard login-CSRF; for this app the impact is mild (there are no
per-user resources), but the same `state` mechanism is what blocks §2.5 replay, so implement it anyway.

**Fix.** §4: `state` in `return_to` + matching `__Host-` cookie, one-shot.

### 2.11 Open redirect via the post-login landing page

**Bug.** Supporting `?next=` / `?returnTo=` on the login route and redirecting to it verbatim after
success. `next=https://evil.com` or `next=//evil.com` or `next=/\evil.com`.

**Fix.** Only accept a *relative path*: must start with `/`, must **not** start with `//` or `/\`, must
not contain `\`, and must match `^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#]*$`. Or simply: always redirect to
`/` and keep the intended destination in `sessionStorage` client-side. **[I]** For this app, **always
redirect to `/`** — there is nowhere else to go.

### 2.12 Trusting Steam Web API data as identity

**Bug.** Resolving the claimed identifier by calling `GetPlayerSummaries` and using whatever it returns.
**[V]** The fake-provider README calls this out: `GetPlayerSummaries` "accepts SteamIDs in arbitrary
format", so it launders a malformed claimed_id into a real-looking profile.

**Fix.** Identity is the 17 digits from the anchored regex, and nothing else. Web API data (if used at
all) is *display only* and never feeds the allowlist check.

### 2.13 Not fixing the TLS/HTTP posture of the verification call

**[I]** Small but real: the `check_authentication` fetch must (a) use `https`, (b) **not follow
redirects** (`redirect: 'manual'` / treat 3xx as failure), (c) have a hard timeout (5 s) via
`AbortSignal.timeout(5000)`, (d) send no cookies or credentials. A redirect-following client pointed at
a Steam URL that 302s elsewhere reintroduces §2.1.

---

## 3. THE VERIFICATION CHECKLIST (implement exactly this)

This is the normative part of the document. Each item is one guard clause. All comparisons are
**constant strings**, case-sensitive, using `===`, unless stated otherwise.

### Constants

```ts
const OPENID_NS       = 'http://specs.openid.net/auth/2.0';
const STEAM_OP_ENDPOINT = 'https://steamcommunity.com/openid/login';   // hardcoded, never from input
const EXPECTED_SIGNED = 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle';
const REQUIRED_SIGNED = ['op_endpoint','claimed_id','identity','return_to','response_nonce','assoc_handle'];
const RETURN_TO_ORIGIN = 'https://dst.ty.ler.dev';
const RETURN_TO_PATH   = '/api/auth/steam/callback';
const CLAIMED_ID_RE = /^https?:\/\/steamcommunity\.com\/openid\/id\/(7656119[0-9]{10})$/;
const NONCE_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)/;
const NONCE_MAX_AGE_S = 300;
const NONCE_MAX_SKEW_S = 60;
```

### A. Request construction (the `/api/auth/steam/login` route)

1. Generate 32 bytes from `crypto.randomBytes(32)` → `stateId` (base64url).
2. Compute `stateToken = stateId + '.' + base64url(HMAC-SHA256(stateKey, stateId + '|' + issuedAtSec))`
   — or simply store `stateId` and `issuedAt` in a signed cookie value; either is fine as long as the
   cookie value is integrity-protected and the `state` query parameter is derived from it.
3. Set cookie `__Host-dst_oidc_state` = `stateToken`; `HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600`.
   **`SameSite=Lax` is required and sufficient** — the callback arrives as a cross-site **top-level GET
   navigation**, which Lax cookies are sent on. **[V]** RFC6265bis: Lax cookies are sent "with same-site
   requests, and with cross-site top-level navigations" using a safe method.
   `SameSite=Strict` would break the flow. **[I]**
4. Build `returnTo = RETURN_TO_ORIGIN + RETURN_TO_PATH + '?state=' + encodeURIComponent(stateId)`.
   Put **only** `stateId` in the URL — not the HMAC, not anything secret.
5. Redirect (302) to `STEAM_OP_ENDPOINT + '?' + qs` with the six parameters from §1.1, `openid.realm =
   RETURN_TO_ORIGIN` (include the port if non-default).
6. Never put user-supplied data into `return_to` or `realm`.

### B. Callback validation (the `/api/auth/steam/callback` route)

Order matters: cheap local checks first, network call last.

7. **Method** is `GET`. Reject anything else.
8. **No duplicate parameters.** For every key in the query string starting with `openid.`, assert
   `params.getAll(key).length === 1`. Reject otherwise. (§2.9)
9. **`openid.mode === 'id_res'`.** If it is `cancel`, redirect to `/?login=cancelled`. Anything else →
   reject. (§2.7)
10. **`openid.ns === OPENID_NS`.** (§2.8)
11. **All of these parameters are present and non-empty strings:** `openid.op_endpoint`,
    `openid.claimed_id`, `openid.identity`, `openid.return_to`, `openid.response_nonce`,
    `openid.assoc_handle`, `openid.signed`, `openid.sig`.
12. **`openid.op_endpoint === STEAM_OP_ENDPOINT`.** (§2.1)
13. **`openid.signed === EXPECTED_SIGNED`** (strict). Additionally assert every name in
    `REQUIRED_SIGNED` is in `openid.signed.split(',')`, so relaxing #13 later still leaves a real check.
    (§2.3)
14. **Every field named in `openid.signed` is present in the query string.** Reject if any is missing.
15. **Build `signedValues`**: for each name `n` in `openid.signed`, `signedValues[n] = params.get('openid.' + n)`.
    From here on, read **only** from `signedValues` (plus `openid.sig`).
16. **`signedValues.claimed_id === signedValues.identity`.** (§2.2)
17. **`CLAIMED_ID_RE.exec(signedValues.claimed_id)`** must match; capture group 1 is `steamId64`.
    No `m` flag. `.` escaped. Fully anchored. (§2.2)
18. **`BigInt(steamId64) >= 76561197960265729n`.** (§2.2)
19. **`return_to` exact structural equality.** Parse `signedValues.return_to` with `new URL()`;
    require `u.protocol === 'https:'`, `u.host === 'dst.ty.ler.dev'` (host, so a port is caught),
    `u.pathname === RETURN_TO_PATH`, `u.username === '' && u.password === ''`, `u.hash === ''`.
    **Do not use `startsWith`.** (§2.4)
20. **`return_to` query is a subset of the actual request query, with equal values** (spec §11.1):
    for each `[k,v]` in `u.searchParams`, assert `params.get(k) === v`. (§2.4)
21. **`state` present and matches the cookie.** Read `__Host-dst_oidc_state`; verify its HMAC; assert
    `stateIdFromCookie === u.searchParams.get('state')` using `crypto.timingSafeEqual`; assert the
    cookie's `issuedAt` is within 600 s. **Delete the state cookie now** (`Max-Age=0`), before the
    network call, so a concurrent replay cannot reuse it. (§2.10, §2.5)
22. **`response_nonce` format and freshness.** `NONCE_RE` must match; parse the RFC 3339 prefix;
    require `now - t <= NONCE_MAX_AGE_S` and `t - now <= NONCE_MAX_SKEW_S`. (§2.5)
    **[V]** xPaw uses `abs(time() - nonce) > 300`.
23. **`check_authentication` POST.** Body = every entry of `signedValues` re-prefixed with `openid.`,
    plus `openid.signed`, `openid.sig`, plus **our own** `openid.ns = OPENID_NS` and
    `openid.mode = 'check_authentication'`. URL = `STEAM_OP_ENDPOINT` constant.
    `Content-Type: application/x-www-form-urlencoded`. Headers `Referer: https://steamcommunity.com/`,
    `Origin: https://steamcommunity.com`. `redirect: 'manual'`, `signal: AbortSignal.timeout(5000)`,
    no credentials. (§1.3, §2.1, §2.13)
24. **HTTP status must be exactly 200.** 403/429 → return a "Steam is rate-limiting, try again in a
    minute" page (5xx-ish UX), *not* "login failed". Any 3xx → hard reject. (§1.3)
25. **Parse the body as Key-Value Form**: normalise `\r\n`→`\n`, split on `\n`, split each line on the
    first `:`. Require `kv['ns'] === OPENID_NS` **and** `kv['is_valid'] === 'true'` (exact, not
    substring). (§2.6)
26. **Allowlist check.** `allowlist.includes(steamId64)`. If not, render a neutral
    "this account isn't on the list" page. Do **not** mint a session first and check later.
27. **Mint the session** (§5) and 302 to `/`. Never redirect to a user-supplied URL. (§2.11)
28. **Log** `steamId64`, outcome, and which check failed — but never the full callback URL (it contains
    a replayable assertion) and never `openid.sig`.

### C. Ambient requirements

29. The callback route must send `Referrer-Policy: no-referrer` (the page it renders would otherwise
    leak the assertion URL in `Referer` to any resource it loads) and `Cache-Control: no-store`.
30. CloudFront must **not** cache `/api/*` (cache policy `CachingDisabled`) — a cached callback response
    or a cached `/api/me` would be an account-mixing bug.

---

## 3bis. Unit-test case list

Structure the verifier as a pure function
`verifyCallback(queryString, cookieHeader, deps: { now, fetchSteam, stateKey })` so every case below is
a plain unit test with `fetchSteam` stubbed. Build a `validQuery()` fixture helper that returns a
correct set of parameters, and mutate it per case.

**Happy path**
1. Valid response, `fetchSteam` → `200 "ns:...\nis_valid:true\n"` → resolves with the expected 17-digit ID.
2. Valid response with `claimed_id` over **http** instead of https → still resolves (Steam has used both).
3. `fetchSteam` receives a body containing `openid.mode=check_authentication`, `openid.ns` = the 2.0 NS,
   and every signed field verbatim — assert on the captured request body and that the URL is exactly
   `https://steamcommunity.com/openid/login`.

**Forgery — §2.1**
4. `openid.op_endpoint = 'https://evil.example/openid/login'` → rejected **and `fetchSteam` never called**.
5. `openid.op_endpoint = 'https://steamcommunity.com/openid/login/'` (trailing slash) → rejected.
6. `openid.op_endpoint = 'https://steamcommunity.com.evil.example/openid/login'` → rejected.
7. `openid.op_endpoint = 'http://steamcommunity.com/openid/login'` (http) → rejected.
8. Stub `fetchSteam` to resolve `is_valid:true` for *any* input, and feed a claimed_id for a
   non-allowlisted SteamID → still rejected at the allowlist step (defence in depth).

**Loose claimed_id — §2.2**
9. `claimed_id = 'https://steamcommunity.com/openid/id/76561198000000000.evil.com/'` → rejected.
10. `claimed_id = 'https://steamcommunity.com/openid/id/76561198000000000/'` (trailing slash) →
    rejected by the strict regex (or accepted if you choose to allow `\/?` — pick one and test it).
11. `claimed_id = 'https://evil.com/?u=https://steamcommunity.com/openid/id/76561198000000000'` → rejected.
12. `claimed_id = 'https://steamcommunityXcom/openid/id/76561198000000000'` → rejected (escaped dot).
13. `claimed_id = 'https://steamcommunity.com/openid/id/76561198000000000\n'` → rejected.
14. `claimed_id = 'https://steamcommunity.com/openid/id/123'` (too short) → rejected.
15. `claimed_id = 'https://steamcommunity.com/openid/id/00000000000000000'` (below the individual base)
    → rejected.
16. `claimed_id !== identity` → rejected.

**Signed-field tampering — §2.3**
17. `openid.signed` omits `claimed_id` (e.g. `signed,op_endpoint,identity,return_to,response_nonce,assoc_handle`)
    → rejected, `fetchSteam` never called.
18. `openid.signed` omits `return_to` → rejected.
19. `openid.signed` omits `response_nonce` → rejected.
20. `openid.signed` lists a field that is absent from the query → rejected.
21. `openid.signed` has extra fields appended → rejected by the strict equality check.
22. A **non**-signed parameter is tampered (e.g. an extra `openid.foo=bar`) and `signed` is untouched →
    still succeeds, and the tampered parameter is absent from the captured `check_authentication` body.

**return_to — §2.4**
23. `return_to` host = `dst.ty.ler.dev.evil.com` → rejected (proves no prefix matching).
24. `return_to` path = `/api/auth/steam/callback/../../x` → rejected (compare `u.pathname` post-parse).
25. `return_to` scheme = `http` → rejected.
26. `return_to` includes `?state=A` while the actual request URL has `state=B` → rejected (§11.1 subset).
27. `return_to` includes an extra signed query param not present in the request URL → rejected.
28. Actual request URL has extra params not in `return_to` → **accepted** (§11.1 is one-directional).

**state / login CSRF — §2.10**
29. No state cookie at all → rejected.
30. State cookie present but `state` query param missing → rejected.
31. State cookie's id ≠ `state` query param → rejected.
32. State cookie with a corrupted HMAC → rejected.
33. State cookie older than 600 s → rejected.
34. Replaying the *same* full callback twice: second call rejected, because the state cookie was cleared
    (simulate by passing an empty cookie header on the second call).

**Nonce — §2.5**
35. `response_nonce` with a timestamp 10 minutes old → rejected, `fetchSteam` never called.
36. `response_nonce` 10 minutes in the future → rejected.
37. `response_nonce` malformed (`not-a-date-suffix`) → rejected.
38. `response_nonce` exactly at the boundary (300 s) → define and test the inclusive/exclusive edge.

**Steam response parsing — §2.6**
39. `fetchSteam` → `200 "ns:...\nis_valid:false\n"` → rejected.
40. `fetchSteam` → `200 "error:is_valid:true\n"` → rejected (proves no substring matching).
41. `fetchSteam` → `200 "is_valid:true"` **without** the `ns` line → rejected.
42. `fetchSteam` → `200` with CRLF line endings and `is_valid:true` → accepted.
43. `fetchSteam` → `403` → rejected with a *retryable* error type distinct from "auth failed".
44. `fetchSteam` → `429` → same as 43.
45. `fetchSteam` → `302` → rejected.
46. `fetchSteam` times out → rejected with the retryable error type.

**mode / ns / pollution — §2.7–2.9**
47. `openid.mode = 'cancel'` → returns the "cancelled" outcome, not an error, and mints no session.
48. `openid.mode = 'id_res '` (trailing space) → rejected.
49. `openid.ns = 'http://openid.net/signon/1.1'` → rejected.
50. Duplicate `openid.claimed_id` (good then evil) → rejected.
51. Duplicate `openid.claimed_id` (evil then good) → rejected.
52. Duplicate `openid.signed` → rejected.

**Session / allowlist — §5**
53. Valid login by a SteamID **not** in the allowlist → no `Set-Cookie` for the session, neutral message.
54. Valid login by an allowlisted SteamID → `Set-Cookie` matches
    `/^__Host-dst_session=[^;]+; Max-Age=2592000; Path=\/; HttpOnly; Secure; SameSite=Lax$/`.
55. Session cookie signed with the **test** secret is rejected when the verifier runs with
    `APP_ENV=prod` (see §5.5).
56. Session cookie with a flipped bit in the signature → rejected.
57. Session cookie past `exp` → rejected.
58. Session cookie for a SteamID that has since been removed from the allowlist → rejected on the next
    API call (allowlist re-check).
59. `POST /api/worlds/:id/start` with no `Origin` header, or a foreign `Origin` → 403 (§5.6).

---

## 4. Replay/nonce and login-CSRF without an always-on database

Three candidate designs:

**(a) Signed, single-use `state` cookie bound into `return_to` — RECOMMENDED.**
Cost: zero. Blocks login CSRF (§2.10) outright, because the attacker cannot set a `__Host-`-prefixed
cookie on `dst.ty.ler.dev` — `__Host-` forbids a `Domain` attribute, so even a compromised sibling
subdomain cannot write it. **[V]** RFC6265bis `__Host-` definition. It also blocks cross-browser replay
(§2.5): a leaked callback URL is useless without the matching HttpOnly cookie. It does **not** block a
same-browser replay of the same URL within 10 minutes, which is harmless (it logs you in as yourself,
and the cookie is cleared on first use anyway).

**(b) `response_nonce` timestamp window — RECOMMENDED, in addition.**
Cost: zero. Caps the useful lifetime of any leaked assertion at 5 minutes even if (a) somehow fails.
xPaw ships exactly this. **[V]**

**(c) DynamoDB on-demand table of seen nonces with TTL — NOT needed here.**
`PK = response_nonce`, `ttl = now + 600`, write with
`ConditionExpression: 'attribute_not_exists(pk)'` and treat `ConditionalCheckFailedException` as
"replayed". On-demand pricing means ~$0 at 6 users, and the table is idle-free (satisfies scale-to-zero).
**[I]** It is the only thing that makes replay *strictly* impossible rather than *practically*
impossible, and it is ~20 lines. Recommendation: **skip it for v1**, leave a TODO. If you later add a
DynamoDB table for anything else (e.g. world metadata), fold the nonce item into it — at that point the
marginal cost is one conditional `PutItem` per login.

**Design (a)+(b) in one paragraph.** On `/api/auth/steam/login`: 32 random bytes → `stateId`; set
`__Host-dst_oidc_state` (HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=600) to
`stateId.HMAC(stateKey, stateId|issuedAt)`; put `?state=<stateId>` in `return_to`. On callback: checklist
items 21–22. Clear the cookie before the network round trip. `stateKey` can be the **same** secret as
the session key, domain-separated via HKDF `info` (`"state-v1"` vs `"session-v1"`), so there is only one
secret to manage. **[I]**

---

## 5. Session cookie design

### 5.1 Stateless vs DynamoDB sessions

**Stateless HMAC cookie.** Zero infrastructure, zero latency, satisfies scale-to-zero perfectly. The
usual objection — "you cannot revoke" — is neutralised here because **the allowlist is re-checked on
every request** (§5.4), which is the only revocation this app needs. **Recommended.**

DynamoDB sessions buy per-device revocation and instant global logout. For 6 friends, not worth the
code. **[I]**

### 5.2 Token format

Do **not** reach for a JWT library. Node 22 has everything needed. Suggested format:

```
v1.<env>.<base64url(JSON payload)>.<base64url(HMAC-SHA256(key, "v1." + env + "." + payloadB64))>
payload = { sub: "76561198...", iat: 1758304800, exp: 1760896800 }
```

Verify with `crypto.timingSafeEqual` on the raw signature bytes, after checking lengths. Reject on any
parse failure before touching the payload. Avoid JWT's `alg` confusion class of bug entirely by not
having an `alg` field. **[I]**

### 5.3 Cookie attributes

```
Set-Cookie: __Host-dst_session=<token>; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax
```

- **`__Host-` prefix**: requires `Secure`, `Path=/`, and **no** `Domain`. **[V]** RFC6265bis. This is
  what makes cookie-forcing from a sibling subdomain impossible — relevant because `ty.ler.dev` likely
  hosts other things.
- **`SameSite=Lax`**, not `Strict`: `Strict` would mean a friend clicking a link to the app from
  Discord lands logged-out, and would break the Steam callback navigation. **[V]** RFC6265bis Lax
  semantics (sent on cross-site top-level safe-method navigations).
- **`Max-Age=2592000`** (30 days). For friends on phones this is the right call; `Expires` is implied by
  `Max-Age`. Consider a sliding refresh: if `exp - now < 20 days`, re-issue the cookie on any request.
  **[I]**
- `Path=/` is mandatory for `__Host-` and is also what you want (SPA at `/`, API at `/api/*`).
- **Dev caveat:** browsers treat `http://localhost` as a secure context, so `Secure` and `__Host-`
  cookies work there. If a given browser/Playwright version disagrees, fall back to the name
  `dst_session_dev` in dev only, selected by `APP_ENV`. **[I]** — verify empirically during
  implementation.

### 5.4 Secret storage, caching, rotation, revocation

- **SSM Parameter Store SecureString**, standard tier, e.g. `/dst/prod/session-secret`. Standard
  parameters are free; SecureString with the **AWS-managed** `aws/ssm` key incurs no KMS key charge
  (KMS API request charges apply and are negligible at this volume). Secrets Manager would be $0.40/mo
  for no benefit here. **[V]** <https://aws.amazon.com/systems-manager/pricing/>,
  <https://docs.aws.amazon.com/systems-manager/latest/userguide/secure-string-parameter-kms-encryption.html>
- **Caching:** read once into a module-scope variable at cold start, with a 5-minute re-read TTL so
  rotation propagates without a redeploy. Do not use the SSM Lambda extension layer (extra cold-start
  weight for one parameter). **[I]**
- **Rotation:** store the parameter as JSON `{"current":"k2","keys":{"k1":"...","k2":"..."}}` and put the
  key id in the token (`v1.<env>.<kid>.<payload>.<sig>`). Sign with `current`, accept any listed key.
  Rotate by adding `k3` as `current`, waiting 30 days, then deleting `k1`. Without this, rotation logs
  everyone out — acceptable for 6 friends, so **[I]** this is optional; if you skip it, note that
  rotation = everyone signs in again.
- **Derive, don't use raw:** `key = hkdfSync('sha256', secret, salt='dst-v1', info=`${env}:session`)`.
  Gives free domain separation between the session key, the state key, and environments.
- **Revocation / allowlist:** every authenticated request re-reads the allowlist (SSM `GetParameter`,
  cached 60 s in module scope) and rejects a `sub` that is no longer present. Removing a friend takes
  effect within 60 s with no session store. **[I]**

### 5.5 Playwright e2e without a production backdoor — the design is sound

Yes: tests mint a session cookie with a **test-only** secret against a locally-run API. Three
independent guarantees that the test secret can never be valid in production:

1. **Different key material, and production has no path to the test material.** Production reads the
   secret *only* from `ssm:/dst/prod/session-secret`. The loader has **no environment-variable
   fallback**: `if (!value) throw new Error('missing session secret')`. The dev/test secret is a
   literal constant committed in the test helper (harmless, see #2). The prod Lambda role's IAM policy
   grants `ssm:GetParameter` on that one ARN only.
2. **Environment binding inside the signature.** `env` appears both in the token (`v1.<env>....`) and in
   the HKDF `info`. Verification does `if (token.env !== process.env.APP_ENV) reject` **before**
   computing the HMAC, and the derived key differs anyway. A token minted as `env=test` is
   unconditionally rejected by a verifier running with `APP_ENV=prod`, **even if the same raw secret
   string were somehow configured in both**. This is the guarantee that survives operator error.
3. **CDK sets `APP_ENV=prod` on the production Lambda and nothing else can.** `APP_ENV` is not read from
   any request header, query parameter, or cookie. Add an assertion at module load:
   `if (APP_ENV === 'prod' && process.env.DEV_SESSION_SECRET) throw`.

Plus test #55 in §3bis, which fails the build if any of this regresses. **[I]** — this is a design
recommendation, not a sourced claim, but it is the standard pattern and each layer is independently
sufficient.

Note the test helper never touches Steam: it mints the cookie directly, so the Playwright suite exercises
everything *after* sign-in. Keep **one** separate, manual, non-CI smoke test for the real Steam flow.

### 5.6 CSRF for POST /start and /stop

`SameSite=Lax` already blocks cookies on cross-site POSTs, which is most of the defence. **[V]**
RFC6265bis. Two cheap additions, both required:

1. **Origin check.** Require `Origin === 'https://dst.ty.ler.dev'` on every non-GET request. Reject if
   the header is absent (all modern browsers send `Origin` on POST). Do not fall back to `Referer`.
2. **Custom header.** Require `X-DST-Request: 1`. A cross-origin `fetch`/`XHR` cannot set a custom
   header without a successful CORS preflight, and there is no CORS configuration on this API (same
   origin), so the preflight fails. HTML forms cannot set headers at all.

Do **not** bother with a double-submit CSRF token; for a same-origin SPA the two checks above are
equivalent and simpler. **[I]** If OAC-with-IAM is used (§6), the `x-amz-content-sha256` header is a
third de facto custom header on every POST.

---

## 6. Architecture fit: CloudFront in front of S3 + the API

Single distribution, `dst.ty.ler.dev`:
- Default behaviour → S3 origin (OAC, SPA, `index.html` fallback for 403/404).
- `/api/*` behaviour → Lambda origin, `CachingDisabled` cache policy,
  `AllViewerExceptHostHeader` origin-request policy (forwards all query strings, headers and cookies).
- Same origin ⇒ cookies are first-party, no CORS, no preflight. This is the right call; it is also what
  makes `__Host-` cookies and the Origin check in §5.6 work cleanly. **[I]**
- The Steam `return_to` is `https://dst.ty.ler.dev/api/auth/steam/callback`, which resolves under the
  `/api/*` behaviour. Steam's redirect is a plain GET, so no payload-signing issue on the callback path.

### 6.1 Lambda Function URL vs API Gateway HTTP API

| | Lambda Function URL | API Gateway HTTP API |
|---|---|---|
| Idle cost | $0 | $0 |
| Per-request | $0 | $1.00 / million **[V]** <https://aws.amazon.com/api-gateway/pricing/> |
| Origin lock-down | OAC + `AuthType: AWS_IAM` **[V]** | CloudFront secret origin header (no OAC for HTTP APIs) |
| POST caveat | **yes**, see below | none |
| Max payload | 6 MB (sync invoke) | 10 MB |
| Timeout | up to 15 min (response streaming) | 30 s |

At 6 users the cost difference is literally cents per decade; choose on simplicity and lock-down
quality.

### 6.2 The `x-amz-content-sha256` caveat — still live as of 2026-09

**[V] Verified today against the current AWS docs** (<https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html>):

> **Important**
> If you use `PUT` or `POST` methods with your Lambda function URL, your users must compute the SHA256 of
> the body and include the payload hash value of the request body in the `x-amz-content-sha256` header
> when sending the request to CloudFront. Lambda doesn't support unsigned payloads.

There is no fix and no "CloudFront now computes it" note; the page still ships a Python example whose
whole purpose is to demonstrate the client-side hash. Community confirmations:
<https://repost.aws/questions/QUbHCI9AfyRdaUPCCo_3XKMQ/lambda-function-url-behind-cloudfront-invalidsignatureexception-only-on-post>,
<https://github.com/piotrekwitkowski/cloudfront-signed-fetch>. **[V]**

### 6.3 Recommendation

**Lambda Function URL + OAC with `AuthType: AWS_IAM`, and a ~10-line fetch wrapper in the SPA.**

```ts
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

async function apiFetch(path: string, init: RequestInit = {}) {
  const body = init.body as string | undefined;
  const hash = body
    ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)))]
        .map(b => b.toString(16).padStart(2, '0')).join('')
    : EMPTY_SHA256;
  return fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { ...init.headers, 'x-amz-content-sha256': hash, 'X-DST-Request': '1' },
  });
}
```

Requirements: OAC `OriginAccessControlOriginType: lambda`, `SigningBehavior: always`, `SigningProtocol:
sigv4`; the function-URL resource policy grants `cloudfront.amazonaws.com` with a
`AWS:SourceArn = <distribution arn>` condition (two `aws lambda add-permission` calls,
`lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`) — **[V]** same AWS doc; CDK's
`FunctionUrlOrigin.withOriginAccessControl()` does this for you. Also ensure the origin-request policy
forwards `x-amz-content-sha256` (`AllViewerExceptHostHeader` does).

This gives a genuinely IAM-enforced origin: the function URL simply cannot be invoked except via your
distribution. $0 idle, $0 per request.

**Pragmatic fallback if the OAC POST path misbehaves:** `AuthType: NONE` + a CloudFront **custom origin
header** `x-dst-origin-secret: <random>` sourced from SSM, compared with `timingSafeEqual` in the Lambda;
reject otherwise. This is 6 lines total, has no payload caveat, and is only marginally weaker — the real
authorization boundary is the session cookie, and the function URL hostname is unguessable-ish but must
be treated as public. **[I]** Do **not** choose API Gateway for this; it adds a second service and a
per-request charge to solve a problem that either option above already solves.

---

## 7. Steam Web API key

### 7.1 What it takes

- Register at `https://steamcommunity.com/dev/apikey`. **[V]** <https://steamcommunity.com/dev>
- The account must **not be limited** — i.e. it must have spent at least $5.00 on Steam. Tyler owns DST,
  so this is satisfied. **[V]** (community-documented requirement; Valve's limited-account policy)
- A **domain name** field is required; it is not enforced in practice (people use `localhost`). **[V]**
- Key creation now requires confirmation in the **Steam Mobile Authenticator**. **[V]**

### 7.2 Terms of use — the part that matters

**[V]** <https://steamcommunity.com/dev/apiterms>:
- *"You agree to keep your Steam Web API key confidential, and not to share it with any third party."*
  → SSM SecureString, never in the repo, never shipped to the browser.
- *"You are limited to one hundred thousand (100,000) calls to the Steam Web API per day."*
- *"You will only retrieve Steam Data about a Steam end user as requested by the end user."*
- **"You will post a privacy policy regarding the use of nonpublic end user data (including such Steam
  Data)."** ← this is a real obligation you would be taking on for a 6-person hobby app.
- Must not imply Valve endorsement.

Additionally, practitioners report a wave of `429 Too Many Requests` on `GetPlayerSummaries` since
mid-2025 beyond the documented daily quota, and a separate per-IP burst limit. **[V]**
<https://www.steamwebapi.com/blog/429-too-many-requests-for-getplayersummaries>,
<https://dev.doctormckay.com/topic/5512-steam-web-api-rate-limits/>

### 7.3 The call

```
GET https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/?key=<KEY>&steamids=<id>[,<id>...]
-> { response: { players: [ { steamid, personaname, profileurl, avatar, avatarmedium, avatarfull, ... } ] } }
```
Up to 100 SteamIDs per call. **[V]** <https://github.com/almic/steam-js-api/wiki/ISteamUser>.
Avatars are CDN URLs, so the SPA would hotlink `avatars.steamstatic.com` — a third-party request from
your page. **[I]**

### 7.4 Verdict: **not worth it**

For "started by \<name\>" among 6 people whose names you already know, a Web API key adds: a secret to
store and rotate, a privacy-policy obligation, a third-party dependency in the login path (or a cache
layer), 429 handling, and hotlinked third-party images — to render 6 strings that change roughly never.

**Use instead:** one SSM parameter that *is* the allowlist and the name map:

```
/dst/prod/users   (String, JSON)
{"76561198000000001":"Tyler","76561198000000002":"Sam","76561198000000003":"Alex"}
```

Allowlist check = `Object.hasOwn(users, sub)`. Display name = `users[sub]`. One parameter, one CLI
command to edit, no key, no ToS. If someone later really wants avatars, add the key then — the
`startedBy` field will already be a SteamID64, so it is a purely additive change. **[I]**

---

## 8. Steam vs Google

| | **Steam OpenID 2.0** | **Google OIDC** |
|---|---|---|
| Setup | None. No registration, no client id, no secret, no consent screen. | Google Cloud project → OAuth client → authorized redirect URIs → consent screen (even "internal"/testing has steps). A client secret to store & rotate (or PKCE-only public client). |
| Code | ~130 lines, one outbound POST, no deps. | `openid-client` or hand-rolled: discovery, PKCE verifier/challenge, code exchange, JWKS fetch + cache + key rotation, JWT `alg`/`iss`/`aud`/`azp`/`exp`/`nonce` validation. More code, more moving parts. **[I]** |
| Risk surface | The 13 pitfalls in §2 — all closed by a checklist you own and unit-test. | Fewer historical bypasses in mainstream libs, but JWT/JWKS handling has its own well-known failure modes (`alg:none`, missing `aud`, accepting any `iss`). Roughly a wash once both are done right. **[I]** |
| Allowlist | **SteamID64 — a public, non-PII-ish identifier.** | **Email addresses**, which the brief says must never be tracked. Forces SSM regardless, and leaks real identities if ever mis-committed. **Point to Steam.** |
| Mobile UX | Friends open the app in a mobile browser, tap "Sign in with Steam", land on `steamcommunity.com`. If already signed in there (common), it's one tap. If not: username + password + Steam Guard code from the app; or scan the QR code with the Steam Mobile App — but the QR flow is designed for signing in *on a PC from your phone*, which is awkward when the browser **is** the phone. **[V]** <https://help.steampowered.com/en/faqs/view/7EFD-3CAE-64D3-1C31>. Realistic worst case: a one-time password + 2FA-code entry, then the `steamcommunity.com` session persists and later logins are one tap. **[I]** | Essentially always one tap; the Google account is already signed in on every phone. Clearly better, by maybe 60 seconds, **once**. **[I]** |
| Phishing optics | Real, and worth naming: you are training friends to type Steam credentials after clicking a link from your site. Mitigations: the domain is genuinely `steamcommunity.com` (check the padlock), Steam Guard blocks credential-only theft, and they already do this for every Steam trading/stats site. **[I]** | No equivalent concern. |
| Availability | `steamcommunity.com/openid/login` has been stable for 15 years, but Valve rate-limits it (403/429) **[V]** and it goes down with Steam. Steam outages are rare but real. Impact: cannot sign in; existing 30-day sessions keep working. **[I]** | Higher availability. |
| Ongoing maintenance | Zero. No secret, no console, no expiring credentials. Valve has twice changed small things (realm must include port; https `claimed_id`) — both caught by the checklist. **[V]** | Client secret rotation, OAuth consent screen re-verification prompts, possible "unverified app" friction. **[I]** |

**Is Steam meaningfully worse? No.** The only real cost is a possible one-time password entry on a phone
for friends not signed in to Steam in mobile Safari/Chrome, plus the phishing-habit optic. Against that:
no app registration, no secret at all, an allowlist made of public identifiers instead of email
addresses, and a codebase you fully understand. Given this app is *for* DST players who all own the game
and the brief explicitly says emails must never be tracked, **Steam is the better fit.**

**Recommendation: build Steam.** Structure the auth Lambda as `IdentityProvider -> { steamId64 }` so
adding Google later is one new route + one new verifier, not a rewrite. **[I]**

---

## 9. Library vs hand-rolled

### 9.1 Survey (checked 2026-09-19)

| Package | Last publish | Deps | Assessment |
|---|---|---|---|
| **`steam-signin`** (DoctorMcKay) | **1.0.5, 2025-02-12** **[V]** | `steamid` only **[V]** | The best of the bunch. Checks `mode`, required-signed fields, anchored `claimed_id` regex, sets `ns`/`mode` itself, exact `is_valid:true` line match, hardcoded POST URL. **Gaps:** no `op_endpoint` equality check, `return_to` compared only at *realm* granularity (not path — see §2.4), no nonce freshness, no duplicate-parameter check, no `state`. 35 stars, 4 open issues incl. a realm/port fix (#8) that is **still unmerged**. **[V]** |
| `node-steam-openid` (LeeviHalme) | 2.0.0, 2024-11-23 **[V]** | `axios`, **`openid`**, `url` **[V]** | Does check `ns`, `op_endpoint`, `claimed_id`/`identity` prefixes, and re-checks with an anchored regex after verification — decent. **But** it delegates the actual assertion verification to the generic `openid` package (discovery machinery, the §2.1 footgun), *requires* a Steam Web API key in the constructor, pulls axios, and does `.replace()`-based SteamID extraction (§2.2). **[V]** source read. |
| `passport-steam` (liamcurry) | 1.0.18, **2023-06-18** **[V]** | `@passport-next/passport-openid`, `steam-web@0.4.0` **[V]** | Historically vulnerable (§2.1), patched, but unmaintained for 3 years and drags in Passport + a pinned 12-year-old `steam-web`. Open issue #92 (login relay, §2.4) closed without a library fix. **[V]** Avoid. |
| `modern-passport-steam`, `@dessly/passport-steam` | forks | — | Exist specifically because of the passport-steam vulnerability; small, low-usage, no advisories either way. **[V]** <https://github.com/easton36/modern-passport-steam> Not worth the trust. |
| `openid` (havard/node-openid) | 2.0.18, 2026-09-08 **[V]** | — | Actively maintained, but it is a **general-purpose** OpenID 2.0 RP that performs discovery — the wrong shape for a single hardcoded provider, and the source of the §2.1 class of bug. |

No GitHub Security Advisories exist for any npm `steam*`/`openid*` package — these were fixed as plain
commits, not advisories. **[V]** (queried the GitHub advisories API for the npm ecosystem; no matches).
That is itself a reason not to rely on `npm audit` to tell you a Steam auth library is safe.

### 9.2 Recommendation: **hand-roll it**

~130 lines of TypeScript implementing §3 exactly, zero dependencies, on Node 22 (global `fetch`,
`node:crypto`, `URL`, `URLSearchParams` — nothing else needed).

Reasons:
1. Every library above is missing at least three items from the §3 checklist (most commonly: exact
   `return_to` path equality, nonce freshness, duplicate-parameter rejection, and `state`). You would be
   writing the wrapper checks anyway — at which point the library is contributing only the HTTP POST.
2. The whole protocol surface is one GET redirect and one POST. There is no crypto to get wrong on our
   side: **Steam verifies its own signature.** Our job is input validation, which is exactly the thing
   that is easier to get right when it is 130 explicit lines with 59 unit tests than when it is split
   across three packages.
3. Supply chain: an auth path with zero third-party code cannot be compromised by a dependency takeover.
   For a public repo with a handful of users, that is the strongest available guarantee.
4. Node 22 gives `AbortSignal.timeout`, `crypto.hkdfSync`, `crypto.timingSafeEqual`, and global `fetch`.

**Do this:** write it, then diff your implementation against `xPaw/SteamOpenID.php` (the most rigorous
implementation found, in any language) and `DoctorMcKay/node-steam-signin` line by line, and add a
comment citing the check each guard clause corresponds to. Vendor neither.

---

## 10. Allowlist location: SSM vs hardcoding in the public repo

**Is hardcoding meaningfully simpler? No.** The difference is:

```ts
// hardcoded
const ALLOWLIST = ['76561198000000001', ...];            // + a deploy to change
```
vs
```ts
// SSM (cached 60s in module scope, ~15 lines including the cache)
const users = await getUsers();                           // aws ssm put-parameter --overwrite ... to change
```

~15 lines and one IAM statement, against **one CLI command instead of a commit + CI run** to add or
remove a friend. SSM is arguably the *operationally* simpler of the two. **[I]**

**Privacy/security assessment of hardcoding:**
- SteamID64s are public identifiers — true, and they are trivially resolvable to a profile URL
  (`https://steamcommunity.com/profiles/<id>`), often a real name, friends list, playtime, and country.
- The harm is not disclosure of a secret; it is **publishing a permanent, machine-readable, Git-history-
  immortal assertion that these specific six people are friends who play together on this server.**
  That is a small but genuine piece of social-graph data about *other people*, published without their
  input, which cannot be retracted (rewriting history does not un-fork or un-archive a public repo).
- It also creates a targeting list: anyone who finds a bug in the app knows exactly whose Steam accounts
  are worth phishing to use it.
- Security-wise the allowlist is not a credential, so hardcoding is not an auth weakness. It is purely a
  privacy and reversibility question. **[I]**

**Recommendation: SSM.** Use the single `/dst/prod/users` JSON parameter from §7.4 (allowlist + display
names in one place, `String` type, not `SecureString` — it is not secret, just unpublished; `String`
avoids KMS entirely and still keeps it out of the repo). Keep a committed
`docs/allowlist.example.json` with fake IDs so the shape is documented. If you ever add Google as a
fallback, emails go in the same parameter and the constraint is already satisfied.

---

## 11. Sources

**Primary — spec & Steam**
- OpenID Authentication 2.0 (Final) — §9 request, §10.1 signed fields, §11.1 return URL, §11.2 discovered
  info, §11.3 nonce, §11.4.2 `check_authentication`, §14.2.1 `identifier_select`:
  <https://openid.net/specs/openid-authentication-2_0.html>
- Steam Web API documentation / OpenID pointer: <https://steamcommunity.com/dev>
- Steam Web API Terms of Use: <https://steamcommunity.com/dev/apiterms>
- Steamworks — User Authentication and Ownership: <https://partner.steamgames.com/doc/features/auth>
- Steam Guard Mobile Authenticator: <https://help.steampowered.com/en/faqs/view/7EFD-3CAE-64D3-1C31>

**Vulnerabilities & write-ups**
- scholtzm/steam-fake-openid-provider (working exploit; names `passport-steam`, `steam-login`):
  <https://github.com/scholtzm/steam-fake-openid-provider>
- omniauth-steam #24, "Anyone can login using self-owned fake openid server":
  <https://github.com/reu/omniauth-steam/issues/24>
- SocialiteProviders/Steam — "Authentication bypass via attacker provided openid server" (GMS-2021-57):
  <https://advisories.gitlab.com/pkg/composer/socialiteproviders/steam/GMS-2021-57>
- passport-steam #92, cross-site assertion relay: <https://github.com/liamcurry/passport-steam/issues/92>
- passport-steam #80, `claimed_id` is https now: <https://github.com/liamcurry/passport-steam/issues/80>

**Reference implementations (read in full)**
- xPaw/SteamOpenID.php (strictest found): <https://github.com/xPaw/SteamOpenID.php>
- DoctorMcKay/node-steam-signin: <https://github.com/DoctorMcKay/node-steam-signin>
  - PR #8 realm/port fix: <https://github.com/DoctorMcKay/node-steam-signin/pull/8>
  - PR #9 example port fix: <https://github.com/DoctorMcKay/node-steam-signin/pull/9>
  - Issue #7 intermittent Access Denied: <https://github.com/DoctorMcKay/node-steam-signin/issues/7>
- LeeviHalme/node-steam-openid: <https://github.com/LeeviHalme/node-steam-openid>
- No associations: <https://github.com/jbufu/openid4java/issues/192>,
  <https://github.com/jaredhanson/passport-openid/issues/1>

**AWS**
- CloudFront OAC for Lambda function URLs, incl. the `x-amz-content-sha256` requirement:
  <https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html>
- re:Post, InvalidSignatureException on POST:
  <https://repost.aws/questions/QUbHCI9AfyRdaUPCCo_3XKMQ/lambda-function-url-behind-cloudfront-invalidsignatureexception-only-on-post>
- cloudfront-signed-fetch (client-side hash helper): <https://github.com/piotrekwitkowski/cloudfront-signed-fetch>
- Systems Manager pricing (standard parameters free): <https://aws.amazon.com/systems-manager/pricing/>
- SecureString KMS encryption:
  <https://docs.aws.amazon.com/systems-manager/latest/userguide/secure-string-parameter-kms-encryption.html>
- API Gateway pricing: <https://aws.amazon.com/api-gateway/pricing/>

**Cookies**
- RFC 6265bis (`__Host-`/`__Secure-` prefixes, SameSite=Lax semantics):
  <https://datatracker.ietf.org/doc/html/draft-ietf-httpbis-rfc6265bis-15>

**Steam Web API**
- ISteamUser/GetPlayerSummaries fields & 100-id batching:
  <https://github.com/almic/steam-js-api/wiki/ISteamUser>
- 429 rate-limit reports: <https://www.steamwebapi.com/blog/429-too-many-requests-for-getplayersummaries>,
  <https://dev.doctormckay.com/topic/5512-steam-web-api-rate-limits/>

---

## 12. Open questions for the owner

1. **`claimed_id` trailing slash** — decide now whether `.../id/765...` only, or `.../id/765.../` too.
   Both reference libraries differ. Recommendation: accept an optional single trailing slash
   (`\/?$`) and test both. Not source-resolved.
2. **Does Valve's endpoint actually return `is_valid:true` for a replayed assertion?** Untested here.
   If it returns `false`, §2.5 is already closed by Steam and the nonce window is pure belt-and-braces.
   Worth a 5-minute manual test during implementation.
3. **`__Host-` cookies over `http://localhost`** in the exact Playwright/Chromium version in use — verify
   empirically; fall back to an `APP_ENV`-selected cookie name if needed.
4. **OAC + `x-amz-content-sha256`** — worth a 30-minute spike before committing the CDK; if it fights
   back, take the secret-origin-header fallback in §6.3 without regret.
