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
  dir = resolve('.local/notification-link-ui');
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
    const path = 'docs/verification/UI-NOTIFICATION-LINK-' + name + '-2026-11-01.png';
    await page.screenshot({ path, fullPage: true });
    shots.push(path);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'horizontal overflow: ' + name,
    );
  }
  await page.goto('http://127.0.0.1:5188/');
  await page.getByRole('button', { name: '通知记录', exact: true }).click();
  await page.getByText('暂无合成通知记录', { exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole('combobox', { name: '关联合成尝试', exact: true })
      .locator('option')
      .count(),
    1,
  );
  await shot('EMPTY-DESKTOP');
  await page.getByRole('button', { name: '支付尝试', exact: true }).click();
  await page.getByRole('button', { name: '创建合成尝试', exact: true }).click();
  await page.getByRole('heading', { name: '合成尝试详情', exact: true }).waitFor();
  const idle = () =>
    page.waitForFunction(() => {
      const b = document.querySelector('.payment-attempt-detail button');
      return b && !b.disabled;
    });
  await idle();
  await page.getByRole('button', { name: '模拟响应丢失', exact: true }).click();
  await idle();
  await page
    .getByRole('combobox', { name: '下一轮合成查询场景', exact: true })
    .selectOption('CLOSED');
  await page.getByRole('button', { name: '运行本仓一轮合成查询', exact: true }).click();
  await page.getByText(/分类：CLOSED/).waitFor();
  await idle();
  await page.getByText('暂无关联通知', { exact: true }).waitFor();
  await shot('BINDING-DESKTOP');
  const id = (await f.runtime.db.paymentAttemptLab.findFirstOrThrow()).id;
  await page.getByRole('button', { name: '通知记录', exact: true }).click();
  await page.getByRole('combobox', { name: '关联合成尝试', exact: true }).selectOption(id);
  let gate,
    release,
    lose = true;
  await page.route('**/api/v1/admin/payment-notification-records?*', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    if (gate) await gate;
    if (lose) {
      lose = false;
      await route.fetch();
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '合成关联已提交，响应丢失' } }),
      });
    }
    return route.continue();
  });
  gate = new Promise((r) => (release = r));
  await page.getByRole('button', { name: '创建合成记录', exact: true }).click();
  await page.getByRole('button', { name: '正在处理…', exact: true }).waitFor();
  await shot('RUNNING');
  release();
  gate = undefined;
  await page.getByRole('alert').filter({ hasText: '合成关联已提交，响应丢失' }).waitFor();
  await shot('LOST-RESPONSE');
  assert.equal(await f.runtime.db.paymentNotificationLabApplication.count(), 1);
  await page.getByRole('button', { name: '重试创建合成记录', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '重复通知已识别' }).waitFor();
  await page.getByRole('heading', { name: '合成通知详情', exact: true }).waitFor();
  await shot('LINKED-DESKTOP');
  await page.getByRole('button', { name: '创建合成记录', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '交易证据已存在' }).waitFor();
  assert.equal(await f.runtime.db.notificationLabRecord.count(), 2);
  assert.equal(await f.runtime.db.paymentNotificationLabApplication.count(), 1);
  await page.getByRole('button', { name: '重放此合成通知', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '重复通知已识别' }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('LINKED-MOBILE');
  await page.getByRole('button', { name: '支付尝试', exact: true }).click();
  await page.getByRole('button', { name: '查看尝试', exact: true }).click();
  await idle();
  await page.getByText('已关联通知 · ', { exact: false }).first().waitFor();
  assert.equal(await page.locator('.notification-binding-panel article').count(), 2);
  await page.getByText('待人工核查，自动查询已停止', { exact: true }).waitFor();
  await shot('CONFLICT-MOBILE');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await shot('CONFLICT-DESKTOP');
  assert.equal(
    (await f.runtime.db.paymentAttemptLab.findUniqueOrThrow({ where: { id } })).evidence,
    'CONFLICT',
  );
  await page.getByRole('button', { name: '补偿核查', exact: true }).click();
  await page.getByRole('combobox', { name: '核查筛选', exact: true }).selectOption('REVIEW');
  await page.getByRole('button', { name: '查看核查详情', exact: true }).click();
  await shot('REVIEW-DESKTOP');
  await page.getByRole('button', { name: '通知记录', exact: true }).click();
  await page.route('**/api/v1/admin/payment-notification-records?*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.enabled = false;
    return route.fulfill({ response, json: body });
  });
  await page.getByRole('button', { name: '刷新记录', exact: true }).click();
  await page.getByRole('heading', { name: '本机合成接收尚未开启', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('combobox', { name: '关联合成尝试', exact: true }).isDisabled(),
    true,
  );
  await shot('DISABLED-DESKTOP');
  assert.equal(await f.runtime.db.consumerOrder.count(), 0);
  assert.equal(await f.runtime.db.paymentPreparation.count(), 0);
  console.log(
    'Actual notification-link UI/API passed: no binding options/empty, server binding, lost response + original retry, different notification IDs share evidence, replay, linked details both sides, query-close conflict + review, default disabled, desktop/mobile without overflow. Screenshots: ' +
      shots.length,
  );
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  await f.cleanup();
}
