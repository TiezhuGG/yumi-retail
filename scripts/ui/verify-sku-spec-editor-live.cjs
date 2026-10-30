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
    const marker = `UI规格说明实链-${Date.now()}`;
    const product = await call('/admin/products', {
      categoryId: category.id,
      name: marker,
      description: '本地合成规格说明验证',
      skus: [
        {
          code: `UISPEC-${Date.now()}`,
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
    await page.getByRole('textbox', { name: '搜索商品' }).fill(marker);
    const dialog = page.getByRole('dialog');
    const open = async () => {
      await page.getByRole('button', { name: '规格说明', exact: true }).click();
      await dialog.getByLabel('规格说明', { exact: true }).waitFor();
    };
    await open();
    await dialog.getByLabel('规格说明', { exact: true }).fill('3包装（原包装，说明更正）');
    await page.screenshot({
      path: path.resolve('docs/verification/UI-SKU-SPEC-LIVE-DESKTOP-2026-10-30.png'),
    });
    await dialog.getByRole('button', { name: '保存规格说明', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const draft = await call(`/admin/products/${createdId}`);
    assert.equal(draft.version, 1);
    assert.equal(draft.status, 'DRAFT');
    assert.equal(draft.skus[0].spec, '3包装（原包装，说明更正）');
    await page.getByRole('button', { name: '上架', exact: true }).click();
    await page.getByRole('button', { name: '下架', exact: true }).waitFor();
    assert.equal((await call(`/products/${product.skus[0].id}`)).spec, draft.skus[0].spec);
    await open();
    await dialog.getByLabel('规格说明', { exact: true }).fill('3包装（原包装，展示说明已更正）');
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: path.resolve('docs/verification/UI-SKU-SPEC-LIVE-MOBILE-2026-10-30.png'),
    });
    await dialog.getByRole('button', { name: '保存规格说明', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const updated = await call(`/admin/products/${createdId}`),
      sale = await call(`/products/${product.skus[0].id}`);
    assert.equal(updated.version, 3);
    assert.equal(updated.status, 'PUBLISHED');
    assert.equal(sale.spec, '3包装（原包装，展示说明已更正）');
    const expected = structuredClone(product);
    expected.status = 'PUBLISHED';
    expected.version = 3;
    expected.skus[0].spec = sale.spec;
    assert.deepEqual(updated, expected);
    assert.equal(sale.priceCents, 719);
    assert.deepEqual(await call(stockPath), beforeStock);
    await page.getByRole('button', { name: '下架', exact: true }).click();
    await page.getByRole('button', { name: '上架', exact: true }).waitFor();
    await call(`/products/${product.skus[0].id}`, undefined, 404);
    fs.writeFileSync(
      '.local/sku-spec-live.json',
      JSON.stringify(
        {
          id: createdId,
          status: 'UNPUBLISHED',
          version: 4,
          draftEdit: true,
          publishedEdit: true,
          spec: sale.spec,
          publicUpdated: true,
          skuOtherFieldsUnchanged: true,
          stockUnchanged: true,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'Live SKU spec UI passed: draft/published description corrections, public spec updated, other SKU fields and stock unchanged; synthetic product left UNPUBLISHED.',
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
