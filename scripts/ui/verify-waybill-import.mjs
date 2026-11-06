/* global document, innerWidth */
// Actual operations UI + disposable PostgreSQL API. Never seeds the operational database.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expressShippingFixture } from '../../tests/helpers/express-shipping-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd(),
  dir = resolve('.local/waybill-import-ui');
const { createServer } = await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const f = await expressShippingFixture();
let server, browser, page;
try {
  await mkdir(dir, { recursive: true });
  await writeFile(
    dir + '/index.html',
    '<html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  );
  await writeFile(
    dir + '/main.tsx',
    `import React from 'react';import {createRoot} from 'react-dom/client';import {StaffSessionPanel,Workspace} from '${root}/packages/web-ui/src/index';import '${root}/packages/web-ui/src/styles.css';createRoot(document.getElementById('root')).render(<React.StrictMode><StaffSessionPanel workspace>{(p,c)=><Workspace profile={p} sessionControl={c}/>}</StaffSessionPanel></React.StrictMode>);`,
  );
  server = await createServer({
    configFile: false,
    root: dir,
    plugins: [react()],
    resolve: {
      alias: {
        react: resolve('apps/admin-web/node_modules/react'),
        'react-dom': resolve('apps/admin-web/node_modules/react-dom'),
      },
    },
    server: {
      host: '127.0.0.1',
      port: 5188,
      strictPort: true,
      fs: { allow: [root] },
      proxy: { '/api': f.base },
    },
  });
  await server.listen();
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([
    {
      name: 'yumi_staff_session',
      value: f.cookie.split('=')[1],
      domain: '127.0.0.1',
      path: '/',
    },
  ]);
  page = await context.newPage();
  const shots = [];
  async function shot(name) {
    const path = 'docs/verification/UI-WAYBILL-IMPORT-' + name + '-2026-11-07.png';
    await page.screenshot({ path, fullPage: true });
    shots.push(path);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'horizontal overflow: ' + name,
    );
  }

  const ids = [await f.createExpress(), await f.createExpress(2)];
  const orders = await f.runtime.db.redemptionOrder.findMany({ where: { id: { in: ids } } });
  const csv =
    '订单号,快递公司代码,快递公司名称,运单号\r\n' +
    orders.map((o, i) => [o.orderNo, 'SF', '', 'SF-UI-IMPORT-00' + i].join(',')).join('\r\n');
  await page.goto('http://127.0.0.1:5188/');
  await page.getByRole('button', { name: '积分兑换订单', exact: true }).click();
  await page.getByRole('button', { name: '查看订单详情', exact: true }).first().waitFor();
  await page.getByLabel('选择本页有效订单', { exact: true }).check();
  await page.getByRole('button', { name: '批量运单导入', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '批量运单导入', exact: true });
  assert.ok(await dialog.getByRole('button', { name: '预检导入', exact: true }).isDisabled());
  await shot('EMPTY');
  const downloadEvent = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '下载已选待发货订单模板', exact: true }).click();
  const download = await downloadEvent,
    template = await readFile(await download.path(), 'utf8');
  assert.ok(orders.every((o) => template.includes(o.orderNo)));
  assert.ok(!template.includes('SF-UI-IMPORT'));
  const input = dialog.getByLabel('运单CSV文件', { exact: true });
  await input.setInputFiles({
    name: 'bad-encoding.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from([0xff, 0xfe, 0xff]),
  });
  await dialog.getByRole('alert').filter({ hasText: '文件编码无效' }).waitFor();
  await shot('ENCODING-ERROR');
  await input.setInputFiles({
    name: 'bad.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('错误表头\nnot-an-order'),
  });
  await dialog.getByRole('button', { name: '预检导入', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: '表头必须为' }).waitFor();
  await shot('CSV-ERROR');
  await input.setInputFiles({
    name: 'synthetic-waybills.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  let releasePreview;
  const held = new Promise((resolve) => {
    releasePreview = resolve;
  });
  await page.route('**/admin/redemptions/waybill-import/preview', async (route) => {
    await held;
    await route.continue();
  });
  await dialog.getByRole('button', { name: '预检导入', exact: true }).click();
  await dialog.getByText('正在预检订单与运单…', { exact: true }).waitFor();
  await shot('LOADING');
  releasePreview();
  await dialog.getByRole('heading', { name: '预检通过 · 2笔订单', exact: true }).waitFor();
  await page.unroute('**/admin/redemptions/waybill-import/preview');
  await shot('READY-DESKTOP');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('READY-MOBILE');
  await dialog
    .getByRole('button', { name: '确认整批发货（2单）', exact: true })
    .scrollIntoViewIfNeeded();
  await shot('FORM-MOBILE');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await f.runtime.db.stockBalance.update({
    where: { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.catalog.skuIds[0] } },
    data: { inventoryHold: true },
  });
  await dialog.getByRole('button', { name: '预检导入', exact: true }).click();
  await dialog
    .getByRole('heading', { name: '本批不能发货，请修正后重新导入', exact: true })
    .waitFor();
  assert.equal(await dialog.getByText('合成快递收件人', { exact: false }).count(), 0);
  await shot('BLOCKED');
  await f.runtime.db.stockBalance.update({
    where: { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.catalog.skuIds[0] } },
    data: { inventoryHold: false },
  });
  await dialog.getByRole('button', { name: '预检导入', exact: true }).click();
  await dialog.getByRole('heading', { name: '预检通过 · 2笔订单', exact: true }).waitFor();
  assert.ok(
    await dialog.getByRole('button', { name: '确认整批发货（2单）', exact: true }).isDisabled(),
  );
  await dialog.getByRole('checkbox').check();
  let originalKey, markCommitted;
  const committed = new Promise((resolve) => {
    markCommitted = resolve;
  });
  const endpoint = '**/admin/redemptions/waybill-import/confirm';
  await page.route(endpoint, async (route) => {
    originalKey = route.request().headers()['idempotency-key'];
    const r = await route.fetch();
    assert.equal(r.status(), 200);
    await route.abort('failed');
    markCommitted();
  });
  await dialog.getByRole('button', { name: '确认整批发货（2单）', exact: true }).click();
  await committed;
  await dialog.getByRole('button', { name: '核实原批量发货请求', exact: true }).waitFor();
  await shot('UNKNOWN');
  assert.equal(await f.runtime.db.redemptionExpressShipment.count(), 2);
  await page.unroute(endpoint);
  await page.reload();
  await page.getByRole('button', { name: '积分兑换订单', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '批量运单导入', exact: true });
  await dialog.getByRole('button', { name: '核实原批量发货请求', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('RESTORED-MOBILE');
  const replay = page.waitForRequest((r) =>
    r.url().endsWith('/admin/redemptions/waybill-import/confirm'),
  );
  await dialog.getByRole('button', { name: '核实原批量发货请求', exact: true }).click();
  assert.equal((await replay).headers()['idempotency-key'], originalKey);
  await dialog.getByRole('heading', { name: '整批发货已登记', exact: true }).waitFor();
  await shot('SUCCESS');
  assert.equal(await f.runtime.db.redemptionExpressShipment.count(), 2);
  assert.equal(await f.runtime.db.redemptionExpressParcel.count(), 0);
  await dialog.getByRole('button', { name: '完成并返回订单', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '查看订单详情', exact: true }).first().click();
  await page.getByText('已快递发货', { exact: true }).first().waitFor();
  await shot('SHIPPED');
  console.log(
    'Actual UI + isolated PG: real CSV download/upload, UTF-8 rejection, parse errors, loading, stock blocker, desktop/mobile, physical confirmation, committed-response loss and original-key recovery passed; screenshots ' +
      shots.length,
  );
} catch (e) {
  if (page) {
    await page.screenshot({ path: '.local/waybill-import-ui-failure.png', fullPage: true });
    await writeFile('.local/waybill-import-ui-failure.html', await page.content());
  }
  throw e;
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  await f.cleanup();
}
