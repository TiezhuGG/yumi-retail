// Synthetic UI responses. PNG/JPEG, DB and storage behavior are tested separately.
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const bytes = fs.readFileSync(
      path.join(
        path.dirname(require.resolve('../../package.json')),
        'tests/fixtures/image-red.png',
      ),
    );
    const profile = {
      id: 'fixture',
      displayName: '合成主图验收',
      roles: ['SUPER_ADMIN'],
      permissions: ['catalog.read', 'catalog.write'],
      warehouseIds: [],
      csrfToken: 'fixture',
    };
    let current = {
      id: 'p1',
      categoryId: 'c1',
      name: '合成图片商品',
      description: '',
      status: 'PUBLISHED',
      version: 0,
      imageId: null,
      skus: [
        {
          id: 's1',
          productId: 'p1',
          code: 'FIXTURE',
          spec: '3包装',
          unit: '包',
          priceCents: 719,
          enabled: true,
          expiryManaged: false,
          barcode: null,
        },
      ],
    };
    let detailFail = true,
      readFail = false,
      listFail = false,
      mode = 'conflict';
    const attempts = [],
      replay = new Map();
    await page.route('**/api/v1/**', async (route) => {
      const req = route.request(),
        p = new URL(req.url()).pathname;
      let data;
      if (/\/image\//.test(p))
        return route.fulfill({
          status: readFail ? 404 : 200,
          contentType: 'image/png',
          body: readFail ? Buffer.alloc(0) : bytes,
        });
      if (p.endsWith('/staff/me')) data = profile;
      else if (p.endsWith('/admin/categories'))
        data = {
          items: [{ id: 'c1', name: '日用品', enabled: true, parentId: null, version: 0 }],
          nextCursor: null,
        };
      else if (p.endsWith('/admin/products')) {
        if (listFail)
          return route.fulfill({ status: 503, json: { error: { message: '合成列表失败' } } });
        data = { items: [current], nextCursor: null };
      } else if (p.endsWith('/admin/products/p1')) {
        if (detailFail) {
          await new Promise((r) => setTimeout(r, 800));
          return route.fulfill({ status: 503, json: { error: { message: '合成主图资料失败' } } });
        }
        data = current;
      } else if (p.endsWith('/set-image')) {
        const body = req.postDataJSON(),
          key = req.headers()['idempotency-key'];
        attempts.push({ body, key });
        if (replay.has(key)) data = replay.get(key);
        else if (mode === 'conflict')
          return route.fulfill({
            status: 409,
            json: { error: { code: 'VERSION_CONFLICT', message: '合成版本冲突' } },
          });
        else {
          current = {
            ...current,
            version: current.version + 1,
            imageId: body.image ? `image-${current.version + 1}` : null,
          };
          data = structuredClone(current);
          replay.set(key, data);
          if (mode === 'unknown') {
            current = { ...current, version: current.version + 1, imageId: 'newer-image' };
            return route.abort('failed');
          }
          if (mode === 'refresh-fail') listFail = true;
        }
      } else throw Error('Unexpected request ' + p);
      return route.fulfill({ json: { data } });
    });
    const dialog = page.getByRole('dialog'),
      open = () => page.getByRole('button', { name: '主图', exact: true }).click();
    const shot = (name) =>
      page.screenshot({
        path: path.resolve(`docs/verification/UI-PRODUCT-IMAGE-${name}-2026-10-31.png`),
      });
    const file = { name: 'fixture.png', mimeType: 'image/png', buffer: bytes };
    await page.goto('http://127.0.0.1:5173/');
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '商品管理', exact: true })
      .click();
    await open();
    await dialog.getByText('正在读取商品主图…').waitFor();
    await shot('LOADING');
    await dialog.getByRole('alert').waitFor();
    await shot('ERROR');
    detailFail = false;
    await dialog.getByRole('button', { name: '重新读取图片资料' }).click();
    await dialog.getByText(/尚未设置主图/).waitFor();
    await shot('EMPTY');
    const input = dialog.getByLabel('选择主图', { exact: true });
    assert(await dialog.getByRole('button', { name: '移除主图' }).isDisabled());
    await input.setInputFiles({
      name: 'bad.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg/>'),
    });
    await dialog.getByText('请选择2MB以内的PNG/JPEG文件', { exact: true }).waitFor();
    await input.setInputFiles(file);
    await dialog.getByRole('img', { name: '待保存主图预览' }).waitFor();
    await dialog.getByRole('button', { name: '上传并保存主图' }).click();
    await dialog.getByText('合成版本冲突', { exact: true }).waitFor();
    assert(await input.isDisabled());
    await shot('CONFLICT');
    current = { ...current, version: 3 };
    mode = 'unknown';
    await dialog.getByRole('button', { name: '载入最新资料（替换当前选择）' }).click();
    await input.setInputFiles(file);
    await dialog.getByRole('button', { name: '上传并保存主图' }).click();
    await dialog.getByRole('button', { name: '使用原操作重试确认' }).waitFor();
    assert(await input.isDisabled());
    await shot('UNKNOWN');
    await dialog.getByRole('button', { name: '使用原操作重试确认' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(attempts.at(-1), attempts.at(-2));
    await page.locator('img.product-art-photo[src$="newer-image"]').waitFor();
    mode = 'success';
    await open();
    await dialog.getByRole('img', { name: '当前商品主图' }).waitFor();
    for (const width of [320, 375, 414]) {
      await page.setViewportSize({ width, height: 812 });
      assert(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
        ),
      );
      assert(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
    }
    await shot('MOBILE');
    await dialog.getByRole('button', { name: '移除主图' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(attempts.at(-1).body.image, null);
    mode = 'refresh-fail';
    await open();
    await input.setInputFiles(file);
    await dialog.getByRole('button', { name: '上传并保存主图' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page
      .getByText('主图操作已确认，但列表刷新失败，请刷新列表核对。', { exact: true })
      .waitFor();
    listFail = false;
    readFail = true;
    await page.reload();
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '商品管理', exact: true })
      .click();
    await open();
    await dialog.getByText('图片加载失败，可重新选图或关闭后重试', { exact: true }).waitFor();
    await shot('READ-ERROR');
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    profile.permissions = ['catalog.read'];
    await page.reload();
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '商品管理', exact: true })
      .click();
    await page.getByText('合成图片商品', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '主图', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      'Product image UI passed: loading/empty/errors, file validation/preview, conflict, frozen identical retry, authoritative refresh, upload/remove, read failure fallback, read-only, 320/375/414.',
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
