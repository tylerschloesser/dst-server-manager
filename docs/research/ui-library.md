# UI component library research — DST server control panel

Date: 2026-09-19. Researched for a small (~2 screen) Vite + React 19 + TypeScript SPA, pnpm monorepo, node 22, used mostly from phones by ~6 friends. Code will be written by Claude Sonnet agents from a plan and tested with Playwright. Owner's constraint: "I don't want to write CSS."

All version numbers below were pulled live from the npm registry and vendor docs on 2026-09-19, not from memory (see per-row sources). Registry dist-tag `latest` was checked with `npm view <pkg> version` / `dist-tags` / `time`.

## Why "LLM-friendliness" needs its own axis this time

Claude Sonnet 5's knowledge cutoff is January 2026. Several of these libraries shipped a new major *after* that cutoff, so a coding agent's training-data instincts will target the **previous** major even though npm's `latest` tag now points at the newer one. That mismatch is a real source of bugs (wrong prop names, removed APIs, wrong install commands) independent of how "stable" the library's API generally is. I checked release dates for exactly this reason.

| Library | Major version | Released | Before or after Jan 2026 cutoff? |
|---|---|---|---|
| Mantine v8 | 8.0.0 | 2025-05-05 | Before — well represented |
| Mantine v9 | 9.0.0 | 2026-03-31 | **After** — agent will likely write v8-shaped code (`Grid gutter=`, `Collapse in=`, `Text color=`, etc. — all renamed in v9) |
| MUI v6 | 6.0.0 | 2024-08-27 | Before — well represented |
| MUI v7 | 7.0.0 | 2025-03-26 | Before — well represented (Grid v2 stabilized, GridLegacy deprecated) |
| MUI v9 (v8 was skipped to resync with MUI X) | 9.0.0 | 2026-04-07 | **After** — agent will likely default to v6/v7 `Grid` patterns, still functional but not idiomatic v9 |
| Chakra UI v3 | 3.0.0 | 2024-10-22 | Before — well represented, though v2→v3 was a full rewrite (removed Emotion/framer-motion, namespaced components, new styling engine) so *pre-2024* training data actively conflicts with v3 |
| Ant Design v6 | 6.0.0 | 2025-11-21 | **Right at the edge (~6 weeks before cutoff)** — thin representation; v5 (React 16-18 by default, needs `@ant-design/v5-patch-for-react-19` shim) is what most training data reflects |
| Radix Themes v3 | 3.0.0 | 2024-03-23 | Before, by 22 months, **and still current** — no v4 as of 2026-09. This is the most stable API of the group |
| HeroUI (ex-NextUI) v3 | 3.0.0 | 2026-03-21 | **After**, and a ground-up rewrite (drops the old `NextUIProvider`, moves to Tailwind v4 + React Aria) — an agent will confidently write v2/NextUI-shaped code that breaks on v3 |
| daisyUI v5 | 5.0.0 | 2025-02-28 | Before — well represented |
| shadcn/ui CLI v2 / Tailwind v4 flow | "CLI v4" changelog | 2026-03 | **After** — agent will likely scaffold Tailwind v3 config + old CLI flags |

Sources: [Mantine changelog 8.0.0](https://mantine.dev/changelog/8-0-0/), [Mantine changelog 9.0.0](https://mantine.dev/changelog/9-0-0/), [Mantine all releases](https://mantine.dev/changelog/all-releases/), [MUI upgrade to v6](https://mui.com/material-ui/migration/upgrade-to-v6/), [MUI Grid v2 migration](https://mui.com/material-ui/migration/upgrade-to-grid-v2/), [Introducing MUI v9](https://mui.com/blog/introducing-mui-v9/), [Chakra v3 announcement](https://chakra-ui.com/blog/announcing-v3), [Ant Design v6 migration](https://ant.design/docs/react/migration-v6/), [antd v5-for-19 patch](https://github.com/ant-design/v5-patch-for-react-19), [Radix Themes releases](https://www.radix-ui.com/themes/docs/overview/releases), [HeroUI v3 rewrite — InfoQ](https://www.infoq.com/news/2026/07/heroui-v3-rewrite/), [daisyUI 5 release notes](https://daisyui.com/docs/v5/), [shadcn CLI v4 changelog](https://ui.shadcn.com/docs/changelog/2026-03-cli-v4), npm registry `time` data for each package.

## Comparison table

| | Current major (npm `latest`, 2026-09-19) | Cadence / maintenance | React 19 | Vite setup | Zero-CSS for our screens | Mobile/responsive OOTB | Bundle weight (rough) | Accessibility | LLM-friendliness |
|---|---|---|---|---|---|---|---|---|---|
| **Mantine** | `@mantine/core@9.6.1` (recommend pinning `^8.3.18`, still patched, 39 releases in 8.x line) | Very active, ~monthly minors, single maintainer-led OSS project, 7+ years, huge changelog discipline | Yes, v8 and v9 both support React 19 ([discussion #6323](https://github.com/orgs/mantinedev/discussions/6323)) | `@mantine/core @mantine/hooks` + `postcss postcss-preset-mantine postcss-simple-vars`, one `postcss.config.cjs`, wrap in `<MantineProvider>`, import `@mantine/core/styles.css` ([official Vite guide](https://mantine.dev/guides/vite/)) | Yes — `Stack`/`Group`/`Grid`/`Card`/`Badge`/`Button loading`/`Modal`/`@mantine/notifications`/`Skeleton`/`CopyButton`/`useMantineColorScheme` all built in, styled via props, no custom CSS needed | Grid/Group/Stack are responsive-prop-driven (`visibleFrom`/`hiddenFrom`, breakpoint props); AppShell has a mobile burger pattern out of the box | Full `@mantine/core` unpacked ~9.2MB source/types (not tree-shaken); real gzipped app bundle for a small screen set is commonly cited in the 80-150KB range including hooks+notifications ([bundle comparison discussion](https://www.index.dev/skill-vs-skill/chakra-ui-vs-mantine-vs-radix-ui)) | Components ship with ARIA roles/attributes, keyboard support, tested with `jest-axe` + manual VoiceOver testing ([Mantine a11y FAQ](https://help.mantine.dev/q/are-mantine-components-accessible)) | v8 API is well represented pre-cutoff; v8→v9 renamed several props (`Grid gutter→gap`, `Collapse in→expanded`, `Text/Anchor color→c`) — **pin v8 to dodge this trap entirely** |
| **MUI (Material UI)** | `@mui/material@9.4.0` (v8 skipped, jumped v7→v9 to resync with MUI X) | Very active, well-funded (MUI is a company), quarterly-ish majors | Yes | `@mui/material @emotion/react @emotion/styled` (or the newer Pigment CSS zero-runtime path); no PostCSS step needed, trivial with Vite | Mostly yes — `Stack`/`Grid`/`Card`/`Chip`(badge-like)/`Button loading`/`Dialog`/`Snackbar`/`Skeleton`; no built-in copy-button (few lines with `navigator.clipboard`); need `sx` prop occasionally for one-offs, which is JS-in-object, not real CSS | `Grid`'s `size` prop plus `useMediaQuery`/breakpoints; solid, long-standing responsive system | Historically **100-200KB gzip** for Material components + Emotion is one of the heavier picks of this group | Excellent, oldest and most audited a11y story in the React ecosystem (built on top of extensive ARIA work), Material Design semantics well understood by screen readers | v6 (Aug 2024) and v7 (Mar 2025) are both solidly pre-cutoff and this is the single most training-data-saturated React UI library in existence, **but** v9 (Apr 2026, post-cutoff) changed nothing structurally huge over v7 — Grid v2 → Grid is the same shape carried forward. **Pin v7.3.x** to match training data 1:1 and skip any v9-specific surprises |
| **Chakra UI** | `@chakra-ui/react@3.37.0` | Active, but v3 (Oct 2024) was a from-scratch rewrite; cadence since has been steady patch releases | Yes, and v3's new style-tag approach was explicitly designed with React 19 in mind | Straightforward Vite install, `ChakraProvider` wrap, no CSS files to import (uses its own CSS-in-JS-like engine, Panda-inspired) | Yes on paper (namespaced components: `Stack`, `Card.Root`, `Badge`, `Button loading`, `Dialog`, `Toaster`, `Skeleton`) but the v2→v3 namespace rewrite (`Modal`→`Dialog`, compound `Card.Root/Card.Body`, snippet-based toaster setup) is exactly the kind of change that trips up code generation | Responsive style-prop arrays, standard Chakra pattern, works well | No hard figure surfaced; comparable to Mantine, moderate | Good — Chakra has always emphasized accessible primitives, and v3 is now built on Ark UI headless primitives underneath | **Risk**: any training data from before Oct 2024 (a large fraction of what any LLM has seen about Chakra, since v1/v2 existed for years) actively conflicts with v3's renamed components and removed `@chakra-ui/icons`/framer-motion dependency. Sonnet 5 (cutoff Jan 2026) has ~15 months of v3-era content to draw on, so it's serviceable but not as safe a bet as Mantine v8 or MUI v7 |
| **shadcn/ui (+Tailwind)** | CLI "v2"/"v4" flow, Tailwind `4.3.3` | Very active, trend-setting, not versioned as a normal library since you copy source into your repo | Yes, current templates target React 19 | `npx shadcn@latest init` scaffolds Tailwind v4 (`@theme` CSS block, no `tailwind.config.ts`, no PostCSS config) directly for Vite ([Tailwind v4 doc](https://ui.shadcn.com/docs/tailwind-v4)) | **No** — this is the honest answer to the "zero CSS" question. shadcn is copy-pasted component source *plus* Tailwind utility classes that live in your repo; you own and edit both. There's no CSS-in-JS engine hiding the styling — you will write `className="flex items-center gap-2 rounded-md border p-4"` yourself, and every layout tweak is a Tailwind class change. This directly contradicts "I don't want to write CSS," even though it's popular and looks great | Responsive is manual Tailwind breakpoint prefixes (`sm:`, `md:`) — you write every responsive rule | Excellent (only what you use ships, Tailwind purges unused classes) | Built on Radix Primitives under the hood, so accessible roles are solid where components use them | The Tailwind v3→v4 change (CSS-native `@theme`, no config file, OKLCH colors) plus the shadcn CLI's own v1→v2 flag/workflow changes landed **March 2026, after cutoff** — a generated project will very likely mix v3-style `tailwind.config.js` with v4 CSS imports, a common real-world failure mode reported in migration guides |
| **Radix Themes** | `@radix-ui/themes@3.3.0` | Steady, low-drama; maintained by WorkOS since acquiring the project | Yes, current release line supports React 19 ([discussion #675](https://github.com/orgs/radix-ui/themes/discussions/675)) | `@radix-ui/themes`, import one CSS file, wrap in `<Theme>` — genuinely trivial with Vite, no PostCSS/Tailwind needed | Mostly — `Flex`/`Grid`/`Card`/`Badge`/`Button` (loading needs a manual spinner swap, no built-in `loading` prop), `Dialog`/`AlertDialog`, `Skeleton` all exist as styled Radix Themes components with theme tokens (no CSS authored). No dedicated copy-button or toast/notification component in Themes itself — you'd reach for `Toast` from bare Radix Primitives (unstyled, needs some styling) or a small third-party toaster, which reintroduces a bit of "writing CSS" | Responsive via `Flex`/`Grid` breakpoint object props, decent but less turnkey than Mantine's AppShell mobile pattern | Radix has the smallest footprint of the full-featured group when used minimally — accessibility primitives are famously lean, though full Themes styling adds weight back | Best-in-class — Radix Primitives are the reference implementation many other libraries (Chakra v3's Ark UI, shadcn) build their accessibility on top of | **Strongest API-stability story of the whole list**: v3.0.0 shipped March 2024 and is *still* the current major 2.5 years later — essentially zero breaking-change risk for an LLM. The gap is component coverage (no batteries-included Notifications/Toast/CopyButton), so an agent has to hand-assemble a couple of pieces |
| **Ant Design** | `antd@6.6.4` | Very active, but v6 (Nov 2025) is brand new; enterprise-oriented cadence | v5 needs the `@ant-design/v5-patch-for-react-19` shim for `Modal`/`message`/`notification` static methods; v6 fixes this natively | `antd` + less-config-needed since v5 dropped Less for CSS-in-JS; straightforward with Vite | Yes, huge component set (`Space`, `Grid`, `Card`, `Badge`, `Button loading`, `Modal`, `notification`/`message`, `Skeleton`) — arguably the most "zero CSS" of all, at the cost of a strong, opinionated enterprise-dashboard visual identity that's a mismatch for a small fun game panel | Antd's grid is a classic 24-column responsive grid, works fine on mobile but the overall design language (dense tables, forms) is desktop/enterprise-first and needs real effort to feel good on a phone | Heaviest of the group: full package ~450KB gzip unpruned ([bundlephobia data pulled 2026-09-19: gzip 455,763 bytes for the whole `antd` package]); tree-shaking with real usage brings this down a lot but it's still the heaviest baseline | Good, mature a11y within its own admin-dashboard idioms | v6 landed 6 weeks before the Jan 2026 cutoff — thin representation; an agent will likely default to v5 patterns (needing the compat patch) or mix v5/v6 APIs. Also visually the worst fit for "a fun game control panel used from a phone" |
| **HeroUI (formerly NextUI)** | `@heroui/react@3.2.6` | Active, but v3 (March 2026) is a from-scratch rewrite — brand new, unproven at scale | v3 is built for React 19/Next.js from the ground up, no provider wrapper needed | Vite guide exists, Tailwind v4-based, needs Tailwind configured | Yes on paper — `HStack`/`Grid` equivalents via Tailwind + component primitives, `Card`, `Chip` (badge), `Button` with `isLoading`, `Modal`, `Skeleton`; no first-party toast in the new v3 API surface confirmed at research time | Built on React Aria Components, so keyboard/mobile interaction quality should be strong, but v3 is 6 months old — fewer real-world mobile reports to lean on | Not yet benchmarked broadly; likely competitive given CSS-only animations and no JS runtime for motion | Built directly on React Aria Components — very strong accessibility foundation | **Worst LLM-friendliness of the whole list.** v3 shipped after the cutoff and is a complete rewrite that removes the old `NextUIProvider` pattern that dominates existing training data (years of NextUI/HeroUI v1/v2 tutorials). An agent will almost certainly generate v2-shaped code against a v3 install and fail |
| **daisyUI** | `daisyui@5.7.42` (Tailwind plugin) | Active, zero-dependency rewrite in v5 (Feb 2025), stable since | N/A — it's CSS classes, not React components, so "React 19 compatibility" doesn't really apply | `@plugin "daisyui";` in your Tailwind v4 CSS entry — trivial | **No** — daisyUI only gives you class names (`btn`, `card`, `modal`, `badge`, `skeleton`) applied to plain HTML/React elements. There is no `<Modal>` component managing open state, no `<Toast>` queue, no `<CopyButton>` clipboard logic — you write that behavior (and the JSX structure + classes) yourself. Less CSS than raw Tailwind, but still real CSS authorship and all the interactive logic | Responsive is manual Tailwind breakpoints, same as shadcn | Excellent (pure CSS, ~34KB compressed for the whole theme system, no JS shipped by the library itself) ([daisyUI 5 release notes](https://daisyui.com/docs/v5/)) | Depends entirely on the semantic HTML you write yourself — no built-in ARIA wiring beyond what native elements provide | Solid API stability since Feb 2025, but doesn't solve "I don't want to write CSS" or component *behavior* at all — disqualifying for this project regardless of version stability |

## Recommendation: Mantine, pinned to v8

**Winner: Mantine, pin `@mantine/core@^8.3.18` / `@mantine/hooks@^8.3.18` / `@mantine/notifications@^8.3.18`** (not the npm `latest` tag, which is now v9).

Reasoning:
- It is the only library on this list that genuinely covers **every** UI element in the brief — `Stack`, `Group`, `Grid`, `Card`, `Badge`, `Button` with a built-in `loading` prop, `Modal`, `@mantine/notifications` for toasts, `Skeleton`, `CopyButton` (with built-in clipboard + "copied" state), and `useMantineColorScheme` for dark mode — as first-party, fully-styled components. No Tailwind classes, no `sx` object tuning, no hand-rolled clipboard or toast queue.
- Setup with Vite is a documented, five-step recipe (`@mantine/core @mantine/hooks` + a `postcss.config.cjs` + `MantineProvider`).
- Accessible roles/labels are built in and axe-tested, which plays well with Playwright's `getByRole` queries.
- Pinning to **v8** (released May 2025, safely inside Sonnet's training window) sidesteps the v8→v9 prop renames (`Grid gutter→gap`, `Collapse in→expanded`, `Text/Anchor color→c`) that shipped in March 2026, after the knowledge cutoff — the single biggest LLM-footgun this research turned up for Mantine. v8.x is still receiving patch releases (`8.3.18`, 39 releases in that line), so pinning it is not settling for an abandoned branch.
- Component/AppShell responsive patterns (burger menu, `visibleFrom`/`hiddenFrom`) give reasonable phone behavior with no extra design work, matching "usable from a phone" with minimal effort.

**Runner-up: MUI (Material UI), pinned to `^7.3.11`.** It is the single most training-data-saturated React UI library that exists, so an agent's instincts are least likely to hallucinate an API. Zero-CSS coverage is *almost* as complete as Mantine's (missing only a first-party copy button, trivial to add with `navigator.clipboard`), setup is arguably even simpler (no PostCSS config file needed), and accessibility is excellent. It loses to Mantine only on completeness (no built-in notifications/toast system — you'd add `notistack` or build on `Snackbar`) and on visual identity: Material Design reads more "enterprise dashboard" than "game panel," though that's a design nit, not a functional one. If the team ever wants the safest, most boring, most widely-documented choice, MUI v7 is it.

Honorable mention, not the pick: **Radix Themes** has the best API stability of anything researched (no breaking major since March 2024) and excellent accessibility, but it lacks a built-in notifications/toast and copy-button component, so it doesn't clear the "truly zero CSS for every listed screen element" bar without extra assembly — good for future-proofing, not for handing an agent a five-minute setup.

**Explicitly ruled out for "zero CSS": shadcn/ui and daisyUI.** Both require writing and owning Tailwind utility classes (and, for shadcn, copied component source) — that is writing CSS in every meaningful sense the owner cares about, even though no `.css` file with custom rules is involved. Both also landed inside or after the Tailwind v3→v4 / shadcn CLI v2 transition (March 2026), which is a documented source of mixed-version scaffolding bugs.

## Exact packages and versions to pin

```
@mantine/core@^8.3.18
@mantine/hooks@^8.3.18
@mantine/notifications@^8.3.18
postcss@^8
postcss-preset-mantine@latest
postcss-simple-vars@latest
@tabler/icons-react@latest   # Mantine's own default icon set, tree-shakeable
```

## Minimal Vite setup for Mantine v8

1. `pnpm add @mantine/core@^8.3.18 @mantine/hooks@^8.3.18 @mantine/notifications@^8.3.18`
2. `pnpm add -D postcss postcss-preset-mantine postcss-simple-vars`
3. Create `postcss.config.cjs`:
   ```js
   module.exports = {
     plugins: {
       'postcss-preset-mantine': {},
       'postcss-simple-vars': {
         variables: {
           'mantine-breakpoint-xs': '36em',
           'mantine-breakpoint-sm': '48em',
           'mantine-breakpoint-md': '62em',
           'mantine-breakpoint-lg': '75em',
           'mantine-breakpoint-xl': '88em',
         },
       },
     },
   };
   ```
4. In `main.tsx` / `App.tsx`:
   ```tsx
   import '@mantine/core/styles.css';
   import '@mantine/notifications/styles.css';
   import { MantineProvider } from '@mantine/core';
   import { Notifications } from '@mantine/notifications';

   export default function App() {
     return (
       <MantineProvider defaultColorScheme="auto">
         <Notifications />
         {/* screens */}
       </MantineProvider>
     );
   }
   ```

(Source: [Mantine's own Vite guide](https://mantine.dev/guides/vite/).)

## Component mapping for the two screens

| UI element from the brief | Mantine v8 component/hook |
|---|---|
| Sign-in page, "Sign in with Steam" button | `Button` (with `leftSection` for a Steam icon), `Center`/`Stack` for layout |
| World card, status badge (stopped/starting/running/stopping) | `Card`, `Badge` (color per status), `Group`/`Stack` inside the card |
| Start/stop button with in-flight state | `Button` `loading` prop (built-in spinner + disabled state) |
| Join panel: server name + IP with copy | `Text` for name/IP, `CopyButton` (built-in "copied" state + timeout) wrapped around an `ActionIcon` or `Button` |
| Player count | Plain `Text`/`Badge`, no special component needed |
| Countdown to auto-stop | Plain state + `Text` (see Countdown section below) — no Mantine component needed, just formatting |
| Confirmation dialog (stop / world switch) | `Modal` (or `@mantine/core`'s `Modal.Root` compound API), or the simpler `modals` manager from `@mantine/modals` for one-liner `openConfirmModal` |
| Toasts for errors | `@mantine/notifications` (`notifications.show({ color: 'red', message })`) |
| Loading/skeleton states | `Skeleton` |
| Dark mode toggle | `useMantineColorScheme()` + `ActionIcon` swapping a sun/moon icon (e.g. `@tabler/icons-react`'s `IconSun`/`IconMoonStars`) |
| Overall page/card layout | `Stack`, `Group`, `Grid`, `Container`, `AppShell` (gives a mobile burger-menu pattern for free if a nav shell is ever needed) |

Note: for the confirm-dialog pattern specifically, consider adding `@mantine/modals` (same version line, `^8.3.18`) — it gives `openConfirmModal({...})` as a single function call, which is less code for an agent to get wrong than manually wiring `Modal` open/close state for every confirmation.

## Companions (kept short)

- **Data fetching/polling for status**: **TanStack Query v5** (`@tanstack/react-query@^5.103.1`). Use `useQuery` with `refetchInterval` (e.g. 3-5s while a world is starting/stopping, longer or paused while stopped) — this is exactly the "poll while a condition holds, back off otherwise" use case `refetchInterval` (optionally as a function of the last data) is built for, plus you get request de-duping, retry, and stale-time control for free. SWR (`swr@^2.5.1`) is a fine, smaller alternative with a similar polling option (`refetchInterval`), but TanStack Query's mutation + query invalidation pattern (`useMutation` to start/stop, then `invalidateQueries`) maps more directly onto "click start, then poll until running" than SWR's more manual `mutate()` calls, and TanStack Query is at least as well-represented in training data. Plain `fetch` + `useEffect`/`setInterval` is avoidable complexity/bug surface for no real benefit here.
- **Routing**: **skip a router.** Two screens (sign-in vs. world list) can be driven by simple state (`isSignedIn` / `session` presence) with no URL-addressable routes needed — there's nothing here a user needs to deep-link or bookmark, and one less dependency is one less thing for an agent to wire up wrong. If a router is ever wanted (e.g. to make the confirm dialog or a specific world shareable via URL), `react-router` v7 (`react-router-dom@^7.18.4`) is the default choice, but it's not needed for this scope.
- **Icons**: **`@tabler/icons-react`** — it's Mantine's own de facto default icon set, used throughout Mantine's docs/examples (so an agent trained on Mantine examples will reach for it naturally), tree-shakeable, and has a Steam-adjacent brand icon set gap you'd fill with a small inline SVG for the Steam logo specifically (neither Tabler nor Lucide ship a Steam brand icon by default; a simple `simple-icons` react wrapper or one inline SVG covers that one icon).
- **Countdown to auto-stop**: no library needed — a small custom hook (`useCountdown(targetTimestamp)` using `setInterval`/`Date.now()` diffing, or better, deriving remaining time each render from a `useState` tick + the server-provided `stopAt` timestamp) is simpler, more transparent to an agent, and easier for Playwright to assert against than pulling in `react-countdown` or similar for one number on screen.

## Confidence and open questions

- High confidence on the recommendation (Mantine) and on pinning v8 specifically given the documented v8→v9 prop renames landing after the training cutoff.
- Bundle-size figures are the softest part of this research — Bundlephobia's API rate-limited this session before per-package gzip numbers could be pulled directly for Mantine/MUI/Chakra/Radix; the table above uses npm's unpacked-size figures (not gzip, not tree-shaken) plus figures cited in third-party 2026 comparison articles as a cross-check. For a 6-user internal tool, bundle size differences in the tens of KB are unlikely to matter in practice, but if precise gzip numbers matter, re-run `https://bundlephobia.com/package/@mantine/core@8.3.18` etc. directly.
- Ant Design v6's real-world React 19 maturity (it's ~10 months old) wasn't stress-tested beyond its own migration doc.
