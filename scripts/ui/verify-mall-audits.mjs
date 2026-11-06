/* global document, innerWidth, window */
// Actual operations UI + disposable PostgreSQL API. Never seeds the operational database.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { URLSearchParams } from 'node:url';
import { pointsReportFixture } from '../../tests/helpers/points-report-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd(),
  dir = resolve('.local/mall-audits-ui');
const { createServer } = await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const f = await pointsReportFixture();
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
    const path = 'docs/verification/UI-MALL-AUDITS-' + name + '-2026-11-07.png';
    await page.screenshot({ path, fullPage: false });
    shots.push(path);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'horizontal overflow: ' + name,
    );
  }

  for (let i = 0; i < 13; i++) await f.grant('UI-AUDIT-' + i, '1');
  const q = new URLSearchParams(f.reportQuery);
  const generated = await f.api('/admin/points/report/export', {
    from: q.get('from'),
    to: q.get('to'),
    dataset: 'LEDGER',
  });
  assert.equal(generated.status, 200);
  const exported = await f.runtime.db.businessAudit.findFirstOrThrow({
    where: { action: 'POINTS_REPORT_EXPORT', resourceId: generated.data.id },
  });
  assert.equal(
    (
      await f.api('/admin/customers/' + f.identity.user.id + '/notes', {
        message: 'SYNTHETIC-PRIVATE-UI-NOTE',
        scopeId: f.warehouseId,
      })
    ).status,
    200,
  );
  const before = JSON.stringify(
    [
      await f.runtime.db.pointsAccount.findMany(),
      await f.runtime.db.pointsEntry.findMany(),
      await f.runtime.db.businessAudit.count(),
    ],
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
  );
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/admin/mall/audits?*', async (route) => {
    await held;
    await route.continue();
  });
  await page.goto('http://127.0.0.1:5188/');
  await page.getByRole('button', { name: '商城操作记录', exact: true }).click();
  await page.getByText('正在读取商城操作记录…', { exact: true }).waitFor();
  await shot('LOADING');
  release();
  await page.locator('.mall-audit-table tbody tr').first().waitFor();
  await page.unroute('**/admin/mall/audits?*');
  assert.equal(await page.locator('.mall-audit-table tbody tr').count(), 20);
  await shot('DESKTOP');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('MOBILE');
  await page.locator('.mall-audit-table tbody tr').first().scrollIntoViewIfNeeded();
  await shot('CARD-MOBILE');
  await page.getByRole('button', { name: '加载更多操作记录', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.mall-audit-table tbody tr').length > 20,
  );
  await shot('PAGINATION-MOBILE');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.route('**/admin/mall/audits?*', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'SYNTHETIC_UNAVAILABLE', message: '合成操作记录暂不可用' },
      }),
    }),
  );
  await page.getByRole('button', { name: '刷新操作记录', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '合成操作记录暂不可用' }).waitFor();
  assert.equal(await page.locator('.mall-audit-table tbody tr').count(), 0);
  await shot('ERROR');
  await page.unroute('**/admin/mall/audits?*');
  await page.getByRole('button', { name: '重试操作记录', exact: true }).click();
  await page.locator('.mall-audit-table tbody tr').first().waitFor();
  await page.getByLabel('操作人', { exact: true }).fill('不存在的操作人');
  await page.getByRole('button', { name: '查询操作记录', exact: true }).click();
  await page.getByText('当前条件暂无商城操作记录', { exact: true }).waitFor();
  await shot('EMPTY');
  await page.getByLabel('操作人', { exact: true }).fill('');
  await page.getByLabel('操作类别', { exact: true }).selectOption('CUSTOMERS');
  await page.getByRole('button', { name: '查询操作记录', exact: true }).click();
  await page.getByText('新增顾客内部备注', { exact: true }).waitFor();
  await page.getByRole('button', { name: '查看记录', exact: true }).first().click();
  let dialog = page.getByRole('dialog', { name: '商城操作记录详情', exact: true });
  await dialog.getByText('新增顾客内部备注', { exact: true }).waitFor();
  assert.ok(!(await dialog.textContent()).includes('SYNTHETIC-PRIVATE-UI-NOTE'));
  await shot('CUSTOMER-DETAIL');
  await dialog.getByRole('button', { name: '关闭表单', exact: true }).click();
  await page.getByLabel('操作类别', { exact: true }).selectOption('EXPORTS');
  await page.getByRole('button', { name: '查询操作记录', exact: true }).click();
  await page.getByText('生成积分报表文件', { exact: true }).waitFor();
  const endpoint = '**/admin/mall/audits/' + exported.id;
  await page.route(endpoint, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'SYNTHETIC_DETAIL', message: '合成详情读取失败' } }),
    }),
  );
  await page.getByRole('button', { name: '查看记录', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '商城操作记录详情', exact: true });
  await dialog.getByRole('alert').filter({ hasText: '合成详情读取失败' }).waitFor();
  await shot('DETAIL-ERROR');
  await page.unroute(endpoint);
  await dialog.getByRole('button', { name: '重试操作详情', exact: true }).click();
  await dialog.getByRole('heading', { name: '文件生成范围', exact: true }).waitFor();
  assert.ok((await dialog.textContent()).includes('19行'));
  await shot('EXPORT-DETAIL');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('DETAIL-MOBILE');
  await dialog.getByRole('button', { name: '关闭表单', exact: true }).click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const staff = await f.runtime.db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } });
  await f.runtime.db.staffWarehouse.deleteMany({
    where: { staffId: staff.id, warehouseId: f.warehouseId },
  });
  await page.getByRole('button', { name: '刷新操作记录', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '当前账号无积分操作权限' }).waitFor();
  assert.equal(await page.locator('.mall-audit-table tbody tr').count(), 0);
  await shot('PERMISSION');
  assert.equal(
    JSON.stringify(
      [
        await f.runtime.db.pointsAccount.findMany(),
        await f.runtime.db.pointsEntry.findMany(),
        await f.runtime.db.businessAudit.count(),
      ],
      (_, v) => (typeof v === 'bigint' ? v.toString() : v),
    ),
    before,
  );
  console.log(
    'Actual UI + isolated PG: loading/list/mobile cards, pagination, errors/retry/empty, private note redaction, validated export scope detail and revoked-permission clearing passed; screenshots ' +
      shots.length,
  );
} catch (e) {
  if (page) {
    await page.screenshot({ path: '.local/mall-audits-ui-failure.png', fullPage: true });
    await writeFile('.local/mall-audits-ui-failure.html', await page.content());
  }
  throw e;
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  await f.cleanup();
}
