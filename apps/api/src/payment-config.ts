import { isIP } from 'node:net';
import type { PaymentReadinessCheck } from '@yumi/contracts';
// Offline shape checks only. Never retain/return environment values or contact a provider.
export function paymentConfiguration(env: NodeJS.ProcessEnv): PaymentReadinessCheck[] {
  const check = (
    code: string,
    title: string,
    value: string | undefined,
    valid: (s: string) => boolean,
    rule: string,
  ): PaymentReadinessCheck => ({
    code,
    title,
    group: 'CONFIGURATION',
    status: !value ? 'MISSING' : valid(value) ? 'FORMAT_OK' : 'INVALID',
    detail: !value
      ? '尚未配置；由部署环境提供非敏感字段。'
      : valid(value)
        ? '本地格式检查通过；真实性、归属和联通未验证。'
        : rule,
  });
  return [
    check(
      'APP_ID',
      '小程序 AppID',
      env.WECHAT_PAY_APP_ID,
      (s) => /^wx[a-z0-9]{16}$/.test(s),
      '本地格式要求wx开头和16位小写字母或数字，不能有空白。',
    ),
    check(
      'MCH_ID',
      '商户号',
      env.WECHAT_PAY_MCH_ID,
      (s) => /^\d{8,32}$/.test(s),
      '本地格式要求8–32位数字，不能有空白；不验证商户真实性。',
    ),
    check(
      'NOTIFY_URL',
      '支付通知地址',
      env.WECHAT_PAY_NOTIFY_URL,
      notificationUrl,
      '本地要求公网域名HTTPS完整地址，包含路径；不能带账号、查询串、片段、IP或本地域名。',
    ),
  ];
}
function notificationUrl(s: string) {
  if (
    s.length > 512 ||
    s !== s.trim() ||
    /[\s\\]/.test(s) ||
    Array.from(s).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
    s.includes('?') ||
    s.includes('#')
  )
    return false;
  try {
    const u = new URL(s),
      h = u.hostname.toLowerCase();
    return (
      u.protocol === 'https:' &&
      !u.username &&
      !u.password &&
      !u.port &&
      u.pathname !== '/' &&
      h.includes('.') &&
      !isIP(h) &&
      !h.startsWith('[') &&
      !h.endsWith('.') &&
      !/(^|\.)(localhost|local|internal|lan|home|test|invalid|example|onion)$/.test(h) &&
      /^[a-z0-9.-]+$/.test(h) &&
      h.split('.').every((p) => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(p))
    );
  } catch {
    return false;
  }
}
export function assertDisabledPaymentMode(env: NodeJS.ProcessEnv) {
  if ((env.PAYMENT_MODE ?? 'disabled') !== 'disabled')
    throw Error('Only PAYMENT_MODE=disabled is supported; payment channels are not implemented.');
}
