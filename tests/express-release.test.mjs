import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expressReleaseReport, main } from '../scripts/check-express-release.mjs';
const env = {
  DATABASE_URL: 'postgresql://local:synthetic_secret@127.0.0.1:55432/yumi_dev',
  TEST_DATABASE_URL: 'postgresql://local:synthetic_secret@127.0.0.1:55432/yumi_test',
  ADDRESS_ENCRYPTION_KEY: 'synthetic_key_that_must_not_be_printed',
};
test('express release report separates local checks from launch and does not disclose configuration or accept claimed external signoff', async () => {
  const report = await expressReleaseReport({
    ...env,
    DEVICE_ACCEPTED: '1',
    PRODUCTION_ACCEPTED: '1',
  });
  assert.equal(report.canLaunch, false);
  assert.equal(report.scope, 'LOCAL_PREPARATION');
  assert.ok(report.migrations.length > 40);
  assert.ok(report.artifacts.length > 0);
  assert.equal(JSON.stringify(report).includes('synthetic_secret'), false);
  assert.equal(JSON.stringify(report).includes(env.ADDRESS_ENCRYPTION_KEY), false);
  assert.ok(report.remaining.some((c) => c.code === 'WECHAT_IDENTITY' && c.status === 'BLOCKED'));
  assert.ok(report.remaining.some((c) => c.code === 'BACKUP_RESTORE' && c.status === 'UNVERIFIED'));
  assert.equal(report.migrationRehearsal, null);
  assert.equal(
    report.checks.find((c) => c.code === 'MINI_MANIFEST').ok,
    report.miniBuild !== 'UNVERIFIED',
  );
});
test('unsafe or invalid environment prevents database rehearsal; unsupported publication flags are refused', async () => {
  for (const changed of [
    { TEST_DATABASE_URL: 'postgresql://local:synthetic_secret@remote.invalid/yumi_test' },
    { NODE_ENV: 'production' },
    { REDEMPTION_DEV_SUBMIT_ENABLED: '1' },
    { REDEMPTION_PICKING_DEV_ENABLED: '1' },
    { POINTS_EXPRESS_MODE: 'controlled' },
    { POINTS_EXPRESS_OPERATIONS_ENABLED: '1' },
  ])
    await assert.rejects(
      expressReleaseReport({ ...env, ...changed }, { rehearse: true }),
      /LOCAL_CONFIGURATION_REQUIRED/,
    );
  await assert.rejects(main(['--publish']), /UNKNOWN_ARGUMENT/);
});
