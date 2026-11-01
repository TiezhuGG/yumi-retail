/* global document, innerWidth, window */
// Actual operations UI + disposable PostgreSQL API. Never seeds the operational database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { orderAdminFixture } from '../../tests/helpers/order-admin-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd(),
  dir = resolve('.local/evidence-timeline-ui');
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
    const path = 'docs/verification/UI-EVIDENCE-TIMELINE-' + name + '-2026-11-01.png';
    await page.screenshot({ path, fullPage: true });
    shots.push(path);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'horizontal overflow: ' + name,
    );
  }
  const csrf = (await f.staff('/staff/me', f.extraCookies[0])).data.csrfToken;
  async function post(path, body) {
    const r = await fetch(f.base + '/api/v1' + path + '?warehouseId=' + f.warehouseId, {
      method: 'POST',
      headers: {
        Cookie: f.extraCookies[0],
        Origin: 'http://127.0.0.1:5188',
        'X-CSRF-Token': csrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 200);
    return (await r.json()).data;
  }
  const a = await post('/admin/payment-attempt-lab', { key: randomUUID() }),
    id = a.attempt.id;
  await post('/admin/payment-attempt-lab/' + id + '/actions/unknown-result', { key: randomUUID() });
  await post('/admin/payment-attempt-lab/run-query-cycle', { scenario: 'CLOSED' });
  await post('/admin/payment-notification-records', { key: randomUUID(), attemptId: id });
  await post('/admin/payment-notification-records', { key: randomUUID(), attemptId: id });
  await page.goto('http://127.0.0.1:5188/');
  await page.getByRole('button', { name: '补偿核查', exact: true }).click();
  await page.getByRole('button', { name: '查看核查详情', exact: true }).click();
  await page.getByRole('heading', { name: '统一证据时间线', exact: true }).waitFor();
  await page.locator('.evidence-timeline-row').first().waitFor();
  await page.getByRole('combobox', { name: '证据来源', exact: true }).selectOption('NOTE');
  await page.getByText('当前来源暂无证据记录', { exact: true }).waitFor();
  await shot('EMPTY-NOTES-DESKTOP');
  const note = '合成时间线核查：<script>window.__timelineInjected=true</script>，继续保留冲突。';
  await page.getByRole('textbox', { name: '合成核查备注', exact: true }).fill(note);
  await page.getByRole('button', { name: '保存核查备注', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '核查备注已保存' }).waitFor();
  await page.locator('.evidence-timeline-row').filter({ hasText: note }).waitFor();
  assert.equal(await page.locator('.evidence-timeline-row script').count(), 0);
  assert.equal(await page.evaluate(() => window.__timelineInjected), undefined);
  await shot('ALL-DESKTOP');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('ALL-MOBILE');
  await page.getByRole('button', { name: '定位备注快照的尝试证据', exact: true }).click();
  await page.locator('.evidence-timeline-row.is-focused').waitFor();
  await page.getByText('当前定位', { exact: true }).waitFor();
  assert.ok(
    await page.evaluate(() =>
      document.activeElement?.getAttribute('data-evidence-ref')?.startsWith('ATTEMPT:'),
    ),
  );
  await page.waitForFunction(() => {
    const row = document.querySelector('.evidence-timeline-row.is-focused'),
      bar = document.querySelector('.sidebar');
    return row && bar && row.getBoundingClientRect().top >= bar.getBoundingClientRect().bottom + 8;
  });
  await shot('FOCUS-ATTEMPT-MOBILE');
  assert.ok(
    (
      await page.locator('.evidence-timeline-row').first().getAttribute('data-evidence-ref')
    ).startsWith('ATTEMPT:'),
  );
  await page.getByRole('button', { name: '定位最新关联通知', exact: true }).first().click();
  await page.waitForFunction(() =>
    document
      .querySelector('.evidence-timeline-row.is-focused')
      ?.dataset.evidenceRef.startsWith('NOTIFICATION:'),
  );
  await shot('FOCUS-NOTIFICATION-MOBILE');
  await page.getByRole('button', { name: '返回最新时间线', exact: true }).click();
  await page.getByRole('combobox', { name: '证据来源', exact: true }).selectOption('QUERY');
  await page
    .locator('.evidence-timeline-row')
    .filter({ hasText: '通知证据结算查询任务' })
    .waitFor();
  await shot('QUERY-MOBILE');
  let fail = true,
    gate,
    release;
  await page.route('**/api/v1/admin/payment-review-lab/*/timeline?*', async (route) => {
    if (gate) await gate;
    if (fail)
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '合成时间线响应中断' } }),
      });
    return route.continue();
  });
  gate = new Promise((r) => (release = r));
  await page.getByRole('button', { name: '查看最新证据', exact: true }).click();
  await page.getByText('正在读取证据时间线…', { exact: true }).waitFor();
  await shot('LOADING-MOBILE');
  release();
  gate = undefined;
  await page.getByRole('alert').filter({ hasText: '合成时间线响应中断' }).waitFor();
  await shot('ERROR-MOBILE');
  fail = false;
  await page.getByRole('button', { name: '重试时间线', exact: true }).click();
  await page.locator('.evidence-timeline-row').first().waitFor();
  await page.unroute('**/api/v1/admin/payment-review-lab/*/timeline?*');
  const detail = (
    await f.staff(
      '/admin/payment-review-lab/' + id + '?warehouseId=' + f.warehouseId,
      f.extraCookies[0],
    )
  ).data;
  for (let i = 0; i < 23; i++)
    await post('/admin/payment-review-lab/' + id + '/notes', {
      key: randomUUID(),
      note: '合成分页备注 ' + i,
      attemptVersion: detail.item.attemptVersion,
      jobVersion: detail.item.jobVersion,
    });
  await page.getByRole('combobox', { name: '证据来源', exact: true }).selectOption('NOTE');
  await page.getByRole('button', { name: '加载更早证据', exact: true }).waitFor();
  assert.equal(await page.locator('.evidence-timeline-row').count(), 20);
  await page
    .getByText('当前证据或备注已有更新，请刷新核查详情后保存备注。', { exact: false })
    .waitFor();
  await page.getByRole('button', { name: '加载更早证据', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.evidence-timeline-row').length === 24,
  );
  await shot('PAGED-NOTES-MOBILE');
  await page
    .getByRole('textbox', { name: '合成核查备注', exact: true })
    .fill('合成草稿在同步快照时保留');
  await page.getByRole('button', { name: '同步核查快照', exact: true }).click();
  await page.locator('.evidence-timeline-row').first().waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: '合成核查备注', exact: true }).inputValue(),
    '合成草稿在同步快照时保留',
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await shot('REFRESHED-DESKTOP');
  const op = await browser.newContext();
  await op.addCookies([
    {
      name: 'yumi_staff_session',
      value: f.cookies[0].split('=')[1],
      domain: '127.0.0.1',
      path: '/',
    },
  ]);
  const other = await op.newPage();
  await other.goto('http://127.0.0.1:5188/');
  await other.getByRole('button', { name: '订单查询', exact: true }).waitFor();
  assert.equal(await other.getByRole('button', { name: '补偿核查', exact: true }).count(), 0);
  await op.close();
  assert.equal(await f.runtime.db.consumerOrder.count(), 0);
  assert.equal(await f.runtime.db.paymentPreparation.count(), 0);
  console.log(
    'Actual unified evidence UI/API passed: all sources, empty notes, plain text, exact focus links, query filter, loading/error/retry, live snapshot change with draft preserved, pagination, role navigation and desktop/mobile without overflow. Screenshots: ' +
      shots.length,
  );
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  await f.cleanup();
}
