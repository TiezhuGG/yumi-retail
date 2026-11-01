/* global document, innerWidth, window */
// Actual operations UI + disposable PostgreSQL API. Never seeds the operational database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { claimPaymentQueryLab } from '../../packages/database/dist/index.js';
import { orderAdminFixture } from '../../tests/helpers/order-admin-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd(),
  dir = resolve('.local/review-summary-ui');
const { createServer } = await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const f = await orderAdminFixture({ notificationLab: true });
let server, browser;
const pendingReleases = [];
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
    const path = 'docs/verification/UI-REVIEW-SUMMARY-' + name + '-2026-11-01.png';
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

  const admin = (await f.staff('/staff/me', f.extraCookies[0])).data;
  const second = await f.runtime.db.warehouse.create({
    data: { id: randomUUID(), code: 'SUMMARY-SECOND', name: '概览空测试仓' },
  });
  await f.runtime.db.staffWarehouse.create({ data: { staffId: admin.id, warehouseId: second.id } });
  async function start(action) {
    const a = await post('/admin/payment-attempt-lab', { key: randomUUID() });
    if (action)
      await post('/admin/payment-attempt-lab/' + a.attempt.id + '/actions/' + action, {
        key: randomUUID(),
      });
    return a.attempt.id;
  }
  const exhausted = await start('unknown-result');
  for (let i = 0; i < 3; i++) {
    assert.ok(await claimPaymentQueryLab(f.runtime.db, f.warehouseId, 1));
    await new Promise((r) => setTimeout(r, 1100));
  }
  await claimPaymentQueryLab(f.runtime.db, f.warehouseId);
  await post('/admin/payment-attempt-lab/' + exhausted + '/actions/success-result', {
    key: randomUUID(),
  });
  await start('unknown-result');
  await post('/admin/payment-attempt-lab/run-query-cycle', { scenario: 'MISSING' });
  const conflict = await start('success-result');
  await post('/admin/payment-attempt-lab/' + conflict + '/actions/closed-result', {
    key: randomUUID(),
  });
  for (let i = 0; i < 23; i++) await start('unknown-result');
  const nav = (name) => page.getByRole('button', { name, exact: true });
  const overview = page.getByRole('region', { name: '合成核查概览', exact: true });
  const card = (name) => overview.locator('.review-overview-card').filter({ hasText: name });
  let entered, release;
  const reached = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (release = r));
  pendingReleases.push(release);
  await page.route('**/api/v1/admin/payment-review-lab/summary?*', async (route) => {
    entered();
    await gate;
    return route.continue();
  });
  await page.goto('http://127.0.0.1:5188/');
  await nav('补偿核查').click();
  await reached;
  await overview.getByText('正在读取核查概览…', { exact: true }).waitFor();
  assert.equal(await overview.locator('.review-overview-card').count(), 0);
  await shot('LOADING-DESKTOP');
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await card('全部待核查').waitFor();
  assert.equal(await card('全部待核查').locator('strong').innerText(), '26 条');
  assert.equal(await card('结果未知').locator('strong').innerText(), '24 条');
  for (const label of ['结果冲突', '查询耗尽', '分类待核查'])
    assert.equal(await card(label).locator('strong').innerText(), '1 条');
  await overview.locator('time').waitFor();
  await shot('COUNTS-DESKTOP');
  await card('结果冲突').click();
  assert.equal(
    await page.getByRole('combobox', { name: '核查筛选', exact: true }).inputValue(),
    'CONFLICT',
  );
  await page.waitForFunction(
    () =>
      document.querySelectorAll('#payment-review-list .text-button').length === 1 &&
      !document.querySelector('#payment-review-list .text-button').disabled,
  );
  await nav('查看核查详情').click();
  await page
    .getByRole('textbox', { name: '合成核查备注', exact: true })
    .fill('从概览筛选后仍保留的草稿');
  await card('结果未知').click();
  await nav('加载更多待核查记录').waitFor();
  assert.equal(await page.locator('#payment-review-list .readiness-check').count(), 20);
  await nav('加载更多待核查记录').click();
  await page.waitForFunction(
    () => document.querySelectorAll('#payment-review-list .readiness-check').length === 24,
  );
  assert.equal(await card('全部待核查').locator('strong').innerText(), '26 条');
  await card('结果冲突').click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('#payment-review-list .text-button').length === 1 &&
      !document.querySelector('#payment-review-list .text-button').disabled,
  );
  await nav('查看核查详情').click();
  assert.equal(
    await page.getByRole('textbox', { name: '合成核查备注', exact: true }).inputValue(),
    '从概览筛选后仍保留的草稿',
  );
  await card('全部待核查').click();
  await page.waitForFunction(
    () => document.querySelectorAll('#payment-review-list .readiness-check').length === 20,
  );
  await card('查询耗尽').click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('#payment-review-list .text-button').length === 1 &&
      !document.querySelector('#payment-review-list .text-button').disabled,
  );
  await nav('查看核查详情').click();
  await page.getByText('合成成功待核对', { exact: false }).first().waitFor();
  await page.locator('.evidence-timeline-row').first().waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('COUNTS-MOBILE');
  await card('分类待核查').click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('#payment-review-list .text-button').length === 1 &&
      !document.querySelector('#payment-review-list .text-button').disabled,
  );
  await nav('查看核查详情').click();
  assert.equal(await card('分类待核查').getAttribute('aria-pressed'), 'true');
  // A manual overview refresh reads new facts and does not pretend the old list is synchronized.
  await start('unknown-result');
  await nav('刷新概览').click();
  await page.waitForFunction(
    () => document.querySelector('.review-overview-card strong')?.textContent === '27 条',
  );
  assert.equal(
    await page.getByRole('combobox', { name: '核查筛选', exact: true }).inputValue(),
    'REVIEW',
  );
  await page.route('**/api/v1/admin/payment-review-lab/summary?*', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: '合成概览读取中断' } }),
    }),
  );
  await nav('刷新概览').click();
  await overview.getByRole('alert').waitFor();
  assert.equal(await overview.locator('.review-overview-card').count(), 0);
  assert.equal(await overview.locator('time').count(), 0);
  await shot('ERROR-MOBILE');
  await page.unrouteAll({ behavior: 'wait' });
  await nav('重试核查概览').click();
  await card('全部待核查').waitFor();
  await page.getByRole('combobox', { name: '验证仓库', exact: true }).selectOption(second.id);
  await overview.getByText('当前仓库暂无待核查合成尝试。', { exact: true }).waitFor();
  assert.equal(await card('全部待核查').locator('strong').innerText(), '0 条');
  await shot('EMPTY-MOBILE');
  // A delayed response from the old warehouse cannot populate the new scope.
  let enteredOld, releaseOld;
  const oldReached = new Promise((r) => (enteredOld = r)),
    oldGate = new Promise((r) => (releaseOld = r));
  await page.route('**/api/v1/admin/payment-review-lab/summary?*', async (route) => {
    if (route.request().url().includes(f.warehouseId)) {
      enteredOld();
      await oldGate;
    }
    return route.continue();
  });
  pendingReleases.push(releaseOld);
  await page.getByRole('combobox', { name: '验证仓库', exact: true }).selectOption(f.warehouseId);
  await oldReached;
  await page.getByRole('combobox', { name: '验证仓库', exact: true }).selectOption(second.id);
  await overview.getByText('当前仓库暂无待核查合成尝试。', { exact: true }).waitFor();
  const response = page.waitForResponse((r) =>
    r.url().includes('/summary?warehouseId=' + f.warehouseId),
  );
  releaseOld();
  await response;
  assert.equal(await card('全部待核查').locator('strong').innerText(), '0 条');
  await page.unrouteAll({ behavior: 'wait' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await shot('EMPTY-DESKTOP');
  assert.equal(await f.runtime.db.consumerOrder.count(), 0);
  assert.equal(await f.runtime.db.paymentPreparation.count(), 0);
  console.log(
    'Review summary UI/API passed: real scoped full counts beyond 20 rows, overlapping reasons, all five card filters, selected states, pagination, draft restoration, known exhausted detail, refresh/new facts, loading/error clears stale counts/retry, empty desktop/mobile, delayed old warehouse ignored, no horizontal overflow; screenshots: ' +
      shots.length,
  );
} finally {
  for (const release of pendingReleases) release();
  if (browser)
    for (const context of browser.contexts())
      for (const page of context.pages()) await page.unrouteAll({ behavior: 'wait' });
  if (browser) await browser.close();
  if (server) await server.close();
  await f.cleanup();
}
