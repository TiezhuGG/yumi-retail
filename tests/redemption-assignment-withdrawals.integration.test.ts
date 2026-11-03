import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { redemptionDeliveryFixture } from './helpers/redemption-delivery-fixture.ts';
type F = Awaited<ReturnType<typeof redemptionDeliveryFixture>>;
async function setup(work: (f: F, c: Awaited<ReturnType<typeof context>>) => Promise<void>) {
  const f = await redemptionDeliveryFixture();
  try {
    await work(f, await context(f));
  } finally {
    await f.cleanup();
  }
}
async function context(f: F) {
  const s = await f.shipment(),
    rider = await f.workerActor('RIDER');
  assert.equal((await f.assign(s.id, rider.id)).status, 200);
  const p = f.deliveryPrefix + '/' + s.id;
  const read = async (cookie = f.cookie) => (await f.deliveryRead(s.id, cookie)).data.items[0]!;
  const a = (await read()).assignment!;
  const body = {
    assignmentId: a.id,
    reason: '合成换班，全部包裹仍在仓库',
    warehouseCustodyConfirmed: true,
  };
  const accept = async (cookie = f.cookie) => {
    const v = await read(cookie);
    return {
      assignmentId: v.assignment!.id,
      packageCount: v.packageCount,
      physicalConfirmed: true,
      lines: v.lines.map((l) => ({ allocationId: l.allocationId, quantity: l.quantity })),
    };
  };
  return { s, rider, p, read, a, body, accept };
}
async function snapshot(f: F) {
  const d = f.runtime.db;
  return {
    stock: await d.stockBalance.findMany(),
    positions: await d.stockPosition.findMany(),
    lots: await d.stockLot.findMany(),
    ledger: await d.stockLedger.count(),
    points: await d.pointsAccount.findMany(),
    entries: await d.pointsEntry.count(),
    orders: await d.redemptionOrder.findMany(),
    allocations: await d.redemptionAllocation.findMany(),
  };
}
test('withdrawal retains facts, hides former rider, reassigns and receives using a new credential without touching stock or points', async () =>
  setup(async (f, c) => {
    const before = await snapshot(f),
      oldBody = await c.accept(),
      k = randomUUID();
    assert.equal((await f.api(c.p + '/withdraw', c.body, k)).status, 200);
    assert.equal((await f.api(c.p + '/withdraw', c.body, k)).status, 200);
    assert.equal(
      (await f.api(c.p + '/withdraw', { ...c.body, reason: 'different' }, k)).status,
      409,
    );
    assert.equal((await c.read()).state, 'UNASSIGNED');
    assert.equal((await c.read()).assignmentHistory[0]!.withdrawal!.reason, c.body.reason);
    assert.equal((await f.deliveryRead(c.s.id, c.rider.cookie)).status, 404);
    assert.equal((await f.deliveryRead(undefined, c.rider.cookie)).data.items.length, 0);
    assert.equal(
      (await f.api(c.p + '/accept', oldBody, randomUUID(), c.rider.cookie, c.rider.csrf)).status,
      404,
    );
    assert.equal(
      (await f.call('/consumer/redemptions/' + c.s.orderId)).data.fulfillmentState,
      'SHIPPED_WAIT_HANDOFF',
    );
    const other = await f.workerActor('RIDER');
    assert.equal((await f.assign(c.s.id, other.id)).status, 200);
    const v = (await f.deliveryRead(c.s.id, other.cookie)).data.items[0]!;
    assert.equal(v.assignmentHistory.length, 0);
    assert.notEqual(v.assignment!.id, c.a.id);
    assert.equal(
      (
        await f.api(
          c.p + '/accept',
          await c.accept(other.cookie),
          randomUUID(),
          other.cookie,
          other.csrf,
        )
      ).status,
      200,
    );
    assert.equal((await c.read()).state, 'HANDED_OVER');
    assert.equal((await c.read()).assignmentHistory.length, 2);
    assert.equal(
      (await f.api(c.p + '/withdraw', { ...c.body, assignmentId: v.assignment!.id })).status,
      409,
    );
    assert.deepEqual(await snapshot(f), before);
    await assert.rejects(f.runtime.db.redemptionAssignmentWithdrawal.deleteMany());
    await assert.rejects(f.runtime.db.redemptionAssignment.deleteMany());
  }));
test('current scoped manager can recover a revoked rider or assigner; frozen goods still block new assignments', async () =>
  setup(async (f, c) => {
    const manager = await f.workerActor('WAREHOUSE_MANAGER'),
      d = f.runtime.db;
    await d.staff.update({ where: { id: c.rider.id }, data: { enabled: false } });
    await d.staff.update({
      where: {
        id: (await d.redemptionAssignment.findUniqueOrThrow({ where: { id: c.a.id } })).actorId,
      },
      data: { enabled: false },
    });
    const post = (action: string, body: unknown) =>
      f.api(c.p + '/' + action, body, randomUUID(), manager.cookie, manager.csrf);
    const o = await d.redemptionOrder.findUniqueOrThrow({ where: { id: c.s.orderId } }),
      where = { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: o.skuId } };
    await d.stockBalance.update({ where, data: { inventoryHold: true } });
    assert.equal((await post('withdraw', c.body)).status, 200);
    const other = await f.workerActor('RIDER');
    assert.equal((await post('assign', { riderId: other.id })).status, 409);
    await d.stockBalance.update({ where, data: { inventoryHold: false } });
    assert.equal((await post('assign', { riderId: other.id })).status, 200);
    assert.equal(
      (
        await f.api(
          c.p + '/accept',
          await c.accept(other.cookie),
          randomUUID(),
          other.cookie,
          other.csrf,
        )
      ).status,
      200,
    );
  }));
test('withdrawal rejects riders, wrong source, missing physical confirmation and extra fields; concurrent receipt settles once', async () =>
  setup(async (f, c) => {
    assert.equal(
      (await f.api(c.p + '/withdraw', c.body, randomUUID(), c.rider.cookie, c.rider.csrf)).status,
      403,
    );
    for (const b of [
      { ...c.body, warehouseCustodyConfirmed: false },
      { ...c.body, extra: true },
      { ...c.body, reason: '' },
    ])
      assert.equal((await f.api(c.p + '/withdraw', b)).status, 400);
    assert.equal(
      (await f.api(c.p + '/withdraw', { ...c.body, assignmentId: randomUUID() })).status,
      409,
    );
    const accept = await c.accept();
    const rs = await Promise.all([
      f.api(c.p + '/withdraw', c.body),
      f.api(c.p + '/accept', accept, randomUUID(), c.rider.cookie, c.rider.csrf),
    ]);
    assert.equal(rs.filter((x) => x.status === 200).length, 1);
    assert.ok(rs.every((x) => [200, 404, 409].includes(x.status)));
    assert.equal(
      (await f.runtime.db.redemptionAssignmentWithdrawal.count()) +
        (await f.runtime.db.redemptionHandoff.count()),
      1,
    );
  }));
test('competing withdrawals and reassignments settle once; SQL prevents stale receipt; late audit failure rolls back', async () =>
  setup(async (f, c) => {
    const d = f.runtime.db,
      k = randomUUID();
    await d.$executeRawUnsafe(
      `CREATE FUNCTION fail_withdrawal_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='REDEMPTION_DELIVERY_WITHDRAW' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$`,
    );
    await d.$executeRawUnsafe(
      'CREATE TRIGGER fail_withdrawal_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_withdrawal_audit()',
    );
    assert.equal((await f.api(c.p + '/withdraw', c.body, k)).status, 500);
    assert.equal(await d.redemptionAssignmentWithdrawal.count(), 0);
    assert.equal((await c.read()).state, 'ASSIGNED');
    await d.$executeRawUnsafe('DROP TRIGGER fail_withdrawal_audit ON business_audits');
    const rs = await Promise.all([
      f.api(c.p + '/withdraw', c.body, k),
      f.api(c.p + '/withdraw', c.body),
    ]);
    assert.deepEqual(rs.map((x) => x.status).sort(), [200, 409]);
    const other = await f.workerActor('RIDER');
    const as = await Promise.all([f.assign(c.s.id, other.id), f.assign(c.s.id, other.id)]);
    assert.deepEqual(as.map((x) => x.status).sort(), [200, 409]);
    await assert.rejects(
      d.redemptionHandoff.create({
        data: {
          id: randomUUID(),
          assignmentId: c.a.id,
          shipmentId: c.s.id,
          orderId: c.s.orderId,
          actorId: c.rider.id,
          packageCount: 2,
          requestId: randomUUID(),
        },
      }),
    );
    assert.equal(await d.redemptionAssignmentWithdrawal.count(), 1);
    assert.equal(await d.redemptionAssignment.count(), 2);
  }));
