import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { addressFixture } from './helpers/address-fixture.ts';
import { ConsumerAuthService } from '../apps/api/dist/consumer-auth.js';
import { applicationConfig } from '../apps/api/dist/config.js';
import { createApplication } from '../apps/api/dist/app.js';
type F = Awaited<ReturnType<typeof addressFixture>>;
async function request(f: F, path: string, body?: unknown, token?: string) {
  const r = await fetch(f.base + '/api/v1' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
      ...(token ? { Authorization: 'Bearer ' + token } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, headers: r.headers, ...(await r.json()) };
}
test('verified WeChat identity is app-scoped, private and separate from development; session restore and logout retain ownership checks', async () => {
  const calls: string[] = [];
  const f = await addressFixture({
    wechatExchange: async (code) => {
      calls.push(code);
      return { openid: code === 'user_b' ? 'synthetic-openid-B-0001' : 'synthetic-openid-A-0001' };
    },
  });
  try {
    assert.equal((await request(f, '/consumer/auth/methods')).data.wechatLoginEnabled, true);
    const [a, b] = await Promise.all([
      request(f, '/consumer/auth/wechat-session', { code: 'user_a_1' }),
      request(f, '/consumer/auth/wechat-session', { code: 'user_a_2' }),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.equal(a.data.user.id, b.data.user.id);
    assert.notEqual(a.data.token, b.data.token);
    assert.equal(a.data.user.provider, 'WECHAT');
    assert.notEqual(a.data.user.id, f.identity.user.id);
    const user = await f.runtime.db.consumerUser.findUniqueOrThrow({
      where: { id: a.data.user.id },
    });
    assert.match(user.subject, /^[a-f0-9]{64}$/);
    assert.equal(user.wechatAppId, 'wx' + '0'.repeat(16));
    assert.equal(JSON.stringify(a.data).includes('openid'), false);
    assert.equal(JSON.stringify(a.data).includes('session_key'), false);
    assert.equal(JSON.stringify(user).includes('synthetic-openid-A-0001'), false);
    assert.equal(
      (await request(f, '/consumer/me', undefined, a.data.token)).data.user.provider,
      'WECHAT',
    );
    assert.equal((await request(f, '/consumer/auth/logout', {}, a.data.token)).status, 200);
    assert.equal((await request(f, '/consumer/me', undefined, a.data.token)).status, 401);
    assert.equal((await request(f, '/consumer/me', undefined, b.data.token)).status, 200);
    const other = await request(f, '/consumer/auth/wechat-session', { code: 'user_b' });
    assert.notEqual(other.data.user.id, a.data.user.id);
    const book = await request(
      f,
      '/consumer/express-addresses',
      {
        version: 0,
        province: '浙江省',
        city: '杭州市',
        district: '西湖区',
        detailAddress: '合成微信地址',
        contactName: '合成收件人',
        phone: '00000000000',
        note: '',
        isDefault: true,
      },
      b.data.token,
    );
    assert.equal(book.status, 200);
    const foreign = await request(
      f,
      '/consumer/express-addresses/' + book.data.id + '/delete',
      { version: 1 },
      other.data.token,
    );
    assert.equal(foreign.status, 404);
    const auth = f.runtime.app.get(ConsumerAuthService);
    const appId = auth.config.wechatAppId;
    auth.config.wechatAppId = 'wx' + '1'.repeat(16);
    assert.equal((await request(f, '/consumer/me', undefined, b.data.token)).status, 401);
    const otherApp = await request(f, '/consumer/auth/wechat-session', { code: 'other_app_code' });
    assert.equal(otherApp.status, 200);
    assert.notEqual(otherApp.data.user.id, a.data.user.id);
    auth.config.wechatAppId = appId;
    assert.equal((await request(f, '/consumer/me', undefined, otherApp.data.token)).status, 401);
    await f.runtime.db.consumerUser.update({
      where: { id: user.id },
      data: { authVersion: { increment: 1 } },
    });
    assert.equal((await request(f, '/consumer/me', undefined, b.data.token)).status, 401);
    await f.runtime.db.consumerUser.update({ where: { id: user.id }, data: { enabled: false } });
    assert.equal(
      (await request(f, '/consumer/auth/wechat-session', { code: 'disabled_user' })).status,
      401,
    );
    assert.equal(
      await f.runtime.db.consumerAuthAudit.count({
        where: { userId: user.id, action: 'WECHAT_LOGIN', outcome: 'DENIED' },
      }),
      1,
    );
    assert.equal(
      (await request(f, '/consumer/auth/wechat-session', { code: 'user_a_1' })).status,
      401,
    );
    assert.equal(calls.filter((c) => c === 'user_a_1').length, 1);
  } finally {
    await f.cleanup();
  }
});
test('code claim prevents duplicate upstream use, throttles socket bucket, rejects client supplied identity and does not cache login tokens for replay', async () => {
  let count = 0;
  const f = await addressFixture({
    wechatExchange: async () => {
      count++;
      return { openid: 'synthetic-openid-once-0001' };
    },
  });
  try {
    for (const input of [
      { code: 'ok', openid: 'forged' },
      { code: '' },
      { code: 'bad code' },
      { code: 'x'.repeat(129) },
    ])
      assert.equal((await request(f, '/consumer/auth/wechat-session', input)).status, 400);
    const race = await Promise.all([
      request(f, '/consumer/auth/wechat-session', { code: 'same_code' }),
      request(f, '/consumer/auth/wechat-session', { code: 'same_code' }),
    ]);
    assert.deepEqual(race.map((r) => r.status).sort(), [200, 401]);
    assert.equal(count, 1);
    const raw = await f.runtime.db.$queryRawUnsafe('SELECT * FROM consumer_wechat_login_codes');
    assert.equal(JSON.stringify(raw).includes('same_code'), false);
    assert.equal(await f.runtime.db.idempotencyRecord.count(), 0);
    await f.runtime.db.consumerLoginThrottle.updateMany({
      where: { attemptCount: { gt: 0 } },
      data: { attemptCount: 60 },
    });
    assert.equal(
      (await request(f, '/consumer/auth/wechat-session', { code: 'limited' })).status,
      429,
    );
    assert.equal(count, 1);
    const x = await fetch(f.base + '/api/v1/consumer/auth/wechat-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.invalid' },
      body: JSON.stringify({ code: 'origin' }),
    });
    assert.equal(x.status, 403);
    await assert.rejects(
      f.runtime.db.consumerUser.updateMany({
        where: { provider: 'WECHAT' },
        data: { subject: 'a'.repeat(64) },
      }),
    );
  } finally {
    await f.cleanup();
  }
});
test('late audit rollback creates no partial account or session; code stays consumed and a fresh code can recover', async () => {
  const f = await addressFixture({
    wechatExchange: async () => ({ openid: 'synthetic-openid-rollback-001' }),
  });
  try {
    const d = f.runtime.db,
      users = await d.consumerUser.count(),
      sessions = await d.consumerSession.count();
    await d.$executeRawUnsafe(
      "CREATE FUNCTION fail_wechat() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='WECHAT_LOGIN' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$",
    );
    await d.$executeRawUnsafe(
      'CREATE TRIGGER fail_wechat BEFORE INSERT ON consumer_auth_audits FOR EACH ROW EXECUTE FUNCTION fail_wechat()',
    );
    assert.equal(
      (await request(f, '/consumer/auth/wechat-session', { code: 'rollback_1' })).status,
      500,
    );
    assert.equal(await d.consumerUser.count(), users);
    assert.equal(await d.consumerSession.count(), sessions);
    assert.equal(
      (await request(f, '/consumer/auth/wechat-session', { code: 'rollback_1' })).status,
      401,
    );
    await d.$executeRawUnsafe('DROP TRIGGER fail_wechat ON consumer_auth_audits');
    assert.equal(
      (await request(f, '/consumer/auth/wechat-session', { code: 'rollback_2' })).status,
      200,
    );
  } finally {
    await f.cleanup();
  }
});
test('default login is closed, formal configuration fails closed and test adapter is never available in production', async () => {
  const f = await addressFixture();
  try {
    assert.equal(
      (await request(f, '/consumer/auth/wechat-session', { code: 'not_enabled' })).status,
      404,
    );
    assert.equal((await request(f, '/consumer/auth/methods')).data.wechatLoginEnabled, false);
  } finally {
    await f.cleanup();
  }
  for (const value of ['2', 'true'])
    assert.throws(() => applicationConfig({ WECHAT_LOGIN_ENABLED: value }));
  assert.throws(() => applicationConfig({ WECHAT_LOGIN_ENABLED: '1' }));
  const config = applicationConfig({
    NODE_ENV: 'production',
    STAFF_ALLOWED_ORIGINS: 'https://store.invalid',
    WECHAT_LOGIN_ENABLED: '1',
    WECHAT_APP_ID: 'wx' + '0'.repeat(16),
    WECHAT_APP_SECRET: randomBytes(16).toString('hex'),
  });
  assert.equal(config.wechatLogin, true);
  assert.equal(config.consumerDevLogin, false);
  await assert.rejects(
    createApplication(
      'postgresql://synthetic:unused@127.0.0.1:55432/yumi_test?schema=wechat_' +
        randomUUID().replaceAll('-', ''),
      { config, wechatExchange: async () => ({ openid: 'synthetic-openid-test' }) },
    ),
    /test adapter/,
  );
});
