/* global document, innerWidth, window, localStorage */
// Actual React pages + real API + disposable PG schema. Browser mini adapter is not native WeChat.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pointsCartFixture } from '../../tests/helpers/points-cart-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd().replaceAll('\\', '/'),
  dir = resolve('.local/points-cart-ui');
const { createServer, build } =
  await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const f = await pointsCartFixture();
let server, browser;
const shots = [];

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
    `import React from 'react';export const ScrollView=({scrollX,children,...p})=><div style={{overflowX:scrollX?'auto':undefined}} {...p}>{children}</div>;export const View=({children,...p})=><div {...p}>{children}</div>;export const Text=({children,...p})=><span {...p}>{children}</span>;export const Button=({children,...p})=><button {...p}>{children}</button>;export const Input=({onInput,onConfirm,maxlength,...p})=><input {...p} maxLength={maxlength} onChange={e=>onInput?.({detail:{value:e.target.value}})} onKeyDown={e=>{if(e.key==='Enter')onConfirm?.()}}/>;export const Picker=({range,onChange,value,disabled})=><select aria-label="收货地址" disabled={disabled} value={value} onChange={e=>onChange({detail:{value:e.target.value}})}>{range.map((v,i)=><option key={i} value={i}>{v}</option>)}</select>;export const Textarea=({onInput,maxlength,...p})=><textarea {...p} maxLength={maxlength} onChange={e=>onInput?.({detail:{value:e.target.value}})}/>;export const Switch=({onChange,checked,disabled})=><input role="switch" type="checkbox" checked={checked} disabled={disabled} onChange={e=>onChange?.({detail:{value:e.target.checked}})}/>;export const Image=({src,mode,...p})=><img src={src} {...p}/>;`,
  );
  await writeFile(
    dir + '/taro.ts',
    `import {useEffect} from 'react';export function useDidShow(fn){useEffect(()=>{fn();window.addEventListener('yumi:show',fn);return()=>window.removeEventListener('yumi:show',fn)},[])}export function useReachBottom(fn){useEffect(()=>{window.addEventListener('yumi:bottom',fn);return()=>window.removeEventListener('yumi:bottom',fn)},[fn])}export function usePullDownRefresh(fn){useEffect(()=>{window.addEventListener('yumi:refresh',fn);return()=>window.removeEventListener('yumi:refresh',fn)},[fn])}export function useRouter(){return {params:Object.fromEntries(new URLSearchParams(location.search))}};export function useDidHide(fn){useEffect(()=>{window.addEventListener('yumi:hide',fn);return()=>window.removeEventListener('yumi:hide',fn)},[])}const Taro={stopPullDownRefresh:()=>{},getStorageSync:k=>JSON.parse(localStorage.getItem(k)||'null'),setStorageSync:(k,v)=>localStorage.setItem(k,JSON.stringify(v)),removeStorageSync:k=>localStorage.removeItem(k),setClipboardData:async o=>{window.__clipboard=o.data;return{}},request:async o=>{const r=await fetch('/api/v1'+o.url.split('/api/v1')[1],{method:o.method,headers:o.header,body:o.method==='GET'?undefined:JSON.stringify(o.data)});return {statusCode:r.status,data:await r.json()}},showToast:async o=>{window.__toast=o.title},switchTab:async o=>{window.__lastNavigation=o.url},navigateTo:async o=>{window.__lastNavigation=o.url}};export default Taro;`,
  );
  await writeFile(
    dir + '/main.tsx',
    `import React from 'react';import{createRoot}from'react-dom/client';import{StaffSessionPanel,Workspace}from'${root}/packages/web-ui/src/index';import Account from '${root}/apps/consumer-mini/src/pages/account/index';import Login from '${root}/apps/consumer-mini/src/pages/login/index';import Rewards from '${root}/apps/consumer-mini/src/pages/rewards/index';import Detail from '${root}/apps/consumer-mini/src/pages/reward/index';import Checkout from '${root}/apps/consumer-mini/src/pages/points-checkout/index';import Cart from '${root}/apps/consumer-mini/src/pages/points-cart/index';import Orders from '${root}/apps/consumer-mini/src/pages/redemptions/index';import Order from '${root}/apps/consumer-mini/src/pages/redemption/index';import ExpressAddresses from '${root}/apps/consumer-mini/src/pages/express-addresses/index';import Points from '${root}/apps/consumer-mini/src/pages/points/index';const mini=location.search.includes('mini');const style=document.createElement('link');style.rel='stylesheet';style.href=mini?'/mini.css':'/admin.css';await new Promise((done,fail)=>{style.onload=done;style.onerror=fail;document.head.appendChild(style)});createRoot(document.getElementById('root')).render(<React.StrictMode><><div style={{padding:8,background:'#fff3cd',fontSize:12}}>隔离验收 · 合成数据 · 购物车整次兑换验收 · 非生产操作</div>{mini?(location.search.includes("view=login")?<Login/>:location.search.includes("view=cart")?<Cart/>:location.search.includes("view=account")?<Account/>:location.search.includes("view=express-addresses")?<ExpressAddresses/>:location.search.includes("view=checkout")?<Checkout/>:location.search.includes("view=orders")?<Orders/>:location.search.includes("view=order&")?<Order/>:location.search.includes("view=points")?<Points/>:location.search.includes("id=")?<Detail/>:<Rewards/>):<StaffSessionPanel workspace>{(p,c)=><Workspace profile={p} sessionControl={c} mobile={location.search.includes("ops")}/>}</StaffSessionPanel>}</></React.StrictMode>);`,
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
    const path = `docs/verification/UI-POINTS-CART-${name}-2026-11-05.png`;
    if (!name.startsWith('MINI-') && !name.endsWith('MOBILE'))
      await p.evaluate(() => {
        window.scrollTo(0, 0);
      });
    await p.evaluate(
      () =>
        new Promise((done) =>
          window.requestAnimationFrame(() => window.requestAnimationFrame(done)),
        ),
    );
    await p.screenshot({ path, fullPage: !name.startsWith('MINI-') && !name.endsWith('MOBILE') });
    shots.push(path);
    assert.ok(
      await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'overflow: ' + name,
    );
  }

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:5188/?mini&view=cart');
  await page.getByText('购物车还是空的', { exact: true }).waitFor();
  await shot('MINI-EMPTY');
  await page.evaluate(
    (v) =>
      localStorage.setItem(
        'yumi.consumer-session.v1:http://127.0.0.1:3000/api/v1',
        JSON.stringify({ token: v.token, expiresAt: v.expiresAt }),
      ),
    f.identity,
  );
  for (const id of [f.rewardId, f.secondRewardId]) {
    await page.goto('http://127.0.0.1:5188/?mini&id=' + id);
    await page.getByRole('button', { name: '加入购物车', exact: true }).click();
    await page.waitForFunction(() => window.__toast === '已加入购物车');
  }
  assert.equal(await page.getByText(/每人累计限兑|总配额|兑换数量与限额/).count(), 0);
  await shot('MINI-DETAIL');
  await page.goto('http://127.0.0.1:5188/?mini&view=cart');
  await page.getByRole('button', { name: '去兑换', exact: true }).waitFor();
  await page.getByRole('button', { name: '＋', exact: true }).nth(1).click();
  await page.getByText('合计 520 积分', { exact: true }).waitFor();
  assert.equal(
    await page.getByText('购物车保存在本机，加入时不锁定库存或积分。', { exact: true }).count(),
    0,
  );
  await shot('MINI-CART');
  await page.getByRole('button', { name: '去兑换', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__lastNavigation), '/pages/points-checkout/index');
  await page.goto('http://127.0.0.1:5188/?mini&view=checkout');
  await page.getByText('商品清单 · 2 种', { exact: true }).waitFor();
  await shot('MINI-CHECKOUT');
  await page.getByRole('button', { name: '核验积分与库存', exact: true }).click();
  await page.getByText('合计 520 积分', { exact: true }).waitFor();
  await shot('MINI-QUOTE');
  let lost = false,
    finishDrop;
  const dropped = new Promise((done) => {
    finishDrop = done;
  });
  await page.route('**/api/v1/consumer/redemption-cart-orders', async (route) => {
    if (lost) {
      await route.continue();
      return;
    }
    lost = true;
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    await page.evaluate(() => {
      window.dispatchEvent(new window.Event('yumi:hide'));
      window.dispatchEvent(new window.Event('yumi:show'));
    });
    await route.abort('failed');
    finishDrop();
  });
  await page.getByRole('button', { name: '确认兑换', exact: true }).click();
  await dropped;
  await page.getByRole('button', { name: '使用原请求核实兑换', exact: true }).waitFor();
  await shot('MINI-UNKNOWN');
  assert.equal(await f.runtime.db.redemptionOrder.count(), 2);
  await page.reload();
  await page.getByRole('button', { name: '使用原请求核实兑换', exact: true }).click();
  await page.getByText('兑换成功', { exact: true }).waitFor();
  await shot('MINI-SUCCESS');
  assert.equal(await f.runtime.db.redemptionOrder.count(), 2);
  assert.equal((await f.call('/consumer/points')).data.balance, '480');
  await page.reload();
  await page.getByText('兑换成功', { exact: true }).waitFor();
  await page.goto('http://127.0.0.1:5188/?mini&view=cart');
  await page.getByText('购物车还是空的', { exact: true }).waitFor();
  await shot('MINI-CART-AFTER');
  await page.goto('http://127.0.0.1:5188/?mini&view=orders');
  await page.getByText('合成第二款商品 × 2', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '刷新订单', exact: true }).count(), 0);
  assert.equal(await page.getByText('玉米百货 · 积分商城', { exact: true }).count(), 0);
  await shot('MINI-ORDERS');
  // A new direct purchase must start a new intent after a completed cart checkout.
  await page.goto('http://127.0.0.1:5188/?mini&id=' + f.secondRewardId);
  await page.getByRole('button', { name: '加入购物车', exact: true }).click();
  await page.waitForFunction(() => window.__toast === '已加入购物车');
  await page.goto('http://127.0.0.1:5188/?mini&id=' + f.rewardId);
  await page.getByRole('button', { name: '立即兑换', exact: true }).click();
  await page.goto('http://127.0.0.1:5188/?mini&view=checkout&id=' + f.rewardId + '&quantity=1');
  await page.getByRole('button', { name: '核验积分与库存', exact: true }).click();
  await page.getByRole('button', { name: '确认兑换', exact: true }).click();
  await page.getByText('兑换成功', { exact: true }).waitFor();
  assert.equal(await f.runtime.db.redemptionOrder.count(), 3);
  assert.equal((await f.call('/consumer/points')).data.balance, '360');
  await shot('MINI-DIRECT-SECOND');
  await page.goto('http://127.0.0.1:5188/?mini&view=cart');
  await page.getByText('合成第二款商品', { exact: true }).waitFor();
  await page.getByText('合计 200 积分', { exact: true }).waitFor();
  await shot('MINI-DIRECT-PRESERVES-CART');
  await page.evaluate(
    (v) =>
      localStorage.setItem(
        'yumi.consumer-session.v1:http://127.0.0.1:3000/api/v1',
        JSON.stringify({ token: v.token, expiresAt: v.expiresAt }),
      ),
    f.identityB,
  );
  await page.reload();
  await page.getByText('购物车还是空的', { exact: true }).waitFor();
  await shot('MINI-ACCOUNT-ISOLATION');
  await page.goto('http://127.0.0.1:5188/?mini&view=account');
  await page.getByText('我的订单', { exact: true }).waitFor();
  assert.equal(await page.getByText('积分兑换好物，订单随时查看', { exact: true }).count(), 0);
  assert.equal(await page.getByRole('button', { name: '账号设置', exact: true }).count(), 0);
  await page.getByText('隐私保护指引', { exact: true }).waitFor();
  await shot('MINI-ACCOUNT-SIMPLE');
  await page.goto('http://127.0.0.1:5188/?mini');
  await page.getByRole('button', { name: '查看详情：日常柔软纸巾', exact: true }).waitFor();
  assert.equal(await page.getByText(/每人限兑|总配额/).count(), 0);
  await shot('MINI-MALL-SIMPLE');
  await page.evaluate(() =>
    localStorage.removeItem('yumi.consumer-session.v1:http://127.0.0.1:3000/api/v1'),
  );
  await page.goto('http://127.0.0.1:5188/?mini&view=account');
  await page.getByRole('button', { name: '微信登录', exact: true }).waitFor();
  await shot('MINI-ACCOUNT-GUEST-SIMPLE');
  await page.goto('http://127.0.0.1:5188/?mini&view=login');
  await page.getByRole('button', { name: '微信登录暂未开放', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: /使用开发顾客/ }).count(), 0);
  assert.equal(
    await page.getByText('登录后可查看积分、兑换商品和查询订单。', { exact: true }).count(),
    0,
  );
  await shot('MINI-LOGIN-SIMPLE');
  // Actual backend order workbench must show both independently fulfillable children.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://127.0.0.1:5188/');
  await page.getByRole('button', { name: '积分兑换订单', exact: true }).click();
  await page
    .getByRole('cell', { name: /合成第二款商品/ })
    .first()
    .waitFor();
  await shot('ADMIN-ORDERS');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      screenshots: shots,
      orders: 3,
      cartPoints: '520',
      directPoints: '120',
      totalPoints: '640',
      remaining: '360',
    }),
  );
} catch (e) {
  if (browser) {
    const pages = browser.contexts().flatMap((c) => c.pages());
    if (pages[0]) {
      await pages[0].screenshot({ path: 'docs/verification/UI-POINTS-CART-FAILURE.png' });
      console.error((await pages[0].locator('body').innerText()).slice(-2500));
    }
  }
  throw e;
} finally {
  await browser?.close();
  await server?.close();
  await f.cleanup();
}
