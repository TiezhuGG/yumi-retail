import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { createDatabase, hashPassword } from '../packages/database/src/index.ts';
import { createApplication } from '../apps/api/dist/app.js';
import { applicationConfig } from '../apps/api/dist/config.js';
import type { StaffProfile } from '../packages/contracts/src/index.ts';
const url = new URL(process.env.TEST_DATABASE_URL ?? '');
if (
  !['127.0.0.1', 'localhost'].includes(url.hostname) ||
  url.pathname !== '/yumi_test' ||
  url.searchParams.has('schema')
)
  throw Error('Disposable local test schema only');
const schema = 'points_' + randomUUID().replaceAll('-', '');
const { Client } = createRequire(import.meta.url)('pg');
const admin = new Client({ connectionString: url.toString() });
url.searchParams.set('schema', schema);
const db = createDatabase(url.toString()),
  warehouseId = randomUUID(),
  otherWarehouse = randomUUID();
const password = randomBytes(24).toString('hex'),
  staffIds = Array.from({ length: 5 }, () => randomUUID());
const sessions: Array<{ cookie: string; csrf: string }> = [];
let runtime: Awaited<ReturnType<typeof createApplication>>, base: string;
async function call(
  path: string,
  body?: unknown,
  actor = 0,
  key = randomUUID(),
  headers: Record<string, string> = {},
) {
  const response = await fetch(base + '/api/v1' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: 'http://127.0.0.1:5173',
      'Content-Type': 'application/json',
      ...(sessions[actor]
        ? { Cookie: sessions[actor]!.cookie, 'X-CSRF-Token': sessions[actor]!.csrf }
        : {}),
      'Idempotency-Key': key,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    cookie: response.headers.get('set-cookie'),
    ...((await response.json()) as {
      data: { items: Array<{ id: string; name: string }> };
      error?: { code: string };
    }),
  };
}
before(async () => {
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query("SELECT set_config('search_path',$1,false)", [schema]);
  for (const dir of (await readdir('packages/database/prisma/migrations'))
    .filter((n) => /^\d/.test(n))
    .sort())
    await admin.query(
      await readFile(`packages/database/prisma/migrations/${dir}/migration.sql`, 'utf8'),
    );
  await db.warehouse.createMany({
    data: [
      { id: warehouseId, code: 'AREA', name: '隔离测试仓' },
      { id: otherWarehouse, code: 'OTHER', name: '其他测试仓' },
    ],
  });
  const passwordHash = await hashPassword(password);
  for (const [i, id] of staffIds.entries())
    await db.staff.create({
      data: {
        id,
        loginName: 'area' + i,
        displayName: '范围测试员工',
        passwordHash,
        roles: {
          create: {
            roleCode: ['SUPER_ADMIN', 'OPERATIONS', 'WAREHOUSE_MANAGER', 'RIDER', 'OPERATIONS'][i]!,
          },
        },
        warehouses: { create: { warehouseId: i === 4 ? otherWarehouse : warehouseId } },
      },
    });
  runtime = await createApplication(url.toString(), {
    config: applicationConfig({
      NODE_ENV: 'test',
      PUBLIC_WAREHOUSE_ID: warehouseId,
      CONSUMER_DEV_LOGIN_ENABLED: '1',
    }),
    accessLog: () => {},
  });
  await runtime.app.listen(0, '127.0.0.1');
  base = await runtime.app.getUrl();
  for (let i = 0; i < 5; i++) {
    const login = await call('/staff/auth/session', { loginName: 'area' + i, password }, -1);
    assert.equal(login.status, 200);
    sessions[i] = { cookie: login.cookie!.split(';')[0]!, csrf: '' };
    const me = await call('/staff/me', undefined, i);
    sessions[i]!.csrf = (me.data as unknown as StaffProfile).csrfToken;
  }
});
after(async () => {
  try {
    if (runtime) await runtime.close();
    await db.$disconnect();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await admin.end();
  }
});

test('points authentication, role and warehouse isolation', async () => {
  assert.equal((await call('/consumer/points')).status, 401);
  assert.equal((await call('/admin/points/accounts', undefined, -1)).status, 401);
  for (const i of [2, 3, 4])
    assert.equal((await call('/admin/points/accounts', undefined, i)).status, 403);
  assert.equal((await call('/admin/points/accounts?userId=' + randomUUID())).status, 400);
});
test('new account is zero, consumer ownership and strict queries', async () => {
  const login = await call(
    '/consumer/auth/dev-session',
    { profile: 'customer-a' },
    -1,
    randomUUID(),
    { 'X-Yumi-Dev-Login': '1' },
  );
  assert.equal(login.status, 200, JSON.stringify(login));
  const token = (login.data as unknown as { token: string }).token;
  const headers = { Authorization: 'Bearer ' + token };
  const r = await call('/consumer/points', undefined, -1, randomUUID(), headers);
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal((r.data as unknown as { balance: string }).balance, '0');
  assert.equal(
    (await call('/consumer/points?userId=' + randomUUID(), undefined, -1, randomUUID(), headers))
      .status,
    400,
  );
  const ledger = await call('/consumer/points/ledger', undefined, -1, randomUUID(), headers);
  assert.deepEqual(ledger.data.items, []);
  assert.equal(
    (await call('/consumer/points/ledger?cursor=bad', undefined, -1, randomUUID(), headers)).status,
    400,
  );
});
test('database rejects unbalanced writes and immutable ledger edits', async () => {
  const user = await db.consumerUser.findFirstOrThrow();
  await db.$executeRaw`INSERT INTO points_accounts(user_id) VALUES(${user.id}::uuid)`;
  await assert.rejects(
    db.$executeRaw`UPDATE points_accounts SET balance=5 WHERE user_id=${user.id}::uuid`,
  );
  const id = randomUUID();
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`UPDATE points_accounts SET balance=50 WHERE user_id=${user.id}::uuid`;
    await tx.$executeRaw`INSERT INTO points_ledger(id,user_id,delta,action_key,reason,actor_id) VALUES(${id}::uuid,${user.id}::uuid,50,'fixture-1','合成测试',${staffIds[0]}::uuid)`;
  });
  await assert.rejects(db.$executeRaw`DELETE FROM points_ledger WHERE id=${id}::uuid`);
  await assert.rejects(db.$executeRaw`UPDATE points_ledger SET delta=51 WHERE id=${id}::uuid`);
  await assert.rejects(
    db.$executeRaw`INSERT INTO points_ledger(id,user_id,delta,action_key,reason,actor_id) VALUES(${randomUUID()}::uuid,${user.id}::uuid,50,'fixture-1','合成测试',${staffIds[0]}::uuid)`,
  );
  const r = await call('/admin/points/accounts/' + user.id + '/ledger');
  assert.equal(r.status, 200);
  assert.equal(r.data.items.length, 1);
});

test('grant budget, independent approval, idempotency and concurrent spending', async () => {
  const user = await db.consumerUser.findFirstOrThrow();
  const prefix = '/admin/points/grants/';
  const create = async (amount: string, actor = 1) => {
    const r = await call(
      prefix + 'store/create',
      { userId: user.id, amount, reason: '合成发放申请', reference: 'TEST-ONLY' },
      actor,
    );
    assert.equal(r.status, 200, JSON.stringify(r));
    return (r.data as unknown as { id: string }).id;
  };
  assert.equal(
    (
      await call(
        prefix + 'store/policy',
        { version: 0, enabled: true, singleLimit: '100', dailyLimit: '100', reason: '合成规则' },
        1,
      )
    ).status,
    403,
  );
  const first = await create('40');
  assert.equal(
    (await call(prefix + first + '/approve', { version: 0, reason: '核验依据' }, 0)).status,
    409,
  );
  assert.equal(
    (
      await call(
        prefix + 'store/policy',
        { version: 0, enabled: true, singleLimit: '100', dailyLimit: '100', reason: '合成规则' },
        0,
      )
    ).status,
    200,
  );
  const self = await create('1', 0);
  assert.equal(
    (await call(prefix + self + '/approve', { version: 0, reason: '不能自审' }, 0)).status,
    403,
  );
  const k = randomUUID();
  const a = await Promise.all([
    call(prefix + first + '/approve', { version: 0, reason: '凭据核验通过' }, 0, k),
    call(prefix + first + '/approve', { version: 0, reason: '凭据核验通过' }, 0, k),
  ]);
  assert.deepEqual(
    a.map((x) => x.status),
    [200, 200],
  );
  assert.equal(
    (await call(prefix + first + '/approve', { version: 0, reason: '不同内容' }, 0, k)).status,
    409,
  );
  const second = await create('40'),
    third = await create('40');
  const rs = await Promise.all([
    call(prefix + second + '/approve', { version: 0, reason: '合成审批' }, 0),
    call(prefix + third + '/approve', { version: 0, reason: '合成审批' }, 0),
  ]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  const rejected = await create('10');
  assert.equal(
    (await call(prefix + rejected + '/reject', { version: 0, reason: '凭据不符' }, 0)).status,
    200,
  );
  assert.equal(
    (await call(prefix + rejected + '/approve', { version: 1, reason: '终态不能再批' }, 0)).status,
    409,
  );
  const canceled = await create('10');
  assert.equal(
    (await call(prefix + canceled + '/cancel', { version: 0, reason: '本人撤销' }, 0)).status,
    403,
  );
  assert.equal(
    (await call(prefix + canceled + '/cancel', { version: 0, reason: '本人撤销' }, 1)).status,
    200,
  );
  const evidence = await db.$queryRaw<
    Array<{ count: bigint }>
  >`SELECT COUNT(*)::bigint AS count FROM points_ledger WHERE action_key LIKE 'GRANT:%'`;
  assert.equal(evidence[0]!.count, 2n);
});
test('grant audit late failure rolls back balance, ledger, budget and intent', async () => {
  const user = await db.consumerUser.findFirstOrThrow();
  const r = await call(
    '/admin/points/grants/store/create',
    { userId: user.id, amount: '10', reason: '回滚夹具', reference: 'ROLLBACK' },
    1,
  );
  assert.equal(r.status, 200);
  const id = (r.data as unknown as { id: string }).id,
    k = randomUUID();
  await admin.query(
    `CREATE FUNCTION fail_grant_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='POINTS_APPROVE' THEN RAISE EXCEPTION 'synthetic late failure'; END IF; RETURN NEW; END $$`,
  );
  await admin.query(
    'CREATE TRIGGER fail_grant_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_grant_audit()',
  );
  assert.equal(
    (
      await call(
        '/admin/points/grants/' + id + '/approve',
        { version: 0, reason: '回滚测试' },
        0,
        k,
      )
    ).status,
    500,
  );
  assert.equal(
    (
      await db.$queryRaw<
        Array<{ status: string }>
      >`SELECT status FROM points_grants WHERE id=${id}::uuid`
    )[0]!.status,
    'SUBMITTED',
  );
  assert.equal(
    (
      await db.$queryRaw<
        Array<{ n: bigint }>
      >`SELECT COUNT(*)::bigint AS n FROM points_ledger WHERE action_key=${'GRANT:' + id}`
    )[0]!.n,
    0n,
  );
  await admin.query('DROP TRIGGER fail_grant_audit ON business_audits');
  assert.equal(
    (
      await call(
        '/admin/points/grants/' + id + '/approve',
        { version: 0, reason: '回滚测试' },
        0,
        k,
      )
    ).status,
    200,
  );
});

test('grant writes require CSRF and current role; finalized facts cannot be rewritten', async () => {
  const user = await db.consumerUser.findFirstOrThrow();
  assert.equal(
    (
      await call(
        '/admin/points/grants/store/create',
        { userId: user.id, amount: '1', reason: '安全测试', reference: 'TEST' },
        1,
        randomUUID(),
        { 'X-CSRF-Token': '' },
      )
    ).status,
    403,
  );
  await db.staffRole.deleteMany({ where: { staffId: staffIds[1]!, roleCode: 'OPERATIONS' } });
  assert.equal((await call('/admin/points/grants', undefined, 1)).status, 403);
  await db.staffRole.create({ data: { staffId: staffIds[1]!, roleCode: 'OPERATIONS' } });
  const final = await db.$queryRaw<
    Array<{ id: string }>
  >`SELECT id FROM points_grants WHERE status='APPROVED' LIMIT 1`;
  await assert.rejects(
    db.$executeRaw`UPDATE points_grants SET amount=amount+1 WHERE id=${final[0]!.id}::uuid`,
  );
  await assert.rejects(db.$executeRaw`DELETE FROM points_grants WHERE id=${final[0]!.id}::uuid`);
});
