import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { WaybillImportPreview, RedemptionOrderView } from '../packages/contracts/src/index.ts';
import { WAYBILL_CSV_HEADER } from '../packages/contracts/src/index.ts';
import { expressShippingFixture } from './helpers/express-shipping-fixture.ts';
import { ExpressShippingService } from '../apps/api/dist/express-shipping.js';
const pp = '/admin/redemptions/waybill-import/preview',
  cp = '/admin/redemptions/waybill-import/confirm';
type F = Awaited<ReturnType<typeof expressShippingFixture>>;
const csv = (orderNos: string[], tracking = ['SF-BATCH-001', 'SF-BATCH-002']) =>
  WAYBILL_CSV_HEADER.join(',') +
  '\n' +
  orderNos.map((n, i) => [n, 'SF', '', tracking[i]].join(',')).join('\n');
async function setup(work: (f: F, ids: string[], nos: string[]) => Promise<void>) {
  const f = await expressShippingFixture();
  try {
    const ids = [await f.createExpress(), await f.createExpress(2)],
      orders = await f.runtime.db.redemptionOrder.findMany({ where: { id: { in: ids } } });
    await work(
      f,
      ids,
      ids.map((id) => orders.find((o) => o.id === id)!.orderNo),
    );
  } finally {
    await f.cleanup();
  }
}
async function preview(f: F, input: string) {
  const r = await f.api(pp, { csv: input });
  return { status: r.status, data: r.data as unknown as WaybillImportPreview };
}
const body = (v: WaybillImportPreview) => ({
  items: v.items.map((o) => ({
    id: o.id,
    version: o.version,
    carrierCode: o.carrierCode,
    carrierName: o.carrierName,
    trackingNo: o.trackingNo,
  })),
  dispatchConfirmed: true,
});
async function snapshot(f: F) {
  const d = f.runtime.db;
  return {
    orders: await d.redemptionOrder.findMany({ orderBy: { id: 'asc' } }),
    shipments: await d.redemptionExpressShipment.findMany({ orderBy: { id: 'asc' } }),
    parcels: await d.redemptionExpressParcel.count(),
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
test('preview is read-only and batch ships each original allocation exactly once without points or implicit parcels', async () =>
  setup(async (f, ids, nos) => {
    const before = await snapshot(f),
      p = await preview(f, csv(nos));
    assert.equal(p.status, 200);
    assert.equal(p.data.canShip, true);
    assert.deepEqual(
      p.data.items.map((o) => o.orderNo),
      nos,
    );
    assert.ok(p.data.items.every((o) => o.allocations.length));
    assert.deepEqual(await snapshot(f), before);
    const b = body(p.data),
      key = randomUUID(),
      result = await f.api(cp, b, key);
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(
      (
        await f.api(
          cp,
          {
            ...b,
            items: [...b.items]
              .reverse()
              .map((x) => ({ ...x, trackingNo: x.trackingNo.toLowerCase() })),
          },
          key,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await f.api(
          cp,
          { ...b, items: b.items.map((x) => ({ ...x, trackingNo: x.trackingNo + '-CHANGED' })) },
          key,
        )
      ).status,
      409,
    );
    assert.equal((await f.api(cp, b)).status, 409);
    const after = await snapshot(f);
    assert.equal(after.shipments.length, 2);
    assert.equal(after.parcels, 0);
    assert.ok(after.jobs.every((j) => j.state === 'EXPRESS_SHIPPED'));
    assert.equal(after.ledger, before.ledger + 2);
    assert.deepEqual(after.points, before.points);
    assert.equal(after.entries, before.entries);
    assert.deepEqual(after.orders, before.orders);
    const old = before.stock.find((s) => s.skuId === f.catalog.skuIds[0])!,
      next = after.stock.find((s) => s.skuId === old.skuId)!;
    assert.equal(next.onHand, old.onHand - 3);
    assert.equal(next.reserved, old.reserved - 3);
    for (let i = 0; i < ids.length; i++) {
      const read = await f.call<RedemptionOrderView>('/consumer/redemptions/' + ids[i]);
      assert.equal(read.data.expressShipment!.trackingNo, b.items[i]!.trackingNo);
      assert.equal(read.data.expressShipment!.parcel, undefined);
    }
  }));
test('invalid CSV, duplicate tracking/order, missing orders and canceled rows never permit partial preview or shipment', async () =>
  setup(async (f, ids, nos) => {
    const before = await snapshot(f);
    for (const c of [
      'bad',
      csv([nos[0]!, nos[0]!]),
      csv(nos, ['SF-SAME-001', 'sf-same-001']),
      csv(nos, ['=FORMULA', 'SF-OKAY-001']),
    ])
      assert.equal((await preview(f, c)).status, 400);
    assert.deepEqual(await snapshot(f), before);
    const missing = await preview(f, csv([nos[0]!, 'R' + 'F'.repeat(32)]));
    assert.equal(missing.data.canShip, false);
    assert.deepEqual(missing.data.items, []);
    assert.equal(missing.data.issues[0]!.row, 3);
    const good = await preview(f, csv(nos));
    assert.equal(
      (await f.call('/consumer/redemptions/' + ids[1] + '/cancel', { version: 0 })).status,
      200,
    );
    const afterCancel = await snapshot(f);
    assert.equal((await f.api(cp, body(good.data))).status, 409);
    assert.deepEqual(await snapshot(f), afterCancel);
    const stale = await preview(f, csv(nos));
    assert.equal(stale.data.canShip, false);
    assert.deepEqual(stale.data.items, []);
  }));
test('strict confirm fields, versions, physical declaration, role, csrf and current warehouse are enforced', async () =>
  setup(async (f, ids, nos) => {
    const p = await preview(f, csv(nos)),
      b = body(p.data),
      before = await snapshot(f);
    for (const request of [
      { ...b, dispatchConfirmed: false },
      { ...b, items: [] },
      { ...b, items: [b.items[0], b.items[0]] },
      { ...b, extra: true },
      { ...b, items: Array.from({ length: 21 }, () => b.items[0]) },
    ])
      assert.equal((await f.api(cp, request)).status, 400);
    assert.equal(
      (await f.api(cp, { ...b, items: b.items.map((x) => ({ ...x, version: 1 })) })).status,
      409,
    );
    const picker = await f.workerActor('PICKER');
    assert.equal((await f.api(cp, b, randomUUID(), picker.cookie, picker.csrf)).status, 403);
    assert.equal(
      (await f.api(pp, { csv: csv(nos) }, randomUUID(), picker.cookie, picker.csrf)).status,
      403,
    );
    assert.equal((await f.api(cp, b, randomUUID(), f.cookie, 'invalid')).status, 403);
    // Staff actor provisioning changes non-business authorization rows only.
    assert.deepEqual(await snapshot(f), before);
    const staff = await f.runtime.db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } });
    await f.runtime.db.staffWarehouse.deleteMany({ where: { staffId: staff.id } });
    assert.equal((await f.api(cp, b)).status, 403);
  }));
test('inventory hold or late audit failure rolls back every row and the original key can recover once', async () =>
  setup(async (f, ids, nos) => {
    const p = await preview(f, csv(nos)),
      b = body(p.data),
      d = f.runtime.db,
      key = randomUUID();
    await d.stockBalance.update({
      where: { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.catalog.skuIds[0]! } },
      data: { inventoryHold: true },
    });
    const held = await snapshot(f);
    assert.equal((await f.api(cp, b, key)).status, 409);
    assert.deepEqual(await snapshot(f), held);
    assert.deepEqual((await preview(f, csv(nos))).data.items, []);
    await d.stockBalance.update({
      where: { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.catalog.skuIds[0]! } },
      data: { inventoryHold: false },
    });
    await d.$executeRawUnsafe(
      "CREATE FUNCTION fail_import_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='REDEMPTION_EXPRESS_BATCH_SHIP' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$",
    );
    await d.$executeRawUnsafe(
      'CREATE TRIGGER fail_import_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_import_audit()',
    );
    const before = await snapshot(f);
    assert.equal((await f.api(cp, b, key)).status, 500);
    assert.deepEqual(await snapshot(f), before);
    await d.$executeRawUnsafe('DROP TRIGGER fail_import_audit ON business_audits');
    assert.equal((await f.api(cp, b, key)).status, 200);
    assert.equal((await f.api(cp, b, key)).status, 200);
    assert.equal(await d.redemptionExpressShipment.count(), 2);
  }));
for (const competitor of ['single', 'parcel', 'batch', 'cancel'])
  test('batch racing ' + competitor + ' settles one complete outcome', async () =>
    setup(async (f, ids, nos) => {
      const b = body((await preview(f, csv(nos))).data);
      const other =
        competitor === 'single'
          ? f.api('/admin/redemptions/' + ids[0] + '/ship', {
              version: 0,
              carrierCode: 'ZTO',
              trackingNo: 'ZTO-RACE-ONE',
              dispatchConfirmed: true,
            })
          : competitor === 'parcel'
            ? f.api('/admin/redemptions/ship-parcel', {
                orders: ids.map((id) => ({ id, version: 0 })),
                carrierCode: 'ZTO',
                trackingNo: 'ZTO-RACE-PARCEL',
                dispatchConfirmed: true,
              })
            : competitor === 'cancel'
              ? f.call('/consumer/redemptions/' + ids[0] + '/cancel', { version: 0 })
              : f.api(cp, {
                  ...b,
                  items: b.items.map((x) => ({ ...x, trackingNo: x.trackingNo + '-ALT' })),
                });
      const rs = await Promise.all([f.api(cp, b), other]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
      const count = await f.runtime.db.redemptionExpressShipment.count();
      assert.equal(
        count,
        rs[0]!.status === 200 ? 2 : competitor === 'single' ? 1 : competitor === 'cancel' ? 0 : 2,
      );
      assert.equal(
        await f.runtime.db.stockLedger.count({
          where: { actionKey: { startsWith: 'REDEMPTION_SHIP:' } },
        }),
        count,
      );
    }),
  );
for (const phase of ['session', 'lot'])
  test('late ' + phase + ' expiry rolls back every imported row', async () =>
    setup(async (f, ids, nos) => {
      const b = body((await preview(f, csv(nos))).data),
        d = f.runtime.db,
        before = await snapshot(f);
      await d.$executeRawUnsafe(
        "CREATE FUNCTION expire_import() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='REDEMPTION_EXPRESS_BATCH_SHIP' THEN " +
          (phase === 'session'
            ? "UPDATE staff_sessions SET created_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()-interval '1 millisecond' WHERE staff_id=NEW.actor_id;"
            : "UPDATE stock_lots SET produced_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 millisecond';") +
          ' END IF; RETURN NEW; END $$',
      );
      await d.$executeRawUnsafe(
        'CREATE TRIGGER expire_import BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION expire_import()',
      );
      assert.equal((await f.api(cp, b)).status, phase === 'session' ? 403 : 409);
      assert.deepEqual(await snapshot(f), before);
    }),
  );
test('successful original request remains recoverable when shipping paused, but authorization is rechecked', async () =>
  setup(async (f, ids, nos) => {
    const b = body((await preview(f, csv(nos))).data),
      svc = f.runtime.app.get(ExpressShippingService),
      key = randomUUID();
    assert.equal((await f.api(cp, b, key)).status, 200);
    Object.defineProperty(svc, 'enabled', { value: false, configurable: true });
    assert.equal((await f.api(cp, b, key)).status, 200);
    assert.equal((await f.api(cp, b)).status, 409);
    const fresh = await f.createExpress();
    assert.equal(
      (
        await f.api(cp, {
          items: [{ id: fresh, version: 0, carrierCode: 'SF', trackingNo: 'SF-PAUSED-FRESH-001' }],
          dispatchConfirmed: true,
        })
      ).status,
      503,
    );
    const staff = await f.runtime.db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } });
    await f.runtime.db.staffWarehouse.deleteMany({ where: { staffId: staff.id } });
    assert.equal((await f.api(cp, b, key)).status, 403);
  }));
test('one batch can ship different customers and SKUs without merging packages or touching unselected reservations', async () =>
  setup(async (f, ids, nos) => {
    const published = await f.api('/admin/rewards/store/create', {
      skuId: f.catalog.skuIds[1],
      title: '合成三包装',
      pointsPrice: '200',
      sortOrder: 20,
      perUserLimit: 3,
      totalQuota: 20,
      startsAt: null,
      endsAt: null,
      reason: '合成导入多规格',
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
    const a = await f.call(
      '/consumer/express-addresses',
      {
        version: 0,
        province: '浙江省',
        city: '杭州市',
        district: '西湖区',
        detailAddress: '合成顾客B地址999',
        contactName: '合成顾客B收件人',
        phone: '00000000001',
        note: '合成不同收件信息',
        isDefault: true,
      },
      randomUUID(),
      f.identityB.token,
    );
    assert.equal(a.status, 200);
    const q = await f.call(
      '/consumer/redemption-quotes',
      {
        ...f.input,
        rewardId: published.data.id,
        quantity: 1,
        deliveryMode: 'EXPRESS',
        addressId: a.data.id,
        addressVersion: 1,
      },
      randomUUID(),
      f.identityB.token,
    );
    assert.equal(q.status, 200);
    const o = await f.call(
      '/consumer/redemptions',
      { quoteId: q.data.id },
      randomUUID(),
      f.identityB.token,
    );
    assert.equal(o.status, 200);
    const order = await f.runtime.db.redemptionOrder.findUniqueOrThrow({
        where: { id: o.data.id },
      }),
      before = await snapshot(f),
      p = await preview(f, csv([nos[0]!, order.orderNo]));
    assert.equal(p.data.canShip, true);
    assert.equal(p.data.items[1]!.address.contactName, '合成顾客B收件人');
    assert.equal((await f.api(cp, body(p.data))).status, 200);
    const after = await snapshot(f);
    assert.deepEqual(after.points, before.points);
    for (const skuId of f.catalog.skuIds) {
      const old = before.stock.find((x) => x.skuId === skuId)!,
        next = after.stock.find((x) => x.skuId === skuId)!;
      assert.equal(next.onHand, old.onHand - 1);
      assert.equal(next.reserved, old.reserved - 1);
    }
    assert.equal(after.jobs.find((j) => j.orderId === ids[1])!.state, 'EXPRESS_WAIT');
    assert.equal(after.parcels, 0);
    assert.equal((await f.call('/consumer/redemptions/' + o.data.id)).status, 404);
  }));
test('original and corrected historical waybill identities block both preview and confirmation', async () =>
  setup(async (f, ids, nos) => {
    assert.equal(
      (
        await f.api('/admin/redemptions/' + ids[0] + '/ship', {
          version: 0,
          carrierCode: 'SF',
          trackingNo: 'SF-HISTORY-IMPORT-01',
          dispatchConfirmed: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.api('/admin/redemptions/' + ids[0] + '/shipping-corrections', {
          version: 0,
          carrierCode: 'ZTO',
          trackingNo: 'ZTO-HISTORY-IMPORT-01',
          reason: '合成更正运单',
          verified: true,
        })
      ).status,
      200,
    );
    const third = await f.createExpress(),
      o = await f.runtime.db.redemptionOrder.findUniqueOrThrow({ where: { id: third } }),
      before = await snapshot(f);
    const rows = [
      { id: ids[1], orderNo: nos[1], carrierCode: 'SF', trackingNo: 'SF-HISTORY-IMPORT-01' },
      { id: third, orderNo: o.orderNo, carrierCode: 'ZTO', trackingNo: 'ZTO-HISTORY-IMPORT-01' },
    ];
    const input =
      WAYBILL_CSV_HEADER.join(',') +
      '\n' +
      rows.map((r) => [r.orderNo, r.carrierCode, '', r.trackingNo].join(',')).join('\n');
    const p = await preview(f, input);
    assert.equal(p.data.canShip, false);
    assert.equal(p.data.issues.length, 2);
    assert.deepEqual(p.data.items, []);
    assert.equal(
      (
        await f.api(cp, {
          items: rows.map((r) => ({
            id: r.id,
            version: 0,
            carrierCode: r.carrierCode,
            trackingNo: r.trackingNo,
          })),
          dispatchConfirmed: true,
        })
      ).status,
      409,
    );
    assert.deepEqual(await snapshot(f), before);
  }));
