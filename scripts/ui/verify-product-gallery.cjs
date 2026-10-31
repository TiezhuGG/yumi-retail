// Synthetic browser states; real API/storage are verified separately.
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const bytes = fs.readFileSync('tests/fixtures/image-red.png');
    const profile = {
      id: 'fixture',
      displayName: '合成图片集验收',
      roles: ['SUPER_ADMIN'],
      permissions: ['catalog.read', 'catalog.write'],
      warehouseIds: [],
      csrfToken: 'fixture',
    };
    const product = {
      id: 'p1',
      categoryId: 'c1',
      name: '合成多图商品',
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
        },
      ],
    };
    let images = [],
      mode = 'normal',
      detailFail = true,
      readFail = false,
      count = 0,
      refreshFail = false;
    const attempts = [],
      replays = new Map();
    const gallery = () => ({ product: { ...product }, images: images.map((i) => ({ ...i })) });
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
      else if (p.endsWith('/admin/products')) data = { items: [product], nextCursor: null };
      else if (p.endsWith('/admin/products/p1/images')) {
        if (detailFail || refreshFail) {
          await new Promise((r) => setTimeout(r, 600));
          return route.fulfill({ status: 503, json: { error: { message: '合成图片读取失败' } } });
        }
        data = gallery();
      } else if (/\/(add-image|set-images)$/.test(p)) {
        const body = req.postDataJSON(),
          key = req.headers()['idempotency-key'];
        attempts.push({ p, body, key });
        if (mode === 'conflict')
          return route.fulfill({
            status: 409,
            json: { error: { code: 'VERSION_CONFLICT', message: '商品已更新，请载入最新资料' } },
          });
        if (replays.has(key)) data = replays.get(key);
        else {
          if (p.endsWith('/add-image')) {
            const id = `i${++count}`;
            images.push({ id, url: `/api/v1/admin/products/p1/image/${id}` });
          } else images = body.imageIds.map((id) => images.find((i) => i.id === id));
          product.imageId = images[0]?.id || null;
          product.version++;
          data = gallery();
          replays.set(key, data);
          if (mode === 'unknown') {
            // Simulate a later edit after the original committed but its response was lost.
            images.reverse();
            product.imageId = images[0]?.id || null;
            product.version++;
            mode = 'normal';
            return route.abort('failed');
          }
          if (mode === 'refresh-fail') refreshFail = true;
        }
      } else data = { items: [], nextCursor: null };
      return route.fulfill({ json: { data } });
    });
    await page.goto('http://127.0.0.1:5173/');
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '商品管理', exact: true })
      .click();
    const dialog = page.getByRole('dialog');
    const shot = async (name) => {
      await dialog.evaluate((el) => {
        el.scrollTop = 0;
      });
      await page.screenshot({
        path: path.resolve(`docs/verification/UI-PRODUCT-GALLERY-${name}-2026-10-31.png`),
      });
    };
    await page.getByRole('button', { name: '图片', exact: true }).click();
    await dialog.getByText('正在读取商品图片…', { exact: true }).waitFor();
    await shot('LOADING');
    await dialog.getByRole('button', { name: '重新读取图片资料' }).waitFor();
    await shot('ERROR');
    detailFail = false;
    await dialog.getByRole('button', { name: '重新读取图片资料' }).click();
    await dialog.getByText('暂无商品图片，顾客将看到包装示意。', { exact: true }).waitFor();
    await shot('EMPTY');
    const input = dialog.getByLabel('添加商品图片', { exact: true });
    await input.setInputFiles({
      name: 'bad.svg',
      mimeType: 'image/svg+xml',
      buffer: Buffer.from('<svg/>'),
    });
    await dialog.getByText('请选择2MB以内的PNG/JPEG文件', { exact: true }).waitFor();
    const upload = async () => {
      await input.setInputFiles(path.resolve('tests/fixtures/image-red.png'));
      await dialog.getByRole('img', { name: '待添加图片预览' }).waitFor();
      await dialog.getByRole('button', { name: '上传并添加图片', exact: true }).click();
    };
    await input.setInputFiles(path.resolve('tests/fixtures/image-red.png'));
    await dialog.getByRole('img', { name: '待添加图片预览' }).waitFor();
    await dialog.getByRole('button', { name: '取消选择', exact: true }).click();
    assert.equal(await dialog.getByRole('img', { name: '待添加图片预览' }).count(), 0);
    mode = 'conflict';
    await upload();
    await dialog.getByRole('button', { name: '载入最新资料（替换当前选择）' }).waitFor();
    assert(await input.isDisabled());
    await shot('CONFLICT');
    mode = 'normal';
    await dialog.getByRole('button', { name: '载入最新资料（替换当前选择）' }).click();
    await input.waitFor();
    await upload();
    await dialog.getByText('1 / 6 张', { exact: true }).waitFor();
    mode = 'unknown';
    await upload();
    await dialog.getByRole('button', { name: '使用原操作重试确认' }).waitFor();
    assert(await input.isDisabled());
    await shot('UNKNOWN');
    const original = attempts.at(-1);
    await dialog.getByRole('button', { name: '使用原操作重试确认' }).click();
    await dialog.getByText('2 / 6 张', { exact: true }).waitFor();
    assert.deepEqual(attempts.at(-1), original);
    assert.equal(
      await dialog.locator('.gallery-tile').first().locator('img').getAttribute('src'),
      images[0].url,
    );
    await dialog.getByRole('button', { name: '图片1后移', exact: true }).click();
    assert(await input.isDisabled());
    await dialog.getByRole('button', { name: '撤销顺序和移除' }).click();
    assert(!(await input.isDisabled()));
    await dialog.locator('.gallery-tile').nth(1).getByRole('button', { name: '设为主图' }).click();
    await dialog.getByRole('button', { name: '保存顺序和移除' }).click();
    await dialog.getByText('图片操作已确认，已读取当前图片集。', { exact: true }).waitFor();
    for (let i = 2; i < 6; i++) {
      await upload();
      await dialog.getByText(`${i + 1} / 6 张`, { exact: true }).waitFor();
    }
    assert(await input.isDisabled());
    await shot('DESKTOP');
    for (const width of [320, 375, 414]) {
      await page.setViewportSize({ width, height: 812 });
      assert(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
      assert(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth + 1,
        ),
      );
    }
    await shot('MOBILE');
    await dialog.getByRole('button', { name: '移除图片1', exact: true }).click();
    assert(await input.isDisabled());
    await dialog.getByRole('button', { name: '保存顺序和移除' }).click();
    await dialog.getByText('5 / 6 张', { exact: true }).waitFor();
    assert(!(await input.isDisabled()));
    mode = 'refresh-fail';
    await upload();
    await dialog
      .getByText('图片操作已确认，但当前资料读取失败，请载入最新资料后继续。', { exact: true })
      .waitFor();
    assert(await input.isDisabled());
    refreshFail = false;
    mode = 'normal';
    readFail = true;
    await dialog.getByRole('button', { name: '载入最新资料（替换当前选择）' }).click();
    await dialog.getByText('图片读取失败', { exact: true }).first().waitFor();
    await shot('READ-ERROR');
    readFail = false;
    await dialog.getByRole('button', { name: '重试图片', exact: true }).first().click();
    await dialog.locator('.gallery-tile img').first().waitFor();
    await dialog.getByRole('button', { name: '关闭并刷新列表', exact: true }).click();
    profile.permissions = ['catalog.read'];
    await page.reload();
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '商品管理', exact: true })
      .click();
    await page.getByText('合成多图商品', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '图片', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      'Gallery UI passed: loading/error/empty, validation, cancel, conflict, identical unknown retry, authoritative refresh, order/cover/remove/undo, cap, read retry, read-only and 320/375/414.',
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
