/* global document, innerWidth */
// Actual operations UI + disposable PostgreSQL API. Never seeds the operational database.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expressShippingFixture } from '../../tests/helpers/express-shipping-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd(),
  dir = resolve('.local/mall-tasks-ui');
const { createServer } = await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const f = await expressShippingFixture();
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
    const path = 'docs/verification/UI-MALL-TASKS-' + name + '-2026-11-06.png';
    await page.screenshot({ path, fullPage: true });
    shots.push(path);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'horizontal overflow: ' + name,
    );
  }

  // All data is synthetic, inside the fixture's disposable PostgreSQL schema.
  const shipped = await f.createExpress(2),
    second = await f.createExpress(1);
  for (const [i, id] of [shipped, second].entries())
    assert.equal(
      (
        await f.api('/admin/redemptions/' + id + '/ship', {
          version: 0,
          carrierCode: 'SF',
          trackingNo: 'SF-UI-TASKS-' + i,
          dispatchConfirmed: true,
        })
      ).status,
      200,
    );
  await f.createExpress(1);
  const claim = async (orderId) => {
    const r = await f.call('/consumer/redemptions/' + orderId + '/returns', {
      quantity: 1,
      reason: '合成待办退货',
    });
    assert.equal(r.status, 200);
    return r.data.id;
  };
  await claim(shipped);
  const waiting = await claim(shipped),
    ready = await claim(second);
  assert.equal(
    (
      await f.api('/admin/redemption-returns/' + waiting + '/approve', {
        requiresReturn: true,
        reason: '合成等待寄回',
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.api('/admin/redemption-returns/' + ready + '/approve', {
        requiresReturn: false,
        reason: '合成无需寄回',
      })
    ).status,
    200,
  );
  for (const id of [shipped, second])
    assert.equal(
      (
        await f.call('/consumer/redemptions/' + id + '/after-sales', {
          category: 'DAMAGED',
          message: '合成待办反馈',
        })
      ).status,
      200,
    );
  assert.equal(
    (
      await f.api('/admin/redemption-after-sales/' + second + '/reply', {
        version: 0,
        message: '合成处理中',
      })
    ).status,
    200,
  );
  const db = f.runtime.db;
  for (let i = 0; i < 22; i++) {
    const sku = await db.sku.create({
      data: {
        id: crypto.randomUUID(),
        productId: f.catalog.productId,
        code: 'TASK-UI-' + i,
        spec: '合成规格' + i,
        unit: '件',
        priceCents: 100n,
        expiryManaged: false,
      },
    });
    await db.rewardProduct.create({
      data: {
        id: crypto.randomUUID(),
        warehouseId: f.warehouseId,
        skuId: sku.id,
        title: '合成缺货商品' + i,
        pointsPrice: 10n,
        status: 'PUBLISHED',
        perUserLimit: 1,
        totalQuota: 1,
      },
    });
  }
  const grant = await f.api('/admin/points/grants/store/create', {
    userId: f.identity.user.id,
    amount: '10',
    reason: '合成待办发放',
    reference: 'TASK-UI',
  });
  assert.equal(grant.status, 200);

  assert.equal(
    (
      await f.api('/admin/points/grants/store/policy', {
        version: 0,
        enabled: true,
        singleLimit: '100',
        dailyLimit: '1000',
        reason: '合成预算',
      })
    ).status,
    200,
  );
  const source = await f.api('/admin/points/grants/store/create', {
    userId: f.identity.user.id,
    amount: '10',
    reason: '合成冲正来源',
    reference: 'UI-SOURCE',
  });
  const reviewer = await f.reviewer(),
    { data: reviewProfile } = await (
      await fetch(f.base + '/api/v1/staff/me', { headers: { Cookie: reviewer } })
    ).json();
  assert.equal(
    (
      await f.api(
        '/admin/points/grants/' + source.data.id + '/approve',
        { version: 0, reason: '合成独立审批' },
        crypto.randomUUID(),
        reviewer,
        reviewProfile.csrfToken,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await f.api('/admin/points/corrections/store/create', {
        grantId: source.data.id,
        amount: '2',
        reason: '合成待办冲正',
        reference: 'UI-CORRECTION',
      })
    ).status,
    200,
  );
  await page.goto('http://127.0.0.1:5188/');
  const open = async () => {
    await page.getByRole('button', { name: '商城待办', exact: true }).click();
    await page.getByRole('heading', { name: '库存提醒', exact: true }).waitFor();
    await page.locator('.mall-stock-summary').waitFor();
  };
  await open();
  assert.equal(await page.locator('.mall-task-queues article').count(), 8);
  assert.equal(await page.locator('.mall-task-stock tbody tr').count(), 20);
  await shot('DESKTOP');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('MOBILE');
  assert.ok(
    await page
      .locator('.mall-task-stock tbody tr')
      .first()
      .getByRole('button', { name: '检查商品', exact: true })
      .evaluate((el) => {
        const b = el.getBoundingClientRect();
        return b.left >= 0 && b.right <= innerWidth;
      }),
    'mobile stock action must be directly visible',
  );
  await page.getByRole('button', { name: '加载更多库存提醒', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.mall-task-stock tbody tr').length === 23,
  );
  await shot('PAGINATION-MOBILE');
  await page.getByLabel('库存范围', { exact: true }).selectOption('LOW');
  await page.getByRole('button', { name: '查看库存', exact: true }).click();
  await page.waitForFunction(
    () => document.querySelectorAll('.mall-task-stock tbody tr').length === 1,
  );
  await page.getByRole('button', { name: '检查商品', exact: true }).click();
  await page.getByRole('heading', { name: '商品已上架', exact: true }).waitFor();
  await page.getByRole('heading', { name: '日常柔软纸巾', exact: true }).waitFor();
  await shot('PRODUCT-DESTINATION');
  await open();
  await page.getByRole('button', { name: '查看积分发放待审批', exact: true }).click();
  await page.getByText('当前仅查看待审批申请', { exact: true }).waitFor();
  await page.getByRole('cell', { name: '合成待办发放', exact: true }).waitFor();
  await shot('GRANT-DESTINATION');
  await page.getByRole('button', { name: '积分发放审批', exact: true }).click();
  await page.getByText('当前仅查看待审批申请', { exact: true }).waitFor();
  assert.equal(
    (
      await f.api('/admin/points/grants/' + grant.data.id + '/cancel', {
        version: 0,
        reason: '合成处理后刷新',
      })
    ).status,
    200,
  );
  await open();
  assert.equal(
    await page.getByRole('button', { name: '查看积分发放待审批', exact: true }).count(),
    0,
  );
  await page.getByLabel('低库存查看阈值（件）', { exact: true }).fill('0');
  await page.getByLabel('库存范围', { exact: true }).selectOption('LOW');
  await page.getByRole('button', { name: '查看库存', exact: true }).click();
  await page.getByText('当前范围没有缺货或低库存商品', { exact: true }).waitFor();
  await shot('EMPTY-MOBILE');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await shot('EMPTY-DESKTOP');

  // Each queue opens an actual filtered API, not a decorative card.
  for (const [label, path, query] of [
    ['待快递发货', '/api/v1/admin/redemptions?', 'fulfillment=EXPRESS_WAIT_SHIP'],
    ['积分冲正待审批', '/api/v1/admin/points/corrections?', 'status=SUBMITTED'],
    ['售后反馈待处理', '/api/v1/admin/redemption-after-sales?', 'status=OPEN'],
    ['售后反馈处理中', '/api/v1/admin/redemption-after-sales?', 'status=PROCESSING'],
    ['退货退积分待审核', '/api/v1/admin/redemption-returns?', 'status=REQUESTED'],
    ['等待退回验收', '/api/v1/admin/redemption-returns?', 'status=WAIT_RETURN'],
    ['待退积分', '/api/v1/admin/redemption-returns?', 'status=READY_TO_REFUND'],
  ]) {
    await open();
    const result = page.waitForResponse((r) => r.url().includes(path) && r.url().includes(query));
    await page.getByRole('button', { name: '查看' + label, exact: true }).click();
    const response = await result;
    assert.equal(response.status(), 200);
    assert.equal((await response.json()).data.items.length, 1, label);
    await page.getByRole('heading', { level: 1 }).waitFor();
    if (label === '待退积分') await shot('RETURN-DESTINATION');
  }
  await open();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/admin/mall-tasks?**', async (route) => {
    await gate;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: '合成待办查询失败' } }),
    });
  });
  await page.getByRole('button', { name: '刷新待办', exact: true }).click();
  await page.getByText('正在读取商城待办…', { exact: true }).waitFor();
  assert.equal(await page.locator('.mall-task-queues article').count(), 0);
  await shot('LOADING');
  release();
  await page.getByRole('alert').filter({ hasText: '合成待办查询失败' }).waitFor();
  await shot('ERROR');
  assert.equal(await page.locator('.mall-stock-summary').count(), 0);
  await page.unroute('**/api/v1/admin/mall-tasks?**');
  await page.getByRole('button', { name: '重试待办', exact: true }).click();
  await page.locator('.mall-stock-summary').waitFor();
  assert.equal(await page.locator('.mall-task-queues article').count(), 8);
  console.log(
    'Actual UI + isolated PG: stock counts/filter/pagination, exact product and pending grant navigation, processed removal, empty/loading/error/retry passed. Screenshots: ' +
      shots.length,
  );
} catch (e) {
  if (page) {
    await page.screenshot({ path: '.local/mall-tasks-ui-failure.png', fullPage: true });
    await writeFile('.local/mall-tasks-ui-failure.html', await page.content());
  }
  throw e;
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  await f.cleanup();
}
