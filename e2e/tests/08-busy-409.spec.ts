// docs/web.md §7 scenario 8: a forced 409 on start shows the "busy" notification and rolls back
// the optimistic badge.
import { control, expect, test } from '../support/fixtures';

test('8. busy 409', async ({ page, request }) => {
  await control.failNext(request, 'start', 409);
  await page.goto('/');

  const worldA = page.getByRole('article', { name: 'World A' });
  await expect(worldA.getByText('Stopped')).toBeVisible();
  await worldA.getByRole('button', { name: 'Start' }).click();

  await expect(
    page.getByText('Another world is already starting. Try again in a moment.'),
  ).toBeVisible();
  await expect(worldA.getByText('Stopped')).toBeVisible();
});
