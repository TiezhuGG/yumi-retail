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
  dir = resolve('.local/redemption-express-ui');
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
    `import React from 'react';export const View=({children,...p})=><div {...p}>{children}</div>;export const Text=({children,...p})=><span {...p}>{children}</span>;export const Button=({children,...p})=><button {...p}>{children}</button>;export const Input=({onInput,onConfirm,maxlength,...p})=><input {...p} maxLength={maxlength} onChange={e=>onInput?.({detail:{value:e.target.value}})} onKeyDown={e=>{if(e.key==='Enter')onConfirm?.()}}/>;export const Picker=({range,onChange,value,disabled})=><select aria-label="收货地址" disabled={disabled} value={value} onChange={e=>onChange({detail:{value:e.target.value}})}>{range.map((v,i)=><option key={i} value={i}>{v}</option>)}</select>;export const Textarea=({onInput,maxlength,...p})=><textarea {...p} maxLength={maxlength} onChange={e=>onInput?.({detail:{value:e.target.value}})}/>;export const Switch=({onChange,checked,disabled})=><input role="switch" type="checkbox" checked={checked} disabled={disabled} onChange={e=>onChange?.({detail:{value:e.target.checked}})}/>;export const Image=({src,mode,...p})=><img src={src} {...p}/>;`,
  );
  await writeFile(
    dir + '/taro.ts',
    `import {useEffect} from 'react';export function useDidShow(fn){useEffect(()=>{fn();window.addEventListener('yumi:show',fn);return()=>window.removeEventListener('yumi:show',fn)},[])}export function useRouter(){return {params:Object.fromEntries(new URLSearchParams(location.search))}};export function useDidHide(fn){useEffect(()=>{window.addEventListener('yumi:hide',fn);return()=>window.removeEventListener('yumi:hide',fn)},[])}const Taro={getStorageSync:k=>JSON.parse(localStorage.getItem(k)||'null'),setStorageSync:(k,v)=>localStorage.setItem(k,JSON.stringify(v)),removeStorageSync:k=>localStorage.removeItem(k),request:async o=>{const r=await fetch('/api/v1'+o.url.split('/api/v1')[1],{method:o.method,headers:o.header,body:o.method==='GET'?undefined:JSON.stringify(o.data)});return {statusCode:r.status,data:await r.json()}},navigateTo:async o=>{window.__lastNavigation=o.url}};export default Taro;`,
  );
  await writeFile(
    dir + '/main.tsx',
    `import React from 'react';import{createRoot}from'react-dom/client';import{StaffSessionPanel,Workspace}from'${root}/packages/web-ui/src/index';import Rewards from '${root}/apps/consumer-mini/src/pages/rewards/index';import Detail from '${root}/apps/consumer-mini/src/pages/reward/index';import Checkout from '${root}/apps/consumer-mini/src/pages/redemption-checkout/index';import Orders from '${root}/apps/consumer-mini/src/pages/redemptions/index';import Order from '${root}/apps/consumer-mini/src/pages/redemption/index';import ExpressAddresses from '${root}/apps/consumer-mini/src/pages/express-addresses/index';import Points from '${root}/apps/consumer-mini/src/pages/points/index';const mini=location.search.includes('mini');const style=document.createElement('link');style.rel='stylesheet';style.href=mini?'/mini.css':'/admin.css';await new Promise((done,fail)=>{style.onload=done;style.onerror=fail;document.head.appendChild(style)});createRoot(document.getElementById('root')).render(<React.StrictMode><><div style={{padding:8,background:'#fff3cd',fontSize:12}}>隔离验收 · 合成数据 · 快递地址与兑换 · 非生产操作</div>{mini?(location.search.includes("view=express-addresses")?<ExpressAddresses/>:location.search.includes("view=checkout")?<Checkout/>:location.search.includes("view=orders")?<Orders/>:location.search.includes("view=order&")?<Order/>:location.search.includes("view=points")?<Points/>:location.search.includes("id=")?<Detail/>:<Rewards/>):<StaffSessionPanel workspace>{(p,c)=><Workspace profile={p} sessionControl={c} mobile={location.search.includes("ops")}/>}</StaffSessionPanel>}</></React.StrictMode>);`,
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
    const path = `docs/verification/UI-E2-EXPRESS-${name}-2026-11-03.png`;
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
  await page.getByText('快递寄送规则', { exact: true }).click();
  await page.getByRole('button', { name: '保存快递规则', exact: true }).waitFor();
  await shot('ADMIN-POLICY-PAUSED');
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
  await mini.goto('http://127.0.0.1:5188/?mini&view=express-addresses');
  await mini.getByText('还没有保存收货地址', { exact: true }).waitFor();
  await shot('MINI-ADDRESSES-EMPTY', mini);
  await mini.getByRole('button', { name: '＋ 新增快递地址', exact: true }).click();
  await mini.getByPlaceholder('填写完整省名，如浙江省').fill('浙江省');
  await mini.getByPlaceholder('填写城市').fill('杭州市');
  await mini.getByPlaceholder('填写区县').fill('西湖区');
  await mini.getByPlaceholder('街道、门牌号及收件位置').fill('合成街道1号101');
  await mini.getByPlaceholder('请填写联系人').fill('合成快递收件人');
  await mini.getByPlaceholder('6至20位数字，可带 + 国际区号').fill('00000000000');
  await mini.getByRole('switch').check();
  await shot('MINI-ADDRESS-FORM', mini);
  let dropAddress = true;
  await mini.route('**/consumer/express-addresses', async (route) => {
    if (route.request().method() === 'POST' && dropAddress) {
      dropAddress = false;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await mini.getByRole('button', { name: '保存地址', exact: true }).click();
  await mini.getByRole('button', { name: '原操作重试确认', exact: true }).waitFor();
  await shot('MINI-ADDRESS-UNKNOWN', mini);
  await mini.getByRole('button', { name: '原操作重试确认', exact: true }).click();
  await mini.getByText('合成快递收件人 00000000000', { exact: true }).waitFor();
  await shot('MINI-ADDRESS-SAVED-PAUSED', mini);
  await mini.goto('http://127.0.0.1:5188/?mini&view=checkout&id=' + f.rewardId + '&quantity=1');
  await mini.getByText('快递兑换暂未开放，请联系门店核实寄送规则', { exact: true }).waitFor();
  assert.equal(
    await mini.getByRole('button', { name: '核验并生成兑换报价', exact: true }).isEnabled(),
    false,
  );
  await shot('MINI-CHECKOUT-PAUSED', mini);
  await page.getByLabel('开放快递兑换（仅配置范围）', { exact: true }).check();
  await page.getByLabel('可寄送省份', { exact: true }).fill('浙江省');
  await page
    .getByLabel('快递规则调整原因', { exact: true })
    .fill('合成验证：浙江省可寄，商家承担运费');
  await shot('ADMIN-POLICY-FORM');
  let dropPolicy = true;
  await page.route('**/admin/redemption-express-policy/update', async (route) => {
    if (dropPolicy) {
      dropPolicy = false;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await page.getByRole('button', { name: '保存快递规则', exact: true }).click();
  await page.getByRole('button', { name: '使用原请求核实规则', exact: true }).waitFor();
  await shot('ADMIN-POLICY-UNKNOWN');
  await page.reload();
  await page.getByRole('button', { name: '积分兑换订单', exact: true }).click();
  await page.getByText('快递寄送规则', { exact: true }).click();
  await page.getByRole('button', { name: '使用原请求核实规则', exact: true }).click();
  await page.getByRole('button', { name: '保存快递规则', exact: true }).waitFor();
  await shot('ADMIN-POLICY-RECOVERED');
  await mini.reload();
  await mini.getByText('可寄送：浙江省 · 商家承担运费', { exact: true }).waitFor();
  await mini.getByRole('button', { name: '核验并生成兑换报价', exact: true }).click();
  await mini.getByText('确认扣除 120 积分', { exact: true }).waitFor();
  await shot('MINI-EXPRESS-QUOTE', mini);
  let dropOrder = true;
  await mini.route('**/consumer/redemptions', async (route) => {
    if (route.request().method() === 'POST' && dropOrder) {
      dropOrder = false;
      await route.fetch();
      await route.abort();
    } else await route.continue();
  });
  await mini.getByRole('button', { name: '确认扣除 120 积分兑换', exact: true }).click();
  await mini.getByText('有一笔兑换待核实', { exact: true }).waitFor();
  await mini.locator('.account-error').waitFor();
  await shot('MINI-ORDER-UNKNOWN', mini);
  await mini.reload();
  await mini.getByRole('button', { name: '核实原兑换操作', exact: true }).click();
  await mini.waitForFunction(() => !!window.__lastNavigation);
  const o = await f.runtime.db.redemptionOrder.findFirstOrThrow({
    where: { deliveryMode: 'EXPRESS' },
  });
  assert.equal(await f.runtime.db.redemptionOrder.count(), 1);
  assert.equal(await f.runtime.db.consumerExpressAddress.count(), 1);
  assert.equal(await f.runtime.db.redemptionPickingTask.count(), 0);
  await mini.goto('http://127.0.0.1:5188/?mini&view=order&id=' + o.id);
  await mini.getByText('待快递发货 · 商家承担运费', { exact: true }).waitFor();
  await mini.getByText('浙江省 杭州市 西湖区 合成街道1号101', { exact: true }).waitFor();
  await shot('MINI-EXPRESS-ORDER', mini);
  await page.getByRole('button', { name: '查询兑换单', exact: true }).click();
  await page.getByRole('button', { name: '查看订单详情', exact: true }).click();
  await page.getByText('待快递发货 · 商家承担运费', { exact: true }).waitFor();
  await shot('ADMIN-EXPRESS-ORDER');
  await page.getByRole('button', { name: '打印本单', exact: true }).click();
  const frame = await (
    await page.locator('iframe[title="订单配货单预览"]').elementHandle()
  ).contentFrame();
  await frame
    .getByText('订单状态：有效兑换 · 配送方式：快递发货 · 商家承担运费', { exact: true })
    .waitFor();
  await frame.getByText('浙江省 杭州市 西湖区 合成街道1号101', { exact: true }).waitFor();
  await shot('ADMIN-EXPRESS-PRINT');
  await mini.goto('http://127.0.0.1:5188/?mini&view=express-addresses');
  await mini.getByText('合成快递收件人 00000000000', { exact: true }).waitFor();
  await mini.evaluate((identity) => {
    window.dispatchEvent(new window.Event('yumi:hide'));
    localStorage.setItem(
      'yumi.consumer-session.v1:http://127.0.0.1:3000/api/v1',
      JSON.stringify({ token: identity.token, expiresAt: identity.expiresAt }),
    );
    window.dispatchEvent(new window.Event('yumi:show'));
  }, f.identityB);
  await mini.getByText('还没有保存收货地址', { exact: true }).waitFor();
  assert.equal(await mini.getByText('合成快递收件人 00000000000', { exact: true }).count(), 0);
  await shot('MINI-ADDRESS-ACCOUNT-SWITCH', mini);
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ passed: true, screenshots: shots, production: false, nativeWechat: false }),
  );
} finally {
  for (const release of releases) release();
  await browser?.close();
  await server?.close();
  await f.cleanup();
}
