// docs/web.md §7 scenario 3: signed in, everything stopped.
import { TEST_NICKNAME } from '../support/session';
import { expect, test } from '../support/fixtures';

test('3. list renders', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText(TEST_NICKNAME)).toBeVisible();

  for (const name of ['World A', 'World B']) {
    const article = page.getByRole('article', { name });
    await expect(article).toBeVisible();
    await expect(article.getByText('Stopped')).toBeVisible();
    const startButton = article.getByRole('button', { name: 'Start' });
    await expect(startButton).toBeVisible();
    await expect(startButton).toBeEnabled();
  }
});
