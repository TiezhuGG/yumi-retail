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
  dir = resolve('.local/picking-shortage-ui');
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
    const path = 'docs/verification/UI-PICKING-SHORTAGE-' + name + '-2026-11-01.png';
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
  await page.goto('http://127.0.0.1:5188/?mobile=1');
  await nav('拣货演练').click();
  await nav('查看演练任务').click();
  await page.getByText('上报单包装合成缺货', { exact: true }).click();
  await page.getByRole('spinbutton', { name: '单包装合成缺货数量', exact: true }).fill('1');
  await page
    .getByRole('combobox', { name: '单包装合成缺货原因', exact: true })
    .selectOption('DAMAGED');
  let lost = true;
  const reportBodies = [];
  await page.route('**/api/v1/warehouse/picking-lab/*/shortages?*', async (route) => {
    reportBodies.push(route.request().postDataJSON());
    if (lost) {
      lost = false;
      await route.fetch();
      return route.abort('failed');
    }
    return route.continue();
  });
  await nav('提交单包装缺货').click();
  await nav('按原操作重试').waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('REPORT-UNKNOWN-MOBILE');
  await nav('刷新演练详情').click();
  await page.getByText('未决 1 条', { exact: true }).waitFor();
  await nav('按原操作重试').click();
  await page.getByRole('status').filter({ hasText: '原操作已恢复' }).waitFor();
  assert.deepEqual(reportBodies[0], reportBodies[1]);
  assert.equal(reportBodies.length, 2);
  await page.unrouteAll({ behavior: 'wait' });
  for (const name of ['合成纸巾 单包装核对数量', '合成纸巾 3包装核对数量'])
    assert.equal(await page.getByRole('spinbutton', { name, exact: true }).isDisabled(), true);
  assert.equal(await nav('确认单包装已备齐').count(), 0);
  await shot('BLOCKED-MOBILE');
  task = (await f.staff(base + '/' + task.id + '?warehouseId=' + f.warehouseId, f.pickerCookie))
    .data.task;
  await post(
    '/' + task.id + '/shortages',
    {
      key: randomUUID(),
      version: task.version,
      exceptionVersion: task.exceptionVersion,
      lineId: 'PAPER_TRIPLE',
      missingQuantity: 1,
      reason: 'MISSING',
    },
    f.pickerCookie,
  );
  await nav('刷新演练详情').click();
  await page.getByText('未决 2 条', { exact: true }).waitFor();
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
  await nav('确认单包装已备齐').waitFor();
  await shot('BLOCKED-DESKTOP');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('spinbutton', { name: '单包装备齐确认数量', exact: true }).fill('1');
  await nav('确认单包装已备齐').click();
  await page.getByRole('alert').filter({ hasText: '必须确认原需求已全部备齐' }).waitFor();
  await shot('RESTORE-QUANTITY-ERROR-MOBILE');
  let restoreLost = true;
  const restoreBodies = [];
  await page.route('**/api/v1/warehouse/picking-lab/*/shortages/*/restore?*', async (route) => {
    restoreBodies.push(route.request().postDataJSON());
    if (restoreLost) {
      restoreLost = false;
      await route.fetch();
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '合成备齐响应未确认' } }),
      });
    }
    return route.continue();
  });
  await page.getByRole('spinbutton', { name: '单包装备齐确认数量', exact: true }).fill('2');
  await nav('确认单包装已备齐').click();
  await nav('按原操作重试').waitFor();
  await shot('RESTORE-UNKNOWN-MOBILE');
  await nav('刷新演练详情').click();
  await page.getByText('未决 1 条', { exact: true }).waitFor();
  await nav('按原操作重试').click();
  await page.getByRole('status').filter({ hasText: '原操作已恢复' }).waitFor();
  assert.equal(restoreBodies.length, 2);
  assert.deepEqual(restoreBodies[0], restoreBodies[1]);
  await page.unrouteAll({ behavior: 'wait' });
  await page.getByRole('spinbutton', { name: '3包装备齐确认数量', exact: true }).fill('1');
  await nav('确认3包装已备齐').click();
  await page.getByText('未决 0 条', { exact: true }).waitFor();
  assert.equal(
    await page
      .getByText('全部演练明细已核对；未打包、未出库、未交接骑手。', { exact: true })
      .count(),
    0,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await shot('RESOLVED-DESKTOP');
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
  await nav('查看演练任务').click();
  await page.getByText('未决 0 条', { exact: true }).waitFor();
  await page.getByRole('spinbutton', { name: '合成纸巾 单包装核对数量', exact: true }).fill('2');
  await nav('确认单包装核对').click();
  await page.getByText('该行演练已核对', { exact: true }).waitFor();
  await page.getByRole('spinbutton', { name: '合成纸巾 3包装核对数量', exact: true }).fill('1');
  await nav('确认3包装核对').click();
  await page
    .getByText('全部演练明细已核对；未打包、未出库、未交接骑手。', { exact: true })
    .waitFor();
  await shot('COMPLETED-MOBILE');
  assert.equal(await f.runtime.db.pickingLabShortage.count(), 2);
  assert.equal(await f.runtime.db.pickingLabShortageEvent.count(), 4);
  assert.equal(await f.runtime.db.consumerOrder.count(), 0);
  console.log(
    'Picking shortage real UI/API passed: owner report/damage reason, lost report original retry, all checking blocked, picker cannot restore, two open records, manager partial quantity refused, committed restore503/original recovery, one remaining shortage stays blocking, both restored do not auto-complete, owner rechecks to completion, history preserved, desktop/mobile no overflow; screenshots: ' +
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
