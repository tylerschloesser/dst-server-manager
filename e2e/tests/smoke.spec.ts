import { expect, test } from '@playwright/test';

// A trivial suite so `pnpm e2e` (an empty Playwright suite exits 1) has something to run.
// The real end-to-end coverage lands with the web app (docs/web.md §7).
test('smoke', () => {
  expect(1 + 1).toBe(2);
});
