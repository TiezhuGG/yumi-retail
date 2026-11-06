import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rewardsFixture } from './helpers/rewards-fixture.ts';
import type { CustomerNotesPage } from '../packages/contracts/src/index.ts';
import { CustomerNotesService } from '../apps/api/dist/customer-notes.js';
import { CatalogService } from '../apps/api/dist/catalog-service.js';
import type { ApiRequest } from '../apps/api/src/http.ts';
let f: Awaited<ReturnType<typeof rewardsFixture>>, firstId: string;
before(async () => {
  f = await rewardsFixture();
});
after(async () => {
  await f?.cleanup();
});
const path = (id = f.identity.user.id) => '/admin/customers/' + id + '/notes';
const add = (message: string, k = randomUUID(), id = f.identity.user.id) =>
  f.api(path(id), { message, scopeId: f.warehouseId }, k);
async function read(query = '', id = f.identity.user.id) {
  const r = await f.api(path(id) + query);
  assert.equal(r.status, 200);
  return r.data as unknown as CustomerNotesPage;
}
async function snapshot() {
  const d = f.runtime.db;
  return JSON.stringify(
    [
      await d.consumerUser.findMany(),
      await d.pointsAccount.findMany(),
      await d.pointsEntry.findMany(),
      await d.stockBalance.findMany(),
      await d.redemptionOrder.findMany(),
    ],
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
  );
}
test('real note is encrypted, scoped, private and append-only; concurrent same-key replay cannot duplicate or alter customer assets', async () => {
  const before = await snapshot(),
    k = randomUUID(),
    message = '合成跟进记录：下次沟通前核对配送安排\n补充核对商品规格',
    [a, b] = await Promise.all([add(message, k), add(message, k)]);
  assert.equal(a.status, 200);
  assert.deepEqual(a.data, b.data);
  firstId = a.data.id;
  const page = await read();
  assert.equal(page.scopeId, f.warehouseId);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0]!.message, message);
  assert.equal(page.items[0]!.actorName, '合成积分验收员');
  const record = await f.runtime.db.businessAudit.findUniqueOrThrow({ where: { id: firstId } });
  assert.ok(!JSON.stringify(record).includes(message));
  assert.ok(!record.reason?.includes('配送安排'));
  assert.ok((record.details as { payload: string }).payload.startsWith('v1.'));
  assert.equal((await add('合成变更内容', k)).status, 409);
  assert.equal(await snapshot(), before);
  await assert.rejects(
    f.runtime.db.businessAudit.update({ where: { id: firstId }, data: { reason: '不应修改' } }),
  );
  await assert.rejects(f.runtime.db.businessAudit.delete({ where: { id: firstId } }));
  for (const field of ['payload', 'subject', 'token', 'requestId', 'actorId', 'phone'])
    assert.ok(!JSON.stringify(page).includes(field));
  assert.equal(
    (
      await fetch(f.base + '/api/v1/consumer/customers/' + f.identity.user.id + '/notes', {
        headers: { Authorization: 'Bearer ' + f.identity.token },
      })
    ).status,
    404,
  );
});
test('notes have stable newest-first pagination, customer/warehouse separation and historical actor names', async () => {
  for (let i = 0; i < 22; i++) assert.equal((await add('合成分页备注' + i)).status, 200);
  const a = await read();
  assert.equal(a.items.length, 20);
  assert.ok(a.nextCursor);
  const b = await read('?cursor=' + a.nextCursor);
  assert.equal(b.items.length, 3);
  assert.equal(b.nextCursor, null);
  assert.equal(new Set([...a.items, ...b.items].map((n) => n.id)).size, 23);
  assert.equal((await read('', f.identityB.user.id)).items.length, 0);
  assert.equal((await f.api(path(f.identityB.user.id) + '?cursor=' + firstId)).status, 409);
  const w = await f.runtime.db.warehouse.create({
      data: { id: randomUUID(), code: 'NOTE-FOREIGN', name: '合成外仓' },
    }),
    source = await f.runtime.db.businessAudit.findUniqueOrThrow({ where: { id: firstId } }),
    foreign = randomUUID();
  await f.runtime.db.businessAudit.create({
    data: {
      id: foreign,
      actorId: source.actorId,
      resourceId: source.resourceId,
      warehouseId: w.id,
      action: 'CUSTOMER_NOTE_ADDED',
      reason: '合成外仓隔离验证',
      details: source.details!,
      requestId: randomUUID(),
    },
  });
  assert.equal((await read()).items.length, 20);
  assert.equal((await f.api(path() + '?cursor=' + foreign)).status, 409);
  assert.equal((await f.api(path(), { message: '不得写外仓', scopeId: w.id })).status, 409);
  await f.runtime.db.staff.update({
    where: { id: source.actorId },
    data: { displayName: '合成改名运营' },
  });
  assert.equal((await read()).items[0]!.actorName, '合成积分验收员');
});
test('late audit failure rolls back the request and original key recovers without touching customer state', async () => {
  const d = f.runtime.db,
    schema = (await d.$queryRaw<Array<{ schema: string }>>`SELECT current_schema() AS schema`)[0]!
      .schema;
  assert.ok(schema.startsWith('address_ui_'));
  const before = await snapshot(),
    count = await d.businessAudit.count({
      where: {
        resourceId: f.identity.user.id,
        warehouseId: f.warehouseId,
        action: 'CUSTOMER_NOTE_ADDED',
      },
    }),
    k = randomUUID();
  await d.$executeRawUnsafe(
    "CREATE FUNCTION fail_customer_note() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='CUSTOMER_NOTE_ADDED' THEN RAISE EXCEPTION 'synthetic note failure'; END IF; RETURN NEW; END $$",
  );
  await d.$executeRawUnsafe(
    'CREATE TRIGGER fail_customer_note BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_customer_note()',
  );
  try {
    assert.equal((await add('合成原键恢复备注', k)).status, 500);
    assert.equal(
      await d.businessAudit.count({
        where: {
          resourceId: f.identity.user.id,
          warehouseId: f.warehouseId,
          action: 'CUSTOMER_NOTE_ADDED',
        },
      }),
      count,
    );
    assert.equal(await snapshot(), before);
  } finally {
    await d.$executeRawUnsafe('DROP TRIGGER fail_customer_note ON business_audits');
    await d.$executeRawUnsafe('DROP FUNCTION fail_customer_note()');
  }
  assert.equal((await add('合成原键恢复备注', k)).status, 200);
  assert.equal((await add('合成原键恢复备注', k)).status, 200);
  assert.equal(await snapshot(), before);
});

test('internal follow-up remains available for disabled customers without restoring access or changing assets', async () => {
  const u = await f.runtime.db.consumerUser.findUniqueOrThrow({
    where: { id: f.identity.user.id },
  });
  assert.equal(
    (
      await f.api('/admin/customers/' + u.id + '/status/disable', {
        version: u.authVersion,
        reason: '合成备注停用验证',
        confirmed: true,
      })
    ).status,
    200,
  );
  const before = await snapshot();
  assert.equal((await add('合成停用期间内部跟进')).status, 200);
  assert.equal(await snapshot(), before);
  assert.equal(
    (
      await fetch(f.base + '/api/v1/consumer/me', {
        headers: { Authorization: 'Bearer ' + f.identity.token },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.api('/admin/customers/' + u.id + '/status/enable', {
        version: u.authVersion + 1,
        reason: '合成核对后恢复',
        confirmed: true,
      })
    ).status,
    200,
  );
  const response = await fetch(f.base + '/api/v1/consumer/auth/dev-session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Yumi-Dev-Login': '1' },
    body: JSON.stringify({ profile: 'customer-a' }),
  });
  assert.equal(response.status, 200);
  const { data } = await response.json();
  f.identity.token = data.token;
});
test('missing keys fail closed and ciphertext cannot be copied to another customer or note', async () => {
  const d = f.runtime.db,
    actor = await d.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } }),
    session = await d.staffSession.findFirstOrThrow({ where: { staffId: actor.id } }),
    service = new CustomerNotesService(new CatalogService(d, f.warehouseId)),
    r = {
      requestId: randomUUID(),
      staffContext: { staffId: actor.id, sessionId: session.id, warehouseIds: [f.warehouseId] },
    } as ApiRequest;
  await assert.rejects(
    service.create(r, f.identity.user.id, randomUUID(), {
      message: '未配置密钥不得保存',
      scopeId: f.warehouseId,
    }),
  );
  await assert.rejects(service.list(r, f.identity.user.id, {}));
  const source = await d.businessAudit.findUniqueOrThrow({ where: { id: firstId } });
  await d.businessAudit.create({
    data: {
      id: randomUUID(),
      actorId: actor.id,
      resourceId: f.identityB.user.id,
      warehouseId: f.warehouseId,
      action: 'CUSTOMER_NOTE_ADDED',
      reason: '合成密文复制验证',
      details: source.details!,
      requestId: randomUUID(),
    },
  });
  const failed = await f.api(path(f.identityB.user.id));
  assert.equal(failed.status, 503);
  assert.equal(failed.error?.code, 'CUSTOMER_NOTES_UNREADABLE');
});
test('strict input, CSRF, consumer and warehouse-only accounts are denied; operations can append, revoked scope cannot replay', async () => {
  for (const body of [
    { message: '', scopeId: f.warehouseId },
    { message: '长'.repeat(501), scopeId: f.warehouseId },
    { message: '含\u0000字符', scopeId: f.warehouseId },
    { message: '缺范围' },
    { message: '不允许扩展', scopeId: f.warehouseId, enabled: false },
  ])
    assert.equal((await f.api(path(), body)).status, 400);
  assert.equal(
    (await f.api(path() + '?extra=1', { message: '禁止参数', scopeId: f.warehouseId })).status,
    400,
  );
  assert.equal(
    (await f.api(path(randomUUID()), { message: '不存在顾客', scopeId: f.warehouseId })).status,
    404,
  );
  assert.equal((await f.api(path() + '?cursor=bad')).status, 400);
  assert.equal(
    (
      await fetch(f.base + '/api/v1' + path(), {
        headers: { Authorization: 'Bearer ' + f.identity.token },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(f.base + '/api/v1' + path(), {
        method: 'POST',
        headers: {
          Cookie: f.cookie,
          Origin: 'http://127.0.0.1:5188',
          'Content-Type': 'application/json',
          'Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify({ message: '缺少CSRF', scopeId: f.warehouseId }),
      })
    ).status,
    403,
  );
  const d = f.runtime.db,
    { data: p } = await (
      await fetch(f.base + '/api/v1/staff/me', { headers: { Cookie: f.cookie } })
    ).json();
  await d.staffRole.updateMany({ where: { staffId: p.id }, data: { roleCode: 'OPERATIONS' } });
  const k = randomUUID();
  assert.equal((await add('运营可追加内部记录', k)).status, 200);
  assert.equal((await f.api(path())).status, 200);
  await d.staffRole.updateMany({
    where: { staffId: p.id },
    data: { roleCode: 'WAREHOUSE_MANAGER' },
  });
  assert.equal((await add('运营可追加内部记录', k)).status, 403);
  assert.equal((await f.api(path())).status, 403);
  await d.staffRole.updateMany({ where: { staffId: p.id }, data: { roleCode: 'SUPER_ADMIN' } });
  await d.staffWarehouse.deleteMany({ where: { staffId: p.id, warehouseId: f.warehouseId } });
  assert.equal((await add('运营可追加内部记录', k)).status, 403);
  assert.equal((await f.api(path())).status, 403);
});
