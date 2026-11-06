/* global document, innerWidth */
// Actual operations UI + disposable PostgreSQL API. Never seeds the operational database.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { rewardsFixture } from '../../tests/helpers/rewards-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd(),
  dir = resolve('.local/reward-check-ui');
const { createServer } = await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const f = await rewardsFixture();
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
    const path = 'docs/verification/UI-REWARD-CHECK-' + name + '-2026-11-06.png';
    await page.screenshot({ path, fullPage: true });
    shots.push(path);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'horizontal overflow: ' + name,
    );
  }
  const created = await f.api('/admin/mall-products', {
    categoryId: f.catalog.categoryId,
    name: '合成上架检查商品',
    skus: [{ code: 'CHECK-UI', spec: '1件装', unit: '件', priceCents: 1299, expiryManaged: false }],
    pointsPrice: '80',
    reason: '合成检查入口验收',
  });
  assert.equal(created.status, 200);
  const id = created.data.rewardId,
    productId = created.data.id;
  await page.goto('http://127.0.0.1:5188/');
  await page.getByRole('button', { name: '兑换商品', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: '合成上架检查商品' })
    .getByRole('button', { name: '查看商品', exact: true })
    .click();
  await page.getByRole('heading', { name: '上架前需先处理', exact: true }).waitFor();
  assert.equal(await page.locator('.reward-readiness-panel .readiness-check').count(), 10);
  await shot('BLOCKED-DESKTOP');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('BLOCKED-MOBILE');
  await page.getByRole('button', { name: '维护分类', exact: true }).click();
  await page.getByRole('dialog', { name: '分类名称与启停', exact: true }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: '关闭表单', exact: true }).click();
  await page.getByRole('heading', { name: '上架前需先处理', exact: true }).waitFor();
  await page.getByRole('button', { name: '管理图片', exact: true }).click();
  await page.getByRole('dialog', { name: '商品图片', exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭并刷新列表', exact: true }).waitFor();
  await shot('IMAGE-MAINTENANCE');
  await page.getByRole('button', { name: '关闭并刷新列表', exact: true }).click();
  await page.getByRole('heading', { name: '上架前需先处理', exact: true }).waitFor();
  await page.getByRole('button', { name: '维护规格与售价', exact: true }).click();
  await page.getByRole('dialog', { name: '规格售价与启停', exact: true }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: '关闭表单', exact: true }).click();
  await page.getByRole('heading', { name: '上架前需先处理', exact: true }).waitFor();
  await page.getByRole('button', { name: '上架基础商品', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '上架基础商品', exact: true });
  await page.route('**/api/v1/admin/products/' + productId + '/publish', async (route) => {
    const result = await route.fetch();
    assert.equal(result.status(), 200);
    await route.abort('failed');
  });
  await dialog.getByRole('button', { name: '确认上架基础商品', exact: true }).click();
  await dialog.getByRole('button', { name: '使用原请求重试上架', exact: true }).waitFor();
  await shot('SOURCE-UNKNOWN');
  assert.equal(
    (await f.runtime.db.product.findUniqueOrThrow({ where: { id: productId } })).status,
    'PUBLISHED',
  );
  assert.equal(
    (await f.runtime.db.rewardProduct.findUniqueOrThrow({ where: { id } })).status,
    'DRAFT',
  );
  await page.unroute('**/api/v1/admin/products/' + productId + '/publish');
  await dialog.getByRole('button', { name: '使用原请求重试上架', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: '当前符合上架条件', exact: true }).waitFor();
  await shot('WARNINGS-MOBILE');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await shot('WARNINGS-DESKTOP');
  // Zero stock, missing photo and absent shipping remain warnings: no new business restriction.
  await page.getByRole('button', { name: '编辑与上下架', exact: true }).click();
  await page.getByRole('dialog').getByLabel('操作原因', { exact: true }).fill('核对合成商品后上架');
  await page.getByRole('dialog').getByRole('button', { name: '上架商品', exact: true }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page
    .getByRole('row')
    .filter({ hasText: '合成上架检查商品' })
    .getByRole('button', { name: '查看商品', exact: true })
    .click();
  await page.getByRole('heading', { name: '商品已上架', exact: true }).waitFor();
  await shot('PUBLISHED');
  assert.equal(
    (await f.runtime.db.rewardProduct.findUniqueOrThrow({ where: { id } })).status,
    'PUBLISHED',
  );
  const staleVersion = (await f.runtime.db.rewardProduct.findUniqueOrThrow({ where: { id } }))
    .version;
  await page.getByRole('button', { name: '维护兑换规则', exact: true }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: '关闭表单', exact: true }).click();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/admin/rewards/' + id + '/readiness', async (route) => {
    await gate;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: '合成商品检查读取失败' } }),
    });
  });
  await page.getByRole('button', { name: '刷新商品检查', exact: true }).click();
  await page.getByText('正在检查商品…', { exact: true }).waitFor();
  await shot('LOADING');
  release();
  await page.getByRole('alert').filter({ hasText: '合成商品检查读取失败' }).waitFor();
  assert.equal(await page.locator('.reward-readiness-panel .readiness-check').count(), 0);
  await shot('ERROR');
  await page.unroute('**/api/v1/admin/rewards/' + id + '/readiness');
  await page.getByRole('button', { name: '重试商品检查', exact: true }).click();
  await page.getByRole('heading', { name: '商品已上架', exact: true }).waitFor();
  assert.equal(
    (await f.runtime.db.rewardProduct.findUniqueOrThrow({ where: { id } })).version,
    staleVersion,
  );
  await page.getByRole('button', { name: '配置快递范围', exact: true }).click();
  await page
    .locator('summary')
    .filter({ hasText: /^快递范围与运费配置$/ })
    .click();
  await page
    .locator('summary')
    .filter({ hasText: /^快递寄送规则$/ })
    .click();
  await page.getByRole('button', { name: '刷新快递规则', exact: true }).waitFor();
  await shot('SHIPPING-DESTINATION');
  console.log(
    'Actual admin UI + isolated PG: 10 checks, maintenance dialogs, source publish lost-response recovery, warnings vs blockers, actual reward publish, loading/error/retry and shipping navigation passed. Screenshots: ' +
      shots.length,
  );
} catch (e) {
  if (page) {
    await page.screenshot({ path: '.local/reward-check-ui-failure.png', fullPage: true });
    await writeFile('.local/reward-check-ui-failure.html', await page.content());
  }
  throw e;
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  await f.cleanup();
}
