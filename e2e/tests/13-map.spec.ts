// docs/web.md §7 scenario 13: each player's map (docs/decisions.md §19), from the synthetic
// fixture in packages/api/src/fakes/map-fixture.ts (the dev user is p3 of test-a's newest session;
// alice, "Ally" on the local allowlist, is p1 and walked east to a stash only she has seen).
import { expect, test } from '../support/fixtures';

// Evaluated in the browser by `page.evaluate` (see 04-start-starting-running.spec.ts).
declare const document: { documentElement: { scrollWidth: number; scrollHeight: number } };
declare const window: {
  innerWidth: number;
  scrollY: number;
  scrollTo(x: number, y: number): void;
};
declare function getComputedStyle(el: unknown): { fontSize: string };

test('13. the map: masked by the API, layered, tap storage for its contents', async ({ page }) => {
  const mapResponse = page.waitForResponse((r) => r.url().endsWith('/api/worlds/test-a/map'));
  await page.goto('/');
  // Nothing outside EVERY player's reveal left the API: not the islet's chest, not its tile type.
  const body = await (await mapResponse).text();
  expect(body).not.toContain('Hidden Gold');
  expect(body).not.toContain('DESERT_DIRT');
  expect(body).not.toMatch(/KU_|7656119/);

  const mapA = page.getByRole('region', { name: 'World A map' });
  await expect(mapA.getByRole('heading', { name: /Your map/ })).toBeVisible();
  await expect(mapA.getByText(/As of day 60/)).toBeVisible();
  await expect(mapA.getByText('12 new tiles')).toBeVisible();
  const canvas = mapA.getByRole('img', { name: /Your map of the surface/ });
  await expect(canvas).toBeVisible();
  // World B has no map for this viewer: no section at all.
  await expect(page.getByRole('region', { name: 'World B map' })).toHaveCount(0);

  // Centre on the base and tap it: every container there is listed with its contents.
  await mapA.getByRole('button', { name: 'Centre on base' }).click();
  const box = (await canvas.boundingBox())!;
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  const selection = mapA.getByTestId('map-selection');
  await expect(selection).toContainText('Chest: Cut Grass 60, Log 38');
  await expect(selection).toContainText('Chest: Gears 3');
  await expect(selection).toContainText('Ice Box: Meat 4');
  await selection.getByRole('button', { name: 'Close' }).click();
  await expect(selection).toHaveCount(0);

  // Turning the map (like the game's Q/E) keeps the centre where it is: the base is still there.
  await mapA.getByRole('button', { name: 'Rotate right' }).click();
  await mapA.getByRole('button', { name: 'Rotate right' }).click();
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(selection).toContainText('Ice Box: Meat 4');
  await selection.getByRole('button', { name: 'Close' }).click();
  await mapA.getByRole('button', { name: 'Rotate left' }).click();

  // With storage hidden, a tap lists nothing.
  await mapA.getByText('Storage', { exact: true }).click();
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(selection).toHaveCount(0);

  // The caves tab.
  await mapA.getByText('Caves', { exact: true }).click();
  await expect(mapA.getByRole('img', { name: /Your map of the caves/ })).toBeVisible();

  // Ally's map: her trail, her stash (outside the viewer's reveal), no caves, no base.
  // A native <select> at >= 16 px: no iOS focus zoom, no AutoFill bar (docs/web.md §3 Map).
  const whose = mapA.getByRole('combobox', { name: 'Whose map' });
  expect(await whose.evaluate((el) => (el as { tagName: string }).tagName)).toBe('SELECT');
  expect(
    await whose.evaluate((el) => parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(16);
  // Switching at the very bottom of the page must not move the scroll: the page never gets
  // shorter for a frame while the new map mounts (Safari clamped the scroll on that).
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const scrolledTo = await page.evaluate(() => window.scrollY);
  await whose.selectOption({ label: 'Ally' });
  await expect(mapA.getByRole('heading', { name: /Ally's map/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrolledTo);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrolledTo);
  await expect(
    mapA.getByRole('img', { name: "Ally's map of the surface: their trail, 1 storage spots" }),
  ).toBeVisible();
  await expect(mapA.getByText('5 new tiles')).toBeVisible();
  await expect(mapA.getByText('where Ally stopped')).toBeVisible();
  await expect(mapA.getByText(/Only what Ally has seen/)).toBeVisible();
  // The tabs stay (the page keeps its height), with Caves disabled: Ally has never been there.
  await expect(mapA.getByRole('radio', { name: 'Caves' })).toBeDisabled();
  await expect(mapA.getByRole('button', { name: 'Centre on base' })).toHaveCount(0);

  // And back to the viewer's own.
  await whose.selectOption({ label: 'Dev (you)' });
  await expect(mapA.getByRole('heading', { name: /Your map/ })).toBeVisible();
  await expect(mapA.getByRole('img', { name: /Your map of the surface/ })).toBeVisible();

  // Still fits a phone (scenario 11's rule).
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    .toBe(true);
});
