// Ephemeral synthetic cryptographic material. Never exported as HTTP data or written to disk.
import { constants, createCipheriv, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { NotificationVerificationError, verifyPaymentNotification } from './wechat-notification.js';
import type { ExpectedPayment, NotificationFailure } from './wechat-notification.js';
export const notificationLabCases = [
  { code: 'VALID', title: '完整原文验签与资源解密' },
  { code: 'RAW_TAMPER', title: '原文空白被修改时拒绝' },
  { code: 'UNKNOWN_KEY', title: '未知公钥标识不回退' },
  { code: 'EXPIRED', title: '超出时间窗口时拒绝' },
  { code: 'BAD_SIGNATURE', title: '错误签名及签名探测流量拒绝' },
  { code: 'BAD_KEY', title: '错误解密密钥拒绝' },
  { code: 'BAD_TAG', title: '密文认证标签被修改时拒绝' },
  { code: 'BAD_AMOUNT', title: '订单金额不匹配时拒绝' },
  { code: 'BAD_BINDING', title: '商户或小程序归属不匹配时拒绝' },
] as const;
export function syntheticNotification() {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 }),
    apiV3Key = randomBytes(32),
    serial = 'PUB_KEY_ID_0000000001',
    nowSeconds = Math.floor(Date.now() / 1000);
  const expected: ExpectedPayment = {
    appid: 'wx1111111111111111',
    mchid: '1900000109',
    outTradeNo: 'SYNTHETIC_ORDER_ONLY',
    total: 2499,
  };
  function envelope(patch: Record<string, unknown> = {}, associatedData = 'transaction') {
    const nonce = randomBytes(6).toString('hex'),
      cipher = createCipheriv('aes-256-gcm', apiV3Key, Buffer.from(nonce));
    cipher.setAAD(Buffer.from(associatedData));
    const transaction = {
      appid: expected.appid,
      mchid: expected.mchid,
      out_trade_no: expected.outTradeNo,
      transaction_id: 'SYNTHETIC_TRANSACTION_ONLY',
      trade_type: 'JSAPI',
      trade_state: 'SUCCESS',
      success_time: new Date().toISOString(),
      amount: { total: expected.total, currency: 'CNY' },
      payer: { openid: 'SYNTHETIC_PRIVATE_ID' },
      ...patch,
    };
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(transaction), 'utf8'),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    return {
      id: 'SYNTHETIC_NOTIFICATION_ONLY',
      event_type: 'TRANSACTION.SUCCESS',
      resource_type: 'encrypt-resource',
      resource: {
        algorithm: 'AEAD_AES_256_GCM',
        original_type: 'transaction',
        nonce,
        associated_data: associatedData,
        ciphertext: encrypted.toString('base64'),
      },
    };
  }
  function signed(body: unknown = envelope(), timestamp = String(nowSeconds)) {
    const rawBody = Buffer.isBuffer(body)
        ? body
        : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
      nonce = randomBytes(16).toString('hex');
    const signature = sign(
      'RSA-SHA256',
      Buffer.concat([Buffer.from(timestamp + '\n' + nonce + '\n'), rawBody, Buffer.from('\n')]),
      { key: pair.privateKey, padding: constants.RSA_PKCS1_PADDING },
    ).toString('base64');
    return {
      rawBody,
      headers: {
        'Wechatpay-Timestamp': timestamp,
        'Wechatpay-Nonce': nonce,
        'Wechatpay-Serial': serial,
        'Wechatpay-Signature': signature,
      },
      trustedKeys: new Map([[serial, pair.publicKey]]),
      apiV3Key,
      expected,
      nowSeconds,
    };
  }
  return { signed, envelope, expected, apiV3Key, nowSeconds };
}
export function runNotificationSelfTest() {
  const f = syntheticNotification();
  const checks: Array<() => void> = [
    () => {
      const result = verifyPaymentNotification(f.signed());
      if (result.total !== 2499 || 'payer' in result) throw Error('Unexpected projection');
    },
    () => {
      const input = f.signed();
      rejects(
        { ...input, rawBody: Buffer.concat([Buffer.from(' '), input.rawBody]) },
        'SIGNATURE_INVALID',
      );
    },
    () => {
      const input = f.signed();
      input.headers['Wechatpay-Serial'] = 'PUB_KEY_ID_999999';
      rejects(input, 'KEY_UNKNOWN');
    },
    () => rejects(f.signed(f.envelope(), String(f.nowSeconds - 301)), 'TIME_WINDOW'),
    () => {
      const input = f.signed();
      input.headers['Wechatpay-Signature'] = Buffer.alloc(256).toString('base64');
      rejects(input, 'SIGNATURE_INVALID');
      input.headers['Wechatpay-Signature'] = 'WECHATPAY/SIGNTEST/synthetic';
      rejects(input, 'HEADER_INVALID');
    },
    () => rejects({ ...f.signed(), apiV3Key: randomBytes(32) }, 'DECRYPT_FAILED'),
    () => {
      const body = f.envelope(),
        bytes = Buffer.from(body.resource.ciphertext, 'base64');
      bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
      body.resource.ciphertext = bytes.toString('base64');
      rejects(f.signed(body), 'DECRYPT_FAILED');
    },
    () =>
      rejects(f.signed(f.envelope({ amount: { total: 1, currency: 'CNY' } })), 'BINDING_MISMATCH'),
    () => rejects(f.signed(f.envelope({ mchid: 'SYNTHETIC_OTHER_MERCHANT' })), 'BINDING_MISMATCH'),
  ];
  const results = notificationLabCases.map((c, i) => {
    try {
      checks[i]!();
      return { ...c, status: 'PASSED' as const };
    } catch {
      return { ...c, status: 'FAILED' as const };
    }
  });
  return {
    completedAt: new Date().toISOString(),
    syntheticOnly: true as const,
    callbackEnabled: false as const,
    results,
  };
}
function rejects(
  input: Parameters<typeof verifyPaymentNotification>[0],
  code: NotificationFailure,
) {
  try {
    verifyPaymentNotification(input);
  } catch (e) {
    if (e instanceof NotificationVerificationError && e.code === code) return;
    throw e;
  }
  throw Error('Expected rejection');
}
