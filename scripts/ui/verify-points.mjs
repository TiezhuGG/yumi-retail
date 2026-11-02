/* global document, innerWidth, localStorage, window, Event */
// Actual React pages + real API + disposable PG schema. Browser mini adapter is not native WeChat.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pointsFixture } from '../../tests/helpers/points-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  root = process.cwd().replaceAll('\\', '/'),
  dir = resolve('.local/points-ui');
const { createServer, build } =
  await import('../../apps/admin-web/node_modules/vite/dist/node/index.js');
const react = (await import('../../apps/admin-web/node_modules/@vitejs/plugin-react/dist/index.js'))
  .default;
const { chromium } = require(process.env.YUMI_PLAYWRIGHT_PATH || 'playwright');
const f = await pointsFixture();
let server, browser;
const shots = [],
  releases = [];
const key = 'yumi.consumer-session.v1:http://127.0.0.1:3000/api/v1';
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
    `import React from 'react';export const View=({children,...p})=><div {...p}>{children}</div>;export const Text=({children,...p})=><span {...p}>{children}</span>;export const Button=({children,...p})=><button {...p}>{children}</button>;`,
  );
  await writeFile(
    dir + '/taro.ts',
    `import {useEffect} from 'react';export function useDidShow(fn){useEffect(()=>{fn();window.addEventListener('yumi:show',fn);return()=>window.removeEventListener('yumi:show',fn)},[])}export function useDidHide(fn){useEffect(()=>{window.addEventListener('yumi:hide',fn);return()=>window.removeEventListener('yumi:hide',fn)},[])}const Taro={getStorageSync:k=>JSON.parse(localStorage.getItem(k)||'null'),setStorageSync:(k,v)=>localStorage.setItem(k,JSON.stringify(v)),removeStorageSync:k=>localStorage.removeItem(k),request:async o=>{const r=await fetch('/api/v1'+o.url.split('/api/v1')[1],{method:o.method,headers:o.header,body:o.method==='GET'?undefined:JSON.stringify(o.data)});return {statusCode:r.status,data:await r.json()}},navigateTo:async o=>{window.__lastNavigation=o.url}};export default Taro;`,
  );
  await writeFile(
    dir + '/main.tsx',
    `import React from 'react';import{createRoot}from'react-dom/client';import{StaffSessionPanel,Workspace}from'${root}/packages/web-ui/src/index';import Points from '${root}/apps/consumer-mini/src/pages/points/index';const mini=location.search.includes('mini');const style=document.createElement('link');style.rel='stylesheet';style.href=mini?'/mini.css':'/admin.css';await new Promise((done,fail)=>{style.onload=done;style.onerror=fail;document.head.appendChild(style)});createRoot(document.getElementById('root')).render(<><div style={{padding:8,background:'#fff3cd',fontSize:12}}>隔离验收 · 合成数据 · 非真实积分发放</div>{mini?<Points/>:<StaffSessionPanel workspace>{(p,c)=><Workspace profile={p} sessionControl={c}/>}</StaffSessionPanel>}</>);`,
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
    executablePath:
      process.env.YUMI_CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
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
    const path = `docs/verification/UI-POINTS-${name}-2026-11-02.png`;
    await p.screenshot({ path, fullPage: !name.startsWith('MINI-') });
    shots.push(path);
    assert.ok(
      await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      'overflow: ' + name,
    );
  }
  await page.goto('http://127.0.0.1:5188');
  await page.getByRole('button', { name: '积分账户', exact: true }).click();
  await page.getByRole('button', { name: '查看明细' }).first().waitFor();
  await shot('ADMIN-LIST-DESKTOP');
  await page.getByRole('button', { name: '查看明细' }).first().click();
  await page.getByText('暂无积分流水', { exact: true }).waitFor();
  await shot('ADMIN-EMPTY');
  await page.getByRole('button', { name: '返回账户列表' }).click();
  await f.seed();
  await page.getByLabel('用户名称').fill('合成账户');
  await page.getByRole('button', { name: '查询账户' }).click();
  await page.getByRole('button', { name: '加载更多', exact: true }).waitFor();
  assert.equal(await page.locator('.points-table tbody tr').count(), 20);
  await page.getByLabel('用户名称').fill('未提交的筛选');
  let fail = false,
    gate;
  await page.route('**/api/v1/admin/points/accounts**', async (route) => {
    if (gate) await gate;
    if (fail)
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '合成积分查询失败' } }),
      });
    return route.continue();
  });
  fail = true;
  await page.getByRole('button', { name: '加载更多', exact: true }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.locator('.points-table tbody tr').count(), 20);
  await shot('ADMIN-PAGE-ERROR');
  fail = false;
  await page.getByRole('button', { name: '重试读取' }).click();
  await page.getByText('合成账户 23', { exact: true }).waitFor();
  assert.equal(await page.locator('.points-table tbody tr').count(), 23);
  await page.setViewportSize({ width: 390, height: 844 });
  await shot('ADMIN-LIST-MOBILE');
  await page.getByLabel('用户名称').fill('合成积分顾客 A');
  await page.getByRole('button', { name: '查询账户' }).click();
  await page.getByText('合成积分顾客 A', { exact: true }).waitFor();
  await page.getByRole('button', { name: '查看明细' }).click();
  await page.getByText('合成验证流水 20', { exact: true }).waitFor();
  fail = true;
  await page.getByRole('button', { name: '加载更多', exact: true }).click();
  await page.getByRole('alert').waitFor();
  fail = false;
  await page.getByRole('button', { name: '重试读取' }).click();
  await page.getByText('合成验证流水 25', { exact: true }).waitFor();
  assert.equal(await page.locator('.points-entry').count(), 25);
  await shot('ADMIN-LEDGER-MOBILE');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await shot('ADMIN-LEDGER-DESKTOP');
  let release;
  gate = new Promise((r) => (release = r));
  releases.push(release);
  await page.getByRole('button', { name: '刷新明细' }).click();
  await page.getByRole('status').waitFor();
  await shot('ADMIN-LOADING');
  gate = undefined;
  release();
  await page.getByText('合成验证流水 20', { exact: true }).waitFor();
  await page.getByRole('button', { name: '返回账户列表' }).click();
  await page.getByLabel('用户名称').fill('不存在的用户');
  await page.getByRole('button', { name: '查询账户' }).click();
  await page.getByText('暂无匹配用户', { exact: true }).waitFor();
  await shot('ADMIN-FILTER-EMPTY');
  await page.getByLabel('用户名称').fill('合成积分顾客 A');
  await page.getByRole('button', { name: '查询账户' }).click();
  await page.getByText('合成积分顾客 A', { exact: true }).waitFor();
  await page.getByRole('button', { name: '查看明细' }).click();
  await page.getByText('合成验证流水 20', { exact: true }).waitFor();
  const operator = await f.runtime.db.staff.findUniqueOrThrow({
    where: { loginName: 'points-ui' },
  });
  await f.runtime.db.staffWarehouse.deleteMany({
    where: { staffId: operator.id, warehouseId: f.warehouseId },
  });
  await page.getByRole('button', { name: '刷新明细' }).click();
  await page.getByRole('alert').waitFor();
  assert.equal(await page.locator('.points-entry').count(), 0);
  assert.equal(await page.locator('.points-table tbody tr').count(), 0);
  await shot('ADMIN-REVOKED-SCOPE');
  const mini = await context.newPage();
  mini.on('pageerror', (e) => errors.push(e.message));
  await mini.setViewportSize({ width: 390, height: 844 });
  await mini.goto('http://127.0.0.1:5188/?mini');
  await mini.getByText('登录后查看积分', { exact: true }).waitFor();
  await shot('MINI-GUEST', mini);
  await mini.getByRole('button', { name: '前往登录' }).click();
  assert.equal(await mini.evaluate(() => window.__lastNavigation), '/pages/account/index');
  async function identity(value) {
    await mini.evaluate(
      ({ key, value }) => {
        window.dispatchEvent(new Event('yumi:hide'));
        if (value) localStorage.setItem(key, JSON.stringify(value));
        else localStorage.removeItem(key);
        window.dispatchEvent(new Event('yumi:show'));
      },
      { key, value },
    );
  }
  let miniFail = false,
    miniGate;
  await mini.route('**/api/v1/consumer/points**', async (route) => {
    if (miniGate) await miniGate;
    if (miniFail)
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '合成积分服务繁忙' } }),
      });
    return route.continue();
  });
  await identity(f.identity);
  await mini.getByText('250 积分', { exact: true }).waitFor();
  await mini.getByText('合成验证流水 20', { exact: true }).waitFor();
  await shot('MINI-BALANCE', mini);
  miniFail = true;
  await mini.getByRole('button', { name: '加载更多', exact: true }).click();
  await mini.getByText('合成积分服务繁忙', { exact: true }).waitFor();
  await shot('MINI-PAGE-ERROR', mini);
  miniFail = false;
  await mini.getByRole('button', { name: '重试读取' }).click();
  await mini.getByText('合成验证流水 25', { exact: true }).waitFor();
  assert.equal(await mini.locator('.account-card').count(), 26);
  await shot('MINI-LEDGER', mini);
  await identity(f.identityB);
  await mini.getByText('0 积分', { exact: true }).waitFor();
  await mini.getByText('暂无积分记录', { exact: true }).waitFor();
  assert.equal(await mini.getByText('合成验证流水 01', { exact: true }).count(), 0);
  await shot('MINI-OTHER-ACCOUNT-EMPTY', mini);
  miniGate = new Promise((r) => (release = r));
  releases.push(release);
  await identity(f.identity);
  await mini.getByText('正在读取…', { exact: true }).waitFor();
  await shot('MINI-LOADING', mini);
  await identity(null);
  await mini.getByText('登录后查看积分', { exact: true }).waitFor();
  miniGate = undefined;
  release();
  await mini.waitForTimeout(300);
  assert.equal(await mini.getByText('250 积分', { exact: true }).count(), 0);
  miniFail = true;
  await identity(f.identity);
  await mini.getByText('合成积分服务繁忙', { exact: true }).waitFor();
  assert.ok((await mini.getByRole('button', { name: '重试读取' }).boundingBox()).height >= 44);
  await shot('MINI-ERROR', mini);
  miniFail = false;
  await mini.getByRole('button', { name: '重试读取' }).click();
  await mini.getByText('250 积分', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        checks:
          'admin desktop/mobile, list/detail pagination and retry, draft filter isolation, loading/empty/error, mini actual source preview, guest/account switch/stale request protection',
        screenshots: shots,
      },
      null,
      2,
    ),
  );
} finally {
  for (const release of releases) release();
  await browser?.close();
  await server?.close();
  await f.cleanup();
}
