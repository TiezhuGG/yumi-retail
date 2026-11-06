/* global document, innerWidth */
// Actual operations UI + disposable PostgreSQL API. Never seeds the operational database.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pointsReportFixture } from '../../tests/helpers/points-report-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd(),
  dir = resolve('.local/points-report-ui');
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
    const path = 'docs/verification/UI-POINTS-REPORT-' + name + '-2026-11-06.png';
    await page.screenshot({ path, fullPage: true });
    shots.push(path);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'horizontal overflow: ' + name,
    );
  }

  for (let i = 0; i < 23; i++) await f.grant('UI-REPORT-' + i, '1');
  await page.goto('http://127.0.0.1:5188/');
  await page.getByRole('button', { name: '积分报表与对账', exact: true }).click();
  await page.getByText('存在未归属流水', { exact: true }).waitFor();
  assert.equal(await page.locator('.points-report-metrics article').count(), 5);
  assert.equal(await page.locator('.points-report-entries tbody tr').count(), 20);
  await shot('DESKTOP');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('MOBILE');
  await page.getByRole('button', { name: '加载更多积分明细', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.points-report-entries tbody tr').length === 29,
  );
  await shot('PAGINATION-MOBILE');
  await page.getByLabel('类型', { exact: true }).selectOption('RETURN');
  await page.waitForFunction(
    () => document.querySelectorAll('.points-report-entries tbody tr').length === 1,
  );
  await page.locator('summary').filter({ hasText: '每日积分变动' }).click();
  await shot('RETURN-FILTER-DAILY');
  // Intentionally damaged data exists only in this disposable schema. No repair UI.
  const db = f.runtime.db;
  const schema = (await db.$queryRawUnsafe('SELECT current_schema() AS schema'))[0].schema;
  assert.ok(schema.startsWith('address_ui_'));
  const entry = await db.pointsEntry.findUniqueOrThrow({
    where: { actionKey: 'GRANT:' + f.grantId },
  });
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('ALTER TABLE points_ledger DISABLE TRIGGER USER');
    await tx.$executeRawUnsafe('ALTER TABLE points_accounts DISABLE TRIGGER USER');
    await tx.pointsEntry.update({ where: { id: entry.id }, data: { delta: 121n } });
    await tx.pointsAccount.update({
      where: { userId: f.identity.user.id },
      data: { balance: { increment: 2n } },
    });
    await tx.pointsAccount.update({
      where: { userId: f.identityB.user.id },
      data: { balance: { decrement: 1n } },
    });
    await tx.$executeRawUnsafe('ALTER TABLE points_ledger ENABLE TRIGGER USER');
    await tx.$executeRawUnsafe('ALTER TABLE points_accounts ENABLE TRIGGER USER');
  });
  await page.getByLabel('类型', { exact: true }).selectOption('');
  await page.getByText('发现差异', { exact: true }).waitFor();
  await page.getByLabel('明细范围', { exact: true }).selectOption('ISSUES');
  await page.getByText('金额或归属不符', { exact: true }).waitFor();
  assert.equal(await page.locator('.points-report-entries tbody tr').count(), 1);
  assert.equal(await page.getByRole('button', { name: '查看账户流水', exact: true }).count(), 2);
  await shot('DIFFERENCES-MOBILE');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await shot('DIFFERENCES-DESKTOP');
  await page.getByRole('button', { name: '查看账户流水', exact: true }).first().click();
  await page.getByRole('dialog').getByRole('heading', { name: '积分明细', exact: true }).waitFor();
  await page.getByRole('dialog').getByRole('table').waitFor();
  await shot('ACCOUNT-LEDGER');
  await page.getByRole('dialog').getByRole('button', { name: '关闭表单', exact: true }).click();
  await page.getByLabel('明细范围', { exact: true }).selectOption('LEDGER');
  await page.getByLabel('开始日期', { exact: true }).fill('2000-01-01');
  await page.getByLabel('结束日期', { exact: true }).fill('2000-01-02');
  await page.getByRole('button', { name: '查询报表', exact: true }).click();
  await page.getByText('所选期间和类型暂无入账流水', { exact: true }).waitFor();
  await shot('EMPTY');
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/admin/points/report?**', async (route) => {
    await gate;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: '合成积分报表读取失败' } }),
    });
  });
  await page.getByRole('button', { name: '刷新报表', exact: true }).click();
  await page.getByText('正在核对积分报表…', { exact: true }).waitFor();
  assert.equal(await page.locator('.points-report-metrics article').count(), 0);
  await shot('LOADING');
  release();
  await page.getByRole('alert').filter({ hasText: '合成积分报表读取失败' }).waitFor();
  await shot('ERROR');
  await page.unroute('**/api/v1/admin/points/report?**');
  await page.getByRole('button', { name: '重试积分报表', exact: true }).click();
  await page.getByText('所选期间和类型暂无入账流水', { exact: true }).waitFor();
  await page.getByLabel('开始日期', { exact: true }).fill('2026-02-28');
  await page.getByLabel('结束日期', { exact: true }).fill('2026-01-01');
  await page.getByRole('button', { name: '查询报表', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '日期范围须为1至366天' }).waitFor();
  await shot('INVALID-RANGE');
  console.log(
    'Actual UI + isolated PG: 5 totals, actual daily detail, pagination/filter, source and account differences, account ledger, empty/loading/error/retry and range validation passed. Screenshots: ' +
      shots.length,
  );
} catch (e) {
  if (page) {
    await page.screenshot({ path: '.local/points-report-ui-failure.png', fullPage: true });
    await writeFile('.local/points-report-ui-failure.html', await page.content());
  }
  throw e;
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  await f.cleanup();
}
