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
  dir = resolve('.local/payment-classification-ui');
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
    const path = 'docs/verification/UI-PAYMENT-CLASSIFICATION-' + name + '-2026-11-01.png';
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
  const idle = () =>
    page.waitForFunction(() => {
      const b = document.querySelector('.payment-attempt-detail button');
      return b && !b.disabled;
    });
  async function startUnknown() {
    await page.getByRole('button', { name: '创建合成尝试', exact: true }).click();
    await page.getByRole('heading', { name: '合成尝试详情', exact: true }).waitFor();
    await idle();
    await page.getByRole('button', { name: '模拟响应丢失', exact: true }).click();
    await idle();
    await page.getByText('等待到期重试', { exact: true }).waitFor();
  }
  await startUnknown();
  await page
    .getByRole('combobox', { name: '下一轮合成查询场景', exact: true })
    .selectOption('RATE');
  await page.getByRole('button', { name: '运行本仓一轮合成查询', exact: true }).click();
  await page.getByText(/分类：RATE_LIMIT/).waitFor();
  await idle();
  await shot('RETRY-DESKTOP');
  await new Promise((r) => setTimeout(r, 1100));
  let gate, release;
  await page.route('**/api/v1/admin/payment-attempt-lab/run-query-cycle?*', async (route) => {
    if (gate) await gate;
    await route.fetch();
    return route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: '合成分类已保存，响应丢失' } }),
    });
  });
  await page
    .getByRole('combobox', { name: '下一轮合成查询场景', exact: true })
    .selectOption('MISSING');
  gate = new Promise((r) => (release = r));
  await page.getByRole('button', { name: '运行本仓一轮合成查询', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.query-scenario select').disabled);
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('RUNNING-MOBILE');
  release();
  gate = undefined;
  await page.getByRole('alert').filter({ hasText: '合成分类已保存，响应丢失' }).waitFor();
  await shot('LOST-RESPONSE-MOBILE');
  assert.equal(
    await f.runtime.db.paymentQueryLabEvent.count({ where: { classification: 'NOT_FOUND' } }),
    1,
  );
  await page.unroute('**/api/v1/admin/payment-attempt-lab/run-query-cycle?*');
  await page.reload();
  await page.getByRole('button', { name: '支付尝试', exact: true }).click();
  await page.getByRole('button', { name: '查看尝试', exact: true }).first().click();
  await idle();
  await page.getByText('待人工核查，自动查询已停止', { exact: true }).waitFor();
  await page.getByText(/分类：NOT_FOUND/).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '重新安排合成查询', exact: true }).isDisabled(),
    true,
  );
  await shot('REVIEW-MOBILE');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await shot('REVIEW-DESKTOP');
  await page.getByRole('button', { name: '补偿核查', exact: true }).click();
  await page.getByRole('combobox', { name: '核查筛选', exact: true }).selectOption('REVIEW');
  await page.getByRole('button', { name: '查看核查详情', exact: true }).click();
  await page
    .getByRole('textbox', { name: '合成核查备注', exact: true })
    .fill('合成分类核查：未确认扣款结果，保留未知。');
  await page.getByRole('button', { name: '保存核查备注', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '核查备注已保存' }).waitFor();
  await shot('NOTE-DESKTOP');
  assert.equal((await f.runtime.db.paymentQueryLabJob.findFirstOrThrow()).state, 'REVIEW');
  await page.getByRole('button', { name: '支付尝试', exact: true }).click();
  await startUnknown();
  await page
    .getByRole('combobox', { name: '下一轮合成查询场景', exact: true })
    .selectOption('SUCCESS');
  await page.getByRole('button', { name: '运行本仓一轮合成查询', exact: true }).click();
  await page.getByText(/分类：SUCCEEDED/).waitFor();
  await idle();
  await shot('KNOWN-DESKTOP');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('KNOWN-MOBILE');
  await page.route('**/api/v1/admin/payment-attempt-lab?*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.enabled = false;
    return route.fulfill({ response, json: body });
  });
  await page.getByRole('button', { name: '刷新尝试记录', exact: true }).click();
  await page.getByRole('button', { name: '查看尝试', exact: true }).first().click();
  await page.waitForFunction(() => document.querySelector('.query-scenario select')?.disabled);
  assert.equal(
    await page.getByRole('combobox', { name: '下一轮合成查询场景', exact: true }).isDisabled(),
    true,
  );
  await shot('DISABLED-MOBILE');
  assert.equal(await f.runtime.db.consumerOrder.count(), 0);
  assert.equal(await f.runtime.db.paymentPreparation.count(), 0);
  console.log(
    'Actual classification UI/API passed: empty, retry, running, lost response and refresh recovery, review stop, filtered review note, known synthetic result, disabled; desktop/mobile without horizontal overflow. Screenshots: ' +
      shots.length,
  );
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  await f.cleanup();
}
