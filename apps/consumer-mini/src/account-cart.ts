import Taro from '@tarojs/taro';
import type { ConsumerCart, CartMergeResult } from '../../../packages/contracts/src/index';
import type { ConsumerProfile } from './consumer-session';
import { parseSession } from './consumer-session';
import { sessionStorageKey } from './session-storage';
import { guestCartKey, guestCart } from './cart-storage';
import { CartRequestError, createCartMerge, readMergeIntent } from './cart-merge';
import type { SaleSku } from './api';
declare const API_BASE_URL: string;
export class CartSaveUnknownError extends Error {}
export type CartIdentity = { token: string; profile: ConsumerProfile };
export async function cartRequest<T>(
  identity: CartIdentity,
  path: string,
  body?: unknown,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' = 'GET',
  key?: string,
): Promise<T> {
  if (parseSession(Taro.getStorageSync(sessionStorageKey))?.token !== identity.token)
    throw Error('登录记录已变化，请重新读取购物车');
  const result = await Taro.request<{ data: T; error?: { code: string; message: string } }>({
    url: API_BASE_URL + path,
    method,
    data: body,
    header: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${identity.token}`,
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    timeout: 10000,
  });
  if (result.statusCode !== 200)
    throw new CartRequestError(
      result.statusCode,
      result.data?.error?.code ?? 'UNKNOWN',
      result.data?.error?.message ?? '暂未确认保存结果，请重新读取购物车',
    );
  return result.data.data;
}
export async function cartIdentity(): Promise<CartIdentity | null> {
  const saved = parseSession(Taro.getStorageSync(sessionStorageKey));
  if (!saved) return null;
  const temporary = { token: saved.token, profile: null as unknown as ConsumerProfile };
  const profile = await cartRequest<ConsumerProfile>(temporary, '/consumer/me');
  return { token: saved.token, profile };
}
export const readAccountCart = (identity: CartIdentity) =>
  cartRequest<ConsumerCart>(identity, '/consumer/cart');
export function pendingMerge() {
  return readMergeIntent(Taro.getStorageSync(guestCartKey));
}
export async function mergeGuest(identity: CartIdentity) {
  const merger = createCartMerge({
    read: () => Taro.getStorageSync(guestCartKey),
    write: (v) => Taro.setStorageSync(guestCartKey, v),
    newKey: () => {
      const data = new Uint8Array(16);
      /* Only a retry identifier, never a credential. */ for (let i = 0; i < data.length; i++)
        data[i] = Math.floor(Math.random() * 256);
      data[6] = (data[6]! & 15) | 64;
      data[8] = (data[8]! & 63) | 128;
      const h = Array.from(data, (v) => v.toString(16).padStart(2, '0')).join('');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    },
    send: (intent) =>
      cartRequest<CartMergeResult>(
        identity,
        '/consumer/cart/merge',
        { items: intent.items },
        'POST',
        intent.key,
      ),
  });
  await merger.merge(identity.profile.user.id);
}
export async function addCartItem(sku: SaleSku) {
  const identity = await cartIdentity();
  if (!identity) {
    guestCart.add(sku);
    return '已加入本机草稿';
  }
  if (pendingMerge()) throw Error('请先在购物车确认待处理的草稿合并');
  const cart = await readAccountCart(identity);
  try {
    await cartRequest<ConsumerCart>(
      identity,
      '/consumer/cart/items',
      { version: cart.version, skuId: sku.id },
      'POST',
    );
  } catch (error) {
    if (error instanceof CartRequestError && error.status < 500) throw error;
    throw new CartSaveUnknownError(
      '尚未确认是否加购成功，请先到购物车核对最新数量；本页暂停重复加购。',
    );
  }
  return '已加入账号购物车';
}
