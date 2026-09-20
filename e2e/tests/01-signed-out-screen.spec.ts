// docs/web.md §7 scenario 1: no cookie, open `/`.
import { expect, test } from '@playwright/test';

test('1. signed-out screen', async ({ page }) => {
  await page.goto('/');

  const link = page.getByRole('link', { name: 'Sign in with Steam' });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('href', '/api/auth/steam/login');

  await expect(page.getByRole('article')).toHaveCount(0);
});
