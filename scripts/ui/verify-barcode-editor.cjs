// Synthetic UI responses; database and real API behavior are checked separately.
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
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
    const profile = {
      id: 'fixture',
      displayName: '条码合成验证',
      roles: ['SUPER_ADMIN'],
      permissions: ['catalog.read', 'catalog.write'],
      warehouseIds: [],
      csrfToken: 'fixture',
    };
    let current = {
      id: 'p1',
      categoryId: 'c1',
      name: '合成条码商品',
      description: '',
      status: 'PUBLISHED',
      version: 0,
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
      mode = 'duplicate',
      listFail = false;
    const attempts = [],
      replay = new Map();
    await page.route('**/api/v1/**', async (route) => {
      const req = route.request(),
        p = new URL(req.url()).pathname;
      let data;
      if (p.endsWith('/staff/me')) data = profile;
      else if (p.endsWith('/admin/categories'))
        data = {
          items: [{ id: 'c1', name: '日用品', parentId: null, enabled: true, version: 0 }],
          nextCursor: null,
        };
      else if (p.endsWith('/admin/products')) {
        if (listFail)
          return route.fulfill({ status: 503, json: { error: { message: '合成列表失败' } } });
        data = { items: [current], nextCursor: null };
      } else if (p.endsWith('/admin/products/p1')) {
        if (detailFail) {
          await new Promise((r) => setTimeout(r, 800));
          return route.fulfill({ status: 503, json: { error: { message: '合成读取失败' } } });
        }
        data = current;
      } else if (p.endsWith('/set-barcode')) {
        const body = req.postDataJSON(),
          key = req.headers()['idempotency-key'];
        attempts.push({ body, key });
        if (replay.has(key)) data = replay.get(key);
        else if (mode === 'duplicate' || mode === 'conflict')
          return route.fulfill({
            status: 409,
            json: {
              error: {
                code: mode === 'duplicate' ? 'BARCODE_IN_USE' : 'VERSION_CONFLICT',
                message: mode === 'duplicate' ? '合成条码被其他SKU绑定' : '合成商品版本冲突',
              },
            },
          });
        else {
          current = {
            ...current,
            version: current.version + 1,
            skus: [{ ...current.skus[0], barcode: body.barcode }],
          };
          data = structuredClone(current);
          replay.set(key, data);
          if (mode === 'unknown') {
            current = {
              ...current,
              version: current.version + 1,
              skus: [{ ...current.skus[0], barcode: '0000000099999' }],
            };
            return route.abort('failed');
          }
          if (mode === 'refresh-fail') listFail = true;
        }
      } else throw Error('Unexpected request ' + p);
      return route.fulfill({ json: { data } });
    });
    const dialog = page.getByRole('dialog'),
      open = () => page.getByRole('button', { name: '条码', exact: true }).click();
    const navigate = () =>
      page.getByRole('navigation').getByRole('button', { name: '商品管理', exact: true }).click();
    const shot = (name) =>
      page.screenshot({
        path: path.resolve(`docs/verification/UI-BARCODE-${name}-2026-10-30.png`),
      });
    await page.goto('http://127.0.0.1:5173/');
    await navigate();
    await open();
    await dialog.getByText('正在读取最新商品条码…').waitFor();
    await shot('LOADING');
    await dialog.getByRole('alert').waitFor();
    await shot('ERROR');
    detailFail = false;
    await dialog.getByRole('button', { name: '重新读取规格' }).click();
    const barcode = dialog.getByLabel('商品条码', { exact: true });
    await barcode.waitFor();
    assert(await dialog.getByRole('button', { name: '保存条码', exact: true }).isDisabled());
    for (const invalid of ['abc', '123 456', '１２３', '1'.repeat(65)]) {
      await barcode.fill(invalid);
      assert(await dialog.getByRole('button', { name: '保存条码', exact: true }).isDisabled());
    }
    await barcode.fill(' 0012345678901 ');
    await dialog.getByRole('button', { name: '保存条码', exact: true }).click();
    await dialog.getByRole('alert').waitFor();
    assert.equal(attempts.at(-1).body.barcode, '0012345678901');
    assert(!(await barcode.isDisabled()));
    await shot('DUPLICATE');
    mode = 'conflict';
    await barcode.fill('0012345678902');
    await dialog.getByRole('button', { name: '保存条码', exact: true }).click();
    await dialog.getByText('合成商品版本冲突', { exact: true }).waitFor();
    assert(await barcode.isDisabled());
    await shot('CONFLICT');
    current = { ...current, version: 4 };
    mode = 'unknown';
    await dialog.getByRole('button', { name: '载入最新资料（替换当前填写）' }).click();
    await barcode.fill('0000000000042');
    await dialog.getByRole('button', { name: '保存条码', exact: true }).click();
    await dialog.getByRole('button', { name: '使用原内容重试确认' }).waitFor();
    assert(await barcode.isDisabled());
    await shot('UNKNOWN');
    await dialog.getByRole('button', { name: '使用原内容重试确认' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(attempts.at(-1), attempts.at(-2));
    await page.getByText('条码：0000000099999', { exact: true }).waitFor();
    await page.getByRole('textbox', { name: '搜索商品' }).fill('0000000099999');
    await page.getByText('合成条码商品', { exact: true }).waitFor();
    mode = 'success';
    await open();
    await barcode.waitFor();
    for (const width of [320, 375, 414]) {
      await page.setViewportSize({ width, height: 812 });
      assert(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
        ),
      );
      assert(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1));
    }
    await barcode.fill('');
    await shot('MOBILE');
    await dialog.getByRole('button', { name: '保存条码', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(attempts.at(-1).body.barcode, null);
    await page.getByText('没有找到符合条件的商品', { exact: true }).waitFor();
    await page.getByRole('textbox', { name: '搜索商品' }).fill('');
    await page.getByText('条码：未设置', { exact: true }).waitFor();
    mode = 'refresh-fail';
    await open();
    await barcode.fill('0000000011111');
    await dialog.getByRole('button', { name: '保存条码', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page
      .getByText('条码修改已确认，但列表刷新失败，请刷新列表核对当前资料。', { exact: true })
      .waitFor();
    listFail = false;
    profile.permissions = ['catalog.read'];
    await page.reload();
    await navigate();
    await page.getByText('合成条码商品', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '条码', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      'Barcode UI passed: loading/error/retry, null, leading zeros, invalid input, duplicate editable, version conflict, same intent retry/current refresh, loaded search/clear, refresh failure, read-only and 320/375/414.',
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
