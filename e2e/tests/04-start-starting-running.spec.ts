// docs/web.md §7 scenario 4: start a stopped world and watch it boot through the fake launcher.
import { MASTER_PORT } from '@dst/shared';
import { control, expect, test } from '../support/fixtures';

// `page.evaluate`'s callback runs in the browser, not this Node process; these ambient
// declarations satisfy the type-checker without pulling in the "dom" lib (root tsconfig.base.json
// is out of scope for this package — decisions §16.34 / this task owns only `e2e/**`). The real
// browser's own global `navigator` answers the call once the source is re-evaluated on the page.
declare const navigator: { clipboard: { readText(): Promise<string> } };

const JOIN_IP = '203.0.113.10'; // packages/api/src/local/localLauncher.ts's fixed fake public IP
const PASSWORD = 'localpass1'; // packages/api/src/local.ts's fake cluster-password parameter

test('4. start -> starting -> running', async ({ page, request }) => {
  await control.setBootMs(request, 1000);
  await page.goto('/');

  const article = page.getByRole('article', { name: 'World A' });
  await article.getByRole('button', { name: 'Start' }).click();

  await expect(article.getByText('Starting')).toBeVisible();
  await expect(article.getByRole('button')).toBeDisabled();

  const joinPanel = page.getByRole('region', { name: 'How to join' });
  await expect(joinPanel).toContainText('Starting the server. Usually about 3 minutes.');

  await expect(article.getByText('Running')).toBeVisible();
  await expect(joinPanel).toContainText('DST World A'); // WorldRegistryItem.serverName
  const address = `${JOIN_IP}:${MASTER_PORT}`;
  await expect(joinPanel).toContainText(address);
  await expect(joinPanel).toContainText(PASSWORD);
  await expect(joinPanel).toContainText(`c_connect("${JOIN_IP}", ${MASTER_PORT}, "${PASSWORD}")`);

  const copyAddress = joinPanel.getByRole('button', { name: 'Copy server address' });
  await copyAddress.click();
  await expect(joinPanel.getByRole('button', { name: 'Copied server address' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(address);
});
