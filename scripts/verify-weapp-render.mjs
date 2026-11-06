import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

// Execute the emitted WeChat bundle with its own React renderer and a small host shim.
// No installed mini-program, network, credentials or platform session is used.
const require = createRequire(import.meta.url);
const dist = resolve('apps/consumer-mini/dist');
const config = JSON.parse(readFileSync(dist + '/app.json', 'utf8'));
assert.notEqual(config.tabBar.custom, true, 'Only the native tab bar may be enabled');
assert.deepEqual(
  config.tabBar.list.map((entry) => entry.pagePath),
  [
    'pages/index/index',
    'pages/points-cart/index',
    'pages/redemptions/index',
    'pages/account/index',
  ],
);
let app, page;
globalThis.App = (value) => {
  app = value;
};
globalThis.Page = (value) => {
  page = value;
};
globalThis.Component = () => {};
globalThis.getApp = () => app;
globalThis.getCurrentPages = () => (page ? [page] : []);
globalThis.wx = {
  getSystemInfoSync: () => ({
    platform: 'devtools',
    SDKVersion: '3.17.5',
    windowWidth: 390,
    pixelRatio: 2,
  }),
  getAppBaseInfo: () => ({ SDKVersion: '3.17.5' }),
  getDeviceInfo: () => ({ platform: 'devtools' }),
  getWindowInfo: () => ({ windowWidth: 390, pixelRatio: 2 }),
  getStorageSync: () => null,
  stopPullDownRefresh: () => {},
  request({ url, success, complete }) {
    const items = url.includes('/rewards')
      ? [
          {
            id: 'fixture-reward',
            name: '运行检查纸巾',
            title: '运行检查纸巾',
            spec: '单包',
            unit: '件',
            imageUrl: null,
            pointsPrice: '120',
            available: 1,
            perUserLimit: 1,
            redemptionEnabled: true,
          },
        ]
      : [{ id: 'fixture-category', name: '运行检查分类' }];
    const data = url.includes('/consumer/auth/methods')
      ? { wechatLoginEnabled: false, developmentLoginEnabled: false }
      : { items, nextCursor: null };
    const result = { statusCode: 200, data: { data } };
    globalThis.queueMicrotask(() => {
      success?.(result);
      complete?.(result);
    });
    return { abort() {} };
  },
};

require(dist + '/app.js');
assert.ok(app, 'WeChat application did not register');
app.onLaunch?.({});
for (const [route, expected] of [
  ['pages/index/index', ['精选可兑换', '运行检查纸巾', 'points-balance-strip']],
  ['pages/points-cart/index', ['购物车', '购物车还是空的']],
  ['pages/redemptions/index', ['订单', '登录后查看']],
  ['pages/account/index', ['我的', '可用积分', '订单', '常用服务']],
  ['pages/login/index', ['玉米百货', '微信登录']],
]) {
  page = undefined;
  require(dist + '/' + route + '.js');
  assert.ok(page, route + ' did not register');
  const updates = [];
  page.route = route;
  page.setData = (data, callback) => {
    updates.push(data);
    callback?.();
  };
  page.onLoad({});
  page.onShow?.();
  for (let attempt = 0; attempt < 40; attempt++) {
    if (expected.every((label) => JSON.stringify(updates).includes(label))) break;
    await sleep(25);
  }
  const rendered = JSON.stringify(updates);
  if (route === 'pages/account/index')
    assert.doesNotMatch(rendered, /member-heading|欢迎来到玉米百货/);
  if (route === 'pages/points-cart/index') assert.doesNotMatch(rendered, /account-name/);
  if (route === 'pages/redemptions/index')
    assert.doesNotMatch(rendered, /account-hero|account-name/);
  assert.ok(
    expected.every((label) => rendered.includes(label)),
    route + ' did not render expected data',
  );
  assert.doesNotMatch(
    rendered,
    /\bstore-tabs\b|返回逛逛|本机购物车草稿/,
    route + ' rendered a legacy navigation',
  );
  assert.doesNotMatch(
    rendered,
    /玉米百货 · 积分商城|积分商品 · 一次兑换|购物车保存在本机|账号设置|登录后可查看积分、兑换商品和查询订单/,
  );
  if (process.env.TARO_APP_CONSUMER_DEV_LOGIN !== '1')
    assert.doesNotMatch(rendered, /使用开发顾客/);
  page.onHide?.();
  page.onUnload?.();
}
console.log(
  'WeChat bundle rendered all four native tab pages and the login page with its compiled React runtime.',
);
