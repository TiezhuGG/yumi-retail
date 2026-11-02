import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { redemptionPickingFixture } from './helpers/redemption-picking-fixture.ts';
import { runRedemptionPickingOnce } from '../packages/database/dist/index.js';
import { RedemptionPickingService } from '../apps/api/dist/redemption-picking.js';
type Fixture = Awaited<ReturnType<typeof redemptionPickingFixture>>;
async function checked(f: Fixture, id: string) {
  await runRedemptionPickingOnce(f.runtime.db);
  const p = f.prefix + '/' + id;
  assert.equal((await f.api(p + '/claim', { version: 0 })).status, 200);
  let v = (await f.read(id)).data.items[0]!;
  for (const a of v.lines) {
    assert.equal(
      (
        await f.api(p + '/check', {
          version: v.task!.version,
          allocationId: a.id,
          quantity: a.quantity,
        })
      ).status,
      200,
    );
    v = (await f.read(id)).data.items[0]!;
  }
  assert.equal((await f.api(p + '/complete', { version: v.task!.version })).status, 200);
  return (await f.read(id)).data.items[0]!;
}
async function fixture(work: (f: Fixture, id: string) => Promise<void>) {
  const f = await redemptionPickingFixture();
  try {
    const id = await f.order();
    await checked(f, id);
    await work(f, id);
  } finally {
    await f.cleanup();
  }
}
async function pack(f: Fixture, id: string, key = randomUUID()) {
  const v = (await f.read(id)).data.items[0]!,
    body = {
      version: v.task!.version,
      packageCount: 1,
      lines: v.lines.map((a) => ({ allocationId: a.id, quantity: a.quantity })),
    };
  const result = await f.api(f.prefix + '/' + id + '/pack', body, key);
  return { result, body, key };
}
async function shipBody(f: Fixture, id: string) {
  const v = (await f.read(id)).data.items[0]!;
  return { version: v.task!.version, packId: v.packing.pack!.id, physicalConfirmed: true };
}
async function snapshot(f: Fixture) {
  const db = f.runtime.db;
  return {
    balances: await db.stockBalance.findMany({ orderBy: { skuId: 'asc' } }),
    lots: await db.stockLot.findMany({ orderBy: { id: 'asc' } }),
    positions: await db.stockPosition.findMany({ orderBy: { id: 'asc' } }),
    stock: await db.stockLedger.count(),
    positionLedger: await db.positionLedger.count(),
    points: await db.pointsAccount.findMany({ orderBy: { userId: 'asc' } }),
  };
}
test('pack requires every original allocation and exact quantities; pack itself moves no stock or points', async () =>
  fixture(async (f, id) => {
    const v = (await f.read(id)).data.items[0]!,
      p = f.prefix + '/' + id,
      a = v.lines[0]!,
      before = await snapshot(f),
      body = {
        version: v.task!.version,
        packageCount: 1,
        lines: [{ allocationId: a.id, quantity: a.quantity }],
      };
    for (const lines of [
      [],
      [{ allocationId: a.id, quantity: 0 }],
      [{ allocationId: a.id, quantity: 1.1 }],
      [...body.lines, ...body.lines],
    ])
      assert.equal((await f.api(p + '/pack', { ...body, lines })).status, 400);
    for (const lines of [
      [{ allocationId: randomUUID(), quantity: 1 }],
      [{ allocationId: a.id, quantity: a.quantity + 1 }],
    ])
      assert.equal(
        (await f.api(p + '/pack', { ...body, lines })).error?.code,
        'PACK_QUANTITY_MISMATCH',
      );
    assert.equal(
      (
        await f.api(p + '/ship', {
          version: v.task!.version,
          packId: randomUUID(),
          physicalConfirmed: true,
        })
      ).error?.code,
      'PACK_REQUIRED',
    );
    assert.equal((await f.api(p + '/pack', { ...body, packageCount: 0 })).status, 400);
    const k = randomUUID();
    assert.equal((await f.api(p + '/pack', body, k)).status, 200);
    assert.equal((await f.api(p + '/pack', body, k)).status, 200);
    assert.equal(
      (await f.api(p + '/pack', { ...body, packageCount: 2 }, k)).error?.code,
      'IDEMPOTENCY_CONFLICT',
    );
    assert.equal((await f.api(p + '/pack', body)).error?.code, 'STAGE_ALREADY_RECORDED');
    assert.deepEqual(await snapshot(f), before);
    assert.equal((await f.read(id)).data.items[0]!.state, 'PACKED');
    assert.equal(
      (await f.call('/consumer/redemptions/' + id)).data.fulfillmentState,
      'PACKED_WAIT_SHIP',
    );
  }));
test('shipment consumes original positions once, preserves points/quota, and historical read does not require consumed reservations', async () =>
  fixture(async (f, id) => {
    assert.equal((await pack(f, id)).result.status, 200);
    const before = await snapshot(f),
      body = await shipBody(f, id),
      k = randomUUID(),
      p = f.prefix + '/' + id;
    assert.equal((await f.api(p + '/ship', body, k)).status, 200);
    assert.equal((await f.api(p + '/ship', body, k)).status, 200);
    assert.equal((await f.api(p + '/ship', body)).error?.code, 'STAGE_ALREADY_RECORDED');
    const after = await snapshot(f),
      b = before.balances.find((b) => b.skuId === f.catalog.skuIds[0])!,
      a = after.balances.find((b) => b.skuId === f.catalog.skuIds[0])!;
    assert.equal(a.onHand, b.onHand - 1);
    assert.equal(a.reserved, b.reserved - 1);
    assert.equal(a.blocked, b.blocked);
    assert.deepEqual(after.points, before.points);
    assert.equal(after.stock, before.stock + 1);
    assert.equal(after.positionLedger, before.positionLedger + 1);
    const allocation = await f.runtime.db.redemptionAllocation.findFirstOrThrow({
        where: { orderId: id },
      }),
      ledger = await f.runtime.db.stockLedger.findUniqueOrThrow({
        where: { id: allocation.consumeLedgerId! },
      });
    assert.equal(ledger.actionKey, 'REDEMPTION_SHIP:' + allocation.id);
    assert.equal(ledger.deltaOnHand, -allocation.quantity);
    assert.equal(ledger.deltaReserved, -allocation.quantity);
    assert.equal(allocation.releaseLedgerId, null);
    const view = (await f.read(id)).data.items[0]!;
    assert.equal(view.state, 'SHIPPED');
    assert.deepEqual(view.readiness.blockers, []);
    assert.equal(view.packing.canShip, false);
    assert.equal(
      (await f.call('/consumer/redemptions/' + id)).data.fulfillmentState,
      'SHIPPED_WAIT_HANDOFF',
    );
    assert.equal(
      (await f.call('/consumer/redemptions/' + id + '/cancel', { version: 0 })).error?.code,
      'CANCELLATION_REVIEW_REQUIRED',
    );
    assert.equal(
      (await f.runtime.db.redemptionOrder.findUniqueOrThrow({ where: { id } })).status,
      'ACTIVE',
    );
    assert.equal(await runRedemptionPickingOnce(f.runtime.db), false);
    assert.equal((await f.api(f.prefix + '?status=SHIPPED')).data.items.length, 1);
    assert.equal((await f.api(f.prefix + '?status=CHECKED')).data.items.length, 0);
  }));
test('two managers racing shipment and pack/cancel races cannot double-consume or refund', async () =>
  fixture(async (f, id) => {
    const manager = await f.workerActor('WAREHOUSE_MANAGER'),
      p = f.prefix + '/' + id;
    const pair = await Promise.all([pack(f, id), pack(f, id)]);
    assert.deepEqual(pair.map((r) => r.result.status).sort(), [200, 409]);
    const body = await shipBody(f, id),
      results = await Promise.all([
        f.api(p + '/ship', body),
        f.api(p + '/ship', body, randomUUID(), manager.cookie, manager.csrf),
        f.call('/consumer/redemptions/' + id + '/cancel', { version: 0 }),
      ]);
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(results.filter((r) => r.status === 409).length, 2);
    assert.equal(await f.runtime.db.redemptionShipment.count(), 1);
    assert.equal(
      await f.runtime.db.stockLedger.count({
        where: { actionKey: { startsWith: 'REDEMPTION_SHIP:' } },
      }),
      1,
    );
  }));
test('packing is owner-only and shipment is manager-only, warehouse scoped, CSRF and physical confirmation protected', async () =>
  fixture(async (f, id) => {
    const picker = await f.workerActor(),
      manager = await f.workerActor('WAREHOUSE_MANAGER'),
      rider = await f.workerActor('RIDER'),
      v = (await f.read(id)).data.items[0]!,
      p = f.prefix + '/' + id,
      body = {
        version: v.task!.version,
        packageCount: 1,
        lines: v.lines.map((a) => ({ allocationId: a.id, quantity: a.quantity })),
      };
    for (const actor of [picker, manager, rider])
      assert.equal(
        (await f.api(p + '/pack', body, randomUUID(), actor.cookie, actor.csrf)).status,
        403,
      );
    assert.equal((await pack(f, id)).result.status, 200);
    const ship = await shipBody(f, id);
    for (const actor of [picker, rider])
      assert.equal(
        (await f.api(p + '/ship', ship, randomUUID(), actor.cookie, actor.csrf)).status,
        403,
      );
    assert.equal((await f.api(p + '/ship', ship, randomUUID(), f.cookie, 'invalid')).status, 403);
    assert.equal(
      (await f.api(p + '/ship', { ...ship, physicalConfirmed: false })).error?.code,
      'PHYSICAL_CONFIRMATION_REQUIRED',
    );
    assert.equal((await f.api(p + '/ship', { ...ship, extra: true })).status, 400);
    const w = randomUUID();
    await f.runtime.db.warehouse.create({ data: { id: w, code: 'OTHER', name: '合成另一仓' } });
    const other = await f.workerActor('WAREHOUSE_MANAGER', w);
    assert.equal(
      (await f.api(p + '/ship', ship, randomUUID(), other.cookie, other.csrf)).status,
      403,
    );
    assert.equal(
      (
        await f.api(
          '/warehouse/warehouses/' + w + '/redemption-picking/' + id + '/ship',
          ship,
          randomUUID(),
          other.cookie,
          other.csrf,
        )
      ).status,
      404,
    );
    assert.equal(
      (await f.api(p + '/ship', ship, randomUUID(), manager.cookie, manager.csrf)).status,
      200,
    );
  }));
test('current stock hold, source, location and expiry gate packing and shipment without partial stock changes', async () =>
  fixture(async (f, id) => {
    const db = f.runtime.db,
      w = f.warehouseId,
      sku = f.catalog.skuIds[0]!,
      pos = await db.stockPosition.findFirstOrThrow({ where: { skuId: sku } }),
      p = f.prefix + '/' + id;
    await db.stockBalance.update({
      where: { warehouseId_skuId: { warehouseId: w, skuId: sku } },
      data: { inventoryHold: true },
    });
    assert.equal((await pack(f, id)).result.error?.code, 'PICKING_BLOCKED');
    await db.stockBalance.update({
      where: { warehouseId_skuId: { warehouseId: w, skuId: sku } },
      data: { inventoryHold: false },
    });
    assert.equal((await pack(f, id)).result.status, 200);
    const body = await shipBody(f, id);
    await db.warehouseLocation.update({ where: { id: pos.locationId }, data: { enabled: false } });
    const before = await snapshot(f);
    assert.equal((await f.api(p + '/ship', body)).error?.code, 'PICKING_BLOCKED');
    assert.deepEqual(await snapshot(f), before);
    await db.warehouseLocation.update({ where: { id: pos.locationId }, data: { enabled: true } });
    await db.sku.update({ where: { id: sku }, data: { enabled: false } });
    assert.equal((await f.api(p + '/ship', body)).error?.code, 'PICKING_BLOCKED');
    await db.sku.update({ where: { id: sku }, data: { enabled: true } });
    await db.stockLot.update({
      where: { id: pos.lotId },
      data: { producedAt: new Date(0), expiresAt: new Date(1) },
    });
    assert.equal((await f.api(p + '/ship', body)).error?.code, 'PICKING_BLOCKED');
    assert.equal(await db.redemptionShipment.count(), 0);
  }));
test('late pack and shipment audits roll back facts and every stock layer; same original requests recover once', async () =>
  fixture(async (f, id) => {
    const db = f.runtime.db,
      p = f.prefix + '/' + id;
    await db.$executeRawUnsafe(
      "CREATE FUNCTION reject_pack_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('REDEMPTION_PICKING_PACK','REDEMPTION_PICKING_SHIP') THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$",
    );
    const v = (await f.read(id)).data.items[0]!,
      packBody = {
        version: v.task!.version,
        packageCount: 2,
        lines: v.lines.map((a) => ({ allocationId: a.id, quantity: a.quantity })),
      };
    for (const action of ['pack', 'ship']) {
      const body = action === 'pack' ? packBody : await shipBody(f, id),
        k = randomUUID(),
        before = await snapshot(f);
      await db.$executeRawUnsafe(
        'CREATE TRIGGER reject_pack_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION reject_pack_audit()',
      );
      assert.equal((await f.api(p + '/' + action, body, k)).status, 500);
      assert.deepEqual(await snapshot(f), before);
      assert.equal(await db.redemptionShipment.count(), 0);
      if (action === 'pack') assert.equal(await db.redemptionPack.count(), 0);
      await db.$executeRawUnsafe('DROP TRIGGER reject_pack_audit ON business_audits');
      assert.equal((await f.api(p + '/' + action, body, k)).status, 200);
      assert.equal((await f.api(p + '/' + action, body, k)).status, 200);
    }
  }));
test('batch expiry during shipment audit restores all original stock and reservations', async () =>
  fixture(async (f, id) => {
    assert.equal((await pack(f, id)).result.status, 200);
    const db = f.runtime.db,
      lot = await db.stockLot.findFirstOrThrow({ where: { skuId: f.catalog.skuIds[0]! } }),
      body = await shipBody(f, id);
    await db.stockLot.update({
      where: { id: lot.id },
      data: { producedAt: new Date(0), expiresAt: new Date(Date.now() + 700) },
    });
    await db.$executeRawUnsafe(
      "CREATE FUNCTION slow_ship_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='REDEMPTION_PICKING_SHIP' THEN PERFORM pg_sleep(1); END IF; RETURN NEW; END $$",
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER slow_ship_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION slow_ship_audit()',
    );
    const before = await snapshot(f);
    assert.equal((await f.api(f.prefix + '/' + id + '/ship', body)).error?.code, 'PICKING_BLOCKED');
    assert.deepEqual(await snapshot(f), before);
    assert.equal(await db.redemptionShipment.count(), 0);
    assert.equal((await f.read(id)).data.items[0]!.state, 'PACKED');
  }));
test('SQL immutable packing and shipment proof constraints reject missing lines and unfunded outgoing facts', async () =>
  fixture(async (f, id) => {
    const db = f.runtime.db,
      t = await db.redemptionPickingTask.findUniqueOrThrow({ where: { orderId: id } });
    await assert.rejects(
      db.redemptionPack.create({
        data: {
          id: randomUUID(),
          taskId: t.id,
          orderId: id,
          taskVersion: t.version,
          packageCount: 1,
          actorId: t.ownerId!,
          requestId: randomUUID(),
        },
      }),
    );
    assert.equal((await pack(f, id)).result.status, 200);
    const pk = await db.redemptionPack.findUniqueOrThrow({ where: { taskId: t.id } });
    await assert.rejects(db.redemptionPackLine.updateMany({ data: { quantity: 100 } }));
    await assert.rejects(db.redemptionPack.deleteMany());
    await assert.rejects(
      db.redemptionShipment.create({
        data: {
          id: randomUUID(),
          taskId: t.id,
          orderId: id,
          packId: pk.id,
          taskVersion: t.version,
          actorId: t.ownerId!,
          requestId: randomUUID(),
        },
      }),
    );
    assert.equal(await db.redemptionShipment.count(), 0);
    assert.equal((await f.api(f.prefix + '/' + id + '/ship', await shipBody(f, id))).status, 200);
    await assert.rejects(db.redemptionShipment.deleteMany());
    await assert.rejects(
      db.redemptionAllocation.updateMany({
        where: { orderId: id },
        data: { consumeLedgerId: null },
      }),
    );
  }));
test('transaction-time warehouse revocation blocks shipment including replay', async () =>
  fixture(async (f, id) => {
    assert.equal((await pack(f, id)).result.status, 200);
    const db = f.runtime.db,
      svc = f.runtime.app.get(RedemptionPickingService),
      staff = await db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } }),
      body = await shipBody(f, id),
      key = randomUUID(),
      original = svc.catalog.write.bind(svc.catalog);
    svc.catalog.write = async (...args) => {
      await db.staffWarehouse.deleteMany({ where: { staffId: staff.id } });
      return original(...args);
    };
    try {
      assert.equal((await f.api(f.prefix + '/' + id + '/ship', body, key)).status, 403);
    } finally {
      svc.catalog.write = original;
    }
    assert.equal(await db.redemptionShipment.count(), 0);
    await db.staffWarehouse.create({ data: { staffId: staff.id, warehouseId: f.warehouseId } });
    assert.equal((await f.api(f.prefix + '/' + id + '/ship', body, key)).status, 200);
    await db.staffWarehouse.deleteMany({ where: { staffId: staff.id } });
    assert.equal((await f.api(f.prefix + '/' + id + '/ship', body, key)).status, 403);
  }));
test('disabled local writing rejects pack and ship after completion with no stock changes', async () =>
  fixture(async (f, id) => {
    const svc = f.runtime.app.get(RedemptionPickingService),
      before = await snapshot(f);
    Object.defineProperty(svc, 'enabled', { value: false });
    assert.equal((await pack(f, id)).result.error?.code, 'REDEMPTION_PICKING_DISABLED');
    const v = (await f.read(id)).data.items[0]!;
    assert.equal(
      (
        await f.api(f.prefix + '/' + id + '/ship', {
          version: v.task!.version,
          packId: randomUUID(),
          physicalConfirmed: true,
        })
      ).error?.code,
      'REDEMPTION_PICKING_DISABLED',
    );
    assert.deepEqual(await snapshot(f), before);
  }));

test('multi-batch outgoing consumes all own allocations and preserves another consumer reservation in a submit race', async () => {
  const f = await redemptionPickingFixture();
  try {
    const reviewer = await f.reviewer(),
      me = await fetch(f.base + '/api/v1/staff/me', { headers: { Cookie: reviewer } }),
      csrf = (await me.json()).data.csrfToken,
      prefix = '/warehouse/warehouses/' + f.warehouseId;
    const receipt = await f.api(prefix + '/receipts', {
      sourceRef: randomUUID(),
      lines: [
        { skuId: f.catalog.skuIds[0]!, batchNo: 'P4C-SECOND', quantity: 3, unitCostCents: 100 },
      ],
    });
    assert.equal(receipt.status, 200);
    assert.equal(
      (
        await f.api(
          prefix + '/receipts/' + receipt.data.id + '/approve',
          { version: 0 },
          randomUUID(),
          reviewer,
          csrf,
        )
      ).status,
      200,
    );
    assert.equal(
      (await f.api(prefix + '/receipts/' + receipt.data.id + '/post', { version: 1 })).status,
      200,
    );
    assert.equal(
      (
        await f.api('/admin/rewards/' + f.rewardId + '/update', {
          title: '合成出库纸巾',
          pointsPrice: '120',
          sortOrder: 10,
          version: 1,
          perUserLimit: 8,
          totalQuota: 20,
          reason: '合成多批次验证',
        })
      ).status,
      200,
    );
    const q = await f.call('/consumer/redemption-quotes', {
      ...f.input,
      rewardVersion: 2,
      quantity: 6,
    });
    assert.equal(q.status, 200);
    const o = await f.call('/consumer/redemptions', { quoteId: q.data.id });
    assert.equal(o.status, 200);
    const id = o.data.id;
    const v = await checked(f, id);
    assert.equal(v.lines.length, 2);
    const wrong = {
      version: v.task!.version,
      packageCount: 1,
      lines: v.lines.slice(0, 1).map((a) => ({ allocationId: a.id, quantity: a.quantity })),
    };
    assert.equal(
      (await f.api(f.prefix + '/' + id + '/pack', wrong)).error?.code,
      'PACK_QUANTITY_MISMATCH',
    );
    assert.equal((await pack(f, id)).result.status, 200);
    const other = await f.call(
      '/consumer/redemption-quotes',
      { ...f.inputB, rewardVersion: 2 },
      randomUUID(),
      f.identityB.token,
    );
    assert.equal(other.status, 200);
    const [out, submitted] = await Promise.all([
      f.api(f.prefix + '/' + id + '/ship', await shipBody(f, id)),
      f.call('/consumer/redemptions', { quoteId: other.data.id }, randomUUID(), f.identityB.token),
    ]);
    assert.equal(out.status, 200);
    assert.equal(submitted.status, 200);
    const db = f.runtime.db,
      balance = await db.stockBalance.findUniqueOrThrow({
        where: { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.catalog.skuIds[0]! } },
      });
    assert.equal(balance.onHand, 2);
    assert.equal(balance.reserved, 1);
    assert.equal(
      await db.redemptionAllocation.count({
        where: { orderId: id, consumeLedgerId: { not: null } },
      }),
      2,
    );
    assert.equal(
      await db.redemptionAllocation.count({
        where: { orderId: submitted.data.id, consumeLedgerId: null, releaseLedgerId: null },
      }),
      1,
    );
    assert.equal((await f.read(id)).data.items[0]!.readiness.blockers.length, 0);
    assert.equal(
      (
        await f.api('/admin/rewards/' + f.rewardId + '/update', {
          title: '合成出库纸巾',
          pointsPrice: '120',
          sortOrder: 10,
          version: 2,
          perUserLimit: 5,
          totalQuota: 20,
          reason: '验证已出库仍累计限兑',
        })
      ).status,
      409,
    );
  } finally {
    await f.cleanup();
  }
});

test('session expiring during shipment audit rolls back stock, consumption pointers and outgoing proof', async () =>
  fixture(async (f, id) => {
    assert.equal((await pack(f, id)).result.status, 200);
    const db = f.runtime.db,
      staff = await db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } }),
      body = await shipBody(f, id),
      before = await snapshot(f);
    await db.staffSession.updateMany({
      where: { staffId: staff.id },
      data: { expiresAt: new Date(Date.now() + 700) },
    });
    await db.$executeRawUnsafe(
      "CREATE FUNCTION slow_ship_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='REDEMPTION_PICKING_SHIP' THEN PERFORM pg_sleep(1); END IF; RETURN NEW; END $$",
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER slow_ship_session BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION slow_ship_session()',
    );
    assert.equal((await f.api(f.prefix + '/' + id + '/ship', body)).status, 403);
    assert.deepEqual(await snapshot(f), before);
    assert.equal(await db.redemptionShipment.count(), 0);
    assert.equal(
      await db.redemptionAllocation.count({
        where: { orderId: id, consumeLedgerId: { not: null } },
      }),
      0,
    );
  }));
