import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLocalRewardSeed } from '../scripts/seed-rewards-local.mjs';
const env = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://sample:sample@127.0.0.1:55432/yumi_dev',
  PUBLIC_WAREHOUSE_ID: '00000000-0000-4000-8000-000000000002',
  PAYMENT_MODE: 'disabled',
  LOCAL_ADMIN_LOGIN: 'sample',
  LOCAL_ADMIN_PASSWORD: 'sample',
};
test('local seed requires explicit apply and exact isolated local target', () => {
  assert.equal(assertLocalRewardSeed(env, ['--apply']), env.DATABASE_URL);
  assert.throws(() => assertLocalRewardSeed({ ...env, DATABASE_URL: '' }, ['--apply']));
  for (const args of [[], ['--apply', '--force'], ['--force']])
    assert.throws(() => assertLocalRewardSeed(env, args));
  for (const DATABASE_URL of [
    'postgresql://sample:sample@remote:55432/yumi_dev',
    'postgresql://sample:sample@127.0.0.1:55432/yumi_test',
    'postgresql://sample:sample@127.0.0.1:5432/yumi_dev',
    'postgresql://sample:sample@127.0.0.1:55432/yumi_dev?schema=public',
  ])
    assert.throws(() => assertLocalRewardSeed({ ...env, DATABASE_URL }, ['--apply']));
});
test('seed rejects production, other warehouse, payment and absent credentials', () => {
  for (const values of [
    { NODE_ENV: 'production' },
    { PUBLIC_WAREHOUSE_ID: 'another' },
    { PAYMENT_MODE: 'mock' },
    { LOCAL_ADMIN_PASSWORD: '' },
    { LOCAL_ADMIN_LOGIN: '' },
  ])
    assert.throws(() => assertLocalRewardSeed({ ...env, ...values }, ['--apply']));
});
