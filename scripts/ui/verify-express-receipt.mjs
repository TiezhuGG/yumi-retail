/* global document, innerWidth, window, localStorage */
// Actual React pages + real API + disposable PG schema. Browser mini adapter is not native WeChat.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expressShippingFixture } from '../../tests/helpers/express-shipping-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd().replaceAll('\\', '/'),
  dir = resolve('.local/express-receipt-ui');
const { createServer, build } =
  await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const f = await expressShippingFixture();
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
    `import {useEffect} from 'react';export function useDidShow(fn){useEffect(()=>{fn();window.addEventListener('yumi:show',fn);return()=>window.removeEventListener('yumi:show',fn)},[])}export function useReachBottom(fn){useEffect(()=>{window.addEventListener('yumi:bottom',fn);return()=>window.removeEventListener('yumi:bottom',fn)},[fn])}export function usePullDownRefresh(fn){useEffect(()=>{window.addEventListener('yumi:refresh',fn);return()=>window.removeEventListener('yumi:refresh',fn)},[fn])}export function useRouter(){return {params:Object.fromEntries(new URLSearchParams(location.search))}};export function useDidHide(fn){useEffect(()=>{window.addEventListener('yumi:hide',fn);return()=>window.removeEventListener('yumi:hide',fn)},[])}const Taro={showModal:async o=>{window.__lastModal=o;return{confirm:window.__modalConfirm!==false,cancel:window.__modalConfirm===false}},stopPullDownRefresh:()=>{},getStorageSync:k=>JSON.parse(localStorage.getItem(k)||'null'),setStorageSync:(k,v)=>localStorage.setItem(k,JSON.stringify(v)),removeStorageSync:k=>localStorage.removeItem(k),setClipboardData:async o=>{window.__clipboard=o.data;return{}},request:async o=>{const r=await fetch('/api/v1'+o.url.split('/api/v1')[1],{method:o.method,headers:o.header,body:o.method==='GET'?undefined:JSON.stringify(o.data)});return {statusCode:r.status,data:await r.json()}},showToast:async o=>{window.__toast=o.title},switchTab:async o=>{window.__lastNavigation=o.url},navigateTo:async o=>{window.__lastNavigation=o.url}};export default Taro;`,
  );
  await writeFile(
    dir + '/main.tsx',
    `import React from 'react';import{createRoot}from'react-dom/client';import{StaffSessionPanel,Workspace}from'${root}/packages/web-ui/src/index';import Account from '${root}/apps/consumer-mini/src/pages/account/index';import Login from '${root}/apps/consumer-mini/src/pages/login/index';import Rewards from '${root}/apps/consumer-mini/src/pages/rewards/index';import Detail from '${root}/apps/consumer-mini/src/pages/reward/index';import Checkout from '${root}/apps/consumer-mini/src/pages/points-checkout/index';import Cart from '${root}/apps/consumer-mini/src/pages/points-cart/index';import Orders from '${root}/apps/consumer-mini/src/pages/redemptions/index';import Order from '${root}/apps/consumer-mini/src/pages/redemption/index';import ExpressAddresses from '${root}/apps/consumer-mini/src/pages/express-addresses/index';import Points from '${root}/apps/consumer-mini/src/pages/points/index';const mini=location.search.includes('mini');const style=document.createElement('link');style.rel='stylesheet';style.href=mini?'/mini.css':'/admin.css';await new Promise((done,fail)=>{style.onload=done;style.onerror=fail;document.head.appendChild(style)});createRoot(document.getElementById('root')).render(<React.StrictMode><><div style={{padding:8,background:'#fff3cd',fontSize:12}}>隔离验收 · 合成数据 · 订单收货确认验收 · 非生产操作</div>{mini?(location.search.includes("view=login")?<Login/>:location.search.includes("view=cart")?<Cart/>:location.search.includes("view=account")?<Account/>:location.search.includes("view=express-addresses")?<ExpressAddresses/>:location.search.includes("view=checkout")?<Checkout/>:location.search.includes("view=orders")?<Orders/>:location.search.includes("view=order&")?<Order/>:location.search.includes("view=points")?<Points/>:location.search.includes("id=")?<Detail/>:<Rewards/>):<StaffSessionPanel workspace>{(p,c)=><Workspace profile={p} sessionControl={c} mobile={location.search.includes("ops")}/>}</StaffSessionPanel>}</></React.StrictMode>);`,
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
    const path = `docs/verification/UI-EXPRESS-RECEIPT-${name}-2026-11-05.png`;
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

  await f.createExpress();
  const shipped = await f.createExpress(),
    received = await f.createExpress(),
    canceled = await f.createExpress();
  for (const id of [shipped, received])
    assert.equal(
      (
        await f.api('/admin/redemptions/' + id + '/ship', {
          version: 0,
          carrierCode: 'SF',
          trackingNo: 'SF-RECEIPT-UI-' + id.slice(0, 8),
          dispatchConfirmed: true,
        })
      ).status,
      200,
    );
  assert.equal(
    (await f.call('/consumer/redemptions/' + received + '/confirm-receipt', { received: true }))
      .status,
    200,
  );
  assert.equal(
    (await f.call('/consumer/redemptions/' + canceled + '/cancel', { version: 0 })).status,
    200,
  );
  const session = async (identity) =>
    page.evaluate(
      (v) =>
        localStorage.setItem(
          'yumi.consumer-session.v1:http://127.0.0.1:3000/api/v1',
          JSON.stringify({ token: v.token, expiresAt: v.expiresAt }),
        ),
      identity,
    );
  const list = 'http://127.0.0.1:5188/?mini&view=orders';
  await page.goto(list);
  await session(f.identity);
  await page.reload();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByText('已经到底了', { exact: true }).waitFor();
  assert.equal(await page.locator('.redemption-list-card').count(), 4);
  await shot('MINI-ALL');
  await page.getByRole('button', { name: '待发货', exact: true }).click();
  await page.getByText('已经到底了', { exact: true }).waitFor();
  assert.equal(await page.locator('.redemption-list-card').count(), 1);
  await shot('MINI-WAIT-SHIP');
  await f.createExpress();
  await page.evaluate(() => window.dispatchEvent(new window.Event('yumi:refresh')));
  await page.waitForFunction(() => document.querySelectorAll('.redemption-list-card').length === 2);
  await shot('MINI-PULL-REFRESH');
  await page.getByRole('button', { name: '待收货', exact: true }).click();
  await page.getByText('待收货 · 顺丰速运', { exact: true }).waitFor();
  assert.equal(await page.locator('.redemption-list-card').count(), 1);
  await shot('MINI-WAIT-RECEIPT');
  await page.getByRole('button', { name: '已完成', exact: true }).click();
  await page.getByText('已完成 · 已确认收货', { exact: true }).waitFor();
  assert.equal(await page.locator('.redemption-list-card').count(), 1);
  await shot('MINI-COMPLETED');
  await page.getByRole('button', { name: '已取消', exact: true }).click();
  await page.getByText('已取消 · 积分已退还', { exact: true }).waitFor();
  await shot('MINI-CANCELED');
  await page.goto('http://127.0.0.1:5188/?mini&view=order&id=' + shipped);
  await page.getByRole('button', { name: '确认收货', exact: true }).waitFor();
  await shot('MINI-RECEIPT-ACTION');
  await page.evaluate(() => {
    window.__modalConfirm = false;
  });
  await page.getByRole('button', { name: '确认收货', exact: true }).click();
  await page.waitForFunction(() => window.__lastModal?.title === '确认已收到全部商品？');
  assert.equal(await f.runtime.db.redemptionExpressReceipt.count(), 1);
  await page.evaluate(() => {
    window.__modalConfirm = true;
  });
  let lost = false;
  await page.route('**/confirm-receipt', async (route) => {
    if (lost) {
      await route.continue();
      return;
    }
    lost = true;
    assert.equal((await route.fetch()).status(), 200);
    await route.abort('failed');
  });
  await page.getByRole('button', { name: '确认收货', exact: true }).click();
  await page.getByText(/请重新读取或核实原收货请求/).waitFor();
  await page.getByRole('button', { name: '核实收货结果', exact: true }).waitFor();
  await shot('MINI-RECEIPT-UNKNOWN');
  await page.getByRole('button', { name: '核实收货结果', exact: true }).click();
  await page.getByText('已完成 · 已确认收货', { exact: true }).waitFor();
  await page.getByText('申请售后', { exact: true }).waitFor();
  assert.equal(await f.runtime.db.redemptionExpressReceipt.count(), 2);
  await shot('MINI-RECEIPT-CONFIRMED');
  await page.reload();
  await page.getByText('已完成 · 已确认收货', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '确认收货', exact: true }).count(), 0);
  await page.goto(list + '&service=after-sales');
  await page.getByText('兑换售后', { exact: true }).waitFor();
  await page.getByText('已经到底了', { exact: true }).waitFor();
  assert.equal(await page.locator('.redemption-list-card').count(), 2);
  await shot('MINI-AFTER-SALES-RECEIVED');
  await page.goto('http://127.0.0.1:5188/?mini&view=account');
  await page.getByText('我的订单', { exact: true }).waitFor();
  await shot('MINI-ACCOUNT');
  await page.getByRole('button', { name: '已完成', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__lastNavigation), '/pages/redemptions/index');
  await page.goto(list);
  await session(f.identityB);
  await page.reload();
  await page.getByText('暂无订单', { exact: true }).waitFor();
  await shot('MINI-ACCOUNT-B-EMPTY');
  await page.goto('http://127.0.0.1:5188/?mini&view=order&id=' + shipped);
  await page.getByText('未找到可访问的兑换单', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '确认收货', exact: true }).count(), 0);
  await shot('MINI-ACCOUNT-B-DENIED');
  await session(f.identity);
  await page.goto(list);
  await page.route('**/consumer/redemptions?fulfillment=EXPRESS_RECEIVED', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'UI_TEST', message: '合成订单读取失败' } }),
    }),
  );
  await page.getByRole('button', { name: '已完成', exact: true }).click();
  await page.getByText('合成订单读取失败', { exact: true }).waitFor();
  assert.equal(await page.locator('.redemption-list-card').count(), 0);
  await shot('MINI-FILTER-ERROR');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('http://127.0.0.1:5188/');
  await page.getByRole('button', { name: '积分兑换订单', exact: true }).click();
  await page.getByRole('button', { name: '已完成', exact: true }).click();
  await page.getByRole('cell', { name: '已完成 · 用户确认收货', exact: true }).first().waitFor();
  assert.equal(
    await page.getByRole('cell', { name: '已完成 · 用户确认收货', exact: true }).count(),
    2,
  );
  await shot('ADMIN-COMPLETED');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ passed: true, screenshots: shots, receiptCount: 2, realDevice: false }),
  );
} finally {
  await browser?.close();
  await server?.close();
  await f.cleanup();
}
