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
  dir = resolve('.local/redemption-express-shipping-ui');
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
    `import React from 'react';export const View=({children,...p})=><div {...p}>{children}</div>;export const Text=({children,...p})=><span {...p}>{children}</span>;export const Button=({children,...p})=><button {...p}>{children}</button>;export const Input=({onInput,onConfirm,maxlength,...p})=><input {...p} maxLength={maxlength} onChange={e=>onInput?.({detail:{value:e.target.value}})} onKeyDown={e=>{if(e.key==='Enter')onConfirm?.()}}/>;export const Picker=({range,onChange,value,disabled})=><select aria-label="收货地址" disabled={disabled} value={value} onChange={e=>onChange({detail:{value:e.target.value}})}>{range.map((v,i)=><option key={i} value={i}>{v}</option>)}</select>;export const Textarea=({onInput,maxlength,...p})=><textarea {...p} maxLength={maxlength} onChange={e=>onInput?.({detail:{value:e.target.value}})}/>;export const Switch=({onChange,checked,disabled})=><input role="switch" type="checkbox" checked={checked} disabled={disabled} onChange={e=>onChange?.({detail:{value:e.target.checked}})}/>;export const Image=({src,mode,...p})=><img src={src} {...p}/>;`,
  );
  await writeFile(
    dir + '/taro.ts',
    `import {useEffect} from 'react';export function useDidShow(fn){useEffect(()=>{fn();window.addEventListener('yumi:show',fn);return()=>window.removeEventListener('yumi:show',fn)},[])}export function useRouter(){return {params:Object.fromEntries(new URLSearchParams(location.search))}};export function useDidHide(fn){useEffect(()=>{window.addEventListener('yumi:hide',fn);return()=>window.removeEventListener('yumi:hide',fn)},[])}const Taro={getStorageSync:k=>JSON.parse(localStorage.getItem(k)||'null'),setStorageSync:(k,v)=>localStorage.setItem(k,JSON.stringify(v)),removeStorageSync:k=>localStorage.removeItem(k),setClipboardData:async o=>{window.__clipboard=o.data;return{}},request:async o=>{const r=await fetch('/api/v1'+o.url.split('/api/v1')[1],{method:o.method,headers:o.header,body:o.method==='GET'?undefined:JSON.stringify(o.data)});return {statusCode:r.status,data:await r.json()}},navigateTo:async o=>{window.__lastNavigation=o.url}};export default Taro;`,
  );
  await writeFile(
    dir + '/main.tsx',
    `import React from 'react';import{createRoot}from'react-dom/client';import{StaffSessionPanel,Workspace}from'${root}/packages/web-ui/src/index';import Rewards from '${root}/apps/consumer-mini/src/pages/rewards/index';import Detail from '${root}/apps/consumer-mini/src/pages/reward/index';import Checkout from '${root}/apps/consumer-mini/src/pages/redemption-checkout/index';import Orders from '${root}/apps/consumer-mini/src/pages/redemptions/index';import Order from '${root}/apps/consumer-mini/src/pages/redemption/index';import ExpressAddresses from '${root}/apps/consumer-mini/src/pages/express-addresses/index';import Points from '${root}/apps/consumer-mini/src/pages/points/index';const mini=location.search.includes('mini');const style=document.createElement('link');style.rel='stylesheet';style.href=mini?'/mini.css':'/admin.css';await new Promise((done,fail)=>{style.onload=done;style.onerror=fail;document.head.appendChild(style)});createRoot(document.getElementById('root')).render(<React.StrictMode><><div style={{padding:8,background:'#fff3cd',fontSize:12}}>隔离验收 · 合成数据 · 快递确认发货 · 非生产操作</div>{mini?(location.search.includes("view=express-addresses")?<ExpressAddresses/>:location.search.includes("view=checkout")?<Checkout/>:location.search.includes("view=orders")?<Orders/>:location.search.includes("view=order&")?<Order/>:location.search.includes("view=points")?<Points/>:location.search.includes("id=")?<Detail/>:<Rewards/>):<StaffSessionPanel workspace>{(p,c)=><Workspace profile={p} sessionControl={c} mobile={location.search.includes("ops")}/>}</StaffSessionPanel>}</></React.StrictMode>);`,
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
    const path = `docs/verification/UI-E3-SHIPPING-${name}-2026-11-03.png`;
    if (!name.startsWith('MINI-'))
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
  await page.getByRole('button', { name: '积分兑换订单', exact: true }).click();
  await page.getByText('暂无匹配兑换订单', { exact: true }).waitFor();
  await shot('ADMIN-EMPTY');
  const id = await f.createExpress(),
    where = { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.catalog.skuIds[0] } };
  const before = await f.runtime.db.stockBalance.findUniqueOrThrow({ where }),
    entries = await f.runtime.db.pointsEntry.count(),
    ledgers = await f.runtime.db.stockLedger.count();
  await page.getByLabel('履约阶段', { exact: true }).selectOption('EXPRESS_WAIT_SHIP');
  await page.getByRole('button', { name: '查询兑换单', exact: true }).click();
  await page.getByRole('button', { name: '查看订单详情', exact: true }).waitFor();
  await shot('ADMIN-WAITING-LIST');
  await page.getByLabel('履约阶段', { exact: true }).selectOption('EXPRESS_SHIPPED');
  await page.getByRole('button', { name: '查询兑换单', exact: true }).click();
  await page.getByText('暂无匹配兑换订单', { exact: true }).waitFor();
  await shot('ADMIN-SHIPPED-EMPTY');
  await page.getByLabel('履约阶段', { exact: true }).selectOption('EXPRESS_WAIT_SHIP');
  await page.getByRole('button', { name: '查询兑换单', exact: true }).click();
  await f.runtime.db.stockBalance.update({ where, data: { inventoryHold: true } });
  let failShipping = true;
  await page.route('**/admin/redemptions/*/shipping', async (route) => {
    if (failShipping) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'UI_TEST', message: '合成发货资料读取失败' } }),
      });
    } else await route.continue();
  });
  await page.getByRole('button', { name: '查看订单详情', exact: true }).click();
  await page.getByText('合成发货资料读取失败', { exact: true }).waitFor();
  await shot('ADMIN-READ-ERROR');
  failShipping = false;
  await page.getByRole('button', { name: '刷新发货资料', exact: true }).click();
  await page.getByText('库存冻结或盘点中', { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '确认快递发货', exact: true }).isEnabled(),
    false,
  );
  await shot('ADMIN-INVENTORY-HELD');
  await f.runtime.db.stockBalance.update({ where, data: { inventoryHold: false } });
  await page.getByRole('button', { name: '刷新发货资料', exact: true }).click();
  await page.getByLabel('快递公司', { exact: true }).selectOption('SF');
  await page.getByLabel('快递运单号', { exact: true }).fill('bad');
  assert.equal(
    await page.getByRole('button', { name: '确认快递发货', exact: true }).isEnabled(),
    false,
  );
  await page.getByLabel('快递运单号', { exact: true }).fill('SF-E3-0000001');
  assert.equal(
    await page.getByRole('button', { name: '确认快递发货', exact: true }).isEnabled(),
    false,
  );
  await page
    .getByLabel('已核对全部实物、原收件信息和运单，确认整单已交给快递', { exact: true })
    .check();
  await shot('ADMIN-SHIP-FORM');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.express-shipping-form').scrollIntoViewIfNeeded();
  await shot('ADMIN-SHIP-FORM-MOBILE');
  await page.setViewportSize({ width: 1440, height: 1000 });
  let dropShip = true;
  await page.route('**/admin/redemptions/*/ship', async (route) => {
    if (dropShip) {
      dropShip = false;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await page.getByRole('button', { name: '确认快递发货', exact: true }).click();
  await page.getByRole('alert').waitFor();
  await shot('ADMIN-SHIP-UNKNOWN');
  await page.reload();
  await page.getByRole('button', { name: '积分兑换订单', exact: true }).click();
  await page.getByRole('button', { name: '查看订单详情', exact: true }).click();
  await page.getByRole('button', { name: '核实原发货请求', exact: true }).click();
  await page.getByRole('heading', { name: '已快递发货', exact: true }).waitFor();
  await page
    .getByRole('button', { name: '核实原发货请求', exact: true })
    .waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('button', { name: '确认快递发货', exact: true }).count(), 0);
  await shot('ADMIN-SHIP-RECOVERED');
  assert.equal(
    await page.getByRole('button', { name: '刷新发货资料', exact: true }).isEnabled(),
    true,
  );
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
  await mini.goto('http://127.0.0.1:5188/?mini&view=order&id=' + id);
  await mini.getByText('已快递发货', { exact: true }).waitFor();
  await mini.getByText('运单号：SF-E3-0000001', { exact: true }).waitFor();
  assert.equal(
    await mini.getByRole('button', { name: '取消兑换并退还 120 积分', exact: true }).count(),
    0,
  );
  await mini.getByRole('button', { name: '复制运单号', exact: true }).click();
  await mini.waitForFunction(() => window.__clipboard === 'SF-E3-0000001');
  await shot('MINI-SHIPPED', mini);
  await page.getByRole('button', { name: '打印本单', exact: true }).click();
  const frame = await (
    await page.locator('iframe[title="订单配货单预览"]').elementHandle()
  ).contentFrame();
  await frame.getByText('已快递发货：顺丰速运 · 运单号：SF-E3-0000001', { exact: true }).waitFor();
  await shot('ADMIN-SHIPPED-PRINT');
  await page.getByRole('button', { name: '关闭打印预览', exact: true }).click();
  await page.getByRole('button', { name: '返回兑换订单列表', exact: true }).click();
  await page.getByLabel('履约阶段', { exact: true }).selectOption('EXPRESS_SHIPPED');
  await page.getByRole('button', { name: '查询兑换单', exact: true }).click();
  await page.getByRole('button', { name: '查看订单详情', exact: true }).waitFor();
  await shot('ADMIN-SHIPPED-LIST');
  await page.getByRole('button', { name: '查看订单详情', exact: true }).click();
  await page.getByRole('heading', { name: '已快递发货', exact: true }).waitFor();
  const after = await f.runtime.db.stockBalance.findUniqueOrThrow({ where });
  assert.equal(after.onHand, before.onHand - 1);
  assert.equal(after.reserved, before.reserved - 1);
  assert.equal(await f.runtime.db.pointsEntry.count(), entries);
  assert.equal(await f.runtime.db.stockLedger.count(), ledgers + 1);
  assert.equal(await f.runtime.db.redemptionExpressShipment.count(), 1);
  assert.equal(await f.runtime.db.redemptionPickingTask.count(), 0);
  const actor = await f.runtime.db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } });
  await f.runtime.db.staffWarehouse.deleteMany({
    where: { staffId: actor.id, warehouseId: f.warehouseId },
  });
  await page.getByRole('button', { name: '刷新发货资料', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByText('合成快递收件人 · 00000000000', { exact: true }).count(), 0);
  await shot('ADMIN-ACCESS-REMOVED');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ passed: true, screenshots: shots, actualCarrier: false, nativeWechat: false }),
  );
} finally {
  for (const release of releases) release();
  await browser?.close();
  await server?.close();
  await f.cleanup();
}
