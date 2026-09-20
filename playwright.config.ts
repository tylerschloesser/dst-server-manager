// docs/decisions.md §16.34: Playwright config lives at the repo root, `testDir: 'e2e/tests'`. The
// two web servers are the local API (APP_ENV=test) and the SPA's Vite dev server, both on the
// fixed ports the SPA's own proxy config expects (packages/web/vite.config.ts).
//
// `APP_ENV`/`PUBLIC_ORIGIN` are also set here (not just in the webServer command below) because
// Playwright reloads this file in every worker process before it loads any spec file, and
// `e2e/support/session.ts` imports `@dst/api/auth`, whose module-load assertions
// (docs/auth.md §0) require both to be set *before* that import happens. Every e2e run mints
// session tokens under `APP_ENV=test`, matching the local API server started below.
process.env['APP_ENV'] = 'test';
process.env['PUBLIC_ORIGIN'] = 'http://localhost:5173';

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e/tests',
  // The local API server (both webServer entries below) is a single shared process holding one
  // in-memory cluster-state singleton (packages/api/src/fakes/fake-state-store.ts) — there is no
  // per-test isolation on the backend, matching the real system's "one world runs at a time"
  // invariant (CLAUDE.md). Tests across every spec file and both projects must therefore run
  // strictly one at a time, or one test's `control.setState`/start/stop mutates the state another
  // concurrently-running test is asserting on.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: process.env['CI'] ? [['list']] : [['list']],
  expect: {
    // Generous: the fake launcher's own ticks and the SPA's 5 s worlds poll both need headroom
    // (docs/web.md §7 scenario 4/6/7/9). Assertions still auto-retry; nothing here is a fixed
    // sleep.
    timeout: 15_000,
  },
  use: {
    baseURL: 'http://localhost:5173',
    permissions: ['clipboard-read', 'clipboard-write'],
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command:
        'APP_ENV=test PUBLIC_ORIGIN=http://localhost:5173 pnpm --filter @dst/api exec tsx src/local.ts',
      port: 8787,
      reuseExistingServer: !process.env['CI'],
    },
    {
      command: 'pnpm --filter @dst/web dev',
      port: 5173,
      reuseExistingServer: !process.env['CI'],
    },
  ],
  projects: [
    { name: 'phone', use: { ...devices['Pixel 5'] } },
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
  ],
});
