/* global global, yumiCartBridge */
// Opt-in native rendering with an explicit Node HTTP bridge to a disposable PostgreSQL schema.
// The bridge bypasses WeChat's request-domain layer; it is not real-device/network acceptance.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createApplication } from '../../apps/api/dist/app.js';
import { applicationConfig } from '../../apps/api/dist/config.js';
import { seedCartCatalog } from '../../tests/helpers/cart-catalog.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const url = new URL(process.env.TEST_DATABASE_URL || '');
if (url.hostname !== '127.0.0.1' || url.pathname !== '/yumi_test' || url.searchParams.has('schema'))
  throw Error('Isolated local test database only');
const require = createRequire(import.meta.url),
  { Client } = require('pg');
const automator = require(process.env.YUMI_MINI_AUTOMATOR_PATH || 'miniprogram-automator');
const schema = 'cart_ui_' + randomUUID().replaceAll('-', '');
const admin = new Client({ connectionString: url.toString() });
const sessionKey = 'yumi.consumer-session.v1:http://127.0.0.1:3000/api/v1';
const cartKey = 'yumi.guest-cart.v1:http://127.0.0.1:3000/api/v1';
let runtime,
  mini,
  page,
  mocked = false,
  storageMocked = false,
  modalMocked = false,
  touched = false;
let backup,
  hadSession = false,
  cartBackup,
  hadCart = false,
  failMergeOnce = false,
  failUpdateOnce = false,
  delay = 0,
  bridgeError;
let restored = false,
  apiCalls = 0;
const mergeKeys = [];
const warehouseId = randomUUID();
let fixture, identityA, identityB, stockBefore;
try {
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query("SELECT set_config('search_path',$1,false)", [schema]);
  const directory = 'packages/database/prisma/migrations';
  for (const name of (await readdir(directory)).filter((n) => /^\d/.test(n)).sort())
    await admin.query(await readFile(`${directory}/${name}/migration.sql`, 'utf8'));
  url.searchParams.set('schema', schema);
  runtime = await createApplication(url.toString(), {
    config: applicationConfig({
      NODE_ENV: 'test',
      CONSUMER_DEV_LOGIN_ENABLED: '1',
      PUBLIC_WAREHOUSE_ID: warehouseId,
    }),
    accessLog: () => {},
  });
  await runtime.app.listen(0, '127.0.0.1');
  const base = await runtime.app.getUrl();
  fixture = await seedCartCatalog(runtime, warehouseId);
  stockBefore = await runtime.db.stockBalance.findMany();
  async function api(route, token, body, method = body === undefined ? 'GET' : 'POST', key) {
    const r = await fetch(base + '/api/v1' + route, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Yumi-Dev-Login': '1',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(key ? { 'Idempotency-Key': key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    assert.equal(r.status, 200, route);
    return (await r.json()).data;
  }
  identityA = await api('/consumer/auth/dev-session', null, { profile: 'customer-a' });
  identityB = await api('/consumer/auth/dev-session', null, { profile: 'customer-b' });
  const labels = (id, q = 1, selected = true) => ({
    skuId: id,
    quantity: q,
    selected,
    name: '草稿纸巾',
    spec: id === fixture.skuIds[0] ? '单包装' : '3包装',
    unit: id === fixture.skuIds[0] ? '包' : '组',
  });
  await api(
    '/consumer/cart/merge',
    identityA.token,
    { items: [labels(fixture.skuIds[0], 1, false)] },
    'POST',
    randomUUID(),
  );

  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
      break;
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      await mini.currentPage();
      break;
    } catch (e) {
      if (attempt === 29) throw e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  const keys = (await mini.callWxMethod('getStorageInfoSync')).keys;
  hadSession = keys.includes(sessionKey);
  if (hadSession) backup = await mini.callWxMethod('getStorageSync', sessionKey);
  hadCart = keys.includes(cartKey);
  if (hadCart) cartBackup = await mini.callWxMethod('getStorageSync', cartKey);
  touched = true;
  await mini.callWxMethod('setStorageSync', sessionKey, {
    token: identityA.token,
    expiresAt: identityA.expiresAt,
  });
  await mini.callWxMethod('setStorageSync', cartKey, {
    version: 1,
    items: [labels(fixture.skuIds[0], 2), labels(fixture.skuIds[1])],
  });
  const productFixtures = {};
  for (const id of fixture.skuIds)
    productFixtures[id] = { statusCode: 200, data: { data: await api('/products/' + id) } };
  await mini.evaluate((values) => {
    global.__yumiCartProducts = values;
  }, productFixtures);
  await mini.evaluate(() => {
    global.__yumiCartResponses = {};
    global.__yumiCartSequence = 0;
  });
  await mini.exposeFunction('yumiCartBridge', (id, options) => {
    void (async () => {
      let result;
      const route = options.url.split('/api/v1')[1] || '';
      if (delay) await new Promise((r) => setTimeout(r, delay));
      if (
        /^\/consumer\/(me|cart(?:\/.*)?)$/.test(route) ||
        /^\/products\/[a-f0-9-]+$/.test(route)
      ) {
        apiCalls++;
        const response = await fetch(base + '/api/v1' + route, {
          method: options.method,
          headers: options.header,
          body: ['POST', 'PUT', 'DELETE'].includes(options.method)
            ? JSON.stringify(options.data)
            : undefined,
        });
        result = { statusCode: response.status, data: await response.json() };
        if (route === '/consumer/cart/merge') {
          mergeKeys.push(options.header['Idempotency-Key'] || options.header['idempotency-key']);
          if (failMergeOnce && response.status === 200) {
            failMergeOnce = false;
            result = {
              statusCode: 503,
              data: {
                error: { code: 'UNKNOWN', message: '合成响应丢失：原稿已保留，请重试同一笔合并' },
              },
            };
          }
        }
        if (options.method === 'PUT' && failUpdateOnce && response.status === 200) {
          failUpdateOnce = false;
          result = { statusCode: 503, data: { error: { message: '合成保存响应丢失' } } };
        }
      } else
        result = {
          statusCode: 200,
          data: { data: { items: [], hasMore: false, nextCursor: null } },
        };
      await mini.evaluate(
        (requestId, value) => {
          const callback = global.__yumiCartResponses[requestId];
          delete global.__yumiCartResponses[requestId];
          if (callback) callback(value);
        },
        id,
        result,
      );
    })().catch((e) => {
      bridgeError = e;
    });
  });
  async function installRequest() {
    await mini.mockWxMethod('request', function (options) {
      const path = options.url.split('/api/v1')[1] || '';
      if (path.startsWith('/products/')) return global.__yumiCartProducts[path.split('/').pop()];
      return new Promise((resolve) => {
        const id = ++global.__yumiCartSequence;
        global.__yumiCartResponses[id] = resolve;
        yumiCartBridge(id, {
          url: options.url,
          method: options.method,
          header: options.header,
          data: options.data,
        });
      });
    });
    mocked = true;
  }
  await installRequest();
  async function wait(selector, text) {
    for (let i = 0; i < 100; i++) {
      if (bridgeError) throw bridgeError;
      for (const e of await page.$$(selector))
        if (text === undefined || (await e.text()).includes(text)) return e;
      await page.waitFor(100);
    }
    throw Error('Missing cart UI ' + selector + ' ' + text);
  }
  const tap = async (selector, text) => {
    await (await wait(selector, text)).trigger('tap');
  };
  const shot = async (name) => {
    console.log('Verified UI state', name);
    if (process.env.YUMI_UI_STOP_AFTER === name) throw new Error('CAPTURE_READY:' + name);
  };
  async function raw() {
    return mini.callWxMethod('getStorageSync', cartKey);
  }
  async function poll(test) {
    for (let i = 0; i < 60; i++) {
      if (await test()) return;
      await page.waitFor(100);
    }
    throw Error('cart state did not settle');
  }
  const row = async (spec) => wait('.cart-row', spec);
  page = await mini.reLaunch('/pages/cart/index');
  await wait('.cart-title', '账号购物车');
  await wait('.cart-status', '本次读取可用');
  await mini.mockWxMethod('showModal', { confirm: true, cancel: false });
  modalMocked = true;
  console.log('Account cart loaded; testing merge.');
  failMergeOnce = true;
  await tap('.cart-merge-button');
  console.log('Merge event dispatched.');
  await wait('.store-feedback', '合成响应丢失');
  console.log('Unknown merge state confirmed.');
  await mini.restoreWxMethod('showModal');
  modalMocked = false;
  assert.ok((await raw()).merge);
  await shot('PENDING');
  const version = (await api('/consumer/cart', identityA.token)).version;
  const keysBefore = mergeKeys.length;
  await mini.callWxMethod('setStorageSync', sessionKey, {
    token: identityB.token,
    expiresAt: identityB.expiresAt,
  });
  page = await mini.reLaunch('/pages/cart/index');
  await wait('.cart-note', '开发顾客 B');
  await tap('.cart-merge-button');
  await wait('.store-feedback', '另一个账号');
  assert.equal(mergeKeys.length, keysBefore);
  await shot('OWNER-MISMATCH');
  await mini.callWxMethod('setStorageSync', sessionKey, {
    token: identityA.token,
    expiresAt: identityA.expiresAt,
  });
  page = await mini.reLaunch('/pages/cart/index');
  await wait('.cart-note', '开发顾客 A');
  await tap('.cart-merge-button');
  await wait('.cart-merge-panel', '本机草稿有0种');
  assert.equal(typeof mergeKeys[0], 'string');
  assert.equal(mergeKeys[0], mergeKeys[1]);
  assert.deepEqual(await raw(), { version: 1, items: [] });
  let cart = await api('/consumer/cart', identityA.token);
  assert.equal(cart.version, version);
  assert.equal(cart.items.find((i) => i.skuId === fixture.skuIds[0]).quantity, 3);
  assert.equal(cart.items.find((i) => i.skuId === fixture.skuIds[0]).selected, false);
  await wait('.cart-total', '12.99');
  await shot('READY');
  await mini.callWxMethod('setStorageSync', cartKey, {
    version: 1,
    items: [labels(fixture.skuIds[1])],
  });
  await tap('.cart-merge-panel button', '查看本机草稿');
  await wait('.cart-title', '本机购物车草稿');
  await (await (await row('3包装')).$('.cart-remove')).trigger('tap');
  await wait('.cart-merge-panel', '本机草稿有0种');
  await tap('.cart-merge-panel button', '返回账号购物车');
  await wait('.cart-total', '12.99');

  await (await (await row('单包装')).$('.cart-check')).trigger('tap');
  await wait('.cart-total', '26.49');
  failUpdateOnce = true;
  await (await (await row('单包装')).$$('.cart-stepper button'))[1].trigger('tap');
  await wait('.store-feedback', '请先重新读取');
  cart = await api('/consumer/cart', identityA.token);
  assert.equal(cart.items.find((i) => i.skuId === fixture.skuIds[0]).quantity, 4);
  await (await (await row('单包装')).$$('.cart-stepper button'))[1].trigger('tap');
  assert.equal((await api('/consumer/cart', identityA.token)).version, cart.version);
  await shot('SAVE-UNKNOWN');
  await tap('.cart-heading button');
  await wait('.cart-total', '30.99');
  await api(
    '/consumer/cart/items/' + fixture.skuIds[0],
    identityA.token,
    { version: cart.version, quantity: 2, selected: true },
    'PUT',
  );
  await (await (await row('单包装')).$$('.cart-stepper button'))[1].trigger('tap');
  await wait('.store-feedback', '其他操作中更新');
  await shot('CONFLICT');
  await tap('.cart-heading button');
  await wait('.cart-total', '21.99');
  await runtime.db.sku.update({ where: { id: fixture.skuIds[1] }, data: { enabled: false } });
  productFixtures[fixture.skuIds[1]] = {
    statusCode: 404,
    data: { error: { message: '商品不可用' } },
  };
  await mini.evaluate((values) => {
    global.__yumiCartProducts = values;
  }, productFixtures);
  await tap('.cart-heading button');
  await wait('.cart-status', '商品已失效');
  await shot('INVALID');
  await (await (await row('3包装')).$('.cart-remove')).trigger('tap');
  await wait('.cart-total', '9.00');
  await mini.callWxMethod('setStorageSync', sessionKey, {
    token: identityB.token,
    expiresAt: identityB.expiresAt,
  });
  page = await mini.reLaunch('/pages/cart/index');
  await wait('.cart-note', '开发顾客 B');
  await wait('.cart-empty', '购物车还是空的');
  await shot('ACCOUNT-B-EMPTY');
  page = await mini.reLaunch('/pages/product/index?id=' + fixture.skuIds[0]);
  await wait('.detail-buy', '加入购物车');
  await tap('.detail-buy');
  await poll(async () => {
    const data = await api('/consumer/cart', identityB.token);
    return data.items[0]?.quantity === 1;
  });
  assert.deepEqual(await raw(), { version: 1, items: [] });
  page = await mini.reLaunch('/pages/cart/index');
  await wait('.cart-total', '4.50');
  await shot('ACCOUNT-B-ADDED');
  delay = 8000;
  page = await mini.reLaunch('/pages/cart/index');
  await wait('.cart-heading button', '正在核验');
  await shot('LOADING');
  delay = 0;
  await wait('.cart-total', '4.50');
  assert.deepEqual(await runtime.db.stockBalance.findMany(), stockBefore);
  assert.equal(await runtime.db.stockLedger.count(), 2);
  console.log(
    'Account cart UI passed with isolated real API/stock: lost merge response replay, owner binding, preserved selection, update uncertainty, version conflict, unavailable retention, account isolation and detail add.',
  );
} catch (error) {
  if (!(error instanceof Error) || !error.message.startsWith('CAPTURE_READY:')) throw error;
  console.log(error.message);
} finally {
  try {
    if (mini) {
      try {
        if (storageMocked) await mini.restoreWxMethod('setStorageSync');
        if (modalMocked) await mini.restoreWxMethod('showModal');
        if (mocked) await mini.restoreWxMethod('request');
        if (touched) {
          if (hadSession) await mini.callWxMethod('setStorageSync', sessionKey, backup);
          else await mini.callWxMethod('removeStorageSync', sessionKey);
          const keys = (await mini.callWxMethod('getStorageInfoSync')).keys;
          assert.equal(keys.includes(sessionKey), hadSession);
          if (hadSession)
            assert.deepEqual(await mini.callWxMethod('getStorageSync', sessionKey), backup);
          if (hadCart) await mini.callWxMethod('setStorageSync', cartKey, cartBackup);
          else await mini.callWxMethod('removeStorageSync', cartKey);
          const finalKeys = (await mini.callWxMethod('getStorageInfoSync')).keys;
          assert.equal(finalKeys.includes(cartKey), hadCart);
          if (hadCart)
            assert.deepEqual(await mini.callWxMethod('getStorageSync', cartKey), cartBackup);
          restored = true;
        }
        await mini.evaluate(() => {
          delete global.__yumiCartProducts;
          delete global.__yumiCartResponses;
          delete global.__yumiCartSequence;
        });
      } finally {
        await mini.disconnect();
      }
    }
  } finally {
    try {
      if (runtime) await runtime.close();
    } finally {
      try {
        assert.match(schema, /^cart_ui_[a-f0-9]{32}$/);
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        await writeFile(
          '.local/cart-account-ui-cleanup.json',
          JSON.stringify({ restored, schemaRemoved: true, apiCalls }) + '\n',
        );
      } finally {
        await admin.end();
      }
    }
  }
}
