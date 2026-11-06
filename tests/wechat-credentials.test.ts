import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey } from 'node:crypto';
import { chmod, writeFile, readFile, symlink, unlink, link } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { wechatCredentialsFixture } from './helpers/wechat-credentials-fixture.ts';
import {
  WechatCredentialStore,
  WechatCredentialError,
} from '../apps/api/src/wechat-credentials.ts';
const error = (code: string) => (e: unknown) =>
  e instanceof WechatCredentialError && e.code === code;
test('private bundle binds matching merchant key/certificate and trusted public keys without serializing key material', async () => {
  const f = await wechatCredentialsFixture();
  try {
    const store = f.store();
    await store.reload(f.now);
    const snapshot = store.current(f.now);
    assert.equal(snapshot.revision, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), { revision: 1 });
    snapshot.checkResponseKey({ 'Wechatpay-Serial': f.manifest.platformKeys[0]!.id }, f.now);
    assert.throws(
      () => snapshot.checkResponseKey({ 'Wechatpay-Serial': 'PUB_KEY_ID_UNKNOWN' }, f.now),
      error('CREDENTIALS_UNAVAILABLE'),
    );
    assert.throws(() =>
      snapshot.checkResponseKey(
        {
          'Wechatpay-Serial': f.manifest.platformKeys[0]!.id,
          'wechatpay-serial': f.manifest.platformKeys[0]!.id,
        },
        f.now,
      ),
    );
    assert.ok(!JSON.stringify(store).includes('PRIVATE KEY'));
  } finally {
    await f.cleanup();
  }
});
test('permissive directories, symlinks, hardlinks, FIFOs and paths outside bundle are rejected with sanitized errors', async () => {
  const f = await wechatCredentialsFixture();
  try {
    await chmod(f.directory, 0o755);
    await assert.rejects(f.store().reload(f.now), error('BUNDLE_INVALID'));
    await chmod(f.directory, 0o700);
    await chmod(join(f.directory, 'merchant.pem'), 0o644);
    await assert.rejects(f.store().reload(f.now), error('BUNDLE_INVALID'));
    await chmod(join(f.directory, 'merchant.pem'), 0o600);
    await chmod(join(f.directory, 'merchant.pem'), 0o700);
    await assert.rejects(f.store().reload(f.now), error('BUNDLE_INVALID'));
    await chmod(join(f.directory, 'merchant.pem'), 0o600);
    await symlink('merchant.pem', join(f.directory, 'alias.pem'));
    f.manifest.privateKeyFile = 'alias.pem';
    await f.save();
    await assert.rejects(f.store().reload(f.now), error('BUNDLE_INVALID'));
    await unlink(join(f.directory, 'alias.pem'));
    await link(join(f.directory, 'merchant.pem'), join(f.directory, 'alias.pem'));
    f.manifest.privateKeyFile = 'merchant.pem';
    await f.save();
    await assert.rejects(f.store().reload(f.now), error('BUNDLE_INVALID'));
    await unlink(join(f.directory, 'alias.pem'));
    execFileSync('mkfifo', [join(f.directory, 'pipe.pem')]);
    f.manifest.privateKeyFile = 'pipe.pem';
    await f.save();
    await assert.rejects(f.store().reload(f.now), error('BUNDLE_INVALID'));
    f.manifest.privateKeyFile = '../merchant.pem';
    await f.save();
    await assert.rejects(f.store().reload(f.now), (e: unknown) => {
      assert.ok(e instanceof WechatCredentialError);
      assert.ok(!e.message.includes(f.directory));
      return true;
    });
    await assert.rejects(
      new WechatCredentialStore('.', f.binding).reload(f.now),
      error('BUNDLE_INVALID'),
    );
  } finally {
    await f.cleanup();
  }
});
test('mismatched key/certificate, non-RSA2048 keys and concatenated PEM or oversized files fail closed', async () => {
  const f = await wechatCredentialsFixture();
  try {
    const keyPath = join(f.directory, 'merchant.pem');
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    for (const bytes of [
      other.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      Buffer.concat([f.privatePem, f.privatePem]),
      Buffer.alloc(32769, 65),
    ]) {
      await writeFile(keyPath, bytes);
      await assert.rejects(f.store().reload(f.now), error('BUNDLE_INVALID'));
    }
    await writeFile(keyPath, f.privatePem);
    const weak = generateKeyPairSync('rsa', { modulusLength: 1024 });
    await writeFile(
      join(f.directory, 'platform.pem'),
      weak.publicKey.export({ type: 'spki', format: 'pem' }),
    );
    await assert.rejects(f.store().reload(f.now), error('BUNDLE_INVALID'));
    await writeFile(
      join(f.directory, 'platform.pem'),
      createPublicKey(other.privateKey).export({ type: 'spki', format: 'pem' }),
    );
    f.manifest.merchantId = '1900000110';
    await f.save();
    await assert.rejects(f.store().reload(f.now), error('BUNDLE_INVALID'));
  } finally {
    await f.cleanup();
  }
});
test('manifest has strict fields and binding; duplicate keys and invalid trust intervals cannot be loaded', async () => {
  const f = await wechatCredentialsFixture();
  try {
    const original = JSON.parse(await readFile(join(f.directory, 'manifest.json'), 'utf8'));
    for (const value of [
      { ...original, extra: true },
      { ...original, version: 2 },
      { ...original, revision: 0 },
      { ...original, appId: 'wx2222222222222222' },
      { ...original, notifyUrl: 'https://untrusted.invalid/n' },
      { ...original, platformKeys: [] },
      { ...original, platformKeys: [original.platformKeys[0], original.platformKeys[0]] },
      {
        ...original,
        platformKeys: [
          { ...original.platformKeys[0], notBefore: original.platformKeys[0].notAfter },
        ],
      },
      { ...original, platformKeys: [{ ...original.platformKeys[0], id: 'unknown' }] },
    ]) {
      await writeFile(join(f.directory, 'manifest.json'), JSON.stringify(value));
      await assert.rejects(f.store().reload(f.now), error('BUNDLE_INVALID'));
    }
    f.manifest.platformKeys[0]!.notBefore = new Date(f.now + 60000).toISOString();
    await f.save();
    await assert.rejects(f.store().reload(f.now), error('BUNDLE_INVALID'));
  } finally {
    await f.cleanup();
  }
});
test('certificate and operator trust windows are enforced on every use, including loaded snapshots', async () => {
  const f = await wechatCredentialsFixture();
  try {
    const store = f.store();
    await store.reload(f.now);
    assert.throws(() => store.current(f.now + 3600000), error('CREDENTIALS_UNAVAILABLE'));
    assert.throws(() => store.current(f.now - 3 * 86400000), error('CREDENTIALS_UNAVAILABLE'));
    f.manifest.platformKeys[0]!.notAfter = new Date(f.now + 4 * 86400000).toISOString();
    await f.save();
    await assert.rejects(f.store().reload(f.now + 3 * 86400000), error('BUNDLE_INVALID'));
  } finally {
    await f.cleanup();
  }
});
test('rotation is atomic and monotonic; failed reload blocks new uses until a valid reload recovers', async () => {
  const f = await wechatCredentialsFixture();
  try {
    const store = f.store();
    await store.reload(f.now);
    const old = store.current(f.now);
    await Promise.all([store.reload(f.now), store.reload(f.now)]);
    f.manifest.revision = 2;
    f.manifest.platformKeys[0]!.id = 'PUB_KEY_ID_SYNTHETIC_2';
    await f.save();
    await store.reload(f.now);
    assert.equal(store.current(f.now).revision, 2);
    old.checkResponseKey({ 'Wechatpay-Serial': 'PUB_KEY_ID_SYNTHETIC_1' }, f.now);
    assert.throws(() =>
      store
        .current(f.now)
        .checkResponseKey({ 'Wechatpay-Serial': 'PUB_KEY_ID_SYNTHETIC_1' }, f.now),
    );
    f.manifest.revision = 1;
    await f.save();
    await assert.rejects(store.reload(f.now), error('REVISION_REJECTED'));
    assert.throws(() => store.current(f.now), error('CREDENTIALS_UNAVAILABLE'));
    f.manifest.revision = 2;
    f.manifest.platformKeys[0]!.id = 'PUB_KEY_ID_SYNTHETIC_3';
    await f.save();
    await assert.rejects(store.reload(f.now), error('REVISION_REJECTED'));
    f.manifest.revision = 3;
    await f.save();
    await store.reload(f.now);
    assert.equal(store.current(f.now).revision, 3);
    await writeFile(join(f.directory, 'manifest.json'), '{invalid');
    await assert.rejects(store.reload(f.now), error('BUNDLE_INVALID'));
    assert.throws(() => store.current(f.now), error('CREDENTIALS_UNAVAILABLE'));
    await f.save();
    await store.reload(f.now);
    assert.equal(store.current(f.now).revision, 3);
  } finally {
    await f.cleanup();
  }
});
test('operator CLI is offline, fails closed and never prints paths, binding identifiers or key material', async () => {
  const f = await wechatCredentialsFixture();
  try {
    const env = {
      ...process.env,
      WECHAT_PAY_CREDENTIALS_DIR: f.directory,
      WECHAT_APP_ID: f.binding.appId,
      WECHAT_PAY_APP_ID: f.binding.appId,
      WECHAT_PAY_MCH_ID: f.binding.merchantId,
      WECHAT_PAY_NOTIFY_URL: f.binding.notifyUrl,
    };
    for (const [change, status, code] of [
      [{}, 0, 'CREDENTIALS_VALID_OFFLINE'],
      [{ WECHAT_APP_ID: 'wx2222222222222222' }, 1, 'CREDENTIALS_INVALID'],
      [{ WECHAT_PAY_CREDENTIALS_DIR: '' }, 1, 'CREDENTIALS_NOT_CONFIGURED'],
    ] as const) {
      const result = spawnSync(process.execPath, ['scripts/check-wechat-pay-credentials.mjs'], {
        env: { ...env, ...change },
        encoding: 'utf8',
      });
      assert.equal(result.status, status);
      const value = JSON.parse(result.stdout);
      assert.equal(value.code, code);
      assert.equal(value.canStartPayment, false);
      assert.equal(value.networkChecked, false);
      for (const secret of [
        f.directory,
        f.binding.appId,
        f.binding.merchantId,
        f.binding.notifyUrl,
        'PRIVATE KEY',
      ])
        assert.ok(!(result.stdout + result.stderr).includes(secret));
    }
  } finally {
    await f.cleanup();
  }
});
