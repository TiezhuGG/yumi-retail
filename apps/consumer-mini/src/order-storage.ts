import Taro from '@tarojs/taro';
import { parseOrderIntent } from './order-intent';
declare const API_BASE_URL: string;
export const orderIntentKey = `yumi.order-intent.v1:${API_BASE_URL}`;
export function acknowledgeOrder(userId: string, orderId: string) {
  const value = parseOrderIntent(Taro.getStorageSync(orderIntentKey));
  if (value?.userId === userId && value.orderId === orderId) Taro.removeStorageSync(orderIntentKey);
}
