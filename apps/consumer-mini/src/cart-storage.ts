import Taro from '@tarojs/taro';
import { createGuestCart } from './guest-cart';
import { assertGuestWritable } from './cart-merge';
declare const API_BASE_URL: string;
export const guestCartKey = `yumi.guest-cart.v1:${API_BASE_URL}`;
export const guestCart = createGuestCart({
  read() {
    try {
      return Taro.getStorageSync(guestCartKey);
    } catch {
      throw Error('本机购物车读取失败，请重试');
    }
  },
  write(value) {
    assertGuestWritable(Taro.getStorageSync(guestCartKey));
    try {
      Taro.setStorageSync(guestCartKey, value);
    } catch {
      throw Error('本机保存失败，购物车未更改，请重试');
    }
  },
});
