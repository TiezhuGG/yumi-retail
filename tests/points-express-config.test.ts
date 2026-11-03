import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { applicationConfig } from '../apps/api/src/config.ts';
import { validatePointsExpressRuntime } from '../apps/api/src/points-express-gate.ts';
const env = {
  NODE_ENV: 'test',
  POINTS_EXPRESS_MODE: 'controlled',
  POINTS_EXPRESS_SUBMIT_ENABLED: '1',
  POINTS_EXPRESS_OPERATIONS_ENABLED: '1',
  POINTS_EXPRESS_ALLOWED_USER_IDS: randomUUID(),
  POINTS_EXPRESS_API_ORIGIN: 'https://api.synthetic.invalid',
  WECHAT_LOGIN_ENABLED: '1',
  WECHAT_APP_ID: 'wx' + '0'.repeat(16),
  WECHAT_APP_SECRET: randomBytes(16).toString('hex'),
  PUBLIC_WAREHOUSE_ID: randomUUID(),
  ADDRESS_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
};
test('formal defaults off and configuration rejects mixed development modes, missing prerequisites, wrong origins and account lists', () => {
  assert.equal(applicationConfig({}).pointsExpress!.mode, 'off');
  assert.equal(applicationConfig(env).pointsExpress!.submit, true);
  for (const change of [
    { POINTS_EXPRESS_MODE: 'bad' },
    { NODE_ENV: 'development' },
    { POINTS_EXPRESS_ALLOWED_USER_IDS: '' },
    { POINTS_EXPRESS_ALLOWED_USER_IDS: 'bad' },
    {
      POINTS_EXPRESS_ALLOWED_USER_IDS:
        env.POINTS_EXPRESS_ALLOWED_USER_IDS + ',' + env.POINTS_EXPRESS_ALLOWED_USER_IDS,
    },
    { POINTS_EXPRESS_API_ORIGIN: 'http://unsafe.local' },
    { WECHAT_LOGIN_ENABLED: '0' },
    { PUBLIC_WAREHOUSE_ID: '' },
    { ADDRESS_ENCRYPTION_KEY: '' },
    { REDEMPTION_DEV_SUBMIT_ENABLED: '1' },
    { REDEMPTION_PICKING_DEV_ENABLED: '1' },
    { CONSUMER_DEV_LOGIN_ENABLED: '1' },
    { POINTS_EXPRESS_MODE: 'off' },
    { POINTS_EXPRESS_SUBMIT_ENABLED: 'true' },
  ])
    assert.throws(() => applicationConfig({ ...env, ...change }));
});
test('formal runtime rejects test/public databases and production mismatches while allowing an isolated controlled test schema', () => {
  const c = applicationConfig(env);
  assert.doesNotThrow(() =>
    validatePointsExpressRuntime(
      'postgresql://synthetic@127.0.0.1/yumi_test?schema=controlled_' +
        randomUUID().replaceAll('-', ''),
      c,
    ),
  );
  for (const url of [
    'postgresql://synthetic@remote.invalid/live',
    'postgresql://synthetic@127.0.0.1/yumi_test',
    'postgresql://synthetic@127.0.0.1/yumi_dev?schema=controlled_' +
      randomUUID().replaceAll('-', ''),
  ])
    assert.throws(() => validatePointsExpressRuntime(url, c));
  const production = applicationConfig({
    ...env,
    NODE_ENV: 'production',
    STAFF_ALLOWED_ORIGINS: 'https://ops.synthetic.invalid',
    POINTS_EXPRESS_MODE: 'production',
    POINTS_EXPRESS_ALLOWED_USER_IDS: '',
  });
  assert.equal(production.redemptionDevSubmit, false);
  assert.equal(production.redemptionPickingDev, false);
  assert.doesNotThrow(() =>
    validatePointsExpressRuntime('postgresql://synthetic@db.internal/live', production),
  );
  for (const url of [
    'postgresql://synthetic@127.0.0.1/yumi_test',
    'postgresql://synthetic@db.internal/live?schema=public',
  ])
    assert.throws(() => validatePointsExpressRuntime(url, production));
});
