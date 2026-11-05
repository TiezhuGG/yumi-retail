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
  dir = resolve('.local/redemption-returns-ui');
const { createServer, build } =
  await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const f = await expressShippingFixture();
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
    `import {useEffect} from 'react';export function useDidShow(fn){useEffect(()=>{fn();window.addEventListener('yumi:show',fn);return()=>window.removeEventListener('yumi:show',fn)},[])}export function useRouter(){return {params:Object.fromEntries(new URLSearchParams(location.search))}};export function useDidHide(fn){useEffect(()=>{window.addEventListener('yumi:hide',fn);return()=>window.removeEventListener('yumi:hide',fn)},[])}const Taro={getStorageSync:k=>JSON.parse(localStorage.getItem(k)||'null'),setStorageSync:(k,v)=>localStorage.setItem(k,JSON.stringify(v)),removeStorageSync:k=>localStorage.removeItem(k),setClipboardData:async o=>{window.__clipboard=o.data;return{}},request:async o=>{const r=await fetch('/api/v1'+o.url.split('/api/v1')[1],{method:o.method,headers:o.header,body:o.method==='GET'?undefined:JSON.stringify(o.data)});return {statusCode:r.status,data:await r.json()}},navigateTo:async o=>{window.__lastNavigation=o.url}};export default Taro;`,
  );
  await writeFile(
    dir + '/main.tsx',
    `import React from 'react';import{createRoot}from'react-dom/client';import{StaffSessionPanel,Workspace}from'${root}/packages/web-ui/src/index';import Account from '${root}/apps/consumer-mini/src/pages/account/index';import Rewards from '${root}/apps/consumer-mini/src/pages/rewards/index';import Detail from '${root}/apps/consumer-mini/src/pages/reward/index';import Checkout from '${root}/apps/consumer-mini/src/pages/redemption-checkout/index';import Orders from '${root}/apps/consumer-mini/src/pages/redemptions/index';import Order from '${root}/apps/consumer-mini/src/pages/redemption/index';import ExpressAddresses from '${root}/apps/consumer-mini/src/pages/express-addresses/index';import Points from '${root}/apps/consumer-mini/src/pages/points/index';const mini=location.search.includes('mini');const style=document.createElement('link');style.rel='stylesheet';style.href=mini?'/mini.css':'/admin.css';await new Promise((done,fail)=>{style.onload=done;style.onerror=fail;document.head.appendChild(style)});createRoot(document.getElementById('root')).render(<React.StrictMode><><div style={{padding:8,background:'#fff3cd',fontSize:12}}>隔离验收 · 合成数据 · 退货退积分验收 · 非生产操作</div>{mini?(location.search.includes("view=account")?<Account/>:location.search.includes("view=express-addresses")?<ExpressAddresses/>:location.search.includes("view=checkout")?<Checkout/>:location.search.includes("view=orders")?<Orders/>:location.search.includes("view=order&")?<Order/>:location.search.includes("view=points")?<Points/>:location.search.includes("id=")?<Detail/>:<Rewards/>):<StaffSessionPanel workspace>{(p,c)=><Workspace profile={p} sessionControl={c} mobile={location.search.includes("ops")}/>}</StaffSessionPanel>}</></React.StrictMode>);`,
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
    const path = `docs/verification/UI-MALL-RETURNS-${name}-2026-11-05.png`;
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

  await page.goto('http://127.0.0.1:5188');
  await page.getByRole('button', { name: '退货退积分', exact: true }).click();
  await page.getByText('暂无退货退积分申请', { exact: true }).waitFor();
  await shot('ADMIN-EMPTY');
  const id = await f.createExpress(2);
  assert.equal(
    (
      await f.api('/admin/redemptions/' + id + '/ship', {
        version: 0,
        carrierCode: 'SF',
        trackingNo: 'SF-MALL-RETURN-UI-001',
        dispatchConfirmed: true,
      })
    ).status,
    200,
  );
  const before = await f.runtime.db.stockBalance.findMany(),
    ledgerCount = await f.runtime.db.stockLedger.count();
  const mini = await context.newPage();
  mini.on('pageerror', (e) => errors.push(e.message));
  await mini.setViewportSize({ width: 390, height: 844 });
  await mini.addInitScript(
    (identity) =>
      localStorage.setItem(
        'yumi.consumer-session.v1:http://127.0.0.1:3000/api/v1',
        JSON.stringify({ token: identity.token, expiresAt: identity.expiresAt }),
      ),
    f.identity,
  );
  await mini.goto('http://127.0.0.1:5188/?mini&view=account');
  await mini.getByText('760', { exact: true }).waitFor();
  await shot('MINI-ACCOUNT-LOGGED', mini);
  await mini.goto('http://127.0.0.1:5188/?mini&view=order&id=' + id);
  const card = mini.locator('.return-card');
  await card.getByLabel('售后申请件数', { exact: true }).waitFor();
  await card.getByLabel('售后申请件数', { exact: true }).fill('2');
  await card
    .getByLabel('退货退积分原因', { exact: true })
    .fill('合成商品破损，申请完整退货并退还积分');
  await card.scrollIntoViewIfNeeded();
  await shot('MINI-REQUEST-FORM', mini);
  let dropRequest = true;
  await mini.route('**/redemptions/*/returns', async (route) => {
    if (route.request().method() === 'POST' && dropRequest) {
      dropRequest = false;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await card.getByRole('button', { name: '提交申请 · 240 积分', exact: true }).click();
  await card.getByRole('button', { name: '使用原请求核实售后', exact: true }).waitFor();
  await shot('MINI-REQUEST-UNKNOWN', mini);
  await mini.reload();
  await mini
    .locator('.return-card')
    .getByRole('button', { name: '使用原请求核实售后', exact: true })
    .click();
  await mini.locator('.return-card').getByText('等待门店审核', { exact: true }).waitFor();
  await mini.locator('.return-card').scrollIntoViewIfNeeded();
  await shot('MINI-REQUESTED', mini);
  await page.getByRole('button', { name: '刷新售后', exact: true }).click();
  await page.getByRole('button', { name: '查看售后申请', exact: true }).click();
  await page
    .getByLabel('退货处理说明', { exact: true })
    .fill('请先联系门店确认退回地址，再完整寄回');
  await page.getByLabel('确认审核结论和退货要求，并展示说明给用户', { exact: true }).check();
  await shot('ADMIN-APPROVE');
  await page.getByRole('button', { name: '审核通过', exact: true }).click();
  await page.locator('.return-state').filter({ hasText: '待退货验收' }).waitFor();
  await mini.reload();
  await mini.locator('.return-card').getByText('审核通过 · 等待退货', { exact: true }).waitFor();
  await mini.locator('.return-card').scrollIntoViewIfNeeded();
  await shot('MINI-WAIT-RETURN', mini);
  await page.getByLabel('实际退回件数', { exact: true }).fill('1');
  await page.getByLabel('实际隔离存放位置', { exact: true }).fill('合成隔离区A-01');
  await page
    .getByLabel('退货处理说明', { exact: true })
    .fill('已检查退回包装和商品，单独隔离待处理');
  await page.getByLabel('已核对全部实物并放入隔离位置', { exact: true }).check();
  assert.equal(
    await page.getByRole('button', { name: '确认退货隔离验收', exact: true }).isEnabled(),
    false,
  );
  await shot('ADMIN-PARTIAL-BLOCKED');
  await page.getByLabel('实际退回件数', { exact: true }).fill('2');
  await page.getByRole('button', { name: '确认退货隔离验收', exact: true }).click();
  await page.locator('.return-state').filter({ hasText: '待退积分' }).waitFor();
  await shot('ADMIN-RECEIVED');
  await page
    .getByLabel('退货处理说明', { exact: true })
    .fill('全部退货已验收，按原积分价退还240积分');
  await page.getByLabel('确认按原兑换积分价退还上述积分', { exact: true }).check();
  await shot('ADMIN-REFUND-FORM');
  let dropRefund = true;
  await page.route('**/redemption-returns/*/refund', async (route) => {
    if (dropRefund) {
      dropRefund = false;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await page.getByRole('button', { name: '确认退还 240 积分', exact: true }).click();
  await page.getByRole('button', { name: '使用原请求核实售后', exact: true }).waitFor();
  await shot('ADMIN-REFUND-UNKNOWN');
  await page.reload();
  await page.getByRole('button', { name: '退货退积分', exact: true }).click();
  await page.getByRole('button', { name: '使用原请求核实售后', exact: true }).click();
  await page.locator('.return-state').filter({ hasText: '积分已退还' }).waitFor();
  await shot('ADMIN-REFUNDED');
  await mini.reload();
  await mini.locator('.return-card').getByText('积分已退还', { exact: true }).waitFor();
  await mini.locator('.return-card').scrollIntoViewIfNeeded();
  await shot('MINI-REFUNDED', mini);
  await mini.goto('http://127.0.0.1:5188/?mini&view=points');
  await mini.getByRole('button', { name: '售后退积分 · 查看兑换单', exact: true }).waitFor();
  await shot('MINI-POINTS-REFUND', mini);
  await mini.goto('http://127.0.0.1:5188/?mini&view=account');
  await mini.getByText('1000', { exact: true }).waitFor();
  await shot('MINI-ACCOUNT-REFUNDED', mini);
  assert.deepEqual(await f.runtime.db.stockBalance.findMany(), before);
  assert.equal(await f.runtime.db.stockLedger.count(), ledgerCount);
  assert.equal(await f.runtime.db.redemptionReturn.count(), 1);
  assert.equal(await f.runtime.db.redemptionReturnEvent.count(), 3);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, screenshots: shots }));
} finally {
  for (const release of releases) release();
  await browser?.close();
  await server?.close();
  await f.cleanup();
}
