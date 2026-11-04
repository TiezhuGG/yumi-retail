import { randomUUID } from 'node:crypto';
/* global document, innerWidth, window */
// Actual React pages + real API + disposable PG schema. Browser mini adapter is not native WeChat.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { rewardsFixture } from '../../tests/helpers/rewards-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd().replaceAll('\\', '/'),
  dir = resolve('.local/rewards-ui');
const { createServer, build } =
  await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const f = await rewardsFixture();
let server, browser;
const shots = [],
  releases = [];

try {
  await mkdir(dir + '/public', { recursive: true });
  await writeFile(
    dir + '/public/admin.css',
    await readFile('packages/web-ui/src/styles.css', 'utf8'),
  );
  const css = (
    await require(resolve('apps/consumer-mini/node_modules/less')).render(
      await readFile('apps/consumer-mini/src/app.less', 'utf8'),
    )
  ).css.replace(/([\d.]+)rpx/g, (_, n) => Number(n) / 2 + 'px');
  await writeFile(
    dir + '/public/mini.css',
    css.replace(/page\s*\{/g, 'body{') +
      '\nbody{margin:0;font-family:Arial,Microsoft YaHei,sans-serif;}button{display:block;box-sizing:border-box;font-family:inherit;}',
  );
  await writeFile(
    dir + '/index.html',
    '<html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  );
  await writeFile(
    dir + '/components.tsx',
    `import React from 'react';export const ScrollView=({scrollX,children,...p})=><div style={{overflowX:scrollX?'auto':undefined}} {...p}>{children}</div>;export const View=({children,...p})=><div {...p}>{children}</div>;export const Text=({children,...p})=><span {...p}>{children}</span>;export const Button=({children,...p})=><button {...p}>{children}</button>;export const Input=({onInput,onConfirm,maxlength,...p})=><input {...p} maxLength={maxlength} onChange={e=>onInput?.({detail:{value:e.target.value}})} onKeyDown={e=>{if(e.key==='Enter')onConfirm?.()}}/>;export const Image=({src,mode,...p})=><img src={src} {...p}/>;`,
  );
  await writeFile(
    dir + '/taro.ts',
    `import {useEffect} from 'react';export function useDidShow(fn){useEffect(()=>{fn();window.addEventListener('yumi:show',fn);return()=>window.removeEventListener('yumi:show',fn)},[])}export function useRouter(){return {params:Object.fromEntries(new URLSearchParams(location.search))}};export function useDidHide(fn){useEffect(()=>{window.addEventListener('yumi:hide',fn);return()=>window.removeEventListener('yumi:hide',fn)},[])}const Taro={getStorageSync:k=>JSON.parse(localStorage.getItem(k)||'null'),setStorageSync:(k,v)=>localStorage.setItem(k,JSON.stringify(v)),removeStorageSync:k=>localStorage.removeItem(k),request:async o=>{const r=await fetch('/api/v1'+o.url.split('/api/v1')[1],{method:o.method,headers:o.header,body:o.method==='GET'?undefined:JSON.stringify(o.data)});return {statusCode:r.status,data:await r.json()}},navigateTo:async o=>{window.__lastNavigation=o.url}};export default Taro;`,
  );
  await writeFile(
    dir + '/main.tsx',
    `import React from 'react';import{createRoot}from'react-dom/client';import{StaffSessionPanel,Workspace}from'${root}/packages/web-ui/src/index';import Rewards from '${root}/apps/consumer-mini/src/pages/rewards/index';import Detail from '${root}/apps/consumer-mini/src/pages/reward/index';const mini=location.search.includes('mini');const style=document.createElement('link');style.rel='stylesheet';style.href=mini?'/mini.css':'/admin.css';await new Promise((done,fail)=>{style.onload=done;style.onerror=fail;document.head.appendChild(style)});createRoot(document.getElementById('root')).render(<><div style={{padding:8,background:'#fff3cd',fontSize:12}}>隔离验收 · 合成数据 · 仅商品浏览 · 不开放真实兑换</div>{mini?(location.search.includes("id=")?<Detail/>:<Rewards/>):<StaffSessionPanel workspace>{(p,c)=><Workspace profile={p} sessionControl={c}/>}</StaffSessionPanel>}</>);`,
  );
  const config = {
    configFile: false,
    root: dir,
    plugins: [react()],
    resolve: {
      alias: {
        '@tarojs/components': dir + '/components.tsx',
        '@tarojs/taro': dir + '/taro.ts',
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
    const path = `docs/verification/UI-REWARDS-${name}-2026-11-02.png`;
    await p.screenshot({ path, fullPage: !name.startsWith('MINI-') });
    shots.push(path);
    assert.ok(
      await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'overflow: ' + name,
    );
  }
  await page.goto('http://127.0.0.1:5188');
  await page.getByRole('button', { name: '兑换商品', exact: true }).click();
  await page.getByText('暂无匹配兑换商品').waitFor();
  await shot('ADMIN-EMPTY');
  let fail = false;
  await page.route('**/api/v1/admin/rewards?**', (route) =>
    fail
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: '合成商品查询失败' } }),
        })
      : route.continue(),
  );
  fail = true;
  await page.getByRole('button', { name: '查询商品', exact: true }).click();
  await page.getByRole('alert').waitFor();
  await shot('ADMIN-ERROR');
  fail = false;
  await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await page.getByText('暂无匹配兑换商品').waitFor();
  await page.getByRole('button', { name: '新增兑换商品', exact: true }).click();
  await page.getByLabel('搜索商品规格').fill('合成纸巾');
  await page.getByRole('button', { name: '查找规格', exact: true }).click();
  await page.getByRole('button', { name: '合成纸巾 · 单包装 / 包', exact: true }).click();
  await page.getByLabel('兑换标题').fill('日常柔软纸巾');
  await page.getByLabel('积分单价').fill('120');
  await page.getByLabel('每人累计限兑件数').fill('3');
  await page.getByLabel('总兑换配额').fill('20');
  await page.getByLabel('操作原因').fill('合成商品验收');
  await shot('ADMIN-CREATE-DESKTOP');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('ADMIN-CREATE-MOBILE');
  await page.getByRole('button', { name: '保存为草稿', exact: true }).scrollIntoViewIfNeeded();
  await shot('ADMIN-CREATE-ACTIONS-MOBILE');
  await page.getByRole('button', { name: '保存为草稿', exact: true }).click();
  await page.getByRole('button', { name: '查看商品', exact: true }).click();
  await page.getByRole('button', { name: '编辑与上下架', exact: true }).click();
  await page.getByLabel('操作原因').fill('合成上架');
  await page.getByRole('button', { name: '上架商品', exact: true }).click();
  await page.getByRole('button', { name: '查看商品', exact: true }).waitFor();
  const response = await f.api('/admin/rewards');
  const id = response.data.items[0].id;
  assert.equal((await f.api('/rewards/' + id)).data.available, 3);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await shot('ADMIN-LIST-DESKTOP');
  await page.getByRole('button', { name: '查看商品', exact: true }).click();
  await shot('ADMIN-DETAIL');
  await page.getByRole('button', { name: '编辑与上下架', exact: true }).click();
  await page.getByLabel('积分单价').fill('125');
  await page.getByLabel('操作原因').fill('合成未知结果恢复');
  let drop = true;
  await page.route('**/api/v1/admin/rewards/*/update', async (route) => {
    if (drop) {
      drop = false;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await page.getByRole('button', { name: '保存商品规则', exact: true }).click();
  await page.getByRole('button', { name: '使用原请求重试', exact: true }).waitFor();
  await shot('ADMIN-UNKNOWN');
  await page.getByRole('button', { name: '使用原请求重试', exact: true }).click();
  await page.getByRole('button', { name: '查看商品', exact: true }).waitFor();
  assert.equal((await f.runtime.db.rewardProduct.findUniqueOrThrow({ where: { id } })).version, 2);
  const mini = await context.newPage();
  mini.on('pageerror', (e) => errors.push(e.message));
  await mini.setViewportSize({ width: 390, height: 844 });
  await mini.goto('http://127.0.0.1:5188/?mini');
  await mini.getByText('日常柔软纸巾', { exact: true }).waitFor();
  await shot('MINI-LIST', mini);
  await mini.getByRole('button', { name: '查看详情', exact: true }).click();
  assert.equal(await mini.evaluate(() => window.__lastNavigation), '/pages/reward/index?id=' + id);
  await mini.goto('http://127.0.0.1:5188/?mini&id=' + id);
  await mini.getByText('合计 125 积分', { exact: true }).waitFor();
  await shot('MINI-DETAIL', mini);
  await mini.getByRole('button', { name: '＋', exact: true }).click();
  await mini.getByText('合计 250 积分', { exact: true }).waitFor();
  assert.equal(
    await mini.getByRole('button', { name: '兑换下单待开放', exact: true }).isDisabled(),
    true,
  );
  await f.runtime.db.stockBalance.update({
    where: { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.input.skuId } },
    data: { inventoryHold: true },
  });
  await mini.reload();
  await mini.getByText('当前暂时缺货', { exact: true }).waitFor();
  await shot('MINI-OUT-OF-STOCK', mini);
  await mini.goto('http://127.0.0.1:5188/?mini');
  await mini.getByRole('textbox').fill('不存在的合成商品');
  await mini.getByRole('button', { name: '搜索', exact: true }).click();
  await mini.getByText('暂无兑换商品', { exact: true }).waitFor();
  await shot('MINI-EMPTY', mini);
  let miniFail = true;
  await mini.route('**/api/v1/rewards?**', (route) =>
    miniFail
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: '合成商城读取失败' } }),
        })
      : route.continue(),
  );
  await mini.getByRole('textbox').fill('');
  await mini.getByRole('button', { name: '搜索', exact: true }).click();
  await mini.getByText('合成商城读取失败', { exact: true }).waitFor();
  await shot('MINI-ERROR', mini);
  miniFail = false;
  await mini.getByRole('button', { name: '重试读取', exact: true }).click();
  await mini.getByText('日常柔软纸巾', { exact: true }).waitFor();
  await f.api('/admin/rewards/' + id + '/unpublish', { version: 2, reason: '合成下架' });
  await mini.goto('http://127.0.0.1:5188/?mini&id=' + id);
  await mini.getByText('兑换商品暂不可用', { exact: true }).waitFor();
  await shot('MINI-UNAVAILABLE', mini);
  // Over twenty catalogue rows: independent source selection and result pagination.
  const db = f.runtime.db;
  for (let i = 0; i < 23; i++) {
    const sid = randomUUID();
    await db.sku.create({
      data: {
        id: sid,
        productId: f.catalog.productId,
        code: 'UI-REWARD-' + i,
        spec: '分页规格' + String(i).padStart(2, '0'),
        unit: '件',
        priceCents: 1n,
        expiryManaged: false,
      },
    });
    await db.rewardProduct.create({
      data: {
        id: randomUUID(),
        warehouseId: f.warehouseId,
        skuId: sid,
        title: '分页商品' + String(i).padStart(2, '0'),
        pointsPrice: 10n,
        sortOrder: i,
        perUserLimit: 1,
        totalQuota: 1,
        status: 'PUBLISHED',
      },
    });
  }
  await page.reload();
  await page.getByRole('button', { name: '兑换商品', exact: true }).click();
  await page.getByLabel('兑换商品名称').fill('分页商品');
  await page.getByRole('button', { name: '查询商品', exact: true }).click();
  await page.getByRole('button', { name: '加载更多', exact: true }).waitFor();
  assert.equal(await page.locator('.points-table tbody tr').count(), 20);
  await page.getByLabel('兑换商品名称').fill('尚未提交的条件');
  fail = true;
  await page.getByRole('button', { name: '加载更多', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.locator('.points-table tbody tr').count(), 20);
  await shot('ADMIN-PAGE-ERROR');
  fail = false;
  await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await page.getByText('分页商品22', { exact: true }).waitFor();
  assert.equal(await page.locator('.points-table tbody tr').count(), 23);
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('ADMIN-LIST-MOBILE');
  await page.getByRole('button', { name: '新增兑换商品', exact: true }).click();
  await page.getByLabel('搜索商品规格').fill('分页规格');
  await page.getByRole('button', { name: '查找规格', exact: true }).click();
  await page.getByRole('button', { name: '更多规格', exact: true }).click();
  await page.getByRole('button', { name: '更多规格', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.locator('.reward-sku').count(), 23);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await mini.goto('http://127.0.0.1:5188/?mini');
  await mini.getByRole('button', { name: '加载更多', exact: true }).waitFor();
  await mini.getByRole('textbox').fill('尚未提交条件');
  miniFail = true;
  await mini.getByRole('button', { name: '加载更多', exact: true }).click();
  await mini.getByText('合成商城读取失败', { exact: true }).waitFor();
  assert.equal(await mini.locator('.reward-card').count(), 20);
  miniFail = false;
  await mini.getByRole('button', { name: '重试读取', exact: true }).click();
  await mini.getByText('分页商品22', { exact: true }).waitFor();
  assert.equal(await mini.locator('.reward-card').count(), 23);
  await shot('MINI-PAGINATION', mini);
  let release;
  const gate = new Promise((done) => {
    release = done;
  });
  releases.push(() => release());
  await mini.route('**/api/v1/rewards?**', async (route) => {
    await gate;
    await route.continue();
  });
  await mini.getByRole('textbox').fill('');
  await mini.getByRole('button', { name: '搜索', exact: true }).click();
  await mini.getByText('正在读取兑换商品…', { exact: true }).waitFor();
  await shot('MINI-LOADING', mini);
  release();
  await mini.getByText('正在读取兑换商品…', { exact: true }).waitFor({ state: 'hidden' });
  let releaseAdmin;
  const adminGate = new Promise((done) => {
    releaseAdmin = done;
  });
  releases.push(() => releaseAdmin());
  await page.route('**/api/v1/admin/rewards?**', async (route) => {
    await adminGate;
    await route.continue();
  });
  await page.getByLabel('兑换商品名称').fill('');
  await page.getByRole('button', { name: '查询商品', exact: true }).click();
  await page.getByRole('status').waitFor();
  await shot('ADMIN-LOADING');
  releaseAdmin();
  await page.getByRole('status').waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  assert.equal(await f.runtime.db.pointsEntry.count(), 0);
  console.log(JSON.stringify({ passed: true, screenshots: shots }));
} finally {
  for (const release of releases) release();
  if (browser) await browser.close();
  if (server) await server.close();
  await f.cleanup();
}
