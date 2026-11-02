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
async function ready() {
  const p = await pack(await checked());
  assert.equal(p.status, 200);
  const d = await dispatch(p.data.task);
  assert.equal(d.status, 200);
  return d.data.task.pack.dispatch.id as string;
}
async function rider() {
  return (await f.staff('/staff/me', f.extraCookies[1]!)).data.id as string;
}
async function assign(id: string, body: unknown, cookie = f.cookies[1]!, token?: string) {
  const r = await fetch(
    f.base + '/api/v1/delivery-lab/' + id + '/assign?warehouseId=' + f.warehouseId,
    {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'http://127.0.0.1:5188',
        'X-CSRF-Token': token ?? (await csrf(cookie)),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  return { status: r.status, ...(await r.json()) };
}
const read = (suffix = '', cookie = f.cookies[1]!) =>
  f.staff(
    '/delivery-lab' + suffix + (suffix.includes('?') ? '&' : '?') + 'warehouseId=' + f.warehouseId,
    cookie,
  );
async function otherRider() {
  const id = randomUUID(),
    source = await f.runtime.db.staff.findUniqueOrThrow({ where: { id: f.pickerId } });
  await f.runtime.db.staff.create({
    data: {
      id,
      loginName: 'other-rider',
      displayName: '另一隔离骑手',
      passwordHash: source.passwordHash,
      roles: { create: { roleCode: 'RIDER' } },
      warehouses: { create: { warehouseId: f.warehouseId } },
    },
  });
  const r = await fetch(f.base + '/api/v1/staff/auth/session', {
    method: 'POST',
    headers: { Origin: 'http://127.0.0.1:5188', 'Content-Type': 'application/json' },
    body: JSON.stringify({ loginName: 'other-rider', password: f.password }),
  });
  assert.equal(r.status, 200);
  return { id, cookie: r.headers.get('set-cookie')!.split(';')[0]! };
}
test('only completed dispatches appear; roles, scope, CSRF and strict inputs protect assignment', async () => {
  const id = await ready(),
    rid = await rider(),
    body = { key: randomUUID(), riderId: rid };
  for (const c of ['', f.pickerCookie, f.cookies[0]!])
    assert.equal((await read('', c)).status, c ? 403 : 401);
  assert.equal((await read()).data.items.length, 1);
  assert.equal((await read('', f.extraCookies[1]!)).data.items.length, 0);
  assert.equal((await assign(id, body, f.extraCookies[1]!)).status, 403);
  assert.equal((await assign(id, body, f.cookies[1]!, '')).status, 403);
  for (const bad of [
    { ...body, state: 'DELIVERED' },
    { ...body, riderId: 'bad' },
    { key: body.key },
  ])
    assert.equal((await assign(id, bad)).status, 400);
  assert.equal((await assign((await create()).id, body)).status, 404);
  assert.equal(
    (await f.staff('/delivery-lab?warehouseId=' + randomUUID(), f.cookies[1]!)).status,
    403,
  );
  assert.equal((await read('/riders', f.extraCookies[1]!)).status, 403);
  const choices = await read('/riders');
  assert.deepEqual(
    choices.data.items.map((x: { id: string }) => x.id),
    [rid],
  );
  assert.equal(JSON.stringify(choices.data).includes('password'), false);
  assert.equal((await read('?riderId=' + rid)).status, 400);
});
test('only active same warehouse riders can receive; database enforces prerequisites and immutability', async () => {
  const id = await ready(),
    rid = await rider(),
    db = f.runtime.db;
  const b = { key: randomUUID(), riderId: rid };
  assert.equal((await assign(id, { ...b, riderId: f.pickerId })).status, 409);
  await db.staff.update({ where: { id: rid }, data: { enabled: false } });
  assert.equal((await assign(id, b)).status, 409);
  const actor = (await f.staff('/staff/me', f.cookies[1]!)).data.id;
  const data = {
    id: randomUUID(),
    dispatchId: id,
    riderId: rid,
    riderName: '合成',
    actorId: actor,
    actorName: '合成',
    key: randomUUID(),
  };
  await assert.rejects(db.deliveryLabAssignment.create({ data }));
  await db.staff.update({ where: { id: rid }, data: { enabled: true } });
  await db.staffWarehouse.delete({
    where: { staffId_warehouseId: { staffId: rid, warehouseId: f.warehouseId } },
  });
  assert.equal((await assign(id, b)).status, 409);
  await assert.rejects(db.deliveryLabAssignment.create({ data }));
  await db.staffWarehouse.create({ data: { staffId: rid, warehouseId: f.warehouseId } });
  await db.staffRole.delete({ where: { staffId_roleCode: { staffId: rid, roleCode: 'RIDER' } } });
  assert.equal((await assign(id, b)).status, 409);
  await assert.rejects(db.deliveryLabAssignment.create({ data }));
  await db.staffRole.create({ data: { staffId: rid, roleCode: 'RIDER' } });
  const r = await assign(id, b);
  assert.equal(r.status, 200);
  const receipt = r.data.task.assignment;
  await assert.rejects(
    db.deliveryLabAssignment.update({ where: { id: receipt.id }, data: { riderName: 'changed' } }),
  );
  await assert.rejects(db.deliveryLabAssignment.delete({ where: { id: receipt.id } }));
});
test('same-key concurrency recovers one fact, different body or actor cannot replay and new key cannot override', async () => {
  const id = await ready(),
    rid = await rider(),
    other = await otherRider(),
    body = { key: randomUUID(), riderId: rid };
  const replies = await Promise.all([assign(id, body), assign(id, body)]);
  assert.deepEqual(
    replies.map((x) => x.status),
    [200, 200],
  );
  assert.deepEqual(replies.map((x) => x.data.duplicate).sort(), [false, true]);
  assert.equal((await assign(id, { ...body, riderId: other.id })).status, 409);
  assert.equal((await assign(id, body, f.extraCookies[0]!)).status, 409);
  assert.equal((await assign(id, { key: randomUUID(), riderId: other.id })).status, 409);
  assert.equal(await f.runtime.db.deliveryLabAssignment.count(), 1);
  assert.equal(
    await f.runtime.db.businessAudit.count({ where: { action: 'DELIVERY_LAB_ASSIGN' } }),
    1,
  );
  const d = (await read('/' + id)).data.task;
  assert.equal(d.handoffReadiness.ready, true);
  assert.equal(JSON.stringify(d).includes(body.key), false);
  assert.equal(JSON.stringify(d).includes(rid), false);
});
test('competing assignment serializes and each rider only reads their assigned task including cursors', async () => {
  const id = await ready(),
    other = await otherRider(),
    rid = await rider();
  const r = await Promise.all([
    assign(id, { key: randomUUID(), riderId: rid }),
    assign(id, { key: randomUUID(), riderId: other.id }),
  ]);
  assert.deepEqual(r.map((x) => x.status).sort(), [200, 409]);
  const a = await f.runtime.db.deliveryLabAssignment.findFirstOrThrow();
  const winner = a.riderId === rid ? f.extraCookies[1]! : other.cookie,
    loser = a.riderId === rid ? other.cookie : f.extraCookies[1]!;
  assert.equal((await read('', winner)).data.items.length, 1);
  assert.equal((await read('', winner)).data.selfOnly, true);
  assert.equal((await read('', loser)).data.items.length, 0);
  assert.equal((await read('/' + id, loser)).status, 404);
  assert.equal((await read('?cursor=' + id, loser)).status, 404);
  assert.equal((await read('/' + id, winner)).status, 200);
  const db = f.runtime.db;
  await db.staffWarehouse.delete({
    where: { staffId_warehouseId: { staffId: a.riderId, warehouseId: f.warehouseId } },
  });
  assert.equal((await read('/' + id, winner)).status, 403);
  const d = (await read('/' + id)).data.task;
  assert.ok(d.handoffReadiness.blockers.includes('RIDER_WAREHOUSE_REMOVED'));
  assert.equal(d.handoffReadiness.ready, false);
});
test('readiness follows revocation and successful original retry stays recoverable without pretending handoff', async () => {
  const id = await ready(),
    rid = await rider(),
    b = { key: randomUUID(), riderId: rid },
    db = f.runtime.db;
  await assign(id, b);
  await db.staff.update({ where: { id: rid }, data: { enabled: false } });
  let d = (await read('/' + id)).data.task;
  assert.ok(d.handoffReadiness.blockers.includes('RIDER_DISABLED'));
  assert.equal(d.handoffReadiness.ready, false);
  const retry = await assign(id, b);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.duplicate, true);
  assert.equal(retry.data.task.handoffReadiness.ready, false);
  await db.staff.update({ where: { id: rid }, data: { enabled: true } });
  await db.staffRole.delete({ where: { staffId_roleCode: { staffId: rid, roleCode: 'RIDER' } } });
  d = (await read('/' + id)).data.task;
  assert.ok(d.handoffReadiness.blockers.includes('RIDER_ROLE_REMOVED'));
  assert.equal((await read('', f.extraCookies[1]!)).status, 403);
  const managerId = (await f.staff('/staff/me', f.cookies[1]!)).data.id;
  await db.staffRole.deleteMany({ where: { staffId: managerId } });
  assert.equal((await assign(id, b)).status, 403);
});
test('audit failure rolls assignment back; full synthetic flow leaves order and inventory facts unchanged', async () => {
  await f.create();
  const db = f.runtime.db;
  const snapshot = async () => ({
    orders: await db.consumerOrder.findMany(),
    positions: await db.stockPosition.findMany(),
    balances: await db.stockBalance.findMany(),
    lots: await db.stockLot.findMany(),
    allocations: await db.orderAllocation.findMany(),
    ledger: await db.stockLedger.count(),
    payment: await db.paymentPreparation.count(),
  });
  const before = await snapshot(),
    id = await ready(),
    b = { key: randomUUID(), riderId: await rider() };
  await db.$executeRawUnsafe(
    "CREATE FUNCTION fail_delivery_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='DELIVERY_LAB_ASSIGN' THEN RAISE EXCEPTION 'Synthetic assignment audit fail'; END IF; RETURN NEW; END $$",
  );
  await db.$executeRawUnsafe(
    'CREATE TRIGGER fail_delivery_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_delivery_audit()',
  );
  assert.equal((await assign(id, b)).status, 500);
  assert.equal(await db.deliveryLabAssignment.count(), 0);
  await db.$executeRawUnsafe('DROP TRIGGER fail_delivery_audit ON business_audits');
  assert.equal((await assign(id, b)).status, 200);
  assert.deepEqual(await snapshot(), before);
});
test('stable pagination is scoped and default-off reads remain available while assignments refuse503', async () => {
  const ids = [];
  for (let i = 0; i < 21; i++) ids.push(await ready());
  const first = await read();
  assert.equal(first.data.items.length, 20);
  const second = await read('?cursor=' + first.data.nextCursor);
  assert.equal(second.data.items.length, 1);
  assert.equal(new Set([...first.data.items, ...second.data.items].map((x) => x.id)).size, 21);
  await f.cleanup();
  f = await pickingFixture();
  assert.equal((await read()).status, 200);
  assert.equal((await read()).data.enabled, false);
  assert.equal(
    (await assign(randomUUID(), { key: randomUUID(), riderId: await rider() })).status,
    503,
  );
  assert.equal(await f.runtime.db.deliveryLabAssignment.count(), 0);
});

async function accept(id: string, body: unknown, cookie = f.extraCookies[1]!) {
  const r = await fetch(
    f.base + '/api/v1/delivery-lab/' + id + '/accept?warehouseId=' + f.warehouseId,
    {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'http://127.0.0.1:5188',
        'X-CSRF-Token': await csrf(cookie),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  return { status: r.status, ...(await r.json()) };
}
test('handoff checks owner and exact count; concurrent original retries create one immutable receipt', async () => {
  const id = await ready(),
    rid = await rider();
  assert.equal((await assign(id, { key: randomUUID(), riderId: rid })).status, 200);
  const body = { key: randomUUID(), packageCount: 1 };
  assert.equal((await accept(id, body, f.cookies[1]!)).status, 403);
  const other = await otherRider();
  assert.equal((await accept(id, body, other.cookie)).status, 404);
  assert.equal((await accept(id, { ...body, packageCount: 2 })).status, 409);
  for (const packageCount of [0, 1.5, '1', null])
    assert.equal((await accept(id, { ...body, packageCount })).status, 400);
  assert.equal((await accept(id, { ...body, state: 'DELIVERED' })).status, 400);
  const results = await Promise.all([accept(id, body), accept(id, body)]);
  assert.deepEqual(
    results.map((r) => r.status),
    [200, 200],
  );
  assert.equal(results.filter((r) => r.data.duplicate).length, 1);
  assert.equal(await f.runtime.db.deliveryLabHandoff.count(), 1);
  assert.equal(results[0].data.task.handoff.packageCount, 1);
  assert.equal((await accept(id, { ...body, packageCount: 2 })).status, 409);
  assert.equal((await accept(id, { ...body, key: randomUUID() })).status, 409);
  const receipt = await f.runtime.db.deliveryLabHandoff.findFirstOrThrow();
  await assert.rejects(
    f.runtime.db.deliveryLabHandoff.update({
      where: { id: receipt.id },
      data: { packageCount: 2 },
    }),
  );
  await assert.rejects(f.runtime.db.deliveryLabHandoff.delete({ where: { id: receipt.id } }));
  assert.equal((await read('/' + id, f.extraCookies[1]!)).data.task.handoff.id, receipt.id);
});
test('different handoff requests compete without duplicate evidence', async () => {
  const id = await ready();
  await assign(id, { key: randomUUID(), riderId: await rider() });
  const results = await Promise.all([
    accept(id, { key: randomUUID(), packageCount: 1 }),
    accept(id, { key: randomUUID(), packageCount: 1 }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(await f.runtime.db.deliveryLabHandoff.count(), 1);
  assert.equal(
    await f.runtime.db.businessAudit.count({ where: { action: 'DELIVERY_LAB_ACCEPT' } }),
    1,
  );
});
test('database handoff gate rejects mismatched count and revoked rider qualification', async () => {
  const id = await ready(),
    rid = await rider();
  await assign(id, { key: randomUUID(), riderId: rid });
  const assignment = await f.runtime.db.deliveryLabAssignment.findFirstOrThrow();
  const data = {
    id: randomUUID(),
    assignmentId: assignment.id,
    key: randomUUID(),
    packageCount: 2,
  };
  await assert.rejects(f.runtime.db.deliveryLabHandoff.create({ data }));
  await f.runtime.db.staffRole.deleteMany({ where: { staffId: rid, roleCode: 'RIDER' } });
  await assert.rejects(
    f.runtime.db.deliveryLabHandoff.create({ data: { ...data, packageCount: 1 } }),
  );
  assert.equal((await accept(id, { key: randomUUID(), packageCount: 1 })).status, 403);
  assert.equal(await f.runtime.db.deliveryLabHandoff.count(), 0);
});

test('handoff audit failure rolls back, original retry recovers, and formal business snapshots remain unchanged', async () => {
  await f.create();
  const db = f.runtime.db;
  const snapshot = async () => ({
    orders: await db.consumerOrder.findMany(),
    positions: await db.stockPosition.findMany(),
    balances: await db.stockBalance.findMany(),
    lots: await db.stockLot.findMany(),
    allocations: await db.orderAllocation.findMany(),
    ledger: await db.stockLedger.findMany(),
    payment: await db.paymentPreparation.findMany(),
  });
  const before = await snapshot(),
    id = await ready();
  await assign(id, { key: randomUUID(), riderId: await rider() });
  const body = { key: randomUUID(), packageCount: 1 };
  await db.$executeRawUnsafe(
    "CREATE FUNCTION fail_handoff_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='DELIVERY_LAB_ACCEPT' THEN RAISE EXCEPTION 'Synthetic handoff audit fail'; END IF; RETURN NEW; END $$",
  );
  await db.$executeRawUnsafe(
    'CREATE TRIGGER fail_handoff_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_handoff_audit()',
  );
  assert.equal((await accept(id, body)).status, 500);
  assert.equal(await db.deliveryLabHandoff.count(), 0);
  await db.$executeRawUnsafe('DROP TRIGGER fail_handoff_audit ON business_audits');
  assert.equal((await accept(id, body)).status, 200);
  assert.equal((await accept(id, body)).data.duplicate, true);
  assert.deepEqual(await snapshot(), before);
});
test('default-off handoff refuses writes without creating a receipt', async () => {
  await f.cleanup();
  f = await pickingFixture();
  assert.equal((await accept(randomUUID(), { key: randomUUID(), packageCount: 1 })).status, 503);
  assert.equal(await f.runtime.db.deliveryLabHandoff.count(), 0);
});

async function stage(
  id: string,
  action: 'start' | 'complete',
  body: unknown,
  cookie = f.extraCookies[1]!,
  token?: string,
) {
  const r = await fetch(
    f.base + '/api/v1/delivery-lab/' + id + '/' + action + '?warehouseId=' + f.warehouseId,
    {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'http://127.0.0.1:5188',
        'X-CSRF-Token': token ?? (await csrf(cookie)),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  return { status: r.status, ...(await r.json()) };
}
async function assignedForJourney() {
  const id = await ready();
  assert.equal((await assign(id, { key: randomUUID(), riderId: await rider() })).status, 200);
  return id;
}
test('journey requires handoff then start; owner, role, CSRF and strict inputs are enforced', async () => {
  const id = await assignedForJourney(),
    body = { key: randomUUID() };
  assert.equal((await stage(id, 'start', body)).status, 409);
  assert.equal((await stage(id, 'complete', body)).status, 409);
  assert.equal((await stage(id, 'start', body, f.cookies[1]!)).status, 403);
  const other = await otherRider();
  assert.equal((await stage(id, 'start', body, other.cookie)).status, 404);
  assert.equal((await stage(id, 'start', body, f.extraCookies[1]!, '')).status, 403);
  for (const bad of [{ ...body, state: 'DELIVERED' }, { key: 'invalid' }, {}])
    assert.equal((await stage(id, 'start', bad)).status, 400);
  await accept(id, { key: randomUUID(), packageCount: 1 });
  assert.equal((await stage(id, 'complete', body)).status, 409);
  assert.equal((await stage(id, 'start', body)).status, 200);
  assert.equal((await stage(id, 'complete', { key: randomUUID() })).status, 200);
  const task = (await read('/' + id)).data.task;
  assert.ok(task.journey.start && task.journey.completion);
  assert.equal(JSON.stringify(task).includes(body.key), false);
});
test('each journey stage serializes concurrent keys and restores original request even after completion', async () => {
  const id = await assignedForJourney();
  await accept(id, { key: randomUUID(), packageCount: 1 });
  const start = { key: randomUUID() },
    complete = { key: randomUUID() };
  let r = await Promise.all([stage(id, 'start', start), stage(id, 'start', start)]);
  assert.deepEqual(
    r.map((v) => v.status),
    [200, 200],
  );
  assert.equal(r.filter((v) => v.data.duplicate).length, 1);
  r = await Promise.all([
    stage(id, 'complete', complete),
    stage(id, 'complete', { key: randomUUID() }),
  ]);
  assert.deepEqual(r.map((v) => v.status).sort(), [200, 409]);
  const db = f.runtime.db,
    rows = await db.deliveryLabJourneyFact.findMany();
  assert.equal(rows.length, 2);
  const fact = rows.find((v) => v.kind === 'COMPLETE')!;
  assert.equal((await stage(id, 'complete', { key: fact.key })).data.duplicate, true);
  assert.equal((await stage(id, 'start', start)).data.duplicate, true);
  assert.equal(
    await db.businessAudit.count({
      where: { action: { in: ['DELIVERY_LAB_START', 'DELIVERY_LAB_COMPLETE'] } },
    }),
    2,
  );
  await assert.rejects(
    db.deliveryLabJourneyFact.update({ where: { id: fact.id }, data: { key: randomUUID() } }),
  );
  await assert.rejects(db.deliveryLabJourneyFact.delete({ where: { id: fact.id } }));
});
test('database journey gate rejects skipped phases and revoked qualification; default-off blocks both actions', async () => {
  const id = await assignedForJourney(),
    db = f.runtime.db,
    a = await db.deliveryLabAssignment.findFirstOrThrow();
  const data = { id: randomUUID(), assignmentId: a.id, key: randomUUID(), kind: 'START' };
  await assert.rejects(db.deliveryLabJourneyFact.create({ data }));
  await accept(id, { key: randomUUID(), packageCount: 1 });
  await assert.rejects(db.deliveryLabJourneyFact.create({ data: { ...data, kind: 'COMPLETE' } }));
  await assert.rejects(db.deliveryLabJourneyFact.create({ data: { ...data, kind: 'ANY_STATE' } }));
  await db.staffRole.deleteMany({ where: { staffId: a.riderId, roleCode: 'RIDER' } });
  await assert.rejects(db.deliveryLabJourneyFact.create({ data }));
  assert.equal((await stage(id, 'start', { key: randomUUID() })).status, 403);
  await f.cleanup();
  f = await pickingFixture();
  for (const action of ['start', 'complete'] as const)
    assert.equal((await stage(randomUUID(), action, { key: randomUUID() })).status, 503);
  assert.equal(await f.runtime.db.deliveryLabJourneyFact.count(), 0);
});
test('journey audit failures roll back each stage and complete flow leaves formal facts unchanged', async () => {
  await f.create();
  const db = f.runtime.db;
  const snapshot = async () => ({
    orders: await db.consumerOrder.findMany(),
    stock: await db.stockPosition.findMany(),
    balances: await db.stockBalance.findMany(),
    lots: await db.stockLot.findMany(),
    allocations: await db.orderAllocation.findMany(),
    ledger: await db.stockLedger.findMany(),
    payment: await db.paymentPreparation.findMany(),
  });
  const before = await snapshot(),
    id = await assignedForJourney();
  await accept(id, { key: randomUUID(), packageCount: 1 });
  for (const [action, audit] of [
    ['start', 'DELIVERY_LAB_START'],
    ['complete', 'DELIVERY_LAB_COMPLETE'],
  ] as const) {
    await db.$executeRawUnsafe(
      `CREATE OR REPLACE FUNCTION fail_journey_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='${audit}' THEN RAISE EXCEPTION 'Synthetic journey audit fail'; END IF; RETURN NEW; END $$`,
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER fail_journey_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_journey_audit()',
    );
    const body = { key: randomUUID() };
    assert.equal((await stage(id, action, body)).status, 500);
    assert.equal(await db.deliveryLabJourneyFact.count(), action === 'start' ? 0 : 1);
    await db.$executeRawUnsafe('DROP TRIGGER fail_journey_audit ON business_audits');
    assert.equal((await stage(id, action, body)).status, 200);
  }
  assert.deepEqual(await snapshot(), before);
});

async function reportException(id: string, body: unknown, cookie = f.extraCookies[1]!) {
  const r = await fetch(
    f.base + '/api/v1/delivery-lab/' + id + '/report-exception?warehouseId=' + f.warehouseId,
    {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'http://127.0.0.1:5188',
        'X-CSRF-Token': await csrf(cookie),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  return { status: r.status, ...(await r.json()) };
}
test('exception owner, prerequisites, strict reason, original retry and database progress blocking', async () => {
  const id = await assignedForJourney(),
    body = { key: randomUUID(), reason: 'DAMAGED' };
  assert.equal((await reportException(id, body)).status, 409);
  assert.equal((await reportException(id, body, f.cookies[1]!)).status, 403);
  const other = await otherRider();
  assert.equal((await reportException(id, body, other.cookie)).status, 404);
  await accept(id, { key: randomUUID(), packageCount: 1 });
  assert.equal((await reportException(id, { ...body, reason: 'OTHER' })).status, 400);
  const r = await Promise.all([reportException(id, body), reportException(id, body)]);
  assert.deepEqual(
    r.map((v) => v.status),
    [200, 200],
  );
  assert.equal(r.filter((v) => v.data.duplicate).length, 1);
  assert.equal((await reportException(id, { ...body, reason: 'REFUSED' })).status, 409);
  assert.equal((await reportException(id, { ...body, key: randomUUID() })).status, 409);
  assert.equal((await stage(id, 'start', { key: randomUUID() })).status, 409);
  const db = f.runtime.db,
    e = await db.deliveryLabException.findFirstOrThrow();
  await assert.rejects(
    db.deliveryLabJourneyFact.create({
      data: { id: randomUUID(), assignmentId: e.assignmentId, key: randomUUID(), kind: 'START' },
    }),
  );
  await assert.rejects(db.deliveryLabException.delete({ where: { id: e.id } }));
  await assert.rejects(
    db.deliveryLabException.update({ where: { id: e.id }, data: { reason: 'REFUSED' } }),
  );
});
test('exception competes with completion; audit rollback and disabled switch remain safe', async () => {
  const id = await assignedForJourney();
  await accept(id, { key: randomUUID(), packageCount: 1 });
  await stage(id, 'start', { key: randomUUID() });
  const db = f.runtime.db,
    body = { key: randomUUID(), reason: 'UNREACHABLE' };
  await db.$executeRawUnsafe(
    "CREATE FUNCTION fail_exception_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='DELIVERY_LAB_EXCEPTION' THEN RAISE EXCEPTION 'Synthetic fail'; END IF; RETURN NEW; END $$",
  );
  await db.$executeRawUnsafe(
    'CREATE TRIGGER fail_exception_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_exception_audit()',
  );
  assert.equal((await reportException(id, body)).status, 500);
  assert.equal(await db.deliveryLabException.count(), 0);
  await db.$executeRawUnsafe('DROP TRIGGER fail_exception_audit ON business_audits');
  const r = await Promise.all([
    reportException(id, body),
    stage(id, 'complete', { key: randomUUID() }),
  ]);
  assert.deepEqual(r.map((v) => v.status).sort(), [200, 409]);
  assert.equal(
    (await db.deliveryLabException.count()) +
      (await db.deliveryLabJourneyFact.count({ where: { kind: 'COMPLETE' } })),
    1,
  );
  await f.cleanup();
  f = await pickingFixture();
  assert.equal((await reportException(randomUUID(), body)).status, 503);
});

async function resolveException(id: string, body: unknown, cookie = f.cookies[1]!) {
  const res = await fetch(
    f.base + '/api/v1/delivery-lab/' + id + '/resolve-exception?warehouseId=' + f.warehouseId,
    {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'http://127.0.0.1:5188',
        'X-CSRF-Token': await csrf(cookie),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    },
  );
  return { status: res.status, ...(await res.json()) };
}
test('manager resolution is immutable, concurrent original retry recovers and rider alone resumes', async () => {
  const id = await assignedForJourney();
  await accept(id, { key: randomUUID(), packageCount: 1 });
  await reportException(id, { key: randomUUID(), reason: 'DAMAGED' });
  const db = f.runtime.db,
    e = await db.deliveryLabException.findFirstOrThrow(),
    body = { key: randomUUID(), exceptionId: e.id };
  assert.equal((await resolveException(id, body, f.extraCookies[1]!)).status, 403);
  assert.equal((await resolveException(id, { ...body, exceptionId: randomUUID() })).status, 409);
  assert.equal((await resolveException(id, { ...body, state: 'COMPLETE' })).status, 400);
  const res = await Promise.all([resolveException(id, body), resolveException(id, body)]);
  assert.deepEqual(
    res.map((v) => v.status),
    [200, 200],
  );
  assert.equal(res.filter((v) => v.data.duplicate).length, 1);
  assert.equal(await db.deliveryLabResolution.count(), 1);
  assert.equal(await db.businessAudit.count({ where: { action: 'DELIVERY_LAB_RESOLVE' } }), 1);
  assert.equal((await resolveException(id, { ...body, key: randomUUID() })).status, 409);
  assert.equal((await resolveException(id, body, f.extraCookies[0]!)).status, 409);
  const fact = await db.deliveryLabResolution.findFirstOrThrow();
  await assert.rejects(
    db.deliveryLabResolution.update({ where: { id: fact.id }, data: { key: randomUUID() } }),
  );
  await assert.rejects(db.deliveryLabResolution.delete({ where: { id: fact.id } }));
  assert.equal(await db.deliveryLabJourneyFact.count(), 0);
  assert.equal((await stage(id, 'start', { key: randomUUID() })).status, 200);
  assert.equal((await stage(id, 'complete', { key: randomUUID() })).status, 200);
  assert.equal((await resolveException(id, body)).data.duplicate, true);
  assert.equal(await db.deliveryLabException.count(), 1);
});
test('resolution audit rollback and gate protect matching exception, resolver scope and unchanged formal facts', async () => {
  await f.create();
  const db = f.runtime.db;
  const snapshot = async () => ({
    orders: await db.consumerOrder.findMany(),
    stock: await db.stockPosition.findMany(),
    balance: await db.stockBalance.findMany(),
    lots: await db.stockLot.findMany(),
    allocations: await db.orderAllocation.findMany(),
    ledger: await db.stockLedger.findMany(),
    payment: await db.paymentPreparation.findMany(),
  });
  const before = await snapshot();
  const id = await assignedForJourney();
  await accept(id, { key: randomUUID(), packageCount: 1 });
  await stage(id, 'start', { key: randomUUID() });
  await reportException(id, { key: randomUUID(), reason: 'REFUSED' });
  const e = await db.deliveryLabException.findFirstOrThrow(),
    body = { key: randomUUID(), exceptionId: e.id };
  const riderId = await rider();
  await assert.rejects(
    db.deliveryLabResolution.create({
      data: {
        id: randomUUID(),
        exceptionId: e.id,
        assignmentId: e.assignmentId,
        actorId: riderId,
        actorName: '合成骑手',
        key: randomUUID(),
      },
    }),
  );
  await db.$executeRawUnsafe(
    "CREATE FUNCTION fail_resolution_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='DELIVERY_LAB_RESOLVE' THEN RAISE EXCEPTION 'Synthetic fail'; END IF; RETURN NEW; END $$",
  );
  await db.$executeRawUnsafe(
    'CREATE TRIGGER fail_resolution_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_resolution_audit()',
  );
  assert.equal((await resolveException(id, body)).status, 500);
  assert.equal(await db.deliveryLabResolution.count(), 0);
  assert.equal((await stage(id, 'complete', { key: randomUUID() })).status, 409);
  await db.$executeRawUnsafe('DROP TRIGGER fail_resolution_audit ON business_audits');
  assert.equal((await resolveException(id, body)).status, 200);
  assert.equal((await stage(id, 'complete', { key: randomUUID() })).status, 200);
  assert.deepEqual(await snapshot(), before);
  await f.cleanup();
  f = await pickingFixture();
  assert.equal((await resolveException(randomUUID(), body)).status, 503);
});
