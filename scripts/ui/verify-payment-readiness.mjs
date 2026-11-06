/* global document, innerWidth */
// Actual operations UI + disposable PostgreSQL API. Never seeds the operational database.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { orderAdminFixture } from '../../tests/helpers/order-admin-fixture.ts';
import { randomBytes } from 'node:crypto';
import { PaymentReadinessService } from '../../apps/api/dist/payment-readiness.js';
import { paymentConfiguration } from '../../apps/api/dist/payment-config.js';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd(),
  dir = resolve('.local/payment-readiness-ui');
const { createServer } = await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const shotTag = process.env.YUMI_UI_SHOT_TAG || '';
if (!/^[A-Z0-9-]{0,20}$/.test(shotTag)) throw Error('Invalid screenshot tag');
const f = await orderAdminFixture();
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
    const path =
      'docs/verification/UI-PAYMENT-READINESS-' +
      (shotTag ? shotTag + '-' : '') +
      name +
      '-2026-11-06.png';
    await page.screenshot({ path, fullPage: true });
    shots.push(path);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'horizontal overflow: ' + name,
    );
  }
  await page.goto('http://127.0.0.1:5188/');
  await page.getByRole('button', { name: '支付接入检查', exact: true }).click();
  await page.getByRole('heading', { name: '当前不能发起支付', exact: true }).waitFor();
  assert.equal(await page.locator('.readiness-check').count(), 14);
  assert.equal(await page.getByText('未配置', { exact: true }).count(), 4);
  await page.getByRole('heading', { name: 'JSAPI下单与调起签名', exact: true }).waitFor();
  await page.getByRole('heading', { name: '凭据加载与HTTPS传输', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '启用支付', exact: true }).count(), 0);
  await shot('DESKTOP');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('MOBILE');
  // Exercise the service's sanitized configuration metadata, never mock a successful payment.
  const service = f.runtime.app.get(PaymentReadinessService),
    saved = [...service.configuration];
  service.configuration.splice(
    0,
    service.configuration.length,
    ...paymentConfiguration({
      WECHAT_PAYER_KEY_ID: 'synthetic-ui-v1',
      WECHAT_PAYER_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    }),
  );
  await page.getByRole('button', { name: '刷新接入检查', exact: true }).click();
  await page
    .getByText(
      '独立加密配置格式通过；新微信登录可保存加密付款人绑定，真实平台及密钥保管/恢复仍待验收。',
      { exact: true },
    )
    .waitFor();
  await page.getByRole('heading', { name: '当前不能发起支付', exact: true }).waitFor();
  await shot('PAYER-CONFIGURED');
  service.configuration.splice(0, service.configuration.length, ...saved);
  await f.runtime.db.checkoutPolicy.update({
    where: { warehouseId: f.warehouseId },
    data: { open: false },
  });
  await page.getByRole('button', { name: '刷新接入检查', exact: true }).click();
  await page.getByText('已有规则但报价暂停；不能据此进行真实交易。', { exact: true }).waitFor();
  await shot('PAUSED');
  await f.runtime.db.checkoutPolicy.delete({ where: { warehouseId: f.warehouseId } });
  await page.getByRole('button', { name: '刷新接入检查', exact: true }).click();
  await page
    .getByText('尚未配置运费、起送及免运规则；不会填入开发样例。', { exact: true })
    .waitFor();
  await shot('MISSING');
  let fail = false,
    gate;
  await page.route('**/api/v1/admin/payment-readiness**', async (route) => {
    if (gate) await gate;
    if (fail)
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '合成接入检查读取失败' } }),
      });
    return route.continue();
  });
  let release;
  gate = new Promise((r) => (release = r));
  await page.getByRole('button', { name: '刷新接入检查', exact: true }).click();
  await page.getByText('正在读取接入检查…', { exact: true }).waitFor();
  await shot('LOADING');
  release();
  gate = undefined;
  await page.getByRole('heading', { name: '当前不能发起支付', exact: true }).waitFor();
  fail = true;
  await page.getByRole('button', { name: '刷新接入检查', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '合成接入检查读取失败' }).waitFor();
  assert.equal(await page.locator('.readiness-check').count(), 0);
  await shot('ERROR');
  fail = false;
  await page.getByRole('button', { name: '重新检查', exact: true }).click();
  await page.getByRole('heading', { name: '当前不能发起支付', exact: true }).waitFor();
  // Warehouse list has an explicit empty/error state; only this controlled edge response is synthetic.
  await page.route('**/api/v1/warehouse/warehouses', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { items: [] } }),
    }),
  );
  await page.reload();
  await page.getByRole('button', { name: '支付接入检查', exact: true }).click();
  await page.getByText('暂无授权仓库，请联系负责人。', { exact: true }).waitFor();
  await shot('NO-WAREHOUSE');
  await page.unroute('**/api/v1/warehouse/warehouses');
  const restricted = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await restricted.addCookies([
    {
      name: 'yumi_staff_session',
      value: f.cookies[0].split('=')[1],
      domain: '127.0.0.1',
      path: '/',
    },
  ]);
  const op = await restricted.newPage();
  await op.goto('http://127.0.0.1:5188/');
  await op.getByRole('button', { name: '订单查询', exact: true }).waitFor();
  assert.equal(await op.getByRole('button', { name: '支付接入检查', exact: true }).count(), 0);
  await restricted.close();
  console.log(
    'Actual admin UI with real isolated API: 14 honest blocked/readiness checks, desktop/mobile, policy pause/missing, loading/error retry, no warehouse and operations role exclusion passed. No provider calls or credentials. Screenshots: ' +
      shots.length,
  );
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  await f.cleanup();
}
