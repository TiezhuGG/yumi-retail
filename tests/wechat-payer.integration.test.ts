import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { addressFixture } from './helpers/address-fixture.ts';
import type { ApiRequest } from '../apps/api/src/http.ts';
import { ConsumerAuthService } from '../apps/api/dist/consumer-auth.js';
const appId = 'wx' + '0'.repeat(16),
  openId = 'synthetic-openid-payer-0001';
const key = () => ({ keyId: 'synthetic-v1', keyHex: randomBytes(32).toString('hex') });
const exchange = async (code: string) => ({
  openid: code.startsWith('other') ? 'synthetic-openid-payer-0002' : openId,
});
type F = Awaited<ReturnType<typeof addressFixture>>;
const req = (token?: string): ApiRequest => ({
  method: 'POST',
  headers: token ? { authorization: 'Bearer ' + token } : {},
  socket: { remoteAddress: '127.0.0.1' },
  requestId: randomUUID(),
});
async function login(f: F, code: string = randomUUID()) {
  const r = await fetch(f.base + '/api/v1/consumer/auth/wechat-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  return { status: r.status, ...(await r.json()) };
}
async function payer(f: F, auth: ConsumerAuthService, token: string, targetApp = appId) {
  const r = req(token);
  r.consumerContext = await auth.authenticate(r);
  return f.runtime.db.$transaction((tx) => auth.paymentPayer(tx, r, targetApp));
}
const codeIs = (code: string) => (e: unknown) => {
  assert.equal((e as { getResponse(): { code: string } }).getResponse().code, code);
  return true;
};
test('verified concurrent logins retain one encrypted binding; only internal authenticated accessor decrypts', async () => {
  const f = await addressFixture({ wechatExchange: exchange, payerEncryption: key() });
  try {
    const auth = f.runtime.app.get(ConsumerAuthService),
      d = f.runtime.db;
    const results = await Promise.all([login(f), login(f)]);
    assert.deepEqual(
      results.map((r) => r.status),
      [200, 200],
    );
    const a = results[0].data,
      b = results[1].data;
    assert.equal(a.user.id, b.user.id);
    assert.notEqual(a.token, b.token);
    const binding = await d.consumerWechatPayer.findUniqueOrThrow({ where: { userId: a.user.id } });
    assert.equal(binding.version, 1);
    assert.equal(await d.consumerWechatPayer.count(), 1);
    assert.equal(
      (await d.consumerUser.findUniqueOrThrow({ where: { id: a.user.id } })).subject,
      createHash('sha256')
        .update(appId + ':' + openId)
        .digest('hex'),
    );
    assert.equal((await payer(f, auth, a.token)).openId, openId);
    assert.ok(
      !JSON.stringify([results, binding, await d.consumerAuthAudit.findMany()]).includes(openId),
    );
    assert.equal(
      (
        await fetch(f.base + '/api/v1/consumer/payment-payer', {
          headers: { Authorization: 'Bearer ' + a.token },
        })
      ).status,
      404,
    );
    await assert.rejects(
      payer(f, auth, a.token, 'wx' + '1'.repeat(16)),
      codeIs('PAYER_IDENTITY_REQUIRED'),
    );
    await assert.rejects(payer(f, auth, f.identity.token), codeIs('PAYER_IDENTITY_REQUIRED'));
    const stale = req(a.token);
    stale.consumerContext = await auth.authenticate(stale);
    await auth.logout(req(a.token), stale.consumerContext);
    await assert.rejects(
      d.$transaction((tx) => auth.paymentPayer(tx, stale, appId)),
      codeIs('SESSION_EXPIRED'),
    );
    await d.consumerUser.update({ where: { id: a.user.id }, data: { enabled: false } });
    await assert.rejects(payer(f, auth, b.token));
  } finally {
    await f.cleanup();
  }
});
test('hash-only legacy login still works without key and verified re-login fills binding without replacing account', async () => {
  const f = await addressFixture({ wechatExchange: exchange });
  try {
    const d = f.runtime.db,
      old = f.runtime.app.get(ConsumerAuthService),
      a = (await login(f)).data;
    assert.equal(await d.consumerWechatPayer.count(), 0);
    await assert.rejects(payer(f, old, a.token), codeIs('PAYER_STORAGE_UNAVAILABLE'));
    const auth = new ConsumerAuthService(
      d,
      { ...old.config, wechatPayerEncryption: key() },
      exchange,
    );
    await assert.rejects(payer(f, auth, a.token), codeIs('PAYER_REFRESH_REQUIRED'));
    const before = await d.consumerUser.findUniqueOrThrow({ where: { id: a.user.id } });
    const fresh = await auth.wechatLogin(req(), { code: randomUUID() });
    assert.equal(fresh.user.id, a.user.id);
    assert.deepEqual(await d.consumerUser.findUniqueOrThrow({ where: { id: a.user.id } }), before);
    assert.equal((await payer(f, auth, fresh.token)).openId, openId);
  } finally {
    await f.cleanup();
  }
});
test('audit failure rolls back new binding and sessions and preserves an existing binding revision', async () => {
  const f = await addressFixture({ wechatExchange: exchange, payerEncryption: key() });
  try {
    const d = f.runtime.db;
    await d.$executeRawUnsafe(
      "CREATE FUNCTION fail_payer_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='WECHAT_LOGIN' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$",
    );
    await d.$executeRawUnsafe(
      'CREATE TRIGGER fail_payer_audit BEFORE INSERT ON consumer_auth_audits FOR EACH ROW EXECUTE FUNCTION fail_payer_audit()',
    );
    const users = await d.consumerUser.count(),
      sessions = await d.consumerSession.count();
    assert.equal((await login(f, 'failed_new')).status, 500);
    assert.equal(await d.consumerWechatPayer.count(), 0);
    assert.equal(await d.consumerUser.count(), users);
    assert.equal(await d.consumerSession.count(), sessions);
    await d.$executeRawUnsafe('DROP TRIGGER fail_payer_audit ON consumer_auth_audits');
    const a = (await login(f)).data,
      before = await d.consumerWechatPayer.findUniqueOrThrow({ where: { userId: a.user.id } });
    await d.$executeRawUnsafe(
      'CREATE TRIGGER fail_payer_audit BEFORE INSERT ON consumer_auth_audits FOR EACH ROW EXECUTE FUNCTION fail_payer_audit()',
    );
    assert.equal((await login(f, 'failed_existing')).status, 500);
    assert.deepEqual(
      await d.consumerWechatPayer.findUniqueOrThrow({ where: { userId: a.user.id } }),
      before,
    );
    assert.equal(await d.consumerSession.count(), sessions + 1);
  } finally {
    await f.cleanup();
  }
});
test('rotation requires a fresh verified login; transplanted ciphertext and direct database source changes fail', async () => {
  const original = key(),
    f = await addressFixture({ wechatExchange: exchange, payerEncryption: original });
  try {
    const d = f.runtime.db,
      old = f.runtime.app.get(ConsumerAuthService),
      a = (await login(f)).data;
    const auth = new ConsumerAuthService(
      d,
      { ...old.config, wechatPayerEncryption: { ...key(), keyId: 'synthetic-v2' } },
      exchange,
    );
    await assert.rejects(payer(f, auth, a.token), codeIs('PAYER_REFRESH_REQUIRED'));
    const fresh = await auth.wechatLogin(req(), { code: randomUUID() });
    assert.equal(fresh.user.id, a.user.id);
    assert.equal((await payer(f, auth, fresh.token)).openId, openId);
    await assert.rejects(payer(f, old, a.token), codeIs('PAYER_REFRESH_REQUIRED'));
    const b = (await login(f, 'other_user')).data;
    const other = await d.consumerWechatPayer.findUniqueOrThrow({ where: { userId: b.user.id } });
    await d.consumerWechatPayer.update({
      where: { userId: a.user.id },
      data: { payload: other.payload, keyId: other.keyId, version: { increment: 1 } },
    });
    await assert.rejects(payer(f, old, a.token), codeIs('PAYER_IDENTITY_UNREADABLE'));
    for (const data of [
      { appId: 'wx' + '1'.repeat(16), version: { increment: 1 } },
      { payload: openId, version: { increment: 1 } },
      { keyId: 'invalid-version' },
    ])
      await assert.rejects(d.consumerWechatPayer.update({ where: { userId: a.user.id }, data }));
    await assert.rejects(
      d.consumerWechatPayer.create({
        data: { userId: f.identity.user.id, appId, keyId: original.keyId, payload: other.payload },
      }),
    );
  } finally {
    await f.cleanup();
  }
});
test('payer read rechecks expiry after waiting for storage and rejects an already authenticated stale identity version', async () => {
  const f = await addressFixture({ wechatExchange: exchange, payerEncryption: key() });
  let release = () => {};
  try {
    const d = f.runtime.db,
      auth = f.runtime.app.get(ConsumerAuthService),
      a = (await login(f)).data;
    const r = req(a.token);
    r.consumerContext = await auth.authenticate(r);
    await d.consumerUser.update({
      where: { id: a.user.id },
      data: { authVersion: { increment: 1 } },
    });
    await assert.rejects(
      d.$transaction((tx) => auth.paymentPayer(tx, r, appId)),
      codeIs('SESSION_EXPIRED'),
    );
    const fresh = await login(f),
      waiting = req(fresh.data.token);
    waiting.consumerContext = await auth.authenticate(waiting);
    let locked = () => {};
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const blocker = d.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('LOCK TABLE consumer_wechat_payers IN ACCESS EXCLUSIVE MODE');
      locked();
      await gate;
    });
    await ready;
    await d.$executeRaw`UPDATE consumer_sessions SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=${waiting.consumerContext.sessionId}::uuid`;
    const read = assert.rejects(
      d.$transaction((tx) => auth.paymentPayer(tx, waiting, appId)),
      codeIs('SESSION_EXPIRED'),
    );
    const timer = setTimeout(release, 900);
    try {
      await Promise.all([read, blocker]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    release();
    await f.cleanup();
  }
});
