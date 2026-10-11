import { expect, test } from '@playwright/test';

const SHOTS = process.env.SCREENSHOT_DIR;

test('landing explains the product and links into the live app', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('prove every move');
  for (const id of ['product', 'problem', 'how', 'proof', 'roadmap']) {
    await expect(page.locator(`section#${id}`)).toBeVisible();
  }
  // Live vault data on the landing itself.
  await expect(page.getByLabel('Live vault on Robinhood Chain testnet')).toContainText(/\$\d/, { timeout: 30_000 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/landing-${info.project.name}.png`, fullPage: true });
  await page.getByRole('link', { name: 'Launch app →' }).first().click();
  await expect(page).toHaveURL(/\/app$/);
  await expect(page.getByRole('navigation', { name: 'App sections' })).toBeVisible();
  expect(errors, errors.join(' | ')).toEqual([]);
});

test('dashboard renders live vault data and the signed decision feed', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/app');
  await expect(page.locator('#nav-heading')).toHaveText(/net asset value/i);
  // NAV comes from the live vault through the proxied RPC: a dollar figure, not the "—" placeholder.
  await expect(page.locator('section[aria-labelledby="nav-heading"]')).toContainText(/\$\d/, { timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Where the USDG is' })).toBeVisible();
  await expect(page.getByLabel(/Morpho \d+%, Uniswap \d+%, idle \d+%/)).toBeVisible({ timeout: 30_000 });

  // Agent feed via the proxied agent API: live status and at least one BLS-verified decision.
  await expect(page.getByText('Agent live')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Agent decisions' })).toBeVisible();
  await expect(page.getByText(/BLS12-381 \(Amadeus\) verified on-chain/).first()).toBeVisible({ timeout: 30_000 });

  // Explorer links point at the real Robinhood testnet explorer.
  const explorerLink = page.locator('a[href^="https://explorer.testnet.chain.robinhood.com/"]').first();
  await expect(explorerLink).toBeAttached();

  // No horizontal overflow at this viewport.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);

  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${info.project.name}.png`, fullPage: true });
});

test('$PICHI panel shows live token data when configured', async ({ page }) => {
  await page.goto('/app');
  const panel = page.locator('section[aria-labelledby="pichi-heading"]');
  test.skip((await panel.count()) === 0, 'NEXT_PUBLIC_PICHI_TOKEN_ADDRESS not set on this deployment');
  await expect(panel).toContainText(/Holders\s*\d/, { timeout: 30_000 });
  await expect(panel).toContainText('No monetary value');
});

test('agent API and RPC are served from the dashboard domain', async ({ request }) => {
  const health = await request.get('/agent/health');
  expect(health.ok()).toBe(true);
  const state = await (await request.get('/agent/state')).json();
  expect(state.signer.scheme).toBe('bls');
  const rpc = await request.post('/rpc', { data: { jsonrpc: '2.0', id: 1, method: 'eth_chainId' } });
  expect((await rpc.json()).result).toBe('0xb626');
  const blocked = await request.post('/rpc', { data: { jsonrpc: '2.0', id: 1, method: 'anvil_setBalance', params: [] } });
  expect(blocked.status()).toBe(403);
});
