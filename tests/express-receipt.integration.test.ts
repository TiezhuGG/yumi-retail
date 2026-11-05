import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { expressShippingFixture } from './helpers/express-shipping-fixture.ts';
import { RedemptionAfterSalesService } from '../apps/api/dist/redemption-after-sales.js';
import type { RedemptionOrderPage, RedemptionOrderView } from '../packages/contracts/src/index.ts';
type F = Awaited<ReturnType<typeof expressShippingFixture>>;
const path = (id: string) => '/consumer/redemptions/' + id + '/confirm-receipt';
async function ship(f: F, id: string) {
  assert.equal(
    (
      await f.api('/admin/redemptions/' + id + '/ship', {
        version: 0,
        carrierCode: 'SF',
        trackingNo: 'SF-RECEIPT-' + id.slice(0, 8),
        dispatchConfirmed: true,
      })
    ).status,
    200,
  );
}
async function snapshot(f: F) {
  return {
    orders: await f.runtime.db.redemptionOrder.findMany(),
    points: await f.runtime.db.pointsAccount.findMany(),
    entries: await f.runtime.db.pointsEntry.findMany(),
    stock: await f.runtime.db.stockBalance.findMany(),
    ledger: await f.runtime.db.stockLedger.findMany(),
    allocations: await f.runtime.db.redemptionAllocation.findMany(),
  };
}
test('only the owner can confirm an active shipped order, repeated and competing requests record one immutable receipt without touching points or stock', async () => {
  const f = await expressShippingFixture();
  try {
    const id = await f.createExpress();
    assert.equal((await f.call(path(id), { received: true })).status, 409);
    await ship(f, id);
    const shipment = await f.runtime.db.redemptionExpressShipment.findUniqueOrThrow({
      where: { orderId: id },
    });
    await assert.rejects(
      f.runtime.db.redemptionExpressReceipt.create({
        data: { shipmentId: shipment.id, userId: f.identityB.user.id, requestId: randomUUID() },
      }),
    );
    const before = await snapshot(f);
    assert.equal(
      (await f.call(path(id), { received: true }, undefined, f.identityB.token)).status,
      404,
    );
    assert.equal((await f.api(path(id), { received: true })).status, 401);
    for (const body of [{ received: false }, { received: true, userId: f.identityB.user.id }, {}])
      assert.equal((await f.call(path(id), body)).status, 400);
    const key = randomUUID();
    const rs = await Promise.all([
      f.call(path(id), { received: true }, key),
      f.call(path(id), { received: true }, key),
      f.call(path(id), { received: true }),
    ]);
    assert.deepEqual(
      rs.map((r) => r.status),
      [200, 200, 200],
    );
    assert.deepEqual(rs[0]!.data, rs[1]!.data);
    assert.deepEqual(rs[0]!.data, rs[2]!.data);
    assert.equal(await f.runtime.db.redemptionExpressReceipt.count(), 1);
    assert.deepEqual(await snapshot(f), before);
    const o = (await f.call<RedemptionOrderView>('/consumer/redemptions/' + id)).data;
    assert.ok(o.expressShipment?.receivedAt);
    assert.equal(o.status, 'ACTIVE');
    await assert.rejects(
      f.runtime.db.redemptionExpressReceipt.updateMany({ data: { requestId: randomUUID() } }),
    );
    await assert.rejects(f.runtime.db.redemptionExpressReceipt.deleteMany());
    const receipt = await f.runtime.db.redemptionExpressReceipt.findFirstOrThrow();
    await assert.rejects(
      f.runtime.db.redemptionExpressReceipt.create({
        data: { ...receipt, shipmentId: randomUUID(), userId: f.identityB.user.id },
      }),
    );
    assert.equal(
      (
        await f.call('/consumer/redemptions/' + id + '/returns', {
          quantity: 1,
          reason: '合成收货后商品问题',
        })
      ).status,
      200,
    );
    const service = f.runtime.app.get(RedemptionAfterSalesService);
    Object.defineProperty(service, 'enabled', { value: false });
    assert.equal((await f.call(path(id), { received: true }, key)).status, 200);
  } finally {
    await f.cleanup();
  }
});
test('waiting, received and historical shipped filters remain scoped and invalidate a cursor whose receipt changed', async () => {
  const f = await expressShippingFixture();
  try {
    const waiting = await f.createExpress(),
      shipped = await f.createExpress(),
      received = await f.createExpress(),
      canceled = await f.createExpress();
    await ship(f, shipped);
    await ship(f, received);
    assert.equal(
      (await f.call('/consumer/redemptions/' + canceled + '/cancel', { version: 0 })).status,
      200,
    );
    assert.equal((await f.call(path(canceled), { received: true })).status, 409);
    await f.call(path(received), { received: true });
    const list = async (status: string, token = f.identity.token) =>
      (
        await f.call<RedemptionOrderPage>(
          '/consumer/redemptions?fulfillment=' + status,
          undefined,
          undefined,
          token,
        )
      ).data.items
        .map((o) => o.id)
        .sort();
    assert.deepEqual(await list('EXPRESS_WAIT_SHIP'), [waiting]);
    assert.deepEqual(await list('EXPRESS_WAIT_RECEIPT'), [shipped]);
    assert.deepEqual(await list('EXPRESS_RECEIVED'), [received]);
    assert.deepEqual(await list('EXPRESS_SHIPPED'), [shipped, received].sort());
    assert.deepEqual(await list('EXPRESS_RECEIVED', f.identityB.token), []);
    const admin = await f.api('/admin/redemptions?fulfillment=EXPRESS_RECEIVED');
    assert.equal(admin.status, 200);
    assert.equal(admin.data.items.length, 1);
    await f.call(path(shipped), { received: true });
    assert.equal(
      (await f.call('/consumer/redemptions?fulfillment=EXPRESS_WAIT_RECEIPT&cursor=' + shipped))
        .status,
      409,
    );
    assert.equal((await f.call('/consumer/redemptions?fulfillment=NOT_REAL')).status, 400);
  } finally {
    await f.cleanup();
  }
});
test('late receipt insertion failure rolls back the fact and key; same request recovers, operation pause blocks new confirmations', async () => {
  const f = await expressShippingFixture();
  try {
    const id = await f.createExpress();
    await ship(f, id);
    const before = await snapshot(f),
      key = randomUUID();
    const service = f.runtime.app.get(RedemptionAfterSalesService);
    Object.defineProperty(service, 'enabled', { value: false, configurable: true });
    assert.equal((await f.call(path(id), { received: true }, key)).status, 503);
    Object.defineProperty(service, 'enabled', { value: true });
    await f.runtime.db.$executeRawUnsafe(
      "CREATE FUNCTION fail_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic receipt failure'; END $$",
    );
    await f.runtime.db.$executeRawUnsafe(
      'CREATE TRIGGER fail_receipt AFTER INSERT ON redemption_express_receipts FOR EACH ROW EXECUTE FUNCTION fail_receipt()',
    );
    assert.equal((await f.call(path(id), { received: true }, key)).status, 500);
    assert.equal(await f.runtime.db.redemptionExpressReceipt.count(), 0);
    assert.deepEqual(await snapshot(f), before);
    await f.runtime.db.$executeRawUnsafe(
      'DROP TRIGGER fail_receipt ON redemption_express_receipts',
    );
    assert.equal((await f.call(path(id), { received: true }, key)).status, 200);
  } finally {
    await f.cleanup();
  }
});
test('session expiry during receipt insertion rolls back confirmation', async () => {
  const f = await expressShippingFixture();
  try {
    const id = await f.createExpress();
    await ship(f, id);
    await f.runtime.db.$executeRawUnsafe(
      'CREATE FUNCTION slow_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$',
    );
    await f.runtime.db.$executeRawUnsafe(
      'CREATE TRIGGER slow_receipt BEFORE INSERT ON redemption_express_receipts FOR EACH ROW EXECUTE FUNCTION slow_receipt()',
    );
    await f.runtime.db.consumerSession.updateMany({
      where: { userId: f.identity.user.id },
      data: { expiresAt: new Date(Date.now() + 700) },
    });
    assert.equal((await f.call(path(id), { received: true })).status, 401);
    assert.equal(await f.runtime.db.redemptionExpressReceipt.count(), 0);
  } finally {
    await f.cleanup();
  }
});
