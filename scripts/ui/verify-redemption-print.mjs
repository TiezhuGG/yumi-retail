/* global document, innerWidth, window */
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
  dir = resolve('.local/redemption-print-ui');
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
    `import React from 'react';import{createRoot}from'react-dom/client';import{StaffSessionPanel,Workspace}from'${root}/packages/web-ui/src/index';import Rewards from '${root}/apps/consumer-mini/src/pages/rewards/index';import Detail from '${root}/apps/consumer-mini/src/pages/reward/index';import Checkout from '${root}/apps/consumer-mini/src/pages/redemption-checkout/index';import Orders from '${root}/apps/consumer-mini/src/pages/redemptions/index';import Order from '${root}/apps/consumer-mini/src/pages/redemption/index';import Points from '${root}/apps/consumer-mini/src/pages/points/index';const mini=location.search.includes('mini');const style=document.createElement('link');style.rel='stylesheet';style.href=mini?'/mini.css':'/admin.css';await new Promise((done,fail)=>{style.onload=done;style.onerror=fail;document.head.appendChild(style)});createRoot(document.getElementById('root')).render(<React.StrictMode><><div style={{padding:8,background:'#fff3cd',fontSize:12}}>隔离验收 · 合成数据 · 订单配货打印 · 非生产操作</div>{mini?(location.search.includes("view=checkout")?<Checkout/>:location.search.includes("view=orders")?<Orders/>:location.search.includes("view=order&")?<Order/>:location.search.includes("view=points")?<Points/>:location.search.includes("id=")?<Detail/>:<Rewards/>):<StaffSessionPanel workspace>{(p,c)=><Workspace profile={p} sessionControl={c} mobile={location.search.includes("ops")}/>}</StaffSessionPanel>}</></React.StrictMode>);`,
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
    const path = `docs/verification/UI-E1-PRINT-${name}-2026-11-03.png`;
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
  const note = '<img src=x onerror=alert(1)>合成备注';
  assert.equal(
    (
      await f.call('/consumer/addresses/' + f.input.addressId + '/update', {
        ...f.addressInput,
        version: 1,
        note,
      })
    ).status,
    200,
  );
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const q = await f.call('/consumer/redemption-quotes', { ...f.input, addressVersion: 2 });
    assert.equal(q.status, 200);
    const o = await f.call('/consumer/redemptions', { quoteId: q.data.id });
    assert.equal(o.status, 200);
    ids.push(o.data.id);
  }
  assert.equal(
    (await f.call('/consumer/redemptions/' + ids[2] + '/cancel', { version: 0 })).status,
    200,
  );
  await page.getByRole('button', { name: '查询兑换单', exact: true }).click();
  await page.getByRole('button', { name: '查看订单详情', exact: true }).first().waitFor();
  const orders = await f.runtime.db.redemptionOrder.findMany({ where: { id: { in: ids } } });
  const first = orders.find((o) => o.id === ids[0]),
    cancelled = orders.find((o) => o.id === ids[2]);
  assert.equal(
    await page.getByLabel('选择订单 ' + cancelled.orderNo, { exact: true }).isEnabled(),
    false,
  );
  await page.getByLabel('选择本页有效订单', { exact: true }).check();
  await page.getByText('已选 2 单', { exact: true }).waitFor();
  await shot('ADMIN-SELECTED');
  let failPreview = true;
  await page.route('**/admin/redemptions/print-preview', async (route) => {
    if (failPreview) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'UI_TEST', message: '合成打印读取失败' } }),
      });
    } else await route.continue();
  });
  await page.getByRole('button', { name: '批量打印订单', exact: true }).click();
  await page.getByText('合成打印读取失败', { exact: false }).waitFor();
  await shot('PREVIEW-ERROR');
  failPreview = false;
  await page.getByRole('button', { name: '重试打印预览', exact: true }).click();
  const frameHandle = await page.locator('iframe[title="订单配货单预览"]').elementHandle();
  const frame = await frameHandle.contentFrame();
  await frame.getByRole('heading', { name: '积分兑换订单配货单', exact: true }).first().waitFor();
  assert.equal(await frame.locator('.sheet').count(), 2);
  assert.equal(await frame.locator('img').count(), 0);
  assert.ok((await frame.locator('body').textContent()).includes(note));
  await shot('BATCH-DESKTOP');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await frame.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await shot('BATCH-MOBILE');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const printPage = await context.newPage();
  await printPage.setContent(await frame.content());
  await printPage.emulateMedia({ media: 'print' });
  const pdf = await printPage.pdf({
    path: dir + '/orders-a4.pdf',
    preferCSSPageSize: true,
    printBackground: true,
  });
  assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 2);
  await shot('A4-PRINT-MEDIA', printPage);
  await printPage.close();
  await frame.evaluate(() => {
    window.print = () => {
      window.parent.__e1PrintCalls = (window.parent.__e1PrintCalls || 0) + 1;
    };
  });
  await page.getByRole('button', { name: '打印订单', exact: true }).click();
  await page.waitForFunction(() => window.__e1PrintCalls === 1);
  await page.getByRole('button', { name: '关闭打印预览', exact: true }).click();
  assert.equal(await page.locator('iframe[title="订单配货单预览"]').count(), 0);
  const row = page
    .getByRole('row')
    .filter({ has: page.getByLabel('选择订单 ' + first.orderNo, { exact: true }) });
  await row.getByRole('button', { name: '查看订单详情', exact: true }).click();
  await page.getByRole('button', { name: '打印本单', exact: true }).click();
  const single = await (
    await page.locator('iframe[title="订单配货单预览"]').elementHandle()
  ).contentFrame();
  await single.getByRole('heading', { name: '积分兑换订单配货单', exact: true }).waitFor();
  assert.equal(await single.locator('.sheet').count(), 1);
  await shot('SINGLE-DESKTOP');
  await single.evaluate(() => {
    window.print = () => {
      window.parent.__e1PrintCalls = (window.parent.__e1PrintCalls || 0) + 1;
    };
  });
  assert.equal(
    (await f.call('/consumer/redemptions/' + ids[0] + '/cancel', { version: 0 })).status,
    200,
  );
  await page.getByRole('button', { name: '打印订单', exact: true }).click();
  await page.getByText('所选订单已取消，请重新查询后选择有效订单', { exact: false }).waitFor();
  assert.equal(await page.evaluate(() => window.__e1PrintCalls), 1);
  assert.equal(await single.locator('body').textContent(), '');
  await shot('CANCELLED-BEFORE-PRINT');
  await page.getByRole('button', { name: '关闭打印预览', exact: true }).click();
  await page.getByRole('button', { name: '刷新订单详情', exact: true }).click();
  await page.getByText('已取消 · 已退积分', { exact: true }).waitFor();
  assert.equal(
    await page.getByRole('button', { name: '打印本单', exact: true }).isEnabled(),
    false,
  );
  await shot('CANCELLED-DETAIL');
  assert.equal(await f.runtime.db.redemptionShipment.count(), 0);
  assert.equal(await f.runtime.db.redemptionPickingTask.count(), 0);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ passed: true, screenshots: shots, pdfPages: 2, actualPrinterVerified: false }),
  );
} finally {
  for (const release of releases) release();
  await browser?.close();
  await server?.close();
  await f.cleanup();
}
