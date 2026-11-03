import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expressShippingFixture } from './helpers/express-shipping-fixture.ts';
import { ExpressShippingService } from '../apps/api/dist/express-shipping.js';
import type {
  RedemptionExpressShippingView,
  RedemptionOrderView,
  RedemptionPrintPreview,
} from '../packages/contracts/src/index.ts';
type F = Awaited<ReturnType<typeof expressShippingFixture>>;
const body = {
  version: 0,
  carrierCode: 'SF',
  trackingNo: 'sf000000123456',
  dispatchConfirmed: true,
};
async function setup(work: (f: F, id: string) => Promise<void>) {
  const f = await expressShippingFixture();
  try {
    await work(f, await f.createExpress());
  } finally {
    await f.cleanup();
  }
}
const path = (id: string) => '/admin/redemptions/' + id + '/ship';
async function info(f: F, id: string) {
  const r = await f.api('/admin/redemptions/' + id + '/shipping');
  return { status: r.status, data: r.data as unknown as RedemptionExpressShippingView };
}
async function snapshot(f: F) {
  const d = f.runtime.db;
  return {
    balances: await d.stockBalance.findMany({ orderBy: { skuId: 'asc' } }),
    lots: await d.stockLot.findMany({ orderBy: { id: 'asc' } }),
    positions: await d.stockPosition.findMany({ orderBy: { id: 'asc' } }),
    ledger: await d.stockLedger.count(),
    positionLedger: await d.positionLedger.count(),
    points: await d.pointsAccount.findMany({ orderBy: { userId: 'asc' } }),
    entries: await d.pointsEntry.count(),
    orders: await d.redemptionOrder.findMany({ orderBy: { id: 'asc' } }),
    allocations: await d.redemptionAllocation.findMany({ orderBy: { id: 'asc' } }),
    outbox: await d.redemptionOutbox.findMany({ orderBy: { orderId: 'asc' } }),
  };
}
test('one express shipment consumes original stock exactly once, keeps points/quota/order and exposes real carrier facts to owner, list filters and print', async () =>
  setup(async (f, id) => {
    const before = await snapshot(f),
      key = randomUUID();
    assert.equal((await info(f, id)).data.canShip, true);
    assert.equal((await f.api(path(id), body, key)).status, 200);
    assert.equal(
      (await f.api(path(id), { ...body, trackingNo: body.trackingNo.toUpperCase() }, key)).status,
      200,
    );
    assert.equal(
      (await f.api(path(id), { ...body, trackingNo: 'SF-CHANGED-0001' }, key)).status,
      409,
    );
    assert.equal((await f.api(path(id), body)).status, 409);
    const after = await snapshot(f),
      index = before.balances.findIndex((x) => x.skuId === f.catalog.skuIds[0]);
    assert.equal(after.balances[index]!.onHand, before.balances[index]!.onHand - 1);
    assert.equal(after.balances[index]!.reserved, before.balances[index]!.reserved - 1);
    assert.equal(after.ledger, before.ledger + 1);
    assert.equal(after.positionLedger, before.positionLedger + 1);
    assert.deepEqual(after.points, before.points);
    assert.equal(after.entries, before.entries);
    assert.deepEqual(after.orders, before.orders);
    assert.ok(after.allocations[0]!.consumeLedgerId);
    assert.equal(after.outbox[0]!.state, 'EXPRESS_SHIPPED');
    assert.equal(await f.runtime.db.redemptionPickingTask.count(), 0);
    const read = await f.call<RedemptionOrderView>('/consumer/redemptions/' + id);
    assert.equal(read.data.fulfillmentState, 'EXPRESS_SHIPPED');
    assert.equal(read.data.expressShipment!.trackingNo, 'SF000000123456');
    assert.equal('actorId' in read.data.expressShipment!, false);
    assert.equal(
      (await f.call('/consumer/redemptions/' + id, undefined, randomUUID(), f.identityB.token))
        .status,
      404,
    );
    assert.equal(
      (await f.api('/admin/redemptions?fulfillment=EXPRESS_SHIPPED')).data.items.length,
      1,
    );
    assert.equal(
      (await f.api('/admin/redemptions?fulfillment=EXPRESS_WAIT_SHIP')).data.items.length,
      0,
    );
    assert.equal(
      (await f.api('/admin/redemptions?status=CANCELED&fulfillment=EXPRESS_SHIPPED')).data.items
        .length,
      0,
    );
    const print = await f.api('/admin/redemptions/print-preview', { ids: [id] });
    assert.equal(
      (print.data as unknown as RedemptionPrintPreview).items[0]!.expressShipment!.trackingNo,
      'SF000000123456',
    );
    assert.equal(
      (await f.call('/consumer/redemptions/' + id + '/cancel', { version: 0 })).status,
      409,
    );
    await assert.rejects(f.runtime.db.redemptionExpressShipment.deleteMany());
    await assert.rejects(
      f.runtime.db.redemptionExpressShipment.updateMany({ data: { trackingNo: 'SF-FAKE-0001' } }),
    );
  }));
test('shipping requires current scoped operator, csrf, valid fields, physical declaration and express source; default gate rejects new writes but successful key remains recoverable', async () =>
  setup(async (f, id) => {
    const picker = await f.workerActor('PICKER');
    assert.equal(
      (await f.api(path(id), body, randomUUID(), picker.cookie, picker.csrf)).status,
      403,
    );
    assert.equal((await f.api(path(id), body, randomUUID(), f.cookie, 'invalid')).status, 403);
    const w = randomUUID();
    await f.runtime.db.warehouse.create({
      data: { id: w, code: 'OTHER-SHIP', name: '合成另一仓' },
    });
    const other = await f.workerActor('OPERATIONS', w);
    assert.equal((await f.api(path(id), body, randomUUID(), other.cookie, other.csrf)).status, 403);
    for (const b of [
      { ...body, dispatchConfirmed: false },
      { ...body, trackingNo: 'bad' },
      { ...body, carrierCode: 'INVALID' },
      { ...body, carrierCode: 'OTHER' },
      { ...body, carrierName: '冒用名称' },
      { ...body, extra: true },
    ])
      assert.equal((await f.api(path(id), b)).status, 400);
    assert.equal((await f.api(path(id), { ...body, version: 1 })).status, 409);
    const q = await f.call('/consumer/redemption-quotes', f.input),
      local = await f.call('/consumer/redemptions', { quoteId: q.data.id });
    assert.equal((await f.api(path(local.data.id), body)).status, 409);
    const actor = await f.runtime.db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } });
    await assert.rejects(
      f.runtime.db.redemptionExpressShipment.create({
        data: {
          id: randomUUID(),
          orderId: id,
          warehouseId: f.warehouseId,
          skuId: f.catalog.skuIds[0]!,
          carrierCode: 'SF',
          carrierName: '顺丰速运',
          trackingNo: 'SF-RAW-0001',
          actorId: actor.id,
          actorName: actor.displayName,
          requestId: randomUUID(),
        },
      }),
    );
    const service = f.runtime.app.get(ExpressShippingService);
    Object.defineProperty(service, 'enabled', { value: false, configurable: true });
    assert.equal((await f.api(path(id), body)).status, 503);
    Object.defineProperty(service, 'enabled', { value: true, configurable: true });
    const k = randomUUID();
    assert.equal((await f.api(path(id), body, k)).status, 200);
    Object.defineProperty(service, 'enabled', { value: false, configurable: true });
    assert.equal((await f.api(path(id), body, k)).status, 200);
  }));
test('frozen inventory, expired batches, paused product and disabled location block shipment until repaired without side effects', async () =>
  setup(async (f, id) => {
    const d = f.runtime.db,
      a = await d.redemptionAllocation.findFirstOrThrow({
        where: { orderId: id },
        include: { position: { include: { lot: true } } },
      }),
      before = await d.redemptionExpressShipment.count();
    const balanceWhere = { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: a.skuId } };
    await d.stockBalance.update({ where: balanceWhere, data: { inventoryHold: true } });
    assert.equal((await info(f, id)).data.canShip, false);
    assert.equal((await f.api(path(id), body)).status, 409);
    await d.stockBalance.update({ where: balanceWhere, data: { inventoryHold: false } });
    await d.stockLot.update({
      where: { id: a.lotId },
      data: { producedAt: new Date(0), expiresAt: new Date(Date.now() - 1000) },
    });
    assert.equal((await f.api(path(id), body)).status, 409);
    await d.stockLot.update({
      where: { id: a.lotId },
      data: { producedAt: a.position.lot.producedAt, expiresAt: a.position.lot.expiresAt },
    });
    await d.product.update({ where: { id: f.catalog.productId }, data: { status: 'DRAFT' } });
    assert.equal((await f.api(path(id), body)).status, 409);
    await d.product.update({ where: { id: f.catalog.productId }, data: { status: 'PUBLISHED' } });
    await d.warehouseLocation.update({
      where: { id: a.position.locationId },
      data: { enabled: false },
    });
    assert.equal((await f.api(path(id), body)).status, 409);
    await d.warehouseLocation.update({
      where: { id: a.position.locationId },
      data: { enabled: true },
    });
    assert.equal(await d.redemptionExpressShipment.count(), before);
    assert.equal((await f.api(path(id), body)).status, 200);
  }));
test('two operators cannot ship twice and cancellation racing shipment commits exactly one outcome', async () =>
  setup(async (f, id) => {
    const rs = await Promise.all([
      f.api(path(id), body),
      f.api(path(id), { ...body, trackingNo: 'SF-SECOND-0001' }),
    ]);
    assert.deepEqual(rs.map((x) => x.status).sort(), [200, 409]);
    assert.equal(await f.runtime.db.redemptionExpressShipment.count(), 1);
    const next = await f.createExpress(),
      race = await Promise.all([
        f.api(path(next), { ...body, trackingNo: 'SF-RACE-0001' }),
        f.call('/consumer/redemptions/' + next + '/cancel', { version: 0 }),
      ]);
    assert.deepEqual(race.map((x) => x.status).sort(), [200, 409]);
    const o = await f.runtime.db.redemptionOrder.findUniqueOrThrow({
      where: { id: next },
      include: { expressShipment: true, allocations: true },
    });
    assert.equal(!!o.expressShipment, o.status === 'ACTIVE');
    assert.ok(
      o.allocations.every((a) =>
        o.status === 'ACTIVE'
          ? a.consumeLedgerId && !a.releaseLedgerId
          : a.releaseLedgerId && !a.consumeLedgerId,
      ),
    );
  }));
test('late audit errors roll back all stock and evidence; original key recovers once and carrier tracking cannot be reused', async () =>
  setup(async (f, id) => {
    const d = f.runtime.db,
      before = await snapshot(f),
      k = randomUUID();
    await d.$executeRawUnsafe(
      "CREATE FUNCTION fail_express_ship() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='REDEMPTION_EXPRESS_SHIP' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$",
    );
    await d.$executeRawUnsafe(
      'CREATE TRIGGER fail_express_ship BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_express_ship()',
    );
    assert.equal((await f.api(path(id), body, k)).status, 500);
    assert.equal(await d.redemptionExpressShipment.count(), 0);
    assert.deepEqual(await snapshot(f), before);
    await d.$executeRawUnsafe('DROP TRIGGER fail_express_ship ON business_audits');
    assert.equal((await f.api(path(id), body, k)).status, 200);
    assert.equal((await f.api(path(id), body, k)).status, 200);
    const next = await f.createExpress(),
      pending = await snapshot(f);
    assert.equal((await f.api(path(next), body)).status, 409);
    assert.deepEqual(await snapshot(f), pending);
  }));
for (const phase of ['session', 'lot'])
  test('late ' + phase + ' expiry rolls back express stock and shipping facts', async () =>
    setup(async (f, id) => {
      const d = f.runtime.db,
        before = await snapshot(f);
      await d.$executeRawUnsafe(
        "CREATE FUNCTION expire_express_ship() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='REDEMPTION_EXPRESS_SHIP' THEN " +
          (phase === 'session'
            ? "UPDATE staff_sessions SET created_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()-interval '1 millisecond' WHERE staff_id=NEW.actor_id;"
            : "UPDATE stock_lots SET produced_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 millisecond' WHERE id IN (SELECT lot_id FROM redemption_allocations WHERE order_id=NEW.resource_id);") +
          ' END IF; RETURN NEW; END $$',
      );
      await d.$executeRawUnsafe(
        'CREATE TRIGGER expire_express_ship BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION expire_express_ship()',
      );
      assert.equal((await f.api(path(id), body)).status, phase === 'session' ? 403 : 409);
      assert.equal(await d.redemptionExpressShipment.count(), 0);
      assert.deepEqual(await snapshot(f), before);
    }),
  );
test('a multi-batch express order consumes every original allocation and stays independent of rider packing', async () =>
  setup(async (f, unused) => {
    // Cancel the initial single-unit order so all original stock is available.
    assert.equal(
      (await f.call('/consumer/redemptions/' + unused + '/cancel', { version: 0 })).status,
      200,
    );
    const reviewer = await f.reviewer(),
      me = await fetch(f.base + '/api/v1/staff/me', { headers: { Cookie: reviewer } }),
      csrf = (await me.json()).data.csrfToken,
      p = '/warehouse/warehouses/' + f.warehouseId;
    const receipt = await f.api(p + '/receipts', {
      sourceRef: randomUUID(),
      lines: [
        { skuId: f.catalog.skuIds[0]!, batchNo: 'E3-SECOND', quantity: 10, unitCostCents: 100 },
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
          title: '合成多批次快递',
          pointsPrice: '120',
          sortOrder: 10,
          version: 1,
          perUserLimit: 10,
          totalQuota: 20,
          reason: '合成多批次验证',
        })
      ).status,
      200,
    );
    f.input.rewardVersion = 2;
    const id = await f.createExpress(6),
      before = await snapshot(f);
    assert.equal(await f.runtime.db.redemptionAllocation.count({ where: { orderId: id } }), 2);
    assert.equal((await f.api(path(id), body)).status, 200);
    const after = await snapshot(f);
    assert.equal(after.ledger, before.ledger + 2);
    assert.equal(after.positionLedger, before.positionLedger + 2);
    assert.deepEqual(after.points, before.points);
    assert.equal(await f.runtime.db.redemptionPack.count(), 0);
    assert.equal(await f.runtime.db.redemptionShipment.count(), 0);
    assert.ok(
      (await f.runtime.db.redemptionAllocation.findMany({ where: { orderId: id } })).every(
        (a) => a.consumeLedgerId,
      ),
    );
  }));
