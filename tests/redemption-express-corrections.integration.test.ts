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
const ship = {
  version: 0,
  carrierCode: 'SF',
  trackingNo: 'SF-E4-ORIGINAL-001',
  dispatchConfirmed: true,
};
const correction = {
  version: 0,
  carrierCode: 'ZTO',
  trackingNo: 'ZTO-E4-UPDATED-001',
  reason: '合成运单录入更正',
  verified: true,
};
const path = (id: string) => '/admin/redemptions/' + id + '/shipping-corrections';
async function read(f: F, id: string) {
  const r = await f.api('/admin/redemptions/' + id + '/shipping');
  assert.equal(r.status, 200);
  return r.data as unknown as RedemptionExpressShippingView;
}
async function setup(work: (f: F, id: string) => Promise<void>) {
  const f = await expressShippingFixture();
  try {
    const id = await f.createExpress();
    assert.equal((await f.api('/admin/redemptions/' + id + '/ship', ship)).status, 200);
    await work(f, id);
  } finally {
    await f.cleanup();
  }
}
async function stock(f: F) {
  const d = f.runtime.db;
  return {
    orders: await d.redemptionOrder.findMany({ orderBy: { id: 'asc' } }),
    allocations: await d.redemptionAllocation.findMany({ orderBy: { id: 'asc' } }),
    balances: await d.stockBalance.findMany({ orderBy: { skuId: 'asc' } }),
    lots: await d.stockLot.findMany({ orderBy: { id: 'asc' } }),
    positions: await d.stockPosition.findMany({ orderBy: { id: 'asc' } }),
    points: await d.pointsAccount.findMany({ orderBy: { userId: 'asc' } }),
    entries: await d.pointsEntry.count(),
    ledger: await d.stockLedger.count(),
    positionLedger: await d.positionLedger.count(),
    outbox: await d.redemptionOutbox.findMany({ orderBy: { orderId: 'asc' } }),
    shipments: await d.redemptionExpressShipment.findMany({ orderBy: { id: 'asc' } }),
  };
}

test('corrections are immutable, ordered, idempotent and visible everywhere without altering stock, points, source shipment or shipping time', async () =>
  setup(async (f, id) => {
    const before = await stock(f),
      initial = await read(f, id),
      k = randomUUID();
    assert.equal((await f.api(path(id), correction, k)).status, 200);
    assert.equal(
      (await f.api(path(id), { ...correction, trackingNo: correction.trackingNo.toLowerCase() }, k))
        .status,
      200,
    );
    assert.equal((await f.api(path(id), { ...correction, reason: 'changed' }, k)).status, 409);
    assert.deepEqual(await stock(f), before);
    const v = await read(f, id);
    assert.equal(v.shipment!.trackingNo, correction.trackingNo);
    assert.equal(v.shipment!.shippedAt, initial.shipment!.shippedAt);
    assert.equal(v.shipment!.correctionVersion, 1);
    assert.ok(v.shipment!.correctedAt);
    assert.equal(v.shipmentHistory.length, 2);
    assert.equal(v.shipmentHistory[0]!.trackingNo, ship.trackingNo);
    assert.equal(v.shipmentHistory[1]!.reason, correction.reason);
    for (const r of [
      await f.call<RedemptionOrderView>('/consumer/redemptions/' + id),
      await f.api('/admin/redemptions/' + id),
    ]) {
      assert.equal(r.status, 200);
      const data = r.data as unknown as RedemptionOrderView;
      assert.equal(data.expressShipment!.trackingNo, correction.trackingNo);
      assert.equal('reason' in data.expressShipment!, false);
      assert.equal('actorName' in data.expressShipment!, false);
      assert.equal('shipmentHistory' in data, false);
    }
    const list = await f.api('/admin/redemptions?fulfillment=EXPRESS_SHIPPED');
    assert.equal(
      (list.data.items[0]!.expressShipment as unknown as { trackingNo: string }).trackingNo,
      correction.trackingNo,
    );
    const print = await f.api('/admin/redemptions/print-preview', { ids: [id] });
    assert.equal(
      (print.data as unknown as RedemptionPrintPreview).items[0]!.expressShipment!.trackingNo,
      correction.trackingNo,
    );
    assert.equal(
      (await f.call('/consumer/redemptions/' + id + '/cancel', { version: 0 })).status,
      409,
    );
    assert.equal((await f.api('/admin/redemptions/' + id + '/ship', ship)).status, 409);
    assert.equal(
      (
        await f.api(path(id), {
          ...correction,
          version: 1,
          trackingNo: ship.trackingNo,
          carrierCode: 'SF',
          reason: '核对后恢复原资料',
        })
      ).status,
      200,
    );
    assert.equal((await read(f, id)).shipmentHistory.length, 3);
    await assert.rejects(
      f.runtime.db.redemptionExpressShipmentCorrection.updateMany({
        data: { reason: 'overwrite' },
      }),
    );
    await assert.rejects(f.runtime.db.redemptionExpressShipmentCorrection.deleteMany());
  }));

test('scoped permissions, ownership, csrf, strict inputs, existing shipment and revision are enforced; paused gate still permits successful original-key recovery', async () =>
  setup(async (f, id) => {
    const picker = await f.workerActor('PICKER');
    assert.equal(
      (await f.api(path(id), correction, randomUUID(), picker.cookie, picker.csrf)).status,
      403,
    );
    assert.equal((await f.api(path(id), correction, randomUUID(), f.cookie, 'bad')).status, 403);
    assert.equal(
      (await f.call('/consumer/redemptions/' + id, undefined, randomUUID(), f.identityB.token))
        .status,
      404,
    );
    const w = randomUUID();
    await f.runtime.db.warehouse.create({ data: { id: w, code: 'E4-OTHER', name: '合成异仓' } });
    const other = await f.workerActor('OPERATIONS', w);
    assert.equal(
      (await f.api(path(id), correction, randomUUID(), other.cookie, other.csrf)).status,
      403,
    );
    for (const bad of [
      { ...correction, verified: false },
      { ...correction, reason: '' },
      { ...correction, reason: 'bad\nreason' },
      { ...correction, carrierCode: 'BAD' },
      { ...correction, trackingNo: 'bad' },
      { ...correction, carrierCode: 'OTHER' },
      { ...correction, extra: true },
    ])
      assert.equal((await f.api(path(id), bad)).status, 400);
    assert.equal((await f.api(path(id), { ...correction, version: 1 })).status, 409);
    assert.equal(
      (await f.api(path(id), { ...correction, carrierCode: 'SF', trackingNo: ship.trackingNo }))
        .status,
      409,
    );
    const pending = await f.createExpress();
    assert.equal((await f.api(path(pending), correction)).status, 409);
    assert.equal(
      (await f.call('/consumer/redemptions/' + pending + '/cancel', { version: 0 })).status,
      200,
    );
    assert.equal((await f.api(path(pending), correction)).status, 409);
    const q = await f.call('/consumer/redemption-quotes', f.input),
      local = await f.call('/consumer/redemptions', { quoteId: q.data.id });
    assert.equal((await f.api(path(local.data.id), correction)).status, 409);
    const key = randomUUID();
    assert.equal((await f.api(path(id), correction, key)).status, 200);
    const service = f.runtime.app.get(ExpressShippingService),
      enabled = service.enabled;
    Object.defineProperty(service, 'enabled', { value: false, configurable: true });
    try {
      assert.equal((await read(f, id)).canCorrect, false);
      assert.equal((await f.api(path(id), correction, key)).status, 200);
      assert.equal(
        (await f.api(path(id), { ...correction, version: 1, trackingNo: 'ZTO-E4-002' })).status,
        503,
      );
    } finally {
      Object.defineProperty(service, 'enabled', { value: enabled, configurable: true });
    }
    await f.runtime.db.staffWarehouse.deleteMany({
      where: {
        staffId: (await f.runtime.db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } }))
          .id,
      },
    });
    assert.equal((await f.api(path(id), correction, key)).status, 403);
  }));

test('competing revisions serialize, historical tracking cannot be reused by correction or a new shipment, and duplicate identity races settle once', async () =>
  setup(async (f, id) => {
    const result = await Promise.all([
      f.api(path(id), correction),
      f.api(path(id), { ...correction, trackingNo: 'ZTO-E4-002' }),
    ]);
    assert.deepEqual(result.map((x) => x.status).sort(), [200, 409]);
    const other = await f.createExpress();
    assert.equal(
      (
        await f.api('/admin/redemptions/' + other + '/ship', {
          ...ship,
          trackingNo: 'SF-E4-OTHER-001',
        })
      ).status,
      200,
    );
    const latest = (await read(f, id)).shipment!;
    assert.equal(
      (await f.api(path(other), { ...correction, carrierCode: 'SF', trackingNo: ship.trackingNo }))
        .status,
      409,
    );
    assert.equal(
      (
        await f.api(path(other), {
          ...correction,
          carrierCode: latest.carrierCode,
          trackingNo: latest.trackingNo,
        })
      ).status,
      409,
    );
    const race = await Promise.all([
      f.api(path(id), { ...correction, version: 1, trackingNo: 'ZTO-E4-SHARED-001' }),
      f.api(path(other), { ...correction, trackingNo: 'ZTO-E4-SHARED-001' }),
    ]);
    assert.deepEqual(race.map((x) => x.status).sort(), [200, 409]);
    const pending = await f.createExpress();
    assert.equal(
      (
        await f.api('/admin/redemptions/' + pending + '/ship', {
          ...ship,
          carrierCode: latest.carrierCode,
          trackingNo: latest.trackingNo,
        })
      ).status,
      409,
    );
  }));

for (const phase of ['audit', 'session'])
  test(
    'late ' +
      phase +
      ' failure rolls back correction, tracking claim, audit and key; same original request recovers',
    async () =>
      setup(async (f, id) => {
        const d = f.runtime.db,
          k = randomUUID(),
          before = await stock(f),
          claims = await d.$queryRawUnsafe(
            'SELECT * FROM redemption_express_waybills ORDER BY tracking_no',
          );
        await d.$executeRawUnsafe(
          "CREATE FUNCTION fail_e4() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='REDEMPTION_EXPRESS_CORRECT' THEN " +
            (phase === 'audit'
              ? "RAISE EXCEPTION 'synthetic';"
              : "UPDATE staff_sessions SET created_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()-interval '1 millisecond' WHERE staff_id=NEW.actor_id;") +
            ' END IF; RETURN NEW; END $$',
        );
        await d.$executeRawUnsafe(
          'CREATE TRIGGER fail_e4 BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_e4()',
        );
        assert.equal((await f.api(path(id), correction, k)).status, phase === 'audit' ? 500 : 403);
        assert.equal(await d.redemptionExpressShipmentCorrection.count(), 0);
        assert.deepEqual(await stock(f), before);
        assert.deepEqual(
          await d.$queryRawUnsafe('SELECT * FROM redemption_express_waybills ORDER BY tracking_no'),
          claims,
        );
        await d.$executeRawUnsafe('DROP TRIGGER fail_e4 ON business_audits');
        assert.equal((await f.api(path(id), correction, k)).status, 200);
        assert.equal((await f.api(path(id), correction, k)).status, 200);
        assert.equal(await d.redemptionExpressShipmentCorrection.count(), 1);
      }),
  );

test('database rejects broken history, fake tracking claims, wrong current actor and mutation; paused catalog stock does not prevent correcting an already dispatched parcel', async () =>
  setup(async (f, id) => {
    const d = f.runtime.db,
      s = await d.redemptionExpressShipment.findUniqueOrThrow({ where: { orderId: id } }),
      actor = await d.staff.findUniqueOrThrow({ where: { id: s.actorId } });
    const raw = {
      id: randomUUID(),
      shipmentId: s.id,
      version: 2,
      carrierCode: 'ZTO',
      carrierName: '中通快递',
      trackingNo: 'ZTO-E4-RAW-001',
      reason: '合成SQL检查',
      actorId: actor.id,
      actorName: actor.displayName,
      requestId: randomUUID(),
    };
    await assert.rejects(d.redemptionExpressShipmentCorrection.create({ data: raw }));
    await assert.rejects(
      d.redemptionExpressShipmentCorrection.create({
        data: { ...raw, version: 1, actorName: 'wrong' },
      }),
    );
    await assert.rejects(
      d.$executeRawUnsafe(
        `INSERT INTO redemption_express_waybills(warehouse_id,carrier_code,carrier_name,tracking_no,shipment_id) VALUES('${f.warehouseId}','SF','顺丰速运','SF-E4-FAKE-001','${s.id}')`,
      ),
    );
    await assert.rejects(d.$executeRawUnsafe('DELETE FROM redemption_express_waybills'));
    await d.stockBalance.update({
      where: { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.catalog.skuIds[0]! } },
      data: { inventoryHold: true },
    });
    assert.equal(
      (await f.api(path(id), { ...correction, carrierCode: 'OTHER', carrierName: '合成承运商' }))
        .status,
      200,
    );
    assert.equal((await read(f, id)).shipment!.carrierName, '合成承运商');
  }));
