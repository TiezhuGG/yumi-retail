import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type {
  ExpressParcelPreview,
  RedemptionOrderView,
  RedemptionExpressShippingView,
} from '../packages/contracts/src/index.ts';
import { ExpressShippingService } from '../apps/api/dist/express-shipping.js';
import { expressShippingFixture } from './helpers/express-shipping-fixture.ts';
const path = '/admin/redemptions/ship-parcel',
  previewPath = '/admin/redemptions/parcel-preview';
type F = Awaited<ReturnType<typeof expressShippingFixture>>;
async function setup(work: (f: F, ids: string[], body: Record<string, unknown>) => Promise<void>) {
  const f = await expressShippingFixture();
  try {
    const ids = [await f.createExpress(), await f.createExpress(2)];
    await work(f, ids, {
      orders: ids.map((id) => ({ id, version: 0 })),
      carrierCode: 'SF',
      trackingNo: 'SF-PARCEL-000001',
      dispatchConfirmed: true,
    });
  } finally {
    await f.cleanup();
  }
}
async function snapshot(f: F) {
  const d = f.runtime.db;
  return {
    orders: await d.redemptionOrder.findMany({ orderBy: { id: 'asc' } }),
    parcels: await d.redemptionExpressParcel.findMany({ orderBy: { id: 'asc' } }),
    shipments: await d.redemptionExpressShipment.findMany({ orderBy: { id: 'asc' } }),
    corrections: await d.redemptionExpressShipmentCorrection.findMany({ orderBy: { id: 'asc' } }),
    stock: await d.stockBalance.findMany({ orderBy: { skuId: 'asc' } }),
    positions: await d.stockPosition.findMany({ orderBy: { id: 'asc' } }),
    lots: await d.stockLot.findMany({ orderBy: { id: 'asc' } }),
    allocations: await d.redemptionAllocation.findMany({ orderBy: { id: 'asc' } }),
    jobs: await d.redemptionOutbox.findMany({ orderBy: { orderId: 'asc' } }),
    points: await d.pointsAccount.findMany({ orderBy: { userId: 'asc' } }),
    entries: await d.pointsEntry.count(),
    ledger: await d.stockLedger.count(),
    audit: await d.businessAudit.count(),
    idem: await d.idempotencyRecord.count(),
    claims: await d.$queryRaw`SELECT * FROM redemption_express_waybills ORDER BY tracking_no`,
  };
}
test('atomic parcel consumes each original reservation once, preserves points, exposes shared tracking and permits per-order receipt', async () =>
  setup(async (f, ids, body) => {
    const before = await snapshot(f),
      key = randomUUID();
    const p = await f.api(previewPath, { ids });
    assert.equal(p.status, 200);
    const v = p.data as unknown as ExpressParcelPreview;
    assert.equal(v.canShip, true);
    assert.equal(v.items.length, 2);
    assert.ok(v.items.every((o) => o.allocations.length));
    assert.deepEqual(await snapshot(f), before);
    const result = await f.api(path, body, key);
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(
      (
        await f.api(
          path,
          {
            ...body,
            orders: [...(body.orders as unknown[])].reverse(),
            trackingNo: 'sf-parcel-000001',
          },
          key,
        )
      ).status,
      200,
    );
    assert.equal((await f.api(path, { ...body, trackingNo: 'SF-CHANGED-001' }, key)).status, 409);
    assert.equal((await f.api(path, body)).status, 409);
    const after = await snapshot(f);
    assert.equal(after.parcels.length, 1);
    assert.equal(after.shipments.length, 2);
    assert.equal(after.ledger, before.ledger + 2);
    assert.deepEqual(after.points, before.points);
    assert.equal(after.entries, before.entries);
    assert.deepEqual(after.orders, before.orders);
    assert.ok(after.allocations.every((a) => a.consumeLedgerId && !a.releaseLedgerId));
    assert.ok(after.jobs.every((j) => j.state === 'EXPRESS_SHIPPED'));
    const index = before.stock.findIndex((s) => s.skuId === f.catalog.skuIds[0]);
    assert.equal(after.stock[index]!.onHand, before.stock[index]!.onHand - 3);
    assert.equal(after.stock[index]!.reserved, before.stock[index]!.reserved - 3);
    for (const id of ids) {
      const read = await f.call<RedemptionOrderView>('/consumer/redemptions/' + id);
      assert.equal(read.data.expressShipment!.trackingNo, body.trackingNo);
      assert.equal(read.data.expressShipment!.parcel!.orderCount, 2);
      assert.equal(read.data.expressShipment!.parcel!.id, result.data.id);
      assert.equal(
        (await f.call('/consumer/redemptions/' + id, undefined, randomUUID(), f.identityB.token))
          .status,
        404,
      );
    }
    assert.equal(
      (await f.call('/consumer/redemptions/' + ids[0] + '/confirm-receipt', { received: true }))
        .status,
      200,
    );
    assert.equal(
      (await f.call<RedemptionOrderView>('/consumer/redemptions/' + ids[1])).data.expressShipment!
        .receivedAt,
      null,
    );
    const stockBeforeReturn = await snapshot(f);
    const requested = await f.call('/consumer/redemptions/' + ids[0] + '/returns', {
      quantity: 1,
      reason: '合成同包单品售后',
    });
    assert.equal(requested.status, 200);
    assert.equal(
      (
        await f.api('/admin/redemption-returns/' + requested.data.id + '/approve', {
          requiresReturn: false,
          reason: '合成无需寄回',
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.api('/admin/redemption-returns/' + requested.data.id + '/refund', {
          confirmed: true,
          reason: '合成原积分退还',
        })
      ).status,
      200,
    );
    const afterReturn = await snapshot(f);
    assert.deepEqual(afterReturn.stock, stockBeforeReturn.stock);
    assert.deepEqual(afterReturn.shipments, stockBeforeReturn.shipments);
    assert.equal(afterReturn.entries, stockBeforeReturn.entries + 1);
    assert.equal(
      afterReturn.points.find((p) => p.userId === f.identity.user.id)!.balance -
        stockBeforeReturn.points.find((p) => p.userId === f.identity.user.id)!.balance,
      120n,
    );
    const otherReturns = await f.call<{ items: unknown[] }>(
      '/consumer/redemptions/' + ids[1] + '/returns',
    );
    assert.deepEqual(otherReturns.data.items, []);
  }));
test('parcel corrections update every member atomically and reserve all historical waybills', async () =>
  setup(async (f, ids, body) => {
    assert.equal((await f.api(path, body)).status, 200);
    const before = await snapshot(f),
      key = randomUUID(),
      c = {
        version: 0,
        carrierCode: 'ZTO',
        trackingNo: 'ZTO-PARCEL-CORRECT-1',
        reason: '合成整包运单更正',
        verified: true,
      };
    const cp = '/admin/redemptions/' + ids[0] + '/shipping-corrections';
    assert.equal((await f.api(cp, c, key)).status, 200);
    assert.equal((await f.api(cp, c, key)).status, 200);
    for (const id of ids) {
      const r = await f.api('/admin/redemptions/' + id + '/shipping');
      const v = r.data as unknown as RedemptionExpressShippingView;
      assert.equal(v.shipment!.trackingNo, c.trackingNo);
      assert.equal(v.shipment!.correctionVersion, 1);
      assert.equal(v.shipmentHistory.length, 2);
    }
    const after = await snapshot(f);
    assert.deepEqual(after.stock, before.stock);
    assert.equal(after.ledger, before.ledger);
    assert.deepEqual(after.points, before.points);
    assert.equal(after.corrections.length, 2);
    assert.equal(
      (
        await f.api('/admin/redemptions/' + ids[1] + '/shipping-corrections', {
          ...c,
          trackingNo: 'ZTO-PARCEL-STALE-1',
        })
      ).status,
      409,
    );
    const next = await f.createExpress();
    for (const trackingNo of [body.trackingNo, c.trackingNo])
      assert.equal(
        (
          await f.api('/admin/redemptions/' + next + '/ship', {
            version: 0,
            carrierCode: trackingNo === body.trackingNo ? 'SF' : 'ZTO',
            trackingNo,
            dispatchConfirmed: true,
          })
        ).status,
        409,
      );
    // Database itself rejects a single-member correction; no bypass of fact triggers.
    await assert.rejects(
      f.runtime.db.$transaction(async (tx) => {
        const shipment = await tx.redemptionExpressShipment.findFirstOrThrow({
          where: { orderId: ids[0] },
        });
        await tx.redemptionExpressShipmentCorrection.create({
          data: {
            id: randomUUID(),
            shipmentId: shipment.id,
            version: 2,
            carrierCode: 'EMS',
            carrierName: 'EMS',
            trackingNo: 'EMS-ONE-SIDED-1',
            reason: '合成非法单边更正',
            actorId: shipment.actorId,
            actorName: shipment.actorName,
            requestId: randomUUID(),
          },
        });
      }),
    );
    assert.equal(await f.runtime.db.redemptionExpressShipmentCorrection.count(), 2);
  }));
test('cancel, inventory hold, malformed selection, role, CSRF and current scope prevent any partial parcel', async () =>
  setup(async (f, ids, body) => {
    for (const orders of [
      [],
      [{ id: ids[0], version: 0 }],
      Array.from({ length: 21 }, () => ({ id: randomUUID(), version: 0 })),
      [
        { id: ids[0], version: 0 },
        { id: ids[0], version: 0 },
      ],
    ])
      assert.equal((await f.api(path, { ...body, orders })).status, 400);
    assert.equal((await f.api(path, { ...body, dispatchConfirmed: false })).status, 400);
    assert.equal(
      (await f.api(path, { ...body, orders: ids.map((id) => ({ id, version: 1 })) })).status,
      409,
    );
    const picker = await f.workerActor('PICKER');
    assert.equal((await f.api(path, body, randomUUID(), picker.cookie, picker.csrf)).status, 403);
    assert.equal((await f.api(path, body, randomUUID(), f.cookie, 'invalid')).status, 403);
    const d = f.runtime.db,
      balance = await d.stockBalance.findFirstOrThrow({
        where: { warehouseId: f.warehouseId, skuId: f.catalog.skuIds[0] },
      });
    await d.stockBalance.update({
      where: { warehouseId_skuId: { warehouseId: balance.warehouseId, skuId: balance.skuId } },
      data: { inventoryHold: true },
    });
    const before = await snapshot(f);
    assert.equal((await f.api(path, body)).status, 409);
    assert.deepEqual(await snapshot(f), before);
    assert.equal(
      ((await f.api(previewPath, { ids })).data as unknown as ExpressParcelPreview).canShip,
      false,
    );
    await d.stockBalance.update({
      where: { warehouseId_skuId: { warehouseId: balance.warehouseId, skuId: balance.skuId } },
      data: { inventoryHold: false },
    });
    assert.equal(
      (await f.call('/consumer/redemptions/' + ids[0] + '/cancel', { version: 0 })).status,
      200,
    );
    const canceled = await snapshot(f);
    assert.equal((await f.api(path, body)).status, 409);
    assert.deepEqual(await snapshot(f), canceled);
    const staff = await d.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } });
    await d.staffWarehouse.deleteMany({ where: { staffId: staff.id } });
    assert.equal((await f.api(path, body)).status, 403);
  }));
test('overlapping parcel requests and single-order shipping cannot both consume stock', async () =>
  setup(async (f, ids, body) => {
    const rs = await Promise.all([
      f.api(path, body),
      f.api('/admin/redemptions/' + ids[0] + '/ship', {
        version: 0,
        carrierCode: 'ZTO',
        trackingNo: 'ZTO-SINGLE-RACE-001',
        dispatchConfirmed: true,
      }),
    ]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
    const shipments = await f.runtime.db.redemptionExpressShipment.findMany();
    assert.equal(shipments.length, rs[0]!.status === 200 ? 2 : 1);
    assert.equal(
      await f.runtime.db.stockLedger.count({
        where: { actionKey: { startsWith: 'REDEMPTION_SHIP:' } },
      }),
      shipments.length,
    );
  }));
test('cancellation racing parcel shipping commits exactly one whole outcome', async () =>
  setup(async (f, ids, body) => {
    const rs = await Promise.all([
      f.api(path, body),
      f.call('/consumer/redemptions/' + ids[0] + '/cancel', { version: 0 }),
    ]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
    const shipments = await f.runtime.db.redemptionExpressShipment.count();
    assert.equal(shipments, rs[0]!.status === 200 ? 2 : 0);
    assert.equal(await f.runtime.db.redemptionExpressParcel.count(), shipments ? 1 : 0);
  }));
test('late parcel audit failure rolls back all orders, and the same original request later succeeds once', async () =>
  setup(async (f, ids, body) => {
    const d = f.runtime.db,
      before = await snapshot(f),
      key = randomUUID();
    await d.$executeRawUnsafe(
      "CREATE FUNCTION fail_parcel_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='REDEMPTION_EXPRESS_PARCEL_SHIP' THEN RAISE EXCEPTION 'synthetic late parcel failure'; END IF; RETURN NEW; END $$",
    );
    await d.$executeRawUnsafe(
      'CREATE TRIGGER fail_parcel_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_parcel_audit()',
    );
    assert.equal((await f.api(path, body, key)).status, 500);
    assert.deepEqual(await snapshot(f), before);
    await d.$executeRawUnsafe('DROP TRIGGER fail_parcel_audit ON business_audits');
    assert.equal((await f.api(path, body, key)).status, 200);
    assert.equal((await f.api(path, body, key)).status, 200);
    assert.equal(await d.redemptionExpressParcel.count(), 1);
  }));
test('overlapping parcels cannot split the shared order or consume a reservation twice', async () =>
  setup(async (f, ids, body) => {
    const third = await f.createExpress();
    const rs = await Promise.all([
      f.api(path, body),
      f.api(path, {
        ...body,
        orders: [
          { id: ids[1], version: 0 },
          { id: third, version: 0 },
        ],
        trackingNo: 'SF-OTHER-PARCEL-01',
      }),
    ]);
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
    assert.equal(await f.runtime.db.redemptionExpressParcel.count(), 1);
    assert.equal(await f.runtime.db.redemptionExpressShipment.count(), 2);
  }));
test('failed and successful replays respect current feature and authorization without changing source orders', async () =>
  setup(async (f, ids, body) => {
    const service = f.runtime.app.get(ExpressShippingService),
      key = randomUUID();
    Object.defineProperty(service, 'enabled', { value: false, configurable: true });
    const before = await snapshot(f);
    assert.equal((await f.api(path, body, key)).status, 503);
    assert.deepEqual(await snapshot(f), before);
    Object.defineProperty(service, 'enabled', { value: true, configurable: true });
    assert.equal((await f.api(path, body, key)).status, 200);
    Object.defineProperty(service, 'enabled', { value: false, configurable: true });
    assert.equal((await f.api(path, body, key)).status, 200);
    const staff = await f.runtime.db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } });
    await f.runtime.db.staffWarehouse.deleteMany({ where: { staffId: staff.id } });
    assert.equal((await f.api(path, body, key)).status, 403);
  }));
for (const phase of ['session', 'lot'])
  test('late ' + phase + ' expiry rolls back the whole parcel', async () =>
    setup(async (f, ids, body) => {
      const d = f.runtime.db,
        before = await snapshot(f);
      await d.$executeRawUnsafe(
        "CREATE FUNCTION expire_parcel() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='REDEMPTION_EXPRESS_PARCEL_SHIP' THEN " +
          (phase === 'session'
            ? "UPDATE staff_sessions SET created_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()-interval '1 millisecond' WHERE staff_id=NEW.actor_id;"
            : "UPDATE stock_lots SET produced_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 millisecond' WHERE id IN (SELECT lot_id FROM redemption_allocations WHERE order_id IN (SELECT unnest(order_ids) FROM redemption_express_parcels WHERE id=NEW.resource_id));") +
          ' END IF; RETURN NEW; END $$',
      );
      await d.$executeRawUnsafe(
        'CREATE TRIGGER expire_parcel BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION expire_parcel()',
      );
      assert.equal((await f.api(path, body)).status, phase === 'session' ? 403 : 409);
      assert.deepEqual(await snapshot(f), before);
    }),
  );
test('missing and mismatched customers or original addresses are rejected without partial private data', async () =>
  setup(async (f, ids, body) => {
    const missing = await f.api(previewPath, { ids: [ids[0], randomUUID()] });
    assert.equal(missing.status, 404);
    assert.equal(missing.data, undefined);
    const address = {
      province: '浙江省',
      city: '杭州市',
      district: '西湖区',
      detailAddress: '合成快递路1号101',
      contactName: '合成快递收件人',
      phone: '00000000000',
      note: '合成收件说明',
      isDefault: true,
    };
    for (const other of [false, true]) {
      const token = other ? f.identityB.token : f.identity.token;
      const a = await f.call(
        '/consumer/express-addresses',
        {
          ...address,
          version: other ? 0 : 1,
          detailAddress: other ? address.detailAddress : '合成另一地址999',
        },
        randomUUID(),
        token,
      );
      assert.equal(a.status, 200);
      const q = await f.call(
        '/consumer/redemption-quotes',
        {
          ...f.input,
          quantity: 1,
          deliveryMode: 'EXPRESS',
          addressId: a.data.id,
          addressVersion: other ? 1 : 2,
        },
        randomUUID(),
        token,
      );
      assert.equal(q.status, 200);
      const o = await f.call('/consumer/redemptions', { quoteId: q.data.id }, randomUUID(), token);
      assert.equal(o.status, 200);
      const before = await snapshot(f),
        selected = [
          { id: ids[0], version: 0 },
          { id: o.data.id, version: 0 },
        ];
      const p = await f.api(previewPath, { ids: selected.map((x) => x.id) });
      assert.equal(p.status, 409);
      assert.equal(p.data, undefined);
      assert.equal((await f.api(path, { ...body, orders: selected })).status, 409);
      assert.deepEqual(await snapshot(f), before);
    }
  }));
test('multi-SKU parcel consumes both SKU balances and keeps unrelated reserved orders untouched', async () =>
  setup(async (f, ids, body) => {
    const published = await f.api('/admin/rewards/store/create', {
      skuId: f.catalog.skuIds[1],
      title: '合成三包装',
      pointsPrice: '200',
      sortOrder: 20,
      perUserLimit: 3,
      totalQuota: 20,
      startsAt: null,
      endsAt: null,
      reason: '合成多规格合包',
    });
    assert.equal(published.status, 200);
    assert.equal(
      (
        await f.api('/admin/rewards/' + published.data.id + '/publish', {
          version: 0,
          reason: '合成上架',
        })
      ).status,
      200,
    );
    const book = await f.call<{ version: number; items: Array<{ id: string }> }>(
      '/consumer/express-addresses',
    );
    const q = await f.call('/consumer/redemption-quotes', {
      ...f.input,
      rewardId: published.data.id,
      quantity: 1,
      deliveryMode: 'EXPRESS',
      addressId: book.data.items[0]!.id,
      addressVersion: book.data.version,
    });
    assert.equal(q.status, 200);
    const o = await f.call('/consumer/redemptions', { quoteId: q.data.id });
    assert.equal(o.status, 200);
    const before = await snapshot(f);
    assert.equal(
      (
        await f.api(path, {
          ...body,
          orders: [
            { id: ids[0], version: 0 },
            { id: o.data.id, version: 0 },
          ],
        })
      ).status,
      200,
    );
    const after = await snapshot(f);
    for (const skuId of f.catalog.skuIds) {
      const old = before.stock.find((x) => x.skuId === skuId)!,
        next = after.stock.find((x) => x.skuId === skuId)!;
      assert.equal(next.onHand, old.onHand - 1);
      assert.equal(next.reserved, old.reserved - 1);
    }
    assert.equal(after.jobs.find((j) => j.orderId === ids[1])!.state, 'EXPRESS_WAIT');
    assert.ok(
      after.allocations.filter((a) => a.orderId === ids[1]).every((a) => !a.consumeLedgerId),
    );
  }));
test('an incomplete parcel fact cannot commit, and parcel membership remains immutable', async () =>
  setup(async (f, ids, body) => {
    const actor = await f.runtime.db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } });
    await assert.rejects(
      f.runtime.db.redemptionExpressParcel.create({
        data: {
          id: randomUUID(),
          warehouseId: f.warehouseId,
          userId: f.identity.user.id,
          executionMode: 'DEVELOPMENT',
          orderIds: ids,
          actorId: actor.id,
          requestId: randomUUID(),
        },
      }),
    );
    assert.equal(await f.runtime.db.redemptionExpressParcel.count(), 0);
    assert.equal((await f.api(path, body)).status, 200);
    const p = await f.runtime.db.redemptionExpressParcel.findFirstOrThrow();
    await assert.rejects(
      f.runtime.db.redemptionExpressParcel.update({
        where: { id: p.id },
        data: { orderIds: [ids[0]!] },
      }),
    );
  }));
