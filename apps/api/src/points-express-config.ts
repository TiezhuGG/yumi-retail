import type { ApplicationConfig } from './config.js';
export function pointsExpressConfiguration(env: NodeJS.ProcessEnv) {
  const mode = env.POINTS_EXPRESS_MODE ?? 'off';
  if (!['off', 'controlled', 'production'].includes(mode))
    throw Error('Invalid POINTS_EXPRESS_MODE.');
  for (const k of ['POINTS_EXPRESS_SUBMIT_ENABLED', 'POINTS_EXPRESS_OPERATIONS_ENABLED'])
    if (env[k] && !['0', '1'].includes(env[k]!)) throw Error('Invalid points express switch.');
  const submit = env.POINTS_EXPRESS_SUBMIT_ENABLED === '1',
    operations = env.POINTS_EXPRESS_OPERATIONS_ENABLED === '1';
  const users = (env.POINTS_EXPRESS_ALLOWED_USER_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (
    users.length > 50 ||
    new Set(users.map((s) => s.toLowerCase())).size !== users.length ||
    users.some((s) => !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s))
  )
    throw Error('Invalid controlled points account list.');
  if (mode === 'off' && (submit || operations || users.length))
    throw Error('Points express mode is off.');
  if (mode !== 'off') {
    if (!['test', 'production'].includes(env.NODE_ENV ?? 'development'))
      throw Error('Formal points mode requires a test or production environment.');
    if (
      [
        'CONSUMER_DEV_LOGIN_ENABLED',
        'ORDER_DEV_SUBMIT_ENABLED',
        'REDEMPTION_DEV_SUBMIT_ENABLED',
        'REDEMPTION_PICKING_DEV_ENABLED',
        'PICKING_LAB_ENABLED',
        'PAYMENT_NOTIFICATION_LAB_ENABLED',
        'REDEMPTION_FULFILLMENT_WORKER_ENABLED',
        'PAYMENT_QUERY_LAB_WORKER_ENABLED',
      ].some((k) => env[k] === '1')
    )
      throw Error('Formal points mode cannot mix development adapters or workers.');
    if (env.WECHAT_LOGIN_ENABLED !== '1' || !env.PUBLIC_WAREHOUSE_ID || !env.ADDRESS_ENCRYPTION_KEY)
      throw Error('Formal points mode requires WeChat identity, warehouse and encryption.');
    if (mode === 'controlled' && !users.length)
      throw Error('Controlled points mode requires explicit accounts.');
    if (mode === 'production' && ((env.NODE_ENV ?? 'development') !== 'production' || users.length))
      throw Error(
        'Production points mode requires production environment and no controlled account list.',
      );
    try {
      const u = new URL(env.POINTS_EXPRESS_API_ORIGIN ?? '');
      if (
        u.protocol !== 'https:' ||
        u.origin !== env.POINTS_EXPRESS_API_ORIGIN ||
        u.username ||
        u.password ||
        !u.hostname.includes('.') ||
        /^\[|^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) ||
        ['localhost'].includes(u.hostname)
      )
        throw Error('ORIGIN');
    } catch {
      throw Error('Formal points mode requires an HTTPS API origin.');
    }
  }
  return {
    mode: mode as 'off' | 'controlled' | 'production',
    submit,
    operations,
    allowedUsers: users.map((s) => s.toLowerCase()),
    apiOrigin: mode === 'off' ? undefined : env.POINTS_EXPRESS_API_ORIGIN,
  };
}
export function validatePointsExpressRuntime(url: string, config: ApplicationConfig) {
  const p = config.pointsExpress;
  if (!p || p.mode === 'off') return;
  if (
    !['controlled', 'production'].includes(p.mode) ||
    !['test', 'production'].includes(config.environment) ||
    config.consumerDevLogin ||
    config.redemptionDevSubmit ||
    config.redemptionPickingDev ||
    config.orderDevSubmit ||
    config.pickingLabEnabled ||
    config.notificationLabEnabled ||
    !config.wechatLogin ||
    !config.wechatAppId ||
    !config.wechatAppSecret ||
    !config.publicWarehouseId ||
    !config.addressEncryptionKey
  )
    throw Error('Invalid isolated formal points configuration.');
  if (p.mode === 'production' && (config.environment !== 'production' || p.allowedUsers.length))
    throw Error('Invalid production points configuration.');
  if (p.mode === 'controlled' && !p.allowedUsers.length)
    throw Error('Controlled points accounts required.');
  if (
    !/^wx[a-f0-9]{16}$/.test(config.wechatAppId!) ||
    !/^[A-Za-z0-9]{32}$/.test(config.wechatAppSecret!) ||
    !/^[a-f0-9]{64}$/i.test(config.addressEncryptionKey!) ||
    p.allowedUsers.length > 50 ||
    new Set(p.allowedUsers).size !== p.allowedUsers.length ||
    p.allowedUsers.some((v) => !/^[a-f0-9-]{36}$/i.test(v))
  )
    throw Error('Invalid formal points prerequisites.');
  try {
    const origin = new URL(p.apiOrigin ?? '');
    if (
      origin.protocol !== 'https:' ||
      origin.origin !== p.apiOrigin ||
      origin.username ||
      origin.password ||
      !origin.hostname.includes('.') ||
      /^\[|^\d+\.\d+\.\d+\.\d+$/.test(origin.hostname)
    )
      throw Error('ORIGIN');
  } catch {
    throw Error('Formal HTTPS API origin required.');
  }
  const u = new URL(url);
  if (
    config.environment === 'test' &&
    (!['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) ||
      u.pathname !== '/yumi_test' ||
      !/^([a-z_]+)_[a-f0-9]{32}$/.test(u.searchParams.get('schema') ?? ''))
  )
    throw Error('Formal test mode requires a disposable local test schema.');
  if (!['postgres:', 'postgresql:'].includes(u.protocol))
    throw Error('Formal points mode requires PostgreSQL.');
  if (
    config.environment !== 'test' &&
    (['/yumi_dev', '/yumi_test'].includes(u.pathname) || u.searchParams.has('schema'))
  )
    throw Error(
      'Formal points environment cannot use development/test databases or custom schemas.',
    );
}
