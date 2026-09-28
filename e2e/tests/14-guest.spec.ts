// docs/web.md §7 scenario 14 / docs/auth.md §12: a guest link sees everything a member sees,
// read-only. Write controls are visible but disabled, the join secrets never reach the page, and
// the server refuses a write even if one is forced.
import { test as base, expect } from '@playwright/test';
import * as control from '../support/control';
import { mintTestGuest, sessionCookie } from '../support/session';

const test = base.extend<{ resetFakes: void }>({
  context: async ({ context }, use) => {
    await context.addCookies([sessionCookie(mintTestGuest())]);
    await use(context);
  },
  resetFakes: [
    async ({ request }, use) => {
      await control.reset(request);
      await use();
    },
    { auto: true },
  ],
});

test('14. a guest link is read-only', async ({ page, request }) => {
  await control.setState(request, {
    status: 'running',
    worldId: 'test-a',
    desiredWorldId: 'test-a',
    publicIp: '203.0.113.10',
    playerCount: 1,
  });
  const worldsResponse = page.waitForResponse((r) => r.url().endsWith('/api/worlds'));
  await page.goto('/');

  // The API sent no password, and the page never shows one.
  const worlds = await (await worldsResponse).text();
  expect(worlds).not.toContain('localpass1');
  expect(worlds).not.toContain('c_connect');

  await expect(page.getByText('Guest · read-only')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeEnabled();

  // Start/Stop: visible, disabled.
  const cardA = page.getByRole('article', { name: 'World A' });
  await expect(cardA.getByRole('button', { name: 'Stop' })).toBeDisabled();
  const cardB = page.getByRole('article', { name: 'World B' });
  await expect(cardB.getByRole('button', { name: 'Start' })).toBeDisabled();

  // The join panel: where, never how to get in.
  const join = page.getByRole('region', { name: 'How to join' });
  await expect(join.getByText('DST World A')).toBeVisible();
  await expect(join.getByText('Hidden in guest view')).toHaveCount(2);
  await expect(join.getByRole('button', { name: 'Copy password' })).toHaveCount(0);
  await expect(join.getByText(/203\.0\.113\.10/)).toBeVisible();

  // The recap and the map render; the note button is there but disabled.
  const recapA = page.getByRole('region', { name: 'World A recap' });
  await expect(recapA.getByRole('heading', { name: /Last session/ })).toBeVisible();
  await expect(recapA.getByRole('button', { name: /note/i })).toBeDisabled();
  const mapA = page.getByRole('region', { name: 'World A map' });
  await expect(mapA.getByRole('img').first()).toBeVisible();
  await expect(mapA.getByRole('heading', { name: /Your map/ })).toHaveCount(0);

  // Forcing a write anyway: the server says read_only, and nothing changes.
  const res = await page.request.post('/api/worlds/test-a/stop', {
    headers: { origin: 'http://localhost:5173', 'x-dst-request': '1' },
  });
  expect(res.status()).toBe(403);
  expect((await res.json()).error.code).toBe('read_only');
  await expect(cardA.getByRole('button', { name: 'Stop' })).toBeVisible();
});
