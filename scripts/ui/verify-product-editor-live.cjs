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
    const marker = `UI编辑实链-${Date.now()}`;
    const product = await call('/admin/products', {
      categoryId: category.id,
      name: marker,
      description: '本地合成编辑验证',
      skus: [
        {
          code: `UIEDIT-${Date.now()}`,
          spec: '3包装',
          unit: '包',
          priceCents: 719,
          expiryManaged: false,
        },
      ],
    });
    createdId = product.id;
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '商品管理', exact: true })
      .click();
    await page.getByRole('button', { name: '刷新', exact: false }).first().click();
    await page.getByText(marker, { exact: true }).waitFor();
    await page.getByRole('textbox', { name: '搜索商品' }).fill(marker);
    await page.getByRole('button', { name: '编辑资料', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('商品名称', { exact: true }).fill(marker + '-草稿更新');
    await dialog.locator('textarea').fill('草稿资料通过真实页面保存');
    await page.screenshot({
      path: path.resolve('docs/verification/UI-PRODUCT-EDIT-LIVE-DESKTOP-2026-10-30.png'),
    });
    await dialog.getByRole('button', { name: '保存商品资料' }).click();
    await dialog.waitFor({ state: 'hidden' });
    const draft = await call(`/admin/products/${createdId}`);
    assert.equal(draft.version, product.version + 1);
    assert.equal(draft.status, 'DRAFT');
    assert.equal(draft.name, marker + '-草稿更新');
    await page.getByRole('button', { name: '上架', exact: true }).click();
    await page.getByRole('button', { name: '下架', exact: true }).waitFor();
    const published = await call(`/admin/products/${createdId}`);
    assert.equal((await call(`/products/${product.skus[0].id}`)).name, published.name);
    await page.getByRole('button', { name: '编辑资料', exact: true }).click();
    await dialog.getByLabel('商品名称', { exact: true }).fill(marker + '-上架后更新');
    await dialog.locator('textarea').fill('');
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: path.resolve('docs/verification/UI-PRODUCT-EDIT-LIVE-MOBILE-2026-10-30.png'),
    });
    await dialog.getByRole('button', { name: '保存商品资料' }).click();
    await dialog.waitFor({ state: 'hidden' });
    const updated = await call(`/admin/products/${createdId}`),
      sale = await call(`/products/${product.skus[0].id}`);
    assert.equal(updated.version, published.version + 1);
    assert.equal(updated.status, 'PUBLISHED');
    assert.equal(updated.name, marker + '-上架后更新');
    assert.equal(sale.name, updated.name);
    assert.equal(sale.description, '');
    assert.deepEqual(updated.skus, product.skus);
    assert.deepEqual(await call(stockPath), beforeStock);
    await page.getByRole('button', { name: '下架', exact: true }).click();
    await page.getByRole('button', { name: '上架', exact: true }).waitFor();
    await call(`/products/${product.skus[0].id}`, undefined, 404);
    fs.writeFileSync(
      '.local/product-edit-live.json',
      JSON.stringify(
        {
          id: createdId,
          state: 'UNPUBLISHED',
          draftVersion: draft.version,
          publishedVersion: published.version,
          editedVersion: updated.version,
          skuUnchanged: true,
          stockUnchanged: true,
          descriptionCleared: true,
          publicReflectedEdit: true,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'Real product editor passed: draft and published edits via browser, public detail reflects new text, description cleared, SKU/stock unchanged; synthetic product left UNPUBLISHED with audit history.',
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
