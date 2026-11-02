/* global document, innerWidth, window, localStorage */
// Actual React pages + real API + disposable PG schema. Browser mini adapter is not native WeChat.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { redemptionPickingFixture } from '../../tests/helpers/redemption-picking-fixture.ts';
import {
  runRedemptionPickingOnce,
  leaseRedemptionPicking,
} from '../../packages/database/dist/index.js';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd().replaceAll('\\', '/'),
  dir = resolve('.local/redemption-picking-ui');
const { createServer, build } =
  await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const f = await redemptionPickingFixture();
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
    `import React from 'react';export const View=({children,...p})=><div {...p}>{children}</div>;export const Text=({children,...p})=><span {...p}>{children}</span>;export const Button=({children,...p})=><button {...p}>{children}</button>;export const Input=({onInput,onConfirm,maxlength,...p})=><input {...p} maxLength={maxlength} onChange={e=>onInput?.({detail:{value:e.target.value}})} onKeyDown={e=>{if(e.key==='Enter')onConfirm?.()}}/>;export const Picker=({range,onChange,value,disabled})=><select aria-label="收货地址" disabled={disabled} value={value} onChange={e=>onChange({detail:{value:e.target.value}})}>{range.map((v,i)=><option key={i} value={i}>{v}</option>)}</select>;export const Image=({src,mode,...p})=><img src={src} {...p}/>;`,
  );
  await writeFile(
    dir + '/taro.ts',
    `import {useEffect} from 'react';export function useDidShow(fn){useEffect(()=>{fn();window.addEventListener('yumi:show',fn);return()=>window.removeEventListener('yumi:show',fn)},[])}export function useRouter(){return {params:Object.fromEntries(new URLSearchParams(location.search))}};export function useDidHide(fn){useEffect(()=>{window.addEventListener('yumi:hide',fn);return()=>window.removeEventListener('yumi:hide',fn)},[])}const Taro={getStorageSync:k=>JSON.parse(localStorage.getItem(k)||'null'),setStorageSync:(k,v)=>localStorage.setItem(k,JSON.stringify(v)),removeStorageSync:k=>localStorage.removeItem(k),request:async o=>{const r=await fetch('/api/v1'+o.url.split('/api/v1')[1],{method:o.method,headers:o.header,body:o.method==='GET'?undefined:JSON.stringify(o.data)});return {statusCode:r.status,data:await r.json()}},navigateTo:async o=>{window.__lastNavigation=o.url}};export default Taro;`,
  );
  await writeFile(
    dir + '/main.tsx',
    `import React from 'react';import{createRoot}from'react-dom/client';import{StaffSessionPanel,Workspace}from'${root}/packages/web-ui/src/index';import Rewards from '${root}/apps/consumer-mini/src/pages/rewards/index';import Detail from '${root}/apps/consumer-mini/src/pages/reward/index';import Checkout from '${root}/apps/consumer-mini/src/pages/redemption-checkout/index';import Orders from '${root}/apps/consumer-mini/src/pages/redemptions/index';import Order from '${root}/apps/consumer-mini/src/pages/redemption/index';import Points from '${root}/apps/consumer-mini/src/pages/points/index';const mini=location.search.includes('mini');const style=document.createElement('link');style.rel='stylesheet';style.href=mini?'/mini.css':'/admin.css';await new Promise((done,fail)=>{style.onload=done;style.onerror=fail;document.head.appendChild(style)});createRoot(document.getElementById('root')).render(<><div style={{padding:8,background:'#fff3cd',fontSize:12}}>隔离验收 · 合成数据 · 隔离验收 · 真实兑换来源拣货 · 尚未出库</div>{mini?(location.search.includes("view=checkout")?<Checkout/>:location.search.includes("view=orders")?<Orders/>:location.search.includes("view=order&")?<Order/>:location.search.includes("view=points")?<Points/>:location.search.includes("id=")?<Detail/>:<Rewards/>):<StaffSessionPanel workspace>{(p,c)=><Workspace profile={p} sessionControl={c} mobile={location.search.includes("ops")}/>}</StaffSessionPanel>}</>);`,
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
    const path = `docs/verification/UI-REDEMPTION-PICKING-${name}-2026-11-02.png`;
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
    await p.screenshot({ path, fullPage: !name.startsWith('MINI-') });
    shots.push(path);
    assert.ok(
      await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'overflow: ' + name,
    );
  }
  await page.goto('http://127.0.0.1:5188');
  await page.getByRole('button', { name: '兑换拣货', exact: true }).click();
  await page.getByText('暂无匹配兑换拣货任务', { exact: true }).waitFor();
  await shot('ADMIN-EMPTY');
  const id = await f.order();
  await page.getByRole('button', { name: '刷新作业', exact: true }).click();
  await page.getByRole('button', { name: '查看拣货详情', exact: true }).click();
  await page.getByText('待建拣货任务', { exact: true }).waitFor();
  await shot('ADMIN-QUEUED');
  await runRedemptionPickingOnce(f.runtime.db);
  await page.getByRole('button', { name: '刷新作业', exact: true }).click();
  await page.getByRole('button', { name: '领取并开始本人拣货', exact: true }).waitFor();
  await shot('ADMIN-READY');
  await f.runtime.db.stockBalance.update({
    where: { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.catalog.skuIds[0] } },
    data: { inventoryHold: true },
  });
  await page.getByRole('button', { name: '刷新作业', exact: true }).click();
  await page.getByText('库存冻结或预占不足', { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '领取并开始本人拣货', exact: true }).isDisabled(),
    true,
  );
  await shot('ADMIN-BLOCKED');
  await f.runtime.db.stockBalance.update({
    where: { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.catalog.skuIds[0] } },
    data: { inventoryHold: false },
  });
  const actor = await f.workerActor();
  const opsContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await opsContext.addCookies([
    {
      name: 'yumi_staff_session',
      value: actor.cookie.split('=')[1],
      domain: '127.0.0.1',
      path: '/',
    },
  ]);
  const ops = await opsContext.newPage();
  ops.on('pageerror', (e) => errors.push(e.message));
  await ops.goto('http://127.0.0.1:5188/?ops');
  await ops.getByRole('button', { name: '兑换拣货', exact: true }).click();
  await ops.getByRole('button', { name: '查看拣货详情', exact: true }).click();
  await ops.getByRole('button', { name: '领取并开始本人拣货', exact: true }).waitFor();
  await shot('OPS-READY', ops);
  let drop = true;
  await ops.route('**/api/v1/warehouse/warehouses/*/redemption-picking/*/claim', async (route) => {
    if (drop) {
      drop = false;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await ops.getByRole('button', { name: '领取并开始本人拣货', exact: true }).click();
  await ops.getByRole('alert').waitFor();
  await ops.getByRole('button', { name: '使用原请求核实领取', exact: true }).waitFor();
  await shot('OPS-UNKNOWN', ops);
  // Persisted key survives reload; an independently resumed request must not add a second claim.
  await ops.reload();
  await ops.getByRole('button', { name: '使用原请求核实领取', exact: true }).waitFor();
  await ops.getByRole('button', { name: '使用原请求核实领取', exact: true }).click();
  await ops.getByText('领取人：合成拣货员（本人）', { exact: true }).waitFor();
  await shot('OPS-CLAIMED', ops);
  assert.equal(
    await f.runtime.db.redemptionPickingEvent.count({ where: { orderId: id, action: 'CLAIMED' } }),
    1,
  );
  await page.getByRole('button', { name: '刷新作业', exact: true }).click();
  await page.getByText('领取人：合成拣货员', { exact: true }).waitFor();
  await shot('ADMIN-CLAIMED');
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
  await mini.getByText('仓库已领取，正在准备拣货；尚未出库或配送。', { exact: true }).waitFor();
  assert.equal(
    await mini.getByRole('button', { name: '取消兑换并退还 120 积分', exact: true }).count(),
    0,
  );
  await shot('MINI-PICKING', mini);
  assert.equal(
    (await f.call('/consumer/redemptions/' + id + '/cancel', { version: 0 })).error.code,
    'CANCELLATION_REVIEW_REQUIRED',
  );
  const second = await f.order();
  await runRedemptionPickingOnce(f.runtime.db);
  await mini.goto('http://127.0.0.1:5188/?mini&view=order&id=' + second);
  await mini.getByText('已创建拣货任务，等待仓库领取。', { exact: true }).waitFor();
  await shot('MINI-READY', mini);
  await mini.getByRole('button', { name: '取消兑换并退还 120 积分', exact: true }).click();
  await mini.getByText('积分已退还，库存和限兑配额已释放。', { exact: true }).waitFor();
  await shot('MINI-CANCELED', mini);
  const canceled = await f.runtime.db.redemptionPickingTask.findUniqueOrThrow({
    where: { orderId: second },
  });
  assert.equal(canceled.state, 'CANCELED');
  await page.getByRole('button', { name: '返回拣货列表', exact: true }).click();
  await page.getByRole('combobox', { name: '任务状态', exact: true }).selectOption('CANCELED');
  await page.getByRole('button', { name: '查询作业', exact: true }).click();
  await page.getByRole('status').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '查看拣货详情', exact: true }).click();
  await page.locator('.picking-state').getByText('已取消', { exact: true }).waitFor();
  await shot('ADMIN-CANCELED');
  const third = await f.order();
  for (let attempt = 0; attempt < 3; attempt++) {
    await leaseRedemptionPicking(f.runtime.db, 1);
    await delay(1100);
  }
  await leaseRedemptionPicking(f.runtime.db, 1);
  assert.equal(
    (await f.runtime.db.redemptionOutbox.findUniqueOrThrow({ where: { orderId: third } })).state,
    'FAILED',
  );
  await page.getByRole('button', { name: '返回拣货列表', exact: true }).click();
  await page.getByRole('combobox', { name: '任务状态', exact: true }).selectOption('FAILED');
  await page.getByRole('button', { name: '查询作业', exact: true }).click();
  await page.getByRole('status').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '查看拣货详情', exact: true }).click();
  await page.getByRole('button', { name: '核查后重试创建任务', exact: true }).waitFor();
  await shot('ADMIN-FAILED');
  await page.getByRole('button', { name: '核查后重试创建任务', exact: true }).click();
  await page.getByText('等待自动重试', { exact: true }).waitFor();
  await shot('ADMIN-RETRY');
  await runRedemptionPickingOnce(f.runtime.db);
  await page.getByRole('button', { name: '刷新作业', exact: true }).click();
  await page.getByRole('button', { name: '领取并开始本人拣货', exact: true }).waitFor();
  await shot('ADMIN-RECOVERED');
  let fail = true;
  await ops.route('**/api/v1/warehouse/warehouses/*/redemption-picking/*', (route) =>
    fail
      ? route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: '合成拣货读取失败' } }),
        })
      : route.continue(),
  );
  await ops.getByRole('button', { name: '刷新作业', exact: true }).click();
  await ops.getByRole('alert').waitFor();
  await shot('OPS-ERROR', ops);
  fail = false;
  await ops.getByRole('button', { name: '重试读取', exact: true }).click();
  await ops.getByText('领取人：合成拣货员（本人）', { exact: true }).waitFor();
  let release;
  const gate = new Promise((done) => {
    release = done;
  });
  releases.push(() => release());
  await ops.route('**/api/v1/warehouse/warehouses/*/redemption-picking/*', async (route) => {
    await gate;
    await route.continue();
  });
  await ops.getByRole('button', { name: '刷新作业', exact: true }).click();
  await ops.getByRole('status').waitFor();
  await shot('OPS-LOADING', ops);
  release();
  await ops.getByRole('status').waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, screenshots: shots }));
} finally {
  for (const release of releases) release();
  if (browser) await browser.close();
  if (server) await server.close();
  await f.cleanup();
}
