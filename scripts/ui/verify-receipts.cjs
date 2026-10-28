// UI-only synthetic responses; actual costs/stock/permissions are verified separately on PostgreSQL.
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.YUMI_CHROMIUM_PATH || '/usr/bin/google-chrome',
    args: ['--no-sandbox'],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
      timezoneId: 'Asia/Shanghai',
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const profile = {
      id: 'staff',
      displayName: 'UI合成仓管',
      roles: ['WAREHOUSE_MANAGER'],
      warehouseIds: ['w1', 'w2'],
      csrfToken: 'fixture',
      permissions: [
        'catalog.read',
        'stock.read',
        'receipt.read',
        'receipt.write',
        'receipt.approve',
        'receipt.post',
      ],
    };
    const sku = (i) => ({
      id: `sku${i}`,
      productId: `product${i}`,
      code: `UI-${i}`,
      spec: i === 1 ? '3包装' : '1瓶',
      unit: i === 1 ? '包' : '瓶',
      enabled: true,
      expiryManaged: i === 2,
      priceCents: 100,
    });
    const products = [1, 2].map((i) => ({
      id: `product${i}`,
      categoryId: 'category',
      name: i === 1 ? '合成纸巾' : '合成洗衣液',
      status: 'PUBLISHED',
      skus: [sku(i)],
    }));
    const line = (i) => ({
      id: `line${i}`,
      skuId: `sku${i}`,
      batchNo: `UI-BATCH-${i}`,
      quantity: 2,
      unitCostCents: i === 1 ? 29 : 719,
      producedAt: null,
      expiresAt: null,
    });
    let records = ['DRAFT', 'APPROVED', 'POSTED'].map((status, i) => ({
      id: `receipt${i}`,
      warehouseId: 'w1',
      sourceRef: `UI合成收货单-${i + 1}`,
      status,
      version: i,
      lines: [line(1), line(2)],
    }));
    const detailed = (r) => ({
      ...r,
      createdAt: '2026-10-29T01:00:00Z',
      reviewedAt: r.status === 'DRAFT' ? null : '2026-10-29T02:00:00Z',
      postedAt: r.status === 'POSTED' ? '2026-10-29T03:00:00Z' : null,
      lines: r.lines.map((l) => ({
        ...l,
        sku: {
          ...sku(l.skuId === 'sku1' ? 1 : 2),
          name: l.skuId === 'sku1' ? '合成纸巾' : '合成洗衣液',
        },
      })),
    });
    const paged = (items, nextCursor = null) => ({ items, nextCursor, hasMore: !!nextCursor });
    let mode = 'normal',
      detailFail = false,
      reject = true,
      loseCreate = false,
      losePost = false,
      delayW1 = false;
    let advanceOnApprove = false;
    const createKeys = [],
      actionKeys = [],
      postedPayloads = [];
    await page.route('**/api/v1/**', async (route) => {
      const req = route.request(),
        url = new URL(req.url()),
        p = url.pathname;
      let data = paged([]);
      if (p.endsWith('/staff/me')) data = profile;
      else if (p.endsWith('/warehouses'))
        data = {
          items: [
            { id: 'w1', name: 'UI合成仓1' },
            { id: 'w2', name: 'UI合成仓2' },
          ],
        };
      else if (p.endsWith('/admin/products')) data = paged(products);
      else if (p.endsWith('/receipts') && req.method() === 'POST') {
        createKeys.push(req.headers()['idempotency-key']);
        postedPayloads.push(req.postDataJSON());
        if (reject)
          return route.fulfill({
            status: 409,
            json: { error: { message: '合成保存冲突，输入已保留' } },
          });
        let row = records.find((r) => r.id === 'created');
        if (!row) {
          row = {
            id: 'created',
            warehouseId: 'w1',
            sourceRef: req.postDataJSON().sourceRef,
            status: 'DRAFT',
            version: 0,
            lines: req.postDataJSON().lines.map((l, i) => ({ ...l, id: `newLine${i}` })),
          };
          records.push(row);
        }
        if (loseCreate) {
          loseCreate = false;
          return route.abort('failed');
        }
        data = row;
      } else if (/\/receipts\/[^/]+\/(approve|post)$/.test(p)) {
        actionKeys.push(req.headers()['idempotency-key']);
        if (reject)
          return route.fulfill({
            status: 409,
            json: { error: { message: '合成状态冲突，请刷新核验' } },
          });
        const id = p.split('/').at(-2),
          row = records.find((r) => r.id === id);
        row.status = p.endsWith('/post') ? 'POSTED' : 'APPROVED';
        row.version++;
        if (losePost) {
          losePost = false;
          return route.abort('failed');
        }
        data = { ...row };
        if (advanceOnApprove && p.endsWith('/approve')) {
          row.status = 'POSTED';
          row.version++;
          advanceOnApprove = false;
        }
      } else if (/\/receipts\/[^/]+$/.test(p)) {
        if (detailFail)
          return route.fulfill({ status: 503, json: { error: { message: '合成详情读取失败' } } });
        data = detailed(records.find((r) => r.id === p.split('/').at(-1)));
      } else if (p.endsWith('/receipts')) {
        if (mode === 'error')
          return route.fulfill({ status: 503, json: { error: { message: '合成收货网络失败' } } });
        if (mode === 'slow') await new Promise((r) => setTimeout(r, 700));
        if (delayW1 && p.includes('/w1/')) await new Promise((r) => setTimeout(r, 500));
        data = paged(
          mode === 'empty' || p.includes('/w2/')
            ? []
            : url.searchParams.has('cursor')
              ? [{ ...records[0], id: 'next-receipt', sourceRef: 'UI分页收货单' }]
              : records,
          mode === 'normal' && !url.searchParams.has('cursor') && p.includes('/w1/')
            ? 'next'
            : null,
        );
      }
      await route.fulfill({ json: { data } });
    });
    const dialog = () => page.getByRole('dialog');
    const close = () => page.getByRole('button', { name: '关闭表单' }).click();
    const shot = async (name) => {
      if (!(await dialog().count())) await page.evaluate(() => globalThis.scrollTo(0, 0));
      await page.waitForTimeout(200);
      return page.screenshot({
        path: path.resolve(
          'docs/verification',
          `${process.env.YUMI_UI_PREFIX || 'UI'}-RECEIPTS-${name}-2026-10-29.png`,
        ),
        fullPage: !(await dialog().count()),
      });
    };
    const noOverflow = async () =>
      assert.ok(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
        ),
        'page overflow',
      );
    await page.goto(process.env.YUMI_UI_URL || 'http://127.0.0.1:5173');
    await page.getByRole('button', { name: '收货入库', exact: true }).first().click();
    await page.getByRole('button', { name: '查看收货详情' }).first().waitFor();
    assert.equal(
      await page.getByRole('button', { name: '查看收货详情' }).count(),
      3,
      'one row per receipt, not per line',
    );
    assert.equal(
      await page.getByRole('button', { name: '确认审核收货单', exact: true }).count(),
      0,
    );
    await shot('LIST');
    await page.getByRole('combobox', { name: '筛选收货状态' }).selectOption('DRAFT');
    assert.equal(await page.getByRole('button', { name: '查看收货详情' }).count(), 1);
    await page.getByRole('textbox', { name: '搜索收货单' }).fill('NOT-FOUND');
    await page.getByRole('heading', { name: '没有匹配的收货单' }).waitFor();
    await page.getByRole('textbox', { name: '搜索收货单' }).fill('');
    await page.getByRole('button', { name: '查看收货详情' }).click();
    await dialog().getByRole('heading', { name: '1. 合成纸巾 · 3包装' }).waitFor();
    assert.ok(await dialog().getByText('成本合计 ¥14.96', { exact: false }).isVisible());
    assert.equal(await page.getByRole('button', { name: '确认审核收货单' }).isDisabled(), true);
    await page.getByLabel('已逐行核对商品、批次、数量、成本和效期').check();
    await page.getByRole('button', { name: '确认审核收货单' }).click();
    await dialog().getByText('合成状态冲突', { exact: false }).waitFor();
    assert.equal(await page.getByLabel('已逐行核对商品、批次、数量、成本和效期').isChecked(), true);
    await page.getByRole('button', { name: '确认审核收货单' }).click();
    await dialog().getByText('合成状态冲突', { exact: false }).waitFor();
    assert.equal(actionKeys[0], actionKeys[1]);
    reject = false;
    await page.getByRole('button', { name: '确认审核收货单' }).click();
    await page.getByRole('button', { name: '确认入库并记录库存' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '确认入库并记录库存' }).isDisabled(), true);
    await page.setViewportSize({ width: 375, height: 812 });
    await noOverflow();
    await shot('DETAIL-MOBILE');
    await page.getByLabel('已核验实收货品与上述批次、数量、成本和效期').check();
    losePost = true;
    await page.getByRole('button', { name: '确认入库并记录库存' }).click();
    await dialog().getByText('结果暂未确认', { exact: false }).waitFor();
    await page.getByRole('button', { name: '刷新当前收货单' }).click();
    await dialog().getByText('此单已入库', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: '确认入库并记录库存' }).count(), 0);
    assert.equal(await dialog().getByText('结果暂未确认', { exact: false }).count(), 0);
    await close();
    await page.getByRole('button', { name: '新建收货单', exact: false }).click();
    await page.getByLabel('来源单号 / 说明').fill('UI多行失败与响应丢失验收');
    const first = page.getByRole('region', { name: '收货明细1', exact: true });
    await first.getByLabel('收货商品').selectOption('sku1');
    await first.getByLabel('供应批次').fill('UI-ONE');
    await first.getByLabel('收货数量（件）').fill('2');
    await first.getByLabel('单件成本（元）').fill('9999999999');
    assert.equal(errors.length, 0, 'out-of-range preview must not crash');
    await first.getByLabel('单件成本（元）').fill('0.29');
    await page.getByRole('button', { name: '添加收货明细', exact: false }).click();
    const second = page.getByRole('region', { name: '收货明细2', exact: true });
    await second.getByLabel('收货商品').selectOption('sku2');
    await second
      .getByLabel('收货商品')
      .locator('option[value="sku1"]:disabled')
      .waitFor({ state: 'attached' });
    await second.getByLabel('供应批次').fill('UI-TWO');
    await second.getByLabel('收货数量（件）').fill('2');
    await second.getByLabel('单件成本（元）').fill('7.19');
    await second.getByLabel('生产时间（北京时间）').fill('2026-10-01T08:00');
    await second.getByLabel('到期时间（北京时间）').fill('2027-10-01T08:00');
    reject = true;
    await page.getByRole('button', { name: '保存收货草稿' }).click();
    await dialog().getByText('合成保存冲突', { exact: false }).waitFor();
    assert.equal(await second.getByLabel('单件成本（元）').inputValue(), '7.19');
    assert.equal(postedPayloads[0].lines[0].unitCostCents, 29);
    assert.equal(postedPayloads[0].lines[1].unitCostCents, 719);
    assert.equal(postedPayloads[0].lines[1].producedAt, '2026-10-01T00:00:00.000Z');
    await shot('CREATE-MOBILE');
    reject = false;
    loseCreate = true;
    await page.getByRole('button', { name: '保存收货草稿' }).click();
    await page.getByRole('button', { name: '使用原意图重试查询' }).waitFor();
    assert.equal(await page.getByLabel('来源单号 / 说明').isDisabled(), true);
    await page.getByRole('button', { name: '使用原意图重试查询' }).click();
    await dialog()
      .getByRole('heading', { name: 'UI多行失败与响应丢失验收', exact: true })
      .waitFor();
    assert.equal(new Set(createKeys).size, 1, 'unknown create retry must keep exact intent');
    assert.deepEqual(postedPayloads[1], postedPayloads[2]);
    advanceOnApprove = true;
    await page.getByLabel('已逐行核对商品、批次、数量、成本和效期').check();
    await page.getByRole('button', { name: '确认审核收货单' }).click();
    await dialog().getByText('单据当前已入库', { exact: false }).waitFor();
    assert.equal(await page.getByRole('button', { name: '确认入库并记录库存' }).count(), 0);

    await close();
    await page.getByRole('combobox', { name: '筛选收货状态' }).selectOption('');
    await page.getByRole('button', { name: '加载更多收货单' }).click();
    await page.getByText('UI分页收货单', { exact: true }).waitFor();
    await shot('LIST-MOBILE');
    detailFail = true;
    await page.getByRole('button', { name: '查看收货详情' }).first().click();
    await page.getByRole('button', { name: '重新加载收货详情' }).waitFor();
    detailFail = false;
    await page.getByRole('button', { name: '重新加载收货详情' }).click();
    await dialog().getByRole('heading', { name: '1. 合成纸巾 · 3包装' }).waitFor();
    await close();
    delayW1 = true;
    await page.getByRole('button', { name: '刷新收货列表' }).click();
    await page.getByRole('combobox', { name: '作业仓库' }).selectOption('w2');
    await page.getByRole('heading', { name: '尚无收货单' }).waitFor();
    await page.waitForTimeout(600);
    assert.equal(await page.getByRole('button', { name: '查看收货详情' }).count(), 0);
    delayW1 = false;
    await page.getByRole('combobox', { name: '作业仓库' }).selectOption('w1');
    await page.getByRole('button', { name: '查看收货详情' }).first().waitFor();
    for (const [state, text] of [
      ['error', '合成收货网络失败'],
      ['empty', '尚无收货单'],
      ['slow', '正在加载收货单…'],
    ]) {
      mode = state;
      await page.getByRole('button', { name: '刷新收货列表' }).click();
      await page.getByText(text, { exact: false }).waitFor();
      await shot(state.toUpperCase());
    }
    mode = 'normal';
    profile.permissions = ['catalog.read', 'stock.read', 'receipt.read'];
    await page.reload();
    await page.getByRole('button', { name: '收货入库', exact: true }).first().click();
    await page.getByRole('button', { name: '查看收货详情' }).first().waitFor();
    assert.equal(await page.getByRole('button', { name: '新建收货单', exact: false }).count(), 0);
    await page.getByRole('button', { name: '查看收货详情' }).nth(1).click();
    await dialog().getByText('当前账号没有此状态的审核或入库权限。').waitFor();
    for (const width of [320, 375, 414]) {
      await page.setViewportSize({ width, height: 812 });
      await noOverflow();
    }
    await close();
    assert.deepEqual(errors, []);
    console.log(
      'Receipt UI passed: one row per receipt, filters/paging, multi-line exact cents/Beijing times, verification gating, failures and unknown-response recovery, warehouse switch protection, read-only role and 320/375/414 layouts. Synthetic responses only.',
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
