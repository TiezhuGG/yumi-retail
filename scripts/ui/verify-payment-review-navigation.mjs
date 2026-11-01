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
  dir = resolve('.local/review-navigation-ui');
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
    const path = 'docs/verification/UI-REVIEW-NAVIGATION-' + name + '-2026-11-01.png';
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

  const adminProfile = (await f.staff('/staff/me', f.extraCookies[0])).data;
  const secondWarehouse = await f.runtime.db.warehouse.create({
    data: { id: randomUUID(), code: 'NAV-SECOND', name: '跨页验证第二仓' },
  });
  await f.runtime.db.staffWarehouse.create({
    data: { staffId: adminProfile.id, warehouseId: secondWarehouse.id },
  });
  const a = await post('/admin/payment-attempt-lab', { key: randomUUID() });
  const id = a.attempt.id;
  await post('/admin/payment-attempt-lab/' + id + '/actions/unknown-result', { key: randomUUID() });
  const b = await post('/admin/payment-attempt-lab', { key: randomUUID() });
  const otherId = b.attempt.id;
  const linkedNotification = await post('/admin/payment-notification-records', {
    key: randomUUID(),
    attemptId: otherId,
  });
  // A known-success record is intentionally absent from the exception list.
  await page.goto('http://127.0.0.1:5188/');
  const nav = (name) => page.getByRole('button', { name, exact: true });
  const review = page.locator('[data-payment-view="payment-review-lab"]:not([hidden])');
  const notes = () => review.getByRole('textbox', { name: '合成核查备注', exact: true });
  const source = page.locator('[data-payment-view="notification-records"]:not([hidden])');
  const attempts = page.locator('[data-payment-view="payment-attempt-lab"]:not([hidden])');
  await nav('补偿核查').click();
  await review.getByRole('combobox', { name: '验证仓库', exact: true }).selectOption(f.warehouseId);
  await nav('查看核查详情').click();
  await notes().fill('尝试 A 的未保存核查草稿');
  await nav('通知记录').click();
  await source.getByRole('combobox', { name: '验证仓库', exact: true }).selectOption(f.warehouseId);
  await source.getByRole('button', { name: '查看记录', exact: true }).first().click();
  const selection = await source.locator('dl').innerText();
  const binding = await source.getByRole('combobox', { name: '关联合成尝试' }).inputValue();
  await nav('查看关联核查时间线').click();
  await review.locator('.evidence-timeline-row.is-focused').waitFor();
  assert.ok(
    (
      await review.locator('.evidence-timeline-row.is-focused').getAttribute('data-evidence-ref')
    ).startsWith('NOTIFICATION:'),
  );
  assert.equal(
    await review.locator('.evidence-timeline-row.is-focused').getAttribute('data-evidence-ref'),
    'NOTIFICATION:' + linkedNotification.record.id,
  );
  assert.equal(await notes().inputValue(), '');
  await shot('NOTIFICATION-DESKTOP');
  await nav('返回通知记录').click();
  await source.waitFor();
  await page.waitForFunction(() =>
    document.activeElement?.textContent?.includes('查看关联核查时间线'),
  );
  assert.equal(await source.locator('dl').innerText(), selection);
  assert.equal(await source.getByRole('combobox', { name: '关联合成尝试' }).inputValue(), binding);
  await nav('支付尝试').click();
  await attempts
    .getByRole('combobox', { name: '验证仓库', exact: true })
    .selectOption(f.warehouseId);
  await attempts.getByRole('button', { name: '查看尝试', exact: true }).last().click();
  await nav('查看本次尝试核查时间线').click();
  await review.locator('.evidence-timeline-row.is-focused').waitFor();
  assert.ok(
    (
      await review.locator('.evidence-timeline-row.is-focused').getAttribute('data-evidence-ref')
    ).startsWith('ATTEMPT:'),
  );
  const attemptDetail = (
    await f.staff(
      '/admin/payment-attempt-lab/' + id + '?warehouseId=' + f.warehouseId,
      f.extraCookies[0],
    )
  ).data;
  assert.equal(
    await review.locator('.evidence-timeline-row.is-focused').getAttribute('data-evidence-ref'),
    'ATTEMPT:' + attemptDetail.events.at(-1).id,
  );
  assert.equal(await notes().inputValue(), '尝试 A 的未保存核查草稿');
  await nav('返回支付尝试').click();
  await page.waitForFunction(() =>
    document.activeElement?.textContent?.includes('查看本次尝试核查时间线'),
  );
  await nav('补偿核查').click();
  assert.equal(await notes().inputValue(), '尝试 A 的未保存核查草稿');
  await review.getByRole('combobox', { name: '核查筛选' }).selectOption('UNKNOWN');
  await nav('查看核查详情').click();
  assert.equal(await notes().inputValue(), '尝试 A 的未保存核查草稿');
  // Lost POST response must retain the same pending key across linked navigation.
  let lost = true;
  const keys = [];
  await page.route('**/api/v1/admin/payment-review-lab/*/notes?*', async (route) => {
    keys.push(route.request().postDataJSON().key);
    if (lost) {
      lost = false;
      await route.fetch();
      return route.abort('failed');
    }
    return route.continue();
  });
  await nav('保存核查备注').click();
  await review.getByRole('alert').waitFor();
  await nav('通知记录').click();
  await nav('查看关联核查时间线').click();
  await review.locator('.evidence-timeline-row.is-focused').waitFor();
  await nav('返回通知记录').click();
  await nav('支付尝试').click();
  await nav('查看本次尝试核查时间线').click();
  await review.locator('.evidence-timeline-row.is-focused').waitFor();
  assert.equal(await notes().inputValue(), '尝试 A 的未保存核查草稿');
  await nav('保存核查备注').click();
  await review.getByRole('status').filter({ hasText: '已保存' }).waitFor();
  assert.equal(keys.length, 2);
  assert.equal(keys[0], keys[1]);
  assert.equal(await f.runtime.db.paymentReviewLabNote.count(), 1);
  await page.unroute('**/api/v1/admin/payment-review-lab/*/notes?*');
  // Read failure must clear the old detail, keep a retry and return path.
  await nav('返回支付尝试').click();
  await page.route('**/api/v1/admin/payment-review-lab/*?*', async (route) => {
    if (new URL(route.request().url()).pathname.endsWith('/' + id))
      return route.fulfill({
        status: 404,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '关联记录当前不可用' } }),
      });
    return route.continue();
  });
  await nav('查看本次尝试核查时间线').click();
  await review.getByRole('alert').filter({ hasText: '关联记录当前不可用' }).waitFor();
  assert.equal(await review.locator('.payment-review-detail').count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('ERROR-MOBILE');
  await page.unroute('**/api/v1/admin/payment-review-lab/*?*');
  await nav('重试打开关联核查').click();
  await review.locator('.evidence-timeline-row.is-focused').waitFor();
  await shot('ATTEMPT-MOBILE');
  // A response arriving after return cannot move focus back into the hidden page.
  await nav('返回支付尝试').click();
  let release, entered;
  const reached = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (release = r));
  await page.route('**/api/v1/admin/payment-review-lab/*/timeline?*', async (route) => {
    entered();
    await gate;
    return route.continue();
  });
  await nav('查看本次尝试核查时间线').click();
  await reached;
  await review.getByText('正在读取证据时间线…', { exact: true }).waitFor();
  await shot('LOADING-MOBILE');
  await nav('返回支付尝试').click();
  await page.waitForFunction(() =>
    document.activeElement?.textContent?.includes('查看本次尝试核查时间线'),
  );
  const response = page.waitForResponse((r) => r.url().includes('/timeline?'));
  release();
  await response;
  await page.waitForFunction(() =>
    document.querySelector(
      '[data-payment-view="payment-review-lab"] .evidence-timeline-row.is-focused',
    ),
  );
  assert.ok(
    await page.evaluate(() =>
      document.activeElement?.textContent?.includes('查看本次尝试核查时间线'),
    ),
  );
  await page.unroute('**/api/v1/admin/payment-review-lab/*/timeline?*');
  await shot('RETURN-MOBILE');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await nav('工作台').click();
  await nav('补偿核查').click();
  await review.locator('.evidence-timeline-row.is-focused').waitFor();
  await shot('RETAINED-DESKTOP');

  await notes().fill('仓库切换前的草稿');
  await review
    .getByRole('combobox', { name: '验证仓库', exact: true })
    .selectOption(secondWarehouse.id);
  await review.getByText('当前筛选下暂无待核查记录', { exact: true }).waitFor();
  await nav('支付尝试').click();
  await nav('查看本次尝试核查时间线').click();
  await review.locator('.evidence-timeline-row.is-focused').waitFor();
  assert.equal(
    await review.getByRole('combobox', { name: '验证仓库', exact: true }).inputValue(),
    f.warehouseId,
  );
  assert.equal(await notes().inputValue(), '仓库切换前的草稿');
  await nav('返回支付尝试').click();
  await f.runtime.db.staffWarehouse.delete({
    where: { staffId_warehouseId: { staffId: adminProfile.id, warehouseId: f.warehouseId } },
  });
  await nav('查看本次尝试核查时间线').click();
  await review.getByRole('alert').waitFor();
  assert.equal(await review.locator('.payment-review-detail').count(), 0);
  await shot('REVOKED-DESKTOP');
  await f.runtime.db.staffWarehouse.create({
    data: { staffId: adminProfile.id, warehouseId: f.warehouseId },
  });
  await nav('重试打开关联核查').click();
  await review.locator('.evidence-timeline-row.is-focused').waitFor();
  for (let i = 0; i < 22; i++)
    await post('/admin/payment-notification-records', { key: randomUUID(), attemptId: otherId });
  await nav('通知记录').click();
  await nav('刷新记录').click();
  await nav('加载更多记录').click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-payment-view="notification-records"] .readiness-check')
        .length === 23,
  );
  await source.getByRole('button', { name: '查看记录', exact: true }).last().click();
  await nav('查看关联核查时间线').click();
  await review.locator('.evidence-timeline-row.is-focused').waitFor();
  await nav('返回通知记录').click();
  assert.equal(await source.getByRole('button', { name: '查看记录', exact: true }).count(), 23);
  assert.equal(await source.getByRole('button', { name: '加载更多记录', exact: true }).count(), 0);
  // Logout unmounts all retained pages and drafts. A lower-role login never sees them.
  await nav('退出登录').click();
  await page.getByRole('heading', { name: '登录工作空间', exact: true }).waitFor();
  assert.equal(await page.locator('[data-payment-view]').count(), 0);
  const login = await fetch(f.base + '/api/v1/staff/auth/session', {
    method: 'POST',
    headers: { Origin: 'http://127.0.0.1:5188', 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginName: 'quote-ui-0', password: f.password }),
  });
  assert.equal(login.status, 200);
  await context.addCookies([
    {
      name: 'yumi_staff_session',
      value: login.headers.get('set-cookie').split(';')[0].split('=')[1],
      domain: '127.0.0.1',
      path: '/',
    },
  ]);
  await page.reload();
  await nav('订单查询').waitFor();
  assert.equal(await nav('补偿核查').count(), 0);
  assert.equal(await page.locator('[data-payment-view]').count(), 0);
  assert.equal(await f.runtime.db.consumerOrder.count(), 0);
  assert.equal(await f.runtime.db.paymentPreparation.count(), 0);
  console.log(
    'Review navigation UI/API passed: linked notification and attempt exact focus, resolved record outside list, return selection/focus, per-attempt draft including filter switch, lost-response key recovery with one note, failed detail/retry without stale detail, late hidden response, retained sidebar state, authorized warehouse switch/drafts, revoked scope refused by real API, logout/lower-role reset, desktop/mobile no overflow; screenshots: ' +
      shots.length,
  );
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  await f.cleanup();
}
