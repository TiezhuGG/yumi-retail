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
  const read = async () => (await f.deliveryRead(s.id, rider.cookie)).data.items[0]!;
  const post = (action: string, body: unknown, key = randomUUID()) =>
    f.api(p + '/' + action, body, key, rider.cookie, rider.csrf);
  const accept = async () => {
    const v = await read();
    assert.equal(
      (
        await post('accept', {
          assignmentId: v.assignment!.id,
          packageCount: v.packageCount,
          lines: v.lines.map((l) => ({ allocationId: l.allocationId, quantity: l.quantity })),
          physicalConfirmed: true,
        })
      ).status,
      200,
    );
  };
  const body = async (action: string) => {
    const v = await read();
    return action === 'start'
      ? { handoffId: v.handoff!.id, departureConfirmed: true }
      : { startId: v.journey.start!.id, deliveryConfirmed: true };
  };
  return { s, rider, p, read, post, accept, body };
}
async function snapshot(f: F) {
  const d = f.runtime.db;
  return {
    stock: await d.stockBalance.findMany(),
    pos: await d.stockPosition.findMany(),
    lot: await d.stockLot.findMany(),
    ledger: await d.stockLedger.count(),
    positionLedger: await d.positionLedger.count(),
    points: await d.pointsAccount.findMany(),
    pointsLedger: await d.pointsEntry.count(),
    orders: await d.redemptionOrder.findMany(),
    allocations: await d.redemptionAllocation.findMany(),
  };
}

async function report(c: Awaited<ReturnType<typeof context>>) {
  const v = await c.read();
  assert.equal(
    (
      await c.post('exception', {
        handoffId: v.handoff!.id,
        kind: 'CONTACT_FAILED',
        reason: '合成无法联系',
      })
    ).status,
    200,
  );
  return (await c.read()).exception!.id;
}
test('manager resolution retains history, original rider resumes and repeated incidents remain reportable', async () =>
  setup(async (f, c) => {
    await c.accept();
    const before = await snapshot(f);
    const id = await report(c),
      body = { exceptionId: id, reason: '已核实可按原地址继续', continuationConfirmed: true },
      k = randomUUID();
    const resolve = () => f.api(c.p + '/resolve', body, k);
    assert.equal((await resolve()).status, 200);
    assert.equal((await resolve()).status, 200);
    assert.ok((await c.read()).exception!.resolution);
    assert.equal((await c.read()).canStart, true);
    assert.equal(
      (await f.call('/consumer/redemptions/' + c.s.orderId)).data.deliveryExceptionReported,
      false,
    );
    assert.equal((await c.post('start', await c.body('start'))).status, 200);
    const second = await report(c);
    assert.notEqual(id, second);
    assert.equal((await c.read()).canComplete, false);
    assert.equal((await f.api(c.p + '/resolve', { ...body, exceptionId: second })).status, 200);
    assert.equal((await c.post('complete', await c.body('complete'))).status, 200);
    assert.equal((await c.read()).exceptionHistory.length, 2);
    assert.deepEqual(await snapshot(f), before);
    await assert.rejects(f.runtime.db.redemptionDeliveryResolution.deleteMany());
    await assert.rejects(f.runtime.db.redemptionDeliveryException.deleteMany());
  }));
test('resolution requires scoped manager, correct unresolved source, confirmation and safe inventory; concurrent requests settle once', async () =>
  setup(async (f, c) => {
    await c.accept();
    const id = await report(c),
      body = { exceptionId: id, reason: '合成核实', continuationConfirmed: true };
    assert.equal((await c.post('resolve', body)).status, 403);
    assert.equal(
      (await f.api(c.p + '/resolve', { ...body, continuationConfirmed: false })).status,
      400,
    );
    assert.equal(
      (await f.api(c.p + '/resolve', { ...body, exceptionId: randomUUID() })).status,
      409,
    );
    const o = await f.runtime.db.redemptionOrder.findUniqueOrThrow({ where: { id: c.s.orderId } });
    await f.runtime.db.stockBalance.update({
      where: { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: o.skuId } },
      data: { inventoryHold: true },
    });
    assert.equal((await f.api(c.p + '/resolve', body)).status, 409);
    assert.equal((await c.read()).exception!.resolution, null);
    await f.runtime.db.stockBalance.update({
      where: { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: o.skuId } },
      data: { inventoryHold: false },
    });
    const rs = await Promise.all([f.api(c.p + '/resolve', body), f.api(c.p + '/resolve', body)]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
    assert.equal(await f.runtime.db.redemptionDeliveryResolution.count(), 1);
  }));
test('late resolution audit failure rolls back and original request recovers once', async () =>
  setup(async (f, c) => {
    await c.accept();
    const id = await report(c),
      body = { exceptionId: id, reason: '核实完成', continuationConfirmed: true },
      k = randomUUID();
    await f.runtime.db.$executeRawUnsafe(
      `CREATE FUNCTION fail_resolution_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='REDEMPTION_DELIVERY_RESOLVE' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$`,
    );
    await f.runtime.db.$executeRawUnsafe(
      'CREATE TRIGGER fail_resolution_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_resolution_audit()',
    );
    assert.equal((await f.api(c.p + '/resolve', body, k)).status, 500);
    assert.equal(await f.runtime.db.redemptionDeliveryResolution.count(), 0);
    assert.equal((await c.read()).canStart, false);
    await f.runtime.db.$executeRawUnsafe('DROP TRIGGER fail_resolution_audit ON business_audits');
    assert.equal((await f.api(c.p + '/resolve', body, k)).status, 200);
    assert.equal((await f.api(c.p + '/resolve', body, k)).status, 200);
  }));
