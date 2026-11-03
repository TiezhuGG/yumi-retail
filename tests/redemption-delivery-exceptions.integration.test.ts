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

test('rider exception is immutable and idempotent, blocks start/complete and projects consumer without private note', async () =>
  setup(async (f, c) => {
    await c.accept();
    const before = await snapshot(f);
    const v = await c.read(),
      body = { handoffId: v.handoff!.id, kind: 'CONTACT_FAILED', reason: '合成异常说明' },
      k = randomUUID();
    assert.equal((await c.post('exception', body, k)).status, 200);
    assert.equal((await c.post('exception', body, k)).status, 200);
    assert.equal((await c.post('exception', { ...body, reason: '更改说明' }, k)).status, 409);
    assert.equal((await c.read()).exception?.reason, body.reason);
    assert.equal((await c.read()).canStart, false);
    assert.equal((await c.post('start', await c.body('start'))).status, 409);
    const consumer = (await f.call('/consumer/redemptions/' + c.s.orderId)).data;
    assert.equal(consumer.deliveryExceptionReported, true);
    assert.ok(!JSON.stringify(consumer).includes(body.reason));
    assert.deepEqual(await snapshot(f), before);
    assert.equal(await f.runtime.db.redemptionDeliveryException.count(), 1);
    await assert.rejects(f.runtime.db.redemptionDeliveryException.deleteMany());
    await assert.rejects(
      f.runtime.db.redemptionJourneyFact.create({
        data: {
          id: randomUUID(),
          handoffId: v.handoff!.id,
          orderId: c.s.orderId,
          kind: 'START',
          actorId: c.rider.id,
          requestId: randomUUID(),
        },
      }),
    );
  }));
test('only assigned rider after receipt may report, completion and exception race is serialized', async () =>
  setup(async (f, c) => {
    assert.equal(
      (await c.post('exception', { handoffId: randomUUID(), kind: 'OTHER', reason: '无接货' }))
        .status,
      409,
    );
    await c.accept();
    const v = await c.read(),
      body = { handoffId: v.handoff!.id, kind: 'DAMAGED', reason: '合成包裹破损' };
    assert.equal((await f.api(c.p + '/exception', body)).status, 403);
    assert.equal((await c.post('exception', { ...body, kind: 'BAD' })).status, 400);
    assert.equal((await c.post('exception', { ...body, status: 'DELIVERED' })).status, 400);
    await c.post('start', await c.body('start'));
    const rs = await Promise.all([
      c.post('exception', body),
      c.post('complete', await c.body('complete')),
    ]);
    assert.equal(rs.filter((x) => x.status === 200).length, 1);
    assert.equal(rs.filter((x) => x.status === 409).length, 1);
  }));
test('late exception audit failure rolls back, original key recovers once', async () =>
  setup(async (f, c) => {
    await c.accept();
    const v = await c.read(),
      body = { handoffId: v.handoff!.id, kind: 'ADDRESS_ISSUE', reason: '合成地址异常' },
      k = randomUUID();
    await f.runtime.db.$executeRawUnsafe(
      `CREATE FUNCTION fail_delivery_exception_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='REDEMPTION_DELIVERY_EXCEPTION' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$`,
    );
    await f.runtime.db.$executeRawUnsafe(
      'CREATE TRIGGER fail_delivery_exception_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_delivery_exception_audit()',
    );
    assert.equal((await c.post('exception', body, k)).status, 500);
    assert.equal(await f.runtime.db.redemptionDeliveryException.count(), 0);
    await f.runtime.db.$executeRawUnsafe(
      'DROP TRIGGER fail_delivery_exception_audit ON business_audits',
    );
    assert.equal((await c.post('exception', body, k)).status, 200);
    assert.equal((await c.post('exception', body, k)).status, 200);
    assert.equal(await f.runtime.db.redemptionDeliveryException.count(), 1);
  }));
