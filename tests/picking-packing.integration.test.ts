import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PickingLabTask } from '../packages/contracts/src/index.ts';
import { pickingFixture } from './helpers/picking-fixture.ts';
let f: Awaited<ReturnType<typeof pickingFixture>>;
const base = '/warehouse/picking-lab';
async function csrf(cookie: string) {
  return (await f.staff('/staff/me', cookie)).data.csrfToken as string;
}
async function post(
  suffix: string,
  body: unknown,
  cookie = f.extraCookies[0]!,
  token?: string,
  origin = 'http://127.0.0.1:5188',
) {
  const r = await fetch(f.base + '/api/v1' + base + suffix + '?warehouseId=' + f.warehouseId, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: origin,
      'X-CSRF-Token': token ?? (await csrf(cookie)),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, ...(await r.json()) };
}
async function create() {
  const r = await post('', { key: randomUUID() });
  assert.equal(r.status, 200);
  return r.data.task;
}
async function detail(id: string) {
  const r = await f.staff(base + '/' + id + '?warehouseId=' + f.warehouseId, f.pickerCookie);
  assert.equal(r.status, 200);
  return r.data;
}
beforeEach(async () => {
  f = await pickingFixture({ pickingLab: true });
});
afterEach(async () => {
  if (f) await f.cleanup();
});

async function claimed() {
  const t = await create();
  assert.equal(
    (await post('/' + t.id + '/claim', { key: randomUUID(), version: 0 }, f.pickerCookie)).status,
    200,
  );
  return (await detail(t.id)).task;
}
const packBody = (t: PickingLabTask) => ({
  key: randomUUID(),
  version: t.version,
  exceptionVersion: t.exceptionVersion,
  packageCount: 1,
  singleQuantity: 2,
  tripleQuantity: 1,
});
const dispatchBody = (t: PickingLabTask) => ({
  key: randomUUID(),
  version: t.version,
  exceptionVersion: t.exceptionVersion,
  packId: t.pack!.id,
});
const pack = (t: PickingLabTask, body: unknown = packBody(t), cookie = f.pickerCookie) =>
  post('/' + t.id + '/pack', body, cookie);
const dispatch = (t: PickingLabTask, body = dispatchBody(t), cookie = f.extraCookies[0]!) =>
  post('/' + t.id + '/dispatch', body, cookie);
async function checked() {
  let t = await claimed();
  for (const [lineId, quantity] of [
    ['PAPER_SINGLE', 2],
    ['PAPER_TRIPLE', 1],
  ] as const) {
    const r = await post(
      '/' + t.id + '/check',
      {
        key: randomUUID(),
        version: t.version,
        exceptionVersion: t.exceptionVersion,
        lineId,
        quantity,
      },
      f.pickerCookie,
    );
    assert.equal(r.status, 200);
    t = r.data.task;
  }
  return t as PickingLabTask;
}
test('packing requires complete picking and blocks unresolved shortage without creating facts', async () => {
  let t = await create();
  assert.equal(t.packingReadiness.ready, false);
  assert.equal((await pack(t)).status, 409);
  t = await claimed();
  assert.equal((await pack(t)).status, 409);
  const r = await post(
    '/' + t.id + '/shortages',
    {
      key: randomUUID(),
      version: 1,
      exceptionVersion: 0,
      lineId: 'PAPER_SINGLE',
      missingQuantity: 1,
      reason: 'MISSING',
    },
    f.pickerCookie,
  );
  assert.equal(r.status, 200);
  t = r.data.task;
  assert.ok(t.packingReadiness.blockers.includes('SHORTAGE_OPEN'));
  assert.equal((await pack(t)).status, 409);
  assert.equal(await f.runtime.db.pickingLabPack.count(), 0);
  assert.equal(await f.runtime.db.pickingLabDispatch.count(), 0);
});
test('owner, role, CSRF, warehouse and strict body protect packing and dispatch', async () => {
  let t = await checked();
  assert.equal(t.packingReadiness.ready, true);
  assert.equal((await pack(t, packBody(t), f.extraCookies[0]!)).status, 403);
  assert.equal((await post('/' + t.id + '/pack', packBody(t), f.pickerCookie, '')).status, 403);
  for (const body of [
    { ...packBody(t), packageCount: 0 },
    { ...packBody(t), packageCount: 21 },
    { ...packBody(t), singleQuantity: 1.5 },
    { ...packBody(t), exceptionVersion: undefined },
    { ...packBody(t), orderId: randomUUID() },
  ])
    assert.equal((await pack(t, body)).status, 400);
  assert.equal((await pack(t, { ...packBody(t), singleQuantity: 1 })).status, 409);
  assert.equal((await pack(t, { ...packBody(t), version: 2 })).status, 409);
  const wrongScope = await fetch(
    f.base + '/api/v1' + base + '/' + t.id + '/pack?warehouseId=' + randomUUID(),
    {
      method: 'POST',
      headers: {
        Cookie: f.pickerCookie,
        Origin: 'http://127.0.0.1:5188',
        'X-CSRF-Token': await csrf(f.pickerCookie),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(packBody(t)),
    },
  );
  assert.equal(wrongScope.status, 403);
  assert.equal((await post('/' + randomUUID() + '/pack', packBody(t), f.pickerCookie)).status, 404);
  assert.equal(
    (
      await post('/' + t.id + '/dispatch', {
        key: randomUUID(),
        version: 3,
        exceptionVersion: 0,
        packId: randomUUID(),
      })
    ).status,
    409,
  );
  t = (await pack(t)).data.task;
  assert.equal((await dispatch(t, dispatchBody(t), f.pickerCookie)).status, 403);
  assert.equal(
    (await post('/' + t.id + '/dispatch', dispatchBody(t), f.extraCookies[0]!, '')).status,
    403,
  );
  assert.equal((await dispatch(t, { ...dispatchBody(t), packId: randomUUID() })).status, 409);
  assert.equal((await dispatch(t, dispatchBody(t), f.cookies[1]!)).status, 200);
});
test('concurrent original requests create one immutable receipt and can recover after dispatch', async () => {
  const t = await checked(),
    b = packBody(t);
  const r = await Promise.all([pack(t, b), pack(t, b)]);
  assert.deepEqual(
    r.map((x) => x.status),
    [200, 200],
  );
  assert.deepEqual(r.map((x) => x.data.duplicate).sort(), [false, true]);
  const p = r[0].data.task as PickingLabTask,
    d = dispatchBody(p);
  const s = await Promise.all([dispatch(p, d), dispatch(p, d)]);
  assert.deepEqual(
    s.map((x) => x.status),
    [200, 200],
  );
  assert.deepEqual(s.map((x) => x.data.duplicate).sort(), [false, true]);
  assert.equal((await pack(t, b)).data.task.pack.dispatch.id, s[0].data.task.pack.dispatch.id);
  assert.equal((await pack(t, { ...b, packageCount: 2 })).status, 409);
  assert.equal((await pack(t)).status, 409);
  assert.equal((await dispatch(p, { ...d, packId: randomUUID() })).status, 409);
  assert.equal((await dispatch(p, d, f.cookies[1]!)).status, 409);
  assert.equal((await dispatch(p)).status, 409);
  assert.equal(await f.runtime.db.pickingLabPack.count(), 1);
  assert.equal(await f.runtime.db.pickingLabDispatch.count(), 1);
  assert.equal(
    await f.runtime.db.businessAudit.count({
      where: { action: { in: ['PICKING_LAB_PACK', 'PICKING_LAB_DISPATCH'] } },
    }),
    2,
  );
  const latest = (await detail(t.id)).task;
  assert.equal(latest.version, 3);
  assert.equal(latest.packingReadiness.ready, false);
  assert.equal(JSON.stringify(latest).includes(b.key), false);
});
test('competing new keys serialize to one pack and one dispatch', async () => {
  const t = await checked();
  const p = await Promise.all([pack(t), pack(t)]);
  assert.deepEqual(p.map((x) => x.status).sort(), [200, 409]);
  const ready = p.find((x) => x.status === 200)!.data.task;
  const d = await Promise.all([dispatch(ready), dispatch(ready)]);
  assert.deepEqual(d.map((x) => x.status).sort(), [200, 409]);
});
test('audit failure atomically rolls each receipt back and preserves original retry', async () => {
  const t = await checked(),
    b = packBody(t),
    db = f.runtime.db;
  await db.$executeRawUnsafe(
    "CREATE FUNCTION fail_packing_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('PICKING_LAB_PACK','PICKING_LAB_DISPATCH') THEN RAISE EXCEPTION 'Synthetic packing audit fail'; END IF; RETURN NEW; END $$",
  );
  const gate = () =>
    db.$executeRawUnsafe(
      'CREATE TRIGGER fail_packing_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_packing_audit()',
    );
  const clear = () => db.$executeRawUnsafe('DROP TRIGGER fail_packing_audit ON business_audits');
  await gate();
  assert.equal((await pack(t, b)).status, 500);
  assert.equal(await db.pickingLabPack.count(), 0);
  await clear();
  const p = (await pack(t, b)).data.task,
    d = dispatchBody(p);
  await gate();
  assert.equal((await dispatch(p, d)).status, 500);
  assert.equal(await db.pickingLabDispatch.count(), 0);
  await clear();
  assert.equal((await dispatch(p, d)).status, 200);
});
test('database rejects incomplete packing, wrong owner, stale snapshots and receipt mutation', async () => {
  const db = f.runtime.db,
    t = await claimed();
  const data = {
    id: randomUUID(),
    taskId: t.id,
    actorId: f.pickerId,
    actorName: '隔离核验',
    key: randomUUID(),
    taskVersion: 3,
    exceptionVersion: 0,
    packageCount: 1,
    singleQuantity: 2,
    tripleQuantity: 1,
  };
  await assert.rejects(db.pickingLabPack.create({ data }));
  const c = await checked();
  await assert.rejects(
    db.pickingLabPack.create({
      data: { ...data, id: randomUUID(), taskId: c.id, exceptionVersion: 1 },
    }),
  );
  const admin = await db.staff.findFirstOrThrow({ where: { id: { not: f.pickerId } } });
  await assert.rejects(
    db.pickingLabPack.create({
      data: { ...data, id: randomUUID(), taskId: c.id, actorId: admin.id },
    }),
  );
  const p = (await pack(c)).data.task as PickingLabTask;
  await assert.rejects(
    db.pickingLabPack.update({ where: { id: p.pack!.id }, data: { packageCount: 2 } }),
  );
  await assert.rejects(db.pickingLabPack.delete({ where: { id: p.pack!.id } }));
  await assert.rejects(
    db.pickingLabDispatch.create({
      data: {
        id: randomUUID(),
        taskId: c.id,
        packId: p.pack!.id,
        actorId: admin.id,
        actorName: '隔离核验',
        key: randomUUID(),
        taskVersion: 3,
        exceptionVersion: 1,
      },
    }),
  );
  const d = (await dispatch(p)).data.task.pack.dispatch;
  await assert.rejects(
    db.pickingLabDispatch.update({ where: { id: d.id }, data: { actorName: 'changed' } }),
  );
  await assert.rejects(db.pickingLabDispatch.delete({ where: { id: d.id } }));
});
test('full synthetic flow leaves real orders, preparations, stock, reservations and movements unchanged', async () => {
  await f.create();
  const db = f.runtime.db;
  async function snapshot() {
    return {
      orders: await db.consumerOrder.findMany({ orderBy: { id: 'asc' } }),
      balances: await db.stockBalance.findMany({ orderBy: { skuId: 'asc' } }),
      movements: await db.stockLedger.findMany({ orderBy: { id: 'asc' } }),
      reservations: await db.orderAllocation.findMany({ orderBy: { id: 'asc' } }),
      preparations: await db.paymentPreparation.findMany({ orderBy: { id: 'asc' } }),
    };
  }
  const before = await snapshot(),
    p = (await pack(await checked())).data.task;
  assert.equal((await dispatch(p)).status, 200);
  assert.deepEqual(await snapshot(), before);
});
test('default-disabled routes cannot record packing or dispatch', async () => {
  await f.cleanup();
  f = await pickingFixture();
  assert.equal(
    (
      await post(
        '/' + randomUUID() + '/pack',
        {
          key: randomUUID(),
          version: 3,
          exceptionVersion: 0,
          packageCount: 1,
          singleQuantity: 2,
          tripleQuantity: 1,
        },
        f.pickerCookie,
      )
    ).status,
    503,
  );
  assert.equal(
    (
      await post('/' + randomUUID() + '/dispatch', {
        key: randomUUID(),
        version: 3,
        exceptionVersion: 0,
        packId: randomUUID(),
      })
    ).status,
    503,
  );
});
