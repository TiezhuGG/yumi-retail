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
  dir = resolve('.local/admin-mall-ui');
const { createServer } = await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const f = await rewardsFixture();
let server, browser, page;
try {
  await f.seed();
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
    const path = 'docs/verification/UI-ADMIN-MALL-' + name + '-2026-11-06.png';
    await page.screenshot({ path, fullPage: true });
    shots.push(path);
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'horizontal overflow: ' + name,
    );
  }
  await f.api('/admin/points/grants/store/policy', {
    version: 0,
    enabled: true,
    singleLimit: '1000',
    dailyLimit: '10000',
    reason: '合成浏览器验收预算',
  });
  await page.goto('http://127.0.0.1:5188/');
  await page.getByRole('button', { name: '顾客管理', exact: true }).click();
  await page.getByRole('button', { name: '查看顾客', exact: true }).first().waitFor();
  assert.equal(await page.getByRole('button', { name: '查看顾客', exact: true }).count(), 20);
  await shot('CUSTOMERS-DESKTOP');
  await page.getByRole('button', { name: '加载更多顾客', exact: true }).click();
  await page
    .getByRole('button', { name: '加载更多顾客', exact: true })
    .waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: '查看顾客', exact: true }).count(), 25);
  await page.getByLabel('顾客名称', { exact: true }).fill('合成积分顾客 A');
  await page.getByRole('button', { name: '查询顾客', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: '合成积分顾客 A' })
    .getByRole('button', { name: '查看顾客', exact: true })
    .click();
  await page.getByRole('heading', { name: '合成积分顾客 A', exact: true }).waitFor();
  await page.getByText('合成验证流水 01', { exact: true }).waitFor();
  await shot('CUSTOMER-DETAIL-DESKTOP');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('CUSTOMER-DETAIL-MOBILE');
  await page.getByRole('button', { name: '发放积分', exact: true }).click();
  await page.getByRole('button', { name: '申请发放积分', exact: true }).click();
  const dialog = page.getByRole('dialog');
  assert.equal(
    await dialog.getByLabel('发放对象', { exact: true }).inputValue(),
    f.identity.user.id,
  );
  assert.equal(await dialog.getByLabel('发放对象', { exact: true }).isDisabled(), true);
  await dialog.getByLabel('发放积分', { exact: true }).fill('35');
  await dialog.getByLabel('业务凭据编号', { exact: true }).fill('ADMIN-MALL-UI-GRANT');
  await dialog.getByLabel('发放原因', { exact: true }).fill('合成顾客发放验收');
  await shot('GRANT-RECIPIENT');
  await page.route('**/api/v1/admin/points/grants/store/create', async (route) => {
    await route.fetch();
    await route.abort('failed');
  });
  await dialog.getByRole('button', { name: '提交发放申请', exact: true }).click();
  await dialog.getByRole('button', { name: '使用原操作重试', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '返回顾客列表', exact: true }).isDisabled(),
    true,
  );
  await shot('GRANT-UNKNOWN');
  await page.unroute('**/api/v1/admin/points/grants/store/create');
  await dialog.getByRole('button', { name: '使用原操作重试', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal(await f.runtime.db.pointsGrant.count(), 1);
  await page.getByRole('button', { name: '误发冲正', exact: true }).click();
  await page.getByText('暂无冲正申请', { exact: true }).waitFor();
  await shot('CORRECTIONS-EMPTY');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '兑换商品', exact: true }).click();
  await page.getByRole('button', { name: '创建全新商品', exact: true }).click();
  await dialog.getByLabel('商品名称', { exact: true }).fill('合成双价浏览器商品');
  await dialog.getByLabel('商品分类', { exact: true }).selectOption(f.catalog.categoryId);
  await dialog.getByLabel('SKU编码', { exact: true }).fill('ADMIN-MALL-UI');
  await dialog.getByLabel('规格', { exact: true }).fill('1件装');
  await dialog.getByLabel('单位', { exact: true }).fill('件');
  await dialog.getByLabel('售价（元）', { exact: true }).fill('12.99');
  await dialog.getByLabel('兑换所需积分', { exact: true }).fill('90');
  await dialog.getByLabel('操作原因', { exact: true }).fill('合成商品发布验收');
  await shot('PRODUCT-DUAL-PRICE');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('PRODUCT-DUAL-PRICE-MOBILE');
  await page.route('**/api/v1/admin/mall-products', async (route) => {
    await route.fetch();
    await route.abort('failed');
  });
  await dialog.getByRole('button', { name: '保存商品草稿', exact: true }).click();
  await dialog.getByRole('button', { name: '使用原请求重试', exact: true }).waitFor();
  await shot('PRODUCT-UNKNOWN');
  await page.unroute('**/api/v1/admin/mall-products');
  await dialog.getByRole('button', { name: '使用原请求重试', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('cell', { name: '合成双价浏览器商品', exact: false }).waitFor();
  const p = await f.runtime.db.product.findFirstOrThrow({
    where: { name: '合成双价浏览器商品' },
    include: { skus: true },
  });
  assert.equal(p.skus[0].priceCents, 1299n);
  const reward = await f.runtime.db.rewardProduct.findFirstOrThrow({
    where: { skuId: p.skus[0].id },
  });
  assert.equal(reward.pointsPrice, 90n);
  assert.equal(await f.runtime.db.sku.count({ where: { code: 'ADMIN-MALL-UI' } }), 1);
  assert.equal((await f.api('/admin/products/' + p.id + '/publish', { version: 0 })).status, 200);
  await page.getByRole('button', { name: '查看商品', exact: true }).click();
  await page.getByRole('button', { name: '编辑与上下架', exact: true }).click();
  await dialog.getByLabel('操作原因', { exact: true }).fill('核对合成分类与规格后上架');
  await dialog.getByRole('button', { name: '上架商品', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('table').getByText('已上架', { exact: true }).waitFor();
  await shot('REWARD-PUBLISHED');
  await page.getByRole('button', { name: '顾客管理', exact: true }).click();
  await page.getByRole('button', { name: '查看顾客', exact: true }).first().waitFor();
  await page.getByLabel('顾客名称', { exact: true }).fill('不存在的合成顾客');
  await page.getByRole('button', { name: '查询顾客', exact: true }).click();
  await page.getByText('暂无匹配顾客', { exact: true }).waitFor();
  await shot('CUSTOMERS-EMPTY');
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route('**/api/v1/admin/customers?**', async (route) => {
    await gate;
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: '合成顾客查询失败' } }),
    });
  });
  await page.getByRole('button', { name: '查询顾客', exact: true }).click();
  await page.getByText('正在读取顾客资料…', { exact: true }).waitFor();
  await shot('CUSTOMERS-LOADING');
  release();
  await page.getByRole('alert').filter({ hasText: '合成顾客查询失败' }).waitFor();
  await shot('CUSTOMERS-ERROR');
  await page.unroute('**/api/v1/admin/customers?**');
  await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await page.getByText('暂无匹配顾客', { exact: true }).waitFor();
  console.log(
    'Actual admin UI and isolated PG: dual prices, atomic create, publish, directory pagination/profile, fixed grant recipient, lost-response original-key recovery, empty/loading/error/retry passed. Screenshots: ' +
      shots.length,
  );
} catch (e) {
  if (page) {
    await page.screenshot({ path: '.local/admin-mall-ui-failure.png', fullPage: true });
    await writeFile('.local/admin-mall-ui-failure.html', await page.content());
  }
  throw e;
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  await f.cleanup();
}
