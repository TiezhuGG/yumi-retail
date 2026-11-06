/* global document, innerWidth */
// Actual operations UI + disposable PostgreSQL API. Never seeds the operational database.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { rewardsFixture } from '../../tests/helpers/rewards-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd(),
  dir = resolve('.local/customer-status-ui');
const { createServer } = await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const f = await rewardsFixture();
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
    await page.getByText('正在读取顾客资料…', { exact: true }).waitFor({ state: 'hidden' });
    const path = 'docs/verification/UI-CUSTOMER-STATUS-' + name + '-2026-11-06.png';
    await page.screenshot({ path, fullPage: true });
    shots.push(path);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'horizontal overflow: ' + name,
    );
  }

  const customerId = f.identity.user.id;
  async function openCustomer() {
    await page.getByRole('button', { name: '顾客管理', exact: true }).click();
    await page.getByLabel('顾客名称', { exact: true }).fill('合成积分顾客 A');
    await page.getByRole('button', { name: '查询顾客', exact: true }).click();
    await page
      .getByRole('row')
      .filter({ hasText: '合成积分顾客 A' })
      .getByRole('button', { name: '查看顾客', exact: true })
      .click();
    await page.getByRole('heading', { name: '账号状态与操作记录', exact: true }).waitFor();
  }
  const change = async (action, reason = '合成界面外并发操作') => {
    const u = await f.runtime.db.consumerUser.findUniqueOrThrow({ where: { id: customerId } });
    const r = await f.api('/admin/customers/' + customerId + '/status/' + action, {
      version: u.authVersion,
      reason,
      confirmed: true,
    });
    assert.equal(r.status, 200);
  };
  await page.goto('http://127.0.0.1:5188/');
  await openCustomer();
  await page.getByText('暂无停用或恢复记录', { exact: true }).waitFor();
  await shot('EMPTY-DESKTOP');
  await page.getByRole('button', { name: '停用账号', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '停用顾客账号', exact: true });
  assert.ok(await dialog.getByRole('button', { name: '确认停用', exact: true }).isDisabled());
  await dialog.getByLabel('操作原因', { exact: true }).fill('合成身份争议，核实期间暂停');
  await dialog.getByLabel('我已核实顾客及操作影响', { exact: true }).check();
  await shot('CONFIRM-DESKTOP');
  let originalKey;
  await page.route('**/api/v1/admin/customers/' + customerId + '/status/disable', async (route) => {
    originalKey = route.request().headers()['idempotency-key'];
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    await route.abort('failed');
  });
  await dialog.getByRole('button', { name: '确认停用', exact: true }).click();
  await dialog.getByRole('button', { name: '使用原请求核实结果', exact: true }).waitFor();
  await shot('UNKNOWN');
  assert.equal(
    await f.runtime.db.businessAudit.count({
      where: { resourceId: customerId, action: 'CUSTOMER_DISABLED' },
    }),
    1,
  );
  await page.unroute('**/api/v1/admin/customers/' + customerId + '/status/disable');
  await page.reload();
  await openCustomer();
  dialog = page.getByRole('dialog', { name: '停用顾客账号', exact: true });
  await dialog.getByRole('button', { name: '使用原请求核实结果', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('RESTORED-MOBILE');
  const replay = page.waitForRequest(
    (r) => r.url().includes('/status/disable') && r.method() === 'POST',
  );
  await dialog.getByRole('button', { name: '使用原请求核实结果', exact: true }).click();
  assert.equal((await replay).headers()['idempotency-key'], originalKey);
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '恢复账号', exact: true }).waitFor();
  assert.equal(
    await f.runtime.db.businessAudit.count({
      where: { resourceId: customerId, action: 'CUSTOMER_DISABLED' },
    }),
    1,
  );
  await shot('DISABLED-MOBILE');
  await page.getByRole('button', { name: '发放积分', exact: true }).click();
  assert.ok(await page.getByRole('button', { name: '申请发放积分', exact: true }).isDisabled());
  await page.getByRole('button', { name: '积分明细', exact: true }).click();
  await page.getByRole('button', { name: '恢复账号', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '恢复顾客账号', exact: true });
  await dialog.getByLabel('操作原因', { exact: true }).fill('合成核实完成，恢复使用');
  await dialog.getByLabel('我已核实顾客及操作影响', { exact: true }).check();
  await dialog.getByRole('button', { name: '确认恢复', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '停用账号', exact: true }).waitFor();
  await shot('ENABLED-MOBILE');
  // A different administrator changed status twice while this confirmation was open.
  await page.getByRole('button', { name: '停用账号', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '停用顾客账号', exact: true });
  await dialog.getByLabel('操作原因', { exact: true }).fill('合成旧状态提交');
  await dialog.getByLabel('我已核实顾客及操作影响', { exact: true }).check();
  await change('disable');
  await change('enable');
  await dialog.getByRole('button', { name: '确认停用', exact: true }).click();
  await dialog.getByRole('alert').filter({ hasText: '账号状态已变化' }).waitFor();
  assert.ok(await dialog.getByRole('button', { name: '确认停用', exact: true }).isDisabled());
  await shot('CONFLICT');
  await dialog.getByRole('button', { name: '关闭表单', exact: true }).click();
  await page.getByRole('button', { name: '停用账号', exact: true }).waitFor();
  for (let i = 0; i < 9; i++) {
    await change('disable');
    await change('enable');
  }
  await page.getByRole('button', { name: '刷新操作记录', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.customer-status-history li').length === 20,
  );
  await page.getByRole('button', { name: '加载更多账号记录', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.customer-status-history li').length === 22,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await shot('HISTORY-DESKTOP');
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/admin/customers/' + customerId + '/status-history', async (route) => {
    await gate;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: '合成账号记录读取失败' } }),
    });
  });
  await page.getByRole('button', { name: '刷新操作记录', exact: true }).click();
  await page.getByText('正在读取账号操作记录…', { exact: true }).waitFor();
  await shot('LOADING');
  release();
  await page.getByRole('alert').filter({ hasText: '合成账号记录读取失败' }).waitFor();
  assert.equal(await page.locator('.customer-status-history li').count(), 0);
  await shot('ERROR');
  await page.unroute('**/api/v1/admin/customers/' + customerId + '/status-history');
  await page.getByRole('button', { name: '重试操作记录', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.customer-status-history li').length === 20,
  );
  const { data: profile } = await (
    await fetch(f.base + '/api/v1/staff/me', { headers: { Cookie: f.cookie } })
  ).json();
  await f.runtime.db.staffRole.updateMany({
    where: { staffId: profile.id },
    data: { roleCode: 'OPERATIONS' },
  });
  await page.reload();
  await openCustomer();
  await page.getByText('账号状态由负责人维护', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '停用账号', exact: true }).count(), 0);
  await shot('OPERATIONS-READONLY');
  console.log(
    'Actual UI + isolated PG: explicit confirmation, lost-response original-key recovery across reload, disable/restore, conflicts, 20+2 history, loading/error/retry, mobile and read-only operations passed. Screenshots: ' +
      shots.length,
  );
} catch (e) {
  if (page) {
    await page.screenshot({ path: '.local/customer-status-ui-failure.png', fullPage: true });
    await writeFile('.local/customer-status-ui-failure.html', await page.content());
  }
  throw e;
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  await f.cleanup();
}
