/* global global, yumiCheckoutBridge */
// Actual native components + isolated PostgreSQL API bridge; not legal-domain or device acceptance.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { checkoutFixture } from '../../tests/helpers/checkout-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  automator = require(process.env.YUMI_MINI_AUTOMATOR_PATH || 'miniprogram-automator');
const fixture = await checkoutFixture({ orders: true, holdSeconds: 3 });
const sessionKey = 'yumi.consumer-session.v1:http://127.0.0.1:3000/api/v1';
const cartKey = 'yumi.guest-cart.v1:http://127.0.0.1:3000/api/v1';
const orderKey = 'yumi.order-intent.v1:http://127.0.0.1:3000/api/v1';
let orderBackup,
  hadOrder = false,
  modalMocked = false,
  worker,
  workerClosed;
let cartBackup,
  hadCart = false;
let mini,
  page,
  backup,
  hadSession = false,
  touched = false,
  mocked = false,
  bridgeError,
  loseOnce = false,
  readFail = false,
  delay = 0;
const keys = [];
async function verifyRestoredStorage() {
  if (hadOrder) {
    if (
      JSON.stringify(await mini.callWxMethod('getStorageSync', orderKey)) !==
      JSON.stringify(orderBackup)
    )
      throw Error('Order intent restoration verification failed');
  } else if ((await mini.callWxMethod('getStorageInfoSync')).keys.includes(orderKey))
    throw Error('Temporary order intent was not removed');
  const afterKeys = (await mini.callWxMethod('getStorageInfoSync')).keys;
  if (hadSession) {
    if (
      JSON.stringify(await mini.callWxMethod('getStorageSync', sessionKey)) !==
      JSON.stringify(backup)
    )
      throw Error('Login storage restoration verification failed');
  } else if (afterKeys.includes(sessionKey)) throw Error('Temporary login storage was not removed');
  if (hadCart) {
    if (
      JSON.stringify(await mini.callWxMethod('getStorageSync', cartKey)) !==
      JSON.stringify(cartBackup)
    )
      throw Error('Cart storage restoration verification failed');
  } else if (afterKeys.includes(cartKey)) throw Error('Temporary cart storage was not removed');
}
try {
  mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
  const storage = (await mini.callWxMethod('getStorageInfoSync')).keys;
  hadSession = storage.includes(sessionKey);
  if (hadSession) backup = await mini.callWxMethod('getStorageSync', sessionKey);
  hadCart = storage.includes(cartKey);
  if (hadCart) cartBackup = await mini.callWxMethod('getStorageSync', cartKey);
  hadOrder = storage.includes(orderKey);
  if (hadOrder) orderBackup = await mini.callWxMethod('getStorageSync', orderKey);
  touched = true;
  await mini.callWxMethod('removeStorageSync', orderKey);
  await mini.callWxMethod('setStorageSync', cartKey, { version: 1, items: [] });
  await mini.callWxMethod('setStorageSync', sessionKey, {
    token: fixture.identity.token,
    expiresAt: fixture.identity.expiresAt,
  });
  await mini.evaluate(() => {
    global.__yumiCheckoutResponses = {};
    global.__yumiCheckoutSequence = 0;
  });
  await mini.exposeFunction('yumiCheckoutBridge', (id, options) => {
    void (async () => {
      const route = options.url.split('/api/v1')[1] || '';
      if (delay) await new Promise((r) => setTimeout(r, delay));
      let result;
      if (readFail && route === '/consumer/orders' && options.method === 'GET')
        result = { statusCode: 503, data: { error: { message: '合成读取失败' } } };
      else {
        const response = await fetch(fixture.base + '/api/v1' + route, {
          method: options.method,
          headers: options.header,
          body: options.method === 'GET' ? undefined : JSON.stringify(options.data),
        });
        result = { statusCode: response.status, data: await response.json() };
        if (route === '/consumer/orders' && options.method === 'POST') {
          keys.push(options.header['Idempotency-Key']);
          if (loseOnce && response.status === 200) {
            loseOnce = false;
            result = { statusCode: 503, data: { error: { message: '合成响应丢失' } } };
          }
        }
      }
      await mini.evaluate(
        (id, value) => {
          const callback = global.__yumiCheckoutResponses[id];
          delete global.__yumiCheckoutResponses[id];
          if (callback) callback(value);
        },
        id,
        result,
      );
    })().catch((e) => {
      bridgeError = e;
    });
  });
  await mini.mockWxMethod('request', function (options) {
    return new Promise((resolve) => {
      const id = ++global.__yumiCheckoutSequence;
      global.__yumiCheckoutResponses[id] = resolve;
      yumiCheckoutBridge(id, {
        url: options.url,
        method: options.method,
        header: options.header,
        data: options.data,
      });
    });
  });
  mocked = true;
  async function wait(selector, text) {
    for (let i = 0; i < 100; i++) {
      if (bridgeError) throw bridgeError;
      for (const el of await page.$$(selector))
        if (text === undefined || (await el.text()).includes(text)) return el;
      await page.waitFor(100);
    }
    throw Error('Missing address UI ' + selector + ' ' + text);
  }
  const tap = async (selector, text) => (await wait(selector, text)).trigger('tap');
  await fixture.runtime.db.checkoutPolicy.create({
    data: { warehouseId: fixture.warehouseId, deliveryFeeCents: 300, minGoodsCents: 0, open: true },
  });
  await mini.mockWxMethod('showModal', { confirm: true, cancel: false });
  modalMocked = true;
  page = await mini.reLaunch('/pages/checkout/index');
  await tap('.checkout-check', '核验商品与费用');
  await wait('.checkout-generate', '生成本次报价');
  await tap('.checkout-generate', '生成本次报价');
  await wait('.checkout-expiry', '报价有效至');
  loseOnce = true;
  await tap('.order-create', '创建开发测试订单');
  await wait('.order-submit-error', '合成响应丢失');
  assert.equal(await fixture.runtime.db.consumerOrder.count(), 1);
  const pending = await mini.callWxMethod('getStorageSync', orderKey);
  assert.equal(pending.quoteId.length, 36);
  assert.equal(pending.userId, fixture.identity.user.id);
  assert.equal('phone' in pending, false);
  page = await mini.reLaunch('/pages/checkout/index');
  await tap('.order-create', '核实原下单操作');
  async function current(path) {
    for (let i = 0; i < 80; i++) {
      if (bridgeError) throw bridgeError;
      const candidate = await mini.currentPage();
      if (candidate.path.replace(/^\//, '') === path) {
        page = candidate;
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw Error('Page route did not change: ' + path);
  }
  await current('pages/order/index');
  await wait('.order-state', '待支付');
  assert.equal(keys[0], keys[1]);
  assert.equal(await fixture.runtime.db.consumerOrder.count(), 1);
  assert.equal(await mini.callWxMethod('getStorageSync', orderKey), '');
  console.log('Native durable order restart/retry, owner detail and acknowledged intent verified.');
  if (process.env.YUMI_ORDER_STOP === 'DETAIL') throw Error('CAPTURE_READY:DETAIL');
  await tap('.order-cancel', '取消未支付订单');
  await wait('.order-state', '订单已取消');
  assert.equal(
    (await fixture.runtime.db.stockBalance.aggregate({ _sum: { reserved: true } }))._sum.reserved,
    0,
  );
  await tap('.checkout-link', '查看本人订单列表');
  await current('pages/orders/index');
  await wait('.order-card', '已取消');
  readFail = true;
  await tap('.address-cancel', '刷新订单');
  await wait('.address-alert', '合成读取失败');
  readFail = false;
  await tap('.address-alert button', '重新读取');
  await wait('.order-card', '已取消');
  const book = await fixture.call('/consumer/addresses'),
    cart = await fixture.call('/consumer/cart'),
    q = await fixture.call('/consumer/checkout/quotes', {
      addressId: fixture.addressId,
      addressVersion: book.data.version,
      cartVersion: cart.data.version,
    }),
    created = await fixture.call('/consumer/orders', { quoteId: q.data.id });
  assert.equal(created.status, 200);
  await new Promise((r) => setTimeout(r, 3200));
  const schema = (await fixture.runtime.db.$queryRawUnsafe('SELECT current_schema() AS schema'))[0]
    .schema;
  if (!/^address_ui_[a-f0-9]{32}$/.test(schema))
    throw Error('Worker must target the disposable test schema');
  const dbUrl = new URL(process.env.TEST_DATABASE_URL);
  dbUrl.searchParams.set('schema', schema);
  worker = spawn(process.execPath, ['apps/worker/dist/main.js'], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: dbUrl.toString(), PAYMENT_MODE: 'disabled' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  workerClosed = new Promise((resolve) => worker.once('close', resolve));
  worker.on('error', (e) => {
    bridgeError = e;
  });
  for (let i = 0; i < 80; i++) {
    if (bridgeError) throw bridgeError;
    const saved = await fixture.runtime.db.consumerOrder.findUniqueOrThrow({
      where: { id: created.data.id },
    });
    if (saved.status === 'CANCELED') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  worker.kill('SIGTERM');
  await workerClosed;
  worker = null;
  page = await mini.reLaunch('/pages/order/index?id=' + created.data.id);
  await wait('.order-state', '已超时');
  assert.equal(
    (await fixture.runtime.db.stockBalance.aggregate({ _sum: { reserved: true } }))._sum.reserved,
    0,
  );
  console.log('Native cancellation/list/error recovery and real worker-process expiry verified.');
} catch (e) {
  if (!e.message.startsWith('CAPTURE_READY:')) throw e;
  console.log(e.message);
} finally {
  if (worker) {
    worker.kill('SIGTERM');
    await workerClosed;
  }
  if (mini) {
    try {
      if (modalMocked) await mini.restoreWxMethod('showModal');
      if (mocked) await mini.restoreWxMethod('request');
      if (touched) {
        if (hadSession) await mini.callWxMethod('setStorageSync', sessionKey, backup);
        else await mini.callWxMethod('removeStorageSync', sessionKey);
        if (hadCart) await mini.callWxMethod('setStorageSync', cartKey, cartBackup);
        else await mini.callWxMethod('removeStorageSync', cartKey);
        if (hadOrder) await mini.callWxMethod('setStorageSync', orderKey, orderBackup);
        else await mini.callWxMethod('removeStorageSync', orderKey);
      }
      await verifyRestoredStorage();
      await mini.disconnect();
    } catch (e) {
      process.exitCode = 1;
      console.error('Native restore failed:', e.message);
    }
  }
  await fixture.cleanup();
}
