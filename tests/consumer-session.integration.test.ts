import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { createDatabase, hashPassword } from '../packages/database/src/index.ts';
import { createApplication } from '../apps/api/dist/app.js';
import { applicationConfig } from '../apps/api/dist/config.js';
import {
  ConsumerAuthService,
  validateConsumerEnvironment,
} from '../apps/api/dist/consumer-auth.js';
import { tokenHash } from '../apps/api/dist/staff-auth.js';
import type { AccessEvent } from '../apps/api/dist/app.js';
const url = new URL(process.env.TEST_DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/yumi_test')
  throw Error('Local test database only');
const schema = 'consumer_' + randomUUID().replaceAll('-', '');
const { Client } = createRequire(import.meta.url)('pg');
const admin = new Client({ connectionString: url.toString() });
url.searchParams.set('schema', schema);
const db = createDatabase(url.toString());
const logs: AccessEvent[] = [];
const config = applicationConfig({ NODE_ENV: 'test', CONSUMER_DEV_LOGIN_ENABLED: '1' });
let runtime: Awaited<ReturnType<typeof createApplication>>;
let base: string;
const tokens: string[] = [];
interface Login {
  token: string;
  expiresAt: string;
  user: { id: string; displayName: string; provider: string };
}
async function call<T = Login>(
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string>; method?: string } = {},
  target = base,
) {
  const response = await fetch(target + '/api/v1' + path, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers: {
      'Content-Type': 'application/json',
      'X-Yumi-Dev-Login': '1',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return {
    status: response.status,
    cookie: response.headers.get('set-cookie'),
    ...((await response.json()) as { data: T; error?: { code: string }; requestId: string }),
  };
}
async function login(profile = 'customer-a', target = base) {
  const result = await call('/consumer/auth/dev-session', { body: { profile } }, target);
  assert.equal(result.status, 200);
  tokens.push(result.data.token);
  return result.data;
}
before(async () => {
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query("SELECT set_config('search_path',$1,false)", [schema]);
  const directory = 'packages/database/prisma/migrations';
  for (const name of (await readdir(directory)).filter((n) => /^\d/.test(n)).sort())
    await admin.query(await readFile(`${directory}/${name}/migration.sql`, 'utf8'));
  runtime = await createApplication(url.toString(), { config, accessLog: (e) => logs.push(e) });
  await runtime.app.listen(0, '127.0.0.1');
  base = await runtime.app.getUrl();
});
after(async () => {
  try {
    if (runtime) await runtime.close();
    await db.$disconnect();
    assert.match(schema, /^consumer_[a-f0-9]{32}$/);
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await admin.end();
  }
});
test('development adapter defaults off, rejects production/remote DB/binding and forwarded connections', async () => {
  assert.equal(applicationConfig({ NODE_ENV: 'test' }).consumerDevLogin, false);
  assert.throws(() =>
    applicationConfig({
      NODE_ENV: 'production',
      STAFF_ALLOWED_ORIGINS: 'https://store.invalid',
      CONSUMER_DEV_LOGIN_ENABLED: '1',
    }),
  );
  assert.throws(() =>
    applicationConfig({
      NODE_ENV: 'development',
      API_HOST: '0.0.0.0',
      CONSUMER_DEV_LOGIN_ENABLED: '1',
    }),
  );
  for (const value of ['https://remote.invalid/yumi_dev', 'postgresql://127.0.0.1/production'])
    assert.throws(() => validateConsumerEnvironment(value, config));
  const service = new ConsumerAuthService(runtime.db, config);
  assert.equal(
    service.developmentAllowed({
      headers: {},
      socket: { remoteAddress: '192.168.1.3' },
      method: 'POST',
      requestId: randomUUID(),
    }),
    false,
  );
  for (const headers of [
    { forwarded: 'for=127.0.0.1' },
    { 'x-forwarded-for': '127.0.0.1' },
    { Origin: 'https://bad.invalid' },
  ]) {
    const normalized = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    assert.equal(
      (
        await call('/consumer/auth/dev-session', {
          headers: normalized,
          body: { profile: 'customer-a' },
        })
      ).status,
      404,
    );
  }
  const disabled = await createApplication(url.toString(), {
    config: applicationConfig({ NODE_ENV: 'test' }),
    accessLog: () => {},
  });
  try {
    await disabled.app.listen(0, '127.0.0.1');
    assert.equal(
      (
        await call(
          '/consumer/auth/dev-session',
          { body: { profile: 'customer-a' } },
          await disabled.app.getUrl(),
        )
      ).status,
      404,
    );
  } finally {
    await disabled.close();
  }
});
test('strict input rejects user ids, extra fields, unsupported identities and absent development header', async () => {
  for (const body of [
    { profile: 'customer-a', userId: randomUUID() },
    { profile: randomUUID() },
    { openid: 'fake' },
    [],
    null,
  ])
    assert.equal((await call('/consumer/auth/dev-session', { body })).status, 400);
  assert.equal(
    (
      await call('/consumer/auth/dev-session', {
        body: { profile: 'customer-a' },
        headers: { 'X-Yumi-Dev-Login': '' },
      })
    ).status,
    403,
  );
  assert.equal(
    (await call('/consumer/auth/dev-session?userId=x', { body: { profile: 'customer-a' } })).status,
    400,
  );
});
test('opaque tokens persist as hashes; current profile never returns provider subject or token', async () => {
  const first = await login();
  const stored = await db.consumerSession.findUnique({
    where: { tokenHash: tokenHash(first.token) },
  });
  assert.ok(stored);
  assert.notEqual(stored.tokenHash, first.token);
  assert.equal(first.user.provider, 'DEVELOPMENT');
  const result = await call('/consumer/me', { token: first.token });
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.data).sort(), ['expiresAt', 'user']);
  assert.deepEqual(Object.keys(result.data.user).sort(), ['displayName', 'id', 'provider']);
  assert.equal(JSON.stringify(result).includes(first.token), false);
  assert.equal(result.cookie, null);
  assert.equal((await call('/consumer/me')).status, 401);
  assert.equal((await call('/consumer/me', { token: 'x' })).status, 401);
});
test('identities remain separate; caller cannot choose another user and consumer bearer cannot access staff APIs', async () => {
  const a = await login(),
    b = await login('customer-b');
  assert.notEqual(a.user.id, b.user.id);
  assert.equal((await call('/consumer/me', { token: a.token })).data.user.id, a.user.id);
  assert.equal((await call('/consumer/me?userId=' + b.user.id, { token: a.token })).status, 400);
  assert.equal((await call('/staff/me', { token: a.token })).status, 401);
  assert.equal((await call('/admin/staff', { token: a.token })).status, 401);
  const staff = await db.staff.create({
    data: {
      id: randomUUID(),
      loginName: 'consumer-test',
      displayName: '测试员工',
      passwordHash: await hashPassword('unused test password'),
    },
  });
  const raw = 's'.repeat(43);
  await db.staffSession.create({
    data: {
      id: randomUUID(),
      staffId: staff.id,
      tokenHash: tokenHash(raw),
      authVersion: 0,
      expiresAt: new Date(Date.now() + 60000),
    },
  });
  assert.equal(
    (await call('/consumer/me', { headers: { Cookie: `yumi_staff_session=${raw}` } })).status,
    401,
  );
  assert.equal((await call('/consumer/me', { token: raw })).status, 401);
});
test('logout revokes only the current session and replay/forged logout cannot revoke another device', async () => {
  const a = await login(),
    other = await login();
  assert.equal(
    (await call('/consumer/auth/logout', { token: a.token, body: { userId: other.user.id } }))
      .status,
    400,
  );
  assert.equal((await call('/consumer/auth/logout', { token: a.token, body: {} })).status, 200);
  assert.equal((await call('/consumer/me', { token: a.token })).status, 401);
  assert.equal((await call('/consumer/me', { token: other.token })).status, 200);
  assert.equal((await call('/consumer/auth/logout', { token: a.token, body: {} })).status, 401);
});
test('expiry, disable and auth version changes invalidate sessions; disabled identities cannot log in', async () => {
  let a = await login();
  await db.consumerSession.update({
    where: { tokenHash: tokenHash(a.token) },
    data: { createdAt: new Date(Date.now() - 120000), expiresAt: new Date(Date.now() - 60000) },
  });
  assert.equal((await call('/consumer/me', { token: a.token })).status, 401);
  a = await login();
  await db.consumerUser.update({ where: { id: a.user.id }, data: { enabled: false } });
  assert.equal((await call('/consumer/me', { token: a.token })).status, 401);
  assert.equal(
    (await call('/consumer/auth/dev-session', { body: { profile: 'customer-a' } })).status,
    401,
  );
  await db.consumerUser.update({
    where: { id: a.user.id },
    data: { enabled: true, authVersion: { increment: 1 } },
  });
  assert.equal((await call('/consumer/me', { token: a.token })).status, 401);
});
test('concurrent first identity login yields one user and independent sessions across application instances', async () => {
  const second = await createApplication(url.toString(), {
    config,
    accessLog: (e) => logs.push(e),
  });
  try {
    await second.app.listen(0, '127.0.0.1');
    const target = await second.app.getUrl();
    // Remove only this test identity after prior sessions; a fresh subject exercises the upsert race.
    const b = await db.consumerUser.findUnique({
      where: { provider_subject: { provider: 'DEVELOPMENT', subject: 'customer-b' } },
    });
    if (b) {
      await db.consumerAuthAudit.deleteMany({ where: { userId: b.id } });
      await db.consumerSession.deleteMany({ where: { userId: b.id } });
      await db.consumerUser.delete({ where: { id: b.id } });
    }
    const [one, two] = await Promise.all([login('customer-b'), login('customer-b', target)]);
    assert.equal(one.user.id, two.user.id);
    assert.notEqual(one.token, two.token);
    assert.equal((await call('/consumer/me', { token: one.token }, target)).status, 200);
    assert.equal(
      (await call('/consumer/auth/logout', { token: one.token, body: {} }, target)).status,
      200,
    );
    assert.equal((await call('/consumer/me', { token: one.token })).status, 401);
    const disabled = await createApplication(url.toString(), {
      config: applicationConfig({ NODE_ENV: 'test' }),
      accessLog: () => {},
    });
    try {
      await disabled.app.listen(0, '127.0.0.1');
      assert.equal(
        (await call('/consumer/me', { token: two.token }, await disabled.app.getUrl())).status,
        401,
      );
    } finally {
      await disabled.close();
    }
  } finally {
    await second.close();
  }
});
test('database audit and API documentation are minimal; no raw token appears in access logs', async () => {
  assert.ok(
    await db.consumerAuthAudit.count({ where: { action: 'DEV_LOGIN', outcome: 'SUCCEEDED' } }),
  );
  assert.ok(
    await db.consumerAuthAudit.count({ where: { action: 'DEV_LOGIN', outcome: 'DENIED' } }),
  );
  assert.ok(await db.consumerAuthAudit.count({ where: { action: 'LOGOUT' } }));
  for (const token of tokens) assert.equal(JSON.stringify(logs).includes(token), false);
  const spec = await (await fetch(base + '/api/v1/openapi.json')).json();
  assert.ok(spec.paths['/api/v1/consumer/auth/dev-session']);
  assert.ok(spec.paths['/api/v1/consumer/me'].get.security[0].consumerSession);
  assert.equal(spec.paths['/api/v1/auth/wechat/session'], undefined);
});
test('login throttle persists across instances and never creates a session after exhaustion', async () => {
  const key = tokenHash('consumer-dev-ip:127.0.0.1');
  await db.consumerLoginThrottle.upsert({
    where: { key },
    create: { key, attemptCount: 30, windowStartedAt: new Date() },
    update: { attemptCount: 30, windowStartedAt: new Date() },
  });
  const count = await db.consumerSession.count();
  assert.equal(
    (await call('/consumer/auth/dev-session', { body: { profile: 'customer-a' } })).status,
    429,
  );
  const second = await createApplication(url.toString(), { config, accessLog: () => {} });
  try {
    await second.app.listen(0, '127.0.0.1');
    assert.equal(
      (
        await call(
          '/consumer/auth/dev-session',
          { body: { profile: 'customer-a' } },
          await second.app.getUrl(),
        )
      ).status,
      429,
    );
  } finally {
    await second.close();
  }
  assert.equal(await db.consumerSession.count(), count);
});
