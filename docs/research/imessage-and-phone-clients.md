# iMessage apps and phone clients — research

Date: 2026-09-21. Question asked: *"Can I make an iMessage app for this? For users with an iPhone,
can I start/stop the server via iMessage — or just a test message or something. If it's
complicated, forget about it."*

Nothing was built. This file exists so the question does not get re-researched from scratch: it
records what the codebase already supports, what Apple's platform actually permits, and which of
the two is the real constraint. Read-only history, like everything in `docs/research/`.

**Verdict: the iMessage app is not worth it, and the reason is distribution, not difficulty. But
the interesting half of the answer is that a phone client needs no new API code at all** — the
control plane is already callable from a non-browser client, by deliberate design. The wall is
credential provisioning, and it only blocks *friends*, not the owner.

## The short answer, as a table

| Option | New code | Works for | Real cost | Verdict |
|---|---|---|---|---|
| **iOS Shortcut, owner-only** | none | Tyler | ~15 min, re-paste a cookie every 30 days | **Do this if you want it.** Start/stop from the Home Screen or Siri, no browser |
| **Home-screen web app polish** | `index.html` meta + icon + manifest | everyone allowlisted | ~half a day incl. the cache-control trap in §5 | Reasonable, cosmetic-plus (unlocks Web Push, §4.3) |
| **Static link-preview card** | `og:` meta + one image | everyone | ~an hour | Cheap, but the card can never show live status (§4.4) |
| **Shortcut for friends** | new non-cookie auth path | everyone allowlisted | new auth surface on a public repo, multi-session | Only if the goal is really "friends start it from a phone without the site" |
| **Real iMessage app** | Xcode/Swift project | anyone who installs it | $99/yr forever + App Store review or 90-day TestFlight re-uploads | **No.** §3 |
| **iMessage bot** | — | — | — | **Impossible.** Apple ships no such API. §3.3 |

## 1. The API is already a non-browser client surface, with zero changes

This was the surprise, and it falls out of two decisions made for unrelated reasons.

**Every mutation is a bodyless POST with the target in the path.** `POST /api/worlds/{worldId}/start`
and `.../stop` take no request body at all (`packages/api/src/router.ts:116-146`). That was forced
by the CloudFront-OAC signature rule, not by any thought of third-party clients — a POST *with* a
body and no `x-amz-content-sha256` is rejected 403 `InvalidSignatureException`, while a bodyless
POST is signed against the empty-string hash and passes (`docs/spikes/cloudfront-oac-lambda-url.md`
tests b/c/d). The constraint is recorded in the web client as a standing warning:

```ts
// packages/web/src/api/client.ts:47-49
// No fetch in this app ever sends a request body. Bodyless POSTs avoid the
// CloudFront OAC x-amz-content-sha256 body-hash requirement (decisions.md §10).
// If you ever need to send data, read that section first — do not add a body here.
```

The side effect is that a third-party client needs no request signing, no body hashing, and no SDK.

**The CSRF check is two header comparisons, and both headers are settable outside a browser.**

```ts
// packages/api/src/router.ts:102-104
function csrfOk(event: HttpRequest, publicOrigin: string): boolean {
  return event.headers['origin'] === publicOrigin && event.headers['x-dst-request'] === '1';
}
```

`Origin` is a [forbidden header name](https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_header_name)
that browser `fetch` refuses to set — which is exactly what makes it a valid CSRF defense — but any
non-browser HTTP client sets it freely. **This is a browser-CSRF control, not an authorization
barrier, and should not be mistaken for one.** Authorization is the session cookie and the
allowlist, checked independently (`packages/api/src/auth/requireUser.ts:18-37`).

So this works today against the live stack, unchanged:

```bash
curl -X POST https://dst.ty.ler.dev/api/worlds/<world-id>/start \
  -H 'Cookie: __Host-dst_session=<minted token — never commit a real one>' \
  -H 'Origin: https://dst.ty.ler.dev' \
  -H 'X-DST-Request: 1'
```

**The repo already does precisely this.** `scripts/lifecycle-test.ts:413-421` drives the real
CloudFront endpoint with the same three headers on every one of its 44 assertions:

```ts
const res = await fetch(`${ORIGIN}${urlPath}`, {
  method,
  headers: { Cookie: cookie, Origin: ORIGIN, 'X-DST-Request': '1' },
});
```

Anything that can issue an HTTP request with custom headers — an iOS Shortcut, a cron job, a
Discord bot, `curl` — is therefore a complete client. Start/stop return the full `WorldsResponse`
directly, so no follow-up poll is needed to render the result (`docs/control-plane.md:587`).

## 2. Credentials are the wall

There is **no bearer token, API key, or query-parameter auth path anywhere.** `requireUser` reads
the cookie and nothing else:

```ts
// packages/api/src/auth/requireUser.ts:18
const token = extractCookieValue(candidateCookieStrings(event), sessionCookieName(appEnv));
if (token === null) return { ok: false, status: 401, code: 'unauthorized' };
```

A grep of `packages/api/src`, `scripts/` and `e2e/` for `bearer|authorization|api[_-]key|access[_-]token`
returns nothing. The cookie is `__Host-dst_session` in prod (`packages/api/src/auth/cookies.ts:10-12`),
`Max-Age=2592000` — 30 days, no sliding refresh (`cookies.ts:28-33`).

Minting one out-of-band is a supported, documented operation — `scripts/mint-cookie.ts` exists for
exactly this and prints one ready-to-paste `Cookie:` header line. **But it requires
`AWS_PROFILE=admin`** (`scripts/mint-cookie.ts:62-65`) because it reads the SecureString
`/dst/session-secret`. That single fact decides the whole design space:

- **For Tyler**, a Shortcut is trivial: mint once on the laptop, paste into the Shortcut, works for
  30 days.
- **For a friend**, it is a non-starter. They have no AWS credentials. Handing them *your* minted
  cookie would share your credential and mis-attribute every start — the allowlist nickname is what
  gets written as `startedBy` (`packages/api/src/auth/requireUser.ts:36`).
- There is no revocation for a leaked cookie short of rotating `/dst/session-secret` (invalidating
  everyone) or removing the SteamID64 from `/dst/users`, which takes effect within the 60 s
  allowlist cache (`ALLOWLIST_TTL_MS`, `packages/api/src/auth/constants.ts:37`).

Also worth stating plainly for whoever reads this next: there is **no WAF, no rate limiting and no
IP allowlist** on the `/api/*` behavior. That is fine for a cookie only Tyler can mint. It is a
different risk conversation if a long-lived token is ever handed to five other people.

## 3. What an iMessage app actually entails

### 3.1 Correcting two things that are commonly assumed

- A **standalone iMessage app does not need a containing iOS app.** Since iOS 10, an iMessage app
  can ship on its own to the iMessage App Store; bundling it with a regular app is optional.
  (Earlier assumption in this project's discussion was wrong.)
- The app itself would be small — `MSMessagesAppViewController` plus three HTTP calls. **Writing it
  is not the problem.**

### 3.2 The problems are recurring cost, distribution, and a second auth implementation

| Constraint | Detail |
|---|---|
| **$99/year, forever** | Apple Developer Program, individual or organization. Verified current as of 2026-09. |
| **No fee waiver** | Apple's waiver covers *nonprofits, accredited educational institutions, and government entities* only. Individuals and sole proprietors are **categorically ineligible, even if every app is free** — a widely repeated claim to the contrary is false. |
| **App Store route** | A public App Store listing, and review, for an app whose sole function is booting one person's game server. |
| **TestFlight route** | Builds **expire 90 days from upload** — a fresh build roughly 4×/year in perpetuity or friends are locked out. Every build for *external* testers must clear Beta App Review first (internal testers must be App Store Connect users on your team). |
| **Ad-hoc route** | Collect each friend's device UDID, re-provision on device changes. |
| **Auth rebuild** | An iMessage extension gets no access to Safari's cookie jar, so the Steam OpenID flow of `docs/auth.md` would be re-implemented in Swift behind a web view, with its own session storage. This is the largest hidden cost. |

Against that: friends can already reach `https://dst.ty.ler.dev` in mobile Safari, where the site is
phone-first by design and CI-tested at phone viewport (`docs/web.md` §5;
`e2e/tests/11-no-horizontal-scroll.spec.ts:31-34` asserts no horizontal overflow on every spec in
the `phone` project). The app would replace a working button with an install step.

### 3.3 An iMessage *bot* is not possible at all

Distinct from an iMessage *app*, and worth recording so it is never re-investigated:

- Apple exposes **no public API for sending or receiving iMessages programmatically.** There is no
  webhook, no bot token, nothing equivalent to the Discord or Telegram bot APIs.
- **Apple Messages for Business** is the only sanctioned inbound-message channel, and it is built
  for companies: registration requires a legal entity (corporation/LLC — sole proprietorships are
  refused), an approved **brand** with logos and colors, an administrator, a technical contact and a
  sponsoring executive, plus in practice a Messaging Service Provider. Not available to a person
  with a game server.
- The only remaining trick is an **always-on Mac** polling `~/Library/Messages/chat.db` and driving
  Messages.app via AppleScript/JXA. This **breaks the project's scale-to-zero invariant**
  (`CLAUDE.md`: "No NAT gateway, ALB, idle Elastic IP, RDS, persistent EBS, or anything always-on"),
  is fragile across OS updates, needs Full Disk Access, and would cost more in electricity than the
  ~$0.10/month the whole system currently costs at idle. Rejected.

**If the real goal is "start the world from a group chat," the answer is a different chat platform.**
Discord and Telegram both have first-class bot APIs, and per §1 the bot would be a thin HTTP shim —
the hard part would still be §2, deciding what credential the bot holds and who may command it.

## 4. What iOS actually offers instead

### 4.1 Shortcuts — the real answer for the owner

The Shortcuts **Get Contents of URL** action supports method selection (GET/POST/PUT/PATCH/DELETE)
and arbitrary custom request headers, which is everything §1 requires. Shape:

```
Get Contents of URL
  URL:     https://dst.ty.ler.dev/api/worlds/<world-id>/start
  Method:  POST
  Headers: Cookie         __Host-dst_session=<minted token>
           Origin         https://dst.ty.ler.dev
           X-DST-Request  1
Get Dictionary Value   active.status     (from WorldsResponse)
Show Notification
```

Runs from the Home Screen, the Share sheet, Siri, or a Back Tap. A status-check variant is the same
with `GET /api/worlds` and no CSRF headers needed (`GET` routes are not CSRF-checked —
`packages/api/src/router.ts:176-199`).

Shortcuts are shareable by iCloud link — but sharing *this* one shares the embedded cookie, so it
stays owner-only (§2).

Polling shape if a Shortcut ever waits for joinable: "joinable" is not a status. It is
`status === 'running' && active.join !== null` (`packages/shared/src/derive.ts:47-49, 82-84`).
Expect 142-333 s click-to-joinable per the measured timings in `CLAUDE.md`.

### 4.2 Home-screen web app

As of **iOS 26, any site added to the Home Screen opens as a web app by default, even with no
manifest** — so the "feels like an app" part is already available today with no repo change. A
manifest and `apple-touch-icon` still control the icon and name (today `packages/web/index.html` is
12 lines with neither, so iOS derives a screenshot icon).

### 4.3 Web Push — the one genuinely new capability

Since iOS 16.4, Web Push works on iOS, but **only for web apps added to the Home Screen**, never in
the Safari tab, and it requires a Web Application Manifest plus a user-gesture permission prompt.
This is the only option in this whole document that would do something the current system cannot:
**notify a friend's phone when the world became joinable**, instead of making them watch the page
for ~3 minutes. It needs a service worker, a manifest, VAPID keys, and somewhere to store
subscriptions — non-trivial, and currently nothing in the repo stores per-user state at all.

### 4.4 Link previews are static, and cannot show live status

Pasting `https://dst.ty.ler.dev` into a chat renders a bare URL today because `index.html` carries
no Open Graph tags. Adding them is an hour. But the card would be **permanently static** — the site
is S3 + CloudFront with no server-side rendering of `index.html`, and iMessage generates the preview
on the *sender's* device at send time and caches it. A card reading "joinable, 3 players" is not
achievable without a rendering endpoint, and even then would be stale on arrival. Assume
"DST Server — start a world" and nothing more.

## 5. Repo-side traps for anything that adds a file to the web bundle

Recorded because it would cost a debugging round otherwise. `packages/infra/lib/web-stack.ts:337-350`
splits the site into **two** `BucketDeployment`s:

```ts
new s3deploy.BucketDeployment(this, 'SiteAssets', {   // everything EXCEPT index.html
  cacheControl: [s3deploy.CacheControl.fromString('public, max-age=31536000, immutable')],
});
new s3deploy.BucketDeployment(this, 'SiteIndex', {    // index.html alone
  cacheControl: [s3deploy.CacheControl.fromString('no-cache, no-store, must-revalidate')],
  distribution: dist, distributionPaths: ['/', '/index.html'],
});
```

A new `manifest.webmanifest`, `sw.js`, or `apple-touch-icon.png` emitted at the dist root lands in
the **immutable one-year** half, and only `/` and `/index.html` are invalidated on deploy. A service
worker cached for a year is a genuinely bad outcome. Any such change must adjust this split.

Also: the CSP is `default-src 'self'; script-src 'self'; …` with no `manifest-src` directive
(`docs/auth.md:476`, applied via `SPA_CSP` at `web-stack.ts:265-281`). `manifest-src` falls back to
`default-src 'self'`, so a same-origin manifest and service worker are allowed as-is — but a
cross-origin push endpoint or icon would not be.

## 6. Recommendation

1. **Do not build an iMessage app.** Recurring $99/year plus a distribution treadmill plus a
   from-scratch Steam OpenID implementation in Swift, to replace a button on a page that already
   works on their phones.
2. **If you want phone control for yourself, build the Shortcut** — no repo change, ~15 minutes,
   using `scripts/mint-cookie.ts`. Re-paste the cookie monthly.
3. **If friends are the point**, the honest options are ranked: (a) they use the site, which works;
   (b) Web Push (§4.3) so they get told when it is up rather than starting it from a phone;
   (c) a Discord bot; (d) a token auth path (§2), which is the largest change and the one that most
   deserves its own `docs/decisions.md` section before any code.

## 7. Confidence and open questions

- **High confidence, verified in-repo:** everything in §1, §2 and §5 — each claim is a quoted line
  from a file at a named path, re-read on 2026-09-21.
- **High confidence, verified against live sources on 2026-09-21:** the $99 fee, the waiver
  exclusion of individuals, the 90-day TestFlight expiry, Beta App Review for external testers,
  Messages for Business's entity requirements, Shortcuts' custom-header support, and Web Push
  requiring a Home Screen install.
- **Not verified, and irrelevant here:** one source claims Web Push is unavailable in EU countries
  on iOS 17.4+. Apple reversed a related EU home-screen-web-app removal in March 2024 and the claim
  looks stale; it was not chased because every user of this system is US-based. Re-check before
  relying on Web Push for an EU user.
- **Not investigated:** whether an iMessage app could avoid re-implementing Steam OpenID by
  deep-linking to Safari for sign-in and sharing a session some other way. Irrelevant unless
  recommendation 1 is reversed.
- **Deliberately unexplored:** the shape of a token auth path (§2 / §6.3d). It is a real design
  task — issuance, storage, hashing, scope, revocation, rate limiting — not a patch, and this
  research made no attempt at it.

## Sources

Live sources, fetched 2026-09-21:

- [Apple Developer Program — Membership Details](https://developer.apple.com/programs/whats-included/) — $99/year
- [Apple Developer Program Fee Waiver eligibility](https://developer.apple.com/help/account/membership/fee-waivers/) — nonprofits/education/government only; individuals and sole proprietors excluded
- [MSMessagesAppViewController — Apple Developer Documentation](https://developer.apple.com/documentation/messages/msmessagesappviewcontroller)
- [Apple Messages for Business — Register your account](https://register.apple.com/resources/messages/messaging-documentation/register-your-acct) and [MSP onboarding](https://register.apple.com/resources/messages/msp-onboarding/mspRegistration) — brand/entity/role requirements
- [Request your first API in Shortcuts — Apple Support](https://support.apple.com/guide/shortcuts/request-your-first-api-apd58d46713f/ios) and [Get Contents of URL — Matthew Cassinelli](https://matthewcassinelli.com/actions/get-contents-of-url/) — method + custom headers
- [Web Push for Web Apps on iOS and iPadOS — WebKit](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/) — Home Screen requirement, manifest, user gesture
- [Do Progressive Web Apps Work on iOS? (2026) — MobiLoud](https://www.mobiloud.com/blog/progressive-web-apps-ios/) — iOS 26 Home Screen web-app default
- [TestFlight Distribution Guide](https://techconcepts.org/blog/testflight-guide) and [iOS Versions, Builds, and TestFlight in App Store Connect (2026)](https://appconsul.com/guides/manage-app-versions-builds-testflight/) — 90-day expiry, Beta App Review, tester limits
- [Forbidden header name — MDN](https://developer.mozilla.org/en-US/docs/Glossary/Forbidden_header_name) — why `Origin` is browser-only

In-repo evidence: `packages/api/src/router.ts`, `packages/api/src/auth/{requireUser,cookies,constants}.ts`,
`packages/web/src/api/client.ts`, `packages/web/index.html`, `packages/infra/lib/web-stack.ts`,
`scripts/{mint-cookie,lifecycle-test}.ts`, `docs/spikes/cloudfront-oac-lambda-url.md`,
`docs/auth.md`, `docs/web.md`, `docs/control-plane.md`.
