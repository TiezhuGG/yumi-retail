/* global global, yumiCheckoutBridge */
// Actual native components + isolated PostgreSQL API bridge; not legal-domain or device acceptance.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { checkoutFixture } from '../../tests/helpers/checkout-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  automator = require(process.env.YUMI_MINI_AUTOMATOR_PATH || 'miniprogram-automator');
const fixture = await checkoutFixture();
const sessionKey = 'yumi.consumer-session.v1:http://127.0.0.1:3000/api/v1';
const cartKey = 'yumi.guest-cart.v1:http://127.0.0.1:3000/api/v1';
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
  touched = true;
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
      if (readFail && route === '/consumer/checkout/preview')
        result = { statusCode: 503, data: { error: { message: '合成读取失败' } } };
      else {
        const response = await fetch(fixture.base + '/api/v1' + route, {
          method: options.method,
          headers: options.header,
          body: options.method === 'GET' ? undefined : JSON.stringify(options.data),
        });
        result = { statusCode: response.status, data: await response.json() };
        if (route === '/consumer/checkout/quotes' && options.method === 'POST') {
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
  page = await mini.reLaunch('/pages/checkout/index');
  await wait('.checkout-store', '尚未配置');
  await tap('.checkout-check', '核验商品与费用');
  await wait('.checkout-total', '暂不能确定');
  assert.equal((await page.$$('.checkout-generate')).length, 0);
  console.log('Native unconfigured rules block monetary quote.');
  const login = await fetch(fixture.base + '/api/v1/staff/auth/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
    body: JSON.stringify({ loginName: 'quote-ui-0', password: fixture.password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const me = await (
    await fetch(fixture.base + '/api/v1/staff/me', { headers: { Cookie: cookie } })
  ).json();
  const change = async (body) => {
    const r = await fetch(fixture.base + '/api/v1/admin/checkout-policy', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'http://127.0.0.1:5173',
        Cookie: cookie,
        'X-CSRF-Token': me.data.csrfToken,
        'Idempotency-Key': (await import('node:crypto')).randomUUID(),
      },
      body: JSON.stringify(body),
    });
    assert.equal(r.status, 200);
  };
  const rule = {
    version: null,
    deliveryFeeCents: 300,
    minGoodsCents: 0,
    freeDeliveryThresholdCents: null,
    open: false,
  };
  await change(rule);
  await change({ ...rule, version: 0, open: true });
  await tap('.checkout-refresh', '刷新');
  await wait('.checkout-check', '核验商品与费用');
  await tap('.checkout-check', '核验商品与费用');
  await wait('.checkout-generate', '生成本次报价');
  await wait('.checkout-total', '24.99');
  loseOnce = true;
  await tap('.checkout-generate', '生成本次报价');
  await wait('.checkout-error', '报价结果尚未确认');
  assert.equal(await fixture.runtime.db.checkoutQuote.count(), 1);
  await tap('.checkout-error button', '原报价操作重试');
  await wait('.checkout-expiry', '报价有效至');
  assert.equal(keys[0], keys[1]);
  assert.equal(await fixture.runtime.db.checkoutQuote.count(), 1);
  console.log('Native amounts and original-key recovery verified.');
  if (process.env.YUMI_CHECKOUT_STOP === 'QUOTE') throw Error('CAPTURE_READY:QUOTE');
  readFail = true;
  await tap('.checkout-check', '核验商品与费用');
  await wait('.checkout-error', '合成读取失败');
  readFail = false;
  await tap('.checkout-check', '核验商品与费用');
  await wait('.checkout-generate', '生成本次报价');
  await fixture.runtime.db.stockBalance.update({
    where: {
      warehouseId_skuId: { warehouseId: fixture.warehouseId, skuId: fixture.catalog.skuIds[0] },
    },
    data: { inventoryHold: true },
  });
  await tap('.checkout-check', '核验商品与费用');
  await wait('.checkout-result', '当前库存不足');
  await wait('.checkout-total', '暂不能确定');
  console.log('Native read retry and inventory-hold blockers verified.');
} catch (e) {
  if (!e.message.startsWith('CAPTURE_READY:')) throw e;
  console.log(e.message);
} finally {
  if (mini) {
    try {
      if (mocked) await mini.restoreWxMethod('request');
      if (touched) {
        if (hadSession) await mini.callWxMethod('setStorageSync', sessionKey, backup);
        else await mini.callWxMethod('removeStorageSync', sessionKey);
        if (hadCart) await mini.callWxMethod('setStorageSync', cartKey, cartBackup);
        else await mini.callWxMethod('removeStorageSync', cartKey);
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
