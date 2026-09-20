// docs/web.md §7 scenario 5: idle countdown ticks down, then freezes once a player joins.
import type { APIRequestContext, Page } from '@playwright/test';
import { control, expect, test } from '../support/fixtures';

function parseSeconds(label: string): number {
  // The countdown text is "Stops in 1:34 if nobody is playing" — the `m:ss` pair is embedded in
  // a sentence, not the whole string.
  const match = /(\d+):(\d\d)/.exec(label);
  const minutes = match?.[1];
  const seconds = match?.[2];
  if (minutes === undefined || seconds === undefined) {
    throw new Error(`unparsable countdown label: ${label}`);
  }
  return Number(minutes) * 60 + Number(seconds);
}

/** The fake launcher's own player-count cycle (packages/api/src/local/localLauncher.ts) steps
 * `playerCount` every 5 s independent of `/api/test/control`, on a clock this suite doesn't
 * control (it carries over between tests in the one shared server process). Re-asserting the
 * desired count on every poll attempt — instead of setting it once and hoping — keeps the read
 * that follows accurate without a fixed sleep. */
async function countdownSecondsPinnedAtZero(
  request: APIRequestContext,
  page: Page,
): Promise<number> {
  await control.setState(request, { playerCount: 0 });
  return parseSeconds(await page.getByTestId('idle-countdown').innerText());
}

async function playersOnlineTextPinnedAtTwo(
  request: APIRequestContext,
  page: Page,
): Promise<string> {
  await control.setState(request, { playerCount: 2 });
  return page.getByTestId('player-count').innerText();
}

test('5. countdown ticks', async ({ page, request }) => {
  // `desiredWorldId` must match `worldId`, or the fake launcher's next tick reads "nothing
  // desired" as a user stop request and starts tearing the world down on its own
  // (packages/api/src/local/localLauncher.ts's `stopReasonFor`).
  await control.setState(request, {
    status: 'running',
    worldId: 'test-a',
    desiredWorldId: 'test-a',
    publicIp: '203.0.113.10', // join must be non-null for the player-count readout to render
    playerCount: 0,
    idleDeadlineInSeconds: 95,
  });
  await page.goto('/');

  const countdown = page.getByTestId('idle-countdown');
  await expect(countdown).toHaveText(/Stops in 1:3\d if nobody is playing/);

  const first = await countdownSecondsPinnedAtZero(request, page);
  await expect
    .poll(() => countdownSecondsPinnedAtZero(request, page), { timeout: 10_000 })
    .toBeLessThan(first);

  await expect
    .poll(() => playersOnlineTextPinnedAtTwo(request, page), { timeout: 10_000 })
    .toBe('2 players online');
  await expect(countdown).toHaveText('Auto-stops once everyone has left.');
});
