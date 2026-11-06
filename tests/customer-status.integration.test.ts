import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expressShippingFixture } from './helpers/express-shipping-fixture.ts';
import type { CustomerStatusHistory } from '../packages/contracts/src/index.ts';
let f: Awaited<ReturnType<typeof expressShippingFixture>>,
  initialOrder: string,
  originalToken: string;
before(async () => {
  f = await expressShippingFixture();
  initialOrder = await f.createExpress();
  originalToken = f.identity.token;
});
after(async () => {
  await f?.cleanup();
});
const statusPath = (action: string, id = f.identity.user.id) =>
  '/admin/customers/' + id + '/status/' + action;
const version = async () =>
  (await f.runtime.db.consumerUser.findUniqueOrThrow({ where: { id: f.identity.user.id } }))
    .authVersion;
const change = async (action: string, k = randomUUID(), v?: number) =>
  f.api(
    statusPath(action),
    { version: v ?? (await version()), reason: '合成账号状态核对', confirmed: true },
    k,
  );
async function history(query = '', id = f.identity.user.id) {
  const r = await f.api('/admin/customers/' + id + '/status-history' + query);
  assert.equal(r.status, 200);
  return r.data as unknown as CustomerStatusHistory;
}
async function login() {
  const r = await fetch(f.base + '/api/v1/consumer/auth/dev-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Yumi-Dev-Login': '1' },
    body: JSON.stringify({ profile: 'customer-a' }),
  });
  return { status: r.status, ...(await r.json()) };
}
async function state() {
  const db = f.runtime.db;
  return JSON.stringify(
    [
      await db.pointsAccount.findMany(),
      await db.pointsEntry.findMany(),
      await db.redemptionOrder.findMany(),
      await db.redemptionAllocation.findMany(),
      await db.stockBalance.findMany(),
      await db.consumerWechatPayer.findMany(),
    ],
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
  );
}
test('disable/restore is one audited state transition, old sessions never resurrect and stock, points and orders remain unchanged', async () => {
  const before = await state(),
    k = randomUUID(),
    v = await version();
  const [a, b] = await Promise.all([change('disable', k, v), change('disable', k, v)]);
  assert.equal(a.status, 200);
  assert.deepEqual(a.data, b.data);
  assert.equal(await version(), v + 1);
  assert.equal((await history()).items.length, 1);
  assert.equal((await f.call('/consumer/me')).status, 401);
  assert.equal((await login()).status, 401);
  assert.equal(
    (await f.call('/consumer/redemptions/' + initialOrder + '/cancel', { version: 0 })).status,
    401,
  );
  assert.equal(
    (
      await f.api('/admin/points/grants/store/create', {
        userId: f.identity.user.id,
        amount: '1',
        reason: '合成停用测试',
        reference: 'STATUS',
      })
    ).status,
    409,
  );
  assert.equal((await change('enable')).status, 200);
  assert.equal((await f.call('/consumer/me', undefined, undefined, originalToken)).status, 401);
  const fresh = await login();
  assert.equal(fresh.status, 200);
  f.identity.token = fresh.data.token;
  assert.equal((await f.call('/consumer/me')).status, 200);
  assert.equal(await state(), before);
  const h = await history();
  assert.deepEqual(
    h.items.map((x) => x.action),
    ['CUSTOMER_ENABLED', 'CUSTOMER_DISABLED'],
  );
  assert.ok(
    h.items.every((x) => x.actorName === '合成积分验收员' && x.reason === '合成账号状态核对'),
  );
  assert.equal((await f.api('/admin/customers/' + f.identity.user.id)).status, 200);
});
test('stale/opposite and altered same-key requests cannot overwrite newer status; replay describes original action only', async () => {
  const v = await version(),
    k = randomUUID(),
    body = { version: v, reason: '合成原请求', confirmed: true };
  assert.equal((await f.api(statusPath('disable'), body, k)).status, 200);
  assert.equal((await change('enable')).status, 200);
  assert.equal((await f.api(statusPath('disable'), body, k)).status, 200);
  assert.equal(
    (await f.runtime.db.consumerUser.findUniqueOrThrow({ where: { id: f.identity.user.id } }))
      .enabled,
    true,
  );
  assert.equal(
    (await f.api(statusPath('disable'), { ...body, reason: '变更原因' }, k)).status,
    409,
  );
  assert.equal((await change('disable', randomUUID(), v)).status, 409);
  assert.equal((await change('enable')).status, 409);
  const fresh = await login();
  assert.equal(fresh.status, 200);
  f.identity.token = fresh.data.token;
});
test('audit failure rolls back identity version and idempotency; original key recovers, evidence remains append-only', async () => {
  const db = f.runtime.db,
    schema = (await db.$queryRaw<Array<{ schema: string }>>`SELECT current_schema() AS schema`)[0]!
      .schema;
  assert.ok(schema.startsWith('address_ui_'));
  const v = await version(),
    k = randomUUID(),
    before = (await history()).items.length;
  await db.$executeRawUnsafe(
    "CREATE FUNCTION fail_customer_status() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='CUSTOMER_DISABLED' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$",
  );
  await db.$executeRawUnsafe(
    'CREATE TRIGGER fail_customer_status BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_customer_status()',
  );
  try {
    assert.equal((await change('disable', k, v)).status, 500);
    assert.equal(await version(), v);
    assert.equal((await history()).items.length, before);
  } finally {
    await db.$executeRawUnsafe('DROP TRIGGER fail_customer_status ON business_audits');
    await db.$executeRawUnsafe('DROP FUNCTION fail_customer_status()');
  }
  assert.equal((await change('disable', k, v)).status, 200);
  const event = (await history()).items[0]!;
  await assert.rejects(
    db.businessAudit.update({ where: { id: event.id }, data: { reason: '不应被改写' } }),
  );
  assert.equal((await change('enable')).status, 200);
  const fresh = await login();
  assert.equal(fresh.status, 200);
  f.identity.token = fresh.data.token;
});
test('concurrent nickname changes and disable serialize without leaving a usable session or changing balances', async () => {
  const before = await state(),
    u = await f.runtime.db.consumerUser.findUniqueOrThrow({ where: { id: f.identity.user.id } });
  const [edit, disabled] = await Promise.all([
    f.call('/consumer/profile/nickname', {
      displayName: '合成账号核对顾客',
      expectedDisplayName: u.displayName,
    }),
    change('disable'),
  ]);
  assert.equal(disabled.status, 200);
  assert.ok([200, 401].includes(edit.status));
  assert.equal((await f.call('/consumer/me')).status, 401);
  assert.equal(await state(), before);
  assert.equal((await change('enable')).status, 200);
  const fresh = await login();
  assert.equal(fresh.status, 200);
  f.identity.token = fresh.data.token;
});
test('disabled customer existing express return can still be handled and refunded by staff', async () => {
  const order = await f.createExpress();
  assert.equal(
    (
      await f.api('/admin/redemptions/' + order + '/ship', {
        version: 0,
        carrierCode: 'SF',
        trackingNo: 'SF-CUSTOMER-STATUS',
        dispatchConfirmed: true,
      })
    ).status,
    200,
  );
  const ret = await f.call('/consumer/redemptions/' + order + '/returns', {
    quantity: 1,
    reason: '合成停用前申请',
  });
  assert.equal(ret.status, 200);
  assert.equal((await change('disable')).status, 200);
  assert.equal(
    (
      await f.api('/admin/redemption-returns/' + ret.data.id + '/approve', {
        requiresReturn: false,
        reason: '合成售后继续办理',
      })
    ).status,
    200,
  );
  const account = await f.runtime.db.pointsAccount.findUniqueOrThrow({
    where: { userId: f.identity.user.id },
  });
  assert.equal(
    (
      await f.api('/admin/redemption-returns/' + ret.data.id + '/refund', {
        confirmed: true,
        reason: '按原积分价退回',
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.runtime.db.pointsAccount.findUniqueOrThrow({ where: { userId: f.identity.user.id } }))
      .balance,
    account.balance + 120n,
  );
  assert.equal(
    (await f.runtime.db.consumerUser.findUniqueOrThrow({ where: { id: f.identity.user.id } }))
      .enabled,
    false,
  );
  assert.equal((await change('enable')).status, 200);
  const fresh = await login();
  assert.equal(fresh.status, 200);
  f.identity.token = fresh.data.token;
});

test('grant approval and disabling serialize at the identity; no credit can slip through an already disabled account', async () => {
  assert.equal(
    (
      await f.api('/admin/points/grants/store/policy', {
        version: 0,
        enabled: true,
        singleLimit: '100',
        dailyLimit: '1000',
        reason: '合成并发预算',
      })
    ).status,
    200,
  );
  const g = await f.api('/admin/points/grants/store/create', {
    userId: f.identity.user.id,
    amount: '5',
    reason: '合成并发发放',
    reference: 'STATUS-RACE',
  });
  assert.equal(g.status, 200);
  const reviewer = await f.reviewer(),
    { data: p } = await (
      await fetch(f.base + '/api/v1/staff/me', { headers: { Cookie: reviewer } })
    ).json(),
    before = await f.runtime.db.pointsAccount.findUniqueOrThrow({
      where: { userId: f.identity.user.id },
    });
  const [approved, disabled] = await Promise.all([
    f.api(
      '/admin/points/grants/' + g.data.id + '/approve',
      { version: 0, reason: '合成并发审批' },
      randomUUID(),
      reviewer,
      p.csrfToken,
    ),
    change('disable'),
  ]);
  assert.equal(disabled.status, 200);
  assert.ok([200, 409].includes(approved.status));
  const after = await f.runtime.db.pointsAccount.findUniqueOrThrow({
    where: { userId: f.identity.user.id },
  });
  assert.equal(after.balance, before.balance + (approved.status === 200 ? 5n : 0n));
  assert.equal(
    (
      await f.api('/admin/points/grants/store/create', {
        userId: f.identity.user.id,
        amount: '1',
        reason: '停用后拒绝',
        reference: 'STATUS-AFTER',
      })
    ).status,
    409,
  );
  assert.equal((await change('enable')).status, 200);
  const fresh = await login();
  assert.equal(fresh.status, 200);
  f.identity.token = fresh.data.token;
});
test('history paginates newest-first, isolates customers, retains actor name, and exposes no identity or session secrets', async () => {
  for (let i = 0; i < 5; i++) {
    assert.equal((await change('disable')).status, 200);
    assert.equal((await change('enable')).status, 200);
  }
  const first = await history();
  assert.equal(first.items.length, 20);
  assert.ok(first.nextCursor);
  const second = await history('?cursor=' + first.nextCursor);
  assert.equal(second.items.length, 2);
  assert.equal(second.nextCursor, null);
  assert.equal(new Set([...first.items, ...second.items].map((x) => x.id)).size, 22);
  assert.equal((await history('', f.identityB.user.id)).items.length, 0);
  assert.equal(
    (
      await f.api(
        '/admin/customers/' + f.identityB.user.id + '/status-history?cursor=' + first.items[0]!.id,
      )
    ).status,
    409,
  );
  const { data: p } = await (
    await fetch(f.base + '/api/v1/staff/me', { headers: { Cookie: f.cookie } })
  ).json();
  await f.runtime.db.staff.update({ where: { id: p.id }, data: { displayName: '合成改名负责人' } });
  assert.equal((await history()).items[0]!.actorName, '合成积分验收员');
  for (const key of [
    'authVersion',
    'token',
    'subject',
    'phone',
    'address',
    'sessionId',
    'actorId',
    'requestId',
  ])
    assert.ok(!JSON.stringify(first).includes(key));
});
test('confirmed dedicated actions require fresh supervisor and warehouse authority, including same-key replays', async () => {
  const good = { version: await version(), reason: '合成权限核对', confirmed: true };
  for (const b of [
    { ...good, confirmed: false },
    { ...good, version: -1 },
    { ...good, reason: '' },
    { ...good, reason: '长'.repeat(201) },
    { ...good, enabled: false },
  ])
    assert.equal((await f.api(statusPath('disable'), b)).status, 400);
  assert.equal((await f.api(statusPath('arbitrary'), good)).status, 404);
  assert.equal((await f.api(statusPath('disable', randomUUID()), good)).status, 404);
  assert.equal((await f.api(statusPath('disable') + '?extra=1', good)).status, 400);
  const headers = {
    Cookie: f.cookie,
    Origin: 'http://127.0.0.1:5188',
    'Content-Type': 'application/json',
    'Idempotency-Key': randomUUID(),
  };
  assert.equal(
    (
      await fetch(f.base + '/api/v1' + statusPath('disable'), {
        method: 'POST',
        headers,
        body: JSON.stringify(good),
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(f.base + '/api/v1' + statusPath('disable'), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + f.identity.token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(good),
      })
    ).status,
    401,
  );
  const k = randomUUID();
  assert.equal((await f.api(statusPath('disable'), good, k)).status, 200);
  const { data: p } = await (
      await fetch(f.base + '/api/v1/staff/me', { headers: { Cookie: f.cookie } })
    ).json(),
    db = f.runtime.db;
  await db.staffRole.updateMany({ where: { staffId: p.id }, data: { roleCode: 'OPERATIONS' } });
  assert.equal((await f.api(statusPath('disable'), good, k)).status, 403);
  assert.equal(
    (await f.api('/admin/customers/' + f.identity.user.id + '/status-history')).status,
    200,
  );
  await db.staffRole.updateMany({
    where: { staffId: p.id },
    data: { roleCode: 'WAREHOUSE_MANAGER' },
  });
  assert.equal(
    (await f.api('/admin/customers/' + f.identity.user.id + '/status-history')).status,
    403,
  );
  await db.staffRole.updateMany({ where: { staffId: p.id }, data: { roleCode: 'SUPER_ADMIN' } });
  await db.staffWarehouse.deleteMany({ where: { staffId: p.id, warehouseId: f.warehouseId } });
  assert.equal((await f.api(statusPath('disable'), good, k)).status, 403);
  assert.equal(
    (await f.api('/admin/customers/' + f.identity.user.id + '/status-history')).status,
    403,
  );
});
test('protocol WeChat login cannot bypass disabled identity and restore requires a newly exchanged code', async () => {
  const { addressFixture } = await import('./helpers/address-fixture.ts');
  const { hashPassword } = await import('../packages/database/dist/index.js');
  const { randomBytes } = await import('node:crypto');
  const w = await addressFixture({
    wechatExchange: async () => ({ openid: 'synthetic-status-wechat-openid-001' }),
  });
  try {
    const password = randomBytes(24).toString('hex');
    await w.runtime.db.staff.create({
      data: {
        id: randomUUID(),
        loginName: 'status-wechat-admin',
        displayName: '合成微信核对负责人',
        passwordHash: await hashPassword(password),
        roles: { create: { roleCode: 'SUPER_ADMIN' } },
        warehouses: { create: { warehouseId: w.warehouseId } },
      },
    });
    const loginStaff = await fetch(w.base + '/api/v1/staff/auth/session', {
      method: 'POST',
      headers: { Origin: 'http://127.0.0.1:5188', 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginName: 'status-wechat-admin', password }),
    });
    assert.equal(loginStaff.status, 200);
    const cookie = loginStaff.headers.get('set-cookie')!.split(';')[0]!;
    const { data: p } = await (
      await fetch(w.base + '/api/v1/staff/me', { headers: { Cookie: cookie } })
    ).json();
    async function wechat(code: string) {
      const r = await fetch(w.base + '/api/v1/consumer/auth/wechat-session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      return { status: r.status, ...(await r.json()) };
    }
    const first = await wechat('status_first');
    assert.equal(first.status, 200);
    async function action(action: string, version: number) {
      return fetch(w.base + '/api/v1/admin/customers/' + first.data.user.id + '/status/' + action, {
        method: 'POST',
        headers: {
          Cookie: cookie,
          Origin: 'http://127.0.0.1:5188',
          'Content-Type': 'application/json',
          'X-CSRF-Token': p.csrfToken,
          'Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({ version, reason: '合成微信身份状态', confirmed: true }),
      });
    }
    assert.equal((await action('disable', 0)).status, 200);
    assert.equal((await wechat('status_disabled')).status, 401);
    assert.equal((await action('enable', 1)).status, 200);
    assert.equal(
      (
        await fetch(w.base + '/api/v1/consumer/me', {
          headers: { Authorization: 'Bearer ' + first.data.token },
        })
      ).status,
      401,
    );
    const restored = await wechat('status_restored');
    assert.equal(restored.status, 200);
    assert.equal(restored.data.user.id, first.data.user.id);
  } finally {
    await w.cleanup();
  }
});
