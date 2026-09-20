// docs/web.md §7 scenario 11: no horizontal scroll on the phone project, in the running state
// (the screen with the longest visible strings: the connect command, the address, the password).
import { control, expect, test } from '../support/fixtures';

// See the comment in 04-start-starting-running.spec.ts: these run inside `page.evaluate`, in the
// browser, not this Node process.
declare const document: { documentElement: { scrollWidth: number } };
declare const window: { innerWidth: number };

test('11. no horizontal scroll on phone', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'phone', 'phone-only (docs/web.md §7 scenario 11)');

  // `desiredWorldId` must match `worldId`, or the fake launcher's next tick reads "nothing
  // desired" as a user stop request and starts tearing the world down on its own
  // (packages/api/src/local/localLauncher.ts's `stopReasonFor`).
  await control.setState(request, {
    status: 'running',
    worldId: 'test-a',
    desiredWorldId: 'test-a',
    publicIp: '203.0.113.10',
    playerCount: 0,
  });
  await page.goto('/');

  const joinPanel = page.getByRole('region', { name: 'How to join' });
  await expect(joinPanel).toBeVisible();
  const consoleCommand = joinPanel.locator('pre');
  await expect(consoleCommand).toBeVisible();

  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    .toBe(true);

  const fits = await consoleCommand.evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(fits).toBe(true);
});
