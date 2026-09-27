// docs/web.md §7 scenario 12: the session recap under each world card, from the synthetic
// fixture in packages/api/src/fakes/recap-fixture.ts (test-a: two recaps, test-b: none).
import { expect, test } from '../support/fixtures';

// Evaluated in the browser by `page.evaluate` (see 04-start-starting-running.spec.ts).
declare const document: { documentElement: { scrollWidth: number } };
declare const window: { innerWidth: number };
declare function getComputedStyle(el: unknown): { fontSize: string };

test('12. recap renders for World A, empty state for World B', async ({ page }) => {
  await page.goto('/');

  const recapA = page.getByRole('region', { name: 'World A recap' });
  await expect(recapA.getByRole('heading', { name: /Last session/ })).toBeVisible();
  // The LLM summary (bold rendered, not as literal asterisks).
  await expect(recapA.getByText('Where things stand')).toBeVisible();
  await expect(recapA.locator('strong', { hasText: 'Endothermic Fire Pit' })).toBeVisible();
  await expect(recapA.getByText('**')).toHaveCount(0);
  // The deterministic facts.
  await expect(recapA.getByText('Days 53 → 60 · spring → summer')).toBeVisible();
  await expect(recapA.getByText(/summer began day 56/)).toBeVisible();
  await expect(recapA.locator('p').filter({ hasText: /^Built\s/ })).toHaveText(
    'Built Endothermic Fire Pit, Chest',
  );
  await expect(recapA.getByText(/bob: Overheating, revived by Ally after 4 min/)).toBeVisible();
  // Nicknames come from the allowlist; ids never reach the page.
  await expect(page.getByText(/KU_|7656119/)).toHaveCount(0);

  // Carried items are folded away until asked for.
  await recapA.getByRole('button', { name: 'You are carrying' }).click();
  await expect(recapA.getByText(/Axe \(20 uses\)/)).toBeVisible();

  // The older session is collapsed, and says why it is thin.
  await expect(recapA.getByText('Summary unavailable')).toBeHidden();
  await recapA.getByRole('button', { name: /Days 46 → 53/ }).click();
  await expect(recapA.getByText('Summary unavailable')).toBeVisible();
  await expect(recapA.getByText(/world was restored before this session/)).toBeVisible();

  const recapB = page.getByRole('region', { name: 'World B recap' });
  await expect(recapB.getByText(/No recap yet/)).toBeVisible();

  // Everything expanded (the longest lines the recap has) still fits a phone (scenario 11's rule).
  await recapA.getByRole('button', { name: 'Where our stuff is' }).first().click();
  await expect(recapA.getByText(/Chest ×5 \(surface\): Cut Grass 60/)).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    .toBe(true);
});

test('12b. saving a "next time" note shows it and survives a reload', async ({ page }) => {
  await page.goto('/');
  const recapA = page.getByRole('region', { name: 'World A recap' });

  await recapA.getByRole('button', { name: 'Add a note for next time' }).click();
  // iOS Safari zooms (and stays zoomed) on focusing any field under 16 px (docs/web.md §5).
  const fontSize = await recapA
    .getByLabel('Note for next time')
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(fontSize).toBeGreaterThanOrEqual(16);
  await recapA.getByLabel('Note for next time').fill('Build an ice box, then caves 🧊');
  await recapA.getByRole('button', { name: 'Save note' }).click();
  await expect(recapA.getByTestId('world-note')).toHaveText('Build an ice box, then caves 🧊');

  await page.reload();
  const reloaded = page.getByRole('region', { name: 'World A recap' });
  await expect(reloaded.getByTestId('world-note')).toHaveText('Build an ice box, then caves 🧊');

  // Emptying it clears it.
  await reloaded.getByRole('button', { name: 'Edit note' }).click();
  await reloaded.getByLabel('Note for next time').fill('');
  await reloaded.getByRole('button', { name: 'Save note' }).click();
  await expect(reloaded.getByRole('button', { name: 'Add a note for next time' })).toBeVisible();
});
