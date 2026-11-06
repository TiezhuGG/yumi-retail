/* global document, innerWidth */
// Actual operations UI + disposable PostgreSQL API. Never seeds the operational database.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pointsReportFixture } from '../../tests/helpers/points-report-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd(),
  dir = resolve('.local/points-report-export-ui');
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
    const path = 'docs/verification/UI-POINTS-REPORT-EXPORT-' + name + '-2026-11-07.png';
    await page.screenshot({ path, fullPage: (await page.locator('dialog[open]').count()) === 0 });
    shots.push(path);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'horizontal overflow: ' + name,
    );
  }

  for (let i = 0; i < 23; i++) await f.grant('UI-EXPORT-' + i, '1');
  const before = JSON.stringify(
    [await f.runtime.db.pointsAccount.findMany(), await f.runtime.db.pointsEntry.findMany()],
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
  );
  await page.goto('http://127.0.0.1:5188/');
  await page.getByRole('button', { name: '积分报表与对账', exact: true }).click();
  await page.getByRole('button', { name: '导出入账明细', exact: true }).waitFor();
  assert.equal(await page.locator('.points-report-entries tbody tr').count(), 20);
  const from = await page.getByLabel('开始日期', { exact: true }).inputValue(),
    to = await page.getByLabel('结束日期', { exact: true }).inputValue();
  // Unsaved date inputs do not silently alter the applied report/export scope.
  await page.getByLabel('开始日期', { exact: true }).fill('2000-01-01');
  await page.getByRole('button', { name: '导出入账明细', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: '导出积分入账明细', exact: true });
  await dialog.getByText(from + ' 至 ' + to + '（含结束当日）', { exact: true }).waitFor();
  await shot('SCOPE-DESKTOP');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('SCOPE-MOBILE');
  await page.setViewportSize({ width: 1440, height: 1000 });
  let releases;
  const held = new Promise((resolve) => {
    releases = resolve;
  });
  let downloads = 0;
  page.on('download', () => {
    downloads++;
  });
  await page.route('**/admin/points/report/export', async (route) => {
    await held;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'SYNTHETIC_UNAVAILABLE', message: '合成导出暂不可用' },
      }),
    });
  });
  await dialog.getByRole('button', { name: '生成并下载CSV', exact: true }).click();
  await dialog.getByText('正在生成积分报表文件…', { exact: true }).waitFor();
  await shot('LOADING');
  releases();
  await dialog.getByRole('alert').filter({ hasText: '合成导出暂不可用' }).waitFor();
  await shot('ERROR');
  assert.equal(downloads, 0);
  await page.unroute('**/admin/points/report/export');
  const downloadEvent = page.waitForEvent('download');
  const requested = page.waitForRequest((r) => r.url().endsWith('/admin/points/report/export'));
  await dialog.getByRole('button', { name: '重试生成并下载', exact: true }).click();
  assert.equal((await requested).postDataJSON().from, from);
  const download = await downloadEvent,
    content = await readFile(await download.path(), 'utf8');
  assert.ok(download.suggestedFilename().includes('入账明细'));
  assert.ok(content.startsWith('\uFEFF'));
  assert.equal(content.split('\r\n').length, 31);
  for (let i = 0; i < 23; i++) assert.ok(content.includes('UI-EXPORT-' + i));
  await dialog.getByRole('heading', { name: '导出文件已生成', exact: true }).waitFor();
  await shot('LEDGER-SUCCESS');
  assert.equal(
    await f.runtime.db.businessAudit.count({ where: { action: 'POINTS_REPORT_EXPORT' } }),
    1,
  );
  const repeat = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '再次下载文件', exact: true }).click();
  assert.equal(await readFile(await (await repeat).path(), 'utf8'), content);
  assert.equal(
    await f.runtime.db.businessAudit.count({ where: { action: 'POINTS_REPORT_EXPORT' } }),
    1,
  );
  await dialog.getByRole('button', { name: '关闭表单', exact: true }).click();
  await page.getByLabel('类型', { exact: true }).selectOption('RETURN');
  await page.waitForFunction(
    () => document.querySelectorAll('.points-report-entries tbody tr').length === 1,
  );
  await page.getByRole('button', { name: '导出入账明细', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '导出积分入账明细', exact: true });
  await dialog.getByText('售后退回', { exact: true }).waitFor();
  await shot('FILTERED');
  const filteredEvent = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '生成并下载CSV', exact: true }).click();
  const filtered = await readFile(await (await filteredEvent).path(), 'utf8');
  assert.equal(filtered.split('\r\n').length, 3);
  assert.ok(filtered.includes('售后退回'));
  assert.ok(!filtered.includes('商品兑换'));
  await dialog.getByRole('button', { name: '关闭表单', exact: true }).click();
  await page.locator('summary').filter({ hasText: '每日积分变动' }).click();
  await page.getByRole('button', { name: '导出每日汇总', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '导出每日积分汇总', exact: true });
  await dialog.getByText('全部类型', { exact: true }).waitFor();
  await shot('DAILY-SCOPE');
  const dailyEvent = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '生成并下载CSV', exact: true }).click();
  const daily = await readFile(await (await dailyEvent).path(), 'utf8');
  assert.ok(daily.includes('"383","250","133"'));
  await shot('DAILY-SUCCESS');
  await dialog.getByRole('button', { name: '关闭表单', exact: true }).click();
  await page.getByLabel('明细范围', { exact: true }).selectOption('ISSUES');
  await page.getByText('当前类型未发现业务流水差异', { exact: true }).waitFor();
  assert.ok(await page.getByRole('button', { name: '导出入账明细', exact: true }).isDisabled());
  await shot('ISSUES-SCOPE');
  await page.getByLabel('明细范围', { exact: true }).selectOption('LEDGER');
  await page.getByLabel('开始日期', { exact: true }).fill('2000-01-01');
  await page.getByLabel('结束日期', { exact: true }).fill('2000-01-02');
  await page.getByRole('button', { name: '查询报表', exact: true }).click();
  await page.getByText('所选期间和类型暂无入账流水', { exact: true }).waitFor();
  await page.getByRole('button', { name: '导出入账明细', exact: true }).click();
  dialog = page.getByRole('dialog', { name: '导出积分入账明细', exact: true });
  const emptyEvent = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '生成并下载CSV', exact: true }).click();
  const empty = await readFile(await (await emptyEvent).path(), 'utf8');
  assert.equal(empty.split('\r\n').length, 2);
  await dialog.getByText('当前范围暂无入账数据，文件仅包含表头。', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('EMPTY-MOBILE');
  assert.equal(
    JSON.stringify(
      [await f.runtime.db.pointsAccount.findMany(), await f.runtime.db.pointsEntry.findMany()],
      (_, v) => (typeof v === 'bigint' ? v.toString() : v),
    ),
    before,
  );
  console.log(
    'Actual UI + isolated PG: applied filter scope, desktop/mobile, loading/error/retry, complete 29-row CSV actual download, repeat download, filtered ledger, all-kind daily totals, issues exclusion and empty header passed; screenshots ' +
      shots.length,
  );
} catch (e) {
  if (page) {
    await page.screenshot({ path: '.local/points-report-export-ui-failure.png', fullPage: true });
    await writeFile('.local/points-report-export-ui-failure.html', await page.content());
  }
  throw e;
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  await f.cleanup();
}
