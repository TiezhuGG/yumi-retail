/* global document, innerWidth, window */
// Actual operations UI + disposable PostgreSQL API. Never seeds the operational database.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pickingFixture } from '../../tests/helpers/picking-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd(),
  dir = resolve('.local/picking-readiness-ui');
const { createServer } = await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const f = await pickingFixture();
let server, browser;
const pendingReleases = [];
try {
  await mkdir(dir, { recursive: true });
  await writeFile(
    dir + '/index.html',
    '<html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  );
  await writeFile(
    dir + '/main.tsx',
    `import React from 'react';import {createRoot} from 'react-dom/client';import {StaffSessionPanel,Workspace} from '${root}/packages/web-ui/src/index';import '${root}/packages/web-ui/src/styles.css';createRoot(document.getElementById('root')).render(<React.StrictMode><StaffSessionPanel workspace>{(p,c)=><Workspace profile={p} sessionControl={c} mobile={new URLSearchParams(location.search).has('mobile')}/>}</StaffSessionPanel></React.StrictMode>);`,
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
      value: f.pickerCookie.split('=')[1],
      domain: '127.0.0.1',
      path: '/',
    },
  ]);
  const page = await context.newPage();
  const shots = [];
  async function shot(name) {
    await page.evaluate(() => window.scrollTo(0, 0));
    const path = 'docs/verification/UI-PICKING-READINESS-' + name + '-2026-11-01.png';
    await page.screenshot({ path, fullPage: true });
    shots.push(path);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'horizontal overflow: ' + name,
    );
  }

  const canceled = await f.create();
  await f.call('/consumer/orders/' + canceled + '/cancel', {});
  const id = await f.create();
  const order = await f.runtime.db.consumerOrder.findUniqueOrThrow({
    where: { id },
    select: { orderNo: true },
  });
  const nav = (name) => page.getByRole('button', { name, exact: true });
  await page.goto('http://127.0.0.1:5188/');
  await nav('拣货准备').click();
  await page.getByRole('button', { name: '查看资格与备货清单', exact: true }).first().waitFor();
  assert.equal(await nav('查看资格与备货清单').count(), 2);
  assert.equal(await nav('订单查询').count(), 0);
  await shot('LIST-DESKTOP');
  await page.getByRole('textbox', { name: '备货订单号前缀' }).fill(order.orderNo.toLowerCase());
  await nav('查询备货记录').click();
  await page.waitForFunction(() => document.querySelectorAll('.picking-order-card').length === 1);
  let entered, release;
  const reached = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (release = r));
  pendingReleases.push(release);
  await page.route('**/api/v1/warehouse/picking-readiness/*?*', async (route) => {
    entered();
    await gate;
    return route.continue();
  });
  await nav('查看资格与备货清单').click();
  await reached;
  await page.getByText('正在核验订单与预占…', { exact: true }).waitFor();
  await shot('LOADING-DESKTOP');
  release();
  await page.unrouteAll({ behavior: 'wait' });
  const detail = page.getByRole('region', { name: '资格与备货清单', exact: true });
  await detail.getByText('未确认真实支付成功', { exact: true }).waitFor();
  assert.equal(await detail.getByText('尚不可领取', { exact: true }).count(), 1);
  assert.ok((await detail.locator('.picking-allocation').count()) > 0);
  assert.equal(await nav('领取拣货').count(), 0);
  await shot('DETAIL-DESKTOP');
  await nav('返回备货记录').click();
  assert.equal(await nav('查看资格与备货清单').count(), 1);
  assert.equal(
    await page.getByRole('textbox', { name: '备货订单号前缀' }).inputValue(),
    order.orderNo.toLowerCase(),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:5188/?mobile=1');
  await nav('拣货准备').waitFor();
  await nav('查看资格与备货清单').first().waitFor();
  assert.equal(await nav('收货入库').count(), 0);
  assert.equal(await nav('订单查询').count(), 0);
  await page
    .locator('.picking-order-card')
    .filter({ hasText: order.orderNo })
    .getByRole('button')
    .click();
  await detail.getByText('未确认真实支付成功', { exact: true }).waitFor();
  const a = await f.runtime.db.orderAllocation.findFirstOrThrow({
    where: { orderId: id },
    include: { position: true },
  });
  await f.runtime.db.stockBalance.update({
    where: { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: a.skuId } },
    data: { inventoryHold: true },
  });
  await f.runtime.db.warehouseLocation.update({
    where: { id: a.position.locationId },
    data: { enabled: false },
  });
  await f.runtime.db.stockLot.update({
    where: { id: a.lotId },
    data: { producedAt: new Date(0), expiresAt: new Date(86400000) },
  });
  await nav('重新核验').click();
  await detail.getByText('分配批次已到期', { exact: true }).first().waitFor();
  await detail.getByText('分配库位已停用', { exact: true }).first().waitFor();
  await detail.getByText('该商品库存处于冻结核对中', { exact: true }).first().waitFor();
  await shot('BLOCKED-MOBILE');
  await page.route('**/api/v1/warehouse/picking-readiness/*?*', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: '合成备货详情暂不可读' } }),
    }),
  );
  await nav('重新核验').click();
  await detail.getByRole('alert').waitFor();
  assert.equal(await detail.locator('.picking-allocation').count(), 0);
  await shot('ERROR-MOBILE');
  await page.unrouteAll({ behavior: 'wait' });
  await nav('重试备货详情').click();
  await detail.getByText('未确认真实支付成功', { exact: true }).waitFor();
  assert.equal((await f.call('/consumer/orders/' + id + '/cancel', {})).status, 200);
  await nav('重新核验').click();
  await detail.getByText('订单已取消，不可拣货', { exact: true }).waitFor();
  assert.equal(await detail.getByText('预占未释放', { exact: true }).count(), 0);
  await shot('CANCELED-MOBILE');
  await nav('返回备货记录').click();
  await page.getByRole('textbox', { name: '备货订单号前缀' }).fill('NOTFOUND');
  await nav('查询备货记录').click();
  await page.getByRole('heading', { name: '暂无符合条件的订单', exact: true }).waitFor();
  await shot('EMPTY-MOBILE');
  assert.equal(await f.runtime.db.consumerOrder.count({ where: { paymentState: 'SUCCESS' } }), 0);
  console.log(
    'Picking readiness actual UI/API passed: picker desktop/mobile role navigation, list/prefix search/return preservation, real allocation snapshot, unpaid guards, loading, hold/disabled location/expiry blockers, failure clears stale detail/retry, cancellation refresh releases, empty state and no horizontal overflow; screenshots: ' +
      shots.length,
  );
} finally {
  for (const release of pendingReleases) release();
  if (browser)
    for (const context of browser.contexts())
      for (const page of context.pages()) await page.unrouteAll({ behavior: 'wait' });
  if (browser) await browser.close();
  if (server) await server.close();
  await f.cleanup();
}
