// Synthetic UI responses exercise failures and role navigation, not business/DB acceptance.
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
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const profile = {
      id: 'ui-staff',
      displayName: 'UI合成仓管',
      roles: ['WAREHOUSE_MANAGER'],
      permissions: ['catalog.read', 'catalog.write', 'stock.read', 'receipt.read'],
      warehouseIds: ['w1', 'w2'],
      csrfToken: 'fixture',
    };
    let productMode = 'normal',
      categoryMode = 'normal',
      receiptMode = 'error',
      stockMode = 'normal',
      warehouseMode = 'normal';
    let slowWarehouse = false,
      failAfterSave = false,
      creates = 0;
    const products = [
      {
        id: 'p1',
        name: '合成纸巾',
        categoryId: 'c1',
        status: 'PUBLISHED',
        version: 1,
        skus: [
          {
            id: 's1',
            code: 'UI-001',
            spec: '3包装',
            unit: '包',
            priceCents: 2990,
            expiryManaged: false,
          },
        ],
      },
    ];
    const categories = [{ id: 'c1', name: '合成日用', parentId: null, enabled: true }];
    await page.route('**/api/v1/**', async (route) => {
      const req = route.request(),
        url = new URL(req.url()),
        p = url.pathname;
      let mode = 'normal',
        items = [],
        data;
      if (p.endsWith('/staff/me')) data = profile;
      else if (p.endsWith('/warehouses')) {
        mode = warehouseMode;
        data = {
          items:
            warehouseMode === 'empty'
              ? []
              : [
                  { id: 'w1', name: '合成仓一' },
                  { id: 'w2', name: '合成仓二' },
                ],
        };
      } else if (p.endsWith('/admin/products')) {
        mode = productMode;
        items = products;
      } else if (p.endsWith('/admin/categories')) {
        if (req.method() === 'POST') {
          creates++;
          failAfterSave = true;
          data = { id: 'saved' };
        } else {
          mode = failAfterSave ? 'error' : categoryMode;
          items = categories;
        }
      } else if (p.endsWith('/receipts')) {
        mode = receiptMode;
      } else if (p.endsWith('/stock')) {
        mode = stockMode;
        items = [
          {
            id: 'st1',
            skuId: 's1',
            onHand: p.includes('/w2/') ? 77 : 12,
            reserved: 2,
            blocked: 1,
            safety: 1,
            inventoryHold: false,
            activeCountId: null,
          },
        ];
        if (slowWarehouse && p.includes('/w1/')) await new Promise((r) => setTimeout(r, 800));
      }
      if (mode === 'slow') await new Promise((r) => setTimeout(r, 1800));
      if (mode === 'error')
        return route.fulfill({ status: 503, json: { error: { message: '合成连接失败' } } });
      await route.fulfill({
        json: { data: data || { items: mode === 'empty' ? [] : items, nextCursor: null } },
      });
    });
    const nav = (name) =>
      page
        .getByRole('navigation', { name: '主导航' })
        .getByRole('button', { name, exact: true })
        .click();
    const shot = (name) =>
      page.screenshot({
        path: path.resolve('docs/verification', `UI-LISTS-${name}-2026-10-29.png`),
        fullPage: true,
      });
    const noOverflow = async () =>
      assert(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth + 1,
        ),
        'document horizontal overflow',
      );
    await page.goto('http://127.0.0.1:5173/');
    await page.getByRole('button', { name: '重试收货待办' }).waitFor();
    assert.equal(await page.getByText('✓ 暂无收货待办', { exact: true }).count(), 0);
    assert.match(
      await page.locator('.stat-card').filter({ hasText: '待处理收货' }).innerText(),
      /暂不可用/,
    );
    await shot('OVERVIEW-ERROR');
    await nav('库存总览');
    await page.getByText('合成纸巾', { exact: true }).waitFor(); // Receipt failure must not block stock.
    assert.match(await page.locator('tbody').innerText(), /12/);
    slowWarehouse = true;
    await page.getByRole('button', { name: '刷新库存', exact: false }).click();
    await page.getByRole('combobox', { name: '作业仓库' }).selectOption('w2');
    await page.getByRole('cell', { name: '77', exact: true }).waitFor();
    await page.waitForTimeout(1000);
    assert.equal(await page.getByRole('cell', { name: '12', exact: true }).count(), 0);
    slowWarehouse = false;
    await nav('商品管理');
    await page.getByRole('textbox', { name: '搜索商品' }).fill('找不到');
    await page.getByText('没有找到符合条件的商品', { exact: true }).waitFor();
    await shot('PRODUCTS-FILTER-EMPTY');
    await nav('库存总览');
    assert.equal(await page.getByRole('textbox', { name: '搜索库存' }).inputValue(), '');
    await page.getByText('合成纸巾', { exact: true }).waitFor();
    await nav('商品管理');
    for (const mode of ['slow', 'error', 'empty', 'normal']) {
      productMode = mode;
      await page.getByRole('button', { name: '刷新', exact: false }).first().click();
      await page
        .getByText(
          mode === 'slow'
            ? '正在加载商品…'
            : mode === 'error'
              ? '商品加载失败：合成连接失败'
              : mode === 'empty'
                ? '没有找到符合条件的商品'
                : '合成纸巾',
          { exact: mode !== 'error' },
        )
        .waitFor();
      if (mode !== 'normal') await shot(`PRODUCTS-${mode.toUpperCase()}`);
      if (mode === 'slow')
        await page.getByText('正在加载商品…', { exact: true }).waitFor({ state: 'hidden' });
    }
    await nav('商品分类');
    for (const mode of ['slow', 'empty', 'normal']) {
      categoryMode = mode;
      await page.getByRole('button', { name: '刷新分类', exact: false }).click();
      if (mode === 'slow') {
        await page.getByText('正在加载分类…', { exact: true }).waitFor();
        await shot('CATEGORIES-SLOW');
        await page.getByText('正在加载分类…', { exact: true }).waitFor({ state: 'hidden' });
      } else if (mode === 'empty') {
        await page.getByText('还没有商品分类，先为好物建立分类吧。').waitFor();
        await shot('CATEGORIES-EMPTY');
      } else await page.getByText('合成日用', { exact: false }).waitFor();
    }
    categoryMode = 'error';
    await page.getByRole('button', { name: '刷新分类', exact: false }).click();
    await page.getByRole('button', { name: '重试分类', exact: true }).waitFor();
    await shot('CATEGORIES-ERROR');
    categoryMode = 'normal';
    await page.getByRole('button', { name: '重试分类', exact: true }).click();
    await page.getByRole('button', { name: '新增分类', exact: false }).click();
    await page
      .getByRole('dialog')
      .getByRole('textbox', { name: '分类名称' })
      .fill('合成保存刷新失败');
    await page.getByRole('button', { name: '保存分类', exact: true }).click();
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByText('分类已保存，列表刷新失败，请重试刷新。', { exact: true }).waitFor();
    assert.equal(creates, 1);
    failAfterSave = false;
    profile.roles = ['PICKER'];
    profile.permissions = ['catalog.read', 'stock.read'];
    await page.reload();
    await nav('库存总览');
    assert.equal(await page.getByRole('button', { name: '收货入库', exact: false }).count(), 0);
    for (const mode of ['slow', 'empty', 'normal']) {
      stockMode = mode;
      await page.getByRole('button', { name: '刷新库存', exact: false }).click();
      if (mode === 'slow') {
        await page.getByText('正在加载库存…', { exact: true }).waitFor();
        await shot('STOCK-SLOW');
        await page.getByText('正在加载库存…', { exact: true }).waitFor({ state: 'hidden' });
      } else if (mode === 'empty') {
        await page.getByText('暂无匹配库存，可调整搜索条件或刷新。').waitFor();
        await shot('STOCK-EMPTY');
      } else await page.getByText('合成纸巾', { exact: true }).waitFor();
    }
    stockMode = 'error';
    await page.getByRole('button', { name: '刷新库存', exact: false }).click();
    await page.getByRole('button', { name: '重试库存', exact: true }).waitFor();
    await page.setViewportSize({ width: 375, height: 812 });
    await noOverflow();
    await shot('STOCK-MOBILE-ERROR');
    stockMode = 'normal';
    await page.getByRole('button', { name: '重试库存', exact: true }).click();
    await page.getByRole('button', { name: '重试库存', exact: true }).waitFor({ state: 'hidden' });
    await shot('STOCK-MOBILE');
    for (const mode of ['error', 'empty']) {
      warehouseMode = mode;
      await page.reload();
      await nav('库存总览');
      await page
        .getByText(mode === 'error' ? '合成连接失败' : '暂无授权仓库，请联系管理员分配。', {
          exact: mode !== 'error',
        })
        .waitFor();
      await shot(`WAREHOUSE-${mode.toUpperCase()}`);
    }
    warehouseMode = 'normal';
    profile.roles = ['WAREHOUSE_MANAGER'];
    profile.permissions = ['catalog.read', 'stock.read', 'receipt.read'];
    await page.goto('http://127.0.0.1:5174/');
    await page.getByRole('heading', { name: '工作台', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '整理商品', exact: false }).count(), 0);
    assert.equal(await page.locator('.stat-card').filter({ hasText: '商品档案' }).count(), 0);
    await shot('OPS-OVERVIEW');
    profile.roles = ['PICKER'];
    profile.permissions = ['catalog.read', 'stock.read'];
    await page.reload();
    await page.getByRole('heading', { name: '库存总览', exact: true }).waitFor();
    assert.equal(
      await page.getByRole('navigation', { name: '主导航' }).getByRole('button').count(),
      2,
    );
    for (const width of [320, 375, 414]) {
      await page.setViewportSize({ width, height: 812 });
      await noOverflow();
    }
    await shot('OPS-PICKER');
    assert.deepEqual(errors, []);
    console.log(
      'List UI passed: independent failures/retry/loading/empty, accurate unavailable metrics, warehouse race, filter reset, acknowledged save + failed refresh, desktop/mobile picker and mobile manager navigation, 320/375/414 layout. Synthetic responses only.',
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
