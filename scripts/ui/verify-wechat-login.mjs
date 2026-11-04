/* global document, innerWidth, window, localStorage, Event */
// Actual React pages + real API + disposable PG schema. Browser mini adapter is not native WeChat.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { addressFixture } from '../../tests/helpers/address-fixture.ts';
import { ConsumerAuthService } from '../../apps/api/dist/consumer-auth.js';
import { failure } from '../../apps/api/dist/http.js';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd().replaceAll('\\', '/'),
  dir = resolve('.local/wechat-login-ui');
const { createServer, build } =
  await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
let mode = 'ok',
  exchanges = 0;
const f = await addressFixture({
  wechatExchange: async () => {
    exchanges++;
    if (mode === 'invalid')
      throw failure(401, 'WECHAT_CODE_INVALID', '微信登录凭证已失效，请重新登录');
    return { openid: 'synthetic-wechat-ui-openid-0001' };
  },
});
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
    `import React from 'react';export const ScrollView=({scrollX,children,...p})=><div style={{overflowX:scrollX?'auto':undefined}} {...p}>{children}</div>;export const View=({children,...p})=><div {...p}>{children}</div>;export const Text=({children,...p})=><span {...p}>{children}</span>;export const Button=({children,...p})=><button {...p}>{children}</button>;export const Input=({onInput,onConfirm,maxlength,...p})=><input {...p} maxLength={maxlength} onChange={e=>onInput?.({detail:{value:e.target.value}})} onKeyDown={e=>{if(e.key==='Enter')onConfirm?.()}}/>;export const Picker=({range,onChange,value,disabled})=><select aria-label="收货地址" disabled={disabled} value={value} onChange={e=>onChange({detail:{value:e.target.value}})}>{range.map((v,i)=><option key={i} value={i}>{v}</option>)}</select>;export const Textarea=({onInput,maxlength,...p})=><textarea {...p} maxLength={maxlength} onChange={e=>onInput?.({detail:{value:e.target.value}})}/>;export const Switch=({onChange,checked,disabled})=><input role="switch" type="checkbox" checked={checked} disabled={disabled} onChange={e=>onChange?.({detail:{value:e.target.checked}})}/>;export const Image=({src,mode,...p})=><img src={src} {...p}/>;`,
  );
  await writeFile(
    dir + '/taro.ts',
    `import {useEffect} from 'react';export function useDidShow(fn){useEffect(()=>{fn();window.addEventListener('yumi:show',fn);return()=>window.removeEventListener('yumi:show',fn)},[])}export function useRouter(){return {params:Object.fromEntries(new URLSearchParams(location.search))}};export function useDidHide(fn){useEffect(()=>{window.addEventListener('yumi:hide',fn);return()=>window.removeEventListener('yumi:hide',fn)},[])}const Taro={login:async()=>{if(window.__wxFail)throw Error("synthetic wx.login failure");if(window.__wxPending)await new Promise(done=>{window.__wxResolve=done});window.__wxCode=(window.__wxCode||0)+1;return {code:"ui_code_"+window.__wxCode}},showModal:async()=>({confirm:true}),getStorageSync:k=>JSON.parse(localStorage.getItem(k)||'null'),setStorageSync:(k,v)=>localStorage.setItem(k,JSON.stringify(v)),removeStorageSync:k=>localStorage.removeItem(k),setClipboardData:async o=>{window.__clipboard=o.data;return{}},request:async o=>{const r=await fetch('/api/v1'+o.url.split('/api/v1')[1],{method:o.method,headers:o.header,body:o.method==='GET'?undefined:JSON.stringify(o.data)});return {statusCode:r.status,data:await r.json()}},navigateTo:async o=>{window.__lastNavigation=o.url}};export default Taro;`,
  );
  await writeFile(
    dir + '/main.tsx',
    `import React from 'react';import{createRoot}from'react-dom/client';import{StaffSessionPanel,Workspace}from'${root}/packages/web-ui/src/index';import Account from '${root}/apps/consumer-mini/src/pages/account/index';import Rewards from '${root}/apps/consumer-mini/src/pages/rewards/index';import Detail from '${root}/apps/consumer-mini/src/pages/reward/index';import Checkout from '${root}/apps/consumer-mini/src/pages/redemption-checkout/index';import Orders from '${root}/apps/consumer-mini/src/pages/redemptions/index';import Order from '${root}/apps/consumer-mini/src/pages/redemption/index';import ExpressAddresses from '${root}/apps/consumer-mini/src/pages/express-addresses/index';import Points from '${root}/apps/consumer-mini/src/pages/points/index';const mini=location.search.includes('mini');const style=document.createElement('link');style.rel='stylesheet';style.href=mini?'/mini.css':'/admin.css';await new Promise((done,fail)=>{style.onload=done;style.onerror=fail;document.head.appendChild(style)});createRoot(document.getElementById('root')).render(<React.StrictMode><><div style={{padding:8,background:'#fff3cd',fontSize:12}}>隔离验收 · 合成数据 · 微信登录适配器 · 合成身份 · 非真实微信联调</div>{mini?(location.search.includes("view=account")?<Account/>:location.search.includes("view=express-addresses")?<ExpressAddresses/>:location.search.includes("view=checkout")?<Checkout/>:location.search.includes("view=orders")?<Orders/>:location.search.includes("view=order&")?<Order/>:location.search.includes("view=points")?<Points/>:location.search.includes("id=")?<Detail/>:<Rewards/>):<StaffSessionPanel workspace>{(p,c)=><Workspace profile={p} sessionControl={c} mobile={location.search.includes("ops")}/>}</StaffSessionPanel>}</></React.StrictMode>);`,
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
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  async function shot(name, p = page) {
    const path = `docs/verification/UI-E4D-WECHAT-${name}-2026-11-03.png`;
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
  let releaseMethods;
  const gate = new Promise((done) => {
    releaseMethods = done;
  });
  releases.push(() => releaseMethods());
  let failMethods = true;
  await page.route('**/consumer/auth/methods', async (route) => {
    await gate;
    if (failMethods)
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: 'synthetic' } }),
      });
    else await route.continue();
  });
  await page.goto('http://127.0.0.1:5188/?mini&view=account');
  await page.getByRole('button', { name: '正在读取登录方式…', exact: true }).waitFor();
  await page
    .getByRole('button', { name: '正在读取登录方式…', exact: true })
    .scrollIntoViewIfNeeded();
  await shot('MINI-LOADING');
  releaseMethods();
  await page.getByText('登录方式读取失败，请重试', { exact: true }).waitFor();
  await shot('MINI-METHODS-ERROR');
  failMethods = false;
  const auth = f.runtime.app.get(ConsumerAuthService);
  auth.config.wechatLogin = false;
  await page.getByRole('button', { name: '重试登录方式', exact: true }).click();
  await page.getByRole('button', { name: '微信登录暂未开放', exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '微信登录暂未开放', exact: true }).isEnabled(),
    false,
  );
  await shot('MINI-DISABLED');
  auth.config.wechatLogin = true;
  await page.reload();
  await page.getByRole('button', { name: '微信登录', exact: true }).waitFor();
  await page.getByRole('button', { name: '微信登录', exact: true }).scrollIntoViewIfNeeded();
  await shot('MINI-GUEST');
  await page.evaluate(() => {
    window.__wxFail = true;
  });
  await page.getByRole('button', { name: '微信登录', exact: true }).click();
  await page.getByText('未能获取微信登录凭证，请重试', { exact: true }).waitFor();
  await shot('MINI-CODE-ERROR');
  assert.equal(exchanges, 0);
  await page.evaluate(() => {
    window.__wxFail = false;
  });
  await page.getByRole('button', { name: '重试核验', exact: true }).click();
  mode = 'invalid';
  await page.getByRole('button', { name: '微信登录', exact: true }).click();
  await page.getByText('微信登录凭证已失效，请重新登录', { exact: true }).waitFor();
  await shot('MINI-INVALID');
  mode = 'ok';
  await page.getByRole('button', { name: '重试核验', exact: true }).click();
  let dropped = true;
  await page.route('**/consumer/auth/wechat-session', async (route) => {
    if (dropped) {
      dropped = false;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await route.abort('failed');
    } else await route.continue();
  });
  await page.getByRole('button', { name: '微信登录', exact: true }).click();
  await page.getByText('暂时无法连接，请检查网络后重试。', { exact: true }).waitFor();
  await shot('MINI-UNKNOWN');
  assert.equal(
    await page.evaluate(() =>
      localStorage.getItem('yumi.consumer-session.v1:http://127.0.0.1:3000/api/v1'),
    ),
    null,
  );
  await page.getByRole('button', { name: '重试核验', exact: true }).click();
  await page.getByRole('button', { name: '微信登录', exact: true }).click();
  await page.getByText('微信账号', { exact: true }).waitFor();
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot('MINI-AUTHENTICATED');
  const data = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('yumi.consumer-session.v1:http://127.0.0.1:3000/api/v1')),
  );
  assert.deepEqual(Object.keys(data).sort(), ['expiresAt', 'token']);
  assert.equal(await f.runtime.db.consumerUser.count({ where: { provider: 'WECHAT' } }), 1);
  const count = exchanges;
  await page.reload();
  await page.getByText('微信账号', { exact: true }).waitFor();
  assert.equal(exchanges, count);
  await shot('MINI-RESTORED');
  await page.getByRole('button', { name: '退出当前登录', exact: true }).click();
  await page.getByRole('button', { name: '微信登录', exact: true }).waitFor();
  await page.getByRole('button', { name: '微信登录', exact: true }).scrollIntoViewIfNeeded();
  await shot('MINI-LOGGED-OUT');
  const sessions = await f.runtime.db.consumerSession.count();
  await page.evaluate(() => {
    window.__wxPending = true;
  });
  await page.getByRole('button', { name: '微信登录', exact: true }).click();
  await page.waitForFunction(() => typeof window.__wxResolve === 'function');
  await page.evaluate(() => {
    window.dispatchEvent(new Event('yumi:hide'));
    window.__wxResolve();
  });
  await page.evaluate(() => window.dispatchEvent(new Event('yumi:show')));
  await page.getByRole('button', { name: '微信登录', exact: true }).waitFor();
  await page.waitForTimeout(100);
  assert.equal(await f.runtime.db.consumerSession.count(), sessions);
  await shot('MINI-HIDDEN-CANCEL');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ passed: true, screenshots: shots, realWechat: false, nativeDevice: false }),
  );
} finally {
  for (const release of releases) release();
  await browser?.close();
  await server?.close();
  await f.cleanup();
}
