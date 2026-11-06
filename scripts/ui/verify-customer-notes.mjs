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
  dir = resolve('.local/customer-notes-ui');
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
    const path = 'docs/verification/UI-CUSTOMER-NOTES-' + name + '-2026-11-06.png';
    await page.screenshot({ path, fullPage: true });
    shots.push(path);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'horizontal overflow: ' + name,
    );
  }

  const customerId = f.identity.user.id;
  const notePath = '/api/v1/admin/customers/' + customerId + '/notes';
  async function openCustomer() {
    await page.getByRole('button', { name: '顾客管理', exact: true }).click();
    await page.getByLabel('顾客名称', { exact: true }).fill('合成积分顾客 A');
    await page.getByRole('button', { name: '查询顾客', exact: true }).click();
    await page
      .getByRole('row')
      .filter({ hasText: '合成积分顾客 A' })
      .getByRole('button', { name: '查看顾客', exact: true })
      .click();
    await page.getByRole('heading', { name: '内部备注与跟进', exact: true }).waitFor();
  }
  await page.goto('http://127.0.0.1:5188/');
  await openCustomer();
  await page.getByText('暂无内部备注', { exact: true }).waitFor();
  await shot('EMPTY-DESKTOP');
  await page.getByRole('button', { name: '新增备注', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '新增顾客内部备注', exact: true });
  assert.ok(await dialog.getByRole('button', { name: '保存内部备注', exact: true }).isDisabled());
  await dialog
    .getByLabel('备注内容', { exact: true })
    .fill('合成跟进：下次沟通时核对商品规格。\n补充记录：暂未收到进一步反馈。');
  await shot('EDITOR-DESKTOP');
  let originalKey;
  await page.route('**' + notePath, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    originalKey = route.request().headers()['idempotency-key'];
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    await route.abort('failed');
  });
  await dialog.getByRole('button', { name: '保存内部备注', exact: true }).click();
  await dialog.getByRole('button', { name: '使用原请求核实备注', exact: true }).waitFor();
  await shot('UNKNOWN');
  assert.equal(
    await f.runtime.db.businessAudit.count({
      where: { action: 'CUSTOMER_NOTE_ADDED', resourceId: customerId, warehouseId: f.warehouseId },
    }),
    1,
  );
  await page.unroute('**' + notePath);
  await page.reload();
  await openCustomer();
  dialog = page.getByRole('dialog', { name: '新增顾客内部备注', exact: true });
  await dialog.getByRole('button', { name: '使用原请求核实备注', exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('RESTORED-MOBILE');
  const replay = page.waitForRequest((r) => r.url().endsWith(notePath) && r.method() === 'POST');
  await dialog.getByRole('button', { name: '使用原请求核实备注', exact: true }).click();
  assert.equal((await replay).headers()['idempotency-key'], originalKey);
  await dialog.waitFor({ state: 'hidden' });
  await page.locator('.customer-notes-list li').waitFor();
  await shot('SAVED-MOBILE');
  assert.equal(
    await f.runtime.db.businessAudit.count({
      where: { action: 'CUSTOMER_NOTE_ADDED', resourceId: customerId, warehouseId: f.warehouseId },
    }),
    1,
  );
  for (let i = 0; i < 22; i++) {
    const r = await f.api('/admin/customers/' + customerId + '/notes', {
      message: '合成分页跟进记录 ' + i,
      scopeId: f.warehouseId,
    });
    assert.equal(r.status, 200);
  }
  await page.getByRole('button', { name: '刷新内部备注', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.customer-notes-list li').length === 20,
  );
  await page.getByRole('button', { name: '加载更多内部备注', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.customer-notes-list li').length === 23,
  );
  await shot('PAGINATION-MOBILE');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await shot('HISTORY-DESKTOP');
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**' + notePath, async (route) => {
    await gate;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: '合成内部备注读取失败' } }),
    });
  });
  await page.getByRole('button', { name: '刷新内部备注', exact: true }).click();
  await page.getByText('正在读取内部备注…', { exact: true }).waitFor();
  assert.equal(await page.locator('.customer-notes-list li').count(), 0);
  await shot('LOADING');
  release();
  await page.getByRole('alert').filter({ hasText: '合成内部备注读取失败' }).waitFor();
  await shot('ERROR');
  await page.unroute('**' + notePath);
  await page.getByRole('button', { name: '重试内部备注', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.customer-notes-list li').length === 20,
  );
  // Ordinary operations staff can append internal notes, while status remains supervisor-only.
  const { data: p } = await (
    await fetch(f.base + '/api/v1/staff/me', { headers: { Cookie: f.cookie } })
  ).json();
  await f.runtime.db.staffRole.updateMany({
    where: { staffId: p.id },
    data: { roleCode: 'OPERATIONS' },
  });
  await page.reload();
  await openCustomer();
  await page.getByText('账号状态由负责人维护', { exact: true }).waitFor();
  await page.getByRole('button', { name: '新增备注', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '新增顾客内部备注', exact: true });
  await dialog.getByLabel('备注内容', { exact: true }).fill('合成运营人员追加跟进');
  await dialog.getByRole('button', { name: '保存内部备注', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByText('合成运营人员追加跟进', { exact: true }).waitFor();
  await shot('OPERATIONS');
  console.log(
    'Actual UI + isolated PG: empty, editor, real encrypted write, lost-response original-key recovery across reload, 20+3 pagination, mobile, loading/error/retry and operations append passed. Screenshots: ' +
      shots.length,
  );
} catch (e) {
  if (page) {
    await page.screenshot({ path: '.local/customer-notes-ui-failure.png', fullPage: true });
    await writeFile('.local/customer-notes-ui-failure.html', await page.content());
  }
  throw e;
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  await f.cleanup();
}
