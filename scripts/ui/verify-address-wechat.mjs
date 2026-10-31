/* global global, yumiAddressBridge */
// Actual native components + isolated PostgreSQL API bridge; not legal-domain or device acceptance.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { addressFixture } from '../../tests/helpers/address-fixture.ts';
if (process.env.YUMI_LIVE_UI !== '1' || process.env.NODE_ENV === 'production')
  throw Error('Local opt-in only');
const require = createRequire(import.meta.url),
  automator = require(process.env.YUMI_MINI_AUTOMATOR_PATH || 'miniprogram-automator');
const fixture = await addressFixture();
const sessionKey = 'yumi.consumer-session.v1:http://127.0.0.1:3000/api/v1';
let mini,
  page,
  backup,
  hadSession = false,
  touched = false,
  mocked = false,
  modal = false,
  bridgeError,
  loseOnce = false,
  readFail = false,
  delay = 0;
const keys = [];
try {
  mini = await automator.connect({ wsEndpoint: 'ws://127.0.0.1:9420' });
  const storage = (await mini.callWxMethod('getStorageInfoSync')).keys;
  hadSession = storage.includes(sessionKey);
  if (hadSession) backup = await mini.callWxMethod('getStorageSync', sessionKey);
  touched = true;
  await mini.callWxMethod('setStorageSync', sessionKey, {
    token: fixture.identity.token,
    expiresAt: fixture.identity.expiresAt,
  });
  await mini.evaluate(() => {
    global.__yumiAddressResponses = {};
    global.__yumiAddressSequence = 0;
  });
  await mini.exposeFunction('yumiAddressBridge', (id, options) => {
    void (async () => {
      const route = options.url.split('/api/v1')[1] || '';
      if (delay) await new Promise((r) => setTimeout(r, delay));
      let result;
      if (readFail && route === '/consumer/addresses' && options.method === 'GET')
        result = { statusCode: 503, data: { error: { message: '合成读取失败' } } };
      else {
        const response = await fetch(fixture.base + '/api/v1' + route, {
          method: options.method,
          headers: options.header,
          body: options.method === 'GET' ? undefined : JSON.stringify(options.data),
        });
        result = { statusCode: response.status, data: await response.json() };
        if (route.startsWith('/consumer/addresses') && options.method === 'POST') {
          keys.push(options.header['Idempotency-Key']);
          if (loseOnce && response.status === 200) {
            loseOnce = false;
            result = { statusCode: 503, data: { error: { message: '合成响应丢失' } } };
          }
        }
      }
      await mini.evaluate(
        (id, value) => {
          const callback = global.__yumiAddressResponses[id];
          delete global.__yumiAddressResponses[id];
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
      const id = ++global.__yumiAddressSequence;
      global.__yumiAddressResponses[id] = resolve;
      yumiAddressBridge(id, {
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
  page = await mini.reLaunch('/pages/addresses/index');
  await wait('.address-state', '还没有保存收货地址');
  await tap('.address-add');
  await wait('.address-form');
  await (await page.$('picker')).trigger('change', { value: '0' });
  const inputs = await page.$$('.address-input');
  await inputs[1].input('合成门牌101');
  await inputs[2].input('合成验收联系人');
  await inputs[3].input('00000000000');
  await (await page.$('switch')).trigger('change', { value: true });
  if (process.env.YUMI_ADDRESS_STOP === 'FORM') throw Error('CAPTURE_READY:FORM');
  loseOnce = true;
  await tap('.address-save', '保存地址');
  await wait('.address-alert', '保存结果尚未确认');
  assert.equal(await fixture.runtime.db.consumerAddress.count(), 1);
  await tap('.address-alert button', '原操作重试确认');
  await wait('.address-card', '合成门牌101');
  assert.equal(keys[0], keys[1]);
  assert.equal(await fixture.runtime.db.consumerAddress.count(), 1);
  await wait('.address-default-tag', '默认');
  if (process.env.YUMI_ADDRESS_STOP === 'READY') throw Error('CAPTURE_READY:READY');
  console.log('Native create/default and unknown same-key retry verified.');
  await tap('.address-actions button', '编辑');
  await wait('.address-form');
  await (await page.$$('.address-input'))[1].input('合成门牌202');
  await tap('.address-save', '保存地址');
  await wait('.address-card', '合成门牌202');
  readFail = true;
  await tap('.address-toolbar button', '刷新地址');
  await wait('.address-state', '暂时无法读取地址');
  readFail = false;
  await tap('.address-state button', '重试读取');
  await wait('.address-card', '合成门牌202');
  await fixture.runtime.db.serviceBuilding.update({
    where: { id: fixture.buildingId },
    data: { enabled: false },
  });
  await tap('.address-toolbar button', '刷新地址');
  await wait('.address-unavailable', '此地址暂不在有效配送范围');
  await mini.mockWxMethod('showModal', { confirm: true, cancel: false });
  modal = true;
  await tap('.address-actions button', '删除');
  await wait('.address-state', '还没有保存收货地址');
  assert.equal((await fixture.runtime.db.consumerAddress.findFirstOrThrow()).payload, null);
  console.log('Native edit/error/retry, inactive range and delete verified.');
} catch (e) {
  if (!e.message.startsWith('CAPTURE_READY:')) throw e;
  console.log(e.message);
} finally {
  if (mini) {
    try {
      if (modal) await mini.restoreWxMethod('showModal');
      if (mocked) await mini.restoreWxMethod('request');
      if (touched) {
        if (hadSession) await mini.callWxMethod('setStorageSync', sessionKey, backup);
        else await mini.callWxMethod('removeStorageSync', sessionKey);
      }
      await mini.disconnect();
    } catch (e) {
      console.error('Native restore failed:', e.message);
    }
  }
  await fixture.cleanup();
}
