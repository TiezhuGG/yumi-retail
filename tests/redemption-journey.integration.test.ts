import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { redemptionDeliveryFixture } from './helpers/redemption-delivery-fixture.ts';
import { RedemptionDeliveryService } from '../apps/api/dist/redemption-delivery.js';
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
test('real receipt -> start -> rider completion projects all views, retains quota/order and changes no points or stock', async () =>
  setup(async (f, c) => {
    await c.accept();
    const before = await snapshot(f);
    for (const [action, state] of [
      ['start', 'DELIVERING'],
      ['complete', 'DELIVERED'],
    ] as const) {
      const b = await c.body(action),
        k = randomUUID();
      assert.equal((await c.post(action, b, k)).status, 200);
      assert.equal((await c.post(action, b, k)).status, 200);
      assert.equal((await c.read()).state, state);
      assert.equal(
        (await f.call('/consumer/redemptions/' + c.s.orderId)).data.fulfillmentState,
        state,
      );
      assert.equal(
        (await f.read(c.s.orderId)).data.items[0]!.packing.shipment!.deliveryState,
        state,
      );
      assert.equal((await c.post(action, b)).error?.code, 'JOURNEY_ALREADY_RECORDED');
      assert.equal(
        (await f.call('/consumer/redemptions/' + c.s.orderId + '/cancel', { version: 0 })).status,
        409,
      );
    }
    assert.deepEqual(await snapshot(f), before);
    assert.equal(await f.runtime.db.redemptionJourneyFact.count(), 2);
    assert.equal(await f.runtime.db.deliveryLabAssignment.count(), 0);
    const page = (await f.deliveryRead(undefined, c.rider.cookie, '?status=DELIVERED')).data;
    assert.equal(page.items.length, 1);
    assert.equal('address' in page.items[0]!, false);
    for (const status of ['HANDED_OVER', 'DELIVERING', 'ASSIGNED'])
      assert.equal(
        (await f.deliveryRead(undefined, c.rider.cookie, '?status=' + status)).data.items.length,
        0,
      );
  }));
test('cannot skip receipt/start, use another phase source, omit physical assertion or inject fields', async () =>
  setup(async (_, c) => {
    assert.equal(
      (await c.post('start', { handoffId: randomUUID(), departureConfirmed: true })).error?.code,
      'JOURNEY_SEQUENCE_REQUIRED',
    );
    assert.equal(
      (await c.post('complete', { startId: randomUUID(), deliveryConfirmed: true })).error?.code,
      'JOURNEY_SEQUENCE_REQUIRED',
    );
    await c.accept();
    assert.equal(
      (await c.post('start', { handoffId: randomUUID(), departureConfirmed: true })).error?.code,
      'JOURNEY_SOURCE_CHANGED',
    );
    const b = await c.body('start');
    assert.equal((await c.post('start', { ...b, departureConfirmed: false })).status, 400);
    assert.equal((await c.post('start', { ...b, status: 'DELIVERED' })).status, 400);
    assert.equal((await c.post('start', b)).status, 200);
    assert.equal(
      (await c.post('complete', { startId: (await c.read()).handoff!.id, deliveryConfirmed: true }))
        .error?.code,
      'JOURNEY_SOURCE_CHANGED',
    );
  }));
test('only assigned currently scoped rider may work; managers cannot proxy and lost permissions block replay', async () =>
  setup(async (f, c) => {
    await c.accept();
    const b = await c.body('start'),
      other = await f.workerActor('RIDER'),
      k = randomUUID();
    assert.equal((await f.api(c.p + '/start', b)).status, 403);
    assert.equal(
      (await f.api(c.p + '/start', b, randomUUID(), other.cookie, other.csrf)).status,
      404,
    );
    assert.equal((await c.post('start', b, k)).status, 200);
    await f.runtime.db.staffRole.deleteMany({ where: { staffId: c.rider.id, roleCode: 'RIDER' } });
    assert.equal((await c.post('start', b, k)).status, 403);
  }));
test('concurrent independent start and completion requests each commit exactly one fact', async () =>
  setup(async (f, c) => {
    await c.accept();
    for (const action of ['start', 'complete']) {
      const b = await c.body(action);
      const rs = await Promise.all([c.post(action, b), c.post(action, b)]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
    }
    assert.equal(await f.runtime.db.redemptionJourneyFact.count(), 2);
  }));
test('original key rejects changed source and 503 gate protects both phases', async () =>
  setup(async (f, c) => {
    await c.accept();
    const svc = f.runtime.app.get(RedemptionDeliveryService);
    for (const action of ['start', 'complete']) {
      const b = await c.body(action),
        k = randomUUID();
      Object.defineProperty(svc, 'enabled', { value: false, configurable: true });
      assert.equal((await c.post(action, b, k)).status, 503);
      Object.defineProperty(svc, 'enabled', { value: true });
      assert.equal((await c.post(action, b, k)).status, 200);
      const changed =
        action === 'start'
          ? { handoffId: randomUUID(), departureConfirmed: true }
          : { startId: randomUUID(), deliveryConfirmed: true };
      assert.equal((await c.post(action, changed, k)).error?.code, 'IDEMPOTENCY_CONFLICT');
    }
  }));
test('source inventory hold and original manager revocation block journey while retaining immutable receipt', async () =>
  setup(async (f, c) => {
    await c.accept();
    const db = f.runtime.db,
      where = { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.catalog.skuIds[0]! } };
    await db.stockBalance.update({ where, data: { inventoryHold: true } });
    assert.equal((await c.post('start', await c.body('start'))).error?.code, 'DELIVERY_BLOCKED');
    await db.stockBalance.update({ where, data: { inventoryHold: false } });
    assert.equal((await c.post('start', await c.body('start'))).status, 200);
    const manager = await db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } });
    await db.staffWarehouse.deleteMany({ where: { staffId: manager.id } });
    assert.equal(
      (await c.post('complete', await c.body('complete'))).error?.code,
      'DELIVERY_PERSON_UNAVAILABLE',
    );
    assert.equal(await db.redemptionJourneyFact.count(), 1);
    assert.equal(await db.redemptionHandoff.count(), 1);
  }));
test('late audit errors roll back facts and idempotency; original requests recover once', async () =>
  setup(async (f, c) => {
    await c.accept();
    const db = f.runtime.db;
    await db.$executeRawUnsafe(
      "CREATE FUNCTION reject_journey() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('REDEMPTION_DELIVERY_START','REDEMPTION_DELIVERY_COMPLETE') THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$",
    );
    for (const action of ['start', 'complete']) {
      const b = await c.body(action),
        k = randomUUID(),
        before = await snapshot(f),
        count = await db.redemptionJourneyFact.count();
      await db.$executeRawUnsafe(
        'CREATE TRIGGER reject_journey BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION reject_journey()',
      );
      assert.equal((await c.post(action, b, k)).status, 500);
      assert.equal(await db.redemptionJourneyFact.count(), count);
      assert.deepEqual(await snapshot(f), before);
      await db.$executeRawUnsafe('DROP TRIGGER reject_journey ON business_audits');
      assert.equal((await c.post(action, b, k)).status, 200);
      assert.equal((await c.post(action, b, k)).status, 200);
    }
  }));
test('SQL rejects skipped phases, wrong actor and cross-order start and prohibits editing/deleting facts', async () =>
  setup(async (f, c) => {
    await c.accept();
    const db = f.runtime.db,
      h = (await c.read()).handoff!;
    const base = {
      id: randomUUID(),
      handoffId: h.id,
      orderId: c.s.orderId,
      kind: 'START',
      actorId: c.rider.id,
      requestId: randomUUID(),
    };
    await assert.rejects(
      db.redemptionJourneyFact.create({
        data: { ...base, kind: 'COMPLETE', startId: randomUUID() },
      }),
    );
    const other = await f.workerActor('RIDER');
    await assert.rejects(db.redemptionJourneyFact.create({ data: { ...base, actorId: other.id } }));
    assert.equal((await c.post('start', await c.body('start'))).status, 200);
    await assert.rejects(db.redemptionJourneyFact.updateMany({ data: { kind: 'COMPLETE' } }));
    await assert.rejects(db.redemptionJourneyFact.deleteMany());
    const s2 = await f.shipment();
    await f.assign(s2.id, c.rider.id);
    const v = (await f.deliveryRead(s2.id)).data.items[0]!;
    await f.api(
      f.deliveryPrefix + '/' + s2.id + '/accept',
      {
        assignmentId: v.assignment!.id,
        packageCount: v.packageCount,
        lines: v.lines.map((l) => ({ allocationId: l.allocationId, quantity: l.quantity })),
        physicalConfirmed: true,
      },
      randomUUID(),
      c.rider.cookie,
      c.rider.csrf,
    );
    const h2 = (await f.deliveryRead(s2.id)).data.items[0]!.handoff!;
    await assert.rejects(
      db.redemptionJourneyFact.create({
        data: {
          ...base,
          id: randomUUID(),
          handoffId: h2.id,
          orderId: s2.orderId,
          kind: 'COMPLETE',
          startId: (await c.read()).journey.start!.id,
        },
      }),
    );
  }));
for (const phase of ['start', 'complete'])
  test('late rider session expiry rolls back ' + phase, async () =>
    setup(async (f, c) => {
      await c.accept();
      if (phase === 'complete')
        assert.equal((await c.post('start', await c.body('start'))).status, 200);
      const b = await c.body(phase),
        db = f.runtime.db,
        before = await db.redemptionJourneyFact.count();
      await db.$executeRawUnsafe(
        "CREATE FUNCTION slow_journey() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('REDEMPTION_DELIVERY_START','REDEMPTION_DELIVERY_COMPLETE') THEN PERFORM pg_sleep(1); END IF; RETURN NEW; END $$",
      );
      await db.$executeRawUnsafe(
        'CREATE TRIGGER slow_journey BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION slow_journey()',
      );
      await db.staffSession.updateMany({
        where: { staffId: c.rider.id },
        data: { expiresAt: new Date(Date.now() + 700) },
      });
      assert.equal((await c.post(phase, b)).status, 403);
      assert.equal(await db.redemptionJourneyFact.count(), before);
    }),
  );
for (const phase of ['start', 'complete'])
  test('late lot expiry rolls back ' + phase, async () =>
    setup(async (f, c) => {
      await c.accept();
      if (phase === 'complete')
        assert.equal((await c.post('start', await c.body('start'))).status, 200);
      const db = f.runtime.db,
        b = await c.body(phase),
        count = await db.redemptionJourneyFact.count();
      await db.$executeRawUnsafe(
        "CREATE FUNCTION late_journey_expiry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('REDEMPTION_DELIVERY_START','REDEMPTION_DELIVERY_COMPLETE') THEN PERFORM pg_sleep(1); END IF; RETURN NEW; END $$",
      );
      await db.$executeRawUnsafe(
        'CREATE TRIGGER late_journey_expiry BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION late_journey_expiry()',
      );
      const lot = await db.stockLot.findFirstOrThrow({ where: { skuId: f.catalog.skuIds[0]! } });
      await db.stockLot.update({
        where: { id: lot.id },
        data: { producedAt: new Date(0), expiresAt: new Date(Date.now() + 700) },
      });
      assert.equal((await c.post(phase, b)).error?.code, 'DELIVERY_BLOCKED');
      assert.equal(await db.redemptionJourneyFact.count(), count);
    }),
  );
test('transaction rechecks scoped rider after preliminary authorization, preserving original key for recovery', async () =>
  setup(async (f, c) => {
    await c.accept();
    const db = f.runtime.db,
      svc = f.runtime.app.get(RedemptionDeliveryService),
      original = svc.catalog.write.bind(svc.catalog),
      b = await c.body('start'),
      k = randomUUID();
    svc.catalog.write = async (...args) => {
      await db.staffWarehouse.deleteMany({ where: { staffId: c.rider.id } });
      return original(...args);
    };
    try {
      assert.equal((await c.post('start', b, k)).status, 403);
    } finally {
      svc.catalog.write = original;
    }
    assert.equal(await db.redemptionJourneyFact.count(), 0);
    await db.staffWarehouse.create({ data: { staffId: c.rider.id, warehouseId: f.warehouseId } });
    assert.equal((await c.post('start', b, k)).status, 200);
  }));
