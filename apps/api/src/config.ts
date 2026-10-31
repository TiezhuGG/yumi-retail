export interface ApplicationConfig {
  environment: 'development' | 'test' | 'production';
  staffOrigins: string[];
  staffSessionSeconds: number;
  docsEnabled: boolean;
  publicWarehouseId?: string;
  productImageRoot?: string;
  consumerDevLogin?: boolean;
  consumerSessionSeconds?: number;
}

export function applicationConfig(env: NodeJS.ProcessEnv = process.env): ApplicationConfig {
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
  return {
    environment: environment as ApplicationConfig['environment'],
    staffOrigins: origins,
    staffSessionSeconds: seconds,
    docsEnabled: environment !== 'production',
    consumerDevLogin,
    consumerSessionSeconds,
    publicWarehouseId: env.PUBLIC_WAREHOUSE_ID || undefined,
    productImageRoot:
      environment === 'production'
        ? undefined
        : env.PRODUCT_IMAGE_LOCAL_DIR || '.local/product-images',
  };
}
