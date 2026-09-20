// docs/web.md §7 scenario 7: switching worlds while one is active asks for confirmation.
import { control, expect, test } from '../support/fixtures';

test('7. switch confirmation', async ({ page, request }) => {
  // `desiredWorldId` must match `worldId` — see 06-stop-with-confirmation.spec.ts's comment.
  await control.setState(request, {
    status: 'running',
    worldId: 'test-a',
    desiredWorldId: 'test-a',
    playerCount: 2,
  });
  await page.goto('/');

  // Re-pin right before acting: the fake launcher's own player-count cycle
  // (packages/api/src/local/localLauncher.ts) steps `playerCount` every 5 s on its own clock.
  await control.setState(request, { playerCount: 2 });
  const worldB = page.getByRole('article', { name: 'World B' });
  await worldB.getByRole('button', { name: 'Start' }).click();

  const dialog = page.getByRole('dialog', { name: 'Switch to World B?' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('will be saved and stopped first');
  await expect(dialog).toContainText("2 players still online — they'll be disconnected.");

  const refetch = page.waitForResponse(
    (res) => res.url().includes('/api/worlds') && res.request().method() === 'GET',
  );
  await dialog.getByRole('button', { name: 'Save and switch' }).click();
  await expect(dialog).toBeHidden();
  await refetch;
});
