// Local opt-in image/catalog writes: synthetic PNG/JPEG fixtures, retained image metadata/objects, final product UNPUBLISHED without cover.
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
    const marker = `UI主图实链-${Date.now()}`;
    const product = await call('/admin/products', {
      categoryId: category.id,
      name: marker,
      description: '纯色合成图片，仅本地验收',
      skus: [
        {
          code: `UIPIC-${Date.now()}`,
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
      await page.getByRole('button', { name: '主图', exact: true }).click();
      await dialog.getByLabel('选择主图', { exact: true }).waitFor();
    };
    await open();
    await dialog
      .getByLabel('选择主图', { exact: true })
      .setInputFiles(path.resolve('tests/fixtures/image-red.png'));
    await dialog.getByRole('img', { name: '待保存主图预览' }).waitFor();
    await page.screenshot({
      path: path.resolve('docs/verification/UI-PRODUCT-IMAGE-LIVE-DESKTOP-2026-10-31.png'),
    });
    await dialog.getByRole('button', { name: '上传并保存主图', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const first = await call(`/admin/products/${createdId}`);
    assert(first.imageId);
    assert.equal(first.version, 1);
    assert.deepEqual(first.skus, product.skus);
    const publicPath = (current) => `/product-images/${current.id}/${current.imageId}`;
    const read = async (route, expected) => {
      const response = await page.request.get(base + route);
      assert.equal(response.status(), expected);
      if (expected === 200) {
        assert.equal(response.headers()['content-type'], 'image/png');
        assert.deepEqual(
          (await response.body()).subarray(0, 8),
          Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
        );
      }
    };
    await read(publicPath(first), 404);
    await read(`/admin/products/${createdId}/image/${first.imageId}`, 200);
    await page.getByRole('button', { name: '上架', exact: true }).click();
    await page.getByRole('button', { name: '下架', exact: true }).waitFor();
    await read(publicPath(first), 200);
    assert.equal(
      (await call(`/products/${product.skus[0].id}`)).imageUrl,
      '/api/v1' + publicPath(first),
    );
    await open();
    await dialog
      .getByLabel('选择主图', { exact: true })
      .setInputFiles(path.resolve('tests/fixtures/image-blue.jpg'));
    await dialog.getByRole('img', { name: '待保存主图预览' }).waitFor();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.screenshot({
      path: path.resolve('docs/verification/UI-PRODUCT-IMAGE-LIVE-MOBILE-2026-10-31.png'),
    });
    await dialog.getByRole('button', { name: '上传并保存主图', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const second = await call(`/admin/products/${createdId}`);
    assert.notEqual(second.imageId, first.imageId);
    assert.equal(second.status, 'PUBLISHED');
    assert.equal(second.version, 3);
    assert.deepEqual(second.skus, product.skus);
    await read(publicPath(first), 404);
    await read(publicPath(second), 200);
    await open();
    await dialog.getByRole('button', { name: '移除主图', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const cleared = await call(`/admin/products/${createdId}`);
    assert.equal(cleared.imageId, null);
    assert.equal(cleared.version, 4);
    await read(publicPath(second), 404);
    assert.equal((await call(`/products/${product.skus[0].id}`)).imageUrl, null);
    assert.deepEqual(await call(stockPath), beforeStock);
    await page.getByRole('button', { name: '下架', exact: true }).click();
    await page.getByRole('button', { name: '上架', exact: true }).waitFor();
    fs.writeFileSync(
      '.local/product-image-live.json',
      JSON.stringify(
        {
          id: createdId,
          status: 'UNPUBLISHED',
          imageId: null,
          pngUpload: true,
          jpegNormalized: true,
          draftPrivate: true,
          publishedReadable: true,
          oldUrlsRevoked: true,
          removed: true,
          skuUnchanged: true,
          stockUnchanged: true,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'Live product image passed: PNG upload, draft auth, public publish, JPEG normalized replacement, old URL revoked, removal fallback, unchanged SKU/stock; synthetic product UNPUBLISHED.',
    );
  } finally {
    if (createdId && profile) {
      const current = await call(`/admin/products/${createdId}`);
      if (current.imageId)
        await call(`/admin/products/${createdId}/set-image`, {
          version: current.version,
          image: null,
        });
      const latest = await call(`/admin/products/${createdId}`);
      if (latest.status === 'PUBLISHED')
        await call(`/admin/products/${createdId}/unpublish`, { version: latest.version });
    }
    if (profile) await call('/staff/auth/logout', {});
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
