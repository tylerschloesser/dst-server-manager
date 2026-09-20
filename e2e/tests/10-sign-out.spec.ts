// docs/web.md §7 scenario 10: signing out returns to the signed-out screen, and it stays that
// way after a reload (the session cookie is cleared server-side).
import { expect, test } from '../support/fixtures';

test('10. sign out', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('article')).toHaveCount(2);

  await page.getByRole('button', { name: 'Sign out' }).click();

  const link = page.getByRole('link', { name: 'Sign in with Steam' });
  await expect(link).toBeVisible();

  await page.reload();
  await expect(link).toBeVisible();
});
