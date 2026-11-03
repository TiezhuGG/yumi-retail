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
    rider = await f.workerActor('RIDER'),
    p = f.deliveryPrefix + '/' + s.id;
  assert.equal((await f.assign(s.id, rider.id)).status, 200);
  const read = async (cookie = f.cookie) => (await f.deliveryRead(s.id, cookie)).data.items[0]!;
  const accept = async (actor = rider) => {
    const v = await read(actor.cookie);
    assert.equal(
      (
        await f.api(
          p + '/accept',
          {
            assignmentId: v.assignment!.id,
            packageCount: v.packageCount,
            physicalConfirmed: true,
            lines: v.lines.map((l) => ({ allocationId: l.allocationId, quantity: l.quantity })),
          },
          randomUUID(),
          actor.cookie,
          actor.csrf,
        )
      ).status,
      200,
    );
  };
  await accept();
  const body = async () => {
    const v = await read();
    return {
      handoffId: v.handoff!.id,
      reason: '合成完整完好实物回交，重新安排配送',
      packageCount: v.packageCount,
      lines: v.lines.map((l) => ({ allocationId: l.allocationId, quantity: l.quantity })),
      intactCustodyConfirmed: true,
      redispatchConfirmed: true,
    };
  };
  const post = (action: string, b: unknown, actor = rider) =>
    f.api(p + '/' + action, b, randomUUID(), actor.cookie, actor.csrf);
  return { s, rider, p, read, accept, body, post };
}
async function snapshot(f: F) {
  const d = f.runtime.db;
  return {
    stock: await d.stockBalance.findMany(),
    positions: await d.stockPosition.findMany(),
    lots: await d.stockLot.findMany(),
    ledger: await d.stockLedger.count(),
    positionLedger: await d.positionLedger.count(),
    points: await d.pointsAccount.findMany(),
    entries: await d.pointsEntry.count(),
    orders: await d.redemptionOrder.findMany(),
    allocations: await d.redemptionAllocation.findMany(),
  };
}
test('full custody return ends old attempt, retains journey and exception, permits a fresh rider receipt and completion without touching stock/points', async () =>
  setup(async (f, c) => {
    const v = await c.read(),
      before = await snapshot(f),
      h = v.handoff!.id;
    assert.equal((await c.post('start', { handoffId: h, departureConfirmed: true })).status, 200);
    assert.equal(
      (await c.post('exception', { handoffId: h, kind: 'CONTACT_FAILED', reason: '合成联系失败' }))
        .status,
      200,
    );
    const b = await c.body(),
      k = randomUUID();
    assert.equal((await f.api(c.p + '/return-custody', b, k)).status, 200);
    assert.equal((await f.api(c.p + '/return-custody', b, k)).status, 200);
    assert.equal((await f.api(c.p + '/return-custody', { ...b, reason: '变更' }, k)).status, 409);
    let current = await c.read();
    assert.equal(current.state, 'UNASSIGNED');
    assert.equal(current.returnHistory[0]!.hadStarted, true);
    assert.equal(current.returnHistory[0]!.exceptions[0]!.resolved, false);
    assert.equal(current.exception, null);
    assert.equal((await f.deliveryRead(c.s.id, c.rider.cookie)).status, 404);
    assert.equal((await f.deliveryRead(undefined, c.rider.cookie)).data.items.length, 0);
    assert.equal((await c.post('start', { handoffId: h, departureConfirmed: true })).status, 404);
    const consumer = (await f.call('/consumer/redemptions/' + c.s.orderId)).data;
    assert.equal(consumer.deliveryReturnRecorded, true);
    assert.equal(consumer.deliveryExceptionReported, false);
    assert.equal(consumer.fulfillmentState, 'SHIPPED_WAIT_HANDOFF');
    assert.equal('returnHistory' in consumer, false);
    const other = await f.workerActor('RIDER');
    assert.equal((await f.assign(c.s.id, other.id)).status, 200);
    await c.accept(other);
    current = await c.read();
    assert.notEqual(current.handoff!.id, h);
    assert.equal(current.journey.start, null);
    assert.equal(
      (await c.post('start', { handoffId: current.handoff!.id, departureConfirmed: true }, other))
        .status,
      200,
    );
    current = await c.read();
    assert.equal(
      (
        await c.post(
          'complete',
          { startId: current.journey.start!.id, deliveryConfirmed: true },
          other,
        )
      ).status,
      200,
    );
    assert.equal((await f.api(c.p + '/return-custody', await c.body())).status, 409);
    assert.equal((await f.assign(c.s.id, c.rider.id)).status, 409);
    assert.deepEqual(await snapshot(f), before);
    assert.equal(await f.runtime.db.redemptionHandoff.count(), 2);
    assert.equal(await f.runtime.db.redemptionCustodyReturn.count(), 1);
    await assert.rejects(f.runtime.db.redemptionCustodyReturn.deleteMany());
    await assert.rejects(
      f.runtime.db.redemptionCustodyReturnLine.updateMany({ data: { quantity: 2 } }),
    );
  }));
test('current scoped manager recovers disabled former rider and assigner; freeze does not prevent custody but prevents redispatch', async () =>
  setup(async (f, c) => {
    const d = f.runtime.db,
      v = await c.read(),
      b = await c.body(),
      manager = await f.workerActor('WAREHOUSE_MANAGER');
    const a = await d.redemptionAssignment.findUniqueOrThrow({ where: { id: v.assignment!.id } });
    await d.staff.update({ where: { id: c.rider.id }, data: { enabled: false } });
    await d.staff.update({ where: { id: a.actorId }, data: { enabled: false } });
    const o = await d.redemptionOrder.findUniqueOrThrow({ where: { id: c.s.orderId } }),
      where = { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: o.skuId } };
    await d.stockBalance.update({ where, data: { inventoryHold: true } });
    const post = (action: string, body: unknown) =>
      f.api(c.p + '/' + action, body, randomUUID(), manager.cookie, manager.csrf);
    assert.equal((await post('return-custody', b)).status, 200);
    const other = await f.workerActor('RIDER');
    assert.equal((await post('assign', { riderId: other.id })).status, 409);
    await d.stockBalance.update({ where, data: { inventoryHold: false } });
    assert.equal((await post('assign', { riderId: other.id })).status, 200);
    await c.accept(other);
  }));
test('strict source/role/full-count checks reject partial or unconfirmed return; SQL validates complete lines and ended attempt cannot append facts', async () =>
  setup(async (f, c) => {
    const b = await c.body(),
      d = f.runtime.db,
      v = await c.read();
    assert.equal((await c.post('return-custody', b)).status, 403);
    for (const body of [
      { ...b, intactCustodyConfirmed: false },
      { ...b, redispatchConfirmed: false },
      { ...b, extra: true },
      { ...b, reason: '' },
      { ...b, lines: [b.lines[0], b.lines[0]] },
      { ...b, packageCount: 1.5 },
    ])
      assert.equal((await f.api(c.p + '/return-custody', body)).status, 400);
    for (const body of [
      { ...b, handoffId: randomUUID() },
      { ...b, packageCount: 1 },
      { ...b, lines: b.lines.map((l) => ({ ...l, quantity: l.quantity + 1 })) },
    ])
      assert.equal((await f.api(c.p + '/return-custody', body)).status, 409);
    const otherWarehouse = randomUUID();
    await d.warehouse.create({
      data: { id: otherWarehouse, code: 'OTHER-RETURN', name: '合成另一仓' },
    });
    const foreign = await f.workerActor('WAREHOUSE_MANAGER', otherWarehouse);
    assert.equal(
      (await f.api(c.p + '/return-custody', b, randomUUID(), foreign.cookie, foreign.csrf)).status,
      403,
    );
    const manager = await d.redemptionAssignment.findUniqueOrThrow({
      where: { id: v.assignment!.id },
    });
    await assert.rejects(
      d.redemptionCustodyReturn.create({
        data: {
          id: randomUUID(),
          handoffId: b.handoffId,
          shipmentId: c.s.id,
          orderId: c.s.orderId,
          actorId: manager.actorId,
          actorName: manager.actorName,
          reason: '缺行',
          packageCount: 2,
          requestId: randomUUID(),
        },
      }),
    );
    assert.equal((await f.api(c.p + '/return-custody', b)).status, 200);
    await assert.rejects(
      d.redemptionJourneyFact.create({
        data: {
          id: randomUUID(),
          handoffId: b.handoffId,
          orderId: c.s.orderId,
          kind: 'START',
          actorId: c.rider.id,
          requestId: randomUUID(),
        },
      }),
    );
    await assert.rejects(
      d.redemptionDeliveryException.create({
        data: {
          id: randomUUID(),
          handoffId: b.handoffId,
          orderId: c.s.orderId,
          actorId: c.rider.id,
          kind: 'OTHER',
          reason: '回交后追加',
          requestId: randomUUID(),
        },
      }),
    );
  }));
test('return competes with completion; exactly one custody outcome commits', async () =>
  setup(async (f, c) => {
    let v = await c.read();
    assert.equal(
      (await c.post('start', { handoffId: v.handoff!.id, departureConfirmed: true })).status,
      200,
    );
    v = await c.read();
    const rs = await Promise.all([
      f.api(c.p + '/return-custody', await c.body()),
      c.post('complete', { startId: v.journey.start!.id, deliveryConfirmed: true }),
    ]);
    assert.equal(rs.filter((r) => r.status === 200).length, 1);
    assert.ok(rs.every((r) => [200, 404, 409].includes(r.status)));
    assert.equal(
      (await f.runtime.db.redemptionCustodyReturn.count()) +
        (await f.runtime.db.redemptionJourneyFact.count({ where: { kind: 'COMPLETE' } })),
      1,
    );
  }));
test('late return audit failure rolls back and original request recovers once; a second return and intermediate unreceived withdrawal retain all attempts', async () =>
  setup(async (f, c) => {
    const d = f.runtime.db,
      b = await c.body(),
      k = randomUUID();
    await d.$executeRawUnsafe(
      `CREATE FUNCTION fail_return_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='REDEMPTION_CUSTODY_RETURN' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$`,
    );
    await d.$executeRawUnsafe(
      'CREATE TRIGGER fail_return_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_return_audit()',
    );
    assert.equal((await f.api(c.p + '/return-custody', b, k)).status, 500);
    assert.equal(await d.redemptionCustodyReturn.count(), 0);
    assert.equal((await c.read()).state, 'HANDED_OVER');
    await d.$executeRawUnsafe('DROP TRIGGER fail_return_audit ON business_audits');
    assert.equal((await f.api(c.p + '/return-custody', b, k)).status, 200);
    assert.equal((await f.api(c.p + '/return-custody', b, k)).status, 200);
    assert.equal((await f.assign(c.s.id, c.rider.id)).status, 200);
    let v = await c.read();
    assert.equal(
      (
        await f.api(c.p + '/withdraw', {
          assignmentId: v.assignment!.id,
          reason: '合成撤回中间分配',
          warehouseCustodyConfirmed: true,
        })
      ).status,
      200,
    );
    assert.equal((await f.assign(c.s.id, c.rider.id)).status, 200);
    await c.accept();
    v = await c.read();
    assert.equal(v.journey.start, null);
    const next = await c.body();
    const rs = await Promise.all([
      f.api(c.p + '/return-custody', next),
      f.api(c.p + '/return-custody', next),
    ]);
    assert.deepEqual(rs.map((x) => x.status).sort(), [200, 409]);
    assert.equal((await c.read()).returnHistory.length, 2);
    assert.equal(await d.redemptionHandoff.count(), 2);
    assert.equal(await d.redemptionCustodyReturnLine.count(), 2);
  }));
