import { constants, createDecipheriv, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { TextDecoder } from 'node:util';
export type NotificationFailure =
  | 'HEADER_INVALID'
  | 'TIME_WINDOW'
  | 'KEY_UNKNOWN'
  | 'SIGNATURE_INVALID'
  | 'BODY_INVALID'
  | 'RESOURCE_INVALID'
  | 'DECRYPT_FAILED'
  | 'TRANSACTION_INVALID'
  | 'BINDING_MISMATCH';
export class NotificationVerificationError extends Error {
  constructor(readonly code: NotificationFailure) {
    super('Payment notification verification rejected: ' + code);
  }
}
const reject = (code: NotificationFailure): never => {
  throw new NotificationVerificationError(code);
};
export interface ExpectedPayment {
  appid: string;
  mchid: string;
  outTradeNo: string;
  total: number;
}
export interface DecodedPaymentNotification {
  notificationId: string;
  outTradeNo: string;
  transactionId: string;
  total: number;
  currency: 'CNY';
  successTime: string;
}
function record(value: unknown, code: NotificationFailure): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject(code);
  return value as Record<string, unknown>;
}
function parse(bytes: Buffer, code: NotificationFailure) {
  try {
    return record(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)), code);
  } catch {
    return reject(code);
  }
}
function text(v: unknown, max: number, code: NotificationFailure) {
  if (
    typeof v !== 'string' ||
    !v.length ||
    v.length > max ||
    Array.from(v).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    return reject(code);
  return v;
}
function base64(s: unknown, max: number, code: NotificationFailure) {
  if (
    typeof s !== 'string' ||
    !s.length ||
    s.length > max ||
    s.length % 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)
  )
    return reject(code);
  const b = Buffer.from(s, 'base64');
  if (b.toString('base64') !== s) return reject(code);
  return b;
}
// Pure core only: no HTTP receiver, provider calls, certificate discovery, persistence or paid transition.
export function verifyPaymentNotification(input: {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  trustedKeys: ReadonlyMap<string, KeyObject>;
  apiV3Key: Buffer;
  expected: ExpectedPayment;
  nowSeconds: number;
}): DecodedPaymentNotification {
  const headers = new Map<string, string>();
  for (const [name, value] of Object.entries(input.headers)) {
    const lower = name.toLowerCase();
    if (!lower.startsWith('wechatpay-')) continue;
    if (
      headers.has(lower) ||
      typeof value !== 'string' ||
      !value.length ||
      value.length > 1024 ||
      Array.from(value).some((c) => c.charCodeAt(0) < 33 || c.charCodeAt(0) > 126)
    )
      return reject('HEADER_INVALID');
    headers.set(lower, value);
  }
  const timestamp = headers.get('wechatpay-timestamp'),
    nonce = headers.get('wechatpay-nonce'),
    serial = headers.get('wechatpay-serial'),
    signature = headers.get('wechatpay-signature');
  if (
    !timestamp ||
    !/^\d{10}$/.test(timestamp) ||
    !nonce ||
    nonce.length > 128 ||
    !serial ||
    !/^[A-Za-z0-9_]{1,128}$/.test(serial) ||
    !signature ||
    signature.startsWith('WECHATPAY/SIGNTEST/') ||
    (headers.has('wechatpay-signature-type') &&
      headers.get('wechatpay-signature-type') !== 'WECHATPAY2-SHA256-RSA2048')
  )
    return reject('HEADER_INVALID');
  if (
    !Number.isSafeInteger(input.nowSeconds) ||
    Math.abs(input.nowSeconds - Number(timestamp)) > 300
  )
    return reject('TIME_WINDOW');
  const key = input.trustedKeys.get(serial);
  if (
    !key ||
    key.type !== 'public' ||
    key.asymmetricKeyType !== 'rsa' ||
    key.asymmetricKeyDetails?.modulusLength !== 2048
  )
    return reject('KEY_UNKNOWN');
  const decodedSignature = base64(signature, 1024, 'SIGNATURE_INVALID');
  if (decodedSignature.length !== 256) return reject('SIGNATURE_INVALID');
  if (!Buffer.isBuffer(input.rawBody) || !input.rawBody.length || input.rawBody.length > 65536)
    return reject('BODY_INVALID');
  const message = Buffer.concat([
    Buffer.from(timestamp + '\n' + nonce + '\n'),
    input.rawBody,
    Buffer.from('\n'),
  ]);
  if (
    !verify('RSA-SHA256', message, { key, padding: constants.RSA_PKCS1_PADDING }, decodedSignature)
  )
    return reject('SIGNATURE_INVALID');
  const body = parse(input.rawBody, 'BODY_INVALID'),
    notificationId = text(body.id, 128, 'BODY_INVALID');
  if (body.event_type !== 'TRANSACTION.SUCCESS' || body.resource_type !== 'encrypt-resource')
    return reject('BODY_INVALID');
  const resource = record(body.resource, 'RESOURCE_INVALID');
  if (
    resource.algorithm !== 'AEAD_AES_256_GCM' ||
    resource.original_type !== 'transaction' ||
    typeof resource.nonce !== 'string' ||
    Buffer.byteLength(resource.nonce) !== 12 ||
    !Buffer.isBuffer(input.apiV3Key) ||
    input.apiV3Key.length !== 32
  )
    return reject('RESOURCE_INVALID');
  const aad = resource.associated_data === undefined ? '' : resource.associated_data;
  if (typeof aad !== 'string' || Buffer.byteLength(aad) > 16) return reject('RESOURCE_INVALID');
  const ciphertext = base64(resource.ciphertext, 65536, 'RESOURCE_INVALID');
  if (ciphertext.length <= 16) return reject('RESOURCE_INVALID');
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', input.apiV3Key, Buffer.from(resource.nonce));
    decipher.setAAD(Buffer.from(aad));
    decipher.setAuthTag(ciphertext.subarray(-16));
    plaintext = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  } catch {
    return reject('DECRYPT_FAILED');
  }
  const transaction = parse(plaintext, 'TRANSACTION_INVALID'),
    amount = record(transaction.amount, 'TRANSACTION_INVALID');
  const outTradeNo = text(transaction.out_trade_no, 32, 'TRANSACTION_INVALID'),
    transactionId = text(transaction.transaction_id, 64, 'TRANSACTION_INVALID'),
    successTime = text(transaction.success_time, 40, 'TRANSACTION_INVALID');
  if (
    transaction.trade_state !== 'SUCCESS' ||
    transaction.trade_type !== 'JSAPI' ||
    amount.currency !== 'CNY' ||
    !Number.isSafeInteger(amount.total) ||
    Number(amount.total) < 0 ||
    !Number.isFinite(Date.parse(successTime))
  )
    return reject('TRANSACTION_INVALID');
  if (
    transaction.appid !== input.expected.appid ||
    transaction.mchid !== input.expected.mchid ||
    outTradeNo !== input.expected.outTradeNo ||
    amount.total !== input.expected.total
  )
    return reject('BINDING_MISMATCH');
  return {
    notificationId,
    outTradeNo,
    transactionId,
    total: Number(amount.total),
    currency: 'CNY',
    successTime,
  };
}
