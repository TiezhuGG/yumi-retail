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
test('return queues follow per-piece decisions and receipts; original-points differences block readiness without writes', async () => {
  const f = await expressShippingFixture();
  try {
    const id = await f.createExpress(3);
    assert.equal(
      (
        await f.api('/admin/redemptions/' + id + '/ship', {
          version: 0,
          carrierCode: 'SF',
          trackingNo: 'SF-RETURN-QUEUE',
          dispatchConfirmed: true,
        })
      ).status,
      200,
    );
    const request = async () => {
      const r = await f.call('/consumer/redemptions/' + id + '/returns', {
        quantity: 1,
        reason: '合成待办测试',
      });
      assert.equal(r.status, 200);
      return r.data.id as string;
    };
    const action = async (rid: string, name: string, body: unknown) =>
      assert.equal(
        (await f.api('/admin/redemption-returns/' + rid + '/' + name, body)).status,
        200,
      );
    const counts = async (expected: number[]) => {
      const data = (await f.api(endpoint)).data as unknown as ExpressReadiness;
      assert.deepEqual(
        [
          data.metrics.returnsRequested,
          data.metrics.returnsWaitingReceipt,
          data.metrics.returnsReadyToRefund,
        ],
        expected,
      );
      assert.equal(data.metrics.inconsistentReturns, 0);
      // Queue totals use exactly the same filters as the destination lists.
      for (const [i, status] of ['REQUESTED', 'WAIT_RETURN', 'READY_TO_REFUND'].entries()) {
        const r = await fetch(f.base + '/api/v1/admin/redemption-returns?status=' + status, {
          headers: { Cookie: f.cookie },
        });
        assert.equal(r.status, 200);
        assert.equal((await r.json()).data.items.length, expected[i]);
      }
    };
    const rejected = await request();
    await action(rejected, 'reject', { reason: '合成驳回' });
    const canceled = await request();
    assert.equal(
      (await f.call('/consumer/redemptions/' + id + '/returns/' + canceled + '/cancel', {})).status,
      200,
    );
    const a = await request(),
      b = await request(),
      c = await request();
    await counts([3, 0, 0]);
    await action(a, 'approve', { requiresReturn: true, reason: '需退回' });
    await action(b, 'approve', { requiresReturn: false, reason: '免退回' });
    await counts([1, 1, 1]);
    await action(a, 'receive', {
      quantity: 1,
      condition: 'DAMAGED',
      location: '合成隔离区',
      physicalConfirmed: true,
      reason: '完整验收',
    });
    await counts([1, 0, 2]);
    await action(a, 'refund', { confirmed: true, reason: '退还原积分' });
    await counts([1, 0, 1]);
    await action(c, 'reject', { reason: '合成驳回' });
    await action(b, 'refund', { confirmed: true, reason: '免退回原积分' });
    await counts([0, 0, 0]);
    const db = f.runtime.db;
    const scope = (
      await db.$queryRaw<Array<{ schema: string }>>`SELECT current_schema() AS schema`
    )[0]!.schema;
    assert.match(scope, /^address_ui_[a-f0-9]+$/);
    // Only corrupt a disposable schema to prove reconciliation detects a mismatched credit.
    await db.$executeRawUnsafe('ALTER TABLE points_ledger DISABLE TRIGGER points_ledger_immutable');
    await db.$executeRaw`UPDATE points_ledger SET delta=delta+1 WHERE action_key=${'RETURN_REFUND:' + a}`;
    const before = await db.businessAudit.count();
    const result = (await f.api(endpoint)).data as unknown as ExpressReadiness;
    assert.equal(result.metrics.inconsistentReturns, 1);
    assert.equal(result.checks.find((c) => c.code === 'INVARIANTS')!.status, 'BLOCKED');
    assert.equal(await db.businessAudit.count(), before);
    assert.equal(JSON.stringify(result).includes('合成待办测试'), false);
    await db.$executeRaw`UPDATE points_ledger SET delta=delta-1 WHERE action_key=${'RETURN_REFUND:' + a}`;
    await db.$executeRawUnsafe('ALTER TABLE points_ledger ENABLE TRIGGER points_ledger_immutable');
    await counts([0, 0, 0]);
  } finally {
    await f.cleanup();
  }
});
