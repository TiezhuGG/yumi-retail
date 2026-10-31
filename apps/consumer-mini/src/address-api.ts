import Taro from '@tarojs/taro';
import type { CartIdentity } from './account-cart';
import { parseSession } from './consumer-session';
import { sessionStorageKey } from './session-storage';
declare const API_BASE_URL: string;
export class AddressRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function addressRequest<T>(
  identity: CartIdentity,
  path: string,
  body?: unknown,
  key?: string,
): Promise<T> {
  if (parseSession(Taro.getStorageSync(sessionStorageKey))?.token !== identity.token)
    throw Error('登录记录已变化，请重新进入地址页面');
  const r = await Taro.request<{ data: T; error?: { code: string; message: string } }>({
    url: API_BASE_URL + path,
    method: body === undefined ? 'GET' : 'POST',
    data: body,
    header: {
      Authorization: `Bearer ${identity.token}`,
      'Content-Type': 'application/json',
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    timeout: 10000,
  });
  if (parseSession(Taro.getStorageSync(sessionStorageKey))?.token !== identity.token)
    throw Error('登录记录已变化，请重新进入地址页面');
  if (r.statusCode !== 200)
    throw new AddressRequestError(
      r.statusCode,
      r.data?.error?.code ?? 'UNKNOWN',
      r.data?.error?.message ?? '地址服务暂不可用',
    );
  return r.data.data;
}
export function addressOperationKey() {
  const bytes = Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const h = bytes.map((n) => n.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
