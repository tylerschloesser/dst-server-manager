// docs/web.md §7 scenario 2: `/?error=not-allowed` shows the allowlist message; a reload of `/`
// clears it (the SPA reads the query param once, then `history.replaceState`s it away).
import { expect, test } from '@playwright/test';

test('2. not-allowed message', async ({ page }) => {
  await page.goto('/?error=not-allowed');

  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(
    "That Steam account isn't on the allowlist. Ask the server owner to add you.",
  );

  // The SPA clears the query param via `history.replaceState` on mount, so by the time we
  // reload, the address bar already reads `/`.
  await expect.poll(() => new URL(page.url()).search).toBe('');
  await page.reload();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
