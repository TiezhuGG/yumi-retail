/* global document, innerWidth, window */
// Actual operations UI + disposable PostgreSQL API. Never seeds the operational database.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pickingFixture } from '../../tests/helpers/picking-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd(),
  dir = resolve('.local/picking-lab-ui');
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
      value: f.extraCookies[0].split('=')[1],
      domain: '127.0.0.1',
      path: '/',
    },
  ]);
  const page = await context.newPage();
  const shots = [];
  async function shot(name) {
    await page.evaluate(() => window.scrollTo(0, 0));
    const path = 'docs/verification/UI-PICKING-LAB-' + name + '-2026-11-01.png';
    await page.screenshot({ path, fullPage: true });
    shots.push(path);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'horizontal overflow: ' + name,
    );
  }

  const nav = (name) => page.getByRole('button', { name, exact: true });
  await page.goto('http://127.0.0.1:5188/');
  await nav('拣货演练').click();
  await page.getByText('暂无合成拣货任务', { exact: true }).waitFor();
  await shot('EMPTY-DESKTOP');
  await nav('创建固定演练任务').click();
  await nav('领取演练任务').waitFor();
  await shot('READY-DESKTOP');
  const t = await f.runtime.db.pickingLabTask.findFirstOrThrow();
  await context.addCookies([
    {
      name: 'yumi_staff_session',
      value: f.pickerCookie.split('=')[1],
      domain: '127.0.0.1',
      path: '/',
    },
  ]);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:5188/?mobile=1');
  await nav('拣货演练').click();
  await nav('查看演练任务').waitFor();
  assert.equal(await nav('创建固定演练任务').count(), 0);
  let release, entered;
  const reached = new Promise((r) => (entered = r)),
    gate = new Promise((r) => (release = r));
  pendingReleases.push(release);
  await page.route('**/api/v1/warehouse/picking-lab/*?*', async (route) => {
    if (route.request().method() === 'GET') {
      entered();
      await gate;
    }
    return route.continue();
  });
  await nav('查看演练任务').click();
  await reached;
  await page.getByText('正在读取演练详情…', { exact: true }).waitFor();
  await shot('LOADING-MOBILE');
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await nav('领取演练任务').waitFor();
  let lost = true;
  const claimBodies = [];
  await page.route('**/api/v1/warehouse/picking-lab/*/claim?*', async (route) => {
    claimBodies.push(route.request().postDataJSON());
    if (lost) {
      lost = false;
      await route.fetch();
      return route.abort('failed');
    }
    return route.continue();
  });
  await nav('领取演练任务').click();
  await nav('按原操作重试').waitFor();
  await shot('UNKNOWN-CLAIM-MOBILE');
  await nav('库存总览').click();
  await nav('拣货演练').click();
  await nav('按原操作重试').waitFor();
  await nav('刷新演练详情').click();
  await page.getByText('领取人：隔离拣货验收员', { exact: true }).waitFor();
  await nav('返回演练列表').click();
  await nav('查看演练任务').click();
  await nav('按原操作重试').click();
  await page.getByRole('status').filter({ hasText: '原操作已恢复' }).waitFor();
  assert.equal(claimBodies.length, 2);
  assert.deepEqual(claimBodies[0], claimBodies[1]);
  await page.unrouteAll({ behavior: 'wait' });
  const first = page.getByRole('spinbutton', { name: '合成纸巾 单包装核对数量', exact: true });
  await first.fill('1');
  await nav('确认单包装核对').click();
  await page.getByRole('alert').filter({ hasText: '核对数量与固定演练需求不一致' }).waitFor();
  await shot('QUANTITY-ERROR-MOBILE');
  await first.fill('2');
  await nav('确认单包装核对').click();
  await page.getByText('该行演练已核对', { exact: true }).waitFor();
  let checkLost = true;
  const checkBodies = [];
  await page.route('**/api/v1/warehouse/picking-lab/*/check?*', async (route) => {
    checkBodies.push(route.request().postDataJSON());
    if (checkLost) {
      checkLost = false;
      await route.fetch();
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '合成核对响应暂不可确认' } }),
      });
    }
    return route.continue();
  });
  await page.getByRole('spinbutton', { name: '合成纸巾 3包装核对数量', exact: true }).fill('1');
  await nav('确认3包装核对').click();
  await nav('按原操作重试').waitFor();
  await nav('刷新演练详情').click();
  await page
    .getByText('全部演练明细已核对；未打包、未出库、未交接骑手。', { exact: true })
    .waitFor();
  await nav('按原操作重试').click();
  await page.getByRole('status').filter({ hasText: '原操作已恢复' }).waitFor();
  assert.equal(checkBodies.length, 2);
  assert.deepEqual(checkBodies[0], checkBodies[1]);
  await page.unrouteAll({ behavior: 'wait' });
  assert.equal(await f.runtime.db.pickingLabEvent.count({ where: { taskId: t.id } }), 4);
  await shot('CHECKED-MOBILE');
  await page.route('**/api/v1/warehouse/picking-lab/*?*', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: '合成演练详情读取中断' } }),
    }),
  );
  await nav('刷新演练详情').click();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.locator('.picking-line').count(), 0);
  await shot('READ-ERROR-MOBILE');
  await page.unrouteAll({ behavior: 'wait' });
  await nav('刷新演练记录').click();
  await page.getByText('演练核对完成', { exact: true }).waitFor();
  // Current owner remains visible but a manager cannot take over someone else's checks.
  await context.addCookies([
    {
      name: 'yumi_staff_session',
      value: f.extraCookies[0].split('=')[1],
      domain: '127.0.0.1',
      path: '/',
    },
  ]);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://127.0.0.1:5188/');
  await nav('拣货演练').click();
  await nav('查看演练任务').click();
  await page.getByText('演练核对完成', { exact: true }).waitFor();
  assert.equal(await page.getByRole('spinbutton').count(), 0);
  await shot('CHECKED-DESKTOP');
  assert.equal(await f.runtime.db.consumerOrder.count(), 0);
  assert.equal(await f.runtime.db.paymentPreparation.count(), 0);
  assert.equal(await f.runtime.db.stockLedger.count({ where: { actorKind: 'SYSTEM' } }), 0);
  console.log(
    'Picking lab actual UI/API passed: empty/create admin, picker cannot create, mobile role navigation, loading, lost claim then refresh/navigation/original retry, quantity mismatch, both lines checked, lost final check/original retry even after completed, immutable 4-event history, read error clears stale detail/retry, admin completed read-only, desktop/mobile without overflow; screenshots: ' +
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
