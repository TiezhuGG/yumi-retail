/* global document, innerWidth, localStorage */
// Browser adapter for the actual mini React source; screenshots are previews, not WeChat acceptance.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { addressFixture } from '../../tests/helpers/address-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd(),
  directory = resolve('.local/address-preview');
const { createServer } = await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const less = require(resolve('apps/consumer-mini/node_modules/less'));
const fixture = await addressFixture();
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
    `import React from 'react';import {createRoot} from 'react-dom/client';import Addresses from '${root}/apps/consumer-mini/src/pages/addresses/index';import './style.css';createRoot(document.getElementById('root')).render(<Addresses/>);`,
  );
  await writeFile(
    directory + '/components.tsx',
    `import React from 'react';export const View=({children,...p})=><div {...p}>{children}</div>;export const Text=({children,...p})=><span {...p}>{children}</span>;export const Button=({children,...p})=><button {...p}>{children}</button>;export const Input=({onInput,maxlength,...p})=><input {...p} maxLength={maxlength} onChange={e=>onInput?.({detail:{value:e.target.value}})}/>;export const Textarea=({onInput,maxlength,...p})=><textarea {...p} maxLength={maxlength} onChange={e=>onInput?.({detail:{value:e.target.value}})}/>;export const Picker=({range,value,onChange,children,...p})=><div style={{position:"relative"}}>{children}<select style={{position:"absolute",inset:0,opacity:0,width:"100%",height:"100%"}} aria-label="选择楼栋" {...p} value={value} onChange={e=>onChange({detail:{value:e.target.value}})}><option value="-1">选择楼栋</option>{range.map((n,i)=><option key={i} value={i}>{n}</option>)}</select></div>;export const Switch=({color,onChange,...p})=><input aria-label="设为默认地址" type="checkbox" {...p} onChange={e=>onChange({detail:{value:e.target.checked}})}/>;`,
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
    lostKey;
  await page.route('**/api/v1/consumer/addresses**', async (route) => {
    if (route.request().method() === 'GET') {
      if (gate) await gate;
      if (failed)
        return route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: '合成读取失败' } }),
        });
    }
    const response = await route.fetch();
    if (lose && route.request().method() === 'POST') {
      lose = false;
      lostKey = route.request().headers()['idempotency-key'];
      if (response.status() !== 200) return route.fulfill({ response });
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '合成响应丢失' } }),
      });
    }
    if (lostKey && route.request().method() === 'POST') {
      assert.equal(route.request().headers()['idempotency-key'], lostKey);
      lostKey = undefined;
    }
    await route.fulfill({ response });
  });
  const shot = async (name) =>
    page.screenshot({
      path: `docs/verification/UI-ADDRESS-PREVIEW-${name}-2026-10-31.png`,
      fullPage: true,
    });
  await page.goto('http://127.0.0.1:5188');
  await page.getByText('还没有保存收货地址', { exact: true }).waitFor();
  await shot('EMPTY');
  await page.getByRole('button', { name: '＋ 新增收货地址', exact: true }).click();
  await page.getByLabel('选择楼栋').selectOption('0');
  await page.getByPlaceholder('填写房号').fill('合成门牌101');
  await page.getByPlaceholder('请填写联系人').fill('合成验收联系人');
  await page.getByPlaceholder('6至20位数字，可带 + 国际区号').fill('00000000000');
  await page.getByLabel('设为默认地址').check();
  await shot('FORM');
  lose = true;
  await page.getByRole('button', { name: '保存地址', exact: true }).click();
  await page.getByRole('button', { name: '原操作重试确认' }).waitFor();
  assert.equal(await page.getByPlaceholder('填写房号').isDisabled(), true);
  await shot('UNKNOWN');
  await page.getByRole('button', { name: '原操作重试确认' }).click();
  await page.locator('.address-card').waitFor();
  assert.equal(await fixture.runtime.db.consumerAddress.count(), 1);
  await shot('READY');
  await page.getByRole('button', { name: '编辑', exact: true }).click();
  await page.getByPlaceholder('填写房号').fill('合成门牌202');
  await page.getByRole('button', { name: '保存地址', exact: true }).click();
  await page.getByText('合成门牌202', { exact: true }).waitFor();
  let release;
  gate = new Promise((r) => (release = r));
  await page.getByRole('button', { name: '刷新地址' }).click();
  await page.getByText('正在读取本人地址…').waitFor();
  await shot('LOADING');
  release();
  gate = undefined;
  await page.locator('.address-card').waitFor();
  failed = true;
  await page.getByRole('button', { name: '刷新地址' }).click();
  await page.getByRole('button', { name: '重试读取' }).waitFor();
  await shot('ERROR');
  failed = false;
  await page.getByRole('button', { name: '重试读取' }).click();
  await page.locator('.address-card').waitFor();
  await fixture.runtime.db.serviceBuilding.update({
    where: { id: fixture.buildingId },
    data: { enabled: false },
  });
  await page.getByRole('button', { name: '刷新地址' }).click();
  await page.getByText('此地址暂不在有效配送范围').waitFor();
  await shot('UNAVAILABLE');
  assert.equal(
    await page.getByRole('button', { name: '＋ 新增收货地址', exact: true }).isDisabled(),
    true,
  );
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await page.getByText('还没有保存收货地址', { exact: true }).waitFor();
  const stored = await fixture.runtime.db.consumerAddress.findFirstOrThrow();
  assert.equal(stored.payload, null);
  console.log(
    'Same mini React source + real isolated API: empty, create/form, response loss/same-key retry, edit, default, loading/error/retry, paused range, delete and 390px overflow checks passed. Browser adapter only; not native WeChat screenshots.',
  );
} finally {
  if (browser) await browser.close();
  if (server) await server.close();
  await fixture.cleanup();
}
