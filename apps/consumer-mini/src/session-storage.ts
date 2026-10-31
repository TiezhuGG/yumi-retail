import Taro from '@tarojs/taro';
import { createConsumerSession, SessionRequestError } from './consumer-session';
import type { SessionState } from './consumer-session';
declare const API_BASE_URL: string;
export const sessionStorageKey = `yumi.consumer-session.v1:${API_BASE_URL}`;
export function consumerSession(publish: (state: SessionState) => void) {
  return createConsumerSession(
    {
      read() {
        try {
          return Taro.getStorageSync(sessionStorageKey);
        } catch {
          throw Error('读取本机登录记录失败，请重试。');
        }
      },
      write(value) {
        try {
          Taro.setStorageSync(sessionStorageKey, value);
        } catch {
          throw Error('登录记录保存失败，请重试；购物车草稿已保留。');
        }
      },
      clear() {
        Taro.removeStorageSync(sessionStorageKey);
      },
      async request<T>(path: string, token?: string, body?: unknown) {
        let result;
        try {
          result = await Taro.request<{ data: T; error?: { message: string } }>({
            url: API_BASE_URL + path,
            method: body === undefined ? 'GET' : 'POST',
            data: body,
            header: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : { 'X-Yumi-Dev-Login': '1' }),
            },
            timeout: 10000,
          });
        } catch {
          throw Error('暂时无法连接，请检查网络后重试。');
        }
        if (result.statusCode !== 200)
          throw new SessionRequestError(
            result.statusCode,
            result.data.error?.message ?? '身份服务暂不可用，请稍后重试。',
          );
        return result.data.data;
      },
    },
    publish,
  );
}
