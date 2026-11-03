/* global document, innerWidth, window, localStorage */
// Actual React pages + real API + disposable PG schema. Browser mini adapter is not native WeChat.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { controlledExpressFixture } from '../../tests/helpers/controlled-express-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd().replaceAll('\\', '/'),
  dir = resolve('.local/points-express-gate-ui');
const { createServer, build } =
  await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const fixture = await controlledExpressFixture();
const f = { ...fixture, base: fixture.controlledBase };
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
    `import React from 'react';export const View=({children,...p})=><div {...p}>{children}</div>;export const Text=({children,...p})=><span {...p}>{children}</span>;export const Button=({children,...p})=><button {...p}>{children}</button>;export const Input=({onInput,onConfirm,maxlength,...p})=><input {...p} maxLength={maxlength} onChange={e=>onInput?.({detail:{value:e.target.value}})} onKeyDown={e=>{if(e.key==='Enter')onConfirm?.()}}/>;export const Picker=({range,onChange,value,disabled})=><select aria-label="收货地址" disabled={disabled} value={value} onChange={e=>onChange({detail:{value:e.target.value}})}>{range.map((v,i)=><option key={i} value={i}>{v}</option>)}</select>;export const Textarea=({onInput,maxlength,...p})=><textarea {...p} maxLength={maxlength} onChange={e=>onInput?.({detail:{value:e.target.value}})}/>;export const Switch=({onChange,checked,disabled})=><input role="switch" type="checkbox" checked={checked} disabled={disabled} onChange={e=>onChange?.({detail:{value:e.target.checked}})}/>;export const Image=({src,mode,...p})=><img src={src} {...p}/>;`,
  );
  await writeFile(
    dir + '/taro.ts',
    `import {useEffect} from 'react';export function useDidShow(fn){useEffect(()=>{fn();window.addEventListener('yumi:show',fn);return()=>window.removeEventListener('yumi:show',fn)},[])}export function useRouter(){return {params:Object.fromEntries(new URLSearchParams(location.search))}};export function useDidHide(fn){useEffect(()=>{window.addEventListener('yumi:hide',fn);return()=>window.removeEventListener('yumi:hide',fn)},[])}const Taro={getStorageSync:k=>JSON.parse(localStorage.getItem(k)||'null'),setStorageSync:(k,v)=>localStorage.setItem(k,JSON.stringify(v)),removeStorageSync:k=>localStorage.removeItem(k),setClipboardData:async o=>{window.__clipboard=o.data;return{}},request:async o=>{const r=await fetch('/api/v1'+o.url.split('/api/v1')[1],{method:o.method,headers:o.header,body:o.method==='GET'?undefined:JSON.stringify(o.data)});return {statusCode:r.status,data:await r.json()}},navigateTo:async o=>{window.__lastNavigation=o.url}};export default Taro;`,
  );
  await writeFile(
    dir + '/main.tsx',
    `import React from 'react';import{createRoot}from'react-dom/client';import{StaffSessionPanel,Workspace}from'${root}/packages/web-ui/src/index';import Rewards from '${root}/apps/consumer-mini/src/pages/rewards/index';import Detail from '${root}/apps/consumer-mini/src/pages/reward/index';import Checkout from '${root}/apps/consumer-mini/src/pages/redemption-checkout/index';import Orders from '${root}/apps/consumer-mini/src/pages/redemptions/index';import Order from '${root}/apps/consumer-mini/src/pages/redemption/index';import ExpressAddresses from '${root}/apps/consumer-mini/src/pages/express-addresses/index';import Points from '${root}/apps/consumer-mini/src/pages/points/index';const mini=location.search.includes('mini');const style=document.createElement('link');style.rel='stylesheet';style.href=mini?'/mini.css':'/admin.css';await new Promise((done,fail)=>{style.onload=done;style.onerror=fail;document.head.appendChild(style)});createRoot(document.getElementById('root')).render(<React.StrictMode><><div style={{padding:8,background:'#fff3cd',fontSize:12}}>隔离验收 · 合成数据 · 独立门禁 · 合成受控账号 · 非真实微信/TLS/生产验收</div>{mini?(location.search.includes("view=express-addresses")?<ExpressAddresses/>:location.search.includes("view=checkout")?<Checkout/>:location.search.includes("view=orders")?<Orders/>:location.search.includes("view=order&")?<Order/>:location.search.includes("view=points")?<Points/>:location.search.includes("id=")?<Detail/>:<Rewards/>):<StaffSessionPanel workspace>{(p,c)=><Workspace profile={p} sessionControl={c} mobile={location.search.includes("ops")}/>}</StaffSessionPanel>}</></React.StrictMode>);`,
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
    const path = `docs/verification/UI-E4E-GATE-${name}-2026-11-03.png`;
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
  await page.getByRole('button', { name: '积分快递首发检查', exact: true }).click();
  await page.getByText(/独立正式门禁已实现；当前模式：controlled/).waitFor();
  await shot('ADMIN-GATES');
  const mini = await context.newPage();
  mini.on('pageerror', (e) => errors.push(e.message));
  await mini.setViewportSize({ width: 390, height: 844 });
  await mini.addInitScript(
    (identity) =>
      localStorage.setItem(
        'yumi.consumer-session.v1:http://127.0.0.1:3000/api/v1',
        JSON.stringify(identity),
      ),
    { token: f.a.token, expiresAt: f.a.expiresAt },
  );
  const url =
    'http://127.0.0.1:5188/?mini&view=checkout&id=' + f.quoteInput.rewardId + '&quantity=1';
  f.config.pointsExpress.submit = false;
  await mini.goto(url);
  await mini.getByText(/新兑换已暂停/).waitFor();
  assert.equal(
    await mini.getByRole('button', { name: '核验并生成兑换报价', exact: true }).isEnabled(),
    false,
  );
  await mini
    .getByRole('button', { name: '核验并生成兑换报价', exact: true })
    .scrollIntoViewIfNeeded();
  await shot('MINI-SUBMIT-PAUSED', mini);
  f.config.pointsExpress.submit = true;
  f.config.pointsExpress.allowedUsers = [f.b.id];
  await mini.reload();
  await mini.getByText(/当前仅向受控测试账号开放兑换/).waitFor();
  await mini
    .getByRole('button', { name: '核验并生成兑换报价', exact: true })
    .scrollIntoViewIfNeeded();
  await shot('MINI-NOT-ALLOWED', mini);
  f.config.pointsExpress.allowedUsers = [f.a.id];
  let failAccess = true;
  await mini.route('**/consumer/redemption-access', async (route) => {
    if (failAccess)
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'UI_TEST', message: '合成门禁读取失败' } }),
      });
    else await route.continue();
  });
  await mini.reload();
  await mini.getByText('合成门禁读取失败', { exact: true }).waitFor();
  await shot('MINI-ACCESS-ERROR', mini);
  failAccess = false;
  await mini.getByRole('button', { name: '重新读取商品与地址', exact: true }).click();
  await mini.getByText(/受控测试兑换 · 可继续核验商品、地址与积分/).waitFor();
  await mini.getByRole('button', { name: '核验并生成兑换报价', exact: true }).click();
  await mini.getByRole('button', { name: '确认扣除 120 积分兑换', exact: true }).waitFor();
  await mini
    .getByRole('button', { name: '确认扣除 120 积分兑换', exact: true })
    .scrollIntoViewIfNeeded();
  await shot('MINI-CONTROLLED-QUOTE', mini);
  f.config.pointsExpress.submit = false;
  await mini.getByRole('button', { name: '确认扣除 120 积分兑换', exact: true }).click();
  await mini.getByText('新兑换已暂停，已受理订单仍可查询与处理', { exact: true }).waitFor();
  await mini.getByRole('button', { name: '核实原兑换操作', exact: true }).waitFor();
  await shot('MINI-PAUSED-AFTER-QUOTE', mini);
  f.config.pointsExpress.submit = true;
  await mini.getByRole('button', { name: '核实原兑换操作', exact: true }).click();
  await mini.waitForFunction(() => !!window.__lastNavigation);
  const order = await f.controlled.db.redemptionOrder.findFirstOrThrow({
    where: { executionMode: 'CONTROLLED' },
  });
  await mini.goto('http://127.0.0.1:5188/?mini&view=order&id=' + order.id);
  await mini.getByText('受控测试订单', { exact: true }).waitFor();
  await shot('MINI-CONTROLLED-ORDER', mini);
  f.config.pointsExpress.operations = false;
  await page.getByRole('button', { name: '积分兑换订单', exact: true }).click();
  await page.getByRole('button', { name: '查看订单详情', exact: true }).click();
  await page.getByText('快递发货暂未开放', { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '确认快递发货', exact: true }).isEnabled(),
    false,
  );
  await shot('ADMIN-OPERATIONS-PAUSED');
  f.config.pointsExpress.operations = true;
  await page.getByRole('button', { name: '刷新发货资料', exact: true }).click();
  await page.getByLabel('快递公司', { exact: true }).selectOption('SF');
  await page.getByLabel('快递运单号', { exact: true }).fill('SF-CONTROLLED-UI-001');
  await page
    .getByLabel('已核对全部实物、原收件信息和运单，确认整单已交给快递', { exact: true })
    .check();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('快递运单号', { exact: true }).scrollIntoViewIfNeeded();
  await shot('ADMIN-SHIP-MOBILE');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: '确认快递发货', exact: true }).click();
  await page.getByRole('heading', { name: '已快递发货', exact: true }).waitFor();
  await shot('ADMIN-CONTROLLED-SHIPPED');
  await page.getByRole('button', { name: '打印本单', exact: true }).click();
  const frame = await (
    await page.locator('iframe[title="订单配货单预览"]').elementHandle()
  ).contentFrame();
  await frame.getByText('受控测试订单', { exact: true }).waitFor();
  await shot('ADMIN-CONTROLLED-PRINT');
  await page.getByRole('button', { name: '关闭打印预览', exact: true }).click();
  const devId = await f.createExpress(),
    dev = await f.controlled.db.redemptionOrder.findUniqueOrThrow({ where: { id: devId } });
  await page.getByRole('button', { name: '返回兑换订单列表', exact: true }).click();
  const row = page.locator('tr').filter({ hasText: dev.orderNo });
  await row.getByRole('button', { name: '查看订单详情', exact: true }).click();
  await page.getByText('本地开发订单', { exact: true }).waitFor();
  await page.getByText('快递发货暂未开放', { exact: true }).waitFor();
  await shot('ADMIN-DEVELOPMENT-BLOCKED');
  assert.equal(
    await f.controlled.db.redemptionExpressShipment.count({ where: { orderId: order.id } }),
    1,
  );
  assert.equal(
    await f.controlled.db.redemptionExpressShipment.count({ where: { orderId: devId } }),
    0,
  );
  assert.equal(await f.controlled.db.redemptionPickingTask.count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      passed: true,
      screenshots: shots,
      realWechat: false,
      realHttps: false,
      production: false,
    }),
  );
} catch (e) {
  await writeFile(
    '.local/points-express-ui-error.json',
    JSON.stringify(
      await Promise.all(
        (browser?.contexts()[0]?.pages() ?? []).map(async (p) => ({
          url: p.url(),
          text: await p.locator('body').innerText(),
        })),
      ),
      null,
      2,
    ),
  );
  throw e;
} finally {
  for (const release of releases) release();
  await browser?.close();
  await server?.close();
  await f.cleanup();
}
