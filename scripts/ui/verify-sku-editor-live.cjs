// Opt-in local synthetic catalog writes. Leaves one marked UNPUBLISHED product and audit history.
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
if (fs.existsSync('.env')) process.loadEnvFile('.env');
const db = new URL(process.env.DATABASE_URL || '');
if (
  process.env.YUMI_LIVE_UI !== '1' ||
  process.env.NODE_ENV === 'production' ||
  !['127.0.0.1', 'localhost'].includes(db.hostname) ||
  db.pathname !== '/yumi_dev' ||
  db.searchParams.has('schema')
)
  throw Error('Requires YUMI_LIVE_UI=1 and local yumi_dev/public');
(async () => {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
    timezoneId: 'Asia/Shanghai',
  });
  let profile, createdId;
  const base = 'http://127.0.0.1:5173/api/v1';
  async function call(route, body, expected = 200) {
    const options =
      body === undefined
        ? {}
        : {
            method: 'POST',
            headers: {
              Origin: 'http://127.0.0.1:5173',
              'X-CSRF-Token': profile.csrfToken,
              'Idempotency-Key': randomUUID(),
              'Content-Type': 'application/json',
            },
            data: body,
          };
    const response = await page.request.fetch(base + route, options);
    assert.equal(response.status(), expected, route);
    return (await response.json()).data;
  }
  try {
    await page.goto('http://127.0.0.1:5173/');
    await page.getByLabel('员工账号').fill(process.env.LOCAL_ADMIN_LOGIN);
    await page.getByLabel('登录密码').fill(process.env.LOCAL_ADMIN_PASSWORD);
    await page.getByRole('button', { name: '登录工作空间 →' }).click();
    await page.locator('.workspace').waitFor();
    profile = await call('/staff/me');
    const category = (await call('/admin/categories?limit=50')).items.find(
      (c) => c.enabled && !c.parentId,
    );
    assert(category);
    const warehouse = (await call('/warehouse/warehouses')).items[0];
    assert(warehouse);
    const stockPath = `/warehouse/warehouses/${warehouse.id}/stock?limit=50`;
    const beforeStock = await call(stockPath);
    const marker = `UI规格实链-${Date.now()}`;
    const product = await call('/admin/products', {
      categoryId: category.id,
      name: marker,
      description: '本地合成规格维护验证',
      skus: [0, 1].map((i) => ({
        code: `UISKU-${Date.now()}-${i}`,
        spec: i ? '6包装' : '3包装',
        unit: '包',
        priceCents: i ? 1299 : 719,
        expiryManaged: false,
      })),
    });
    createdId = product.id;
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '商品管理', exact: true })
      .click();
    await page.getByRole('button', { name: '刷新', exact: false }).first().click();
    await page.getByRole('textbox', { name: '搜索商品' }).fill(marker);
    const row = page.getByRole('row').filter({ hasText: product.skus[0].code });
    const dialog = page.getByRole('dialog');
    const open = async () => {
      await row.getByRole('button', { name: '售价与启停', exact: true }).click();
      await dialog.getByLabel('售价（元）').waitFor();
    };
    await open();
    await dialog.getByLabel('售价（元）').fill('0.29');
    await page.screenshot({
      path: path.resolve('docs/verification/UI-SKU-LIVE-DESKTOP-2026-10-30.png'),
    });
    await dialog.getByRole('button', { name: '保存售价' }).click();
    await dialog.waitFor({ state: 'hidden' });
    let current = await call(`/admin/products/${createdId}`);
    assert.equal(current.skus.find((s) => s.id === product.skus[0].id).priceCents, 29);
    assert.equal(current.status, 'DRAFT');
    await page.getByRole('button', { name: '上架', exact: true }).click();
    await page.getByRole('button', { name: '下架', exact: true }).waitFor();
    assert.equal((await call(`/products/${product.skus[0].id}`)).priceCents, 29);
    await open();
    await dialog.getByRole('button', { name: '停用规格', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    current = await call(`/admin/products/${createdId}`);
    assert.equal(current.status, 'PUBLISHED');
    await call(`/products/${product.skus[0].id}`, undefined, 404);
    assert.equal((await call(`/products/${product.skus[1].id}`)).priceCents, 1299);
    await open();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: path.resolve('docs/verification/UI-SKU-LIVE-MOBILE-2026-10-30.png'),
    });
    await dialog.getByRole('button', { name: '启用规格', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal((await call(`/products/${product.skus[0].id}`)).priceCents, 29);
    assert.deepEqual(await call(stockPath), beforeStock);
    await page.getByRole('button', { name: '下架', exact: true }).click();
    await page.getByRole('button', { name: '上架', exact: true }).waitFor();
    current = await call(`/admin/products/${createdId}`);
    assert.equal(current.status, 'UNPUBLISHED');
    assert.equal(current.version, 5);
    await call(`/products/${product.skus[0].id}`, undefined, 404);
    fs.writeFileSync(
      '.local/sku-live.json',
      JSON.stringify(
        {
          id: createdId,
          status: current.status,
          version: current.version,
          priceCents: 29,
          publicHiddenOnDisable: true,
          otherSkuVisible: true,
          publicRestoredOnEnable: true,
          stockUnchanged: true,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'Live SKU UI passed: 29 cents exact, publish/disable/enable public behavior, other SKU unchanged, stock unchanged; synthetic product left UNPUBLISHED.',
    );
  } finally {
    if (createdId && profile) {
      const current = await call(`/admin/products/${createdId}`);
      if (current.status === 'PUBLISHED')
        await call(`/admin/products/${createdId}/unpublish`, { version: current.version });
    }
    if (profile) await call('/staff/auth/logout', {});
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
