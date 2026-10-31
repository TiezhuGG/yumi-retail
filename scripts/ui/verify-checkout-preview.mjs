/* global document, innerWidth, localStorage */
// Browser adapter for the actual mini React source; screenshots are previews, not WeChat acceptance.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { checkoutFixture } from '../../tests/helpers/checkout-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd(),
  directory = resolve('.local/checkout-preview');
const { createServer } = await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const less = require(resolve('apps/consumer-mini/node_modules/less'));
const fixture = await checkoutFixture();
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
    `import {useEffect} from 'react';export function useDidShow(fn){useEffect(()=>{fn()},[])}export function useDidHide(){}const Taro={getStorageSync:key=>JSON.parse(localStorage.getItem(key)||'null'),setStorageSync:(key,v)=>localStorage.setItem(key,JSON.stringify(v)),removeStorageSync:key=>localStorage.removeItem(key),request:async o=>{const r=await fetch('/api/v1'+o.url.split('/api/v1')[1],{method:o.method,headers:o.header,body:o.method==='GET'?undefined:JSON.stringify(o.data)});return {statusCode:r.status,data:await r.json()}},showModal:async()=>({confirm:true,cancel:false}),navigateTo:async()=>{},navigateBack:async()=>{},reLaunch:async()=>{}};export default Taro;`,
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
  let lose = false,
    failed = false,
    gate,
    lostKey,
    retryKey;
  await page.route('**/api/v1/consumer/checkout/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/preview')) {
      if (gate) await gate;
      if (failed)
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: '合成读取失败' } }),
        });
    }
    const response = await route.fetch();
    if (path.endsWith('/quotes') && lose && response.status() === 200) {
      lose = false;
      lostKey = route.request().headers()['idempotency-key'];
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '合成报价响应丢失' } }),
      });
    }
    if (path.endsWith('/quotes') && lostKey)
      retryKey = route.request().headers()['idempotency-key'];
    await route.fulfill({ response });
  });
  const shot = async (name) =>
    page.screenshot({
      path: `docs/verification/UI-CHECKOUT-PREVIEW-${name}-2026-10-31.png`,
      fullPage: true,
    });
  await page.clock.install();
  await page.goto('http://127.0.0.1:5188');
  await page.getByRole('button', { name: '核验商品与费用', exact: true }).waitFor();
  await page.getByRole('button', { name: '核验商品与费用', exact: true }).click();
  await page.getByText('暂不能确定', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: '生成本次报价', exact: true }).count(), 0);
  await shot('UNCONFIGURED');
  const admin = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await admin.goto('http://127.0.0.1:5188/admin.html');
  await admin.getByLabel('员工账号').fill('quote-ui-0');
  await admin.getByLabel('登录密码').fill(fixture.password);
  await admin.getByRole('button', { name: '登录工作空间 →' }).click();
  await admin.locator('.workspace').waitFor();
  await admin
    .getByRole('navigation')
    .getByRole('button', { name: '报价规则', exact: true })
    .click();
  await admin.getByText('报价规则尚未配置', { exact: true }).waitFor();
  await admin.screenshot({
    path: 'docs/verification/UI-CHECKOUT-POLICY-EMPTY-2026-10-31.png',
    fullPage: true,
  });
  await admin.getByRole('button', { name: '配置真实规则' }).click();
  const dialog = admin.getByRole('dialog');
  await dialog.getByLabel('配送费（元）', { exact: true }).fill('3.00');
  await dialog.getByLabel('起送商品金额（元）', { exact: true }).fill('0');
  await admin.screenshot({
    path: 'docs/verification/UI-CHECKOUT-POLICY-FORM-2026-10-31.png',
    fullPage: true,
  });
  await dialog.getByRole('button', { name: '保存规则' }).click();
  await admin.getByText('报价已暂停', { exact: true }).waitFor();
  await admin.getByRole('button', { name: '编辑报价规则' }).click();
  await dialog.getByLabel('允许生成报价（手动控制）').check();
  await dialog.getByRole('button', { name: '保存规则' }).click();
  await admin.getByText('已允许生成报价', { exact: true }).waitFor();
  await admin.screenshot({
    path: 'docs/verification/UI-CHECKOUT-POLICY-DESKTOP-2026-10-31.png',
    fullPage: true,
  });
  await admin.setViewportSize({ width: 390, height: 844 });
  await admin.screenshot({
    path: 'docs/verification/UI-CHECKOUT-POLICY-MOBILE-2026-10-31.png',
    fullPage: true,
  });
  assert.ok(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole('button', { name: '刷新购物车与地址资料' }).click();
  await page.getByRole('button', { name: '核验商品与费用', exact: true }).click();
  await page.getByRole('button', { name: '生成本次报价', exact: true }).waitFor();
  assert.ok((await page.locator('.checkout-total').innerText()).includes('24.99'));
  await shot('READY');
  lose = true;
  await page.getByRole('button', { name: '生成本次报价', exact: true }).click();
  await page.getByRole('button', { name: '原报价操作重试' }).waitFor();
  await shot('UNKNOWN');
  await page.getByRole('button', { name: '原报价操作重试' }).click();
  await page.locator('.checkout-expiry').waitFor();
  assert.equal(lostKey, retryKey);
  assert.equal(await fixture.runtime.db.checkoutQuote.count(), 1);
  await shot('QUOTE');
  await page.clock.fastForward(121000);
  await page.getByText('本次报价已过期，请重新核验', { exact: true }).waitFor();
  await shot('EXPIRED');
  let release;
  gate = new Promise((r) => (release = r));
  await page.getByRole('button', { name: '核验商品与费用', exact: true }).click();
  await page.getByRole('button', { name: '正在核验…' }).waitFor();
  await shot('LOADING');
  release();
  gate = undefined;
  await page.getByRole('button', { name: '生成本次报价', exact: true }).waitFor();
  failed = true;
  await page.getByRole('button', { name: '核验商品与费用', exact: true }).click();
  await page.getByText('合成读取失败', { exact: true }).waitFor();
  await shot('ERROR');
  failed = false;
  await page.getByRole('button', { name: '核验商品与费用', exact: true }).click();
  await page.getByRole('button', { name: '生成本次报价', exact: true }).waitFor();
  await fixture.runtime.db.stockBalance.update({
    where: {
      warehouseId_skuId: { warehouseId: fixture.warehouseId, skuId: fixture.catalog.skuIds[0] },
    },
    data: { inventoryHold: true },
  });
  await page.getByRole('button', { name: '核验商品与费用', exact: true }).click();
  await page.getByText('当前库存不足', { exact: true }).waitFor();
  await shot('UNAVAILABLE');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(await page.getByRole('button', { name: '订单提交尚未开放' }).isDisabled(), true);
  console.log(
    'Checkout real isolated API + actual React source: missing rules, admin create-paused/open, cent amounts, response-loss replay, expiry, loading/error/retry, inventory hold and desktop/mobile layouts passed. Consumer screenshots are browser previews.',
  );
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  await fixture.cleanup();
}
