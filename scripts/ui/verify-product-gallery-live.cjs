// Local opt-in gallery writes; synthetic products are cleared and unpublished in finally.
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
    const marker = `UI多图实链-${Date.now()}`;
    const product = await call('/admin/products', {
      categoryId: category.id,
      name: marker,
      description: '纯色合成图片，仅本地验收',
      skus: [
        {
          code: `UIGALLERY-${Date.now()}`,
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
    await page.getByRole('button', { name: '图片', exact: true }).click();
    const input = dialog.getByLabel('添加商品图片', { exact: true });
    const galleryPath = `/admin/products/${createdId}/images`;
    const upload = async (file, count) => {
      await input.setInputFiles(path.resolve(`tests/fixtures/${file}`));
      await dialog.getByRole('img', { name: '待添加图片预览' }).waitFor();
      await dialog.getByRole('button', { name: '上传并添加图片', exact: true }).click();
      await dialog.getByText(`${count} / 6 张`, { exact: true }).waitFor();
    };
    await upload('image-red.png', 1);
    let gallery = await call(galleryPath);
    const first = gallery.images[0].id;
    assert.equal(gallery.product.imageId, first);
    assert.equal(
      (await page.request.get(base + `/product-images/${createdId}/${first}`)).status(),
      404,
    );
    assert.equal(
      (await page.request.get(base + `/admin/products/${createdId}/image/${first}`)).status(),
      200,
    );
    await upload('image-blue.jpg', 2);
    gallery = await call(galleryPath);
    const second = gallery.images[1].id;
    assert.equal(gallery.product.version, 2);
    await dialog.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.screenshot({
      path: path.resolve('docs/verification/UI-PRODUCT-GALLERY-LIVE-DESKTOP-2026-10-31.png'),
    });
    await dialog
      .locator('.gallery-tile')
      .nth(1)
      .getByRole('button', { name: '设为主图', exact: true })
      .click();
    await dialog.getByRole('button', { name: '保存顺序和移除', exact: true }).click();
    await dialog.getByText('图片操作已确认，已读取当前图片集。', { exact: true }).waitFor();
    gallery = await call(galleryPath);
    assert.deepEqual(
      gallery.images.map((i) => i.id),
      [second, first],
    );
    assert.equal(gallery.product.imageId, second);
    await page.setViewportSize({ width: 375, height: 812 });
    await dialog.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.screenshot({
      path: path.resolve('docs/verification/UI-PRODUCT-GALLERY-LIVE-MOBILE-2026-10-31.png'),
    });
    await dialog.getByRole('button', { name: '关闭并刷新列表', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '上架', exact: true }).click();
    await page.getByRole('button', { name: '下架', exact: true }).waitFor();
    const sale = await call(`/products/${product.skus[0].id}`);
    assert.deepEqual(
      sale.imageUrls,
      [second, first].map((id) => `/api/v1/product-images/${createdId}/${id}`),
    );
    assert.equal(sale.imageUrl, sale.imageUrls[0]);
    for (const id of [first, second]) {
      const response = await page.request.get(base + `/product-images/${createdId}/${id}`);
      assert.equal(response.status(), 200);
      assert.equal(response.headers()['content-type'], 'image/png');
      assert.deepEqual(
        (await response.body()).subarray(0, 8),
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
    }
    await page.getByRole('button', { name: '图片', exact: true }).click();
    await dialog.getByText('2 / 6 张', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: '移除图片1', exact: true }).click();
    await dialog.getByRole('button', { name: '保存顺序和移除', exact: true }).click();
    await dialog.getByText('1 / 6 张', { exact: true }).waitFor();
    gallery = await call(galleryPath);
    assert.equal(gallery.product.imageId, first);
    assert.equal(
      (await page.request.get(base + `/product-images/${createdId}/${second}`)).status(),
      404,
    );
    await dialog.getByRole('button', { name: '移除图片1', exact: true }).click();
    await dialog.getByRole('button', { name: '保存顺序和移除', exact: true }).click();
    await dialog.getByText('0 / 6 张', { exact: true }).waitFor();
    const cleared = await call(galleryPath);
    assert.equal(cleared.product.imageId, null);
    assert.equal(cleared.product.status, 'PUBLISHED');
    assert.deepEqual(cleared.product.skus, product.skus);
    assert.deepEqual((await call(`/products/${product.skus[0].id}`)).imageUrls, []);
    assert.equal(
      (await page.request.get(base + `/product-images/${createdId}/${first}`)).status(),
      404,
    );
    assert.deepEqual(await call(stockPath), beforeStock);
    await dialog.getByRole('button', { name: '关闭并刷新列表', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '下架', exact: true }).click();
    await page.getByRole('button', { name: '上架', exact: true }).waitFor();
    fs.writeFileSync(
      '.local/product-gallery-live.json',
      JSON.stringify(
        {
          id: createdId,
          status: 'UNPUBLISHED',
          imageId: null,
          pngAndJpegUpload: true,
          orderedCover: true,
          publicURLs: true,
          removalRevokes: true,
          skuUnchanged: true,
          stockUnchanged: true,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      'Live gallery passed: browser PNG/JPEG append, order/cover, publish, all images public, removal/promotion/revocation, empty fallback and SKU/stock unchanged. Synthetic product unpublished.',
    );
  } finally {
    if (createdId && profile) {
      const current = await call(`/admin/products/${createdId}`);
      const gallery = await call(`/admin/products/${createdId}/images`);
      if (gallery.images.length)
        await call(`/admin/products/${createdId}/set-images`, {
          version: current.version,
          imageIds: [],
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
