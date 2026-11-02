/* global document, innerWidth, window */
// Actual operations UI + disposable PostgreSQL API. Never seeds the operational database.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pickingFixture } from '../../tests/helpers/picking-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd().replaceAll('\\', '/'),
  dir = resolve('.local/delivery-lab-ui');
const { createServer } = await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const f = await pickingFixture({ pickingLab: true });
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
    `import React from 'react';import {createRoot} from 'react-dom/client';import {StaffSessionPanel,Workspace} from '${root}/packages/web-ui/src/index';import '${root}/packages/web-ui/src/styles.css';createRoot(document.getElementById('root')).render(<React.StrictMode><StaffSessionPanel workspace>{(p,c)=><Workspace profile={p} sessionControl={c} mobile={new URLSearchParams(location.search).has('mobile')}/>}</StaffSessionPanel></React.StrictMode>);`,
  );
  const { build } = await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
  await build({
    configFile: false,
    root: dir,
    plugins: [react()],
    resolve: {
      alias: {
        react: resolve('apps/admin-web/node_modules/react'),
        'react-dom': resolve('apps/admin-web/node_modules/react-dom'),
      },
    },
  });
  server = await createServer({
    configFile: false,
    root: dir + '/dist',
    plugins: [],
    optimizeDeps: { noDiscovery: true },
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
    executablePath: process.env.YUMI_CHROME_PATH || '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await context.addCookies([
    {
      name: 'yumi_staff_session',
      value: f.cookies[1].split('=')[1],
      domain: '127.0.0.1',
      path: '/',
    },
  ]);
  const page = await context.newPage();
  const shots = [];
  async function shot(name) {
    await page.evaluate(() => window.scrollTo(0, 0));
    const path = 'docs/verification/UI-DELIVERY-JOURNEY-' + name + '-2026-11-02.png';
    await page.screenshot({ path, fullPage: true });
    shots.push(path);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'horizontal overflow: ' + name,
    );
  }

  const base = '/warehouse/picking-lab';
  async function post(path, body, cookie = f.extraCookies[0]) {
    const token = (await f.staff('/staff/me', cookie)).data.csrfToken;
    const r = await fetch(f.base + '/api/v1' + base + path + '?warehouseId=' + f.warehouseId, {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'http://127.0.0.1:5188',
        'X-CSRF-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 200);
    return (await r.json()).data.task;
  }
  const nav = (name) => page.getByRole('button', { name, exact: true });
  const rid = (await f.staff('/staff/me', f.extraCookies[1])).data.id;
  async function seed() {
    let task = await post('', { key: randomUUID() });
    task = await post('/' + task.id + '/claim', { key: randomUUID(), version: 0 }, f.pickerCookie);
    for (const [lineId, quantity] of [
      ['PAPER_SINGLE', 2],
      ['PAPER_TRIPLE', 1],
    ])
      task = await post(
        '/' + task.id + '/check',
        { key: randomUUID(), version: task.version, exceptionVersion: 0, lineId, quantity },
        f.pickerCookie,
      );
    task = await post(
      '/' + task.id + '/pack',
      {
        key: randomUUID(),
        version: 3,
        exceptionVersion: 0,
        packageCount: 2,
        singleQuantity: 2,
        tripleQuantity: 1,
      },
      f.pickerCookie,
    );
    task = await post('/' + task.id + '/dispatch', {
      key: randomUUID(),
      version: 3,
      exceptionVersion: 0,
      packId: task.pack.id,
    });
    return task.pack.dispatch.id;
  }
  const listPattern = '**/api/v1/delivery-lab?*';
  await page.route(listPattern, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'LIST_UNAVAILABLE', message: '配送列表暂时不可用' } }),
    }),
  );
  await page.goto('http://127.0.0.1:5188/');
  await nav('配送演练').click();
  await page.getByRole('alert').filter({ hasText: '配送列表暂时不可用' }).waitFor();
  assert.equal(await page.getByText('暂无已出库的合成任务', { exact: true }).count(), 0);
  await shot('LIST-ERROR-DESKTOP');
  await page.unroute(listPattern);
  await nav('重试配送读取').click();
  await page.getByText('暂无已出库的合成任务', { exact: true }).waitFor();
  await shot('EMPTY-DESKTOP');
  const id = await seed();
  await nav('刷新配送列表').click();
  await nav('查看合成配送').click();
  await page.getByText('尚未分配骑手', { exact: true }).waitFor();
  assert.equal(await nav('确认合成分配').isDisabled(), true);
  await shot('UNASSIGNED-DESKTOP');
  await f.runtime.db.staff.update({ where: { id: rid }, data: { enabled: false } });
  await nav('刷新配送详情').click();
  await page
    .getByText('本仓暂无可分配骑手，请先维护员工角色与仓库权限。', { exact: true })
    .waitFor();
  await shot('NO-RIDERS-DESKTOP');
  await f.runtime.db.staff.update({ where: { id: rid }, data: { enabled: true } });
  await nav('刷新配送详情').click();
  await page.getByRole('combobox', { name: '接收骑手', exact: true }).selectOption(rid);
  const sent = [];
  let once = true;
  const pattern = '**/delivery-lab/' + id + '/assign?*';
  await page.route(pattern, async (route) => {
    sent.push(route.request().postData());
    if (once) {
      once = false;
      const result = await route.fetch();
      assert.equal(result.status(), 200);
      await route.abort('failed');
    } else await route.continue();
  });
  await nav('确认合成分配').click();
  await nav('按原分配重试').waitFor();
  assert.equal(await f.runtime.db.deliveryLabAssignment.count(), 1);
  await nav('库存总览').click();
  await nav('配送演练').click();
  await nav('刷新配送详情').click();
  await page.getByText('不可变分配凭据', { exact: true }).waitFor();
  await shot('ASSIGN-UNKNOWN-DESKTOP');
  await nav('按原分配重试').click();
  await page.getByText('原分配已恢复，未重复生成凭据。', { exact: true }).waitFor();
  assert.equal(sent.length, 2);
  assert.equal(sent[0], sent[1]);
  await page.unroute(pattern);
  await shot('ASSIGNED-DESKTOP');
  await seed(); // Unassigned task must not leak into rider's own list.
  await context.addCookies([
    {
      name: 'yumi_staff_session',
      value: f.extraCookies[1].split('=')[1],
      domain: '127.0.0.1',
      path: '/',
    },
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:5188/?mobile=1');
  await nav('配送演练').click();
  await nav('查看合成配送').waitFor();
  assert.equal(await nav('查看合成配送').count(), 1);
  await shot('RIDER-LIST-MOBILE');
  await nav('查看合成配送').click();
  await page.getByText('资格满足 · 尚未接货', { exact: true }).waitFor();
  assert.equal(await nav('确认合成分配').count(), 0);
  await shot('RIDER-DETAIL-MOBILE');
  await page.getByLabel('实际核对合成包裹数').fill('2');
  const acceptPattern = '**/delivery-lab/' + id + '/accept?*';
  let originalAccept;
  await page.route(acceptPattern, async (route) => {
    originalAccept = route.request().postData();
    assert.equal((await route.fetch()).status(), 200);
    await route.abort();
  });
  await nav('确认本人合成接货').click();
  await nav('按原接货请求重试').waitFor();
  await shot('ACCEPT-UNKNOWN-MOBILE');
  await page.unroute(acceptPattern);
  await nav('刷新配送详情').click();
  await page.getByText('不可变合成接货凭据', { exact: true }).waitFor();
  await page.route(acceptPattern, async (route) => {
    assert.equal(route.request().postData(), originalAccept);
    await route.continue();
  });
  await nav('按原接货请求重试').click();
  await page.getByText('原接货凭据已恢复，未重复交接。', { exact: true }).waitFor();
  assert.equal(await f.runtime.db.deliveryLabHandoff.count(), 1);
  await shot('ACCEPTED-MOBILE');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await shot('ACCEPTED-DESKTOP');
  await page.unroute(acceptPattern);

  await page.setViewportSize({ width: 390, height: 844 });
  for (const [action, label, button] of [
    ['start', '确认开始本次合成配送', '记录合成配送开始'],
    ['complete', '确认本次合成送达演练完成', '记录合成送达'],
  ]) {
    const pattern = '**/delivery-lab/' + id + '/' + action + '?*';
    let original;
    await page.getByLabel(label, { exact: true }).check();
    await page.route(pattern, async (route) => {
      original = route.request().postData();
      assert.equal((await route.fetch()).status(), 200);
      await route.abort();
    });
    await nav(button).click();
    await nav('按原阶段请求重试').waitFor();
    await shot(action.toUpperCase() + '-UNKNOWN-MOBILE');
    await page.unroute(pattern);
    await nav('刷新配送详情').click();
    await page
      .getByText(action === 'start' ? '合成配送中' : '合成送达已记录', { exact: true })
      .waitFor();
    await page.route(pattern, async (route) => {
      assert.equal(route.request().postData(), original);
      await route.continue();
    });
    await nav('按原阶段请求重试').click();
    await page.getByText('原阶段凭据已恢复，未重复记录。', { exact: true }).waitFor();
    await page.unroute(pattern);
    await shot(action.toUpperCase() + '-MOBILE');
  }
  assert.equal(await f.runtime.db.deliveryLabJourneyFact.count(), 2);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await shot('COMPLETED-DESKTOP');
  await context.addCookies([
    {
      name: 'yumi_staff_session',
      value: f.cookies[1].split('=')[1],
      domain: '127.0.0.1',
      path: '/',
    },
  ]);
  await page.goto('http://127.0.0.1:5188/?mobile=1');
  await nav('配送演练').click();
  await page
    .getByRole('article')
    .filter({ hasText: '合成送达已记录' })
    .getByRole('button', { name: '查看合成配送', exact: true })
    .click();
  await f.runtime.db.staff.update({ where: { id: rid }, data: { enabled: false } });
  await nav('刷新配送详情').click();
  await page.getByText('骑手账号已停用', { exact: true }).waitFor();
  await shot('BLOCKED-MOBILE');
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  pendingReleases.push(release);
  const detailPattern = '**/delivery-lab/' + id + '?*';
  await page.route(detailPattern, async (route) => {
    await gate;
    await route.continue();
  });
  await nav('刷新配送详情').click();
  await page.getByText('正在读取配送详情…', { exact: true }).waitFor();
  await shot('LOADING-MOBILE');
  release();
  await page.getByText('不可变分配凭据', { exact: true }).waitFor();
  await page.unroute(detailPattern);
  await page.route(detailPattern, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'READ_UNAVAILABLE', message: '配送读取暂时不可用' } }),
    }),
  );
  await nav('刷新配送详情').click();
  await page.getByRole('alert').filter({ hasText: '配送读取暂时不可用' }).waitFor();
  await shot('READ-ERROR-MOBILE');
  await page.unroute(detailPattern);
  await nav('重试配送读取').click();
  await page.getByText('不可变分配凭据', { exact: true }).waitFor();
  assert.equal(await f.runtime.db.deliveryLabAssignment.count(), 1);
  assert.equal(await f.runtime.db.consumerOrder.count(), 0);
  console.log(
    'Delivery real API/UI passed: empty/unassigned/no eligible rider, committed lost response and exact original retry across navigation, one immutable assignment, rider own list excludes unassigned tasks, rider no assign control, revoked account blocks readiness, loading/error recovery; desktop1440/mobile390 no overflow; screenshots:' +
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
