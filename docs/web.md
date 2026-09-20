# Web — `packages/web` (SPA) and `e2e/` (Playwright)

Domain doc for the browser app and its end-to-end suite. `docs/decisions.md` is the source of
truth (sections 4, 10, 11, 13); this doc only expands it. The API's JSON shapes come from
`docs/control-plane.md`; auth/session details from `docs/auth.md`.

**Never redefine API types in `packages/web`.** Import them from the shared workspace package
(`packages/shared`, e.g. `WorldStatus`, `World`, `ActiveWorld`, `JoinInfo`, `WorldsResponse`,
`MeResponse` — use the names it actually exports). If a field you need is missing there, add it
to `packages/shared`, not to the web package.

## 1. Stack, setup, pinning

Vite + React 19 + TypeScript (strict) + Mantine 8 + TanStack Query v5. **No router** (two
screens driven by state). **No authored `.css` files** — layout comes only from Mantine
components and props (`Stack`, `Group`, `Container`, `gap`, `mt`, `fullWidth`, …). Inline
`style={{}}` for one-off wrapping is allowed; a stylesheet is not.

Dependencies (pin exactly these majors):

```
@mantine/core@^8.3.18  @mantine/hooks@^8.3.18  @mantine/notifications@^8.3.18
@tanstack/react-query@^5  @tabler/icons-react  react@19  react-dom@19
dev: vite  @vitejs/plugin-react  typescript  postcss  postcss-preset-mantine  postcss-simple-vars
```

Do **not** add `@mantine/modals` (plain `Modal` is enough) and do **not** install `@mantine/*`
without a version — npm `latest` is v9.

Setup steps (Mantine's Vite recipe): (1) `packages/web/postcss.config.cjs` with
`postcss-preset-mantine` and `postcss-simple-vars` defining `mantine-breakpoint-xs..xl`
(`36em/48em/62em/75em/88em`); (2) `src/main.tsx` imports `@mantine/core/styles.css` then
`@mantine/notifications/styles.css`, in that order; (3) providers, outermost first:
`<MantineProvider defaultColorScheme="dark">` → `<QueryClientProvider client={queryClient}>` →
`<Notifications position="top-center" />` → `<App />` (`Notifications` must be inside
`MantineProvider`); (4) no color-scheme toggle in v1 — dark is the default and only scheme.

### Mantine v9 APIs the implementer must NOT use

v9 shipped after the model cutoff and renamed props; we are on **v8**, so write v8 shapes:

| Write (v8, correct here) | Do not write (v9) |
|---|---|
| `<Grid gutter="md">` | `<Grid gap="md">` |
| `<Collapse in={open}>` | `<Collapse expanded={open}>` |
| `<Text c="dimmed">` (`c` works in v8 and v9) | `<Text color="dimmed">` (removed in v9, deprecated in v8) |

mantine.dev now documents v9 — use the versioned v8 docs (`https://v8.mantine.dev`) or the props
the installed `@mantine/core@8.x` types expose. If TypeScript rejects a prop, the doc page was v9.

## 2. File layout

```
packages/web/
  index.html                  <title>DST Server</title>, <meta name="viewport" content="width=device-width, initial-scale=1">
  vite.config.ts              react plugin, server.proxy for /api, build.outDir = 'dist'
  postcss.config.cjs
  src/main.tsx                providers + createRoot
  src/App.tsx                 screen switch: loading | signed-out | world list
  src/api/client.ts           apiGet / apiPost, ApiError
  src/api/queries.ts          useMe, useWorlds
  src/api/mutations.ts        useStartWorld, useStopWorld, useSignOut
  src/hooks/useCountdown.ts
  src/lib/format.ts           formatCountdown, playerCountLabel
  src/screens/SignedOutScreen.tsx
  src/screens/WorldListScreen.tsx
  src/components/AppHeader.tsx
  src/components/WorldCard.tsx
  src/components/StatusBadge.tsx
  src/components/JoinPanel.tsx
  src/components/CopyRow.tsx
  src/components/ConfirmStopModal.tsx
  src/components/ConfirmSwitchModal.tsx
```

Component tree when signed in:

```
AppShell
  AppShell.Header  -> AppHeader (title, nickname, Sign out button)
  AppShell.Main    -> Container size="xs" > Stack gap="md"
       JoinPanel (only when active && active.status !== 'stopped')
       WorldCard × n  (StatusBadge, Start/Stop Button)
       ConfirmStopModal / ConfirmSwitchModal (rendered once, at screen level)
```

## 3. Screens and states

**Loading** — while `useMe` is pending: `AppShell.Main` with three `<Skeleton height={96}
radius="md" />` in a `Stack`. No spinner-only screen.

**Signed out** — `useMe` returned 401. `Center` + `Stack` inside `Container size="xs"`:
`Title order={1}` "DST Server", `Text c="dimmed"` "Sign in to start a world.", then
`<Button component="a" href="/api/auth/steam/login" size="lg" fullWidth>Sign in with Steam</Button>`
(role **link**, accessible name **"Sign in with Steam"**; a real navigation, never fetch).
On mount read `new URLSearchParams(location.search).get('error')` once, then
`history.replaceState({}, '', '/')` so a refresh clears it. Above the button render an
`<Alert color="red" title="Can't sign in">` with:

- `error === 'not-allowed'` → "That Steam account isn't on the allowlist. Ask the server owner to add you."
- any other non-empty value → "Sign-in didn't work. Please try again."

**World list** — `useMe` succeeded. Header: `Title order={1} size="h4"` "DST Server",
`Text` with the nickname, `Button variant="subtle" size="compact-sm"` named **"Sign out"**.

### WorldCard

`<Card component="article" aria-label={world.displayName} withBorder radius="md" padding="md">`
(role **article**, name = display name — always scope card queries to it).

- `Title order={3}` = `world.displayName`.
- `StatusBadge`: `<Badge color={...}>` with exact text **Stopped / Starting / Running /
  Stopping**. Colors `gray / yellow / green / orange`. Status is always readable as text —
  never encode status in color alone.
- When `active.stale` is true and this is the active world, a second line
  `<Text size="sm" c="orange">Not responding — check back in a minute.</Text>`.
- Action `Button fullWidth size="md"`, accessible name exactly **"Start"** or **"Stop"**:
  - derived status `stopped` → "Start" (`color="green"`).
  - derived status `running` → "Stop" (`color="red"`).
  - derived status `starting` or `stopping` → the matching button with `disabled` and
    `loading` (Mantine `loading` already disables; set both so the disabled state is explicit).
  - while a start/stop mutation for this world is in flight → `loading`.
  - every other card's button is disabled while any mutation is in flight.

Derived per-world status (decisions §6): `active && active.worldId === world.worldId ?
active.status : 'stopped'`.

### JoinPanel (active world)

`<Paper component="section" aria-labelledby="join-heading" withBorder p="md">` with
`<Title order={2} size="h4" id="join-heading">How to join</Title>` → role **region**, name
**"How to join"**.

While `status === 'starting'`: `Group` of `<Loader size="sm" />` and
`<Text>Starting the server. Usually about 3 minutes.</Text>`. No join details yet.

While `status === 'running'` (`active.join` present):

- `CopyRow` "Server name" → `join.serverName`, copy button **"Copy server name"**.
- `CopyRow` "Address" → `` `${join.ip}:${join.port}` ``, copy button **"Copy server address"**.
- `CopyRow` "Password" → `join.password`, copy button **"Copy password"**. Shown as text, not
  masked (decisions §1: show the password in the UI).
- `CopyRow` "Console command" → `<Code block>{join.connectCommand}</Code>`, copy button
  **"Copy console command"**. Wrap with `style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}`.
- `<List type="ordered" size="sm">`: "Open Don't Starve Together and click Browse Games." /
  "Search for the server name above." / "Click Join and enter the password." Then `<Text
  size="sm" c="dimmed">Or press the backtick key in game and paste the console command.</Text>`
- Player count `<Text data-testid="player-count">`: `null` → "Player count unavailable";
  `0` → "No players online yet"; `1` → "1 player online"; `n` → "n players online".
- `<Text size="sm" c="dimmed">Started by {active.startedBy}</Text>` (nickname, never a SteamID).
- Countdown `<Text size="sm" data-testid="idle-countdown">` (no `aria-live` — it ticks every
  second):
  - `playerCount > 0` → "Auto-stops once everyone has left."
  - otherwise, with `idleDeadline` → `Stops in {mm:ss} if nobody is playing`
    (e.g. "Stops in 27:14 if nobody is playing").
  - countdown reached zero → "Stopping soon…".
  - no `idleDeadline` → render nothing.

### Modals

Both use `<Modal opened onClose title={…} centered>` (role **dialog**, accessible name = title).

- **Stop**: title `Stop {displayName}?`. Body: "The world is saved before it stops." Plus, when
  `playerCount > 0`: `<Alert color="yellow">{n} player(s) still online — they'll be disconnected.</Alert>`
  Buttons: **"Cancel"** (`variant="default"`) and **"Stop world"** (`color="red"`).
- **Switch** (Start B while A is `starting`/`running`/`stopping`): title `Switch to {B.displayName}?`.
  Body: "{A.displayName} will be saved and stopped first, then {B.displayName} starts on the same
  server. This takes a few minutes." Same player warning Alert when A has players. Buttons:
  **"Cancel"** and **"Save and switch"**.

Starting a world while everything is `stopped` needs no confirmation.

## 4. Data layer

`src/api/client.ts`:

```ts
// No fetch in this app ever sends a request body. Bodyless POSTs avoid the
// CloudFront OAC x-amz-content-sha256 body-hash requirement (decisions.md §10).
// If you ever need to send data, read that section first — do not add a body here.
export async function apiPost(path: string): Promise<Response>
```

- `apiGet(path)`: `fetch(path, { credentials: 'same-origin', headers: { Accept: 'application/json' } })`.
- `apiPost(path)`: `fetch(path, { method: 'POST', credentials: 'same-origin', headers:
  { 'X-DST-Request': '1' } })` — **no `body`, no `Content-Type`**.
- Non-2xx → throw `ApiError { status, code? }`. 401 never throws a notification; callers handle it.

Queries (`queryClient` defaults: `retry: 1`, `refetchOnWindowFocus: true`):

- `useMe()` — `queryKey: ['me']`, `GET /api/me`. 401 → resolve to `null` (signed out) instead of
  throwing, so `App` can branch on `data === null`. `staleTime: 60_000`.
- `useWorlds()` — `queryKey: ['worlds']`, `GET /api/worlds`, `enabled: me != null`.
  ```ts
  refetchInterval: (query) => {
    const s = query.state.data?.active?.status;
    return s && s !== 'stopped' ? 5_000 : 30_000;   // decisions.md §11
  },
  refetchIntervalInBackground: false,               // paused while the tab is hidden
  ```
  A 401 from this query clears `['me']` (`queryClient.setQueryData(['me'], null)`) → signed-out screen.

Mutations (`src/api/mutations.ts`), all bodyless POSTs:

- `useStartWorld()` → `POST /api/worlds/{id}/start`; `useStopWorld()` → `.../stop`;
  `useSignOut()` → `POST /api/auth/logout`, then `queryClient.clear()` and
  `setQueryData(['me'], null)`.
- `onMutate`: `await queryClient.cancelQueries({ queryKey: ['worlds'] })`, snapshot, then
  optimistically `setQueryData(['worlds'], …)` with `active.status` = `'starting'` (start,
  `worldId` = target) or `'stopping'` (stop). Ignore the POST response body; only the status
  code matters.
- `onError`: roll back to the snapshot, then map:
  - `401` → `setQueryData(['me'], null)` (signed-out screen), no notification.
  - `403` → `notifications.show({ color: 'red', title: 'Not allowed', message: "Your account isn't on the allowlist anymore." })`.
  - `409` → `notifications.show({ color: 'yellow', title: 'Server busy', message: 'Another world is already starting. Try again in a moment.' })`.
  - anything else / network → `notifications.show({ color: 'red', title: "That didn't work", message: 'Try again in a moment.' })`.
- `onSettled`: `queryClient.invalidateQueries({ queryKey: ['worlds'] })`.

`useCountdown(deadlineIso: string | null | undefined)`: `setInterval` of 1000 ms (cleared on
unmount and when the deadline changes), returns
`{ totalSeconds, label, expired }` where `totalSeconds = max(0, round((Date.parse(deadline) - Date.now()) / 1000))`.
`formatCountdown` → `m:ss` under an hour (`27:14`), `h:mm:ss` at or above it. No date library.

## 5. Phone-first layout and accessibility

- Single column everywhere: `Container size="xs"` + `Stack gap="md"`. No `Grid`, no side-by-side
  cards — do not add a desktop-only layout.
- `AppShell header={{ height: 56 }} padding="md"`; header content in a `Group justify="space-between"`.
- Tap targets: action `Button size="md"` with `fullWidth`; the sign-in `Button size="lg"`; every
  `ActionIcon` (copy buttons) `size="xl" variant="subtle"` so it clears 44 px.
- Nothing may overflow horizontally: long values (IP, password, console command) wrap via
  `style={{ wordBreak: 'break-all' }}`; `CopyRow` is a `Group wrap="nowrap"` with the value in a
  `Box style={{ minWidth: 0, flex: 1 }}`.
- Every interactive element has an accessible name (the exact strings above). `ActionIcon`s get
  `aria-label` that flips with copy state: `aria-label={copied ? 'Copied server address' : 'Copy server address'}`.
- Status is text first: badge text, the stale hint and the countdown are all readable strings;
  color is decoration only.
- Headings are ordered: `h1` app title, `h2` "How to join", `h3` world names.

## 6. Local development

`vite.config.ts`:

```ts
server: { port: 5173, proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: false } } }
```

`changeOrigin: false` is required: the API's CSRF check compares `Origin` with `PUBLIC_ORIGIN`,
which is `http://localhost:5173` locally.

Root `pnpm dev` runs both in parallel: the local API (`packages/api` local entrypoint, `DST_ENV=local`,
`PORT=8787`, in-memory fakes per decisions §10) and `vite dev`.

**Dev sign-in.** The local server entrypoint (`packages/api/src/local/server.ts` — the file the
Lambda bundle never imports) registers `GET /api/dev/login`, which mints a session cookie for a
fake allowlisted user and 302s to `/`. Guards, all three required:

(1) it is registered only in the local entrypoint, which the Lambda handler module never imports,
so it cannot be bundled into `dst-server-manager-api`; (2) the handler asserts `env === 'local'`
at registration time and throws otherwise; (3) the nickname/SteamID it uses are fakes defined in
code (`dev-user`, `"Dev"`), never a real one.

Developers sign in by visiting `http://localhost:5173/api/dev/login` directly. The UI never links
to it — no dev-only element is rendered in the SPA.

## 7. Playwright (`e2e/`)

```
e2e/playwright.config.ts
e2e/support/session.ts     mintTestSession() — imports the signer from packages/api, never reimplements it
e2e/support/control.ts     setState(), reset(), failNext()
e2e/support/fixtures.ts    `test` extended with a signed-in context
e2e/tests/*.spec.ts
```

Config: `testDir: 'tests'`, `use: { baseURL: 'http://localhost:5173', permissions:
['clipboard-read', 'clipboard-write'] }`, `webServer: [ { command: local API with
`DST_ENV=test`, port 8787 }, { command: `pnpm --filter @dst/web dev`, port 5173 } ]`,
`reuseExistingServer: !process.env.CI`. Two projects, both chromium:
`phone` (`{ ...devices['Pixel 5'] }`) and `desktop` (viewport 1280×800). Every spec runs in both.

**Auth.** Per decisions §9 and `docs/auth.md`: with `env=test` the API derives its session key
from a test-only secret (env var, set by the config for both the API and the test process).
`mintTestSession(nickname)` builds `v1.test.<payload>.<hmac>` with that secret; the fixture adds
cookie `{ name: 'dst_session', value, domain: 'localhost', path: '/', httpOnly: true, secure: false }`
to the browser context. A production verifier rejects this token by env and by key derivation.
Never hard-code a real SteamID64 — tests use an obviously fake 17-digit constant defined in
`e2e/support/session.ts`.

**Controlling the fakes.** The local entrypoint (same file, same three guards, `env` must be
`test` or `local`) exposes `POST /api/test/control`, exempt from the session and CSRF checks,
accepting JSON:

```jsonc
{ "reset": true }                                   // back to: two worlds, everything stopped
{ "state": { "status": "running", "worldId": "test-a", "playerCount": 2,
             "idleDeadlineInSeconds": 1814 } }      // patch the cluster state item
{ "heartbeatAgeSeconds": 300 }                      // -> API marks stale: true
{ "failNext": { "route": "start", "status": 409 } } // one-shot forced error
{ "bootMs": 1000 }                                  // fake launcher starting -> running delay
```

`control.ts` wraps these with Playwright's `request` fixture. Every spec calls `reset()` in
`beforeEach`. Test worlds use the reserved `test-` id prefix (decisions §3).

### Scenarios (each numbered spec is one `test`)

1. **Signed-out screen** — no cookie, open `/`: link "Sign in with Steam" is visible and its
   `href` is `/api/auth/steam/login`; no world `article` is present.
2. **Not-allowed message** — open `/?error=not-allowed`: alert text "That Steam account isn't on
   the allowlist. Ask the server owner to add you." is visible; after a reload of `/` it is gone.
3. **List renders** — signed in, everything stopped: both world `article`s visible, each with a
   badge "Stopped" and an enabled "Start" button; header shows the nickname.
4. **Start → starting → running** — `bootMs: 1000`, click "Start" on world A: badge becomes
   "Starting", the button is disabled, region "How to join" shows "Starting the server. Usually
   about 3 minutes."; then (`expect` with a generous timeout) badge "Running", server name, the
   address, the password and the console command are visible; clicking "Copy server address"
   flips its accessible name to "Copied server address" and `navigator.clipboard.readText()`
   equals `ip:port`.
5. **Countdown ticks** — force `running` with `idleDeadlineInSeconds: 95` and `playerCount: 0`:
   `[data-testid="idle-countdown"]` matches `/Stops in 1:3\d if nobody is playing/`, and after
   ~3 s the parsed seconds are strictly smaller. Then set `playerCount: 2` and assert the text is
   "Auto-stops once everyone has left." and "2 players online" is shown.
6. **Stop with confirmation** — force `running`, click "Stop": dialog named "Stop {name}?" opens;
   "Cancel" closes it with status unchanged; reopen and click "Stop world" → badge "Stopping".
7. **Switch confirmation** — force A `running` with 2 players, click "Start" on B: dialog
   "Switch to {B}?" contains "will be saved and stopped first" and the player warning; "Save and
   switch" closes it and a start request for B is accepted (badge for A becomes "Stopping" or B
   becomes "Starting", depending on the fake's timing — assert on the dialog closing and on a
   `worlds` refetch, not on an exact intermediate status).
8. **Busy 409** — `failNext: { route: 'start', status: 409 }`, click "Start": a notification with
   "Another world is already starting. Try again in a moment." appears and the badge is back to
   "Stopped" (optimistic update rolled back).
9. **Stale hint** — force `running` with `heartbeatAgeSeconds: 300`: the active card shows
   "Not responding — check back in a minute." and the badge still reads "Running".
10. **Sign out** — click "Sign out": the signed-out screen appears (link "Sign in with Steam"),
    and a reload keeps it signed out (cookie cleared).
11. **No horizontal scroll (phone project)** — on the running state with the longest strings,
    assert `document.documentElement.scrollWidth <= window.innerWidth + 1` and that the console
    command element's `scrollWidth` fits its client width.

Prefer `getByRole`/`getByLabel` with the exact names above; `data-testid` only for the two
dynamic readouts (`idle-countdown`, `player-count`).

## 8. Build output and deploy contract

- `pnpm --filter @dst/web build` → `vite build` → **`packages/web/dist`** (`build.outDir: 'dist'`,
  `base: '/'`, `build.sourcemap: false`). The CI workflow builds before `cdk deploy DstWeb`
  (decisions §12), and `DstWeb` deploys that directory into the site bucket.
- **No SPA fallback needed** — there is no router, every navigation targets `/` or `/api/*`.
  Do not add a 404→`index.html` CloudFront function beyond what serving `index.html` as the
  default root object already gives.
- Cache-control expectations for `docs/infra.md`:
  - `index.html` → `no-cache` (or `max-age=0, must-revalidate`); invalidate `/index.html` (or
    `/*`) on deploy.
  - `/assets/*` (Vite's content-hashed files) → `public, max-age=31536000, immutable`; never
    invalidated.
  - `/api/*` uses `CachingDisabled`; the site origin's caching never applies to it.
