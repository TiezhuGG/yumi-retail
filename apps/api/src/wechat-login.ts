import type { ApplicationConfig } from './config.js';
import { failure } from './http.js';
export type WechatExchange = (code: string) => Promise<{ openid: string }>;
// Fixed origin and path: credentials must never be sent to a caller-supplied endpoint.
export function wechatExchange(
  config: ApplicationConfig,
  transport: typeof fetch = fetch,
): WechatExchange {
  return async (code) => {
    const url = new URL('https://api.weixin.qq.com/sns/jscode2session');
    url.search = new URLSearchParams({
      appid: config.wechatAppId!,
      secret: config.wechatAppSecret!,
      js_code: code,
      grant_type: 'authorization_code',
    }).toString();
    let data: Record<string, unknown>;
    try {
      const response = await transport(url, {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
        headers: { Accept: 'application/json' },
      });
      if (!response.ok || !response.body) throw Error('UPSTREAM');
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let size = 0,
        text = '';
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 16384) throw Error('SIZE');
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        await reader.cancel().catch(() => {});
      }
      const value: unknown = JSON.parse(text);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('FORMAT');
      data = value as Record<string, unknown>;
    } catch {
      throw failure(503, 'WECHAT_UNAVAILABLE', '微信身份服务暂不可用，请重新获取登录凭证后重试');
    }
    if (data.errcode !== undefined && data.errcode !== 0) {
      if (data.errcode === 40029 || data.errcode === 40163)
        throw failure(401, 'WECHAT_CODE_INVALID', '微信登录凭证已失效，请重新登录');
      if (data.errcode === 45011)
        throw failure(429, 'WECHAT_RATE_LIMITED', '微信登录频繁，请稍后重试');
      throw failure(503, 'WECHAT_UNAVAILABLE', '微信身份服务暂不可用，请稍后重试');
    }
    if (
      typeof data.openid !== 'string' ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(data.openid) ||
      typeof data.session_key !== 'string' ||
      !/^[A-Za-z0-9+/]{22}==$/.test(data.session_key)
    )
      throw failure(503, 'WECHAT_RESPONSE_INVALID', '微信身份服务返回异常，请重新登录');
    // session_key and unionid are not needed for this app session and are discarded.
    return { openid: data.openid };
  };
}
