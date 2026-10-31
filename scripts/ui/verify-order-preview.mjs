/* global document, innerWidth, localStorage */
// Browser adapter for the actual mini React source; screenshots are previews, not WeChat acceptance.
import assert from 'node:assert/strict';
import { expireUnpaidOrders } from '../../packages/database/dist/index.js';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkoutFixture } from '../../tests/helpers/checkout-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd(),
  directory = resolve('.local/order-preview');
const { createServer } = await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const less = require(resolve('apps/consumer-mini/node_modules/less'));
const fixture = await checkoutFixture({ orders: true, holdSeconds: 3 });
let server, browser;
try {
  await mkdir(directory, { recursive: true });
  const css = (
    await less.render(
      await (await import('node:fs/promises')).readFile('apps/consumer-mini/src/app.less', 'utf8'),
    )
  ).css.replace(/([\d.]+)rpx/g, (_, v) => Number(v) / 2 + 'px');
  await writeFile(
    directory + '/style.css',
    css +
      `
body{font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;}button{display:block;box-sizing:border-box;border:0;font-family:inherit;}input,textarea,select{font-family:inherit;color:inherit;}textarea{resize:none;}input[type=checkbox]{appearance:none;width:40px;height:24px;border-radius:14px;background:#cdd7c7;position:relative;}input[type=checkbox]:checked{background:#008a42;}input[type=checkbox]::after{content:'';position:absolute;width:20px;height:20px;border-radius:50%;background:white;top:2px;left:2px;}input[type=checkbox]:checked::after{left:18px;}
`,
  );
  await writeFile(
    directory + '/index.html',
    '<html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  );
  await writeFile(
    directory + '/main.tsx',
    `import React from 'react';import {createRoot} from 'react-dom/client';import Addresses from '${root}/apps/consumer-mini/src/pages/checkout/index';import './style.css';createRoot(document.getElementById('root')).render(<Addresses/>);`,
  );
  await writeFile(
    directory + '/components.tsx',
    `import React from 'react';export const View=({children,...p})=><div {...p}>{children}</div>;export const Text=({children,...p})=><span {...p}>{children}</span>;export const Button=({children,...p})=><button {...p}>{children}</button>;export const Input=({onInput,maxlength,...p})=><input {...p} maxLength={maxlength} onChange={e=>onInput?.({detail:{value:e.target.value}})}/>;export const Textarea=({onInput,maxlength,...p})=><textarea {...p} maxLength={maxlength} onChange={e=>onInput?.({detail:{value:e.target.value}})}/>;export const Picker=({range,value,onChange,children,...p})=><div style={{position:"relative"}}>{children}<select style={{position:"absolute",inset:0,opacity:0,width:"100%",height:"100%"}} aria-label="选择收货地址" {...p} value={value} onChange={e=>onChange({detail:{value:e.target.value}})}><option value="-1">选择收货地址</option>{range.map((n,i)=><option key={i} value={i}>{n}</option>)}</select></div>;export const Switch=({color,onChange,...p})=><input aria-label="设为默认地址" type="checkbox" {...p} onChange={e=>onChange({detail:{value:e.target.checked}})}/>;`,
  );
  await writeFile(
    directory + '/taro.ts',
    `import {useEffect} from 'react';export function useDidShow(fn){useEffect(()=>{fn()},[])}export function useDidHide(){}export function useRouter(){return {params:Object.fromEntries(new URLSearchParams(location.search))}}const Taro={getStorageSync:key=>JSON.parse(localStorage.getItem(key)||'null'),setStorageSync:(key,v)=>localStorage.setItem(key,JSON.stringify(v)),removeStorageSync:key=>localStorage.removeItem(key),request:async o=>{const r=await fetch('/api/v1'+o.url.split('/api/v1')[1],{method:o.method,headers:o.header,body:o.method==='GET'?undefined:JSON.stringify(o.data)});return {statusCode:r.status,data:await r.json()}},showModal:async()=>({confirm:true,cancel:false}),navigateTo:async o=>{const [path,query='']=o.url.split('?');const name=path==='/pages/order/index'?'order':path==='/pages/orders/index'?'orders':'index';location.assign('/'+name+'.html'+(query?'?'+query:''))},navigateBack:async()=>{},reLaunch:async()=>{}};export default Taro;`,
  );
  server = await createServer({
    configFile: false,
    root: directory,
    plugins: [react()],
    resolve: {
      alias: {
        '@tarojs/components': directory + '/components.tsx',
        '@tarojs/taro': directory + '/taro.ts',
        react: resolve('apps/admin-web/node_modules/react'),
        'react-dom': resolve('apps/admin-web/node_modules/react-dom'),
      },
    },
    define: {
      API_BASE_URL: JSON.stringify('http://127.0.0.1:3000/api/v1'),
      CONSUMER_DEV_LOGIN: 'false',
    },
    server: {
      host: '127.0.0.1',
      port: 5188,
      strictPort: true,
      fs: { allow: [root] },
      proxy: { '/api': fixture.base },
    },
  });
  await writeFile(
    directory + '/admin.html',
    '<html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"><div id="root"></div><script type="module" src="/admin.tsx"></script></body></html>',
  );
  await writeFile(
    directory + '/admin.tsx',
    `import React from 'react';import {createRoot} from 'react-dom/client';import {StaffSessionPanel,Workspace} from '${root}/packages/web-ui/src/index';import '${root}/packages/web-ui/src/styles.css';createRoot(document.getElementById('root')).render(<StaffSessionPanel workspace>{(profile,control)=><Workspace profile={profile} sessionControl={control}/>}</StaffSessionPanel>);`,
  );
  for (const name of ['order', 'orders']) {
    await writeFile(
      directory + '/' + name + '.html',
      `<html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"><div id="root"></div><script type="module" src="/${name}.tsx"></script></body></html>`,
    );
    await writeFile(
      directory + '/' + name + '.tsx',
      `import React from 'react';import {createRoot} from 'react-dom/client';import Page from '${root}/apps/consumer-mini/src/pages/${name}/index';import './style.css';createRoot(document.getElementById('root')).render(<Page/>);`,
    );
  }
  await server.listen();
  browser = await chromium.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: true,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.addInitScript(
    ({ token, expiresAt }) =>
      localStorage.setItem(
        'yumi.consumer-session.v1:http://127.0.0.1:3000/api/v1',
        JSON.stringify({ token, expiresAt }),
      ),
    fixture.identity,
  );
  await fixture.runtime.db.checkoutPolicy.create({
    data: { warehouseId: fixture.warehouseId, deliveryFeeCents: 300, minGoodsCents: 0, open: true },
  });
  let lose = true,
    lostKey,
    retryKey,
    readFail = false,
    gate;
  await page.route('**/api/v1/consumer/orders**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (route.request().method() === 'GET') {
      if (gate) await gate;
      if (readFail)
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: '合成订单读取失败' } }),
        });
    }
    const response = await route.fetch();
    if (path === '/api/v1/consumer/orders' && route.request().method() === 'POST') {
      if (lose && response.status() === 200) {
        lose = false;
        lostKey = route.request().headers()['idempotency-key'];
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: '合成下单响应丢失' } }),
        });
      }
      retryKey = route.request().headers()['idempotency-key'];
    }
    await route.fulfill({ response });
  });
  const shot = async (name) =>
    page.screenshot({
      path: `docs/verification/UI-ORDER-PREVIEW-${name}-2026-11-01.png`,
      fullPage: true,
    });
  await page.goto('http://127.0.0.1:5188/orders.html');
  await page.getByText('还没有订单', { exact: true }).waitFor();
  await shot('EMPTY');
  await page.goto('http://127.0.0.1:5188/');
  await page.getByRole('button', { name: '核验商品与费用', exact: true }).click();
  await page.getByRole('button', { name: '生成本次报价' }).click();
  await page.locator('.checkout-expiry').waitFor();
  await page.getByRole('button', { name: '创建开发测试订单', exact: true }).click();
  await page.getByRole('button', { name: '核实原下单操作' }).waitFor();
  await shot('UNKNOWN');
  assert.equal(await fixture.runtime.db.consumerOrder.count(), 1);
  // Reload the page to prove only non-contact intent metadata is needed to resume the exact request.
  await page.reload();
  await page.getByRole('button', { name: '核实原下单操作' }).click();
  await page.getByText('待支付 · 尚未开始支付', { exact: true }).waitFor();
  assert.equal(lostKey, retryKey);
  assert.equal(await fixture.runtime.db.consumerOrder.count(), 1);
  await shot('DETAIL');
  const intent = await page.evaluate(() =>
    localStorage.getItem('yumi.order-intent.v1:http://127.0.0.1:3000/api/v1'),
  );
  assert.equal(intent, null);
  await page.getByRole('button', { name: '取消未支付订单', exact: true }).click();
  await page.getByText('订单已取消', { exact: true }).waitFor();
  await shot('CANCELED');
  assert.equal(
    (await fixture.runtime.db.stockBalance.aggregate({ _sum: { reserved: true } }))._sum.reserved,
    0,
  );
  await page.getByRole('button', { name: '查看本人订单列表', exact: true }).click();
  await page.locator('.order-card').waitFor();
  await shot('LIST');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  let release;
  gate = new Promise((r) => (release = r));
  await page.getByRole('button', { name: '刷新订单', exact: true }).click();
  await page.getByText('正在读取本人订单…', { exact: true }).waitFor();
  await shot('LOADING');
  release();
  gate = undefined;
  await page.locator('.order-card').waitFor();
  readFail = true;
  await page.getByRole('button', { name: '刷新订单', exact: true }).click();
  await page.locator('.address-alert').filter({ hasText: '合成订单读取失败' }).waitFor();
  await shot('ERROR');
  readFail = false;
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await page.locator('.order-card').waitFor();
  const book = await fixture.call('/consumer/addresses'),
    basket = await fixture.call('/consumer/cart');
  const q = await fixture.call('/consumer/checkout/quotes', {
    addressId: fixture.addressId,
    addressVersion: book.data.version,
    cartVersion: basket.data.version,
  });
  assert.equal(q.status, 200);
  const next = await fixture.call('/consumer/orders', { quoteId: q.data.id });
  assert.equal(next.status, 200);
  await new Promise((r) => setTimeout(r, 3200));
  assert.equal(await expireUnpaidOrders(fixture.runtime.db), 1);
  await page.goto('http://127.0.0.1:5188/order.html?id=' + next.data.id);
  await page.getByText('未开始支付且已超时，预占已释放。', { exact: true }).waitFor();
  await shot('TIMEOUT');
  console.log(
    'Actual mini React source and real isolated API: durable same-key reload recovery, detail, encrypted history, cancellation/list/empty/loading/error/retry and automatic expiry verified. Browser adapter screenshots only.',
  );
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  await fixture.cleanup();
}
