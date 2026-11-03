import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { redemptionDeliveryFixture } from './helpers/redemption-delivery-fixture.ts';
import { RedemptionDeliveryService } from '../apps/api/dist/redemption-delivery.js';
type F = Awaited<ReturnType<typeof redemptionDeliveryFixture>>;
async function fixture(work: (f: F, s: { id: string; orderId: string }) => Promise<void>) {
  const f = await redemptionDeliveryFixture();
  try {
    await work(f, await f.shipment());
  } finally {
    await f.cleanup();
  }
}
async function snapshot(f: F) {
  const d = f.runtime.db;
  return {
    stock: await d.stockBalance.findMany({ orderBy: { skuId: 'asc' } }),
    pos: await d.stockPosition.findMany({ orderBy: { id: 'asc' } }),
    lots: await d.stockLot.findMany({ orderBy: { id: 'asc' } }),
    ledger: await d.stockLedger.count(),
    posLedger: await d.positionLedger.count(),
    points: await d.pointsAccount.findMany({ orderBy: { userId: 'asc' } }),
    pointsLedger: await d.pointsEntry.count(),
  };
}
async function receive(f: F, id: string) {
  const v = (await f.deliveryRead(id)).data.items[0]!;
  return {
    assignmentId: v.assignment!.id,
    packageCount: v.packageCount,
    lines: v.lines.map((l) => ({ allocationId: l.allocationId, quantity: l.quantity })),
    physicalConfirmed: true,
  };
}
test('assignment and owner receipt use real shipment snapshots, immutable evidence and original keys without touching points or stock', async () =>
  fixture(async (f, s) => {
    const rider = await f.workerActor('RIDER'),
      before = await snapshot(f),
      p = f.deliveryPrefix + '/' + s.id,
      k = randomUUID();
    assert.equal((await f.assign(s.id, rider.id, k)).status, 200);
    assert.equal((await f.assign(s.id, rider.id, k)).status, 200);
    assert.equal((await f.assign(s.id, rider.id)).error?.code, 'DELIVERY_ALREADY_ASSIGNED');
    assert.equal(
      (await f.call('/consumer/redemptions/' + s.orderId)).data.fulfillmentState,
      'ASSIGNED_WAIT_HANDOFF',
    );
    const body = await receive(f, s.id),
      key = randomUUID();
    assert.equal((await f.api(p + '/accept', body, key, rider.cookie, rider.csrf)).status, 200);
    assert.equal((await f.api(p + '/accept', body, key, rider.cookie, rider.csrf)).status, 200);
    assert.equal(
      (await f.api(p + '/accept', { ...body, packageCount: 1 }, key, rider.cookie, rider.csrf))
        .error?.code,
      'IDEMPOTENCY_CONFLICT',
    );
    assert.equal(
      (await f.api(p + '/accept', body, randomUUID(), rider.cookie, rider.csrf)).error?.code,
      'DELIVERY_ALREADY_ACCEPTED',
    );
    assert.deepEqual(await snapshot(f), before);
    const v = (await f.deliveryRead(s.id, rider.cookie)).data.items[0]!;
    assert.equal(v.state, 'HANDED_OVER');
    assert.equal(v.address!.room, '合成101');
    assert.equal(
      (await f.call('/consumer/redemptions/' + s.orderId)).data.fulfillmentState,
      'RIDER_RECEIVED_WAIT_START',
    );
    assert.equal(
      (await f.call('/consumer/redemptions/' + s.orderId + '/cancel', { version: 0 })).status,
      409,
    );
    assert.equal(await f.runtime.db.redemptionHandoff.count(), 1);
    assert.equal(await f.runtime.db.deliveryLabAssignment.count(), 0);
  }));
test('riders see only their assigned shipments, details alone decrypt addresses, roles and warehouse remain server scoped', async () =>
  fixture(async (f, s) => {
    const rider = await f.workerActor('RIDER'),
      other = await f.workerActor('RIDER'),
      picker = await f.workerActor('PICKER'),
      p = f.deliveryPrefix + '/' + s.id;
    assert.equal((await f.deliveryRead(undefined, rider.cookie)).data.items.length, 0);
    assert.equal((await f.deliveryRead(s.id, rider.cookie)).status, 404);
    assert.equal(
      (await f.api(p + '/assign', { riderId: rider.id }, randomUUID(), rider.cookie, rider.csrf))
        .status,
      403,
    );
    assert.equal((await f.deliveryRead(s.id, picker.cookie)).status, 403);
    assert.equal((await f.assign(s.id, rider.id)).status, 200);
    const list = (await f.deliveryRead(undefined, rider.cookie)).data;
    assert.equal(list.selfOnly, true);
    assert.equal(list.items.length, 1);
    assert.equal('address' in list.items[0]!, false);
    assert.equal(
      (await f.deliveryRead(undefined, rider.cookie, '?status=UNASSIGNED')).data.items.length,
      0,
    );
    assert.equal((await f.deliveryRead(s.id, other.cookie)).status, 404);
    const body = await receive(f, s.id);
    assert.equal(
      (await f.api(p + '/accept', body, randomUUID(), other.cookie, other.csrf)).status,
      404,
    );
    assert.equal((await f.api(p + '/accept', body)).status, 403);
    assert.equal(
      (await f.api(f.deliveryPrefix + '/riders', undefined, randomUUID(), rider.cookie, rider.csrf))
        .status,
      403,
    );
    const w = randomUUID();
    await f.runtime.db.warehouse.create({ data: { id: w, code: 'OTHER', name: '合成另一仓' } });
    const foreign = await f.workerActor('RIDER', w);
    assert.equal(
      (
        await f.api(
          '/warehouse/warehouses/' + w + '/redemption-delivery/' + s.id,
          undefined,
          randomUUID(),
          foreign.cookie,
          foreign.csrf,
        )
      ).status,
      404,
    );
    assert.equal((await f.deliveryRead(s.id, foreign.cookie)).status, 403);
  }));
test('candidate rider selection filters disabled, other-role and other-warehouse staff; unshipped and malformed requests fail', async () =>
  fixture(async (f, s) => {
    const rider = await f.workerActor('RIDER'),
      disabled = await f.workerActor('RIDER'),
      picker = await f.workerActor('PICKER'),
      db = f.runtime.db;
    await db.staff.update({ where: { id: disabled.id }, data: { enabled: false } });
    const list = await f.api(f.deliveryPrefix + '/riders');
    assert.equal(list.status, 200);
    assert.deepEqual(
      list.data.items.map((v) => v.id),
      [rider.id],
    );
    for (const id of [disabled.id, picker.id, randomUUID()])
      assert.equal((await f.assign(s.id, id)).error?.code, 'DELIVERY_PERSON_UNAVAILABLE');
    assert.equal(
      (await f.api(f.deliveryPrefix + '/' + s.id + '/assign', { riderId: rider.id, extra: true }))
        .status,
      400,
    );
    assert.equal(
      (
        await f.api(
          f.deliveryPrefix + '/' + s.id + '/assign',
          { riderId: rider.id },
          randomUUID(),
          f.cookie,
          'bad',
        )
      ).status,
      403,
    );
    const order = await f.order();
    assert.equal((await f.assign(order, rider.id)).status, 404);
    assert.equal((await f.deliveryRead(undefined, f.cookie, '?status=INVALID')).status, 400);
  }));
test('receipt requires exact original package and every allocation, rejects stale assignment, duplicates, fractional and non-physical receipts', async () =>
  fixture(async (f, s) => {
    const rider = await f.workerActor('RIDER');
    assert.equal((await f.assign(s.id, rider.id)).status, 200);
    const b = await receive(f, s.id),
      p = f.deliveryPrefix + '/' + s.id + '/accept';
    for (const body of [
      { ...b, physicalConfirmed: false },
      { ...b, lines: [] },
      { ...b, lines: [...b.lines, ...b.lines] },
      { ...b, lines: [{ ...b.lines[0]!, quantity: 1.1 }] },
    ])
      assert.equal((await f.api(p, body, randomUUID(), rider.cookie, rider.csrf)).status, 400);
    for (const body of [
      { ...b, packageCount: 1 },
      { ...b, lines: [{ allocationId: randomUUID(), quantity: 1 }] },
      { ...b, lines: [{ ...b.lines[0]!, quantity: 2 }] },
    ])
      assert.equal(
        (await f.api(p, body, randomUUID(), rider.cookie, rider.csrf)).error?.code,
        'HANDOFF_QUANTITY_MISMATCH',
      );
    assert.equal(
      (await f.api(p, { ...b, assignmentId: randomUUID() }, randomUUID(), rider.cookie, rider.csrf))
        .error?.code,
      'ASSIGNMENT_CHANGED',
    );
    assert.equal((await f.api(p, b, randomUUID(), rider.cookie, 'bad')).status, 403);
    assert.equal(await f.runtime.db.redemptionHandoff.count(), 0);
  }));
test('competing managers select exactly one rider, two accepts write one receipt and never duplicate stock movement', async () =>
  fixture(async (f, s) => {
    const a = await f.workerActor('RIDER'),
      b = await f.workerActor('RIDER'),
      manager = await f.workerActor('WAREHOUSE_MANAGER'),
      p = f.deliveryPrefix + '/' + s.id;
    const results = await Promise.all([
      f.assign(s.id, a.id),
      f.api(p + '/assign', { riderId: b.id }, randomUUID(), manager.cookie, manager.csrf),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    const assignment = (await f.deliveryRead(s.id)).data.items[0]!.assignment!,
      rider = assignment.riderId === a.id ? a : b,
      body = await receive(f, s.id),
      before = await snapshot(f);
    const race = await Promise.all([
      f.api(p + '/accept', body, randomUUID(), rider.cookie, rider.csrf),
      f.api(p + '/accept', body, randomUUID(), rider.cookie, rider.csrf),
    ]);
    assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
    assert.deepEqual(await snapshot(f), before);
    assert.equal(await f.runtime.db.redemptionAssignment.count(), 1);
    assert.equal(await f.runtime.db.redemptionHandoff.count(), 1);
  }));
test('source freezes, lot expiry and current rider/assigner permissions block new handoff while preserving assignment', async () =>
  fixture(async (f, s) => {
    const rider = await f.workerActor('RIDER'),
      db = f.runtime.db,
      p = f.deliveryPrefix + '/' + s.id;
    assert.equal((await f.assign(s.id, rider.id)).status, 200);
    const body = await receive(f, s.id),
      where = { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.catalog.skuIds[0]! } };
    await db.stockBalance.update({ where, data: { inventoryHold: true } });
    assert.equal(
      (await f.api(p + '/accept', body, randomUUID(), rider.cookie, rider.csrf)).error?.code,
      'DELIVERY_BLOCKED',
    );
    await db.stockBalance.update({ where, data: { inventoryHold: false } });
    const manager = await db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } });
    await db.staffWarehouse.deleteMany({ where: { staffId: manager.id } });
    assert.equal(
      (await f.api(p + '/accept', body, randomUUID(), rider.cookie, rider.csrf)).error?.code,
      'DELIVERY_PERSON_UNAVAILABLE',
    );
    await db.staffWarehouse.create({ data: { staffId: manager.id, warehouseId: f.warehouseId } });
    await db.staffRole.deleteMany({ where: { staffId: rider.id, roleCode: 'RIDER' } });
    assert.equal(
      (await f.api(p + '/accept', body, randomUUID(), rider.cookie, rider.csrf)).status,
      403,
    );
    await db.staffRole.create({ data: { staffId: rider.id, roleCode: 'RIDER' } });
    const lot = await db.stockLot.findFirstOrThrow({ where: { skuId: f.catalog.skuIds[0]! } });
    await db.stockLot.update({
      where: { id: lot.id },
      data: { producedAt: new Date(0), expiresAt: new Date(1) },
    });
    assert.equal(
      (await f.api(p + '/accept', body, randomUUID(), rider.cookie, rider.csrf)).error?.code,
      'DELIVERY_BLOCKED',
    );
    assert.equal(await db.redemptionAssignment.count(), 1);
    assert.equal(await db.redemptionHandoff.count(), 0);
  }));
test('late assignment and receipt audit failures roll back facts; the original requests recover once', async () =>
  fixture(async (f, s) => {
    const rider = await f.workerActor('RIDER'),
      db = f.runtime.db,
      p = f.deliveryPrefix + '/' + s.id;
    await db.$executeRawUnsafe(
      "CREATE FUNCTION reject_delivery_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('REDEMPTION_DELIVERY_ASSIGN','REDEMPTION_DELIVERY_ACCEPT') THEN RAISE EXCEPTION 'synthetic delivery audit failure'; END IF; RETURN NEW; END $$",
    );
    for (const action of ['assign', 'accept']) {
      const body = action === 'assign' ? { riderId: rider.id } : await receive(f, s.id),
        cookie = action === 'assign' ? f.cookie : rider.cookie,
        csrf = action === 'assign' ? f.profile.csrfToken : rider.csrf,
        k = randomUUID(),
        before = await snapshot(f);
      await db.$executeRawUnsafe(
        'CREATE TRIGGER reject_delivery_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION reject_delivery_audit()',
      );
      assert.equal((await f.api(p + '/' + action, body, k, cookie, csrf)).status, 500);
      assert.deepEqual(await snapshot(f), before);
      assert.equal(await db.redemptionHandoff.count(), 0);
      if (action === 'assign') assert.equal(await db.redemptionAssignment.count(), 0);
      await db.$executeRawUnsafe('DROP TRIGGER reject_delivery_audit ON business_audits');
      assert.equal((await f.api(p + '/' + action, body, k, cookie, csrf)).status, 200);
      assert.equal((await f.api(p + '/' + action, body, k, cookie, csrf)).status, 200);
    }
  }));
test('SQL enforces original shipment and current actors, exact receipt evidence and immutable facts', async () =>
  fixture(async (f, s) => {
    const rider = await f.workerActor('RIDER'),
      db = f.runtime.db,
      manager = await db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } });
    await assert.rejects(
      db.redemptionAssignment.create({
        data: {
          id: randomUUID(),
          shipmentId: s.id,
          orderId: s.orderId,
          riderId: manager.id,
          riderName: manager.displayName,
          actorId: manager.id,
          actorName: manager.displayName,
          requestId: randomUUID(),
        },
      }),
    );
    assert.equal((await f.assign(s.id, rider.id)).status, 200);
    const a = await db.redemptionAssignment.findFirstOrThrow({
      where: { shipmentId: s.id, withdrawal: null },
    });
    await assert.rejects(db.redemptionAssignment.updateMany({ data: { riderId: manager.id } }));
    await assert.rejects(
      db.redemptionHandoff.create({
        data: {
          id: randomUUID(),
          assignmentId: a.id,
          shipmentId: s.id,
          orderId: s.orderId,
          actorId: rider.id,
          packageCount: 2,
          requestId: randomUUID(),
        },
      }),
    );
    assert.equal(await db.redemptionHandoff.count(), 0);
    assert.equal(
      (
        await f.api(
          f.deliveryPrefix + '/' + s.id + '/accept',
          await receive(f, s.id),
          randomUUID(),
          rider.cookie,
          rider.csrf,
        )
      ).status,
      200,
    );
    await assert.rejects(db.redemptionHandoff.deleteMany());
    await assert.rejects(db.redemptionHandoffLine.updateMany({ data: { quantity: 100 } }));
  }));
test('in-transaction revocation is enforced after preliminary authorization and revoked riders cannot replay', async () =>
  fixture(async (f, s) => {
    const rider = await f.workerActor('RIDER'),
      db = f.runtime.db,
      svc = f.runtime.app.get(RedemptionDeliveryService);
    assert.equal((await f.assign(s.id, rider.id)).status, 200);
    const body = await receive(f, s.id),
      p = f.deliveryPrefix + '/' + s.id + '/accept',
      k = randomUUID(),
      original = svc.catalog.write.bind(svc.catalog);
    svc.catalog.write = async (...args) => {
      await db.staffWarehouse.deleteMany({ where: { staffId: rider.id } });
      return original(...args);
    };
    try {
      assert.equal((await f.api(p, body, k, rider.cookie, rider.csrf)).status, 403);
    } finally {
      svc.catalog.write = original;
    }
    assert.equal(await db.redemptionHandoff.count(), 0);
    await db.staffWarehouse.create({ data: { staffId: rider.id, warehouseId: f.warehouseId } });
    assert.equal((await f.api(p, body, k, rider.cookie, rider.csrf)).status, 200);
    await db.staffWarehouse.deleteMany({ where: { staffId: rider.id } });
    assert.equal((await f.api(p, body, k, rider.cookie, rider.csrf)).status, 403);
  }));
test('late lot expiry rolls back handoff and default-disabled delivery cannot assign or accept', async () =>
  fixture(async (f, s) => {
    const rider = await f.workerActor('RIDER'),
      db = f.runtime.db,
      svc = f.runtime.app.get(RedemptionDeliveryService);
    Object.defineProperty(svc, 'enabled', { value: false, configurable: true });
    assert.equal((await f.assign(s.id, rider.id)).error?.code, 'REDEMPTION_DELIVERY_DISABLED');
    Object.defineProperty(svc, 'enabled', { value: true });
    assert.equal((await f.assign(s.id, rider.id)).status, 200);
    const body = await receive(f, s.id);
    Object.defineProperty(svc, 'enabled', { value: false });
    assert.equal(
      (
        await f.api(
          f.deliveryPrefix + '/' + s.id + '/accept',
          body,
          randomUUID(),
          rider.cookie,
          rider.csrf,
        )
      ).error?.code,
      'REDEMPTION_DELIVERY_DISABLED',
    );
    Object.defineProperty(svc, 'enabled', { value: true });
    const lot = await db.stockLot.findFirstOrThrow({ where: { skuId: f.catalog.skuIds[0]! } });
    await db.stockLot.update({
      where: { id: lot.id },
      data: { producedAt: new Date(0), expiresAt: new Date(Date.now() + 700) },
    });
    await db.$executeRawUnsafe(
      "CREATE FUNCTION slow_handoff() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='REDEMPTION_DELIVERY_ACCEPT' THEN PERFORM pg_sleep(1); END IF; RETURN NEW; END $$",
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER slow_handoff BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION slow_handoff()',
    );
    assert.equal(
      (
        await f.api(
          f.deliveryPrefix + '/' + s.id + '/accept',
          body,
          randomUUID(),
          rider.cookie,
          rider.csrf,
        )
      ).error?.code,
      'DELIVERY_BLOCKED',
    );
    assert.equal(await db.redemptionHandoff.count(), 0);
  }));

test('late rider-session expiry rolls back receipt, and picking view reflects the actual handoff stage', async () =>
  fixture(async (f, s) => {
    const rider = await f.workerActor('RIDER'),
      db = f.runtime.db;
    assert.equal((await f.assign(s.id, rider.id)).status, 200);
    assert.equal(
      (await f.read(s.orderId)).data.items[0]!.packing.shipment!.deliveryState,
      'ASSIGNED',
    );
    const body = await receive(f, s.id),
      before = await snapshot(f);
    await db.staffSession.updateMany({
      where: { staffId: rider.id },
      data: { expiresAt: new Date(Date.now() + 700) },
    });
    await db.$executeRawUnsafe(
      "CREATE FUNCTION slow_rider_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='REDEMPTION_DELIVERY_ACCEPT' THEN PERFORM pg_sleep(1); END IF; RETURN NEW; END $$",
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER slow_rider_session BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION slow_rider_session()',
    );
    assert.equal(
      (
        await f.api(
          f.deliveryPrefix + '/' + s.id + '/accept',
          body,
          randomUUID(),
          rider.cookie,
          rider.csrf,
        )
      ).status,
      403,
    );
    assert.equal(await db.redemptionHandoff.count(), 0);
    assert.deepEqual(await snapshot(f), before);
  }));
async function extendStockAndQuota(f: F) {
  const reviewer = await f.reviewer(),
    me = await fetch(f.base + '/api/v1/staff/me', { headers: { Cookie: reviewer } }),
    csrf = (await me.json()).data.csrfToken,
    p = '/warehouse/warehouses/' + f.warehouseId;
  const receipt = await f.api(p + '/receipts', {
    sourceRef: randomUUID(),
    lines: [
      { skuId: f.catalog.skuIds[0]!, batchNo: 'P4D-SECOND', quantity: 30, unitCostCents: 100 },
    ],
  });
  assert.equal(receipt.status, 200);
  assert.equal(
    (
      await f.api(
        p + '/receipts/' + receipt.data.id + '/approve',
        { version: 0 },
        randomUUID(),
        reviewer,
        csrf,
      )
    ).status,
    200,
  );
  assert.equal(
    (await f.api(p + '/receipts/' + receipt.data.id + '/post', { version: 1 })).status,
    200,
  );
  assert.equal(
    (
      await f.api('/admin/rewards/' + f.rewardId + '/update', {
        title: '合成交接纸巾',
        pointsPrice: '120',
        sortOrder: 10,
        version: 1,
        perUserLimit: 30,
        totalQuota: 40,
        reason: '隔离交接规模验证',
      })
    ).status,
    200,
  );
  f.input.rewardVersion = 2;
  await f.credit(f.identity.user.id, 5000);
}
test('multi-batch owner receipt requires every original packed allocation without a second inventory movement', async () => {
  const f = await redemptionDeliveryFixture();
  try {
    await extendStockAndQuota(f);
    f.input.quantity = 6;
    const s = await f.shipment(),
      rider = await f.workerActor('RIDER');
    assert.equal((await f.assign(s.id, rider.id)).status, 200);
    const body = await receive(f, s.id);
    assert.equal(body.lines.length, 2);
    assert.equal(
      body.lines.reduce((n, l) => n + l.quantity, 0),
      6,
    );
    const p = f.deliveryPrefix + '/' + s.id + '/accept',
      before = await snapshot(f);
    assert.equal(
      (
        await f.api(
          p,
          { ...body, lines: body.lines.slice(0, 1) },
          randomUUID(),
          rider.cookie,
          rider.csrf,
        )
      ).error?.code,
      'HANDOFF_QUANTITY_MISMATCH',
    );
    assert.equal((await f.api(p, body, randomUUID(), rider.cookie, rider.csrf)).status, 200);
    assert.deepEqual(await snapshot(f), before);
    assert.equal(await f.runtime.db.redemptionHandoffLine.count(), 2);
    assert.equal(
      (await f.read(s.orderId)).data.items[0]!.packing.shipment!.deliveryState,
      'HANDED_OVER',
    );
  } finally {
    await f.cleanup();
  }
});
test('actual shipment pagination is stable and cursors cannot cross rider scope or state filters', async () => {
  const f = await redemptionDeliveryFixture();
  try {
    await extendStockAndQuota(f);
    for (let i = 0; i < 20; i++) await f.shipment();
    // Keep the original 20-active-quote protection; the 21st real shipment uses customer B.
    assert.equal((await f.call('/consumer/redemption-quotes', f.input)).status, 429);
    const q = await f.call(
      '/consumer/redemption-quotes',
      { ...f.inputB, rewardVersion: 2 },
      randomUUID(),
      f.identityB.token,
    );
    assert.equal(q.status, 200);
    const order = await f.call(
      '/consumer/redemptions',
      { quoteId: q.data.id },
      randomUUID(),
      f.identityB.token,
    );
    assert.equal(order.status, 200);
    await f.shipment(order.data.id);
    const first = (await f.deliveryRead()).data;
    assert.equal(first.items.length, 20);
    assert.ok(first.nextCursor);
    const next = (await f.deliveryRead(undefined, f.cookie, '?cursor=' + first.nextCursor)).data;
    assert.equal(next.items.length, 1);
    assert.equal(new Set([...first.items, ...next.items].map((v) => v.id)).size, 21);
    assert.equal(next.nextCursor, null);
    assert.equal(
      (await f.deliveryRead(undefined, f.cookie, '?status=ASSIGNED&cursor=' + first.nextCursor))
        .status,
      409,
    );
    const rider = await f.workerActor('RIDER');
    assert.equal(
      (await f.deliveryRead(undefined, rider.cookie, '?cursor=' + first.nextCursor)).status,
      409,
    );
    assert.equal((await f.deliveryRead(first.items[0]!.id, rider.cookie)).status, 404);
    assert.equal(
      first.items.some((v) => 'address' in v),
      false,
    );
  } finally {
    await f.cleanup();
  }
});
