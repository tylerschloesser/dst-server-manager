// docs/web.md §7 scenario 6: force `running`, then stop through the confirmation dialog.
import { control, expect, test } from '../support/fixtures';

test('6. stop with confirmation', async ({ page, request }) => {
  // `desiredWorldId` must match `worldId`, or the fake launcher's next tick reads "nothing
  // desired" as a user stop request and starts tearing the world down on its own
  // (packages/api/src/local/localLauncher.ts's `stopReasonFor`).
  await control.setState(request, {
    status: 'running',
    worldId: 'test-a',
    desiredWorldId: 'test-a',
    playerCount: 0,
  });
  await page.goto('/');

  const article = page.getByRole('article', { name: 'World A' });
  await expect(article.getByText('Running')).toBeVisible();
  await article.getByRole('button', { name: 'Stop' }).click();

  const dialog = page.getByRole('dialog', { name: 'Stop World A?' });
  await expect(dialog).toBeVisible();

  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(article.getByText('Running')).toBeVisible();

  await article.getByRole('button', { name: 'Stop' }).click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Stop world' }).click();
  await expect(dialog).toBeHidden();

  await expect(article.getByText('Stopping')).toBeVisible();
});
