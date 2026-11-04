/* global document, innerWidth, window, localStorage */
// Actual React pages + real API + disposable PG schema. Browser mini adapter is not native WeChat.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { redemptionDeliveryFixture } from '../../tests/helpers/redemption-delivery-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd().replaceAll('\\', '/'),
  dir = resolve('.local/redemption-delivery-ui');
const { createServer, build } =
  await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const f = await redemptionDeliveryFixture();
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
    `import React from 'react';export const ScrollView=({scrollX,children,...p})=><div style={{overflowX:scrollX?'auto':undefined}} {...p}>{children}</div>;export const View=({children,...p})=><div {...p}>{children}</div>;export const Text=({children,...p})=><span {...p}>{children}</span>;export const Button=({children,...p})=><button {...p}>{children}</button>;export const Input=({onInput,onConfirm,maxlength,...p})=><input {...p} maxLength={maxlength} onChange={e=>onInput?.({detail:{value:e.target.value}})} onKeyDown={e=>{if(e.key==='Enter')onConfirm?.()}}/>;export const Picker=({range,onChange,value,disabled})=><select aria-label="收货地址" disabled={disabled} value={value} onChange={e=>onChange({detail:{value:e.target.value}})}>{range.map((v,i)=><option key={i} value={i}>{v}</option>)}</select>;export const Image=({src,mode,...p})=><img src={src} {...p}/>;`,
  );
  await writeFile(
    dir + '/taro.ts',
    `import {useEffect} from 'react';export function useDidShow(fn){useEffect(()=>{fn();window.addEventListener('yumi:show',fn);return()=>window.removeEventListener('yumi:show',fn)},[])}export function useRouter(){return {params:Object.fromEntries(new URLSearchParams(location.search))}};export function useDidHide(fn){useEffect(()=>{window.addEventListener('yumi:hide',fn);return()=>window.removeEventListener('yumi:hide',fn)},[])}const Taro={getStorageSync:k=>JSON.parse(localStorage.getItem(k)||'null'),setStorageSync:(k,v)=>localStorage.setItem(k,JSON.stringify(v)),removeStorageSync:k=>localStorage.removeItem(k),request:async o=>{const r=await fetch('/api/v1'+o.url.split('/api/v1')[1],{method:o.method,headers:o.header,body:o.method==='GET'?undefined:JSON.stringify(o.data)});return {statusCode:r.status,data:await r.json()}},navigateTo:async o=>{window.__lastNavigation=o.url}};export default Taro;`,
  );
  await writeFile(
    dir + '/main.tsx',
    `import React from 'react';import{createRoot}from'react-dom/client';import{StaffSessionPanel,Workspace}from'${root}/packages/web-ui/src/index';import Rewards from '${root}/apps/consumer-mini/src/pages/rewards/index';import Detail from '${root}/apps/consumer-mini/src/pages/reward/index';import Checkout from '${root}/apps/consumer-mini/src/pages/redemption-checkout/index';import Orders from '${root}/apps/consumer-mini/src/pages/redemptions/index';import Order from '${root}/apps/consumer-mini/src/pages/redemption/index';import Points from '${root}/apps/consumer-mini/src/pages/points/index';const mini=location.search.includes('mini');const style=document.createElement('link');style.rel='stylesheet';style.href=mini?'/mini.css':'/admin.css';await new Promise((done,fail)=>{style.onload=done;style.onerror=fail;document.head.appendChild(style)});createRoot(document.getElementById('root')).render(<><div style={{padding:8,background:'#fff3cd',fontSize:12}}>隔离验收 · 合成数据 · 兑换骑手分配与接货 · 非生产操作</div>{mini?(location.search.includes("view=checkout")?<Checkout/>:location.search.includes("view=orders")?<Orders/>:location.search.includes("view=order&")?<Order/>:location.search.includes("view=points")?<Points/>:location.search.includes("id=")?<Detail/>:<Rewards/>):<StaffSessionPanel workspace>{(p,c)=><Workspace profile={p} sessionControl={c} mobile={location.search.includes("ops")}/>}</StaffSessionPanel>}</>);`,
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
    const path = `docs/verification/UI-REDEMPTION-RETURN-${name}-2026-11-03.png`;
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
  await page.getByRole('button', { name: '兑换骑手交接', exact: true }).click();
  await page.getByText('暂无匹配的兑换交接单', { exact: true }).waitFor();
  await shot('ADMIN-EMPTY');
  const shipment = await f.shipment();
  await page.getByRole('button', { name: '刷新交接', exact: true }).click();
  await page.getByRole('button', { name: '查看交接详情', exact: true }).click();
  await page.getByText('暂无有效本仓骑手，请先核实人员角色和仓库授权。', { exact: true }).waitFor();
  await shot('ADMIN-NO-RIDERS');
  let failRiders = true;
  await page.route('**/redemption-delivery/riders', async (route) => {
    if (failRiders) {
      failRiders = false;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'UI_TEST', message: '合成骑手读取失败' } }),
      });
    } else await route.continue();
  });
  await page.getByRole('button', { name: '刷新本仓骑手', exact: true }).click();
  await page.getByText('合成骑手读取失败', { exact: true }).waitFor();
  await shot('ADMIN-RIDERS-ERROR');
  const rider = await f.workerActor('RIDER'),
    other = await f.workerActor('RIDER');
  await f.runtime.db.staff.update({ where: { id: rider.id }, data: { displayName: '合成骑手甲' } });
  await f.runtime.db.staff.update({ where: { id: other.id }, data: { displayName: '合成骑手乙' } });
  async function riderPage(actor) {
    const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await c.addCookies([
      {
        name: 'yumi_staff_session',
        value: actor.cookie.split('=')[1],
        domain: '127.0.0.1',
        path: '/',
      },
    ]);
    const p = await c.newPage();
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto('http://127.0.0.1:5188/?ops');
    await p.getByRole('button', { name: '兑换骑手交接', exact: true }).click();
    return p;
  }
  const ops = await riderPage(rider),
    otherPage = await riderPage(other);
  await ops.getByText('暂无匹配的兑换交接单', { exact: true }).waitFor();
  await shot('RIDER-EMPTY', ops);
  await page.getByRole('button', { name: '刷新本仓骑手', exact: true }).click();
  await page
    .getByRole('option', { name: '合成骑手甲', exact: true })
    .waitFor({ state: 'attached' });
  await page.getByLabel('接货骑手', { exact: true }).selectOption(rider.id);
  await shot('ADMIN-ASSIGN-FORM');
  let dropAssign = true;
  await page.route('**/redemption-delivery/*/assign', async (route) => {
    if (dropAssign) {
      dropAssign = false;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await page.getByRole('button', { name: '确认分配骑手', exact: true }).click();
  await page.getByRole('alert').waitFor();
  await shot('ADMIN-ASSIGN-UNKNOWN');
  await page.reload();
  await page.getByRole('button', { name: '使用原请求核实分配', exact: true }).click();
  await page.locator('.delivery-state').filter({ hasText: '已分配 · 待骑手接货' }).waitFor();
  await shot('ADMIN-ASSIGNED');

  await ops.getByRole('button', { name: '刷新交接', exact: true }).click();
  await ops.getByRole('button', { name: '查看交接详情', exact: true }).click();
  await ops.getByRole('heading', { name: '本人核对接货', exact: true }).waitFor();
  await shot('OLD-RIDER-DETAIL', ops);

  await ops.getByLabel('实际接货包裹数', { exact: true }).fill('2');
  await ops.getByRole('spinbutton', { name: /接货件数/ }).fill('1');
  await ops.getByLabel('已核验包裹及每项实物，确认本人接货', { exact: true }).check();
  await ops.getByRole('button', { name: '确认本人接货', exact: true }).click();
  await ops.locator('.delivery-state').filter({ hasText: '骑手已接货 · 待开始配送' }).waitFor();
  await ops.getByLabel('已携带本单全部包裹，确认实际出发配送', { exact: true }).check();
  await ops.getByRole('button', { name: '确认开始配送', exact: true }).click();
  await ops.locator('.delivery-state').filter({ hasText: '骑手配送中' }).waitFor();
  await ops.getByLabel('异常说明', { exact: true }).fill('合成联系不到收货人，完整包裹交回仓管');
  await ops.getByRole('button', { name: '提交配送异常', exact: true }).click();
  await ops.getByText('配送异常待处理', { exact: true }).waitFor();
  await shot('OLD-RIDER-EXCEPTION', ops);
  await page.getByRole('button', { name: '刷新交接', exact: true }).click();
  await page.getByRole('heading', { name: '核验整单实物回交', exact: true }).waitFor();
  await page
    .getByLabel('回交原因', { exact: true })
    .fill('合成联系恢复待重新安排；全部原包裹已完整完好接收');
  await page.getByLabel('实际回交包裹数', { exact: true }).fill('1');
  await page.getByRole('spinbutton', { name: /回交件数/ }).fill('1');
  await page
    .getByLabel('已收到原单全部包裹，逐项完整完好，可重新安排配送', { exact: true })
    .check();
  assert.equal(
    await page.getByRole('button', { name: '确认完整回交仓库', exact: true }).isEnabled(),
    false,
  );
  await shot('ADMIN-RETURN-COUNT-MISMATCH');
  await page.getByLabel('实际回交包裹数', { exact: true }).fill('2');
  await page.getByLabel('已核验原地址及异常情况，可重新安排配送', { exact: true }).check();
  await shot('ADMIN-RETURN-FORM');
  let dropReturn = true;
  await page.route('**/redemption-delivery/*/return-custody', async (route) => {
    if (dropReturn) {
      dropReturn = false;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await page.getByRole('button', { name: '确认完整回交仓库', exact: true }).click();
  await page.getByRole('alert').waitFor();
  await shot('ADMIN-RETURN-UNKNOWN');
  await page.reload();
  await page.getByRole('button', { name: '使用原请求核实实物回交', exact: true }).click();
  await page.locator('.delivery-state').filter({ hasText: '已出库 · 待分配骑手' }).waitFor();
  await page.getByRole('heading', { name: '实物回交与保管记录', exact: true }).waitFor();
  await shot('ADMIN-RETURNED');
  await ops.getByRole('button', { name: '刷新交接', exact: true }).click();
  await ops.getByRole('alert').waitFor();
  await ops.getByText('合成验证联系人', { exact: false }).waitFor({ state: 'hidden' });
  assert.equal(await ops.getByText('合成验证联系人', { exact: false }).count(), 0);
  await shot('OLD-RIDER-ACCESS-REMOVED', ops);
  const mini = await context.newPage();
  await mini.setViewportSize({ width: 390, height: 844 });
  await mini.addInitScript(
    (identity) =>
      localStorage.setItem(
        'yumi.consumer-session.v1:http://127.0.0.1:3000/api/v1',
        JSON.stringify({ token: identity.token, expiresAt: identity.expiresAt }),
      ),
    f.identity,
  );
  await mini.goto('http://127.0.0.1:5188/?mini&view=order&id=' + shipment.orderId);
  await mini.getByText('包裹已回交，等待门店重新安排配送。', { exact: true }).waitFor();
  await shot('MINI-RETURNED', mini);
  await page.getByRole('button', { name: '刷新本仓骑手', exact: true }).click();
  await page
    .getByRole('option', { name: '合成骑手乙', exact: true })
    .waitFor({ state: 'attached' });
  await page.getByLabel('接货骑手', { exact: true }).selectOption(other.id);
  await page.getByRole('button', { name: '确认分配骑手', exact: true }).click();
  await page.locator('.delivery-state').filter({ hasText: '已分配 · 待骑手接货' }).waitFor();
  await shot('ADMIN-REASSIGNED');
  await otherPage.getByRole('button', { name: '刷新交接', exact: true }).click();
  await otherPage.getByRole('button', { name: '查看交接详情', exact: true }).click();
  await otherPage.getByRole('heading', { name: '本人核对接货', exact: true }).waitFor();
  assert.equal(
    await otherPage.getByRole('heading', { name: '实物回交与保管记录', exact: true }).count(),
    0,
  );
  await otherPage.getByLabel('实际接货包裹数', { exact: true }).fill('2');
  await otherPage.getByRole('spinbutton', { name: /接货件数/ }).fill('1');
  await otherPage.getByLabel('已核验包裹及每项实物，确认本人接货', { exact: true }).check();
  await shot('NEW-RIDER-ACCEPT-FORM', otherPage);
  await otherPage.getByRole('button', { name: '确认本人接货', exact: true }).click();
  await otherPage
    .locator('.delivery-state')
    .filter({ hasText: '骑手已接货 · 待开始配送' })
    .waitFor();
  await otherPage.getByLabel('已携带本单全部包裹，确认实际出发配送', { exact: true }).check();
  await otherPage.getByRole('button', { name: '确认开始配送', exact: true }).click();
  await otherPage.locator('.delivery-state').filter({ hasText: '骑手配送中' }).waitFor();
  await otherPage.getByLabel('已按原收货地址将全部包裹交付收货人', { exact: true }).check();
  await otherPage.getByRole('button', { name: '确认全部送达', exact: true }).click();
  await otherPage.locator('.delivery-state').filter({ hasText: '骑手已确认送达' }).waitFor();
  await shot('NEW-RIDER-COMPLETED', otherPage);
  await page.getByRole('button', { name: '刷新交接', exact: true }).click();
  await page.locator('.delivery-state').filter({ hasText: '骑手已确认送达' }).waitFor();
  assert.equal(
    await page.getByRole('heading', { name: '核验整单实物回交', exact: true }).count(),
    0,
  );
  await shot('ADMIN-COMPLETED-HISTORY');
  await mini.reload();
  await mini.getByText('骑手已确认送达。', { exact: true }).waitFor();
  await mini
    .getByText('曾回交仓库，以下为重新安排的配送进度；积分未重复扣减。', { exact: true })
    .waitFor();
  await shot('MINI-COMPLETED', mini);
  assert.equal(await f.runtime.db.redemptionHandoff.count(), 2);
  assert.equal(await f.runtime.db.redemptionCustodyReturn.count(), 1);
  assert.equal(await f.runtime.db.redemptionJourneyFact.count(), 3);
  assert.equal(await f.runtime.db.redemptionDeliveryException.count(), 1);
  assert.equal(await f.runtime.db.redemptionDeliveryResolution.count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, screenshots: shots }));
} finally {
  for (const release of releases) release();
  await browser?.close();
  await server?.close();
  await f.cleanup();
}
