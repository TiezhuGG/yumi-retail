import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import {
  verifyPaymentNotification,
  NotificationVerificationError,
} from '../apps/api/src/wechat-notification.ts';
import {
  syntheticNotification,
  runNotificationSelfTest,
} from '../apps/api/src/notification-fixtures.ts';
let f: ReturnType<typeof syntheticNotification>;
before(() => {
  f = syntheticNotification();
});
const rejected = (input: Parameters<typeof verifyPaymentNotification>[0], code: string) =>
  assert.throws(
    () => verifyPaymentNotification(input),
    (e) => e instanceof NotificationVerificationError && e.code === code,
  );
test('exact raw bytes verify before AES-GCM decrypt; projection omits payer and full plaintext', () => {
  const input = f.signed(),
    row = verifyPaymentNotification(input);
  assert.equal(row.total, 2499);
  assert.equal(row.outTradeNo, f.expected.outTradeNo);
  assert.ok(!('payer' in row));
  assert.ok(!JSON.stringify(row).includes('SYNTHETIC_PRIVATE_ID'));
  const same = verifyPaymentNotification(input);
  assert.deepEqual(same, row); // Cryptographic checks are not durable notification deduplication.
  const lower = {
    ...input,
    headers: Object.fromEntries(
      Object.entries(input.headers).map(([k, v]) => [k.toLowerCase(), v]),
    ),
  };
  assert.deepEqual(verifyPaymentNotification(lower), row);
});
test('raw whitespace, valid-JSON changes and signatures from another key never verify', () => {
  const input = f.signed();
  rejected(
    { ...input, rawBody: Buffer.concat([input.rawBody, Buffer.from(' ')]) },
    'SIGNATURE_INVALID',
  );
  rejected(
    {
      ...input,
      rawBody: Buffer.from(
        input.rawBody.toString().replace('SYNTHETIC_NOTIFICATION_ONLY', 'SYNTHETIC_OTHER_EVENT'),
      ),
    },
    'SIGNATURE_INVALID',
  );
  const other = syntheticNotification();
  rejected({ ...input, trustedKeys: other.signed().trustedKeys }, 'SIGNATURE_INVALID');
});
test('unknown serial, duplicate/array headers, unsupported signature type, probes and malformed base64 reject', () => {
  const input = f.signed();
  rejected(
    { ...input, headers: { ...input.headers, 'Wechatpay-Serial': 'PUB_KEY_ID_UNKNOWN' } },
    'KEY_UNKNOWN',
  );
  rejected(
    {
      ...input,
      headers: { ...input.headers, 'wechatpay-serial': input.headers['Wechatpay-Serial'] },
    },
    'HEADER_INVALID',
  );
  rejected(
    { ...input, headers: { ...input.headers, 'Wechatpay-Nonce': ['a', 'b'] } },
    'HEADER_INVALID',
  );
  rejected(
    { ...input, headers: { ...input.headers, 'Wechatpay-Signature-Type': 'HMAC' } },
    'HEADER_INVALID',
  );
  for (const signature of [
    'WECHATPAY/SIGNTEST/synthetic',
    'bad???',
    Buffer.alloc(256).toString('base64'),
  ])
    rejected(
      { ...input, headers: { ...input.headers, 'Wechatpay-Signature': signature } },
      signature.startsWith('WECHATPAY/') ? 'HEADER_INVALID' : 'SIGNATURE_INVALID',
    );
  rejected(
    { ...input, headers: { ...input.headers, 'Wechatpay-Nonce': 'line\nbreak' } },
    'HEADER_INVALID',
  );
  const weak = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey;
  rejected(
    { ...input, trustedKeys: new Map([[input.headers['Wechatpay-Serial'], weak]]) },
    'KEY_UNKNOWN',
  );
});
test('clock window is explicit and bounded in both directions', () => {
  for (const diff of [-301, 301])
    rejected(f.signed(f.envelope(), String(f.nowSeconds + diff)), 'TIME_WINDOW');
  assert.equal(
    verifyPaymentNotification(f.signed(f.envelope(), String(f.nowSeconds - 300))).total,
    2499,
  );
  rejected({ ...f.signed(), nowSeconds: NaN }, 'TIME_WINDOW');
});
test('bounded raw body, invalid UTF8/JSON and unsupported event/resource algorithm reject', () => {
  const input = f.signed();
  rejected({ ...input, rawBody: Buffer.alloc(65537) }, 'BODY_INVALID');
  rejected(f.signed('{'), 'BODY_INVALID');
  rejected(f.signed(Buffer.from([0xff])), 'BODY_INVALID');
  const bad = f.envelope();
  bad.event_type = 'REFUND.SUCCESS';
  rejected(f.signed(bad), 'BODY_INVALID');
  const algorithm = f.envelope();
  algorithm.resource.algorithm = 'AES-CBC';
  rejected(f.signed(algorithm), 'RESOURCE_INVALID');
  const malformed = f.envelope();
  malformed.resource.ciphertext = '%%%=';
  rejected(f.signed(malformed), 'RESOURCE_INVALID');
  const nonce = f.envelope();
  nonce.resource.nonce = 'too-short';
  rejected(f.signed(nonce), 'RESOURCE_INVALID');
});
test('wrong key/tag/AAD cannot decrypt even with a valid envelope signature; empty optional AAD works', () => {
  rejected({ ...f.signed(), apiV3Key: randomBytes(32) }, 'DECRYPT_FAILED');
  rejected({ ...f.signed(), apiV3Key: randomBytes(31) }, 'RESOURCE_INVALID');
  const body = f.envelope(),
    bytes = Buffer.from(body.resource.ciphertext, 'base64');
  bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
  body.resource.ciphertext = bytes.toString('base64');
  rejected(f.signed(body), 'DECRYPT_FAILED');
  const aad = f.envelope();
  aad.resource.associated_data = 'wrong';
  rejected(f.signed(aad), 'DECRYPT_FAILED');
  const empty = f.envelope({}, '');
  assert.equal(verifyPaymentNotification(f.signed(empty)).total, 2499);
  delete (empty.resource as { associated_data?: string }).associated_data;
  assert.equal(verifyPaymentNotification(f.signed(empty)).total, 2499);
});
test('state, integer amount/currency, app/merchant/order bindings all fail closed', () => {
  for (const patch of [
    { appid: 'OTHER' },
    { mchid: 'OTHER' },
    { out_trade_no: 'OTHER' },
    { amount: { total: 1, currency: 'CNY' } },
  ])
    rejected(f.signed(f.envelope(patch)), 'BINDING_MISMATCH');
  for (const patch of [
    { trade_state: 'NOTPAY' },
    { trade_type: 'NATIVE' },
    { amount: { total: 24.99, currency: 'CNY' } },
    { amount: { total: -1, currency: 'CNY' } },
    { amount: { total: 2499, currency: 'USD' } },
    { amount: { total: '2499', currency: 'CNY' } },
    { success_time: 'bad' },
  ])
    rejected(f.signed(f.envelope(patch)), 'TRANSACTION_INVALID');
});
test('self-test uses real crypto for all nine cases and returns only fixed metadata', () => {
  const result = runNotificationSelfTest();
  assert.equal(result.syntheticOnly, true);
  assert.equal(result.callbackEnabled, false);
  assert.equal(result.results.length, 9);
  assert.ok(result.results.every((c) => c.status === 'PASSED'));
  const text = JSON.stringify(result);
  for (const term of [
    'PRIVATE KEY',
    'ciphertext',
    'SYNTHETIC_PRIVATE_ID',
    '1900000109',
    'wx1111111111111111',
  ])
    assert.ok(!text.includes(term), term);
});
