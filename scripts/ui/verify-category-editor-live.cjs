// Opt-in local synthetic writes. Leaves one UNPUBLISHED product, two categories and audit history.
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
    const marker = Date.now();
    const parent = await call('/admin/categories', { name: `UI父分类实链-${marker}` });
    const child = await call('/admin/categories', {
      name: `UI子分类实链-${marker}`,
      parentId: parent.id,
    });
    const warehouse = (await call('/warehouse/warehouses')).items[0];
    const stockPath = `/warehouse/warehouses/${warehouse.id}/stock?limit=50`,
      beforeStock = await call(stockPath);
    const product = await call('/admin/products', {
      categoryId: child.id,
      name: `UI分类验证商品-${marker}`,
      description: '本地合成分类维护验证',
      skus: [
        {
          code: `UICAT-${marker}`,
          spec: '3包装',
          unit: '包',
          priceCents: 719,
          expiryManaged: false,
        },
      ],
    });
    createdId = product.id;
    const published = await call(`/admin/products/${product.id}/publish`, {
      version: product.version,
    });
    const publicBefore = await call(`/products/${product.skus[0].id}`);
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '商品分类', exact: true })
      .click();
    await page.getByRole('button', { name: '↻ 刷新分类', exact: true }).click();
    const dialog = page.getByRole('dialog');
    const parentRow = page
      .getByRole('row')
      .filter({ has: page.getByText('▤　' + parent.name, { exact: true }) });
    const childRow = () => page.getByRole('row').filter({ hasText: `UI子分类实链-${marker}` });
    const open = async (row) => {
      await row.getByRole('button', { name: '维护分类', exact: true }).click();
      await dialog.getByLabel('分类名称', { exact: true }).waitFor();
    };
    await open(childRow());
    await dialog.getByLabel('分类名称', { exact: true }).fill(child.name + '-更新');
    await page.screenshot({
      path: path.resolve('docs/verification/UI-CATEGORY-LIVE-DESKTOP-2026-10-30.png'),
    });
    await dialog.getByRole('button', { name: '保存名称', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const renamed = await call(`/admin/categories/${child.id}`);
    assert.equal(renamed.name, child.name + '-更新');
    assert.equal(renamed.version, 1);
    await open(parentRow);
    await dialog.getByRole('button', { name: '停用分类', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await call(`/products/${product.skus[0].id}`, undefined, 404);
    const hiddenChild = await call(`/admin/categories/${child.id}`);
    assert.equal(hiddenChild.enabled, true);
    assert.equal(hiddenChild.version, 1);
    assert.equal(hiddenChild.parent.enabled, false);
    await open(childRow());
    await page.setViewportSize({ width: 375, height: 812 });
    await dialog.getByText(/父分类已停用，此分类下商品/).waitFor();
    await page.screenshot({
      path: path.resolve('docs/verification/UI-CATEGORY-LIVE-MOBILE-2026-10-30.png'),
    });
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await open(parentRow);
    await dialog.getByRole('button', { name: '启用分类', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(await call(`/products/${product.skus[0].id}`), publicBefore);
    await open(childRow());
    await dialog.getByRole('button', { name: '停用分类', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await call(`/products/${product.skus[0].id}`, undefined, 404);
    await open(childRow());
    await dialog.getByRole('button', { name: '启用分类', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(await call(`/products/${product.skus[0].id}`), publicBefore);
    const current = await call(`/admin/products/${product.id}`);
    assert.deepEqual(current, published);
    assert.deepEqual(await call(stockPath), beforeStock);
    await call(`/admin/products/${product.id}/unpublish`, { version: current.version });
    await open(parentRow);
    await dialog.getByRole('button', { name: '停用分类', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    fs.writeFileSync(
      '.local/category-live.json',
      JSON.stringify(
        {
          parentId: parent.id,
          childId: child.id,
          productId: createdId,
          productFinalStatus: 'UNPUBLISHED',
          parentFinalEnabled: false,
          childVersion: 3,
          parentVersion: 3,
          renamed: true,
          ancestorHideRestore: true,
          childHideRestore: true,
          productSkuUnchanged: true,
          stockUnchanged: true,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'Live category UI passed: child rename, parent/child disable-enable visibility, parent effect without rewriting child/product/SKU/stock; product left UNPUBLISHED and synthetic parent disabled.',
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
