// Browser UI checks with explicit synthetic responses. Does not write a database.
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.YUMI_CHROMIUM_PATH || '/usr/bin/google-chrome',
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const p = {
    id: 'position',
    skuId: 'sku',
    name: '合成抽纸（UI验收）',
    spec: '3包装',
    batchNo: 'UI-BATCH',
    locationCode: 'A-01',
    onHand: 10,
    reserved: 0,
    blocked: 2,
    version: 1,
    locationEnabled: true,
    expired: false,
  };
  const isolation = {
    id: 'isolation-00000001',
    positionId: p.id,
    skuId: p.skuId,
    quantity: 2,
    remaining: 2,
    version: 1,
    reason: 'UI合成隔离记录',
  };
  const doc = {
    id: 'document-00000001',
    isolationId: isolation.id,
    positionId: p.id,
    kind: 'DAMAGE',
    quantity: 1,
    status: 'DRAFT',
    version: 1,
    createdBy: 'other-employee',
    reviewedBy: null,
    reason: 'UI合成报损申请',
  };
  const reversal = {
    id: 'reversal-00000001',
    positionId: p.id,
    quantity: 1,
    status: 'DRAFT',
    version: 1,
    positionVersion: 1,
    createdBy: 'other-employee',
    reviewedBy: null,
    reason: 'UI合成误录申请',
  };
  const source = {
    positionId: p.id,
    batchNo: p.batchNo,
    sourceRef: 'UI合成收货单',
    receiptId: 'receipt-00000001',
    receiptLineId: 'line',
    originalQuantity: 10,
    reversedQuantity: 0,
    remaining: 10,
    freeQuantity: 8,
    positionVersion: 1,
  };
  const profile = {
    id: 'reviewer',
    displayName: 'UI验收员工',
    roles: ['WAREHOUSE_MANAGER'],
    warehouseIds: ['w'],
    csrfToken: 'fixture',
    permissions: [
      'catalog.read',
      'stock.read',
      'receipt.read',
      'stock.isolate',
      'disposition.write',
      'disposition.approve',
      'disposition.post',
      'reversal.write',
      'reversal.approve',
      'reversal.post',
    ],
  };
  let mode = 'normal',
    reject = true;
  const keys = [];
  const paged = (items) => ({ items, nextCursor: null, hasMore: false });
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(),
      pathname = new URL(request.url()).pathname;
    let data = paged([]);
    if (request.method() === 'POST') {
      keys.push(request.headers()['idempotency-key']);
      if (reject)
        return route.fulfill({
          status: 409,
          json: { error: { message: '合成版本冲突，请刷新单据核对' } },
        });
      if (pathname.includes('stock-isolations')) data = isolation;
      if (pathname.includes('stock-dispositions'))
        data = {
          ...doc,
          status: 'APPROVED',
          reviewedBy: profile.id,
          reviewReason: '合成审批已完成',
        };
      if (pathname.includes('receipt-reversals'))
        data = {
          ...reversal,
          status: 'APPROVED',
          reviewedBy: profile.id,
          reviewReason: '合成审批已完成',
        };
    } else if (pathname.endsWith('/staff/me')) data = profile;
    else if (pathname.endsWith('/warehouses'))
      data = { items: [{ id: 'w', name: 'UI合成验收仓' }] };
    else if (pathname.endsWith('/positions')) data = paged([p]);
    else if (pathname.includes('receipt-reversal-sources')) data = source;
    else if (/\/(stock-isolations|stock-dispositions|receipt-reversals)\//.test(pathname))
      data = pathname.includes('stock-isolations')
        ? isolation
        : pathname.includes('stock-dispositions')
          ? doc
          : reversal;
    else if (/\/(stock-isolations|stock-dispositions|receipt-reversals)$/.test(pathname)) {
      if (mode === 'error')
        return route.fulfill({ status: 503, json: { error: { message: '合成网络失败' } } });
      if (mode === 'slow') await new Promise((r) => setTimeout(r, 700));
      data = paged(
        mode === 'empty'
          ? []
          : [
              pathname.includes('stock-isolations')
                ? isolation
                : pathname.includes('stock-dispositions')
                  ? doc
                  : reversal,
            ],
      );
    }
    return route.fulfill({ json: { data } });
  });
  const shot = async (name) =>
    page.screenshot({
      path: path.resolve(
        'docs/verification',
        `${process.env.YUMI_UI_PREFIX || 'UI'}-${name}-2026-10-28.png`,
      ),
      fullPage: true,
    });
  const dialog = () => page.getByRole('dialog');
  const close = () => page.getByRole('button', { name: '关闭表单' }).click();
  const noOverflow = async () =>
    assert.ok(
      await page.evaluate(
        () => globalThis.document.documentElement.scrollWidth <= globalThis.innerWidth,
      ),
    );
  await page.goto(process.env.YUMI_UI_URL || 'http://127.0.0.1:5173');
  await page.getByRole('button', { name: '隔离与报损', exact: true }).click();
  await page.getByRole('button', { name: '查看隔离并申请处置' }).waitFor();
  await shot('DISPOSITION-LIST');
  assert.equal(await page.getByLabel('问题货品位置').count(), 0);
  await page.getByRole('button', { name: '新建隔离', exact: false }).click();
  await page.getByLabel('问题货品位置').selectOption('position');
  await page.getByLabel('隔离数量', { exact: true }).fill('1');
  await page.getByLabel('问题说明').fill('保留隔离输入');
  await page.getByRole('button', { name: '确认立即隔离' }).click();
  await dialog().getByText('合成版本冲突', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('问题说明').inputValue(), '保留隔离输入');
  await page.getByRole('button', { name: '确认立即隔离' }).click();
  await dialog().getByText('合成版本冲突', { exact: false }).waitFor();
  assert.equal(keys[0], keys[1], 'failed retry must reuse idempotency key');
  await close();
  await page.getByRole('button', { name: '查看隔离并申请处置' }).click();
  await page.getByLabel('处置数量').fill('1');
  await page.getByLabel('申请原因').fill('保留处置输入');
  await page.getByRole('button', { name: '提交处置申请' }).click();
  await dialog().getByText('合成版本冲突', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('申请原因').inputValue(), '保留处置输入');
  await close();
  await page.getByRole('button', { name: '处置申请', exact: true }).click();
  await page.getByRole('combobox', { name: '筛选处置状态' }).selectOption('POSTED');
  await page.getByText('暂无符合条件的处置申请', { exact: false }).waitFor();
  await page.getByRole('combobox', { name: '筛选处置状态' }).selectOption('DRAFT');
  await page.getByRole('button', { name: '查看处置单', exact: true }).click();
  await page.getByLabel('审批说明', { exact: true }).fill('合成独立审核');
  reject = false;
  await page.getByRole('button', { name: '确认独立审批', exact: true }).click();
  await page.getByRole('button', { name: '确认报损过账' }).waitFor();
  assert.ok(await page.getByLabel('已核验本次报损实物并完成处理').isVisible());
  reject = true;
  await page.getByLabel('已核验本次报损实物并完成处理').check();
  await page.getByLabel('实物核验说明', { exact: false }).fill('保留实物核验说明');
  await page.getByRole('button', { name: '确认报损过账' }).click();
  await dialog().getByText('合成版本冲突', { exact: false }).waitFor();
  assert.equal(
    await page.getByLabel('实物核验说明', { exact: false }).inputValue(),
    '保留实物核验说明',
  );
  await page.setViewportSize({ width: 375, height: 812 });
  await noOverflow();
  await shot('DISPOSITION-DETAIL-MOBILE');
  await close();
  await shot('DISPOSITION-MOBILE');
  for (const [state, text] of [
    ['error', '合成网络失败'],
    ['empty', '暂无符合条件的处置申请'],
    ['slow', '正在加载隔离与处置记录…'],
  ]) {
    mode = state;
    await page.getByRole('button', { name: '刷新列表', exact: true }).click();
    await page.getByText(text, { exact: false }).waitFor();
    await shot(`DISPOSITION-${state.toUpperCase()}`);
  }
  mode = 'normal';

  await page.getByRole('button', { name: '收货纠错', exact: true }).click();
  await page.getByRole('button', { name: '查看逆向单', exact: true }).waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await shot('REVERSAL-LIST');
  assert.equal(await page.getByLabel('纠错库存位置').count(), 0);
  await page.getByRole('button', { name: '新建纠错申请', exact: false }).click();
  await page.getByLabel('纠错库存位置').selectOption('position');
  await page.getByRole('button', { name: '核对原收货及额度' }).click();
  await page.getByLabel('误录纠错数量').fill('1');
  await page.getByLabel('误录原因').fill('保留纠错输入');
  await page.getByRole('button', { name: '提交逆向申请' }).click();
  await dialog().getByText('合成版本冲突', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('误录原因').inputValue(), '保留纠错输入');
  await close();
  await page.getByRole('button', { name: '查看逆向单' }).click();
  await page.getByLabel('逆向审批说明').fill('独立核验原单');
  reject = false;
  await page.getByRole('button', { name: '确认独立审批逆向单' }).click();
  await page.getByRole('button', { name: '确认逆向纠错过账' }).waitFor();
  await page.getByLabel('原单及实物核验说明').fill('保留纠错实物核验');
  await page.getByLabel('已核验原收货记录和实物', { exact: false }).check();
  reject = true;
  await page.getByRole('button', { name: '确认逆向纠错过账' }).click();
  await dialog().getByText('合成版本冲突', { exact: false }).waitFor();
  assert.equal(await page.getByLabel('原单及实物核验说明').inputValue(), '保留纠错实物核验');
  for (const width of [320, 375, 414]) {
    await page.setViewportSize({ width, height: 812 });
    await noOverflow();
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await shot('REVERSAL-DETAIL-MOBILE');
  await close();
  await shot('REVERSAL-MOBILE');
  for (const [state, text] of [
    ['error', '合成网络失败'],
    ['empty', '暂无符合条件的纠错申请'],
    ['slow', '正在加载纠错申请…'],
  ]) {
    mode = state;
    await page.getByRole('button', { name: '刷新列表', exact: true }).click();
    await page.getByText(text, { exact: false }).waitFor();
    await shot(`REVERSAL-${state.toUpperCase()}`);
  }

  mode = 'normal';
  profile.id = 'other-employee';
  await page.reload();
  await page.getByRole('button', { name: '隔离与报损', exact: true }).click();
  await page.getByRole('button', { name: '处置申请', exact: true }).click();
  await page.getByRole('button', { name: '查看处置单', exact: true }).click();
  await dialog().getByText('请让另一位管理员或仓管登录后独立审批。').waitFor();
  assert.equal(
    await dialog().getByRole('button', { name: '确认独立审批', exact: true }).count(),
    0,
  );
  assert.ok(keys.every(Boolean));
  assert.deepEqual(errors, []);
  await browser.close();
  console.log(
    'Stock task UI passed: independent lists/dialogs, filtering, approval/post actions, failed input retention, loading/empty/error/retry, 320/375/414 layouts. Synthetic responses only.',
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
