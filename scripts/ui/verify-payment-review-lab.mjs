/* global document, innerWidth, window */
// Actual operations UI + disposable PostgreSQL API. Never seeds the operational database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { claimPaymentQueryLab, finishPaymentQueryLab } from '../../packages/database/dist/index.js';
import { orderAdminFixture } from '../../tests/helpers/order-admin-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd(),
  dir = resolve('.local/payment-review-ui');
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
    const path = 'docs/verification/UI-PAYMENT-REVIEW-' + name + '-2026-11-01.png';
    await page.screenshot({ path, fullPage: true });
    shots.push(path);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'horizontal overflow: ' + name,
    );
  }
  await page.goto('http://127.0.0.1:5188/');
  await page.getByRole('button', { name: '补偿核查', exact: true }).click();
  await page.getByText('当前筛选下暂无待核查记录', { exact: true }).waitFor();
  await shot('EMPTY-DESKTOP');
  const csrf = (await f.staff('/staff/me', f.extraCookies[0])).data.csrfToken,
    headers = {
      Cookie: f.extraCookies[0],
      Origin: 'http://127.0.0.1:5188',
      'X-CSRF-Token': csrf,
      'Content-Type': 'application/json',
    };
  async function seed(actions) {
    let r = await fetch(f.base + '/api/v1/admin/payment-attempt-lab?warehouseId=' + f.warehouseId, {
      method: 'POST',
      headers,
      body: JSON.stringify({ key: randomUUID() }),
    });
    assert.equal(r.status, 200);
    const id = (await r.json()).data.attempt.id;
    for (const action of actions) {
      r = await fetch(
        f.base +
          '/api/v1/admin/payment-attempt-lab/' +
          id +
          '/actions/' +
          action +
          '?warehouseId=' +
          f.warehouseId,
        { method: 'POST', headers, body: JSON.stringify({ key: randomUUID() }) },
      );
      assert.equal(r.status, 200);
    }
    return id;
  }
  const exhausted = await seed(['unknown-result']);
  for (let i = 0; i < 3; i++) {
    assert.ok(await claimPaymentQueryLab(f.runtime.db, f.warehouseId, 1));
    await new Promise((r) => setTimeout(r, 1100));
  }
  await claimPaymentQueryLab(f.runtime.db, f.warehouseId);
  const unknown = await seed(['unknown-result']),
    conflict = await seed(['success-result', 'closed-result']);
  await page.getByRole('button', { name: '刷新待核查列表', exact: true }).click();
  await page.getByRole('button', { name: '查看核查详情', exact: true }).first().waitFor();
  assert.equal(await page.getByRole('button', { name: '查看核查详情', exact: true }).count(), 3);
  await shot('LIST-DESKTOP');
  async function openUnknown() {
    await page
      .locator('.readiness-check')
      .filter({ hasText: unknown.slice(-8) })
      .getByRole('button', { name: '查看核查详情', exact: true })
      .click();
    await page.getByRole('heading', { name: '合成核查详情', exact: true }).waitFor();
  }
  const idle = () =>
    page.waitForFunction(() => {
      const b = document.querySelector('.payment-review-detail button');
      return b && !b.disabled;
    });
  await openUnknown();
  await idle();
  let lose = true,
    gate,
    release;
  await page.route('**/api/v1/admin/payment-review-lab/*/notes?*', async (route) => {
    if (gate) await gate;
    if (lose) {
      lose = false;
      await route.fetch();
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '合成备注已写入，响应丢失' } }),
      });
    }
    return route.continue();
  });
  const text = '合成核查：<script>window.__reviewInjected=true</script>，继续保留未知。';
  await page.getByRole('textbox', { name: '合成核查备注', exact: true }).fill(text);
  gate = new Promise((r) => (release = r));
  await page.getByRole('button', { name: '保存核查备注', exact: true }).click();
  await page.getByRole('button', { name: '正在处理…', exact: true }).waitFor();
  await shot('RUNNING');
  release();
  gate = undefined;
  await page.getByRole('alert').filter({ hasText: '响应丢失' }).waitFor();
  assert.equal(await f.runtime.db.paymentReviewLabNote.count(), 1);
  await shot('ERROR-DESKTOP');
  await page.getByRole('button', { name: '保存核查备注', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '原备注已保存' }).waitFor();
  await idle();
  assert.equal(await f.runtime.db.paymentReviewLabNote.count(), 1);
  assert.equal(await page.locator('.payment-review-detail script').count(), 0);
  await page.getByText(text, { exact: true }).waitFor();
  await shot('NOTE-DESKTOP');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('NOTE-MOBILE');
  const second = '合成核查：任务版本变化后重新读取当前证据。';
  await page.getByRole('textbox', { name: '合成核查备注', exact: true }).fill(second);
  const lease = await claimPaymentQueryLab(f.runtime.db, f.warehouseId);
  assert.ok(lease);
  assert.equal(lease.attemptId, unknown);
  await page.getByRole('button', { name: '保存核查备注', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '证据或任务已变化' }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '保存核查备注', exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await page.getByRole('textbox', { name: '合成核查备注', exact: true }).inputValue(),
    second,
  );
  await shot('STALE-MOBILE');
  await finishPaymentQueryLab(f.runtime.db, lease);
  await page.getByRole('button', { name: '刷新核查详情', exact: true }).click();
  await idle();
  await page.getByRole('button', { name: '保存核查备注', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '核查备注已保存' }).waitFor();
  await idle();
  assert.equal(await f.runtime.db.paymentReviewLabNote.count(), 2);
  await page.getByRole('combobox', { name: '核查筛选', exact: true }).selectOption('CONFLICT');
  await page.getByRole('button', { name: '查看核查详情', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '查看核查详情', exact: true }).count(), 1);
  await page.getByText('合成尝试 · ' + conflict.slice(-8), { exact: true }).waitFor();
  await shot('CONFLICT-FILTER-MOBILE');
  await page.getByRole('combobox', { name: '核查筛选', exact: true }).selectOption('EXHAUSTED');
  await page.getByRole('button', { name: '查看核查详情', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '查看核查详情', exact: true }).count(), 1);
  await page.getByText('合成尝试 · ' + exhausted.slice(-8), { exact: true }).waitFor();
  await shot('EXHAUSTED-FILTER-MOBILE');
  await page.getByRole('combobox', { name: '核查筛选', exact: true }).selectOption('ALL');
  await page.getByRole('button', { name: '查看核查详情', exact: true }).first().waitFor();
  await openUnknown();
  await idle();
  await page.route('**/api/v1/admin/payment-review-lab?*', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.data.enabled = false;
    return route.fulfill({ response, json: body });
  });
  await page.getByRole('button', { name: '刷新待核查列表', exact: true }).click();
  await page
    .getByText('本机合成核查写入尚未开启，可只读查看；不能保存备注。', { exact: true })
    .waitFor();
  assert.equal(
    await page.getByRole('textbox', { name: '合成核查备注', exact: true }).isDisabled(),
    true,
  );
  await shot('DISABLED-MOBILE');
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
  assert.equal(await op.getByRole('button', { name: '补偿核查', exact: true }).count(), 0);
  await other.close();
  assert.equal(await f.runtime.db.consumerOrder.count(), 0);
  assert.equal(await f.runtime.db.paymentPreparation.count(), 0);
  assert.equal(
    (await f.runtime.db.paymentAttemptLab.findUniqueOrThrow({ where: { id: unknown } })).evidence,
    'UNKNOWN',
  );
  console.log(
    'Actual review UI/API passed: empty/filter/details, note save lost response + original retry once, plain text escaping, stale snapshot refusal with draft retained + refresh recovery, desktop/mobile, disabled and role navigation. Two immutable notes; zero orders/preparations. Screenshots: ' +
      shots.length,
  );
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  await f.cleanup();
}
