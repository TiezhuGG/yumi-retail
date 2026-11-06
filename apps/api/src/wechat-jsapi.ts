import { constants, randomBytes, sign, type KeyObject } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { notificationUrl } from './payment-config.js';
import {
  verifyWechatSignature,
  WechatSignatureError,
  type WechatSignatureFailure,
} from './wechat-signature.js';

type JsapiFailure =
  | WechatSignatureFailure
  | 'CONFIG_INVALID'
  | 'KEY_INVALID'
  | 'ORDER_INVALID'
  | 'PAYER_INVALID'
  | 'REQUEST_UNKNOWN'
  | 'REQUEST_EXPIRED'
  | 'STATUS_UNEXPECTED'
  | 'RESPONSE_INVALID';
export class JsapiProtocolError extends Error {
  constructor(readonly code: JsapiFailure) {
    super('WeChat JSAPI protocol rejected: ' + code);
  }
}
const reject = (code: JsapiFailure): never => {
  throw new JsapiProtocolError(code);
};
const path = '/v3/pay/transactions/jsapi';
const endpoint = 'https://api.mch.weixin.qq.com' + path;
export interface JsapiMerchant {
  appId: string;
  merchantId: string;
  certificateSerial: string;
  privateKey: KeyObject;
  notifyUrl: string;
}
export interface JsapiOrder {
  outTradeNo: string;
  totalCents: number;
  description: string;
  paymentDeadline: Date;
  // Future caller must obtain the original OpenID from a trusted server binding.
  // Neither a frontend supplied identity nor consumer_users.subject is that binding.
  payer: { provider: 'WECHAT'; appId: string; openId: string };
}
export interface SignedJsapiRequest {
  readonly method: 'POST';
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}
export interface MiniPaymentParameters {
  readonly timeStamp: string;
  readonly nonceStr: string;
  readonly package: string;
  readonly signType: 'RSA';
  readonly paySign: string;
}
function validTime(n: number) {
  return Number.isSafeInteger(n) && /^\d{10}$/.test(String(n));
}
// Offline protocol only: no environment/file loading, HTTP calls, persistence,
// payment activation, order transition or client-side requestPayment invocation.
export function createJsapiProtocol(
  merchant: JsapiMerchant,
  trustedKeys: ReadonlyMap<string, KeyObject>,
) {
  if (!merchant || typeof merchant !== 'object') return reject('CONFIG_INVALID');
  const { appId, merchantId, certificateSerial, privateKey, notifyUrl } = merchant;
  if (
    [appId, merchantId, certificateSerial, notifyUrl].some((value) => typeof value !== 'string') ||
    !/^wx[a-z0-9]{16}$/.test(appId) ||
    !/^\d{8,32}$/.test(merchantId) ||
    !/^[A-Fa-f0-9]{1,128}$/.test(certificateSerial) ||
    !notificationUrl(notifyUrl) ||
    notifyUrl.length > 255
  )
    return reject('CONFIG_INVALID');
  if (
    !privateKey ||
    privateKey.type !== 'private' ||
    privateKey.asymmetricKeyType !== 'rsa' ||
    privateKey.asymmetricKeyDetails?.modulusLength !== 2048
  )
    return reject('KEY_INVALID');
  const keys = new Map(trustedKeys);
  const issued = new WeakMap<SignedJsapiRequest, { expiresAt: number; createdAt: number }>();
  const signature = (message: string) => {
    try {
      return sign('RSA-SHA256', Buffer.from(message), {
        key: privateKey,
        padding: constants.RSA_PKCS1_PADDING,
      }).toString('base64');
    } catch {
      return reject('KEY_INVALID');
    }
  };
  return Object.freeze({
    prepay(order: JsapiOrder, nowSeconds: number): SignedJsapiRequest {
      if (!order || typeof order !== 'object') return reject('ORDER_INVALID');
      const deadline =
        order.paymentDeadline instanceof Date
          ? Math.floor(order.paymentDeadline.getTime() / 1000)
          : NaN;
      if (
        !validTime(nowSeconds) ||
        typeof order.outTradeNo !== 'string' ||
        !/^[A-Za-z0-9_\-|*]{6,32}$/.test(order.outTradeNo) ||
        !Number.isSafeInteger(order.totalCents) ||
        order.totalCents < 1 ||
        order.totalCents > 2147483647 ||
        typeof order.description !== 'string' ||
        !order.description.trim() ||
        Array.from(order.description).length > 127 ||
        /[\p{Cc}\p{Cf}]/u.test(order.description) ||
        !Number.isSafeInteger(deadline) ||
        deadline < nowSeconds + 60 ||
        deadline > nowSeconds + 15 * 86400
      )
        return reject('ORDER_INVALID');
      if (
        order.payer?.provider !== 'WECHAT' ||
        order.payer.appId !== appId ||
        typeof order.payer.openId !== 'string' ||
        !/^[A-Za-z0-9_-]{16,128}$/.test(order.payer.openId)
      )
        return reject('PAYER_INVALID');
      const body = JSON.stringify({
        appid: appId,
        mchid: merchantId,
        description: order.description,
        out_trade_no: order.outTradeNo,
        time_expire: new Date(deadline * 1000).toISOString().replace('.000Z', 'Z'),
        notify_url: notifyUrl,
        amount: { total: order.totalCents, currency: 'CNY' },
        payer: { openid: order.payer.openId },
      });
      const nonce = randomBytes(16).toString('hex'),
        timestamp = String(nowSeconds);
      const authorization = `WECHATPAY2-SHA256-RSA2048 mchid="${merchantId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${certificateSerial}",signature="${signature('POST\n' + path + '\n' + timestamp + '\n' + nonce + '\n' + body + '\n')}"`;
      const request: SignedJsapiRequest = Object.freeze({
        method: 'POST',
        url: endpoint,
        body,
        headers: Object.freeze({
          Authorization: authorization,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        }),
      });
      issued.set(request, {
        expiresAt: Math.min(deadline, nowSeconds + 7200),
        createdAt: nowSeconds,
      });
      return request;
    },
    invocation(
      request: SignedJsapiRequest,
      response: {
        status: number;
        rawBody: Buffer;
        headers: Record<string, string | string[] | undefined>;
      },
      nowSeconds: number,
    ): MiniPaymentParameters {
      const context = issued.get(request);
      if (!context) return reject('REQUEST_UNKNOWN');
      if (
        !validTime(nowSeconds) ||
        nowSeconds < context.createdAt ||
        nowSeconds >= context.expiresAt
      )
        return reject('REQUEST_EXPIRED');
      try {
        verifyWechatSignature({ ...response, trustedKeys: keys, nowSeconds });
      } catch (e) {
        if (e instanceof WechatSignatureError) return reject(e.code);
        throw e;
      }
      if (response.status !== 200) return reject('STATUS_UNEXPECTED');
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(response.rawBody));
      } catch {
        return reject('RESPONSE_INVALID');
      }
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        !('prepay_id' in body) ||
        typeof body.prepay_id !== 'string' ||
        !/^[A-Za-z0-9_-]{1,64}$/.test(body.prepay_id)
      )
        return reject('RESPONSE_INVALID');
      const timeStamp = String(nowSeconds),
        nonceStr = randomBytes(16).toString('hex'),
        packageValue = 'prepay_id=' + body.prepay_id;
      return Object.freeze({
        timeStamp,
        nonceStr,
        package: packageValue,
        signType: 'RSA',
        paySign: signature(appId + '\n' + timeStamp + '\n' + nonceStr + '\n' + packageValue + '\n'),
      });
    },
  });
}
