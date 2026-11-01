import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
test('strict role, CSRF, warehouse and synthetic-only inputs cannot enable real operations', async () => {
  assert.equal((await f.staff(base + '?warehouseId=' + f.warehouseId, '')).status, 401);
  for (const c of [f.cookies[0]!, f.extraCookies[1]!])
    assert.equal((await f.staff(base + '?warehouseId=' + f.warehouseId, c)).status, 403);
  assert.equal((await post('', { key: randomUUID() }, f.pickerCookie)).status, 403);
  assert.equal((await post('', { key: randomUUID() }, f.extraCookies[0]!, '')).status, 403);
  assert.equal(
    (
      await post(
        '',
        { key: randomUUID() },
        f.extraCookies[0]!,
        undefined,
        'http://untrusted.invalid',
      )
    ).status,
    403,
  );
  for (const body of [
    { key: 'bad' },
    { key: randomUUID(), orderId: randomUUID() },
    { key: randomUUID(), state: 'CHECKED' },
  ])
    assert.equal((await post('', body)).status, 400);
  assert.equal(
    (await f.staff(base + '?warehouseId=' + f.warehouseId + '&state=READY', f.pickerCookie)).status,
    400,
  );
  const t = await create();
  for (const body of [
    { key: randomUUID(), version: -1 },
    { key: randomUUID(), version: 0, lineId: 'sku' },
  ])
    assert.equal((await post('/' + t.id + '/claim', body, f.pickerCookie)).status, 400);
  assert.equal(
    (
      await post(
        '/' + t.id + '/check',
        { key: randomUUID(), version: 0, lineId: 'REAL', quantity: 2 },
        f.pickerCookie,
      )
    ).status,
    400,
  );
  assert.equal(
    (await f.staff(base + '/' + t.id + '?warehouseId=' + randomUUID(), f.pickerCookie)).status,
    403,
  );
  const other = await f.runtime.db.warehouse.findFirstOrThrow({
    where: { id: { not: f.warehouseId } },
  });
  await f.runtime.db.staffWarehouse.create({
    data: { staffId: f.pickerId, warehouseId: other.id },
  });
  assert.equal(
    (await f.staff(base + '/' + t.id + '?warehouseId=' + other.id, f.pickerCookie)).status,
    404,
  );
  assert.equal(
    (await f.staff(base + '?warehouseId=' + other.id + '&cursor=' + t.id, f.pickerCookie)).status,
    404,
  );
  await f.runtime.db.staffWarehouse.deleteMany({ where: { staffId: f.pickerId } });
  assert.equal(
    (await post('/' + t.id + '/claim', { key: randomUUID(), version: 0 }, f.pickerCookie)).status,
    403,
  );
});
test('same create key concurrently persists exactly one task, immutable create event and audit', async () => {
  const key = randomUUID(),
    r = await Promise.all(Array.from({ length: 8 }, () => post('', { key })));
  assert.ok(r.every((x) => x.status === 200));
  assert.equal(new Set(r.map((x) => x.data.task.id)).size, 1);
  assert.equal(r.filter((x) => !x.data.duplicate).length, 1);
  assert.equal(await f.runtime.db.pickingLabTask.count(), 1);
  assert.equal(await f.runtime.db.pickingLabEvent.count(), 1);
  assert.equal(
    await f.runtime.db.businessAudit.count({ where: { action: 'PICKING_LAB_CREATE' } }),
    1,
  );
});
test('two staff competing claim once; loser and other staff cannot check even with current version', async () => {
  const t = await create(),
    a = { key: randomUUID(), version: 0 },
    b = { key: randomUUID(), version: 0 };
  const r = await Promise.all([
    post('/' + t.id + '/claim', a, f.pickerCookie),
    post('/' + t.id + '/claim', b, f.extraCookies[0]!),
  ]);
  assert.deepEqual(r.map((x) => x.status).sort(), [200, 409]);
  const winner = r[0].status === 200 ? f.pickerCookie : f.extraCookies[0]!,
    loser = r[0].status === 200 ? f.extraCookies[0]! : f.pickerCookie;
  const d = (await detail(t.id)).task;
  assert.equal(d.state, 'PICKING');
  assert.equal(d.events.length, 2);
  assert.equal(
    (
      await post(
        '/' + t.id + '/check',
        { key: randomUUID(), version: 1, lineId: 'PAPER_SINGLE', quantity: 2 },
        loser,
      )
    ).status,
    403,
  );
  const replay = await post('/' + t.id + '/claim', r[0].status === 200 ? a : b, winner);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.duplicate, true);
  assert.equal(
    (await post('/' + t.id + '/claim', { key: randomUUID(), version: 1 }, winner)).status,
    409,
  );
});
test('line counts, optimistic competition and exact-key recovery advance two checks once, never stock or orders', async () => {
  const order = await f.create(),
    before = await facts(),
    t = await create();
  assert.equal(
    (await post('/' + t.id + '/claim', { key: randomUUID(), version: 0 }, f.pickerCookie)).status,
    200,
  );
  assert.equal(
    (
      await post(
        '/' + t.id + '/check',
        { key: randomUUID(), version: 1, lineId: 'PAPER_SINGLE', quantity: 1 },
        f.pickerCookie,
      )
    ).status,
    409,
  );
  const one = { key: randomUUID(), version: 1, lineId: 'PAPER_SINGLE', quantity: 2 };
  const r = await Promise.all(
    Array.from({ length: 8 }, () => post('/' + t.id + '/check', one, f.pickerCookie)),
  );
  assert.ok(r.every((x) => x.status === 200));
  assert.equal(r.filter((x) => !x.data.duplicate).length, 1);
  assert.equal(
    (await post('/' + t.id + '/check', { ...one, quantity: 3 }, f.pickerCookie)).status,
    409,
  );
  assert.equal(
    (
      await post(
        '/' + t.id + '/check',
        { key: randomUUID(), version: 1, lineId: 'PAPER_TRIPLE', quantity: 1 },
        f.pickerCookie,
      )
    ).status,
    409,
  );
  const two = { key: randomUUID(), version: 2, lineId: 'PAPER_TRIPLE', quantity: 1 };
  const done = await post('/' + t.id + '/check', two, f.pickerCookie);
  assert.equal(done.status, 200);
  assert.equal(done.data.task.state, 'CHECKED');
  assert.equal(done.data.task.events.length, 4);
  assert.ok(done.data.task.lines.every((i: { checked: boolean }) => i.checked));
  assert.equal((await post('/' + t.id + '/check', one, f.pickerCookie)).data.duplicate, true);
  assert.equal(
    (await post('/' + t.id + '/check', { ...two, key: randomUUID(), version: 3 }, f.pickerCookie))
      .status,
    409,
  );
  assert.deepEqual(await facts(), before);
  assert.equal(
    (await f.runtime.db.consumerOrder.findUniqueOrThrow({ where: { id: order } })).paymentState,
    'NOT_STARTED',
  );
});
test('different lines with the same version cannot both succeed or falsely finish', async () => {
  const t = await create();
  await post('/' + t.id + '/claim', { key: randomUUID(), version: 0 }, f.pickerCookie);
  const r = await Promise.all([
    post(
      '/' + t.id + '/check',
      { key: randomUUID(), version: 1, lineId: 'PAPER_SINGLE', quantity: 2 },
      f.pickerCookie,
    ),
    post(
      '/' + t.id + '/check',
      { key: randomUUID(), version: 1, lineId: 'PAPER_TRIPLE', quantity: 1 },
      f.pickerCookie,
    ),
  ]);
  assert.deepEqual(r.map((x) => x.status).sort(), [200, 409]);
  const d = (await detail(t.id)).task;
  assert.equal(d.state, 'PICKING');
  assert.equal(d.lines.filter((i: { checked: boolean }) => i.checked).length, 1);
});
test('audit failure rolls all task/event changes back; database rejects silent changes, owner takeover and fact mutation', async () => {
  const t = await create(),
    body = { key: randomUUID(), version: 0 };
  await f.runtime.db.$executeRawUnsafe(
    "CREATE FUNCTION fail_picking_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='PICKING_LAB_CLAIM' THEN RAISE EXCEPTION 'Synthetic picking late audit failure'; END IF; RETURN NEW; END $$",
  );
  await f.runtime.db.$executeRawUnsafe(
    'CREATE TRIGGER fail_picking_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_picking_audit()',
  );
  try {
    assert.equal((await post('/' + t.id + '/claim', body, f.pickerCookie)).status, 500);
    assert.equal((await detail(t.id)).task.state, 'READY');
    assert.equal(await f.runtime.db.pickingLabEvent.count(), 1);
  } finally {
    await f.runtime.db.$executeRawUnsafe('DROP TRIGGER fail_picking_audit ON business_audits');
    await f.runtime.db.$executeRawUnsafe('DROP FUNCTION fail_picking_audit()');
  }
  assert.equal((await post('/' + t.id + '/claim', body, f.pickerCookie)).status, 200);
  await assert.rejects(
    f.runtime.db.pickingLabTask.update({
      where: { id: t.id },
      data: { version: 2, checkedLines: ['PAPER_SINGLE'] },
    }),
  );
  await assert.rejects(
    f.runtime.db.pickingLabTask.update({
      where: { id: t.id },
      data: { ownerId: (await f.staff('/staff/me', f.extraCookies[0]!)).data.id, version: 2 },
    }),
  );
  const e = await f.runtime.db.pickingLabEvent.findFirstOrThrow({ where: { taskId: t.id } });
  await assert.rejects(
    f.runtime.db.pickingLabEvent.update({ where: { id: e.id }, data: { actorName: 'rewritten' } }),
  );
  await assert.rejects(f.runtime.db.pickingLabEvent.delete({ where: { id: e.id } }));
  await assert.rejects(f.runtime.db.pickingLabTask.delete({ where: { id: t.id } }));
});
test('default-off API can read durable synthetic history but cannot write; role revocation applies to later calls', async () => {
  const g = await pickingFixture();
  try {
    const admin = (await g.staff('/staff/me', g.extraCookies[0]!)).data,
      id = randomUUID(),
      key = randomUUID();
    await g.runtime.db.$transaction(async (tx) => {
      await tx.pickingLabTask.create({
        data: { id, key, warehouseId: g.warehouseId, creatorId: admin.id },
      });
      await tx.pickingLabEvent.create({
        data: {
          id: randomUUID(),
          taskId: id,
          key,
          actorId: admin.id,
          actorName: admin.displayName,
          action: 'CREATE',
          version: 0,
          state: 'READY',
          checkedLines: [],
        },
      });
    });
    const r = await g.staff(base + '/' + id + '?warehouseId=' + g.warehouseId, g.pickerCookie);
    assert.equal(r.status, 200);
    assert.equal(r.data.enabled, false);
    const write = await fetch(
      g.base + '/api/v1' + base + '/' + id + '/claim?warehouseId=' + g.warehouseId,
      {
        method: 'POST',
        headers: {
          Cookie: g.extraCookies[0]!,
          Origin: 'http://127.0.0.1:5188',
          'X-CSRF-Token': admin.csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ key: randomUUID(), version: 0 }),
      },
    );
    assert.equal(write.status, 503);
  } finally {
    await g.cleanup();
  }
  const t = await create();
  await f.runtime.db.staffRole.deleteMany({ where: { staffId: f.pickerId } });
  assert.equal(
    (await post('/' + t.id + '/claim', { key: randomUUID(), version: 0 }, f.pickerCookie)).status,
    403,
  );
});
test('pagination is warehouse-scoped and task projection omits request keys and credentials', async () => {
  for (let i = 0; i < 21; i++) await create();
  const a = await f.staff(base + '?warehouseId=' + f.warehouseId, f.pickerCookie);
  assert.equal(a.data.items.length, 20);
  const b = await f.staff(
    base + '?warehouseId=' + f.warehouseId + '&cursor=' + a.data.nextCursor,
    f.pickerCookie,
  );
  assert.equal(b.data.items.length, 1);
  assert.equal(
    new Set([...a.data.items, ...b.data.items].map((t: { id: string }) => t.id)).size,
    21,
  );
  const raw = JSON.stringify(a.data);
  for (const field of [
    '"key"',
    '"expectedVersion"',
    '"passwordHash"',
    '"requestId"',
    '"orderId"',
    '"skuId"',
  ])
    assert.ok(!raw.includes(field));
});
async function facts() {
  const db = f.runtime.db;
  return {
    orders: await db.consumerOrder.findMany(),
    allocations: await db.orderAllocation.findMany(),
    positions: await db.stockPosition.findMany(),
    lots: await db.stockLot.findMany(),
    balances: await db.stockBalance.findMany(),
    ledger: await db.stockLedger.count(),
    payment: await db.paymentPreparation.count(),
  };
}
