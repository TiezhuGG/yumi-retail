// Opt-in local writes: leaves synthetic DRAFT product/receipt and audit; no approval/posting; clears barcode.
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
    const stamp = Date.now(),
      marker = `UI条码收货实链-${stamp}`,
      barcode = `001${stamp}`;
    const product = await call('/admin/products', {
      categoryId: category.id,
      name: marker,
      description: '本地合成条码选品验收',
      skus: [
        {
          code: `UIRECBAR-${stamp}`,
          spec: '3包装',
          unit: '包',
          priceCents: 719,
          expiryManaged: false,
        },
      ],
    });
    createdId = product.id;
    await call(`/admin/products/${createdId}/skus/${product.skus[0].id}/set-barcode`, {
      version: 0,
      barcode,
    });
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '收货入库', exact: true })
      .click();
    await page.getByRole('button', { name: '新建收货单', exact: false }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('来源单号 / 说明').fill(marker);
    const line = dialog.getByRole('region', { name: '收货明细1', exact: true });
    await line.getByLabel('供应批次').fill(`BAR-${stamp}`);
    await line.getByLabel('收货数量（件）').fill('2');
    await line.getByLabel('单件成本（元）').fill('0.29');
    await line.getByLabel('按条码查找商品').fill(barcode);
    await line.getByRole('button', { name: '查询条码', exact: true }).click();
    await line.getByText(marker, { exact: true }).waitFor();
    assert.equal(await line.locator('select').inputValue(), '');
    await page.screenshot({
      path: path.resolve('docs/verification/UI-RECEIPT-BARCODE-LIVE-DESKTOP-2026-10-31.png'),
    });
    await line.getByRole('button', { name: '选入本行', exact: true }).click();
    assert.equal(await line.locator('select').inputValue(), product.skus[0].id);
    assert.equal(await line.getByLabel('收货数量（件）').inputValue(), '2');
    assert.equal(await line.getByLabel('单件成本（元）').inputValue(), '0.29');
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: path.resolve('docs/verification/UI-RECEIPT-BARCODE-LIVE-MOBILE-2026-10-31.png'),
    });
    const [response] = await Promise.all([
      page.waitForResponse((r) => r.url().endsWith('/receipts') && r.request().method() === 'POST'),
      dialog.getByRole('button', { name: '保存收货草稿', exact: true }).click(),
    ]);
    assert.equal(response.status(), 200);
    const receipt = (await response.json()).data;
    assert.equal(receipt.status, 'DRAFT');
    assert.equal(receipt.lines[0].skuId, product.skus[0].id);
    assert.equal(receipt.lines[0].quantity, 2);
    assert.equal(receipt.lines[0].unitCostCents, 29);
    const actual = await call(`/warehouse/warehouses/${warehouse.id}/receipts/${receipt.id}`);
    assert.equal(actual.lines[0].sku.code, product.skus[0].code);
    assert.deepEqual(await call(stockPath), beforeStock);
    fs.writeFileSync(
      '.local/receipt-barcode-live.json',
      JSON.stringify(
        {
          productId: createdId,
          receiptId: receipt.id,
          warehouseId: warehouse.id,
          status: 'DRAFT',
          quantity: 2,
          unitCostCents: 29,
          explicitSelection: true,
          stockUnchanged: true,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'Live receipt barcode passed: exact real lookup, explicit UI selection, preserved quantity/cost, actual DRAFT receipt created, stock unchanged; synthetic barcode cleared in cleanup.',
    );
  } finally {
    if (createdId && profile) {
      const current = await call(`/admin/products/${createdId}`);
      if (current.skus[0].barcode !== null)
        await call(`/admin/products/${createdId}/skus/${current.skus[0].id}/set-barcode`, {
          version: current.version,
          barcode: null,
        });
    }
    if (profile) await call('/staff/auth/logout', {});
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
