import assert from 'node:assert/strict';
import { test } from 'node:test';
import { constants, generateKeyPairSync, sign, verify } from 'node:crypto';
import {
  createJsapiProtocol,
  JsapiProtocolError,
  type JsapiMerchant,
  type JsapiOrder,
} from '../apps/api/src/wechat-jsapi.ts';
const merchantKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const platformKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const now = 1793923200;
const serial = 'PUB_KEY_ID_SYNTHETIC';
const merchant: JsapiMerchant = {
  appId: 'wx1111111111111111',
  merchantId: '1900000109',
  certificateSerial: 'ABCDEF123456',
  privateKey: merchantKeys.privateKey,
  notifyUrl: 'https://payments.yumi-demo.com/api/v1/wechat/notify',
};
const order: JsapiOrder = {
  outTradeNo: 'Y20261106000000000ABCDEF123456',
  totalCents: 2499,
  description: '合成纸巾与日用品',
  paymentDeadline: new Date((now + 900) * 1000),
  payer: { provider: 'WECHAT', appId: merchant.appId, openId: 'o_synthetic_payer_original_id' },
};
const core = () => createJsapiProtocol(merchant, new Map([[serial, platformKeys.publicKey]]));
function response(
  rawBody = Buffer.from(JSON.stringify({ prepay_id: 'wx_synthetic_prepay' })),
  seconds = now,
) {
  const nonce = 'synthetic_response_nonce';
  return {
    status: 200,
    rawBody,
    headers: {
      'Wechatpay-Timestamp': String(seconds),
      'Wechatpay-Nonce': nonce,
      'Wechatpay-Serial': serial,
      'Wechatpay-Signature': sign(
        'RSA-SHA256',
        Buffer.concat([Buffer.from(seconds + '\n' + nonce + '\n'), rawBody, Buffer.from('\n')]),
        { key: platformKeys.privateKey, padding: constants.RSA_PKCS1_PADDING },
      ).toString('base64'),
    },
  };
}
const rejects = (fn: () => unknown, code: string) =>
  assert.throws(fn, (e) => e instanceof JsapiProtocolError && e.code === code);

test('JSAPI request signs the exact immutable UTF-8 body and fixed path with independent RSA verification', () => {
  const request = core().prepay(order, now);
  assert.equal(request.method, 'POST');
  assert.equal(request.url, 'https://api.mch.weixin.qq.com/v3/pay/transactions/jsapi');
  assert.equal(request.headers.Accept, 'application/json');
  assert.equal(request.headers['Content-Type'], 'application/json');
  const body = JSON.parse(request.body);
  assert.deepEqual(body.amount, { total: 2499, currency: 'CNY' });
  assert.deepEqual(body.payer, { openid: order.payer.openId });
  assert.equal(body.time_expire, new Date((now + 900) * 1000).toISOString().replace('.000Z', 'Z'));
  assert.equal(body.notify_url, merchant.notifyUrl);
  const header = request.headers.Authorization!;
  assert.ok(header.startsWith('WECHATPAY2-SHA256-RSA2048 '));
  const values = Object.fromEntries(
    [...header.matchAll(/(\w+)="([^"]+)"/g)].map((m) => [m[1], m[2]]),
  );
  assert.equal(values.mchid, merchant.merchantId);
  assert.equal(values.serial_no, merchant.certificateSerial);
  assert.equal(values.timestamp, String(now));
  assert.match(values.nonce_str!, /^[a-f0-9]{32}$/);
  const canonical = `POST\n/v3/pay/transactions/jsapi\n${now}\n${values.nonce_str}\n${request.body}\n`;
  assert.equal(
    verify(
      'RSA-SHA256',
      Buffer.from(canonical),
      merchantKeys.publicKey,
      Buffer.from(values.signature!, 'base64'),
    ),
    true,
  );
  assert.equal(
    verify(
      'RSA-SHA256',
      Buffer.from(canonical + ' '),
      merchantKeys.publicKey,
      Buffer.from(values.signature!, 'base64'),
    ),
    false,
  );
  assert.throws(() => {
    (request as { url: string }).url = 'https://untrusted.invalid';
  }, TypeError);
  assert.throws(() => {
    (request.headers as Record<string, string>).Authorization = 'changed';
  }, TypeError);
});
test('same business request keeps trade number, amount, deadline and body while obtaining a fresh nonce', () => {
  const protocol = core(),
    a = protocol.prepay(order, now),
    b = protocol.prepay(order, now + 1);
  assert.equal(a.body, b.body);
  assert.notEqual(a.headers.Authorization, b.headers.Authorization);
});
test('only a verified response for an issued request yields the five mini-program invocation fields, signed with the same merchant and AppID', () => {
  const protocol = core(),
    request = protocol.prepay(order, now);
  const result = protocol.invocation(request, response(), now);
  assert.deepEqual(
    Object.keys(result).sort(),
    ['nonceStr', 'package', 'paySign', 'signType', 'timeStamp'].sort(),
  );
  assert.equal(result.package, 'prepay_id=wx_synthetic_prepay');
  assert.equal(result.signType, 'RSA');
  assert.match(result.nonceStr, /^[a-f0-9]{32}$/);
  const canonical = `${merchant.appId}\n${result.timeStamp}\n${result.nonceStr}\n${result.package}\n`;
  assert.equal(
    verify(
      'RSA-SHA256',
      Buffer.from(canonical),
      merchantKeys.publicKey,
      Buffer.from(result.paySign, 'base64'),
    ),
    true,
  );
  assert.equal(
    verify(
      'RSA-SHA256',
      Buffer.from(canonical.replace(merchant.appId, 'wx2222222222222222')),
      merchantKeys.publicKey,
      Buffer.from(result.paySign, 'base64'),
    ),
    false,
  );
  assert.equal(JSON.stringify(result).includes(order.payer.openId), false);
});
test('body changes, missing/duplicate headers, unknown serials, stale times, malformed signatures and signature probes cannot produce invocation data', () => {
  const protocol = core(),
    request = protocol.prepay(order, now),
    r = response();
  rejects(
    () =>
      protocol.invocation(
        request,
        { ...r, rawBody: Buffer.concat([r.rawBody, Buffer.from(' ')]) },
        now,
      ),
    'SIGNATURE_INVALID',
  );
  rejects(() => protocol.invocation(request, { ...r, headers: {} }, now), 'HEADER_INVALID');
  rejects(
    () =>
      protocol.invocation(
        request,
        { ...r, headers: { ...r.headers, 'wechatpay-serial': serial } },
        now,
      ),
    'HEADER_INVALID',
  );
  rejects(
    () =>
      protocol.invocation(
        request,
        { ...r, headers: { ...r.headers, 'Wechatpay-Serial': 'PUB_KEY_ID_OTHER' } },
        now,
      ),
    'KEY_UNKNOWN',
  );
  rejects(() => protocol.invocation(request, response(undefined, now - 301), now), 'TIME_WINDOW');
  rejects(() => protocol.invocation(request, response(undefined, now + 301), now), 'TIME_WINDOW');
  rejects(
    () =>
      protocol.invocation(
        request,
        { ...r, headers: { ...r.headers, 'Wechatpay-Signature': 'WECHATPAY/SIGNTEST/synthetic' } },
        now,
      ),
    'HEADER_INVALID',
  );
  rejects(
    () =>
      protocol.invocation(
        request,
        { ...r, headers: { ...r.headers, 'Wechatpay-Signature': '***=' } },
        now,
      ),
    'SIGNATURE_INVALID',
  );
  const other = createJsapiProtocol(merchant, new Map([[serial, merchantKeys.publicKey]]));
  rejects(() => other.invocation(other.prepay(order, now), r, now), 'SIGNATURE_INVALID');
});
test('signed error statuses, non-object JSON, invalid UTF-8 and unsafe or missing prepay IDs remain unusable', () => {
  const protocol = core(),
    request = protocol.prepay(order, now);
  rejects(
    () => protocol.invocation(request, { ...response(), status: 500 }, now),
    'STATUS_UNEXPECTED',
  );
  for (const value of [
    null,
    [],
    {},
    { prepay_id: 2 },
    { prepay_id: '' },
    { prepay_id: 'x'.repeat(65) },
    { prepay_id: 'unsafe\nvalue' },
  ])
    rejects(
      () => protocol.invocation(request, response(Buffer.from(JSON.stringify(value))), now),
      'RESPONSE_INVALID',
    );
  rejects(
    () => protocol.invocation(request, response(Buffer.from([0xff, 0xfe])), now),
    'RESPONSE_INVALID',
  );
  rejects(
    () => protocol.invocation(request, response(Buffer.from('{invalid JSON')), now),
    'RESPONSE_INVALID',
  );
  rejects(() => protocol.invocation(request, response(Buffer.alloc(65537)), now), 'BODY_INVALID');
});
test('fractional/unsafe amounts, invalid trade numbers, descriptions and deadlines reject before generating a request', () => {
  const protocol = core();
  for (const totalCents of [0, -1, 0.1, NaN, Infinity, 2147483648, Number.MAX_SAFE_INTEGER])
    rejects(() => protocol.prepay({ ...order, totalCents }, now), 'ORDER_INVALID');
  for (const outTradeNo of ['short', 'x'.repeat(33), 'injection\n', '订单编号'])
    rejects(() => protocol.prepay({ ...order, outTradeNo }, now), 'ORDER_INVALID');
  for (const description of ['', ' ', 'x'.repeat(128), 'bad\ntext', 'hidden\u200btext'])
    rejects(() => protocol.prepay({ ...order, description }, now), 'ORDER_INVALID');
  for (const deadline of [now - 1, now + 59, now + 15 * 86400 + 1, NaN])
    rejects(
      () => protocol.prepay({ ...order, paymentDeadline: new Date(deadline * 1000) }, now),
      'ORDER_INVALID',
    );
  rejects(() => protocol.prepay(order, now * 1000), 'ORDER_INVALID');
  assert.doesNotThrow(() =>
    protocol.prepay(
      { ...order, description: '纸'.repeat(127), paymentDeadline: new Date((now + 60) * 1000) },
      now,
    ),
  );
});
test('wrong-app or development payers and header injection are rejected without reflecting private input', () => {
  const protocol = core();
  for (const payer of [
    { ...order.payer, provider: 'DEVELOPMENT' },
    { ...order.payer, appId: 'wx2222222222222222' },
    { ...order.payer, openId: 'customer-a' },
    { ...order.payer, openId: 'synthetic_private_openid\n' },
  ])
    rejects(
      () => protocol.prepay({ ...order, payer: payer as JsapiOrder['payer'] }, now),
      'PAYER_INVALID',
    );
  for (const config of [
    { ...merchant, certificateSerial: 'secret\nheader' },
    { ...merchant, notifyUrl: 'https://127.0.0.1/notify' },
    { ...merchant, appId: 'synthetic_private_appid' },
    { ...merchant, notifyUrl: 'https://pay.yumi-demo.com/' + 'x'.repeat(256) },
  ])
    assert.throws(
      () => createJsapiProtocol(config, new Map()),
      (e) =>
        e instanceof JsapiProtocolError &&
        e.code === 'CONFIG_INVALID' &&
        !e.message.includes('secret') &&
        !e.message.includes('synthetic_private'),
    );
});
test('merchant signing requires private RSA2048 and trusted response key choices stay pinned to the protocol instance', () => {
  for (const privateKey of [
    merchantKeys.publicKey,
    generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey,
    generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey,
  ])
    rejects(() => createJsapiProtocol({ ...merchant, privateKey }, new Map()), 'KEY_INVALID');
  const config = { ...merchant },
    keys = new Map([[serial, platformKeys.publicKey]]);
  const protocol = createJsapiProtocol(config, keys);
  config.appId = 'wx2222222222222222';
  keys.clear();
  const request = protocol.prepay(order, now);
  assert.equal(JSON.parse(request.body).appid, merchant.appId);
  assert.equal(protocol.invocation(request, response(), now).signType, 'RSA');
});
test('unissued/cross-instance requests, expired orders, backward clocks and prepay sessions over two hours cannot be invoked', () => {
  const protocol = core(),
    request = protocol.prepay(order, now);
  rejects(() => core().invocation(request, response(), now), 'REQUEST_UNKNOWN');
  rejects(() => protocol.invocation({ ...request }, response(), now), 'REQUEST_UNKNOWN');
  rejects(
    () => protocol.invocation(request, response(undefined, now + 900), now + 900),
    'REQUEST_EXPIRED',
  );
  rejects(
    () => protocol.invocation(request, response(undefined, now - 1), now - 1),
    'REQUEST_EXPIRED',
  );
  const long = protocol.prepay({ ...order, paymentDeadline: new Date((now + 86400) * 1000) }, now);
  rejects(
    () => protocol.invocation(long, response(undefined, now + 7200), now + 7200),
    'REQUEST_EXPIRED',
  );
});
