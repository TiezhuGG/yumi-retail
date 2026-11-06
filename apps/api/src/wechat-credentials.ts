import {
  createHash,
  createPrivateKey,
  createPublicKey,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { createJsapiProtocol, type JsapiMerchant } from './wechat-jsapi.js';

export class WechatCredentialError extends Error {
  constructor(readonly code: 'BUNDLE_INVALID' | 'REVISION_REJECTED' | 'CREDENTIALS_UNAVAILABLE') {
    super('WeChat credentials rejected: ' + code);
  }
}
export interface WechatMerchantBinding {
  appId: string;
  merchantId: string;
  notifyUrl: string;
}
interface PlatformKey {
  id: string;
  key: KeyObject;
  notBefore: number;
  notAfter: number;
}
const reject = (): never => {
  throw new WechatCredentialError('BUNDLE_INVALID');
};
function record(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject();
  const result = value as Record<string, unknown>;
  if (Object.keys(result).length !== fields.length || fields.some((k) => !Object.hasOwn(result, k)))
    return reject();
  return result;
}
function instant(value: unknown): number {
  if (typeof value !== 'string' || value.length !== 24) return reject();
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || new Date(parsed).toISOString() !== value) return reject();
  return parsed;
}
function rsa(key: KeyObject, type: 'private' | 'public') {
  if (
    key.type !== type ||
    key.asymmetricKeyType !== 'rsa' ||
    key.asymmetricKeyDetails?.modulusLength !== 2048 ||
    key.asymmetricKeyDetails?.publicExponent !== 65537n
  )
    return reject();
  return key;
}
// Private directories/files must be installed by a trusted operator. No uploads or URL paths.
async function privateFile(directory: string, name: unknown): Promise<Buffer> {
  if (
    typeof name !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(name) ||
    name.includes('..')
  )
    return reject();
  const file = await open(
    join(directory, name),
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const before = await file.stat();
    if (
      !before.isFile() ||
      before.uid !== process.getuid?.() ||
      before.mode & 0o177 ||
      before.nlink !== 1 ||
      before.size < 1 ||
      before.size > 32768
    )
      return reject();
    const bytes = Buffer.alloc(before.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const next = await file.read(bytes, size, bytes.length - size, null);
      if (!next.bytesRead) break;
      size += next.bytesRead;
    }
    const after = await file.stat();
    if (
      size !== before.size ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    )
      return reject();
    return bytes.subarray(0, size);
  } finally {
    await file.close();
  }
}
function pem(bytes: Buffer, label: 'PRIVATE KEY' | 'CERTIFICATE' | 'PUBLIC KEY') {
  const text = bytes.toString('ascii');
  if (
    !bytes.equals(Buffer.from(text, 'ascii')) ||
    !new RegExp(
      `^-----BEGIN ${label}-----\\r?\\n[A-Za-z0-9+/=\\r\\n]+\\r?\\n-----END ${label}-----\\r?\\n?$`,
    ).test(text)
  )
    return reject();
  return bytes;
}
export class WechatCredentialSnapshot {
  #merchant: JsapiMerchant;
  #keys: readonly PlatformKey[];
  #notBefore: number;
  #notAfter: number;
  constructor(
    readonly revision: number,
    merchant: JsapiMerchant,
    keys: readonly PlatformKey[],
    certificate: X509Certificate,
  ) {
    this.#merchant = Object.freeze(merchant);
    this.#keys = keys;
    this.#notBefore = Date.parse(certificate.validFrom);
    this.#notAfter = Date.parse(certificate.validTo);
    Object.freeze(this);
  }
  private keysAt(nowMs: number) {
    if (!Number.isSafeInteger(nowMs) || nowMs < this.#notBefore || nowMs >= this.#notAfter)
      throw new WechatCredentialError('CREDENTIALS_UNAVAILABLE');
    const keys = new Map(
      this.#keys
        .filter((k) => nowMs >= k.notBefore && nowMs < k.notAfter)
        .map((k) => [k.id, k.key]),
    );
    if (!keys.size) throw new WechatCredentialError('CREDENTIALS_UNAVAILABLE');
    return keys;
  }
  protocol(nowMs: number) {
    return createJsapiProtocol(this.#merchant, this.keysAt(nowMs));
  }
  checkResponseKey(headers: Record<string, string | string[] | undefined>, nowMs: number) {
    const values = Object.entries(headers).filter(
      ([name]) => name.toLowerCase() === 'wechatpay-serial',
    );
    if (
      values.length !== 1 ||
      typeof values[0]![1] !== 'string' ||
      !this.keysAt(nowMs).has(values[0]![1])
    )
      throw new WechatCredentialError('CREDENTIALS_UNAVAILABLE');
  }
}
async function load(directory: string, expected: WechatMerchantBinding, nowMs: number) {
  try {
    if (!isAbsolute(directory) || (await realpath(directory)) !== resolve(directory))
      return reject();
    const before = await lstat(directory);
    if (!before.isDirectory() || before.uid !== process.getuid?.() || before.mode & 0o077)
      return reject();
    const manifestBytes = await privateFile(directory, 'manifest.json');
    const manifest = record(JSON.parse(manifestBytes.toString('utf8')), [
      'version',
      'revision',
      'appId',
      'merchantId',
      'notifyUrl',
      'privateKeyFile',
      'certificateFile',
      'platformKeys',
    ]);
    if (
      manifest.version !== 1 ||
      !Number.isSafeInteger(manifest.revision) ||
      Number(manifest.revision) < 1 ||
      manifest.appId !== expected.appId ||
      manifest.merchantId !== expected.merchantId ||
      manifest.notifyUrl !== expected.notifyUrl
    )
      return reject();
    if (
      !Array.isArray(manifest.platformKeys) ||
      manifest.platformKeys.length < 1 ||
      manifest.platformKeys.length > 4
    )
      return reject();
    const files = [manifestBytes];
    const privateBytes = await privateFile(directory, manifest.privateKeyFile);
    files.push(privateBytes);
    let privateKey: KeyObject;
    try {
      privateKey = rsa(createPrivateKey(pem(privateBytes, 'PRIVATE KEY')), 'private');
    } finally {
      privateBytes.fill(0);
    }
    const certificateBytes = await privateFile(directory, manifest.certificateFile);
    files.push(certificateBytes);
    const certificate = new X509Certificate(pem(certificateBytes, 'CERTIFICATE'));
    if (
      certificate.ca ||
      !certificate.subject.split('\n').includes('CN=' + expected.merchantId) ||
      !createPublicKey(privateKey)
        .export({ type: 'spki', format: 'der' })
        .equals(certificate.publicKey.export({ type: 'spki', format: 'der' }))
    )
      return reject();
    const keys: PlatformKey[] = [];
    for (const entry of manifest.platformKeys) {
      const value = record(entry, ['id', 'publicKeyFile', 'notBefore', 'notAfter']);
      if (
        typeof value.id !== 'string' ||
        !/^PUB_KEY_ID_[A-Za-z0-9_]{1,110}$/.test(value.id) ||
        keys.some((k) => k.id === value.id)
      )
        return reject();
      const bytes = await privateFile(directory, value.publicKeyFile);
      files.push(bytes);
      const notBefore = instant(value.notBefore),
        notAfter = instant(value.notAfter);
      if (notBefore >= notAfter) return reject();
      keys.push({
        id: value.id,
        key: rsa(createPublicKey(pem(bytes, 'PUBLIC KEY')), 'public'),
        notBefore,
        notAfter,
      });
    }
    const after = await lstat(directory);
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.ctimeMs !== after.ctimeMs ||
      before.mode !== after.mode
    )
      return reject();
    const snapshot = new WechatCredentialSnapshot(
      Number(manifest.revision),
      { ...expected, privateKey, certificateSerial: certificate.serialNumber },
      keys,
      certificate,
    );
    snapshot.protocol(nowMs);
    // Include derived public identity: private PEM buffers have already been zeroed.
    const digest = createHash('sha256');
    for (const bytes of files) digest.update(bytes);
    digest.update(createPublicKey(privateKey).export({ type: 'spki', format: 'der' }));
    return { snapshot, fingerprint: digest.digest('hex') };
  } catch {
    return reject();
  }
}
// Explicit reload only. Failed reload blocks new calls; in-flight calls retain their snapshot.
// Future startup integration must not expose a reload/upload API or enable PAYMENT_MODE.
export class WechatCredentialStore {
  #loaded?: Awaited<ReturnType<typeof load>>;
  #blocked = true;
  #reloading?: Promise<void>;
  #binding: WechatMerchantBinding;
  #directory: string;
  constructor(directory: string, expected: WechatMerchantBinding) {
    this.#directory = directory;
    this.#binding = Object.freeze({ ...expected });
  }
  reload(nowMs = Date.now()): Promise<void> {
    if (this.#reloading) return this.#reloading;
    this.#blocked = true;
    const attempt = async () => {
      const next = await load(this.#directory, this.#binding, nowMs);
      if (
        this.#loaded &&
        (next.snapshot.revision < this.#loaded.snapshot.revision ||
          (next.snapshot.revision === this.#loaded.snapshot.revision &&
            next.fingerprint !== this.#loaded.fingerprint))
      )
        throw new WechatCredentialError('REVISION_REJECTED');
      this.#loaded = next;
      this.#blocked = false;
    };
    this.#reloading = attempt().finally(() => {
      this.#reloading = undefined;
    });
    return this.#reloading;
  }
  current(nowMs = Date.now()) {
    if (this.#blocked || !this.#loaded) throw new WechatCredentialError('CREDENTIALS_UNAVAILABLE');
    this.#loaded.snapshot.protocol(nowMs);
    return this.#loaded.snapshot;
  }
}
