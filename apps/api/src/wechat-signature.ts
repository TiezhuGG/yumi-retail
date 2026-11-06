import { constants, verify } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
export type WechatSignatureFailure =
  | 'HEADER_INVALID'
  | 'TIME_WINDOW'
  | 'KEY_UNKNOWN'
  | 'SIGNATURE_INVALID'
  | 'BODY_INVALID';
export class WechatSignatureError extends Error {
  constructor(readonly code: WechatSignatureFailure) {
    super('WeChat signature rejected: ' + code);
  }
}
const reject = (code: WechatSignatureFailure): never => {
  throw new WechatSignatureError(code);
};
function base64(s: unknown, max: number, code: WechatSignatureFailure) {
  if (
    typeof s !== 'string' ||
    !s.length ||
    s.length > max ||
    s.length % 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)
  )
    return reject(code);
  const bytes = Buffer.from(s, 'base64');
  if (bytes.toString('base64') !== s) return reject(code);
  return bytes;
}
// Caller supplies pinned/trusted public keys. This never discovers or downloads keys.
export function verifyWechatSignature(input: {
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  trustedKeys: ReadonlyMap<string, KeyObject>;
  nowSeconds: number;
}): void {
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
}
