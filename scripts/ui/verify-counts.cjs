// UI-only fixtures: no database writes or server authorization claims.
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
const out = path.resolve('docs/verification');
const screenshotName = (name) =>
  process.env.YUMI_UI_PREFIX ? name.replace('UI-COUNTS', process.env.YUMI_UI_PREFIX) : name;
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.YUMI_CHROMIUM_PATH || '/usr/bin/google-chrome',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  let listMode = 'normal';
  const rejectSubmission = true;
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const permissions = [
    'catalog.read',
    'stock.read',
    'receipt.read',
    'count.write',
    'count.approve',
    'count.post',
  ];
  const profile = {
    id: 'ui-author',
    displayName: '界面验收员工',
    permissions,
    roles: ['WAREHOUSE_MANAGER'],
    warehouseIds: ['w'],
    csrfToken: 'ui-fixture',
  };
  const position = {
    id: 'pos',
    skuId: 'sku',
    name: '合成抽纸（UI验收）',
    spec: '3包装',
    skuCode: 'UI-001',
    locationCode: 'A-01',
    batchNo: 'UI-BATCH',
    onHand: 10,
    reserved: 0,
    blocked: 0,
  };
  const line = {
    id: 'line',
    positionId: 'pos',
    snapshotOnHand: 10,
    snapshotReserved: 0,
    snapshotBlocked: 0,
    counted: null,
  };
  const row = {
    id: 'ui-count-00000001',
    skuId: 'sku',
    status: 'FROZEN',
    version: 1,
    reason: '合成盘点任务，仅供界面验收',
    createdBy: 'ui-author',
    createdAt: '2026-10-28T08:00:00Z',
    reviewedBy: null,
    lines: [line],
  };
  const paged = (items) => ({ items, nextCursor: null, hasMore: false });
  let mutationCount = 0;
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const p = url.pathname;
    let data = paged([]);
    if (p.endsWith('/staff/me')) data = profile;
    else if (p.endsWith('/warehouses')) data = { items: [{ id: 'w', name: 'UI合成验收仓' }] };
    else if (p.endsWith('/positions')) data = paged([position]);
    else if (p.endsWith('/stock')) data = paged([{ skuId: 'sku', version: 1, onHand: 10 }]);
    else if (p.endsWith('/stock-counts') && request.method() === 'GET') {
      if (listMode === 'error')
        return route.fulfill({ status: 503, json: { error: { message: '合成网络失败，请重试' } } });
      if (listMode === 'slow') await new Promise((r) => setTimeout(r, 800));
      data = paged(
        listMode === 'empty'
          ? []
          : [
              row,
              { ...row, id: 'ui-count-00000002', status: 'SUBMITTED', createdBy: 'another-author' },
            ],
      );
    } else if (request.method() === 'POST') {
      mutationCount++;
      assert.ok(request.headers()['idempotency-key']);
      if (rejectSubmission)
        return route.fulfill({
          status: 409,
          json: { error: { message: '合成版本冲突：请刷新当前单据后核对' } },
        });
      data = row;
    } else if (p.includes('/stock-counts/'))
      data = p.endsWith('00000002')
        ? { ...row, id: 'ui-count-00000002', status: 'SUBMITTED', createdBy: 'another-author' }
        : row;
    await route.fulfill({ json: { data } });
  });
  await page.goto(process.env.YUMI_UI_URL || 'http://127.0.0.1:5173');
  await page.getByRole('button', { name: '实物盘点', exact: true }).click();
  await page.getByRole('button', { name: '查看详情 →' }).first().waitFor();
  const checkWidth = async () =>
    assert.ok(
      await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
      ),
      'page overflow',
    );
  await checkWidth();
  await page.screenshot({
    path: path.join(out, screenshotName('UI-COUNTS-DESKTOP-2026-10-28.png')),
    fullPage: true,
  });
  await page.getByRole('combobox', { name: '筛选盘点状态' }).selectOption('SUBMITTED');
  assert.equal(await page.getByRole('button', { name: '查看详情 →' }).count(), 1);
  await page.getByRole('button', { name: '查看详情 →' }).click();
  await page.getByRole('button', { name: '审批盘点差异', exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭表单' }).click();
  await page.getByRole('combobox', { name: '筛选盘点状态' }).selectOption('FROZEN');
  await page.getByRole('button', { name: '查看详情 →' }).click();
  await page.getByLabel('实盘件数').fill('9');
  await page.getByRole('button', { name: '提交全部实盘数' }).click();
  await page.getByRole('dialog').getByText('合成版本冲突', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('实盘件数').inputValue(), '9');
  assert.equal(mutationCount, 1);
  await page.setViewportSize({ width: 375, height: 812 });
  await checkWidth();
  await page.screenshot({
    path: path.join(out, screenshotName('UI-COUNTS-DETAIL-MOBILE-2026-10-28.png')),
    fullPage: true,
  });
  await page.getByRole('button', { name: '关闭表单' }).click();
  await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  await page.getByRole('button', { name: '查看详情 →' }).first().waitFor();
  for (const width of [320, 375, 414]) {
    await page.setViewportSize({ width, height: 812 });
    await checkWidth();
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({
    path: path.join(out, screenshotName('UI-COUNTS-MOBILE-2026-10-28.png')),
    fullPage: true,
  });
  await page.getByRole('button', { name: '发起盘点', exact: false }).click();
  await page.getByLabel('发起原因').fill('保留输入测试');
  await page.getByLabel('盘点商品规格').selectOption('sku');
  await page.getByRole('button', { name: '确认发起并冻结' }).click();
  await page.getByRole('dialog').getByText('合成版本冲突', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('发起原因').inputValue(), '保留输入测试');
  await page.getByRole('button', { name: '关闭表单' }).click();
  listMode = 'error';
  await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  await page.getByRole('button', { name: '重新加载盘点单' }).waitFor();
  await page.screenshot({
    path: path.join(out, screenshotName('UI-COUNTS-ERROR-2026-10-28.png')),
    fullPage: true,
  });
  listMode = 'empty';
  await page.getByRole('button', { name: '重新加载盘点单' }).click();
  await page.getByRole('heading', { name: '还没有盘点任务' }).waitFor();
  await page.screenshot({
    path: path.join(out, screenshotName('UI-COUNTS-EMPTY-2026-10-28.png')),
    fullPage: true,
  });
  listMode = 'slow';
  await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  await page.getByText('正在加载盘点单…').waitFor();
  await page.screenshot({
    path: path.join(out, screenshotName('UI-COUNTS-LOADING-2026-10-28.png')),
    fullPage: true,
  });
  assert.deepEqual(pageErrors, []);
  await browser.close();
  console.log(
    'Counts UI checks passed: filters, approval entry, conflict input retention, create failure, retry, empty/loading/error and 320/375/414 widths. Fixtures only.',
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
