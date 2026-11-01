import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applicationConfig } from '../apps/api/src/config.ts';
test('picking lab defaults off and rejects production, exposed binding and malformed toggles', () => {
  assert.equal(applicationConfig({ NODE_ENV: 'test' }).pickingLabEnabled, false);
  assert.equal(
    applicationConfig({ NODE_ENV: 'test', PICKING_LAB_ENABLED: '1', API_HOST: '127.0.0.1' })
      .pickingLabEnabled,
    true,
  );
  for (const env of [
    {
      NODE_ENV: 'production',
      STAFF_ALLOWED_ORIGINS: 'https://example.invalid',
      PICKING_LAB_ENABLED: '1',
    },
    { NODE_ENV: 'test', PICKING_LAB_ENABLED: '1', API_HOST: '0.0.0.0' },
    { NODE_ENV: 'test', PICKING_LAB_ENABLED: 'true' },
  ])
    assert.throws(() => applicationConfig(env));
});
