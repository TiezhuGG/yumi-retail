/* global document, innerWidth, window */
// Actual React pages + real API + disposable PG schema. Browser mini adapter is not native WeChat.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expressShippingFixture } from '../../tests/helpers/express-shipping-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd().replaceAll('\\', '/'),
  dir = resolve('.local/express-readiness-ui');
const { createServer, build } =
  await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const f = await expressShippingFixture();
let server, browser;
const shots = [],
  releases = [];

try {
  await mkdir(dir + '/public', { recursive: true });
  await writeFile(
    dir + '/public/admin.css',
    await readFile('packages/web-ui/src/styles.css', 'utf8'),
  );
  await writeFile(
    dir + '/index.html',
    '<html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  );
  await writeFile(
    dir + '/main.tsx',
    `import React from 'react';import{createRoot}from'react-dom/client';import{StaffSessionPanel,Workspace}from'${root}/packages/web-ui/src/index';const style=document.createElement('link');style.rel='stylesheet';style.href='/admin.css';await new Promise((done,fail)=>{style.onload=done;style.onerror=fail;document.head.appendChild(style)});createRoot(document.getElementById('root')).render(<React.StrictMode><><div style={{padding:8,background:'#fff3cd',fontSize:12}}>隔离验收 · 合成数据 · 售后待办检查 · 非生产操作</div><StaffSessionPanel workspace>{(p,c)=><Workspace profile={p} sessionControl={c}/>}</StaffSessionPanel></></React.StrictMode>);`,
  );
  const config = {
    configFile: false,
    root: dir,
    plugins: [react()],
    resolve: {
      alias: {
        react: resolve('apps/admin-web/node_modules/react'),
        'react-dom': resolve('apps/admin-web/node_modules/react-dom'),
      },
    },
    define: {
      API_BASE_URL: JSON.stringify('http://127.0.0.1:3000/api/v1'),
      CONSUMER_DEV_LOGIN: 'false',
    },
  };
  await build(config);
  server = await createServer({
    configFile: false,
    root: dir + '/dist',
    optimizeDeps: { noDiscovery: true },
    server: { host: '127.0.0.1', port: 5188, strictPort: true, proxy: { '/api': f.base } },
  });
  await server.listen();
  browser = await chromium.launch({
    executablePath: process.env.YUMI_CHROME_PATH || '/usr/bin/google-chrome',
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([
    { name: 'yumi_staff_session', value: f.cookie.split('=')[1], domain: '127.0.0.1', path: '/' },
  ]);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  async function shot(name, p = page) {
    const path = `docs/verification/UI-RETURN-QUEUE-${name}-2026-11-05.png`;
    if (!name.startsWith('MINI-') && !name.endsWith('MOBILE'))
      await p.evaluate(() => {
        window.scrollTo(0, 0);
      });
    await p.evaluate(
      () =>
        new Promise((done) =>
          window.requestAnimationFrame(() => window.requestAnimationFrame(done)),
        ),
    );
    await p.screenshot({ path, fullPage: !name.startsWith('MINI-') && !name.endsWith('MOBILE') });
    shots.push(path);
    assert.ok(
      await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'overflow: ' + name,
    );
  }

  let releaseRead;
  const gate = new Promise((done) => {
    releaseRead = done;
  });
  releases.push(() => releaseRead());
  let failed = true;
  await page.route('**/admin/redemption-express-readiness', async (route) => {
    await gate;
    if (failed)
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'UI_TEST', message: '合成首发检查读取失败' } }),
      });
    else await route.continue();
  });
  await page.goto('http://127.0.0.1:5188');
  await page.getByRole('button', { name: '积分快递首发检查', exact: true }).click();
  await page.getByText('正在核对首发条件…', { exact: true }).waitFor();
  await shot('LOADING');
  releaseRead();
  await page.getByText('合成首发检查读取失败', { exact: true }).waitFor();
  await shot('READ-ERROR');
  failed = false;
  await page.getByRole('button', { name: '刷新首发检查', exact: true }).click();
  await page.getByRole('heading', { name: '正式微信身份', exact: true }).waitFor();
  await page.getByText('当前没有待快递发货订单', { exact: true }).waitFor();
  await shot('EMPTY');
  const id = await f.createExpress();
  await page.getByRole('button', { name: '刷新首发检查', exact: true }).click();
  await page.getByText(/最早待发订单创建于/).waitFor();
  await shot('WAITING');
  assert.equal(
    (
      await f.api('/admin/redemptions/' + id + '/ship', {
        version: 0,
        carrierCode: 'SF',
        trackingNo: 'SF-E4C-UI-001',
        dispatchConfirmed: true,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.call('/consumer/redemptions/' + id + '/after-sales', {
        category: 'OTHER',
        message: '合成检查待办',
      })
    ).status,
    200,
  );
  await page.getByRole('button', { name: '刷新首发检查', exact: true }).click();
  await page.getByText('当前没有待快递发货订单', { exact: true }).waitFor();
  assert.equal(await page.getByText('SF-E4C-UI-001', { exact: true }).count(), 0);
  assert.equal(await page.getByText('合成检查待办', { exact: true }).count(), 0);
  await shot('METRICS');
  const applied = await f.call('/consumer/redemptions/' + id + '/returns', {
    quantity: 1,
    reason: '合成售后待办，请核对原积分',
  });
  assert.equal(applied.status, 200);
  const returnId = applied.data.id;
  const queue = page.getByRole('region', { name: '售后待办', exact: true });
  const refresh = async () => {
    await page.getByRole('button', { name: '刷新首发检查', exact: true }).click();
    await page.getByRole('heading', { name: '正式微信身份', exact: true }).waitFor();
  };
  const inspectQueue = async (status, name) => {
    await queue.getByRole('button', { name: '查看' + name, exact: true }).click();
    await page.getByRole('combobox', { name: '售后处理状态', exact: true }).waitFor();
    assert.equal(await page.getByRole('combobox', { name: '售后处理状态' }).inputValue(), status);
    await page.getByRole('button', { name: '查看售后申请', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '查看售后申请', exact: true }).count(), 1);
    await shot('FILTER-' + status);
    await page.getByRole('button', { name: '积分快递首发检查', exact: true }).click();
    await page.getByRole('heading', { name: '正式微信身份', exact: true }).waitFor();
  };
  await refresh();
  assert.equal(
    await queue
      .locator('strong')
      .allTextContents()
      .then((x) => x.join(',')),
    '1,0,0',
  );
  await shot('REQUESTED');
  await inspectQueue('REQUESTED', '待审核');
  assert.equal(
    (
      await f.api('/admin/redemption-returns/' + returnId + '/approve', {
        requiresReturn: true,
        reason: '合成退回审核',
      })
    ).status,
    200,
  );
  await refresh();
  assert.equal(
    await queue
      .locator('strong')
      .allTextContents()
      .then((x) => x.join(',')),
    '0,1,0',
  );
  await inspectQueue('WAIT_RETURN', '待验收');
  assert.equal(
    (
      await f.api('/admin/redemption-returns/' + returnId + '/receive', {
        quantity: 1,
        condition: 'DAMAGED',
        location: '合成隔离区',
        physicalConfirmed: true,
        reason: '完整隔离验收',
      })
    ).status,
    200,
  );
  await refresh();
  assert.equal(
    await queue
      .locator('strong')
      .allTextContents()
      .then((x) => x.join(',')),
    '0,0,1',
  );
  await inspectQueue('READY_TO_REFUND', '待退积分');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.express-readiness-metrics').first().scrollIntoViewIfNeeded();
  await shot('METRICS-MOBILE');
  await queue.scrollIntoViewIfNeeded();
  await shot('RETURNS-MOBILE');
  await page.getByRole('heading', { name: '正式微信身份', exact: true }).scrollIntoViewIfNeeded();
  await shot('BLOCKERS-MOBILE');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const scope = (await f.runtime.db.$queryRaw`SELECT current_schema() AS schema`)[0].schema;
  assert.match(scope, /^address_ui_[a-f0-9]+$/);
  // Only disposable synthetic facts are changed to verify the visible discrepancy state.
  await f.runtime.db.$executeRawUnsafe(
    'ALTER TABLE redemption_return_events DISABLE TRIGGER redemption_return_event_immutable',
  );
  await f.runtime.db
    .$executeRaw`UPDATE redemption_return_events SET quantity=2 WHERE return_id=${returnId}::uuid AND kind='RECEIVE'`;
  await refresh();
  const invariantCard = page
    .getByRole('heading', { name: '快递事实核对', exact: true })
    .locator('..');
  await invariantCard
    .getByText('发现事实差异；先暂停相关操作并核对原始记录，禁止自动填平。', { exact: true })
    .waitFor();
  await shot('RETURN-DIFFERENCE');
  await f.runtime.db
    .$executeRaw`UPDATE redemption_return_events SET quantity=1 WHERE return_id=${returnId}::uuid AND kind='RECEIVE'`;
  await f.runtime.db.$executeRawUnsafe(
    'ALTER TABLE redemption_return_events ENABLE TRIGGER redemption_return_event_immutable',
  );
  await f.runtime.db.redemptionExpressPolicy.update({
    where: { warehouseId: f.warehouseId },
    data: { enabled: false },
  });
  await page.getByRole('button', { name: '刷新首发检查', exact: true }).click();
  await page.getByText('寄送规则缺失或暂停；不会默认全国发货。', { exact: true }).waitFor();
  await shot('POLICY-PAUSED');
  const actor = await f.runtime.db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } });
  await f.runtime.db.staffWarehouse.deleteMany({ where: { staffId: actor.id } });
  await page.getByRole('button', { name: '刷新首发检查', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.locator('.express-readiness-metrics').count(), 0);
  await shot('ACCESS-REMOVED');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, screenshots: shots, canLaunch: false }));
} finally {
  for (const release of releases) release();
  await browser?.close();
  await server?.close();
  await f.cleanup();
}
