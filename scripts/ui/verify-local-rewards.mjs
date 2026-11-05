/* global document, innerWidth, window */
// Actual React pages + real API + disposable PG schema. Browser mini adapter is not native WeChat.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd().replaceAll('\\', '/'),
  dir = resolve('.local/local-rewards-ui');
const { createServer, build } =
  await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const live = await (await fetch('http://127.0.0.1:3000/api/v1/rewards')).json();
assert.ok(live.data?.items.length, 'Start local API and seed demo rewards first');
let server, browser;
const shots = [];

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
      '\nbody{margin:0;font-family:Arial,Microsoft YaHei,sans-serif;}button{display:block;box-sizing:border-box;font-family:inherit;}',
  );
  await writeFile(
    dir + '/index.html',
    '<html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0"><div id="root"></div><script type="module" src="/main.tsx"></script></body></html>',
  );
  await writeFile(
    dir + '/components.tsx',
    `import React from 'react';export const ScrollView=({scrollX,children,...p})=><div style={{overflowX:scrollX?'auto':undefined}} {...p}>{children}</div>;export const View=({children,...p})=><div {...p}>{children}</div>;export const Text=({children,...p})=><span {...p}>{children}</span>;export const Button=({children,...p})=><button {...p}>{children}</button>;export const Input=({onInput,onConfirm,maxlength,...p})=><input {...p} maxLength={maxlength} onChange={e=>onInput?.({detail:{value:e.target.value}})} onKeyDown={e=>{if(e.key==='Enter')onConfirm?.()}}/>;export const Image=({src,mode,...p})=><img src={src} {...p}/>;`,
  );
  await writeFile(
    dir + '/taro.ts',
    `import {useEffect} from 'react';export function useDidShow(fn){useEffect(()=>{fn();window.addEventListener('yumi:show',fn);return()=>window.removeEventListener('yumi:show',fn)},[])}export function useRouter(){return {params:Object.fromEntries(new URLSearchParams(location.search))}};export function useDidHide(fn){useEffect(()=>{window.addEventListener('yumi:hide',fn);return()=>window.removeEventListener('yumi:hide',fn)},[])}const Taro={getStorageSync:k=>JSON.parse(localStorage.getItem(k)||'null'),setStorageSync:(k,v)=>localStorage.setItem(k,JSON.stringify(v)),removeStorageSync:k=>localStorage.removeItem(k),request:async o=>{const r=await fetch('/api/v1'+o.url.split('/api/v1')[1],{method:o.method,headers:o.header,body:o.method==='GET'?undefined:JSON.stringify(o.data)});return {statusCode:r.status,data:await r.json()}},navigateTo:async o=>{window.__lastNavigation=o.url}};export default Taro;`,
  );
  await writeFile(
    dir + '/main.tsx',
    `import React from 'react';import{createRoot}from'react-dom/client';import{StaffSessionPanel,Workspace}from'${root}/packages/web-ui/src/index';import Account from '${root}/apps/consumer-mini/src/pages/account/index';import Home from '${root}/apps/consumer-mini/src/pages/index/index';import Rewards from '${root}/apps/consumer-mini/src/pages/rewards/index';import Detail from '${root}/apps/consumer-mini/src/pages/reward/index';const mini=location.search.includes('mini');const style=document.createElement('link');style.rel='stylesheet';style.href=mini?'/mini.css':'/admin.css';await new Promise((done,fail)=>{style.onload=done;style.onerror=fail;document.head.appendChild(style)});createRoot(document.getElementById('root')).render(<><div style={{padding:8,background:'#fff3cd',fontSize:12}}>隔离验收 · 合成数据 · 仅商品浏览 · 不开放真实兑换</div>{mini?(location.search.includes("id=")?<Detail/>:location.search.includes("account")?<Account/>:location.search.includes("home")?<Home/>:<Rewards/>):<StaffSessionPanel workspace>{(p,c)=><Workspace profile={p} sessionControl={c}/>}</StaffSessionPanel>}</>);`,
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
    server: {
      host: '127.0.0.1',
      port: 5188,
      strictPort: true,
      proxy: { '/api': 'http://127.0.0.1:3000' },
    },
  });
  await server.listen();
  browser = await chromium.launch({
    executablePath: process.env.YUMI_CHROME_PATH || '/usr/bin/google-chrome',
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  async function shot(name) {
    await page.evaluate(
      () =>
        new Promise((done) =>
          window.requestAnimationFrame(() => window.requestAnimationFrame(done)),
        ),
    );
    assert.ok(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'No horizontal overflow',
    );
    const path = 'docs/verification/UI-LOCAL-POINTS-' + name + '-2026-11-05.png';
    await page.screenshot({ path, fullPage: !name.startsWith('CATEGORY-') });
    shots.push(path);
  }
  await page.goto('http://127.0.0.1:5188/?mini&home');
  await page
    .locator('.reward-card')
    .nth(Math.min(6, live.data.items.length) - 1)
    .waitFor();
  for (const item of live.data.items.slice(0, 6))
    await page.getByText(item.title, { exact: true }).waitFor();
  assert.equal(await page.getByText('商品加载失败', { exact: true }).count(), 0);
  await shot('HOME');
  let categorySplits = 0;
  await page.route('**/api/v1/categories', async (route) => {
    const response = await route.fetch(),
      body = await response.json();
    if (body.data.items.length > 3) {
      categorySplits++;
      body.data = {
        ...body.data,
        items: body.data.items.slice(0, 3),
        nextCursor: body.data.items[2].id,
      };
      await route.fulfill({ response, json: body });
    } else await route.fulfill({ response });
  });
  await page.goto('http://127.0.0.1:5188/?mini');
  await page
    .locator('.reward-card')
    .nth(live.data.items.length - 1)
    .waitFor();
  await shot('CATALOG');
  await page.getByRole('button', { name: '选择分类 ▾', exact: true }).click();
  await page.getByText('家居收纳', { exact: true }).waitFor();
  assert.ok(categorySplits > 0, 'All category tags loaded across API pages');
  await shot('CATEGORY-ALL');
  await page.getByRole('button', { name: '纸品日用', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.reward-card').length === 3);
  await shot('CATEGORY-SELECTED');
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await page
    .locator('.reward-card')
    .nth(live.data.items.length - 1)
    .waitFor();
  if (live.data.nextCursor) {
    await page.getByRole('button', { name: '加载更多', exact: true }).click();
    await page.locator('.reward-card').nth(20).waitFor();
    await shot('CATALOG-MORE');
  }

  await page.getByPlaceholder('搜索兑换好物', { exact: true }).fill('纸巾');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('.reward-card').length === 1);
  await page.getByText('演示纸巾', { exact: true }).waitFor();
  await shot('SEARCH');
  const paper = live.data.items.find((p) => p.title === '演示纸巾');
  assert.ok(paper);
  await page.goto('http://127.0.0.1:5188/?mini&id=' + paper.id);
  await page.locator('.reward-product-name').filter({ hasText: paper.title }).waitFor();
  await page.getByText('120 积分 / 件', { exact: true }).waitFor();
  await shot('DETAIL');
  let fail = true;
  await page.route('**/api/v1/rewards?*', async (route) => {
    if (fail) {
      fail = false;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '合成接口暂不可用' } }),
      });
    } else await route.continue();
  });
  await page.goto('http://127.0.0.1:5188/?mini');
  await page.getByText('合成接口暂不可用', { exact: true }).waitFor();
  await shot('ERROR');
  await page.getByRole('button', { name: '重试读取', exact: true }).click();
  await page
    .locator('.reward-card')
    .nth(live.data.items.length - 1)
    .waitFor();
  await shot('RECOVERED');
  await page.goto('http://127.0.0.1:5188/?mini&account');
  await page.getByRole('button', { name: '微信登录 / 查看我的积分', exact: true }).waitFor();
  await shot('ACCOUNT-GUEST');
  await page.getByText('收货地址', { exact: true }).click();
  assert.equal(await page.evaluate(() => window.__lastNavigation), '/pages/login/index');
  await page.getByRole('button', { name: '账号设置', exact: true }).click();
  await page.getByText('隐私保护指引', { exact: true }).waitFor();
  await shot('ACCOUNT-SETTINGS');
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({ passed: true, apiItems: live.data.items.length, screenshots: shots }),
  );
} finally {
  await browser?.close();
  await server?.close();
}
