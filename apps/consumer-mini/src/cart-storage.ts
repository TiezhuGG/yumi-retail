import Taro from '@tarojs/taro';
import { createGuestCart } from './guest-cart';
declare const API_BASE_URL: string;
const key = `yumi.guest-cart.v1:${API_BASE_URL}`;
export const guestCart = createGuestCart({
  read() {
    try {
      return Taro.getStorageSync(key);
    } catch {
      throw Error('本机购物车读取失败，请重试');
    }
  },
  write(value) {
    try {
      Taro.setStorageSync(key, value);
    } catch {
      throw Error('本机保存失败，购物车未更改，请重试');
    }
  },
});
