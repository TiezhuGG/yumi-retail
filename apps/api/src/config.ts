import { pointsExpressConfiguration } from './points-express-config.js';
import { assertDisabledPaymentMode, paymentConfiguration } from './payment-config.js';
import type { PaymentReadinessCheck } from '@yumi/contracts';
export interface ApplicationConfig {
  pointsExpress?: {
    mode: 'off' | 'controlled' | 'production';
    submit: boolean;
    operations: boolean;
    allowedUsers: string[];
    apiOrigin?: string;
  };
  notificationLabEnabled?: boolean;
  pickingLabEnabled?: boolean;
  paymentConfiguration?: PaymentReadinessCheck[];
  environment: 'development' | 'test' | 'production';
  staffOrigins: string[];
  staffSessionSeconds: number;
  docsEnabled: boolean;
  publicWarehouseId?: string;
  productImageRoot?: string;
  addressEncryptionKey?: string;
  orderDevSubmit?: boolean;
  redemptionDevSubmit?: boolean;
  redemptionPickingDev?: boolean;
  orderDevHoldSeconds?: number;
  consumerDevLogin?: boolean;
  wechatLogin?: boolean;
  wechatAppId?: string;
  wechatAppSecret?: string;
  consumerSessionSeconds?: number;
}

export function applicationConfig(env: NodeJS.ProcessEnv = process.env): ApplicationConfig {
  assertDisabledPaymentMode(env);
  const environment = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(environment))
    throw new Error('Invalid NODE_ENV.');
  const origins = (
    env.STAFF_ALLOWED_ORIGINS ??
    (environment === 'production'
      ? ''
      : 'http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:5174,http://localhost:5174,http://127.0.0.1:3000,http://localhost:3000')
  )
    .split(',')
    .filter(Boolean);
  if (!origins.length) throw new Error('STAFF_ALLOWED_ORIGINS is required.');
  for (const origin of origins) {
    const parsed = new URL(origin);
    if (
      parsed.origin !== origin ||
      parsed.username ||
      parsed.password ||
      (environment === 'production' && parsed.protocol !== 'https:') ||
      !['http:', 'https:'].includes(parsed.protocol)
    )
      throw new Error('Invalid staff origin configuration.');
  }
  if (environment === 'production' && env.PRODUCT_IMAGE_LOCAL_DIR)
    throw new Error('Local product image storage is development-only.');
  if (env.CONSUMER_DEV_LOGIN_ENABLED && !['0', '1'].includes(env.CONSUMER_DEV_LOGIN_ENABLED))
    throw new Error('Invalid CONSUMER_DEV_LOGIN_ENABLED.');
  const consumerDevLogin = env.CONSUMER_DEV_LOGIN_ENABLED === '1';
  if (
    consumerDevLogin &&
    (environment === 'production' ||
      (env.API_HOST && !['127.0.0.1', '::1', 'localhost'].includes(env.API_HOST)))
  )
    throw new Error('Consumer development login requires non-production loopback binding.');
  if (env.WECHAT_LOGIN_ENABLED && !['0', '1'].includes(env.WECHAT_LOGIN_ENABLED))
    throw Error('Invalid WECHAT_LOGIN_ENABLED.');
  const wechatLogin = env.WECHAT_LOGIN_ENABLED === '1';
  if (
    wechatLogin &&
    (!/^wx[a-f0-9]{16}$/.test(env.WECHAT_APP_ID ?? '') ||
      !/^[A-Za-z0-9]{32}$/.test(env.WECHAT_APP_SECRET ?? ''))
  )
    throw Error('WeChat login requires valid server credentials.');
  const consumerSessionSeconds = Number(env.CONSUMER_SESSION_SECONDS ?? 28800);
  if (
    !Number.isInteger(consumerSessionSeconds) ||
    consumerSessionSeconds < 60 ||
    consumerSessionSeconds > 86400
  )
    throw new Error('Invalid CONSUMER_SESSION_SECONDS.');
  const seconds = Number(env.STAFF_SESSION_SECONDS ?? 28800);
  if (
    env.PUBLIC_WAREHOUSE_ID &&
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(env.PUBLIC_WAREHOUSE_ID)
  )
    throw new Error('Invalid PUBLIC_WAREHOUSE_ID.');
  if (!Number.isInteger(seconds) || seconds < 60 || seconds > 86400)
    throw new Error('Invalid STAFF_SESSION_SECONDS.');
  if (env.ORDER_DEV_SUBMIT_ENABLED && !['0', '1'].includes(env.ORDER_DEV_SUBMIT_ENABLED))
    throw new Error('Invalid ORDER_DEV_SUBMIT_ENABLED.');
  if (
    env.PAYMENT_NOTIFICATION_LAB_ENABLED &&
    !['0', '1'].includes(env.PAYMENT_NOTIFICATION_LAB_ENABLED)
  )
    throw new Error('Invalid PAYMENT_NOTIFICATION_LAB_ENABLED.');
  if (env.PICKING_LAB_ENABLED && !['0', '1'].includes(env.PICKING_LAB_ENABLED))
    throw new Error('Invalid PICKING_LAB_ENABLED.');
  const pickingLabEnabled = env.PICKING_LAB_ENABLED === '1';
  if (
    pickingLabEnabled &&
    (environment === 'production' ||
      (env.API_HOST && !['127.0.0.1', '::1', 'localhost'].includes(env.API_HOST)))
  )
    throw new Error('Picking lab requires non-production loopback binding.');
  const notificationLabEnabled = env.PAYMENT_NOTIFICATION_LAB_ENABLED === '1';
  if (
    notificationLabEnabled &&
    (environment === 'production' ||
      (env.API_HOST && !['127.0.0.1', '::1', 'localhost'].includes(env.API_HOST)))
  )
    throw new Error('Notification lab requires non-production loopback binding.');
  if (
    env.REDEMPTION_PICKING_DEV_ENABLED &&
    !['0', '1'].includes(env.REDEMPTION_PICKING_DEV_ENABLED)
  )
    throw Error('Invalid REDEMPTION_PICKING_DEV_ENABLED.');
  const redemptionPickingDev = env.REDEMPTION_PICKING_DEV_ENABLED === '1';
  if (
    redemptionPickingDev &&
    (environment === 'production' ||
      (env.API_HOST && !['localhost', '127.0.0.1', '::1'].includes(env.API_HOST)))
  )
    throw Error('Redemption picking requires local development isolation.');
  if (env.REDEMPTION_DEV_SUBMIT_ENABLED && !['0', '1'].includes(env.REDEMPTION_DEV_SUBMIT_ENABLED))
    throw new Error('Invalid REDEMPTION_DEV_SUBMIT_ENABLED.');
  const redemptionDevSubmit = env.REDEMPTION_DEV_SUBMIT_ENABLED === '1';
  if (
    redemptionDevSubmit &&
    (environment === 'production' ||
      (env.API_HOST && !['127.0.0.1', '::1', 'localhost'].includes(env.API_HOST)))
  )
    throw new Error('Redemption submission is local development only.');
  const orderDevSubmit = env.ORDER_DEV_SUBMIT_ENABLED === '1';
  if (
    orderDevSubmit &&
    (environment === 'production' ||
      (env.API_HOST && !['127.0.0.1', '::1', 'localhost'].includes(env.API_HOST)))
  )
    throw new Error('Order submission foundation is local development only.');
  if (env.ADDRESS_ENCRYPTION_KEY && !/^[a-f0-9]{64}$/i.test(env.ADDRESS_ENCRYPTION_KEY))
    throw new Error('Invalid ADDRESS_ENCRYPTION_KEY.');
  if (
    !Number.isInteger(Number(env.ORDER_DEV_HOLD_SECONDS ?? 900)) ||
    Number(env.ORDER_DEV_HOLD_SECONDS ?? 900) < 1 ||
    Number(env.ORDER_DEV_HOLD_SECONDS ?? 900) > 900
  )
    throw new Error('Invalid ORDER_DEV_HOLD_SECONDS.');
  return {
    pointsExpress: pointsExpressConfiguration(env),
    notificationLabEnabled,
    pickingLabEnabled,
    paymentConfiguration: paymentConfiguration(env),
    orderDevHoldSeconds: Number(env.ORDER_DEV_HOLD_SECONDS ?? 900),
    orderDevSubmit,
    redemptionDevSubmit,
    redemptionPickingDev,
    addressEncryptionKey: env.ADDRESS_ENCRYPTION_KEY || undefined,
    environment: environment as ApplicationConfig['environment'],
    staffOrigins: origins,
    staffSessionSeconds: seconds,
    docsEnabled: environment !== 'production',
    consumerDevLogin,
    wechatLogin,
    wechatAppId: wechatLogin ? env.WECHAT_APP_ID : undefined,
    wechatAppSecret: wechatLogin ? env.WECHAT_APP_SECRET : undefined,
    consumerSessionSeconds,
    publicWarehouseId: env.PUBLIC_WAREHOUSE_ID || undefined,
    productImageRoot:
      environment === 'production'
        ? undefined
        : env.PRODUCT_IMAGE_LOCAL_DIR || '.local/product-images',
  };
}
