// Synthetic errors and late responses. Real API behavior is verified separately.
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
    const errors = [],
      writes = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const profile = {
      id: 'staff',
      displayName: '合成收货条码验收',
      roles: ['WAREHOUSE_MANAGER'],
      permissions: ['catalog.read', 'receipt.read', 'receipt.write', 'stock.read'],
      warehouseIds: ['w1'],
      csrfToken: 'fixture',
    };
    const sku = (id = 's1', enabled = true) => ({
      id,
      productId: 'p1',
      name: '未分页载入的合成抽纸',
      code: id,
      spec: '3包装',
      unit: '包',
      enabled,
      expiryManaged: false,
      priceCents: 999,
      barcode: '0012345678901',
    });
    let fail = true,
      release;
    await page.route('**/api/v1/**', async (route) => {
      const req = route.request(),
        url = new URL(req.url()),
        p = url.pathname;
      let data = { items: [], nextCursor: null };
      if (p.endsWith('/staff/me')) data = profile;
      else if (p.endsWith('/warehouses')) data = { items: [{ id: 'w1', name: '合成授权仓' }] };
      else if (p.endsWith('/skus/by-barcode')) {
        const code = url.searchParams.get('barcode');
        if (code === '11') {
          await new Promise((r) => {
            release = r;
          });
          data = sku('old');
        } else if (code === '00')
          return route.fulfill({ status: 404, json: { error: { message: '合成未找到条码' } } });
        else if (fail)
          return route.fulfill({ status: 503, json: { error: { message: '合成条码网络失败' } } });
        else data = sku('s1', code !== '99');
      } else if (p.endsWith('/receipts') && req.method() === 'POST') {
        writes.push(req.postDataJSON());
        return route.fulfill({
          status: 409,
          json: { error: { message: '合成保存冲突，保留草稿' } },
        });
      }
      return route.fulfill({ json: { data } });
    });
    const shot = (name) =>
      page.screenshot({
        path: path.resolve(`docs/verification/UI-RECEIPT-BARCODE-${name}-2026-10-31.png`),
      });
    await page.goto('http://127.0.0.1:5173/');
    await page
      .getByRole('navigation')
      .getByRole('button', { name: '收货入库', exact: true })
      .click();
    await page.getByRole('button', { name: '新建收货单', exact: false }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('来源单号 / 说明').fill('合成条码草稿');
    const line = dialog.getByRole('region', { name: '收货明细1', exact: true });
    await line.getByLabel('供应批次').fill('ORIGINAL');
    await line.getByLabel('收货数量（件）').fill('7');
    await line.getByLabel('单件成本（元）').fill('0.29');
    const input = line.getByLabel('按条码查找商品'),
      query = () => line.getByRole('button', { name: '查询条码', exact: true }).click();
    await input.fill('0012345678901');
    await input.press('Enter');
    await line.getByText(/合成条码网络失败/).waitFor();
    assert.equal(writes.length, 0);
    await shot('ERROR');
    fail = false;
    await query();
    await line.getByText('未分页载入的合成抽纸', { exact: true }).waitFor();
    assert.equal(await line.locator('select').inputValue(), '');
    await shot('DESKTOP');
    await line.getByRole('button', { name: '选入本行', exact: true }).click();
    assert.equal(await line.locator('select').inputValue(), 's1');
    assert.equal(await line.getByLabel('供应批次').inputValue(), 'ORIGINAL');
    assert.equal(await line.getByLabel('收货数量（件）').inputValue(), '7');
    assert.equal(await line.getByLabel('单件成本（元）').inputValue(), '0.29');
    await input.fill('00');
    await query();
    await line.getByText(/合成未找到条码/).waitFor();
    assert.equal(await line.locator('select').inputValue(), 's1');
    await shot('NOT-FOUND');
    await input.fill('99');
    await query();
    await line.getByText('规格已停用，不能选入收货单。', { exact: true }).waitFor();
    assert(await line.getByRole('button', { name: '选入本行', exact: true }).isDisabled());
    await shot('DISABLED');
    await input.fill('11');
    await query();
    await line.getByRole('status').waitFor();
    await shot('LOADING');
    await input.fill('22');
    await query();
    await line.getByRole('button', { name: '选入本行', exact: true }).waitFor();
    release();
    await page.waitForTimeout(100);
    assert.equal(await line.getByText('old', { exact: true }).count(), 0);
    await dialog.getByRole('button', { name: '添加收货明细', exact: false }).click();
    const second = dialog.getByRole('region', { name: '收货明细2', exact: true });
    await second.getByLabel('按条码查找商品').fill('22');
    await second.getByRole('button', { name: '查询条码', exact: true }).click();
    await second.getByText(/此SKU已在其他明细中/).waitFor();
    assert(await second.getByRole('button', { name: '选入本行', exact: true }).isDisabled());
    await second.getByRole('button', { name: '移除此行' }).click();
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
    await dialog.getByRole('button', { name: '保存收货草稿', exact: true }).click();
    await dialog.getByText('合成保存冲突，保留草稿', { exact: true }).waitFor();
    assert.equal(writes[0].lines[0].skuId, 's1');
    assert.equal(writes[0].lines[0].quantity, 7);
    assert.equal(writes[0].lines[0].unitCostCents, 29);
    assert.equal(await line.getByLabel('供应批次').inputValue(), 'ORIGINAL');
    assert.deepEqual(errors, []);
    console.log(
      'Receipt barcode UI passed: off-page lookup, exact text, Enter does not save, explicit selection, draft preservation, missing/error/disabled/duplicate, late-response discard, real payload and 320/375/414.',
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
