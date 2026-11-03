/* global document, innerWidth, window, localStorage, Event */
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
  dir = resolve('.local/redemption-after-sales-ui');
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
    `import React from 'react';import{createRoot}from'react-dom/client';import{StaffSessionPanel,Workspace}from'${root}/packages/web-ui/src/index';import Rewards from '${root}/apps/consumer-mini/src/pages/rewards/index';import Detail from '${root}/apps/consumer-mini/src/pages/reward/index';import Checkout from '${root}/apps/consumer-mini/src/pages/redemption-checkout/index';import Orders from '${root}/apps/consumer-mini/src/pages/redemptions/index';import Order from '${root}/apps/consumer-mini/src/pages/redemption/index';import ExpressAddresses from '${root}/apps/consumer-mini/src/pages/express-addresses/index';import Points from '${root}/apps/consumer-mini/src/pages/points/index';const mini=location.search.includes('mini');const style=document.createElement('link');style.rel='stylesheet';style.href=mini?'/mini.css':'/admin.css';await new Promise((done,fail)=>{style.onload=done;style.onerror=fail;document.head.appendChild(style)});createRoot(document.getElementById('root')).render(<React.StrictMode><><div style={{padding:8,background:'#fff3cd',fontSize:12}}>隔离验收 · 合成数据 · 售后反馈 · 非生产操作</div>{mini?(location.search.includes("view=express-addresses")?<ExpressAddresses/>:location.search.includes("view=checkout")?<Checkout/>:location.search.includes("view=orders")?<Orders/>:location.search.includes("view=order&")?<Order/>:location.search.includes("view=points")?<Points/>:location.search.includes("id=")?<Detail/>:<Rewards/>):<StaffSessionPanel workspace>{(p,c)=><Workspace profile={p} sessionControl={c} mobile={location.search.includes("ops")}/>}</StaffSessionPanel>}</></React.StrictMode>);`,
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
    const path = `docs/verification/UI-E4B-AFTERSALES-${name}-2026-11-03.png`;
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
  await page.getByRole('button', { name: '兑换售后反馈', exact: true }).click();
  await page.getByText('暂无匹配售后反馈', { exact: true }).waitFor();
  await shot('ADMIN-EMPTY');
  const id = await f.createExpress();
  assert.equal(
    (
      await f.api('/admin/redemptions/' + id + '/ship', {
        version: 0,
        carrierCode: 'SF',
        trackingNo: 'SF-E4B-UI-001',
        dispatchConfirmed: true,
      })
    ).status,
    200,
  );
  const d = f.runtime.db,
    where = { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.catalog.skuIds[0] } },
    before = await d.stockBalance.findUniqueOrThrow({ where }),
    entries = await d.pointsEntry.count(),
    ledgers = await d.stockLedger.count();
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
  let failRead = true;
  await mini.route('**/consumer/redemptions/*/after-sales', async (route) => {
    if (failRead && route.request().method() === 'GET')
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'UI_TEST', message: '合成反馈进度读取失败' } }),
      });
    else await route.continue();
  });
  await mini.goto('http://127.0.0.1:5188/?mini&view=order&id=' + id);
  await mini.getByText('合成反馈进度读取失败', { exact: true }).waitFor();
  await mini.getByText('售后反馈', { exact: true }).scrollIntoViewIfNeeded();
  await shot('MINI-READ-ERROR', mini);
  failRead = false;
  await mini.getByRole('button', { name: '刷新反馈进度', exact: true }).click();
  await mini.getByText('暂无售后反馈', { exact: true }).waitFor();
  assert.equal(
    await mini.getByRole('button', { name: '提交售后反馈', exact: true }).isEnabled(),
    false,
  );
  await mini.locator('select').selectOption('1');
  await mini
    .getByPlaceholder('请描述商品或配送问题（最多500字）')
    .fill('合成包装破损，需要门店核实');
  await mini.getByText('售后反馈', { exact: true }).scrollIntoViewIfNeeded();
  await shot('MINI-FORM', mini);
  let dropCreate = true;
  await mini.route('**/consumer/redemptions/*/after-sales', async (route) => {
    if (dropCreate && route.request().method() === 'POST') {
      dropCreate = false;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await route.abort('failed');
    } else await route.continue();
  });
  await mini.getByRole('button', { name: '提交售后反馈', exact: true }).click();
  await mini.getByRole('button', { name: '核实原反馈请求', exact: true }).waitFor();
  await mini
    .getByText('有一笔反馈请求待核实，请保留原请求。', { exact: true })
    .scrollIntoViewIfNeeded();
  await shot('MINI-UNKNOWN', mini);
  await mini.reload();
  await mini.getByRole('button', { name: '核实原反馈请求', exact: true }).click();
  await mini
    .getByRole('button', { name: '核实原反馈请求', exact: true })
    .waitFor({ state: 'hidden' });
  await mini.getByText('待门店处理', { exact: true }).waitFor();
  await mini.getByText('售后反馈', { exact: true }).scrollIntoViewIfNeeded();
  await shot('MINI-SUBMITTED', mini);
  await page.getByRole('button', { name: '刷新售后反馈', exact: true }).click();
  await page.getByRole('button', { name: '查看反馈详情', exact: true }).click();
  await page.getByText('合成包装破损，需要门店核实', { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '发送回复', exact: true }).isEnabled(),
    false,
  );
  await page.getByLabel('回复内容', { exact: true }).fill('合成门店回复：已收到反馈，正在核实');
  await page.getByLabel('确认将此回复展示给用户', { exact: true }).check();
  await shot('ADMIN-REPLY-FORM');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('回复内容', { exact: true }).scrollIntoViewIfNeeded();
  await shot('ADMIN-REPLY-MOBILE');
  await page.setViewportSize({ width: 1440, height: 1000 });
  let dropReply = true;
  await page.route('**/admin/redemption-after-sales/*/reply', async (route) => {
    if (dropReply) {
      dropReply = false;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await route.abort('failed');
    } else await route.continue();
  });
  await page.getByRole('button', { name: '发送回复', exact: true }).click();
  await page.getByRole('button', { name: '核实原处理请求', exact: true }).waitFor();
  await page.getByRole('alert').waitFor();
  await shot('ADMIN-UNKNOWN');
  await page.reload();
  await page.getByRole('button', { name: '兑换售后反馈', exact: true }).click();
  await page.getByRole('button', { name: '查看反馈详情', exact: true }).click();
  await page.getByRole('button', { name: '核实原处理请求', exact: true }).click();
  await page
    .getByRole('button', { name: '核实原处理请求', exact: true })
    .waitFor({ state: 'hidden' });
  await page.getByText('合成门店回复：已收到反馈，正在核实', { exact: true }).waitFor();
  await shot('ADMIN-REPLIED');
  await mini.getByRole('button', { name: '刷新反馈进度', exact: true }).click();
  await mini.getByText('合成门店回复：已收到反馈，正在核实', { exact: true }).waitFor();
  await mini.getByText('门店回复', { exact: true }).scrollIntoViewIfNeeded();
  await shot('MINI-PROGRESS', mini);
  await mini.getByPlaceholder('补充问题说明（最多500字）').fill('合成补充：外包装有破损');
  await mini.getByRole('button', { name: '补充说明', exact: true }).click();
  await mini.getByText('合成补充：外包装有破损', { exact: true }).waitFor();
  await page.getByLabel('处理方式', { exact: true }).selectOption('close');
  await page.getByLabel('回复内容', { exact: true }).fill('合成已沟通完成');
  await page.getByLabel('确认将此回复展示给用户，并结束本次反馈', { exact: true }).check();
  await page.getByRole('button', { name: '回复并结束本次反馈', exact: true }).click();
  await page.getByText('反馈进度已变化，请刷新后再操作', { exact: true }).waitFor();
  assert.equal(await page.getByText('合成包装破损，需要门店核实', { exact: true }).count(), 0);
  await shot('ADMIN-STALE');
  await page.getByRole('button', { name: '刷新售后反馈', exact: true }).click();
  await page.getByText('合成补充：外包装有破损', { exact: true }).waitFor();
  await page.getByLabel('处理方式', { exact: true }).selectOption('close');
  await page
    .getByLabel('回复内容', { exact: true })
    .fill('合成沟通结果：本次反馈结束，如仍需帮助可重新反馈');
  await page.getByLabel('确认将此回复展示给用户，并结束本次反馈', { exact: true }).check();
  await page.getByRole('button', { name: '回复并结束本次反馈', exact: true }).click();
  await page.getByText('本次反馈已结束，用户需要帮助时可重新反馈。', { exact: true }).waitFor();
  await mini.getByRole('button', { name: '刷新反馈进度', exact: true }).click();
  await mini.getByText('本次反馈已结束', { exact: true }).waitFor();
  await mini.getByText('门店处理说明', { exact: true }).scrollIntoViewIfNeeded();
  await shot('MINI-CLOSED', mini);
  await mini.getByPlaceholder('仍需帮助？请说明原因重新反馈').fill('合成仍需帮助，重新反馈');
  await mini.getByRole('button', { name: '重新反馈', exact: true }).click();
  await mini.getByRole('button', { name: '补充说明', exact: true }).waitFor();
  await mini.getByText('合成仍需帮助，重新反馈', { exact: true }).waitFor();
  await mini.getByText('合成仍需帮助，重新反馈', { exact: true }).scrollIntoViewIfNeeded();
  await shot('MINI-REOPENED', mini);
  await page.getByRole('button', { name: '返回售后反馈列表', exact: true }).click();
  await page.getByLabel('反馈状态', { exact: true }).selectOption('CLOSED');
  await page.getByRole('button', { name: '查询反馈', exact: true }).click();
  await page.getByText('暂无匹配售后反馈', { exact: true }).waitFor();
  await shot('ADMIN-FILTER-EMPTY');
  await page.getByLabel('反馈状态', { exact: true }).selectOption('OPEN');
  await page.getByRole('button', { name: '查询反馈', exact: true }).click();
  await page.getByRole('button', { name: '查看反馈详情', exact: true }).click();
  await page.getByText('合成仍需帮助，重新反馈', { exact: true }).waitFor();
  await mini.evaluate((identity) => {
    window.dispatchEvent(new Event('yumi:hide'));
    localStorage.setItem(
      'yumi.consumer-session.v1:http://127.0.0.1:3000/api/v1',
      JSON.stringify({ token: identity.token, expiresAt: identity.expiresAt }),
    );
    window.dispatchEvent(new Event('yumi:show'));
  }, f.identityB);
  await mini.getByText('未找到可访问的兑换单', { exact: true }).waitFor();
  assert.equal(await mini.getByText('合成包装破损，需要门店核实', { exact: true }).count(), 0);
  await shot('MINI-ACCOUNT-SWITCH', mini);
  await page.getByLabel('回复内容', { exact: true }).fill('合成失权提交');
  await page.getByLabel('确认将此回复展示给用户', { exact: true }).check();
  const actor = await d.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } });
  await d.staffWarehouse.deleteMany({ where: { staffId: actor.id, warehouseId: f.warehouseId } });
  await page.getByRole('button', { name: '发送回复', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByText('合成包装破损，需要门店核实', { exact: true }).count(), 0);
  assert.equal(await page.getByLabel('回复内容', { exact: true }).count(), 0);
  await shot('ADMIN-ACCESS-REMOVED');
  assert.deepEqual(await d.stockBalance.findUniqueOrThrow({ where }), before);
  assert.equal(await d.pointsEntry.count(), entries);
  assert.equal(await d.stockLedger.count(), ledgers);
  assert.equal(await d.redemptionAfterSales.count(), 1);
  assert.equal(await d.redemptionAfterSalesEvent.count(), 5);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ passed: true, screenshots: shots, nativeWechat: false, actualCarrier: false }),
  );
} finally {
  for (const release of releases) release();
  await browser?.close();
  await server?.close();
  await f.cleanup();
}
