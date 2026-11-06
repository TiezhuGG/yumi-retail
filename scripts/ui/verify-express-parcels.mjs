/* global document, innerWidth */
// Actual operations UI + disposable PostgreSQL API. Never seeds the operational database.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expressShippingFixture } from '../../tests/helpers/express-shipping-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd(),
  dir = resolve('.local/express-parcels-ui');
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
    const path = 'docs/verification/UI-EXPRESS-PARCELS-' + name + '-2026-11-07.png';
    await page.screenshot({ path, fullPage: true });
    shots.push(path);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'horizontal overflow: ' + name,
    );
  }

  await f.createExpress();
  await f.createExpress(2);
  await page.goto('http://127.0.0.1:5188/');
  await page.getByRole('button', { name: '积分兑换订单', exact: true }).click();
  await page.getByRole('button', { name: '查看订单详情', exact: true }).first().waitFor();
  assert.ok(await page.getByRole('button', { name: '合包发货', exact: true }).isDisabled());
  await page.getByLabel('选择本页有效订单', { exact: true }).check();
  let releasePreview;
  const previewHeld = new Promise((resolve) => {
    releasePreview = resolve;
  });
  await page.route('**/admin/redemptions/parcel-preview', async (route) => {
    await previewHeld;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'SYNTHETIC_UNAVAILABLE', message: '合成合包资料暂不可用' },
      }),
    });
  });
  await page.getByRole('button', { name: '合包发货', exact: true }).click();
  await page.getByText('正在核验合包订单…', { exact: true }).waitFor();
  await shot('LOADING');
  releasePreview();
  await page.getByRole('alert').filter({ hasText: '合成合包资料暂不可用' }).waitFor();
  await shot('ERROR');
  await page.unroute('**/admin/redemptions/parcel-preview');
  await page.getByRole('button', { name: '重新核验合包资料', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '合包确认与发货', exact: true });
  await dialog.getByLabel('合包快递公司', { exact: true }).waitFor();
  await shot('READY-DESKTOP');
  await f.runtime.db.stockBalance.update({
    where: { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.catalog.skuIds[0] } },
    data: { inventoryHold: true },
  });
  await dialog.getByRole('button', { name: '重新核验合包资料', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: '原预占需核查' }).waitFor();
  assert.ok(
    await dialog.getByRole('button', { name: '确认合包并发货（2单）', exact: true }).isDisabled(),
  );
  await shot('BLOCKED');
  await f.runtime.db.stockBalance.update({
    where: { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.catalog.skuIds[0] } },
    data: { inventoryHold: false },
  });
  await dialog.getByRole('button', { name: '重新核验合包资料', exact: true }).click();
  await dialog.getByLabel('合包快递公司', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('READY-MOBILE');
  await dialog
    .getByRole('button', { name: '确认合包并发货（2单）', exact: true })
    .scrollIntoViewIfNeeded();
  await shot('FORM-MOBILE');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await dialog.getByLabel('合包快递公司', { exact: true }).selectOption('SF');
  await dialog.getByLabel('合包运单号', { exact: true }).fill('SF-UI-PARCEL-001');
  assert.ok(
    await dialog.getByRole('button', { name: '确认合包并发货（2单）', exact: true }).isDisabled(),
  );
  await dialog.getByRole('checkbox').check();
  const endpoint = '**/admin/redemptions/ship-parcel';
  let originalKey, markCommitted;
  const committed = new Promise((resolve) => {
    markCommitted = resolve;
  });
  await page.route(endpoint, async (route) => {
    originalKey = route.request().headers()['idempotency-key'];
    const r = await route.fetch();
    assert.equal(r.status(), 200);
    await route.abort('failed');
    markCommitted();
  });
  await dialog.getByRole('button', { name: '确认合包并发货（2单）', exact: true }).click();
  await committed;
  await dialog.getByRole('button', { name: '核实原合包请求', exact: true }).waitFor();
  await shot('UNKNOWN');
  assert.equal(await f.runtime.db.redemptionExpressParcel.count(), 1);
  assert.equal(await f.runtime.db.redemptionExpressShipment.count(), 2);
  await page.unroute(endpoint);
  await page.reload();
  await page.getByRole('button', { name: '积分兑换订单', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '合包确认与发货', exact: true });
  await dialog.getByRole('button', { name: '核实原合包请求', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('RESTORED-MOBILE');
  const replay = page.waitForRequest((r) => r.url().endsWith('/admin/redemptions/ship-parcel'));
  await dialog.getByRole('button', { name: '核实原合包请求', exact: true }).click();
  assert.equal((await replay).headers()['idempotency-key'], originalKey);
  await dialog.getByText('合包发货已登记', { exact: true }).waitFor();
  await shot('SUCCESS');
  assert.equal(await f.runtime.db.redemptionExpressParcel.count(), 1);
  await dialog.getByRole('button', { name: '完成并返回订单', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '查看订单详情', exact: true }).first().click();
  await page.getByText('同包发货 · 共2笔订单。运单更正会同步整个包裹。', { exact: true }).waitFor();
  await shot('SHIPPED');
  await page.getByRole('button', { name: '更正运单资料', exact: true }).click();
  await page.getByLabel('更正后的快递公司', { exact: true }).selectOption('ZTO');
  await page.getByLabel('更正后的运单号', { exact: true }).fill('ZTO-UI-PARCEL-UPDATED');
  await page.getByLabel('更正原因', { exact: true }).fill('合成整包录入更正');
  await page
    .getByRole('checkbox', { name: '已核对原包裹真实运单，本次仅更正录入资料', exact: true })
    .check();
  await shot('CORRECTION');
  await page.getByRole('button', { name: '保存运单更正', exact: true }).click();
  await page.getByText('ZTO-UI-PARCEL-UPDATED', { exact: false }).first().waitFor();
  assert.equal(await f.runtime.db.redemptionExpressShipmentCorrection.count(), 2);
  await shot('CORRECTED');
  console.log(
    'Actual UI + disposable PG: parcel review, mobile, physical confirmation, lost response, reload recovery with original key, shipment and whole-parcel correction passed. Screenshots ' +
      shots.length,
  );
} catch (e) {
  if (page) {
    await page.screenshot({ path: '.local/express-parcels-ui-failure.png', fullPage: true });
    await writeFile('.local/express-parcels-ui-failure.html', await page.content());
  }
  throw e;
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  await f.cleanup();
}
