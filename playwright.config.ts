// docs/decisions.md §16.34: Playwright config lives at the repo root. Web servers (the local API
// with APP_ENV=test + Vite) are wired in a later task once packages/api/src/local.ts and the
// @dst/web app exist; this scaffold only proves `pnpm e2e` runs a suite.
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e/tests',
});
