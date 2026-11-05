import Taro from '@tarojs/taro';
import { parseOrderIntent } from './order-intent';
declare const API_BASE_URL: string;
export const redemptionIntentKey = `yumi.redemption-intent.v1:${API_BASE_URL}`;
export const redemptionCancelKey = (userId: string, id: string) =>
  `yumi.redemption-cancel.v1:${API_BASE_URL}:${userId}:${id}`;
export function acknowledgeRedemption(userId: string, id: string) {
  const v = parseOrderIntent(Taro.getStorageSync(redemptionIntentKey));
  if (v?.userId === userId && v.orderId === id) Taro.removeStorageSync(redemptionIntentKey);
}

export const redemptionReceiptKey = (userId: string, id: string) =>
  `yumi.redemption-receipt.v1:${API_BASE_URL}:${userId}:${id}`;
