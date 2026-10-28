// Local read-only checks. No catalog/stock writes; login/logout only mutate sessions.
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
if (fs.existsSync('.env')) process.loadEnvFile('.env');
const dbUrl = new URL(process.env.DATABASE_URL || '');
if (
  process.env.NODE_ENV === 'production' ||
  !['127.0.0.1', 'localhost'].includes(dbUrl.hostname) ||
  dbUrl.pathname !== '/yumi_dev'
)
  throw Error('Requires local yumi_dev');
(async () => {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('http://127.0.0.1:5173/');
    await page.getByLabel('员工账号').fill(process.env.LOCAL_WAREHOUSE_LOGIN);
    await page.getByLabel('登录密码').fill(process.env.LOCAL_WAREHOUSE_PASSWORD);
    await page.getByRole('button', { name: '登录工作空间 →' }).click();
    await page.getByRole('heading', { name: '工作台', exact: true }).waitFor();
    const read = async (suffix) => {
      const response = await page.request.get(`http://127.0.0.1:5173/api/v1${suffix}`);
      assert.equal(response.status(), 200);
      return (await response.json()).data;
    };
    const warehouses = (await read('/warehouse/warehouses')).items;
    assert(warehouses.length);
    const root = `/warehouse/warehouses/${warehouses[0].id}`;
    const products = (await read('/admin/products?limit=50')).items;
    const categories = (await read('/admin/categories?limit=50')).items;
    const stock = (await read(`${root}/stock?limit=50`)).items;
    assert(products.length && categories.length && stock.length);
    const nav = (name) =>
      page
        .getByRole('navigation', { name: '主导航' })
        .getByRole('button', { name, exact: true })
        .click();
    await nav('商品管理');
    await page.getByRole('cell', { name: products[0].skus[0].code, exact: false }).waitFor();
    assert.equal(
      await page.locator('tbody tr').count(),
      products.reduce((n, p) => n + p.skus.length, 0),
    );
    await page.screenshot({
      path: path.resolve('docs/verification/UI-LISTS-LIVE-PRODUCTS-2026-10-29.png'),
      fullPage: true,
    });
    await nav('商品分类');
    await page.getByText(categories[0].name, { exact: false }).first().waitFor();
    assert.equal(await page.locator('tbody tr').count(), categories.length);
    await nav('库存总览');
    await page.getByText('正在加载库存…', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(await page.locator('tbody tr').count(), stock.length);
    for (const row of stock) {
      const sku = products.flatMap((p) => p.skus).find((s) => s.id === row.skuId);
      if (!sku) continue;
      const tr = page
        .locator('tbody tr')
        .filter({ has: page.getByRole('cell', { name: sku.code, exact: true }) });
      assert.equal(await tr.locator('[data-label="实物库存"]').innerText(), String(row.onHand));
      assert.equal(await tr.locator('[data-label="预占"]').innerText(), String(row.reserved));
      assert.equal(await tr.locator('[data-label="不可售"]').innerText(), String(row.blocked));
    }
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: path.resolve('docs/verification/UI-LISTS-LIVE-STOCK-2026-10-29.png'),
      fullPage: true,
    });
    assert.deepEqual(errors, []);
    console.log(
      `Real local API passed: ${products.length} products, ${categories.length} categories, ${stock.length} stock rows match page/API quantities. No business writes.`,
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
