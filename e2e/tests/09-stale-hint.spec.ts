// docs/web.md §7 scenario 9: a heartbeat older than 2 minutes shows the stale hint but keeps the
// "Running" badge (docs/decisions.md §16.8 — `stale` never changes `status`).
import { control, expect, test } from '../support/fixtures';

test('9. stale hint', async ({ page, request }) => {
  // `desiredWorldId` must match `worldId` — see 06-stop-with-confirmation.spec.ts's comment.
  await control.setState(request, {
    status: 'running',
    worldId: 'test-a',
    desiredWorldId: 'test-a',
    playerCount: 0,
  });
  await control.setHeartbeatAgeSeconds(request, 300);
  await page.goto('/');

  const article = page.getByRole('article', { name: 'World A' });
  await expect(article.getByText('Not responding — check back in a minute.')).toBeVisible();
  await expect(article.getByText('Running')).toBeVisible();
});
