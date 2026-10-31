import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { failure } from './http.js';
export class OrderPrivateData {
  constructor(private readonly hex?: string) {}
  key() {
    if (!this.hex) throw failure(503, 'ADDRESS_STORAGE_UNAVAILABLE', '订单地址加密尚未配置');
    return Buffer.from(this.hex, 'hex');
  }
  encrypt(userId: string, orderId: string, value: unknown) {
    const iv = randomBytes(12),
      cipher = createCipheriv('aes-256-gcm', this.key(), iv);
    cipher.setAAD(Buffer.from(`order:${userId}:${orderId}`));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return [
      'v1',
      iv.toString('base64'),
      cipher.getAuthTag().toString('base64'),
      data.toString('base64'),
    ].join('.');
  }
  decrypt<T>(userId: string, orderId: string, payload: string): T {
    const [v, iv, tag, data] = payload.split('.');
    if (v !== 'v1' || !iv || !tag || !data) throw Error('Invalid order snapshot');
    const cipher = createDecipheriv('aes-256-gcm', this.key(), Buffer.from(iv, 'base64'));
    cipher.setAAD(Buffer.from(`order:${userId}:${orderId}`));
    cipher.setAuthTag(Buffer.from(tag, 'base64'));
    return JSON.parse(
      Buffer.concat([cipher.update(Buffer.from(data, 'base64')), cipher.final()]).toString('utf8'),
    ) as T;
  }
}
