/* global document, innerWidth, window */
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
  dir = resolve('.local/payment-query-ui');
const { createServer } = await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const f = await orderAdminFixture({ notificationLab: true });
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
      value: f.extraCookies[0].split('=')[1],
      domain: '127.0.0.1',
      path: '/',
    },
  ]);
  const page = await context.newPage();
  const shots = [];
  async function shot(name) {
    await page.evaluate(() => window.scrollTo(0, 0));
    const path = 'docs/verification/UI-PAYMENT-QUERY-' + name + '-2026-11-01.png';
    await page.screenshot({ path, fullPage: true });
    shots.push(path);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'horizontal overflow: ' + name,
    );
  }
  await page.goto('http://127.0.0.1:5188/');
  await page.getByRole('button', { name: '支付尝试', exact: true }).click();
  await page.getByText('暂无合成支付尝试', { exact: true }).waitFor();
  await shot('EMPTY-DESKTOP');
  await page.getByRole('button', { name: '创建合成尝试', exact: true }).click();
  await page.getByRole('heading', { name: '合成尝试详情', exact: true }).waitFor();
  const idle = () =>
    page.waitForFunction(() => {
      const b = document.querySelector('.payment-attempt-detail button');
      return b && !b.disabled;
    });
  await idle();
  assert.equal(await f.runtime.db.paymentAttemptLab.count(), 1);
  assert.equal(await f.runtime.db.paymentAttemptLabEvent.count(), 1);
  let gate,
    fail = false,
    lose = true,
    release;
  await page.route(
    '**/api/v1/admin/payment-attempt-lab/*/actions/unknown-result?*',
    async (route) => {
      if (gate) await gate;
      if (fail)
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: '合成结果响应中断' } }),
        });
      if (lose) {
        lose = false;
        await route.fetch();
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: '服务已记录，响应丢失' } }),
        });
      }
      return route.continue();
    },
  );
  gate = new Promise((r) => (release = r));
  await page.getByRole('button', { name: '模拟响应丢失', exact: true }).click();
  await page.getByRole('button', { name: '正在处理…', exact: true }).waitFor();
  await shot('RUNNING');
  release();
  gate = undefined;
  await page.getByRole('alert').filter({ hasText: '服务已记录，响应丢失' }).waitFor();
  await shot('ERROR');
  assert.equal(await f.runtime.db.paymentAttemptLabEvent.count(), 2);
  await page.reload();
  await page.getByRole('button', { name: '支付尝试', exact: true }).click();
  await page.getByRole('button', { name: '查看尝试', exact: true }).click();
  await idle();
  await page
    .locator('.payment-attempt-detail')
    .getByText('结果未知，等待核查', { exact: true })
    .first()
    .waitFor();
  await shot('UNKNOWN-DESKTOP');
  await page.getByRole('button', { name: '模拟响应丢失', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '原操作已记录' }).waitFor();
  await idle();
  assert.equal(await f.runtime.db.paymentAttemptLabEvent.count(), 2);
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('UNKNOWN-MOBILE');
  await page.getByRole('button', { name: '运行本仓一轮合成查询', exact: true }).click();
  await idle();
  assert.equal((await f.runtime.db.paymentQueryLabJob.findFirstOrThrow()).attempts, 1);
  await shot('RETRY-MOBILE');
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: '运行本仓一轮合成查询', exact: true }).click();
  await idle();
  await page.waitForTimeout(5200);
  await page.getByRole('button', { name: '运行本仓一轮合成查询', exact: true }).click();
  await idle();
  assert.equal((await f.runtime.db.paymentQueryLabJob.findFirstOrThrow()).state, 'EXHAUSTED');
  await shot('EXHAUSTED-MOBILE');
  await page.getByRole('button', { name: '重新安排合成查询', exact: true }).click();
  await idle();
  assert.equal((await f.runtime.db.paymentQueryLabJob.findFirstOrThrow()).attempts, 0);
  await shot('REQUEUED-MOBILE');

  await page.getByRole('button', { name: '模拟查单关闭', exact: true }).click();
  await idle();
  await page
    .locator('.payment-attempt-detail')
    .getByText('合成关闭结果待核对', { exact: true })
    .first()
    .waitFor();
  await page.getByRole('button', { name: '模拟响应丢失', exact: true }).click();
  await idle();
  assert.equal((await f.runtime.db.paymentAttemptLab.findFirstOrThrow()).evidence, 'CLOSED');
  await page.getByRole('button', { name: '模拟查单成功', exact: true }).click();
  await idle();
  await page
    .locator('.payment-attempt-detail')
    .getByText('结果冲突，需核查', { exact: true })
    .first()
    .waitFor();
  await shot('CONFLICT-MOBILE');
  await page.getByRole('button', { name: '运行本仓一轮合成查询', exact: true }).click();
  await idle();
  assert.equal((await f.runtime.db.paymentQueryLabJob.findFirstOrThrow()).state, 'DONE');
  await shot('STOPPED-MOBILE');
  assert.equal(await f.runtime.db.paymentAttemptLabEvent.count(), 8);
  await page.route('**/api/v1/admin/payment-attempt-lab?*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.enabled = false;
    return route.fulfill({ response, json: body });
  });
  await page.getByRole('button', { name: '刷新尝试记录', exact: true }).click();
  await page.getByRole('heading', { name: '本机合成尝试尚未开启', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '创建合成尝试', exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole('button', { name: '模拟查单成功', exact: true }).isDisabled(),
    true,
  );
  await shot('DISABLED');
  const other = await browser.newContext();
  await other.addCookies([
    {
      name: 'yumi_staff_session',
      value: f.cookies[0].split('=')[1],
      domain: '127.0.0.1',
      path: '/',
    },
  ]);
  const op = await other.newPage();
  await op.goto('http://127.0.0.1:5188/');
  await op.getByRole('button', { name: '订单查询', exact: true }).waitFor();
  assert.equal(await op.getByRole('button', { name: '支付尝试', exact: true }).count(), 0);
  await other.close();
  assert.equal(await f.runtime.db.consumerOrder.count(), 0);
  assert.equal(await f.runtime.db.paymentPreparation.count(), 0);
  assert.equal(await f.runtime.db.notificationLabRecord.count(), 0);
  console.log(
    'Actual attempt UI/API passed: empty, durable unknown result, response lost after commit + page reload + original-key retry, close/unknown/success conflict, desktop/mobile, running/error, disabled and role navigation. One synthetic attempt, eight evidence events and bounded query-task history, zero business orders/preparations/notifications. Screenshots: ' +
      shots.length,
  );
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  await f.cleanup();
}
