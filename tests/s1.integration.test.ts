import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createDatabase, hashPassword } from '../packages/database/src/index.ts';
import { createApplication } from '../apps/api/dist/app.js';
import type { AccessEvent } from '../apps/api/dist/app.js';
import { applicationConfig } from '../apps/api/dist/config.js';
import type { StaffProfile } from '../packages/contracts/src/index.ts';

const url = new URL(process.env.TEST_DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname != '/yumi_test')
  throw new Error('S1 only permits the isolated local test database.');
const db = createDatabase(url.toString());
const password = randomBytes(18).toString('hex');
const run = randomUUID().replaceAll('-', '');
const staffIds = [randomUUID(), randomUUID(), randomUUID()];
const warehouseIds = [randomUUID(), randomUUID()];
const names = [`owner.${run}`, `store.${run}`, `rider.${run}`];
const requestIds: string[] = [];
const logs: AccessEvent[] = [];
const checks: string[] = [];
const config = applicationConfig({ ...process.env, NODE_ENV: 'test' });
let runtime: Awaited<ReturnType<typeof createApplication>>;
let base: string;
type Envelope<T> = { data: T; error?: { code: string; message: string }; requestId: string };
async function call<T = Record<string, unknown>>(
  path: string,
  init: RequestInit = {},
  target = base,
) {
  const headers = new Headers(init.headers);
  if (!headers.has('origin')) headers.set('origin', 'http://127.0.0.1:5173');
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  const response = await fetch(`${target}/api/v1${path}`, { ...init, headers });
  const requestId = response.headers.get('x-request-id');
  if (requestId) requestIds.push(requestId);
  const body = (await response.json()) as Envelope<T>;
  return { response, body };
}
async function login(index = 0) {
  const result = await call('/staff/auth/session', {
    method: 'POST',
    body: JSON.stringify({ loginName: names[index], password }),
  });
  assert.equal(result.response.status, 200);
  const cookie = result.response.headers.get('set-cookie')?.split(';')[0];
  assert.ok(cookie);
  return cookie;
}
async function me(cookie: string) {
  return call<StaffProfile>('/staff/me', { headers: { cookie } });
}

before(async () => {
  const passwordHash = await hashPassword(password);
  await db.warehouse.createMany({
    data: warehouseIds.map((id, i) => ({ id, code: `s1-${run}-${i}`, name: `隔离测试仓${i}` })),
  });
  for (const [i, id] of staffIds.entries()) {
    await db.staff.create({
      data: {
        id,
        loginName: names[i]!,
        displayName: `S1测试员工${i}`,
        passwordHash,
        roles: { create: { roleCode: ['SUPER_ADMIN', 'WAREHOUSE_MANAGER', 'RIDER'][i]! } },
        warehouses: { create: { warehouseId: warehouseIds[0]! } },
      },
    });
  }
  runtime = await createApplication(url.toString(), {
    config,
    accessLog: (event) => logs.push(event),
  });
  await runtime.app.listen(0, '127.0.0.1');
  base = await runtime.app.getUrl();
});
after(async () => {
  try {
    if (runtime) await runtime.close();
    await db.authAuditEvent.deleteMany({
      where: { OR: [{ actorId: { in: staffIds } }, { requestId: { in: requestIds } }] },
    });
    await db.staffSession.deleteMany({ where: { staffId: { in: staffIds } } });
    await db.staffRole.deleteMany({ where: { staffId: { in: staffIds } } });
    await db.staffWarehouse.deleteMany({ where: { staffId: { in: staffIds } } });
    await db.staff.deleteMany({ where: { id: { in: staffIds } } });
    await db.warehouseLocation.deleteMany({ where: { warehouseId: { in: warehouseIds } } });
    await db.warehouse.deleteMany({ where: { id: { in: warehouseIds } } });
    const hash = (value: string) => createHash('sha256').update(value).digest('hex');
    const throttleKeys = [
      hash('ip:127.0.0.1'),
      ...names.map((name) => hash(`login:${name}:127.0.0.1`)),
      hash(`login:unknown.${run}:127.0.0.1`),
      hash(`login:limited.${run}:127.0.0.1`),
    ];
    await db.staffLoginThrottle.deleteMany({ where: { key: { in: throttleKeys } } });
    await mkdir('.local', { recursive: true });
    await writeFile(
      '.local/s1-results.json',
      JSON.stringify(
        { finishedAt: new Date().toISOString(), checks, logEvents: logs.length },
        null,
        2,
      ) + '\n',
    );
  } finally {
    await db.$disconnect();
  }
});

test('anonymous requests and malformed bodies use request-correlated errors', async () => {
  const result = await call('/staff/me');
  assert.equal(result.response.status, 401);
  assert.equal(result.body.error?.code, 'AUTH_REQUIRED');
  assert.equal(result.body.requestId, result.response.headers.get('x-request-id'));
  const invalid = await call('/staff/auth/session', { method: 'POST', body: '{invalid' });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.requestId, invalid.response.headers.get('x-request-id'));
  const extra = await call('/staff/auth/session', {
    method: 'POST',
    body: JSON.stringify({ loginName: names[0], password, roles: ['SUPER_ADMIN'] }),
  });
  assert.equal(extra.response.status, 400);
  const missing = await call('/not-a-route');
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.error?.code, 'RESOURCE_NOT_FOUND');
  checks.push('uniform errors and strict input');
});
test('wrong password and unknown account return the same denial without a session', async () => {
  for (const loginName of [names[0], `unknown.${run}`]) {
    const result = await call('/staff/auth/session', {
      method: 'POST',
      body: JSON.stringify({ loginName, password: 'incorrect' }),
    });
    assert.equal(result.response.status, 401);
    assert.equal(result.body.error?.code, 'INVALID_CREDENTIALS');
    assert.equal(result.response.headers.get('set-cookie'), null);
  }
  checks.push('credential rejection');
});
test('login sets HttpOnly cookie, stores only token hash and returns bounded profile', async () => {
  const result = await call('/staff/auth/session', {
    method: 'POST',
    body: JSON.stringify({ loginName: names[0]!.toUpperCase(), password }),
  });
  assert.equal(result.response.status, 200);
  const raw = result.response.headers.get('set-cookie')!;
  assert.match(raw, /HttpOnly/);
  assert.match(raw, /SameSite=Strict/);
  assert.match(raw, /Path=\/api\/v1/);
  const cookie = raw.split(';')[0]!;
  const token = cookie.split('=')[1]!;
  const stored = await db.staffSession.findUnique({
    where: { tokenHash: createHash('sha256').update(token).digest('hex') },
  });
  assert.ok(stored);
  assert.equal(stored.tokenHash === token, false);
  const profile = await me(cookie);
  assert.equal(profile.response.status, 200);
  assert.equal(profile.body.data.id, staffIds[0]);
  assert.deepEqual(profile.body.data.warehouseIds, [warehouseIds[0]]);
  assert.ok(profile.body.data.csrfToken);
  assert.equal(JSON.stringify(profile.body).includes('passwordHash'), false);
  assert.equal(JSON.stringify(profile.body).includes(token), false);
  checks.push('opaque persistent sessions and minimal profile');
});
test('CSRF and Origin checks protect logout; valid logout revokes the cookie', async () => {
  const cookie = await login();
  const profile = (await me(cookie)).body.data;
  const noCsrf = await call('/staff/auth/logout', { method: 'POST', headers: { cookie } });
  assert.equal(noCsrf.response.status, 403);
  const evil = await call('/staff/auth/logout', {
    method: 'POST',
    headers: { cookie, origin: 'https://untrusted.invalid', 'x-csrf-token': profile.csrfToken },
  });
  assert.equal(evil.response.status, 403);
  assert.equal((await me(cookie)).response.status, 200);
  const good = await call('/staff/auth/logout', {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': profile.csrfToken },
  });
  assert.equal(good.response.status, 200);
  assert.match(good.response.headers.get('set-cookie')!, /Max-Age=0/);
  assert.equal((await me(cookie)).response.status, 401);
  checks.push('CSRF origin and logout revocation');
});
test('login rejects absent or untrusted Origin', async () => {
  for (const origin of ['', 'https://untrusted.invalid']) {
    const result = await call('/staff/auth/session', {
      method: 'POST',
      headers: { origin },
      body: JSON.stringify({ loginName: names[0], password }),
    });
    assert.equal(result.response.status, 403);
  }
  checks.push('login origin check');
});
test('permissions and warehouse scope reject cross-warehouse and rider access', async () => {
  const cookie = await login(1);
  const list = await call<{ items: { id: string }[] }>(
    '/warehouse/warehouses?warehouseId=' + warehouseIds[1],
    { headers: { cookie } },
  );
  assert.equal(list.response.status, 200);
  assert.deepEqual(
    list.body.data.items.map((item) => item.id),
    [warehouseIds[0]],
  );
  assert.equal(
    (await call('/warehouse/warehouses/' + warehouseIds[0], { headers: { cookie } })).response
      .status,
    200,
  );
  assert.equal(
    (await call('/warehouse/warehouses/' + warehouseIds[1], { headers: { cookie } })).response
      .status,
    403,
  );
  assert.equal((await call('/admin/staff', { headers: { cookie } })).response.status, 403);
  assert.equal(
    (await call('/warehouse/warehouses', { headers: { cookie: await login(2) } })).response.status,
    403,
  );
  const admin = await call('/admin/staff', { headers: { cookie: await login() } });
  assert.equal(admin.response.status, 200);
  assert.equal(JSON.stringify(admin.body).includes('passwordHash'), false);
  checks.push('role permissions and warehouse scope');
});
test('expiry, staff disable and authVersion changes invalidate existing sessions', async () => {
  let cookie = await login();
  await db.staffSession.updateMany({
    where: { staffId: staffIds[0] },
    data: { createdAt: new Date(Date.now() - 7200000), expiresAt: new Date(Date.now() - 3600000) },
  });
  assert.equal((await me(cookie)).response.status, 401);
  cookie = await login(1);
  await db.staff.update({ where: { id: staffIds[1] }, data: { enabled: false } });
  assert.equal((await me(cookie)).response.status, 401);
  await db.staff.update({
    where: { id: staffIds[1] },
    data: { enabled: true, authVersion: { increment: 1 } },
  });
  assert.equal((await me(cookie)).response.status, 401);
  checks.push('expiry disable and version revocation');
});
test('role and warehouse permissions are reloaded from the database per request', async () => {
  const cookie = await login(1);
  await db.staffWarehouse.deleteMany({ where: { staffId: staffIds[1] } });
  assert.equal(
    (await call('/warehouse/warehouses/' + warehouseIds[0], { headers: { cookie } })).response
      .status,
    403,
  );
  await db.staffWarehouse.create({
    data: { staffId: staffIds[1]!, warehouseId: warehouseIds[0]! },
  });
  await db.staffRole.deleteMany({ where: { staffId: staffIds[1] } });
  assert.equal((await call('/warehouse/warehouses', { headers: { cookie } })).response.status, 403);
  await db.staffRole.create({ data: { staffId: staffIds[1]!, roleCode: 'WAREHOUSE_MANAGER' } });
  checks.push('permission changes take effect immediately');
});
test('sessions remain usable on a second application instance', async () => {
  const cookie = await login();
  const second = await createApplication(url.toString(), {
    config,
    accessLog: (event) => logs.push(event),
  });
  try {
    await second.app.listen(0, '127.0.0.1');
    const result = await call('/staff/me', { headers: { cookie } }, await second.app.getUrl());
    assert.equal(result.response.status, 200);
  } finally {
    await second.close();
  }
  checks.push('database-backed multi-instance session');
});
test('login throttling persists across application instances', async () => {
  const payload = JSON.stringify({ loginName: `limited.${run}`, password: 'incorrect' });
  for (let i = 0; i < 10; i++)
    assert.equal(
      (await call('/staff/auth/session', { method: 'POST', body: payload })).response.status,
      401,
    );
  assert.equal(
    (await call('/staff/auth/session', { method: 'POST', body: payload })).response.status,
    429,
  );
  const second = await createApplication(url.toString(), {
    config,
    accessLog: (event) => logs.push(event),
  });
  try {
    await second.app.listen(0, '127.0.0.1');
    assert.equal(
      (
        await call(
          '/staff/auth/session',
          { method: 'POST', body: payload },
          await second.app.getUrl(),
        )
      ).response.status,
      429,
    );
  } finally {
    await second.close();
  }
  checks.push('persistent login throttling');
});
test('Swagger describes implemented routes and production requires HTTPS origins', async () => {
  const spec = await fetch(base + '/api/v1/openapi.json');
  assert.equal(spec.status, 200);
  const document = await spec.json();
  assert.ok(document.paths['/api/v1/staff/auth/session']);
  assert.equal(
    document.paths['/api/v1/staff/me'].get.responses['200'].content['application/json'].schema
      .properties.data.properties.csrfToken.type,
    'string',
  );
  assert.ok(document.paths['/api/v1/warehouse/warehouses/{warehouseId}']);
  assert.equal(document.paths['/api/v1/orders'], undefined);
  assert.equal((await fetch(base + '/api/v1/docs')).status, 200);
  assert.throws(() => applicationConfig({ NODE_ENV: 'production' }));
  assert.throws(() =>
    applicationConfig({ NODE_ENV: 'production', STAFF_ALLOWED_ORIGINS: 'http://example.invalid' }),
  );
  const production = applicationConfig({
    NODE_ENV: 'production',
    STAFF_ALLOWED_ORIGINS: 'https://example.invalid',
  });
  assert.equal(production.docsEnabled, false);
  const secured = await createApplication(url.toString(), {
    config: production,
    accessLog: (event) => logs.push(event),
  });
  try {
    await secured.app.listen(0, '127.0.0.1');
    const target = await secured.app.getUrl();
    assert.equal((await fetch(target + '/api/v1/docs')).status, 404);
    assert.equal((await fetch(target + '/api/v1/openapi.json')).status, 404);
    const result = await call(
      '/staff/auth/session',
      {
        method: 'POST',
        headers: { origin: 'https://example.invalid' },
        body: JSON.stringify({ loginName: names[0], password }),
      },
      target,
    );
    assert.equal(result.response.status, 200);
    assert.match(result.response.headers.get('set-cookie') ?? '', /; Secure/);
  } finally {
    await secured.close();
  }
  checks.push('implemented API specification and production configuration');
});
test('auth audit exists and access logs never contain credentials or raw cookies', async () => {
  assert.ok(
    await db.authAuditEvent.count({
      where: { actorId: { in: staffIds }, action: 'STAFF_LOGIN', outcome: 'SUCCEEDED' },
    }),
  );
  assert.ok(
    await db.authAuditEvent.count({
      where: { actorId: { in: staffIds }, action: 'STAFF_LOGOUT', outcome: 'SUCCEEDED' },
    }),
  );
  assert.equal(JSON.stringify(logs).includes(password), false);
  assert.equal(JSON.stringify(logs).includes('yumi_staff_session='), false);
  assert.ok(
    logs.every(
      (event) => Object.keys(event).sort().join(',') === 'durationMs,method,requestId,route,status',
    ),
  );
  checks.push('audit and redacted access logging');
});
