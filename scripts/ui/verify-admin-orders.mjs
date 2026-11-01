/* global document, innerWidth */
// Actual operations UI + disposable PostgreSQL API. Never seeds the operational database.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { orderAdminFixture } from '../../tests/helpers/order-admin-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd(),
  dir = resolve('.local/admin-orders-ui');
const { createServer } = await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const f = await orderAdminFixture();
let server, browser;
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
      value: f.cookies[0].split('=')[1],
      domain: '127.0.0.1',
      path: '/',
    },
  ]);
  const page = await context.newPage();
  const shots = [];
  async function shot(name) {
    const path = 'docs/verification/UI-ADMIN-ORDERS-' + name + '-2026-11-01.png';
    await page.screenshot({ path, fullPage: true });
    shots.push(path);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'horizontal overflow: ' + name,
    );
  }
  await page.goto('http://127.0.0.1:5188/');
  await page.getByRole('button', { name: '订单查询', exact: true }).click();
  await page.getByText('没有符合条件的订单', { exact: true }).waitFor();
  await shot('EMPTY');
  const first = await f.create();
  await page.getByRole('button', { name: '刷新订单', exact: true }).click();
  await page.getByRole('button', { name: '查看详情', exact: true }).click();
  await page.getByRole('heading', { name: '批次与库位预占', exact: true }).waitFor();
  await shot('DETAIL-DESKTOP');
  assert.equal(await page.locator('.order-allocation').count(), 2);
  assert.ok(!(await page.locator('main').innerText()).includes('合成订单私密备注'));
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('DETAIL-MOBILE');
  await f.call('/consumer/orders/' + first + '/cancel', {});
  await page.getByRole('button', { name: '刷新订单详情', exact: true }).click();
  await page.getByText('顾客取消', { exact: true }).waitFor();
  await shot('RELEASED');
  await page.getByRole('button', { name: '返回订单列表', exact: true }).click();
  await page.getByRole('button', { name: '查看详情', exact: true }).waitFor();
  await shot('LIST-MOBILE');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await shot('LIST-DESKTOP');
  let fail = false,
    gate;
  await page.route('**/api/v1/admin/orders**', async (route) => {
    if (gate) await gate;
    if (fail)
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '合成订单查询失败' } }),
      });
    return route.continue();
  });
  let release;
  gate = new Promise((r) => (release = r));
  await page.getByRole('button', { name: '刷新订单', exact: true }).click();
  // The list keeps already read rows while refreshing; first load uses a separate loading state.
  await page.getByLabel('订单号前缀').fill('ZNOORDER');
  await page.getByRole('button', { name: '查询订单', exact: true }).click();
  await page.getByText('正在读取订单…', { exact: true }).waitFor();
  await shot('LOADING');
  release();
  gate = undefined;
  await page.getByText('没有符合条件的订单', { exact: true }).waitFor();
  fail = true;
  await page.getByRole('button', { name: '刷新订单', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '合成订单查询失败' }).waitFor();
  await shot('ERROR');
  fail = false;
  await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await page.getByText('没有符合条件的订单', { exact: true }).waitFor();
  await page.getByRole('button', { name: '重置筛选', exact: true }).click();
  await page.getByRole('button', { name: '查看详情', exact: true }).click();
  fail = true;
  await page.getByRole('button', { name: '刷新订单详情', exact: true }).click();
  await page.getByRole('button', { name: '重试详情', exact: true }).waitFor();
  await shot('DETAIL-ERROR');
  fail = false;
  await page.getByRole('button', { name: '重试详情', exact: true }).click();
  await page.getByRole('heading', { name: '批次与库位预占', exact: true }).waitFor();
  await page.getByRole('button', { name: '返回订单列表', exact: true }).click();
  // Real API pagination: 20 orders from A, 2 from B. Cancel each fixture order to reuse physical stock.
  for (let i = 0; i < 19; i++) {
    const id = await f.create();
    await f.call('/consumer/orders/' + id + '/cancel', {});
  }
  const token = await f.secondCustomer();
  for (let i = 0; i < 2; i++) {
    const id = await f.create(token);
    await f.call('/consumer/orders/' + id + '/cancel', {}, token);
  }
  await page.getByRole('button', { name: '刷新订单', exact: true }).click();
  await page.getByRole('button', { name: '加载更多订单', exact: true }).waitFor();
  assert.equal(await page.locator('.order-table tbody tr').count(), 20);
  // A failed refresh with a next cursor must retry the first page, not append page two.
  fail = true;
  await page.getByRole('button', { name: '刷新订单', exact: true }).click();
  await page.getByRole('button', { name: '重试读取', exact: true }).waitFor();
  fail = false;
  await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await page.getByRole('button', { name: '加载更多订单', exact: true }).waitFor();
  assert.equal(await page.locator('.order-table tbody tr').count(), 20);
  // Lost page response must retry the same cursor and append only the two unseen rows.
  fail = true;
  await page.getByRole('button', { name: '加载更多订单', exact: true }).click();
  await page.getByRole('button', { name: '重试读取', exact: true }).waitFor();
  fail = false;
  await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.order-table tbody tr').length === 22,
  );
  await page.getByLabel('订单状态').selectOption('AWAITING_PAYMENT');
  await page.getByRole('button', { name: '查询订单', exact: true }).click();
  await page.getByText('没有符合条件的订单', { exact: true }).waitFor();
  // A delayed old query cannot repopulate a newer empty filter.
  let unblock;
  gate = new Promise((r) => (unblock = r));
  await page.getByRole('button', { name: '重置筛选', exact: true }).click();
  await page.getByText('正在读取订单…', { exact: true }).waitFor();
  await page.getByLabel('订单号前缀').fill('ZNOORDER');
  await page.getByRole('button', { name: '查询订单', exact: true }).click();
  unblock();
  gate = undefined;
  await page.getByText('没有符合条件的订单', { exact: true }).waitFor();
  assert.equal(await page.locator('.order-table tbody tr').count(), 0);
  const other = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await other.addCookies([
    {
      name: 'yumi_staff_session',
      value: f.cookies[1].split('=')[1],
      domain: '127.0.0.1',
      path: '/',
    },
  ]);
  const restricted = await other.newPage();
  await restricted.goto('http://127.0.0.1:5188/');
  await restricted.getByRole('button', { name: '库存总览', exact: true }).waitFor();
  assert.equal(await restricted.getByRole('button', { name: '订单查询', exact: true }).count(), 0);
  await other.close();
  console.log(
    'Actual admin UI with isolated real API: desktop/mobile, reservation/release, empty/loading/error/detail retry, 20+2 pagination recovery, stale filter rejection and role navigation passed. Screenshots: ' +
      shots.length,
  );
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  await f.cleanup();
}
