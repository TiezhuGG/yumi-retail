// Opt-in local writes: two synthetic products; clear both barcodes, unpublish the sale fixture, retain audit.
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
  let profile, createdId, otherId;
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
      marker = `UI条码实链-${stamp}`,
      own = `001${stamp}`,
      taken = `002${stamp}`;
    const make = (name) =>
      call('/admin/products', {
        categoryId: category.id,
        name,
        description: '本地合成条码验证',
        skus: [
          {
            code: `UIBAR-${name === marker ? 'A' : 'B'}-${stamp}`,
            spec: '3包装',
            unit: '包',
            priceCents: 719,
            expiryManaged: false,
          },
        ],
      });
    const product = await make(marker);
    createdId = product.id;
    const competitor = await make(`UI重复码占位-${stamp}`);
    otherId = competitor.id;
    let other = await call(`/admin/products/${otherId}/skus/${competitor.skus[0].id}/set-barcode`, {
      version: 0,
      barcode: taken,
    });
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '商品管理', exact: true })
      .click();
    await page.getByRole('button', { name: '刷新', exact: false }).first().click();
    const search = page.getByRole('textbox', { name: '搜索商品' });
    await search.fill(marker);
    const dialog = page.getByRole('dialog'),
      barcode = dialog.getByLabel('商品条码', { exact: true });
    const open = async () => {
      await page.getByRole('button', { name: '条码', exact: true }).click();
      await barcode.waitFor();
    };
    await open();
    await barcode.fill(taken);
    await dialog.getByRole('button', { name: '保存条码', exact: true }).click();
    await dialog
      .getByText('条码已绑定其他规格，请核对；停用规格也保留绑定', { exact: true })
      .waitFor();
    assert(!(await barcode.isDisabled()));
    await barcode.fill(own);
    await page.screenshot({
      path: path.resolve('docs/verification/UI-BARCODE-LIVE-DESKTOP-2026-10-30.png'),
    });
    await dialog.getByRole('button', { name: '保存条码', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const saved = await call(`/admin/products/${createdId}`);
    const expected = structuredClone(product);
    expected.version = 1;
    expected.skus[0].barcode = own;
    assert.deepEqual(saved, expected);
    await search.fill(own);
    await page.getByText(marker, { exact: true }).waitFor();
    await page.getByRole('button', { name: '上架', exact: true }).click();
    await page.getByRole('button', { name: '下架', exact: true }).waitFor();
    const saleBefore = await call(`/products/${product.skus[0].id}`);
    await open();
    await barcode.fill('');
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: path.resolve('docs/verification/UI-BARCODE-LIVE-MOBILE-2026-10-30.png'),
    });
    await dialog.getByRole('button', { name: '保存条码', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByText('没有找到符合条件的商品', { exact: true }).waitFor();
    await search.fill(marker);
    const cleared = await call(`/admin/products/${createdId}`);
    assert.equal(cleared.skus[0].barcode, null);
    assert.equal(cleared.status, 'PUBLISHED');
    assert.deepEqual(await call(`/products/${product.skus[0].id}`), saleBefore);
    other = await call(`/admin/products/${otherId}/skus/${competitor.skus[0].id}/set-barcode`, {
      version: other.version,
      barcode: own,
    });
    assert.equal(other.skus[0].barcode, own);
    other = await call(`/admin/products/${otherId}/skus/${competitor.skus[0].id}/set-barcode`, {
      version: other.version,
      barcode: null,
    });
    assert.deepEqual(await call(stockPath), beforeStock);
    await page.getByRole('button', { name: '下架', exact: true }).click();
    await page.getByRole('button', { name: '上架', exact: true }).waitFor();
    await call(`/products/${product.skus[0].id}`, undefined, 404);
    fs.writeFileSync(
      '.local/barcode-live.json',
      JSON.stringify(
        {
          id: createdId,
          otherId,
          status: 'UNPUBLISHED',
          leadingZerosPreserved: true,
          duplicateRejectedInUI: true,
          barcodeSearch: true,
          cleared: true,
          reusedAfterClear: true,
          syntheticBindingsCleared: true,
          stockUnchanged: true,
          publicUnchanged: true,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'Live barcode UI passed: duplicate rejection, leading zeros, binding, loaded search, clear, reuse, public/stock unchanged; synthetic product UNPUBLISHED and both bindings cleared.',
    );
  } finally {
    if (createdId && profile) {
      const current = await call(`/admin/products/${createdId}`);
      if (current.status === 'PUBLISHED')
        await call(`/admin/products/${createdId}/unpublish`, { version: current.version });
    }
    for (const id of [createdId, otherId].filter(Boolean)) {
      const current = await call(`/admin/products/${id}`);
      if (current.skus[0].barcode !== null)
        await call(`/admin/products/${id}/skus/${current.skus[0].id}/set-barcode`, {
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
