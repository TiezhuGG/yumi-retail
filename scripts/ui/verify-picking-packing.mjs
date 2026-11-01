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
  root = process.cwd(),
  dir = resolve('.local/picking-packing-ui');
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
      value: f.pickerCookie.split('=')[1],
      domain: '127.0.0.1',
      path: '/',
    },
  ]);
  const page = await context.newPage();
  const shots = [];
  async function shot(name) {
    await page.evaluate(() => window.scrollTo(0, 0));
    const path = 'docs/verification/UI-PICKING-PACKING-' + name + '-2026-11-01.png';
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
  let task = await post('', { key: randomUUID() });
  task = await post('/' + task.id + '/claim', { key: randomUUID(), version: 0 }, f.pickerCookie);
  const nav = (name) => page.getByRole('button', { name, exact: true });
  const spin = (name) => page.getByRole('spinbutton', { name, exact: true });
  await page.goto('http://127.0.0.1:5188/?mobile=1');
  await nav('拣货演练').click();
  await nav('查看演练任务').click();
  assert.equal(await nav('确认合成打包').isDisabled(), true);
  await shot('INCOMPLETE-DESKTOP');
  for (const [lineId, quantity] of [
    ['PAPER_SINGLE', 2],
    ['PAPER_TRIPLE', 1],
  ])
    task = await post(
      '/' + task.id + '/check',
      { key: randomUUID(), version: task.version, exceptionVersion: 0, lineId, quantity },
      f.pickerCookie,
    );
  await nav('刷新演练详情').click();
  await spin('单包装装包数量').fill('1');
  await spin('3包装装包数量').fill('1');
  await nav('确认合成打包').click();
  await page.getByRole('alert').filter({ hasText: '打包数量必须与原演练需求逐行一致' }).waitFor();
  await shot('QUANTITY-ERROR-DESKTOP');
  await spin('单包装装包数量').fill('2');
  const packRequests = [];
  let once = true;
  await page.route('**/picking-lab/*/pack?*', async (route) => {
    packRequests.push(route.request().postData());
    if (once) {
      once = false;
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  });
  await nav('确认合成打包').click();
  await nav('按原操作重试').waitFor();
  assert.equal(await f.runtime.db.pickingLabPack.count(), 1);
  await nav('库存总览').click();
  await nav('拣货演练').click();
  await nav('刷新演练详情').click();
  await page
    .getByRole('region', { name: '合成打包与出库', exact: true })
    .getByText('合成打包已记录', { exact: true })
    .waitFor();
  assert.equal(await nav('确认合成出库').count(), 0);
  await shot('PACK-UNKNOWN-DESKTOP');
  await nav('按原操作重试').click();
  await page.getByText('原操作已恢复，未重复追加记录。', { exact: true }).waitFor();
  assert.equal(packRequests.length, 2);
  assert.equal(packRequests[0], packRequests[1]);
  await page.unroute('**/picking-lab/*/pack?*');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('PACKED-MOBILE');
  await context.addCookies([
    {
      name: 'yumi_staff_session',
      value: f.cookies[1].split('=')[1],
      domain: '127.0.0.1',
      path: '/',
    },
  ]);
  await page.goto('http://127.0.0.1:5188/?mobile=1');
  await nav('拣货演练').click();
  await nav('查看演练任务').click();
  await nav('确认合成出库').waitFor();
  await shot('DISPATCH-READY-MOBILE');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const dispatchRequests = [];
  once = true;
  await page.route('**/picking-lab/*/dispatch?*', async (route) => {
    dispatchRequests.push(route.request().postData());
    if (once) {
      once = false;
      await route.fetch();
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: false,
          error: { code: 'UNCONFIRMED', message: '合成出库响应未确认' },
        }),
      });
    } else await route.continue();
  });
  await nav('确认合成出库').click();
  await nav('按原操作重试').waitFor();
  assert.equal(await f.runtime.db.pickingLabDispatch.count(), 1);
  await nav('刷新演练详情').click();
  await page
    .getByRole('region', { name: '合成打包与出库', exact: true })
    .getByText('合成出库已记录', { exact: true })
    .waitFor();
  await shot('DISPATCH-UNKNOWN-DESKTOP');
  await nav('按原操作重试').click();
  await page.getByText('原操作已恢复，未重复追加记录。', { exact: true }).waitFor();
  assert.equal(dispatchRequests.length, 2);
  assert.equal(dispatchRequests[0], dispatchRequests[1]);
  await page.unroute('**/picking-lab/*/dispatch?*');
  assert.equal(await nav('确认合成出库').count(), 0);
  await shot('COMPLETED-DESKTOP');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('COMPLETED-MOBILE');
  let releaseRead;
  const readGate = new Promise((resolve) => {
    releaseRead = resolve;
  });
  pendingReleases.push(releaseRead);
  const detailPattern = '**/picking-lab/' + task.id + '?*';
  await page.route(detailPattern, async (route) => {
    await readGate;
    await route.continue();
  });
  await nav('刷新演练详情').click();
  await page.getByText('正在读取演练详情…', { exact: true }).waitFor();
  await shot('LOADING-MOBILE');
  releaseRead();
  await page
    .getByRole('region', { name: '合成打包与出库', exact: true })
    .getByText('合成出库已记录', { exact: true })
    .waitFor();
  await page.unroute(detailPattern);
  await page.route(detailPattern, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: false,
        error: { code: 'READ_UNAVAILABLE', message: '演练详情暂时不可用' },
      }),
    }),
  );
  await nav('刷新演练详情').click();
  await page.getByRole('alert').filter({ hasText: '演练详情暂时不可用' }).waitFor();
  await shot('READ-ERROR-MOBILE');
  await page.unroute(detailPattern);
  await nav('刷新演练记录').click();
  await page
    .getByRole('region', { name: '合成打包与出库', exact: true })
    .getByText('合成出库已记录', { exact: true })
    .waitFor();
  assert.equal(await f.runtime.db.pickingLabPack.count(), 1);
  assert.equal(await f.runtime.db.pickingLabDispatch.count(), 1);
  assert.equal(await f.runtime.db.consumerOrder.count(), 0);
  console.log(
    'Packing real UI/API passed: incomplete disabled, wrong quantities rejected, lost pack response and committed dispatch503 recover exact original bodies, navigation retains pending, picker cannot dispatch, manager confirms once, immutable receipts, desktop/mobile no overflow; screenshots: ' +
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
