/* global document, innerWidth, window, localStorage */
// Actual React pages + real API + disposable PG schema. Browser mini adapter is not native WeChat.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pointsFixture } from '../../tests/helpers/points-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd().replaceAll('\\', '/'),
  dir = resolve('.local/consumer-nickname-ui');
const { createServer, build } =
  await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const f = await pointsFixture();
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
    `import {useEffect} from 'react';export function useDidShow(fn){useEffect(()=>{fn();window.addEventListener('yumi:show',fn);return()=>window.removeEventListener('yumi:show',fn)},[])}export function useReachBottom(fn){useEffect(()=>{window.addEventListener('yumi:bottom',fn);return()=>window.removeEventListener('yumi:bottom',fn)},[fn])}export function usePullDownRefresh(fn){useEffect(()=>{window.addEventListener('yumi:refresh',fn);return()=>window.removeEventListener('yumi:refresh',fn)},[fn])}export function useRouter(){return {params:Object.fromEntries(new URLSearchParams(location.search))}};export function useDidHide(fn){useEffect(()=>{window.addEventListener('yumi:hide',fn);return()=>window.removeEventListener('yumi:hide',fn)},[])}const Taro={showModal:async o=>{window.__lastModal=o;return{confirm:window.__modalConfirm!==false,cancel:window.__modalConfirm===false}},stopPullDownRefresh:()=>{},getStorageSync:k=>JSON.parse(localStorage.getItem(k)||'null'),setStorageSync:(k,v)=>localStorage.setItem(k,JSON.stringify(v)),removeStorageSync:k=>localStorage.removeItem(k),setClipboardData:async o=>{window.__clipboard=o.data;return{}},request:async o=>{const r=await fetch('/api/v1'+o.url.split('/api/v1')[1],{method:o.method,headers:o.header,body:o.method==='GET'?undefined:JSON.stringify(o.data)});return {statusCode:r.status,data:await r.json()}},showToast:async o=>{window.__toast=o.title},switchTab:async o=>{window.__lastNavigation=o.url},navigateBack:async()=>{window.__lastNavigation='back'},navigateTo:async o=>{window.__lastNavigation=o.url}};export default Taro;`,
  );
  await writeFile(
    dir + '/main.tsx',
    `import React from 'react';import{createRoot}from'react-dom/client';import{StaffSessionPanel,Workspace}from'${root}/packages/web-ui/src/index';import Profile from '${root}/apps/consumer-mini/src/pages/profile/index';import Feedback from '${root}/apps/consumer-mini/src/pages/return-feedback/index';import ReturnsList from '${root}/apps/consumer-mini/src/pages/returns/index';import ReturnDetail from '${root}/apps/consumer-mini/src/pages/return/index';import Account from '${root}/apps/consumer-mini/src/pages/account/index';import Login from '${root}/apps/consumer-mini/src/pages/login/index';import Rewards from '${root}/apps/consumer-mini/src/pages/rewards/index';import Detail from '${root}/apps/consumer-mini/src/pages/reward/index';import Checkout from '${root}/apps/consumer-mini/src/pages/points-checkout/index';import Cart from '${root}/apps/consumer-mini/src/pages/points-cart/index';import Orders from '${root}/apps/consumer-mini/src/pages/redemptions/index';import Order from '${root}/apps/consumer-mini/src/pages/redemption/index';import ExpressAddresses from '${root}/apps/consumer-mini/src/pages/express-addresses/index';import Points from '${root}/apps/consumer-mini/src/pages/points/index';import{openRedemptions}from'${root}/apps/consumer-mini/src/reward-navigation';window.__openOrders=openRedemptions;const mini=location.search.includes('mini');const style=document.createElement('link');style.rel='stylesheet';style.href=mini?'/mini.css':'/admin.css';await new Promise((done,fail)=>{style.onload=done;style.onerror=fail;document.head.appendChild(style)});createRoot(document.getElementById('root')).render(<React.StrictMode><><div style={{padding:8,background:'#fff3cd',fontSize:12}}>隔离验收 · 合成数据 · 昵称编辑验收 · 非生产操作</div>{mini?(location.search.includes("view=profile")?<Profile/>:location.search.includes("view=feedback")?<Feedback/>:location.search.includes("view=returns")?<ReturnsList/>:location.search.includes("view=return&")?<ReturnDetail/>:location.search.includes("view=login")?<Login/>:location.search.includes("view=cart")?<Cart/>:location.search.includes("view=account")?<Account/>:location.search.includes("view=express-addresses")?<ExpressAddresses/>:location.search.includes("view=checkout")?<Checkout/>:location.search.includes("view=orders")?<Orders/>:location.search.includes("view=order&")?<Order/>:location.search.includes("view=points")?<Points/>:location.search.includes("id=")?<Detail/>:<Rewards/>):<StaffSessionPanel workspace>{(p,c)=><Workspace profile={p} sessionControl={c} mobile={location.search.includes("ops")}/>}</StaffSessionPanel>}</></React.StrictMode>);`,
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
    const path = `docs/verification/UI-CONSUMER-NICKNAME-${name}-2026-11-06.png`;
    if (['MINI-DETAIL', 'MINI-SUPPLEMENTED', 'MINI-REOPENED'].includes(name))
      await p.locator('.after-sales-card').scrollIntoViewIfNeeded();
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

  const host = 'http://127.0.0.1:5188/';
  const url = host + '?mini&view=profile';
  const login = (identity) =>
    page.evaluate(
      (v) =>
        localStorage.setItem(
          'yumi.consumer-session.v1:http://127.0.0.1:3000/api/v1',
          JSON.stringify({ token: v.token, expiresAt: v.expiresAt }),
        ),
      identity,
    );
  const rename = async (displayName, expectedDisplayName, token = f.identity.token) => {
    const r = await fetch(f.base + '/api/v1/consumer/profile/nickname', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName, expectedDisplayName }),
    });
    assert.equal(r.status, 200);
  };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(url);
  await page.getByRole('button', { name: '微信登录', exact: true }).waitFor();
  await shot('MINI-GUEST');
  await login(f.identity);
  await page.reload();
  const input = page.getByRole('textbox', { name: '昵称', exact: true });
  await input.waitFor();
  assert.equal(
    await page.getByRole('button', { name: '保存昵称', exact: true }).isDisabled(),
    true,
  );
  await shot('MINI-FORM');
  await input.fill('🙂'.repeat(21));
  assert.equal(
    await page.getByRole('button', { name: '保存昵称', exact: true }).isDisabled(),
    true,
  );
  await shot('MINI-TOO-LONG');
  await input.fill('玉米邻居');
  await page.getByRole('button', { name: '保存昵称', exact: true }).click();
  await page.getByText('昵称已保存', { exact: true }).waitFor();
  assert.equal(
    (await f.runtime.db.consumerUser.findUniqueOrThrow({ where: { id: f.identity.user.id } }))
      .displayName,
    '玉米邻居',
  );
  await shot('MINI-SAVED');
  await page.goto(host + '?mini&view=account');
  await page.getByText('玉米邻居', { exact: true }).waitFor();
  await page.getByRole('button', { name: '修改昵称 ›', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__lastNavigation), '/pages/profile/index');
  await shot('MINI-ACCOUNT');
  await page.goto(url);
  await input.waitFor();
  await input.fill('我想要的昵称');
  await rename('另一设备昵称', '玉米邻居');
  await page.getByRole('button', { name: '保存昵称', exact: true }).click();
  await page.getByText('昵称已在其他设备修改，请核对最新昵称后保存', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), '我想要的昵称');
  await page.getByText('当前昵称：另一设备昵称', { exact: true }).waitFor();
  await shot('MINI-CONFLICT');
  await page.getByRole('button', { name: '保存昵称', exact: true }).click();
  await page.getByText('昵称已保存', { exact: true }).waitFor();
  let lose = true;
  await page.route('**/consumer/profile/nickname', async (route) => {
    if (!lose) return route.continue();
    lose = false;
    assert.equal((await route.fetch()).status(), 200);
    await route.abort('failed');
  });
  await input.fill('响应丢失已保存');
  await page.getByRole('button', { name: '保存昵称', exact: true }).click();
  await page.getByRole('button', { name: '核实保存结果', exact: true }).waitFor();
  await shot('MINI-UNKNOWN');
  assert.equal(await input.isDisabled(), true);
  await page.getByRole('button', { name: '核实保存结果', exact: true }).click();
  await page.getByText('昵称已保存', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), '响应丢失已保存');
  await shot('MINI-VERIFIED');
  await page.unroute('**/consumer/profile/nickname');
  await page.route('**/consumer/profile/nickname', (route) => route.abort('failed'));
  await input.fill('未送达请求重试');
  await page.getByRole('button', { name: '保存昵称', exact: true }).click();
  await page.getByRole('button', { name: '使用原内容重试', exact: true }).waitFor();
  await shot('MINI-RETRY');
  await login(f.identityB);
  await page.evaluate(() => {
    window.dispatchEvent(new window.Event('yumi:hide'));
    window.dispatchEvent(new window.Event('yumi:show'));
  });
  await input.waitFor();
  assert.equal(await input.inputValue(), f.identityB.user.displayName);
  assert.equal(await page.getByRole('button', { name: '使用原内容重试', exact: true }).count(), 0);
  await shot('MINI-ACCOUNT-B');
  await login(f.identity);
  await page.evaluate(() => {
    window.dispatchEvent(new window.Event('yumi:hide'));
    window.dispatchEvent(new window.Event('yumi:show'));
  });
  await page.getByRole('button', { name: '使用原内容重试', exact: true }).waitFor();
  await page.unroute('**/consumer/profile/nickname');
  await page.getByRole('button', { name: '使用原内容重试', exact: true }).click();
  await page.getByText('昵称已保存', { exact: true }).waitFor();
  assert.equal(await input.inputValue(), '未送达请求重试');
  await shot('MINI-RETRIED');
  await input.fill('禁止写到另一账号');
  await login(f.identityB);
  await page.getByRole('button', { name: '保存昵称', exact: true }).click();
  await page.getByText('登录记录已变化，请重新读取本人昵称', { exact: true }).waitFor();
  assert.equal(await input.count(), 0);
  assert.equal(
    (await f.runtime.db.consumerUser.findUniqueOrThrow({ where: { id: f.identityB.user.id } }))
      .displayName,
    f.identityB.user.displayName,
  );
  await shot('MINI-SWITCH-GUARD');
  await page.route('**/consumer/me', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'UI_TEST', message: '合成昵称读取失败' } }),
    }),
  );
  await page.reload();
  await page.getByText('合成昵称读取失败', { exact: true }).waitFor();
  await shot('MINI-READ-ERROR');
  await page.unroute('**/consumer/me');
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await input.waitFor();
  await page.route('**/consumer/profile/nickname', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: { code: 'SESSION_EXPIRED', message: '合成登录已失效' } }),
    }),
  );
  await input.fill('失效不能保存');
  await page.getByRole('button', { name: '保存昵称', exact: true }).click();
  await page.getByRole('button', { name: '微信登录', exact: true }).waitFor();
  assert.equal(await input.count(), 0);
  await shot('MINI-EXPIRED');
  await page.unroute('**/consumer/profile/nickname');
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await input.waitFor();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await shot('DESKTOP-FORM');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, screenshots: shots, realDevice: false }));
} finally {
  await browser?.close();
  await server?.close();
  await f.cleanup();
}
