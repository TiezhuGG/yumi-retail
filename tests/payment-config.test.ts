import { test } from 'node:test';
import assert from 'node:assert/strict';
import { paymentConfiguration, assertDisabledPaymentMode } from '../apps/api/src/payment-config.ts';
import { applicationConfig } from '../apps/api/src/config.ts';
import { randomBytes } from 'node:crypto';
test('payer storage report distinguishes absent, invalid and configured without returning encryption values', () => {
  const key = randomBytes(32).toString('hex'),
    keyId = 'synthetic-secret-key-id';
  const configured = paymentConfiguration({
    WECHAT_PAYER_KEY_ID: keyId,
    WECHAT_PAYER_ENCRYPTION_KEY: key,
  });
  assert.equal(configured[3]!.status, 'CONFIGURED');
  assert.ok(!JSON.stringify(configured).includes(key));
  assert.ok(!JSON.stringify(configured).includes(keyId));
  assert.equal(paymentConfiguration({ WECHAT_PAYER_KEY_ID: keyId })[3]!.status, 'INVALID');
  assert.equal(
    paymentConfiguration({
      WECHAT_PAYER_KEY_ID: keyId,
      WECHAT_PAYER_ENCRYPTION_KEY: key,
      ADDRESS_ENCRYPTION_KEY: key,
    })[3]!.status,
    'INVALID',
  );
});
test('optional configuration is missing by default and no environment values or credentials are returned', () => {
  const report = paymentConfiguration({
    WECHAT_PAY_PRIVATE_KEY: 'synthetic-do-not-leak',
    WECHAT_PAY_API_V3_KEY: 'synthetic-secret',
  });
  assert.ok(report.every((c) => c.status === 'MISSING'));
  assert.ok(!JSON.stringify(report).includes('synthetic'));
});
test('format-only fields never claim merchant ownership, connectivity or payment readiness', () => {
  const env = {
    WECHAT_PAY_APP_ID: 'wx1111111111111111',
    WECHAT_PAY_MCH_ID: '1900000109',
    WECHAT_PAY_NOTIFY_URL: 'https://payments.yumi-demo.com/api/v1/wechat/notify',
  };
  assert.equal(
    paymentConfiguration({ WECHAT_PAY_APP_ID: 'wxd678efh567hg6787' })[0]!.status,
    'FORMAT_OK',
  );
  const checks = paymentConfiguration(env);
  assert.ok(checks.slice(0, 3).every((c) => c.status === 'FORMAT_OK'));
  assert.equal(checks[3]!.status, 'MISSING');
  for (const value of Object.values(env)) assert.ok(!JSON.stringify(checks).includes(value));
  for (const field of ['WECHAT_PAY_APP_ID', 'WECHAT_PAY_MCH_ID'] as const) {
    assert.equal(
      paymentConfiguration({ ...env, [field]: ' ' + env[field] })[
        field === 'WECHAT_PAY_APP_ID' ? 0 : 1
      ]!.status,
      'INVALID',
    );
  }
});
test('notify URL rejects local/IP, insecure or ambiguous input without a network request', () => {
  for (const value of [
    'http://pay.yumi-demo.com/notify',
    'https://localhost/notify',
    'https://pay.local/notify',
    'https://pay.internal/notify',
    'https://pay.test/notify',
    'https://pay.invalid/notify',
    'https://127.0.0.1/notify',
    'https://2130706433/notify',
    'https://[::1]/notify',
    'https://user:synthetic-secret@pay.yumi-demo.com/notify',
    'https://pay.yumi-demo.com/notify?token=secret',
    'https://pay.yumi-demo.com/notify#fragment',
    'https://pay.yumi-demo.com/',
    'https://pay.yumi-demo.com:8443/notify',
    'https://pay.yumi-demo.com\\other/notify',
    ' https://pay.yumi-demo.com/notify',
    'https://pay.yumi-demo.com/notify\n',
    'x'.repeat(513),
  ])
    assert.equal(
      paymentConfiguration({ WECHAT_PAY_NOTIFY_URL: value })[2]!.status,
      'INVALID',
      value,
    );
  assert.equal(
    paymentConfiguration({ WECHAT_PAY_NOTIFY_URL: 'https://pay.yumi-demo.com/notify' })[2]!.status,
    'FORMAT_OK',
  );
});
test('central configuration rejects every unsupported payment mode and never reflects the input', () => {
  assert.doesNotThrow(() => assertDisabledPaymentMode({}));
  assert.doesNotThrow(() => assertDisabledPaymentMode({ PAYMENT_MODE: 'disabled' }));
  for (const mode of ['wechat', 'mock', 'sandbox', '', 'DISABLED', 'synthetic-secret-mode']) {
    assert.throws(
      () => applicationConfig({ PAYMENT_MODE: mode }),
      (e) => e instanceof Error && !e.message.includes(mode || 'unexpected-empty-string'),
    );
  }
});
