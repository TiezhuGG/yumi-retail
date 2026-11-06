import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  WechatPayerPrivateData,
  payerEncryptionConfiguration,
} from '../apps/api/src/wechat-payer-private.ts';
const openId = 'synthetic-openid-payer-0001',
  appId = 'wx' + '0'.repeat(16);
const identity = {
  userId: randomUUID(),
  appId,
  subject: createHash('sha256')
    .update(appId + ':' + openId)
    .digest('hex'),
};
const config = { keyId: 'synthetic-v1', keyHex: randomBytes(32).toString('hex') };
const code = (expected: string) => (e: unknown) => {
  assert.equal((e as { getResponse(): { code: string } }).getResponse().code, expected);
  return true;
};
test('payer configuration is optional, paired, validated and independent of address encryption', () => {
  assert.equal(payerEncryptionConfiguration({}), undefined);
  for (const env of [
    { WECHAT_PAYER_KEY_ID: config.keyId },
    { WECHAT_PAYER_ENCRYPTION_KEY: config.keyHex },
    { WECHAT_PAYER_KEY_ID: '../bad', WECHAT_PAYER_ENCRYPTION_KEY: config.keyHex },
    { WECHAT_PAYER_KEY_ID: config.keyId, WECHAT_PAYER_ENCRYPTION_KEY: 'invalid' },
    {
      WECHAT_PAYER_KEY_ID: config.keyId,
      WECHAT_PAYER_ENCRYPTION_KEY: config.keyHex,
      ADDRESS_ENCRYPTION_KEY: config.keyHex.toUpperCase(),
    },
  ])
    assert.throws(() => payerEncryptionConfiguration(env));
  assert.deepEqual(
    payerEncryptionConfiguration({
      WECHAT_PAYER_KEY_ID: config.keyId,
      WECHAT_PAYER_ENCRYPTION_KEY: config.keyHex,
    }),
    config,
  );
  assert.throws(
    () => new WechatPayerPrivateData().encrypt(identity, openId),
    code('PAYER_STORAGE_UNAVAILABLE'),
  );
});
test('payer ciphertext is randomized and authenticated against customer, application and identity hash', () => {
  const storage = new WechatPayerPrivateData(config),
    value = storage.encrypt(identity, openId);
  assert.notEqual(value.payload, storage.encrypt(identity, openId).payload);
  assert.ok(!value.payload.includes(openId));
  assert.equal(storage.decrypt(identity, value), openId);
  for (const other of [
    { ...identity, userId: randomUUID() },
    { ...identity, appId: 'wx' + '1'.repeat(16) },
    { ...identity, subject: 'a'.repeat(64) },
  ])
    assert.throws(() => storage.decrypt(other, value), code('PAYER_IDENTITY_UNREADABLE'));
  assert.throws(
    () => storage.encrypt(identity, 'synthetic-other-openid'),
    code('PAYER_IDENTITY_INVALID'),
  );
  const parts = value.payload.split('.');
  parts[3] = Buffer.from('synthetic-tampered-identity').toString('base64');
  for (const payload of [
    parts.join('.'),
    value.payload + '.',
    'v1.bad.bad.bad',
    value.payload.replace('v1.', 'v2.'),
    'x'.repeat(513),
  ])
    assert.throws(
      () => storage.decrypt(identity, { ...value, payload }),
      code('PAYER_IDENTITY_UNREADABLE'),
    );
});
test('unknown key revision requires verified login; wrong key cannot decrypt and exposes no plaintext', () => {
  const value = new WechatPayerPrivateData(config).encrypt(identity, openId);
  assert.throws(
    () => new WechatPayerPrivateData({ ...config, keyId: 'synthetic-v2' }).decrypt(identity, value),
    code('PAYER_REFRESH_REQUIRED'),
  );
  assert.throws(
    () =>
      new WechatPayerPrivateData({ ...config, keyHex: randomBytes(32).toString('hex') }).decrypt(
        identity,
        value,
      ),
    code('PAYER_IDENTITY_UNREADABLE'),
  );
});
