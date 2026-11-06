import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { failure } from './http.js';

export interface WechatPayerEncryption {
  keyId: string;
  keyHex: string;
}
export function payerEncryptionConfiguration(
  env: NodeJS.ProcessEnv,
): WechatPayerEncryption | undefined {
  const keyId = env.WECHAT_PAYER_KEY_ID,
    keyHex = env.WECHAT_PAYER_ENCRYPTION_KEY;
  if (!keyId && !keyHex) return undefined;
  if (!keyId || !/^[A-Za-z0-9_-]{1,32}$/.test(keyId) || !keyHex || !/^[a-f0-9]{64}$/i.test(keyHex))
    throw Error('Configure valid WECHAT_PAYER_KEY_ID and WECHAT_PAYER_ENCRYPTION_KEY together.');
  if (env.ADDRESS_ENCRYPTION_KEY?.toLowerCase() === keyHex.toLowerCase())
    throw Error('WeChat payer encryption requires a separate key from address storage.');
  return { keyId, keyHex };
}
export interface PayerIdentity {
  userId: string;
  appId: string;
  subject: string;
}
export class WechatPayerPrivateData {
  constructor(private readonly config?: WechatPayerEncryption) {}
  get configured() {
    return !!this.config;
  }
  private key() {
    if (
      !this.config ||
      !/^[a-f0-9]{64}$/i.test(this.config.keyHex) ||
      !/^[A-Za-z0-9_-]{1,32}$/.test(this.config.keyId)
    )
      throw failure(503, 'PAYER_STORAGE_UNAVAILABLE', '支付身份加密尚未配置');
    return Buffer.from(this.config.keyHex, 'hex');
  }
  private aad(i: PayerIdentity, keyId: string) {
    if (
      !/^[a-f0-9-]{36}$/.test(i.userId) ||
      !/^wx[a-f0-9]{16}$/.test(i.appId) ||
      !/^[a-f0-9]{64}$/.test(i.subject)
    )
      throw failure(503, 'PAYER_IDENTITY_INVALID', '支付身份暂时无法核验');
    return Buffer.from(`wechat-payment-payer:v1:${i.userId}:${i.appId}:${i.subject}:${keyId}`);
  }
  private validate(i: PayerIdentity, openId: string) {
    if (
      typeof openId !== 'string' ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(openId) ||
      createHash('sha256')
        .update(i.appId + ':' + openId)
        .digest('hex') !== i.subject
    )
      throw failure(503, 'PAYER_IDENTITY_INVALID', '支付身份暂时无法核验');
  }
  encrypt(i: PayerIdentity, openId: string) {
    const key = this.key(),
      keyId = this.config!.keyId;
    this.validate(i, openId);
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(this.aad(i, keyId));
    const data = Buffer.concat([cipher.update(openId, 'utf8'), cipher.final()]);
    return {
      keyId,
      payload: [
        'v1',
        iv.toString('base64'),
        cipher.getAuthTag().toString('base64'),
        data.toString('base64'),
      ].join('.'),
    };
  }
  decrypt(i: PayerIdentity, value: { keyId: string; payload: string }) {
    const key = this.key();
    if (value.keyId !== this.config!.keyId)
      throw failure(409, 'PAYER_REFRESH_REQUIRED', '支付身份需重新微信登录后核验');
    try {
      if (typeof value.payload !== 'string' || value.payload.length > 512) throw Error('FORMAT');
      const parts = value.payload.split('.');
      if (parts.length !== 4 || parts[0] !== 'v1') throw Error('FORMAT');
      const bytes = parts.slice(1).map((s) => {
        const b = Buffer.from(s, 'base64');
        if (b.toString('base64') !== s) throw Error('FORMAT');
        return b;
      });
      if (
        bytes[0]!.length !== 12 ||
        bytes[1]!.length !== 16 ||
        bytes[2]!.length < 16 ||
        bytes[2]!.length > 128
      )
        throw Error('FORMAT');
      const cipher = createDecipheriv('aes-256-gcm', key, bytes[0]!);
      cipher.setAAD(this.aad(i, value.keyId));
      cipher.setAuthTag(bytes[1]!);
      const openId = Buffer.concat([cipher.update(bytes[2]!), cipher.final()]).toString('utf8');
      this.validate(i, openId);
      return openId;
    } catch {
      throw failure(503, 'PAYER_IDENTITY_UNREADABLE', '支付身份暂不可读取，请重新微信登录后重试');
    }
  }
}
