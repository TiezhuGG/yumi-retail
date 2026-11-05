/* global document, innerWidth, URLSearchParams, location, localStorage, requestAnimationFrame */
// Actual page components and API; synthetic records in a disposable PostgreSQL schema.
// Browser adapters verify layout and interaction, not native WeChat acceptance.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { controlledExpressFixture } from '../../tests/helpers/controlled-express-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local explicit opt-in required');
const require = createRequire(import.meta.url);
const root = process.cwd();
const dir = resolve('.local/atlas-pages');
const output = resolve('docs/verification/atlas-pages-2026-11-05');
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const { createServer, build } =
  await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const fixture = await controlledExpressFixture({ browserLogin: true });
let browser, server;
const records = [],
  errors = [];
try {
  await mkdir(dir + '/public', { recursive: true });
  await mkdir(output, { recursive: true });
  const pages = [
    'index',
    'account',
    'login',
    'points',
    'rewards',
    'reward',
    'redemption-checkout',
    'redemptions',
    'redemption',
    'service-area',
    'addresses',
    'express-addresses',
    'product',
    'cart',
    'checkout',
    'orders',
    'order',
  ];
  const order = await fixture.controlledOrder();
  const shipped = await fixture.controlledOrder();
  const shipping = await fixture.call(
    '/admin/redemptions/' + shipped.id + '/ship',
    {
      version: 0,
      carrierCode: 'SF',
      carrierName: '顺丰速运',
      trackingNo: 'SYNTHETICATLAS1105',
      dispatchConfirmed: true,
    },
    randomUUID(),
    fixture.a.token,
    true,
  );
  assert.equal(shipping.status, 200, 'synthetic shipment');
  assert.equal(
    (
      await fixture.call('/consumer/redemptions/' + shipped.id + '/after-sales', {
        category: 'DAMAGED',
        message: '合成界面验收反馈，外包装需核查',
      })
    ).status,
    200,
  );
  async function retail(path, body) {
    const response = await fetch(fixture.base + '/api/v1' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + fixture.identity.token,
        'Idempotency-Key': randomUUID(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const result = await response.json();
    assert.equal(response.status, 200, path + ': ' + JSON.stringify(result));
    return result.data;
  }
  await fixture.runtime.db.checkoutPolicy.create({
    data: { warehouseId: fixture.warehouseId, deliveryFeeCents: 300, minGoodsCents: 0, open: true },
  });
  await retail('/consumer/cart/items', { version: 0, skuId: fixture.catalog.skuIds[1] });
  const book = await retail('/consumer/addresses');
  const quote = await retail('/consumer/checkout/quotes', {
    addressId: book.items[0].id,
    addressVersion: book.version,
    cartVersion: 1,
  });
  const retailOrder = (await retail('/consumer/orders', { quoteId: quote.id })).id;
  await retail('/consumer/cart/items', {
    version: (await retail('/consumer/cart')).version,
    skuId: fixture.catalog.skuIds[0],
  });
  const skuId = fixture.catalog.skuIds[0];
  await writeFile(
    dir + '/index.html',
    '<html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><body><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  );
  await writeFile(
    dir + '/components.tsx',
    `import React from 'react';
export const View=({children,...p})=><div {...p}>{children}</div>;
export const Text=({children,...p})=><span {...p}>{children}</span>;
export const Button=({children,...p})=><button {...p}>{children}</button>;
export const ScrollView=({scrollX,children,...p})=><div style={{overflowX:scrollX?'auto':undefined}} {...p}>{children}</div>;
export const Input=({onInput,onConfirm,maxlength,type,...p})=><input {...p} type={type==='number'?'number':'text'} maxLength={maxlength} onChange={e=>onInput?.({detail:{value:e.target.value}})} onKeyDown={e=>{if(e.key==='Enter')onConfirm?.()}}/>;
export const Textarea=({onInput,maxlength,...p})=><textarea {...p} maxLength={maxlength} onChange={e=>onInput?.({detail:{value:e.target.value}})}/>;
export const Picker=({range,onChange,value,disabled,children})=><div style={{position:'relative'}}>{children}<select style={{position:'absolute',inset:0,opacity:0,width:'100%',height:'100%'}} aria-label="选择" disabled={disabled} value={value} onChange={e=>onChange({detail:{value:e.target.value}})}>{range.map((v,i)=><option key={i} value={i}>{v}</option>)}</select></div>;
export const Switch=({onChange,checked,disabled})=><input role="switch" type="checkbox" checked={checked} disabled={disabled} onChange={e=>onChange?.({detail:{value:e.target.checked}})}/>;
export const Image=({src,mode,...p})=><img src={src} style={{objectFit:mode==='aspectFill'?'cover':'contain',...p.style}} {...p}/>;
export const Swiper=({children,...p})=><div {...p}>{React.Children.toArray(children)[0]}</div>;
export const SwiperItem=View;`,
  );
  await writeFile(
    dir + '/taro.ts',
    `import {useEffect} from 'react';
export function useDidShow(fn){useEffect(()=>{fn();window.addEventListener('yumi:show',fn);return()=>window.removeEventListener('yumi:show',fn)},[])}
export function useDidHide(fn){useEffect(()=>{window.addEventListener('yumi:hide',fn);return()=>window.removeEventListener('yumi:hide',fn)},[])}
export function useRouter(){return {params:Object.fromEntries(new URLSearchParams(location.search))}};
export function useLoad(fn){useEffect(()=>fn(Object.fromEntries(new URLSearchParams(location.search))),[])};export function usePullDownRefresh(){};export function useReachBottom(){};
const go=async o=>{window.__lastNavigation=o.url};
const Taro={login:async()=>({code:'synthetic_launch_browser_code'}),navigateBack:async()=>{},navigateTo:go,switchTab:go,redirectTo:go,reLaunch:go,
getStorageSync:k=>JSON.parse(localStorage.getItem(k)||'null'),setStorageSync:(k,v)=>localStorage.setItem(k,JSON.stringify(v)),removeStorageSync:k=>localStorage.removeItem(k),
pageScrollTo:async()=>{},showModal:async()=>({confirm:true}),showToast:()=>{},stopPullDownRefresh:()=>{},setNavigationBarTitle:()=>{},setClipboardData:async()=>({}),
request:async o=>{const retail=['service-area','addresses','product','cart','checkout','orders','order'].includes(new URLSearchParams(location.search).get('view'));const r=await fetch((retail?'/retail-api/v1':'/api/v1')+o.url.split('/api/v1')[1],{method:o.method,headers:o.header,body:o.method==='GET'?undefined:JSON.stringify(o.data)});return {statusCode:r.status,data:await r.json()}}};export default Taro;`,
  );
  const css = (
    await require(resolve('apps/consumer-mini/node_modules/less')).render(
      await readFile('apps/consumer-mini/src/app.less', 'utf8'),
      { filename: resolve('apps/consumer-mini/src/app.less') },
    )
  ).css;
  await writeFile(
    dir + '/public/mini.css',
    css
      .replace(/([\d.]+)rpx/g, (_, n) => Number(n) / 2 + 'px')
      .replace(/(^|\n)page\s*\{/g, '$1body{') +
      '\nbody{margin:0;font-family:"Microsoft YaHei",sans-serif}button{display:block;box-sizing:border-box;font-family:inherit;border:0}input,textarea,select{box-sizing:border-box}img{display:block;max-width:100%} .preview-navbar{height:44px;display:flex;align-items:center;justify-content:center;border-bottom:1px solid #e8e8e0;background:#fff;font-size:14px;font-weight:600}.preview-tabbar{position:fixed;bottom:0;left:0;right:0;display:flex;justify-content:space-around;background:#fff;border-top:1px solid #e8e8e0;padding:10px 0;font-size:11px}.preview-tabbar span{display:grid;justify-items:center;gap:4px}.preview-tabbar img{width:22px;height:22px}',
  );
  await writeFile(
    dir + '/main.tsx',
    `import React from 'react';import{createRoot}from'react-dom/client';import{StaffSessionPanel,Workspace}from'${root}/packages/web-ui/src/index';
${pages.map((p, i) => `import Page${i} from '${root}/apps/consumer-mini/src/pages/${p}/index';`).join('\n')}
const q=new URLSearchParams(location.search),mini=q.has('mini'),view=q.get('view')||'index';const pages={${pages.map((p, i) => `'${p}':Page${i}`).join(',')}};const Page=pages[view];
const style=document.createElement('link');style.rel='stylesheet';style.href=mini?'/mini.css':'/admin.css';await new Promise((done,fail)=>{style.onload=done;style.onerror=fail;document.head.appendChild(style)});
createRoot(document.getElementById('root')).render(mini?<><div className="preview-navbar">玉米百货</div><Page/>{['index','account','redemptions'].includes(view)&&<div className="preview-tabbar">{[['home','商城'],['orders','兑换订单'],['account','我的']].map(([icon,title])=><span key={icon}><img src={'/tab-'+icon+'.png'}/>{title}</span>)}</div>}</>:<StaffSessionPanel workspace>{(p,c)=><Workspace profile={p} sessionControl={c}/>}</StaffSessionPanel>);`,
  );
  await writeFile(
    dir + '/public/admin.css',
    await readFile('packages/web-ui/src/styles.css', 'utf8'),
  );
  for (const icon of ['home', 'orders', 'account']) {
    const bytes = await readFile(`apps/consumer-mini/src/assets/tab-${icon}.png`).catch(() => null);
    if (bytes) await writeFile(dir + `/public/tab-${icon}.png`, bytes);
  }
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
    server: {
      host: '127.0.0.1',
      port: 5188,
      strictPort: true,
      proxy: {
        '/api': fixture.controlledBase,
        '/retail-api': {
          target: fixture.base,
          rewrite: (path) => path.replace('/retail-api', '/api'),
        },
      },
    },
  });
  await server.listen();
  browser = await chromium.launch({
    executablePath: process.env.YUMI_CHROME_PATH || '/usr/bin/google-chrome',
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    timezoneId: 'Asia/Shanghai',
  });
  await context.addCookies([
    {
      name: 'yumi_staff_session',
      value: fixture.cookie.split('=')[1],
      domain: '127.0.0.1',
      path: '/',
    },
  ]);
  await context.addInitScript(
    ({ identity, controlled }) => {
      const view = new URLSearchParams(location.search).get('view');
      const who = [
        'service-area',
        'addresses',
        'product',
        'cart',
        'checkout',
        'orders',
        'order',
      ].includes(view)
        ? identity
        : controlled;
      if (view === 'login')
        localStorage.removeItem('yumi.consumer-session.v1:http://127.0.0.1:3000/api/v1');
      else
        localStorage.setItem(
          'yumi.consumer-session.v1:http://127.0.0.1:3000/api/v1',
          JSON.stringify(who),
        );
    },
    { identity: fixture.identity, controlled: fixture.a },
  );
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  async function shot(name, p = page) {
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({
      path: output + '/' + name + '.png',
      fullPage: true,
      animations: 'disabled',
    });
    const info = await p.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth + 1,
      width: innerWidth,
      height: document.documentElement.scrollHeight,
    }));
    console.log('Verified ' + name);
    records.push({ name, ...info });
    assert.equal(info.overflow, false, name + ' horizontal overflow');
  }
  async function settled(p = page) {
    await p.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
    await p.waitForLoadState('networkidle');
    await p.waitForFunction(
      () =>
        !Array.from(document.querySelectorAll('[role="status"]')).some(
          (el) =>
            el.getClientRects().length &&
            /正在加载|正在读取|正在核对|正在核验|正在核实|加载中/.test(el.textContent),
        ),
    );
    await p.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
  }
  await page.goto('http://127.0.0.1:5188');
  await page.locator('.workspace').waitFor();
  await settled();
  const nav = page.locator('nav[aria-label="主导航"] button');
  const names = await nav.allTextContents();
  for (let i = 0; i < names.length; i++) {
    await nav.nth(i).click();
    await settled();
    await shot('admin-' + i);
    const forms = {
      1: ['＋ 新增商品', '编辑资料', '售价与启停', '规格说明', '条码', '图片'],
      2: ['＋ 新增分类', '维护分类'],
      4: ['编辑小区与启停', '新增楼栋'],
      5: ['编辑报价规则'],
      7: ['申请发放积分', '配置发放预算'],
      8: ['申请误发冲正'],
      9: ['新增兑换商品'],
      14: ['＋ 新建收货单', '查看收货详情'],
      16: ['＋ 发起盘点'],
      17: ['＋ 新建隔离'],
      18: ['＋ 新建纠错申请'],
    };
    for (const [j, label] of (forms[i] || []).entries()) {
      const button = page.getByRole('button', { name: label, exact: true }).first();
      if (!(await button.count())) continue;
      await button.click();
      await page.locator('dialog[open]').waitFor();
      await settled();
      await shot('admin-' + i + '-form-' + j);
      await page.setViewportSize({ width: 390, height: 844 });
      await shot('admin-' + i + '-form-' + j + '-mobile');
      await page.keyboard.press('Escape');
      await page.locator('dialog[open]').waitFor({ state: 'hidden' });
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    if (i === 6) {
      await page.getByRole('button', { name: '查看明细', exact: true }).first().click();
      await settled();
      await shot('admin-points-ledger');
    }
    if (i === 9) {
      await page.getByRole('button', { name: '查看商品', exact: true }).first().click();
      await shot('admin-reward-detail');
      await page.getByRole('button', { name: '编辑与上下架', exact: true }).click();
      await settled();
      await shot('admin-reward-edit');
      await page.keyboard.press('Escape');
    }
    if (i === 10) {
      await page.getByRole('button', { name: '查看订单详情', exact: true }).first().click();
      await settled();
      await shot('admin-redemption-detail');
      await page.getByRole('button', { name: '打印本单', exact: true }).click();
      await page.locator('.redemption-print-frame').waitFor();
      await settled();
      await shot('admin-print');
      await page.getByRole('button', { name: '关闭打印预览', exact: true }).click();
      await page.getByRole('button', { name: '返回兑换订单列表', exact: true }).click();
    }
    if (i === 11) {
      await page.getByRole('button', { name: '查看反馈详情', exact: true }).first().click();
      await settled();
      await shot('admin-after-sales-detail');
      await page.getByRole('button', { name: '返回售后反馈列表', exact: true }).click();
    }
  }
  const mini = await context.newPage();
  mini.on('pageerror', (e) => errors.push(e.message));
  await mini.setViewportSize({ width: 390, height: 844 });
  for (const name of pages) {
    const id =
      name === 'product'
        ? skuId
        : name === 'reward' || name === 'redemption-checkout'
          ? fixture.rewardId
          : name === 'redemption'
            ? order.id
            : name === 'order'
              ? retailOrder
              : undefined;
    await mini.goto(
      'http://127.0.0.1:5188/?mini&view=' + name + (id ? '&id=' + id : '') + '&quantity=1',
    );
    await settled(mini);
    await shot('mini-' + name, mini);
    if (['express-addresses', 'addresses'].includes(name)) {
      await mini
        .getByRole('button', { name: /新增.*地址/ })
        .first()
        .click();
      await settled(mini);
      await shot('mini-' + name + '-form', mini);
    }
  }
  await mini.goto('http://127.0.0.1:5188/?mini&view=redemption&id=' + shipped.id);
  await settled(mini);
  await shot('mini-redemption-shipped', mini);
  await mini.setViewportSize({ width: 320, height: 740 });
  for (const name of pages) {
    const id =
      name === 'product'
        ? skuId
        : name === 'reward' || name === 'redemption-checkout'
          ? fixture.rewardId
          : name === 'redemption'
            ? order.id
            : name === 'order'
              ? retailOrder
              : undefined;
    await mini.goto(
      'http://127.0.0.1:5188/?mini&view=' + name + (id ? '&id=' + id : '') + '&quantity=1',
    );
    await settled(mini);
    await shot('mini-320-' + name, mini);
  }
  await mini.setViewportSize({ width: 390, height: 844 });
  // Explicitly injected transport states, separated from actual API screenshot coverage.
  let release;
  const held = new Promise((done) => (release = done));
  await mini.route('**/api/v1/rewards', async (route) => {
    await held;
    await route.continue();
  });
  await mini.goto('http://127.0.0.1:5188/?mini&view=index');
  await mini.locator('.atlas-loading').waitFor();
  await shot('mini-state-loading', mini);
  release();
  await settled(mini);
  await mini.unroute('**/api/v1/rewards');
  await mini.route('**/api/v1/rewards**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: '合成弱网状态' } }),
    }),
  );
  await mini.goto('http://127.0.0.1:5188/?mini&view=rewards');
  await settled(mini);
  await shot('mini-state-error', mini);
  await mini.unroute('**/api/v1/rewards**');
  await mini.getByRole('button', { name: '重试读取', exact: true }).click();
  await settled(mini);
  assert.equal(await mini.locator('.reward-card').count(), 1);
  await mini.locator('.reward-search input').fill('不存在的合成商品');
  await mini.getByRole('button', { name: '搜索', exact: true }).click();
  await settled(mini);
  await shot('mini-state-empty', mini);
  const login = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  login.on('pageerror', (e) => errors.push(e.message));
  await login.goto('http://127.0.0.1:5188');
  await login.locator('.login-card').waitFor();
  await settled(login);
  await shot('admin-login', login);
  await login.setViewportSize({ width: 390, height: 844 });
  await shot('admin-login-mobile', login);
  await login.close();
  await page.getByRole('button', { name: '积分账户', exact: true }).click();
  await settled();
  await page.route('**/api/v1/admin/points/accounts**', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: '合成网络错误，请重试' } }),
    }),
  );
  await page.getByRole('button', { name: '查询账户', exact: true }).click();
  await settled();
  await shot('admin-state-error');
  await page.unroute('**/api/v1/admin/points/accounts**');
  await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await settled();
  await page.getByRole('textbox', { name: '用户名称', exact: true }).fill('不存在的合成账户');
  await page.getByRole('button', { name: '查询账户', exact: true }).click();
  await settled();
  await shot('admin-state-empty');

  // Responsive admin navigation must leave every authorized route reachable.
  await page.setViewportSize({ width: 390, height: 844 });
  for (let i = 0; i < names.length; i++) {
    await nav.nth(i).click();
    await settled();
    await shot('admin-mobile-' + i);
  }
  assert.deepEqual(errors, [], 'React runtime errors');
  await writeFile(
    output + '/results.json',
    JSON.stringify(
      {
        adminRoutes: names,
        records,
        errors,
        scope: 'Actual React + actual API + disposable PG; browser mini adapter, not native WeChat',
      },
      null,
      2,
    ),
  );
  const escape = (value) =>
    value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
  await writeFile(
    output + '/index.html',
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>玉米百货 · 实际页面截图</title><style>body{margin:0;background:#f6f6ef;color:#23251f;font:14px Microsoft YaHei,sans-serif}header{padding:32px;max-width:1200px;margin:auto}h1{font-size:28px}p{line-height:1.8;color:#62665a}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:18px;padding:0 32px 40px;max-width:1400px;margin:auto}a{background:white;border:1px solid #e8e8e0;border-radius:12px;overflow:hidden;text-decoration:none;color:inherit}img{width:100%;height:260px;object-fit:contain;object-position:top;background:#eeeee7}a span{display:block;padding:12px}</style><header><h1>玉米百货 · 页面改版截图</h1><p>2026-11-05 · 当前实际 React 页面 + 隔离 API / PostgreSQL 合成资料。小程序图片为浏览器同源码预览，微信原生导航由适配层示意；不是微信工具或真机验收。state 图片含明确注入的网络状态。点击查看原图。</p></header><main>' +
      records
        .map(
          (r) =>
            '<a href="' +
            escape(r.name) +
            '.png"><img loading="lazy" src="' +
            escape(r.name) +
            '.png"><span>' +
            escape(r.name) +
            '</span></a>',
        )
        .join('') +
      '</main></html>',
  );
  console.log(
    JSON.stringify({
      screenshots: records.length,
      adminRoutes: names.length,
      miniPages: pages.length,
      output,
    }),
  );
} finally {
  await browser?.close();
  await server?.close();
  await fixture.cleanup();
}
