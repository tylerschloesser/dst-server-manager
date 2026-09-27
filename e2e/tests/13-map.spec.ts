// docs/web.md §7 scenario 13: the viewer's own map (docs/decisions.md §19), from the synthetic
// fixture in packages/api/src/fakes/map-fixture.ts (the dev user is p3 of test-a's newest session).
import { expect, test } from '../support/fixtures';

// Evaluated in the browser by `page.evaluate` (see 04-start-starting-running.spec.ts).
declare const document: { documentElement: { scrollWidth: number } };
declare const window: { innerWidth: number };

test('13. the map: masked by the API, layered, tap storage for its contents', async ({ page }) => {
  const mapResponse = page.waitForResponse((r) => r.url().endsWith('/api/worlds/test-a/map'));
  await page.goto('/');
  // Nothing outside the viewer's reveal left the API: not the islet's chest, not its tile type.
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

  // With storage hidden, a tap lists nothing.
  await mapA.getByText('Storage', { exact: true }).click();
  await canvas.click({ position: { x: box.width / 2, y: box.height / 2 } });
  await expect(selection).toHaveCount(0);

  // The caves tab.
  await mapA.getByText('Caves', { exact: true }).click();
  await expect(mapA.getByRole('img', { name: /Your map of the caves/ })).toBeVisible();

  // Still fits a phone (scenario 11's rule).
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    .toBe(true);
});
