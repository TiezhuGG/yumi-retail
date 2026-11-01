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
  dir = resolve('.local/payment-adapter-ui');
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
    const path = 'docs/verification/UI-PAYMENT-ADAPTER-' + name + '-2026-11-01.png';
    await page.screenshot({ path, fullPage: true });
    shots.push(path);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'horizontal overflow: ' + name,
    );
  }
  await page.goto('http://127.0.0.1:5188/');
  await page.getByRole('button', { name: '渠道契约验证', exact: true }).click();
  await page.getByRole('heading', { name: '可运行本机隔离验证', exact: true }).waitFor();
  assert.equal(await page.getByText('尚未运行', { exact: true }).count(), 17);
  await shot('IDLE-DESKTOP');
  await page.getByRole('button', { name: '运行合成验证', exact: true }).click();
  await page.getByRole('heading', { name: '合成验证全部通过', exact: true }).waitFor();
  assert.equal(await page.getByText('验证通过', { exact: true }).count(), 17);
  assert.equal(await page.getByText(/分类：/).count(), 17);
  await shot('PASSED-DESKTOP');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('PASSED-MOBILE');
  let fail = false,
    gate;
  await page.route('**/api/v1/admin/payment-adapter-lab/run**', async (route) => {
    if (gate) await gate;
    if (fail)
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '合成验证响应中断' } }),
      });
    return route.continue();
  });
  let release;
  gate = new Promise((r) => (release = r));
  await page.getByRole('button', { name: '运行合成验证', exact: true }).click();
  await page.getByRole('button', { name: '正在运行合成验证…', exact: true }).waitFor();
  assert.equal(await page.locator('.notification-lab-result').count(), 0);
  await shot('RUNNING');
  release();
  gate = undefined;
  await page.getByRole('heading', { name: '合成验证全部通过', exact: true }).waitFor();
  fail = true;
  await page.getByRole('button', { name: '运行合成验证', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '合成验证响应中断' }).waitFor();
  assert.equal(await page.locator('.notification-lab-result').count(), 0);
  await shot('ERROR');
  fail = false;
  await page.getByRole('button', { name: '重试验证', exact: true }).click();
  await page.getByRole('heading', { name: '合成验证全部通过', exact: true }).waitFor();
  await page.route('**/api/v1/admin/payment-adapter-lab?*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.enabled = false;
    return route.fulfill({ response, json: body });
  });
  await page.getByRole('button', { name: '刷新验证说明', exact: true }).click();
  await page.getByRole('heading', { name: '本机隔离验证尚未开启', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '运行合成验证', exact: true }).isDisabled(),
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
  assert.equal(await op.getByRole('button', { name: '渠道契约验证', exact: true }).count(), 0);
  await other.close();
  assert.equal(await f.runtime.db.consumerOrder.count(), 0);
  assert.equal(await f.runtime.db.paymentPreparation.count(), 0);
  console.log(
    'Actual payment adapter UI and isolated API: seventeen classification cases, desktop/mobile, running, retry, disabled and restricted navigation passed. Zero orders/preparations created. Screenshots: ' +
      shots.length,
  );
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  await f.cleanup();
}
