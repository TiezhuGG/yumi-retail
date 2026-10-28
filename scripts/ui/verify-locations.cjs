// Synthetic UI responses only. Actual inventory protection is tested separately on PostgreSQL.
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const profile = {
      id: 'ui-manager',
      displayName: 'UI合成仓管',
      roles: ['WAREHOUSE_MANAGER'],
      warehouseIds: ['w'],
      csrfToken: 'fixture',
      permissions: [
        'catalog.read',
        'stock.read',
        'receipt.read',
        'stock.transfer',
        'location.write',
        'stock.check',
        'stock.release-hold',
      ],
    };
    const locs = [
      { id: 'default', code: 'DEFAULT', name: '默认收货位', enabled: true, version: 1 },
      { id: 'a', code: 'A-01', name: 'UI合成货架', enabled: true, version: 1 },
    ];
    const positions = [
      {
        id: 'p1',
        skuId: 'sku1',
        name: '合成纸巾',
        spec: '3包装',
        skuCode: 'UI-01',
        lotId: 'lot1',
        locationId: 'default',
        locationCode: 'DEFAULT',
        batchNo: 'UI-BATCH-1',
        onHand: 10,
        reserved: 0,
        blocked: 2,
        expired: false,
        locationEnabled: true,
        version: 1,
        expiresAt: null,
      },
      {
        id: 'p2',
        skuId: 'sku2',
        name: '合成洗衣液',
        spec: '1瓶',
        skuCode: 'UI-02',
        lotId: 'lot2',
        locationId: 'a',
        locationCode: 'A-01',
        batchNo: 'UI-BATCH-2',
        onHand: 5,
        reserved: 1,
        blocked: 0,
        expired: false,
        locationEnabled: true,
        version: 1,
        expiresAt: null,
      },
    ];
    const report = {
      id: 'check1',
      skuId: 'sku1',
      status: 'INCONSISTENT',
      issueCount: 1,
      createdAt: '2026-10-28T08:00:00Z',
      issues: [
        {
          kind: 'POSITION_LEDGER',
          resourceId: 'p1',
          expected: { onHand: '10', reserved: '0', blocked: '2' },
          actual: { onHand: '9', reserved: '0', blocked: '2' },
        },
      ],
    };
    let mode = 'normal',
      ledgerError = false,
      reject = true;
    const keys = [];
    let balanceReads = 0;
    const paged = (items, nextCursor = null) => ({ items, nextCursor, hasMore: !!nextCursor });
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        p = url.pathname;
      let data = paged([]);
      if (request.method() === 'POST') {
        keys.push(request.headers()['idempotency-key']);
        if (reject)
          return route.fulfill({
            status: 409,
            json: { error: { message: '合成版本冲突，请刷新后核对' } },
          });
        data = p.endsWith('/inventory-checks')
          ? { ...report, status: 'CONSISTENT', issues: [], issueCount: 0 }
          : { ...locs[1], enabled: false, version: 2 };
      } else if (p.endsWith('/staff/me')) data = profile;
      else if (p.endsWith('/warehouses')) data = { items: [{ id: 'w', name: 'UI合成验收仓' }] };
      else if (p.endsWith('/stock')) {
        balanceReads++;
        data = paged([{ version: 1, onHand: 10, inventoryHold: true }]);
      } else if (p.endsWith('/ledger')) {
        if (ledgerError)
          return route.fulfill({ status: 503, json: { error: { message: '合成流水加载失败' } } });
        data = paged([
          {
            id: 'ledger',
            deltaOnHand: -1,
            deltaReserved: 0,
            deltaBlocked: 0,
            actionKey: 'RECEIPT_REVERSE:fixture',
            createdAt: '2026-10-28T08:00:00Z',
            reason: 'UI合成纠错流水',
          },
        ]);
      } else if (/\/(positions|locations|stock-transfers|inventory-checks)$/.test(p)) {
        if (mode === 'error')
          return route.fulfill({ status: 503, json: { error: { message: '合成列表加载失败' } } });
        if (mode === 'slow') await new Promise((r) => setTimeout(r, 600));
        if (mode === 'empty') data = paged([]);
        else if (p.endsWith('/positions')) {
          const sku = url.searchParams.get('skuId');
          if (mode === 'race' && sku === 'sku1') await new Promise((r) => setTimeout(r, 500));
          data = paged(sku ? positions.filter((p) => p.skuId === sku) : positions);
        } else if (p.endsWith('/locations')) data = paged(locs);
        else if (p.endsWith('/stock-transfers'))
          data = paged([
            {
              id: 'transfer1',
              sourcePositionId: 'p1',
              targetPositionId: 'p2',
              quantity: 1,
              reason: 'UI合成移位记录',
              createdAt: '2026-10-28T08:00:00Z',
            },
          ]);
        else data = paged([report]);
      }
      await route.fulfill({ json: { data } });
    });
    const shot = async (name) =>
      page.screenshot({
        path: path.resolve(
          'docs/verification',
          `${process.env.YUMI_UI_PREFIX || 'UI'}-LOCATIONS-${name}-2026-10-28.png`,
        ),
        fullPage: !(await page.getByRole('dialog').count()),
      });
    const close = () => page.getByRole('button', { name: '关闭表单' }).click();
    const noOverflow = async () =>
      assert.ok(
        await page.evaluate(
          () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
        ),
        'page overflow',
      );
    await page.goto(process.env.YUMI_UI_URL || 'http://127.0.0.1:5173');
    await page.getByRole('button', { name: '库位与核对', exact: true }).click();
    await page.getByRole('button', { name: '查看位置与流水' }).first().waitFor();
    await shot('POSITIONS');
    assert.equal(
      await page.getByRole('button', { name: '移位', exact: true }).nth(1).isDisabled(),
      true,
    );
    const filter = page.getByRole('combobox', { name: '筛选商品规格' });
    await filter.selectOption('sku1');
    await page.getByRole('button', { name: '查看位置与流水' }).waitFor();
    assert.equal(await filter.locator('option[value="sku2"]').count(), 1);
    mode = 'race';
    await filter.selectOption('');
    await filter.selectOption('sku1');
    await filter.selectOption('sku2');
    await page.locator('.task-card').filter({ hasText: '合成洗衣液' }).waitFor();
    await page.waitForTimeout(600);
    assert.equal(await page.locator('.task-card').filter({ hasText: '合成纸巾' }).count(), 0);
    mode = 'normal';
    await filter.selectOption('');
    await page.getByRole('button', { name: '查看位置与流水' }).first().click();
    await page.getByRole('dialog').getByText('收货纠错', { exact: true }).waitFor();
    ledgerError = true;
    await page.getByRole('button', { name: '刷新位置流水' }).click();
    await page.getByRole('dialog').getByText('合成流水加载失败').waitFor();
    ledgerError = false;
    await page.getByRole('dialog').getByRole('button', { name: '重新加载资料' }).click();
    await page.getByRole('dialog').getByText('收货纠错', { exact: true }).waitFor();
    await page.setViewportSize({ width: 375, height: 812 });
    await noOverflow();
    await shot('LEDGER-MOBILE');
    await close();
    await page.getByRole('button', { name: '存储库位', exact: true }).click();
    await page.getByRole('button', { name: '查看库位详情' }).first().waitFor();
    await shot('STORAGE-MOBILE');
    await page.getByRole('button', { name: '新增库位', exact: false }).click();
    await page.getByLabel('库位编码', { exact: true }).fill('UI-A');
    await page.getByLabel('库位名称', { exact: true }).fill('保留库位名称');
    await page.getByRole('button', { name: '保存库位', exact: true }).click();
    await page.getByRole('dialog').getByText('合成版本冲突', { exact: false }).waitFor();
    assert.equal(await page.getByLabel('库位名称', { exact: true }).inputValue(), '保留库位名称');
    await page.getByRole('button', { name: '保存库位', exact: true }).click();
    await page.getByRole('dialog').getByText('合成版本冲突', { exact: false }).waitFor();
    assert.equal(keys[0], keys[1]);
    await close();
    await page.getByRole('button', { name: '查看库位详情' }).first().click();
    assert.equal(await page.getByRole('button', { name: '确认停用此库位' }).count(), 0);
    await close();
    await page.getByRole('button', { name: '移位记录', exact: true }).click();
    await page.getByRole('button', { name: '查看移位详情' }).waitFor();
    await page.getByRole('button', { name: '新建移位', exact: false }).click();
    await page.getByLabel('源库存位置').selectOption('p1');
    await page.getByLabel('目标库位').selectOption('a');
    await page.getByLabel('移位数量（件）').fill('1');
    await page.getByLabel('移位原因').fill('保留移位原因');
    await page.getByRole('button', { name: '确认同仓移位', exact: true }).click();
    await page.getByRole('dialog').getByText('合成版本冲突', { exact: false }).waitFor();
    assert.equal(await page.getByLabel('移位原因').inputValue(), '保留移位原因');
    await shot('TRANSFER-MOBILE');
    await close();
    await page.getByRole('button', { name: '查看移位详情' }).click();
    await page.getByRole('dialog').getByText('已过账 · 1 件', { exact: true }).waitFor();
    await close();
    await page.getByRole('button', { name: '核对报告', exact: true }).click();
    await page.getByRole('button', { name: '查看核对报告' }).waitFor();
    await page.getByRole('button', { name: '查看核对报告' }).click();
    await page.getByRole('dialog').getByText('发现差异，已记录核对结果').waitFor();
    await shot('REPORT-MOBILE');
    await close();
    await page.getByRole('button', { name: '执行库存核对', exact: true }).click();
    await page.getByLabel('核对商品规格').selectOption('sku1');
    await page.getByLabel('解除暂停原因').fill('保留解除原因');
    await page.getByRole('button', { name: '复核并解除核对暂停' }).click();
    await page.getByRole('dialog').getByText('合成版本冲突', { exact: false }).waitFor();
    assert.equal(await page.getByLabel('解除暂停原因').inputValue(), '保留解除原因');
    reject = false;
    await page.getByRole('button', { name: '确认执行账本核对' }).click();
    await page
      .getByRole('dialog')
      .getByRole('heading', { name: '账本一致', exact: true })
      .waitFor();
    await close();
    await page.getByRole('combobox', { name: '筛选商品规格' }).selectOption('sku1');
    await page.getByRole('button', { name: '查看核对报告' }).waitFor();
    const previousReads = balanceReads;
    await page.getByRole('button', { name: '执行库存核对', exact: true }).click();
    await page.getByText('当前账面 10 件', { exact: false }).waitFor();
    assert.equal(
      balanceReads,
      previousReads + 1,
      'reopening the same SKU must fetch a fresh balance',
    );
    await close();
    await page.getByRole('button', { name: '批次位置', exact: true }).click();
    for (const [state, text] of [
      ['error', '合成列表加载失败'],
      ['empty', '暂无符合条件的批次位置'],
      ['slow', '正在加载资料…'],
    ]) {
      mode = state;
      await page.getByRole('button', { name: '刷新当前列表' }).click();
      await page.getByText(text, { exact: false }).waitFor();
      await shot(state.toUpperCase());
    }
    mode = 'normal';
    profile.permissions = ['catalog.read', 'stock.read'];
    profile.roles = ['PICKER'];
    profile.displayName = 'UI合成拣货员';
    await page.reload();
    await page.getByRole('button', { name: '库位与核对', exact: true }).click();
    await page.getByRole('button', { name: '查看位置与流水' }).first().waitFor();
    assert.equal(await page.getByRole('button', { name: '移位', exact: true }).count(), 0);
    await page.getByRole('button', { name: '查看位置与流水' }).first().click();
    await page.getByRole('dialog').getByText('收货纠错', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '从此位置移位' }).count(), 0);
    await close();
    await page.getByRole('button', { name: '存储库位', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: '新增库位', exact: false }).count(), 0);
    await page.getByRole('button', { name: '核对报告', exact: true }).click();
    await page.getByRole('button', { name: '查看核对报告' }).waitFor();
    assert.equal(await page.getByRole('button', { name: '执行库存核对', exact: true }).count(), 0);
    for (const width of [320, 375, 414]) {
      await page.setViewportSize({ width, height: 812 });
      await noOverflow();
    }
    await shot('PICKER-MOBILE');
    assert.deepEqual(errors, []);
    assert.ok(keys.every(Boolean));
    console.log(
      'Locations UI passed: warehouse/picker paths, independent details, stale filter protection, ledger retry, input retention/idempotent retry, report/check/release entries and responsive states. Fixtures only.',
    );
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
