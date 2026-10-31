import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apiBaseForBuild, collectBuildInfo, verifyBuildInfo } from '../scripts/mini-build-info.mjs';

test('device target rejects absent/local/insecure/placeholder addresses before building', () => {
  for (const value of [
    undefined,
    '',
    'http://api.yumi-retail.com/api/v1',
    'https://127.0.0.1/api/v1',
    'https://[::1]/api/v1',
    'https://192.168.1.10/api/v1',
    'https://localhost/api/v1',
    'https://localhost./api/v1',
    'https://api.test./api/v1',
    'https://api_bad.host/api/v1',
    'https://warehouse.local/api/v1',
    'https://api.example.com/api/v1',
    'https://api.test/api/v1',
  ])
    assert.throws(() => apiBaseForBuild(value, 'device'));
});
test('API URL is canonical and rejects credentials/query/hash/wrong paths without echoing them', () => {
  assert.equal(
    apiBaseForBuild(' https://api.yumi-retail.com/api/v1/ ', 'device'),
    'https://api.yumi-retail.com/api/v1',
  );
  assert.equal(apiBaseForBuild(undefined, 'local'), 'http://127.0.0.1:3000/api/v1');
  for (const value of [
    'https://account:synthetic-secret@api.yumi-retail.com/api/v1',
    'https://api.yumi-retail.com/api/v1?token=synthetic-secret',
    'https://api.yumi-retail.com/api/v1#synthetic-secret',
    'https://api.yumi-retail.com/',
    'not-a-url',
  ]) {
    assert.throws(
      () => apiBaseForBuild(value, 'device'),
      (e) => !e.message.includes('synthetic-secret'),
    );
  }
});
function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'yumi-mini-build-'));
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
test('local output cannot be accepted as a device build', () =>
  fixture((root) => {
    writeFileSync(join(root, 'app.js'), 'const api="http://127.0.0.1:3000/api/v1";');
    const info = collectBuildInfo(root, 'local', 'http://127.0.0.1:3000/api/v1');
    assert.throws(() => verifyBuildInfo(root, info, 'device'));
    assert.deepEqual(info.acceptance, {
      developerTool: 'not-recorded',
      realDevice: 'not-recorded',
      legalDomain: 'not-recorded',
    });
  }));
test('manifest detects stale API and changed/added/missing output', () =>
  fixture((root) => {
    // Pure synthetic text fixture, no network request to this domain.
    const api = 'https://api.yumi-retail.com/api/v1';
    const code = `const api=${JSON.stringify(api)};`;
    writeFileSync(join(root, 'app.js'), code);
    const info = collectBuildInfo(root, 'device', api);
    verifyBuildInfo(root, info, 'device');
    assert.throws(() => collectBuildInfo(root, 'device', 'https://other.yumi-retail.com/api/v1'));
    writeFileSync(join(root, 'app.js'), code + ' // changed');
    assert.throws(() => verifyBuildInfo(root, info, 'device'));
    writeFileSync(join(root, 'app.js'), code);
    writeFileSync(join(root, 'extra.js'), '// extra');
    assert.throws(() => verifyBuildInfo(root, info, 'device'));
    rmSync(join(root, 'extra.js'));
    rmSync(join(root, 'app.js'));
    assert.throws(() => verifyBuildInfo(root, info, 'device'));
  }));

test('development consumer identity is explicit, local-only and unavailable in device/production builds', async () => {
  const { consumerDevelopmentBuild } = await import('../scripts/mini-build-info.mjs');
  assert.equal(
    consumerDevelopmentBuild(undefined, 'local', 'http://127.0.0.1:3000/api/v1', 'development'),
    false,
  );
  assert.equal(
    consumerDevelopmentBuild('1', 'local', 'http://127.0.0.1:3000/api/v1', 'development'),
    true,
  );
  for (const [target, api, environment] of [
    ['device', 'https://api.yumi-retail.com/api/v1', 'development'],
    ['local', 'http://127.0.0.1:3000/api/v1', 'production'],
    ['local', 'https://remote.invalid/api/v1', 'development'],
  ])
    assert.throws(() => consumerDevelopmentBuild('1', target, api, environment));
});
