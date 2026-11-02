import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectLocalConfiguration,
  rehearseMigrations,
} from '../scripts/check-fulfillment-local.mjs';
const env = {
  DATABASE_URL: 'postgresql://local:SYNTHETIC_SECRET@127.0.0.1:55439/yumi_dev',
  TEST_DATABASE_URL: 'postgresql://local:SYNTHETIC_SECRET@127.0.0.1:55439/yumi_test',
};
test('isolated config passes only exact runtime and safe defaults; never returns URL or secrets', () => {
  const checks = inspectLocalConfiguration(env, '24.22.1');
  assert.ok(checks.every((c) => c.ok));
  assert.equal(JSON.stringify(checks).includes('SYNTHETIC_SECRET'), false);
  assert.equal(inspectLocalConfiguration(env, '26.13.0').find((c) => c.code === 'NODE').ok, false);
  assert.equal(inspectLocalConfiguration({}).filter((c) => !c.ok).length, 2);
});
test('production, public binding, real payment and every nonzero or malformed toggle fail', () => {
  for (const [key, value] of [
    ['NODE_ENV', 'production'],
    ['API_HOST', '0.0.0.0'],
    ['PAYMENT_MODE', 'wechat'],
    ...[
      'CONSUMER_DEV_LOGIN_ENABLED',
      'ORDER_DEV_SUBMIT_ENABLED',
      'REDEMPTION_DEV_SUBMIT_ENABLED',
      'REDEMPTION_PICKING_DEV_ENABLED',
      'REDEMPTION_FULFILLMENT_WORKER_ENABLED',
      'PAYMENT_NOTIFICATION_LAB_ENABLED',
      'PAYMENT_QUERY_LAB_WORKER_ENABLED',
      'PICKING_LAB_ENABLED',
    ].flatMap((k) => [
      [k, '1'],
      [k, 'true'],
    ]),
  ])
    assert.ok(inspectLocalConfiguration({ ...env, [key]: value }).some((c) => !c.ok));
});
test('URL boundary rejects remote, wrong database and query option redirection before connecting', async () => {
  for (const url of [
    'postgresql://remote.invalid/yumi_test',
    'postgresql://127.0.0.1/production',
    'postgresql://127.0.0.1/yumi_test?host=remote.invalid',
    'postgresql://127.0.0.1/yumi_test?schema=public',
    'bad',
  ]) {
    assert.equal(
      inspectLocalConfiguration({ ...env, TEST_DATABASE_URL: url }).find(
        (c) => c.code === 'TEST_DATABASE_URL',
      ).ok,
      false,
    );
    await assert.rejects(rehearseMigrations(url), /LOCAL_TEST_DATABASE_REQUIRED/);
  }
});
import { mkdtempSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseEnv } from 'node:util';
test('setup can rebuild isolated credentials twice without overwriting and preflight output stays redacted', () => {
  mkdirSync('.local', { recursive: true });
  const dir = mkdtempSync(resolve('.local/setup-preflight-'));
  try {
    const script = resolve('scripts/setup-local.mjs');
    let p = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
    assert.equal(p.status, 0);
    const first = readFileSync(resolve(dir, '.env'), 'utf8'),
      configured = parseEnv(first);
    p = spawnSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
    assert.equal(p.status, 0);
    assert.equal(readFileSync(resolve(dir, '.env'), 'utf8'), first);
    assert.ok(inspectLocalConfiguration(configured).every((c) => c.ok));
    assert.equal(p.stdout.includes(configured.POSTGRES_PASSWORD), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
