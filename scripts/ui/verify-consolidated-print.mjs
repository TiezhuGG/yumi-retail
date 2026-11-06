/* global document, innerWidth, window */
// Actual operations UI + disposable PostgreSQL API. Never seeds the operational database.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expressShippingFixture } from '../../tests/helpers/express-shipping-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd(),
  dir = resolve('.local/consolidated-print-ui');
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
    const path = 'docs/verification/UI-CONSOLIDATED-PRINT-' + name + '-2026-11-06.png';
    await page.screenshot({ path, fullPage: true });
    shots.push(path);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'horizontal overflow: ' + name,
    );
  }

  const ids = [await f.createExpress(), await f.createExpress(2)];
  await page.goto('http://127.0.0.1:5188/');
  await page.getByRole('button', { name: '积分兑换订单', exact: true }).click();
  await page.getByRole('button', { name: '查看订单详情', exact: true }).first().waitFor();
  assert.ok(await page.getByRole('button', { name: '汇总配货打印', exact: true }).isDisabled());
  await page.getByLabel('选择本页有效订单', { exact: true }).check();
  await shot('SELECTED');
  const endpoint = '**/admin/redemptions/consolidated-print-preview';
  await page.route(endpoint, (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'TEST_UNAVAILABLE', message: '合成预览不可用' } }),
    }),
  );
  await page.getByRole('button', { name: '汇总配货打印', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '合成预览不可用' }).waitFor();
  await shot('ERROR');
  await page.unroute(endpoint);
  await page.getByRole('button', { name: '重试打印预览', exact: true }).click();
  const frame = page.frames().find((x) => x !== page.mainFrame());
  await frame.getByRole('heading', { name: '多订单汇总配货单', exact: true }).waitFor();
  assert.equal(await frame.locator('.sheet').count(), 1);
  assert.equal(await frame.locator('.order-detail').count(), 2);
  assert.ok((await frame.locator('table').first().textContent()).includes('3'));
  await shot('DESKTOP');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await shot('MOBILE');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const printPage = await context.newPage();
  await printPage.setContent(await frame.content());
  await printPage.emulateMedia({ media: 'print' });
  await printPage.screenshot({
    path: 'docs/verification/UI-CONSOLIDATED-PRINT-A4-2026-11-06.png',
    fullPage: true,
  });
  const pdf = await printPage.pdf({ path: dir + '/consolidated-a4.pdf', preferCSSPageSize: true });
  assert.ok((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length >= 1);
  await printPage.close();
  await frame.evaluate(() => {
    window.print = () => {
      window.parent.__combinedPrintCalls = (window.parent.__combinedPrintCalls || 0) + 1;
    };
  });
  await page.getByRole('button', { name: '打印订单', exact: true }).click();
  await page.waitForFunction(() => window.__combinedPrintCalls === 1);
  assert.equal(
    (await f.call('/consumer/redemptions/' + ids[0] + '/cancel', { version: 0 })).status,
    200,
  );
  await page.getByRole('button', { name: '打印订单', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '已取消' }).waitFor();
  assert.equal(await frame.locator('body').textContent(), '');
  assert.equal(await page.evaluate(() => window.__combinedPrintCalls), 1);
  await shot('STALE-REJECTED');
  console.log(
    'Actual UI + isolated PG: selection, error/retry, consolidated quantities/order details, desktop/mobile, A4, fresh print and stale cancellation passed; screenshots ' +
      (shots.length + 1),
  );
} catch (e) {
  if (page) {
    await page.screenshot({ path: '.local/consolidated-print-ui-failure.png', fullPage: true });
    await writeFile('.local/consolidated-print-ui-failure.html', await page.content());
  }
  throw e;
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  await f.cleanup();
}
