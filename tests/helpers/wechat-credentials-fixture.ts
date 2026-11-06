// Generated synthetic keys/certificate, private temp directory, no real merchant material.
import { generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WechatCredentialStore } from '../../apps/api/src/wechat-credentials.ts';
export async function wechatCredentialsFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'yumi-wx-credentials-'));
  try {
    await chmod(directory, 0o700);
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '2',
        '-subj',
        '/CN=1900000109',
        '-addext',
        'basicConstraints=critical,CA:FALSE',
        '-addext',
        'subjectAltName=DNS:api.mch.weixin.qq.com',
        '-keyout',
        join(directory, 'merchant.pem'),
        '-out',
        join(directory, 'certificate.pem'),
      ],
      { stdio: 'ignore' },
    );
    for (const file of ['merchant.pem', 'certificate.pem'])
      await chmod(join(directory, file), 0o600);
    const now = Date.now(),
      platform = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const binding = {
      appId: 'wx1111111111111111',
      merchantId: '1900000109',
      notifyUrl: 'https://payments.yumi-demo.com/api/v1/wechat/notify',
    };
    await writeFile(
      join(directory, 'platform.pem'),
      platform.publicKey.export({ type: 'spki', format: 'pem' }),
      { mode: 0o600 },
    );
    const manifest = {
      version: 1,
      revision: 1,
      ...binding,
      privateKeyFile: 'merchant.pem',
      certificateFile: 'certificate.pem',
      platformKeys: [
        {
          id: 'PUB_KEY_ID_SYNTHETIC_1',
          publicKeyFile: 'platform.pem',
          notBefore: new Date(now - 3600000).toISOString(),
          notAfter: new Date(now + 3600000).toISOString(),
        },
      ],
    };
    const save = () =>
      writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest), { mode: 0o600 });
    await save();
    return {
      directory,
      manifest,
      binding,
      platform,
      now,
      save,
      store: () => new WechatCredentialStore(directory, binding),
      privatePem: await readFile(join(directory, 'merchant.pem')),
      certificatePem: await readFile(join(directory, 'certificate.pem')),
      cleanup: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (e) {
    await rm(directory, { recursive: true, force: true });
    throw e;
  }
}
