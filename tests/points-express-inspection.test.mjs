import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import {
  inspectPointsExpressConfiguration,
  main,
} from '../scripts/check-points-express-config.mjs';
test('formal config inspection never connects or releases and returns no credentials, origins or customer identifiers', () => {
  const id = randomUUID(),
    key = randomBytes(32).toString('hex'),
    secret = randomBytes(16).toString('hex');
  const env = {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://synthetic:synthetic_secret@database.private/live',
    STAFF_ALLOWED_ORIGINS: 'https://ops.synthetic.invalid',
    PUBLIC_WAREHOUSE_ID: randomUUID(),
    ADDRESS_ENCRYPTION_KEY: key,
    WECHAT_LOGIN_ENABLED: '1',
    WECHAT_APP_ID: 'wx' + '0'.repeat(16),
    WECHAT_APP_SECRET: secret,
    POINTS_EXPRESS_MODE: 'controlled',
    POINTS_EXPRESS_ALLOWED_USER_IDS: id,
    POINTS_EXPRESS_API_ORIGIN: 'https://api.synthetic.invalid',
  };
  const r = inspectPointsExpressConfiguration(env);
  assert.equal(r.configurationValid, true);
  assert.equal(r.canLaunch, false);
  assert.equal(r.networkChecked, false);
  assert.equal(r.controlledAccountCount, 1);
  for (const value of [
    id,
    key,
    secret,
    'synthetic_secret',
    'database.private',
    'api.synthetic.invalid',
  ])
    assert.equal(JSON.stringify(r).includes(value), false);
  assert.equal(
    inspectPointsExpressConfiguration({ ...env, REDEMPTION_DEV_SUBMIT_ENABLED: '1' })
      .configurationValid,
    false,
  );
  assert.equal(
    inspectPointsExpressConfiguration({
      ...env,
      DATABASE_URL: 'postgresql://synthetic:secret@localhost/yumi_dev',
    }).configurationValid,
    false,
  );
});
test('invalid configuration and publication arguments fail without echoing input', () => {
  assert.equal(inspectPointsExpressConfiguration({}).configurationValid, false);
  const r = inspectPointsExpressConfiguration({
    STAFF_ALLOWED_ORIGINS: 'synthetic_secret_not_a_url',
  });
  assert.equal(r.configurationValid, false);
  assert.equal(JSON.stringify(r).includes('synthetic_secret_not_a_url'), false);
  assert.throws(() => main(['--publish']), /UNKNOWN_ARGUMENT/);
});
