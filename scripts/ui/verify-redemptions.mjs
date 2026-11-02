/* global document, innerWidth, window, localStorage, Event */
// Actual React pages + real API + disposable PG schema. Browser mini adapter is not native WeChat.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  redemptionFixture,
  seedCancelledRedemptions,
} from '../../tests/helpers/redemption-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd().replaceAll('\\', '/'),
  dir = resolve('.local/redemptions-ui');
const { createServer, build } =
  await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const f = await redemptionFixture();
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
      '\nbody{margin:0;font-family:Arial,Microsoft YaHei,sans-serif;}button{display:block;box-sizing:border-box;font-family:inherit;}select{box-sizing:border-box;width:100%;min-height:44px;border:1px solid #dce6de;border-radius:8px;padding:10px;color:#345544;background:white;}',
  );
  await writeFile(
    dir + '/index.html',
    '<html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  );
  await writeFile(
    dir + '/components.tsx',
    `import React from 'react';export const View=({children,...p})=><div {...p}>{children}</div>;export const Text=({children,...p})=><span {...p}>{children}</span>;export const Button=({children,...p})=><button {...p}>{children}</button>;export const Input=({onInput,onConfirm,maxlength,...p})=><input {...p} maxLength={maxlength} onChange={e=>onInput?.({detail:{value:e.target.value}})} onKeyDown={e=>{if(e.key==='Enter')onConfirm?.()}}/>;export const Picker=({range,onChange,value,disabled})=><select aria-label="收货地址" disabled={disabled} value={value} onChange={e=>onChange({detail:{value:e.target.value}})}>{range.map((v,i)=><option key={i} value={i}>{v}</option>)}</select>;export const Image=({src,mode,...p})=><img src={src} {...p}/>;`,
  );
  await writeFile(
    dir + '/taro.ts',
    `import {useEffect} from 'react';export function useDidShow(fn){useEffect(()=>{fn();window.addEventListener('yumi:show',fn);return()=>window.removeEventListener('yumi:show',fn)},[])}export function useRouter(){return {params:Object.fromEntries(new URLSearchParams(location.search))}};export function useDidHide(fn){useEffect(()=>{window.addEventListener('yumi:hide',fn);return()=>window.removeEventListener('yumi:hide',fn)},[])}const Taro={getStorageSync:k=>JSON.parse(localStorage.getItem(k)||'null'),setStorageSync:(k,v)=>localStorage.setItem(k,JSON.stringify(v)),removeStorageSync:k=>localStorage.removeItem(k),request:async o=>{const r=await fetch('/api/v1'+o.url.split('/api/v1')[1],{method:o.method,headers:o.header,body:o.method==='GET'?undefined:JSON.stringify(o.data)});return {statusCode:r.status,data:await r.json()}},navigateTo:async o=>{window.__lastNavigation=o.url}};export default Taro;`,
  );
  await writeFile(
    dir + '/main.tsx',
    `import React from 'react';import{createRoot}from'react-dom/client';import{StaffSessionPanel,Workspace}from'${root}/packages/web-ui/src/index';import Rewards from '${root}/apps/consumer-mini/src/pages/rewards/index';import Detail from '${root}/apps/consumer-mini/src/pages/reward/index';import Checkout from '${root}/apps/consumer-mini/src/pages/redemption-checkout/index';import Orders from '${root}/apps/consumer-mini/src/pages/redemptions/index';import Order from '${root}/apps/consumer-mini/src/pages/redemption/index';import Points from '${root}/apps/consumer-mini/src/pages/points/index';const mini=location.search.includes('mini');const style=document.createElement('link');style.rel='stylesheet';style.href=mini?'/mini.css':'/admin.css';await new Promise((done,fail)=>{style.onload=done;style.onerror=fail;document.head.appendChild(style)});createRoot(document.getElementById('root')).render(<><div style={{padding:8,background:'#fff3cd',fontSize:12}}>隔离验收 · 合成数据 · 隔离开发兑换 · 真实仓配未开放</div>{mini?(location.search.includes("view=checkout")?<Checkout/>:location.search.includes("view=orders")?<Orders/>:location.search.includes("view=order&")?<Order/>:location.search.includes("view=points")?<Points/>:location.search.includes("id=")?<Detail/>:<Rewards/>):<StaffSessionPanel workspace>{(p,c)=><Workspace profile={p} sessionControl={c}/>}</StaffSessionPanel>}</>);`,
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
    const path = `docs/verification/UI-REDEMPTIONS-${name}-2026-11-02.png`;
    await p.screenshot({ path, fullPage: !name.startsWith('MINI-') });
    shots.push(path);
    assert.ok(
      await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'overflow: ' + name,
    );
  }
  const sessionKey = 'yumi.consumer-session.v1:http://127.0.0.1:3000/api/v1';
  await page.goto('http://127.0.0.1:5188');
  await page.getByRole('button', { name: '积分兑换订单', exact: true }).click();
  await page.getByText('暂无匹配兑换订单', { exact: true }).waitFor();
  await shot('ADMIN-EMPTY');
  const mini = await context.newPage();
  mini.on('pageerror', (e) => errors.push(e.message));
  await mini.setViewportSize({ width: 390, height: 844 });
  await mini.addInitScript(
    ({ sessionKey, identity }) =>
      localStorage.setItem(
        sessionKey,
        JSON.stringify({ token: identity.token, expiresAt: identity.expiresAt }),
      ),
    { sessionKey, identity: f.identity },
  );
  const checkout = 'http://127.0.0.1:5188/?mini&view=checkout&id=' + f.rewardId + '&quantity=1';
  await mini.goto(checkout);
  await mini.getByRole('button', { name: '核验并生成兑换报价', exact: true }).waitFor();
  await shot('MINI-CHECKOUT', mini);
  await mini.getByRole('button', { name: '核验并生成兑换报价', exact: true }).click();
  await mini.getByRole('button', { name: '确认扣除 120 积分兑换', exact: true }).waitFor();
  await shot('MINI-QUOTE', mini);
  let dropCreate = true;
  await mini.route('**/api/v1/consumer/redemptions', async (route) => {
    if (route.request().method() === 'POST' && dropCreate) {
      dropCreate = false;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await mini.getByRole('button', { name: '确认扣除 120 积分兑换', exact: true }).click();
  await mini.getByRole('button', { name: '核实原兑换操作', exact: true }).waitFor();
  await mini.locator('.account-error').waitFor();
  await shot('MINI-CREATE-UNKNOWN', mini);
  assert.equal(await f.runtime.db.redemptionOrder.count(), 1);
  // The original intent survives a full page reload, with the same quote/key/owner.
  await mini.reload();
  await mini.getByRole('button', { name: '核实原兑换操作', exact: true }).waitFor();
  await mini.getByRole('button', { name: '核实原兑换操作', exact: true }).click();
  await mini.waitForFunction(() =>
    window.__lastNavigation?.startsWith('/pages/redemption/index?id='),
  );
  const id = (await f.runtime.db.redemptionOrder.findFirstOrThrow()).id;
  assert.equal(
    await f.runtime.db.pointsEntry.count({
      where: { redemptionId: id, redemptionAction: 'REDEEM' },
    }),
    1,
  );
  await mini.goto('http://127.0.0.1:5188/?mini&view=order&id=' + id);
  await mini
    .getByText('已扣积分并预占库存；履约待办已保存，真实仓配尚未接入。', { exact: true })
    .waitFor();
  await shot('MINI-ORDER-ACTIVE', mini);
  let dropCancel = true;
  await mini.route('**/api/v1/consumer/redemptions/*/cancel', async (route) => {
    if (dropCancel) {
      dropCancel = false;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await mini.getByRole('button', { name: '取消兑换并退还 120 积分', exact: true }).click();
  await mini.getByText(/请刷新核实，或使用原请求重试取消/).waitFor();
  await shot('MINI-CANCEL-UNKNOWN', mini);
  await mini.getByRole('button', { name: '取消兑换并退还 120 积分', exact: true }).click();
  await mini.getByText('积分已退还，库存和限兑配额已释放。', { exact: true }).waitFor();
  await shot('MINI-ORDER-CANCELED', mini);
  assert.equal(await f.runtime.db.pointsEntry.count({ where: { redemptionId: id } }), 2);
  assert.equal(
    (await f.runtime.db.pointsAccount.findUniqueOrThrow({ where: { userId: f.identity.user.id } }))
      .balance,
    1000n,
  );
  await mini.goto('http://127.0.0.1:5188/?mini&view=orders');
  await mini.getByText('已取消 · 积分已退还', { exact: true }).waitFor();
  await shot('MINI-ORDERS', mini);
  await mini.goto('http://127.0.0.1:5188/?mini&view=points');
  await mini.getByText('兑换取消退还积分', { exact: true }).waitFor();
  await shot('MINI-POINTS', mini);
  await page.getByRole('button', { name: '查询兑换单', exact: true }).click();
  await page.getByRole('button', { name: '查看兑换凭据', exact: true }).click();
  await page.getByText('取消并退还积分', { exact: false }).waitFor();
  await shot('ADMIN-DETAIL-DESKTOP');
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('ADMIN-DETAIL-MOBILE');
  // Stale quotes cannot silently debit a newly raised price.
  await mini.goto(checkout);
  await mini.getByRole('button', { name: '核验并生成兑换报价', exact: true }).click();
  await mini.getByRole('button', { name: '确认扣除 120 积分兑换', exact: true }).waitFor();
  await f.runtime.db.rewardProduct.update({
    where: { id: f.rewardId },
    data: { pointsPrice: 125n, version: { increment: 1 } },
  });
  await mini.getByRole('button', { name: '确认扣除 120 积分兑换', exact: true }).click();
  await mini.getByRole('button', { name: '已确认未创建，重新核验', exact: true }).waitFor();
  await shot('MINI-QUOTE-CHANGED', mini);
  await mini.getByRole('button', { name: '已确认未创建，重新核验', exact: true }).click();
  await mini.getByRole('button', { name: '重新读取商品与地址', exact: true }).click();
  await mini.getByRole('button', { name: '核验并生成兑换报价', exact: true }).click();
  await mini.getByRole('button', { name: '确认扣除 125 积分兑换', exact: true }).waitFor();
  await f.runtime.db.rewardProduct.update({
    where: { id: f.rewardId },
    data: { pointsPrice: 10000n, version: { increment: 1 } },
  });
  await mini.getByRole('button', { name: '重新读取商品与地址', exact: true }).click();
  await mini.getByRole('button', { name: '核验并生成兑换报价', exact: true }).click();
  await mini.getByText('积分不足，还差9000积分', { exact: true }).waitFor();
  await shot('MINI-INSUFFICIENT', mini);
  assert.equal(await f.runtime.db.redemptionOrder.count(), 1);
  await seedCancelledRedemptions(f);
  await mini.goto('http://127.0.0.1:5188/?mini&view=orders');
  await mini.getByRole('button', { name: '加载更多', exact: true }).waitFor();
  assert.equal(await mini.getByRole('button', { name: '查看兑换单', exact: true }).count(), 20);
  let pageFail = true;
  await mini.route('**/api/v1/consumer/redemptions?cursor=*', (route) =>
    pageFail
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: '合成兑换续页失败' } }),
        })
      : route.continue(),
  );
  await mini.getByRole('button', { name: '加载更多', exact: true }).click();
  await mini.getByText('合成兑换续页失败', { exact: true }).waitFor();
  assert.equal(await mini.getByRole('button', { name: '查看兑换单', exact: true }).count(), 20);
  await shot('MINI-PAGE-ERROR', mini);
  pageFail = false;
  await mini.getByRole('button', { name: '重试读取', exact: true }).click();
  await mini.getByRole('button', { name: '加载更多', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await mini.getByRole('button', { name: '查看兑换单', exact: true }).count(), 24);
  await shot('MINI-PAGINATION', mini);
  let fail = true;
  await page.getByRole('button', { name: '返回兑换订单列表', exact: true }).click();
  await page.route('**/api/v1/admin/redemptions?**', (route) =>
    fail
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: '合成兑换订单读取失败' } }),
        })
      : route.continue(),
  );
  await page.getByRole('button', { name: '查询兑换单', exact: true }).click();
  await page.getByRole('alert').waitFor();
  await shot('ADMIN-ERROR');
  fail = false;
  await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await page.getByRole('button', { name: '查看兑换凭据', exact: true }).first().waitFor();
  await page.getByRole('button', { name: '加载更多', exact: true }).waitFor();
  await page.getByRole('button', { name: '加载更多', exact: true }).click();
  await page.getByRole('button', { name: '加载更多', exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: '查看兑换凭据', exact: true }).count(), 24);
  await shot('ADMIN-PAGINATION');
  await mini.goto('http://127.0.0.1:5188/?mini&view=orders');
  await mini.evaluate(() => localStorage.clear());
  await mini.evaluate(() => window.dispatchEvent(new Event('yumi:hide')));
  await mini.evaluate(() => window.dispatchEvent(new Event('yumi:show')));
  await mini.getByRole('button', { name: '登录后查看', exact: true }).waitFor();
  await shot('MINI-GUEST', mini);
  assert.equal(await mini.locator('.account-card').count(), 0);
  await mini.evaluate(
    ({ sessionKey, identity }) =>
      localStorage.setItem(
        sessionKey,
        JSON.stringify({ token: identity.token, expiresAt: identity.expiresAt }),
      ),
    { sessionKey, identity: f.identity },
  );
  let release;
  const gate = new Promise((done) => {
    release = done;
  });
  releases.push(() => release());
  await mini.route('**/api/v1/consumer/redemptions', async (route) => {
    await gate;
    await route.continue();
  });
  await mini.goto('http://127.0.0.1:5188/?mini&view=orders');
  await mini.getByText('正在读取兑换单…', { exact: true }).waitFor();
  await shot('MINI-LOADING', mini);
  release();
  await mini.getByText('正在读取兑换单…', { exact: true }).waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, screenshots: shots }));
} finally {
  for (const release of releases) release();
  if (browser) await browser.close();
  if (server) await server.close();
  await f.cleanup();
}
