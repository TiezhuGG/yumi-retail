import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expressShippingFixture } from './helpers/express-shipping-fixture.ts';
import type { ExpressReadiness } from '../packages/contracts/src/index.ts';
const endpoint = '/admin/redemption-express-readiness';
test('readiness reports real scoped metrics, no launch, no cash/rider gates and no private fields or writes', async () => {
  const f = await expressShippingFixture();
  try {
    const before = await f.runtime.db.businessAudit.count();
    const empty = await f.api(endpoint);
    assert.equal(empty.status, 200);
    const v = empty.data as unknown as ExpressReadiness;
    assert.equal(v.canLaunch, false);
    assert.equal(v.metrics.waiting, 0);
    assert.equal(v.metrics.oldestWaitingAt, null);
    assert.equal(v.checks.find((c) => c.code === 'WECHAT_IDENTITY')!.status, 'BLOCKED');
    assert.equal(
      v.checks.some((c) => ['REAL_PAYMENT', 'RIDER'].includes(c.code)),
      false,
    );
    const id = await f.createExpress();
    const wait = (await f.api(endpoint)).data as unknown as ExpressReadiness;
    assert.equal(wait.metrics.waiting, 1);
    assert.ok(wait.metrics.oldestWaitingAt);
    assert.equal(wait.metrics.inconsistentOrders, 0);
    assert.equal(
      (
        await f.api('/admin/redemptions/' + id + '/ship', {
          version: 0,
          carrierCode: 'SF',
          trackingNo: 'SF-READINESS-001',
          dispatchConfirmed: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.call('/consumer/redemptions/' + id + '/after-sales', {
          category: 'OTHER',
          message: '合成首发反馈说明',
        })
      ).status,
      200,
    );
    const count = await f.runtime.db.businessAudit.count(),
      entries = await f.runtime.db.pointsEntry.count(),
      stock = await f.runtime.db.stockLedger.count();
    const r = await f.api(endpoint),
      data = r.data as unknown as ExpressReadiness;
    assert.equal(data.metrics.waiting, 0);
    assert.equal(data.metrics.shipped, 1);
    assert.equal(data.metrics.openFeedback, 1);
    assert.equal(
      data.metrics.inconsistentOrders +
        data.metrics.inconsistentFeedback +
        data.metrics.inconsistentWaybills,
      0,
    );
    assert.equal(JSON.stringify(data).includes(id), false);
    assert.equal(JSON.stringify(data).includes('SF-READINESS-001'), false);
    assert.equal(JSON.stringify(data).includes('合成首发反馈说明'), false);
    assert.equal('address' in data, false);
    assert.equal(await f.runtime.db.businessAudit.count(), count);
    assert.equal(await f.runtime.db.pointsEntry.count(), entries);
    assert.equal(await f.runtime.db.stockLedger.count(), stock);
    assert.ok(count > before);
    const denied = await f.api(endpoint + '?warehouseId=' + randomUUID());
    assert.equal(denied.status, 400);
    const picker = await f.workerActor('PICKER');
    assert.equal(
      (await f.api(endpoint, undefined, randomUUID(), picker.cookie, picker.csrf)).status,
      403,
    );
    const w = randomUUID();
    await f.runtime.db.warehouse.create({
      data: { id: w, code: 'READINESS-OTHER', name: '合成异仓' },
    });
    const other = await f.workerActor('OPERATIONS', w);
    assert.equal(
      (await f.api(endpoint, undefined, randomUUID(), other.cookie, other.csrf)).status,
      403,
    );
    const http = await fetch(f.base + '/api/v1' + endpoint, { headers: { Cookie: f.cookie } });
    assert.equal(http.headers.get('cache-control'), 'no-store');
  } finally {
    await f.cleanup();
  }
});
test('missing operational configuration stays blocked, request failures do not imply no discrepancies', async () => {
  const f = await expressShippingFixture();
  try {
    await f.runtime.db.redemptionExpressPolicy.update({
      where: { warehouseId: f.warehouseId },
      data: { enabled: false },
    });
    const data = (await f.api(endpoint)).data as unknown as ExpressReadiness;
    assert.equal(data.checks.find((c) => c.code === 'EXPRESS_POLICY')!.status, 'BLOCKED');
    assert.equal(data.canLaunch, false);
    const actor = await f.runtime.db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } });
    await f.runtime.db.staffWarehouse.deleteMany({ where: { staffId: actor.id } });
    assert.equal((await f.api(endpoint)).status, 403);
  } finally {
    await f.cleanup();
  }
});
test('readiness detects a broken historical waybill claim and stops reporting a clean consistency check', async () => {
  const f = await expressShippingFixture();
  try {
    const id = await f.createExpress();
    assert.equal(
      (
        await f.api('/admin/redemptions/' + id + '/ship', {
          version: 0,
          carrierCode: 'SF',
          trackingNo: 'SF-READINESS-DIFF-001',
          dispatchConfirmed: true,
        })
      ).status,
      200,
    );
    const d = f.runtime.db,
      scope = (await d.$queryRaw<Array<{ schema: string }>>`SELECT current_schema() AS schema`)[0]!
        .schema;
    assert.match(scope, /^address_ui_[a-f0-9]+$/);
    // Synthetic corruption only inside the disposable test schema, to exercise monitoring.
    await d.$executeRawUnsafe(
      'ALTER TABLE redemption_express_waybills DISABLE TRIGGER express_waybill_immutable',
    );
    const s = await d.redemptionExpressShipment.findUniqueOrThrow({ where: { orderId: id } });
    await d.$executeRaw`DELETE FROM redemption_express_waybills WHERE shipment_id=${s.id}::uuid`;
    const result = (await f.api(endpoint)).data as unknown as ExpressReadiness;
    assert.equal(result.metrics.inconsistentWaybills, 1);
    assert.equal(result.checks.find((c) => c.code === 'INVARIANTS')!.status, 'BLOCKED');
    assert.equal(result.canLaunch, false);
    await d.$executeRaw`INSERT INTO redemption_express_waybills(warehouse_id,carrier_code,carrier_name,tracking_no,shipment_id) VALUES(${s.warehouseId}::uuid,${s.carrierCode},${s.carrierName},${s.trackingNo},${s.id}::uuid)`;
    await d.$executeRawUnsafe(
      'ALTER TABLE redemption_express_waybills ENABLE TRIGGER express_waybill_immutable',
    );
    assert.equal(
      ((await f.api(endpoint)).data as unknown as ExpressReadiness).metrics.inconsistentWaybills,
      0,
    );
  } finally {
    await f.cleanup();
  }
});
