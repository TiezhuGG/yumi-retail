import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pickingFixture } from './helpers/picking-fixture.ts';
let f: Awaited<ReturnType<typeof pickingFixture>>;
const base = '/warehouse/picking-readiness';
const path = (id?: string) => base + (id ? '/' + id : '') + '?warehouseId=' + f.warehouseId;
async function read(id?: string) {
  const r = await f.staff(path(id), f.pickerCookie);
  assert.equal(r.status, 200);
  return r.data;
}
beforeEach(async () => {
  f = await pickingFixture();
});
afterEach(async () => {
  if (f) await f.cleanup();
});
test('picking read permission is independent of order admin and rejects consumer, operations and rider', async () => {
  const id = await f.create();
  assert.equal((await f.staff(path(), '')).status, 401);
  assert.equal((await f.call(path())).status, 401);
  for (const c of [f.cookies[0]!, f.extraCookies[1]!])
    for (const p of [path(), path(id)]) assert.equal((await f.staff(p, c)).status, 403);
  for (const c of [f.pickerCookie, f.cookies[1]!, f.extraCookies[0]!])
    assert.equal((await f.staff(path(id), c)).status, 200);
  assert.equal(
    (await f.staff('/admin/orders?warehouseId=' + f.warehouseId, f.pickerCookie)).status,
    403,
  );
  await f.runtime.db.staffWarehouse.deleteMany({ where: { staffId: f.pickerId } });
  assert.equal((await f.staff(path(id), f.pickerCookie)).status, 403);
});
test('warehouse scope, disabled warehouse, strict queries and foreign detail/cursor are enforced', async () => {
  const id = await f.create(),
    other = await f.runtime.db.warehouse.findFirstOrThrow({
      where: { id: { not: f.warehouseId } },
    });
  for (const suffix of [
    '&state=READY',
    '&q=%25',
    '&q=',
    '&q=' + 'A'.repeat(41),
    '&cursor=bad',
    '&warehouseId=' + f.warehouseId,
  ])
    assert.equal((await f.staff(path() + suffix, f.pickerCookie)).status, 400);
  assert.equal((await f.staff(base, f.pickerCookie)).status, 400);
  assert.equal((await f.staff(path('bad'), f.pickerCookie)).status, 400);
  assert.equal((await f.staff(path(id) + '&q=X', f.pickerCookie)).status, 400);
  assert.equal((await f.staff(path(randomUUID()), f.pickerCookie)).status, 404);
  assert.equal((await f.staff(base + '?warehouseId=' + other.id, f.pickerCookie)).status, 403);
  await f.runtime.db.staffWarehouse.create({
    data: { staffId: f.pickerId, warehouseId: other.id },
  });
  assert.equal(
    (await f.staff(base + '/' + id + '?warehouseId=' + other.id, f.pickerCookie)).status,
    404,
  );
  assert.equal(
    (await f.staff(base + '?warehouseId=' + other.id + '&cursor=' + id, f.pickerCookie)).status,
    404,
  );
  await f.runtime.db.warehouse.update({ where: { id: f.warehouseId }, data: { enabled: false } });
  assert.equal((await f.staff(path(id), f.pickerCookie)).status, 403);
});
function privacy(v: unknown) {
  if (v && typeof v === 'object')
    for (const [k, x] of Object.entries(v)) {
      assert.ok(
        ![
          'userId',
          'addressPayload',
          'phone',
          'contactName',
          'note',
          'digest',
          'key',
          'quoteId',
          'payableCents',
          'priceCents',
          'leaseToken',
          'requestId',
          'payload',
        ].includes(k),
        k,
      );
      privacy(x);
    }
}
test('detail uses real order snapshots and batch/location reservations without granting eligibility or writing stock', async () => {
  const id = await f.create(),
    before = await facts(),
    d = await read(id);
  assert.equal(d.claimEnabled, false);
  assert.ok(d.blockers.includes('READ_ONLY_PHASE'));
  assert.ok(d.blockers.includes('PAYMENT_UNCONFIRMED'));
  assert.ok(!d.blockers.includes('RESERVATION_MISMATCH'));
  assert.equal(
    d.totalQuantity,
    d.items.reduce((n: number, i: { quantity: number }) => n + i.quantity, 0),
  );
  for (const i of d.items) {
    assert.equal(i.activeReserved, i.quantity);
    for (const a of i.allocations) {
      assert.ok(a.batchNo);
      assert.ok(a.locationName);
      assert.equal(a.released, false);
      assert.deepEqual(a.issues, []);
    }
  }
  privacy(d);
  privacy(await read());
  await Promise.all(Array.from({ length: 8 }, () => read(id)));
  assert.deepEqual(await facts(), before);
});
test('cancelled reservations show released and concurrent cancellation never returns a mixed snapshot', async () => {
  const id = await f.create();
  const results = await Promise.all([
    f.call('/consumer/orders/' + id + '/cancel', {}),
    ...Array.from({ length: 8 }, () => read(id)),
  ]);
  assert.equal(results[0].status, 200);
  for (const d of results.slice(1))
    for (const i of d.items)
      assert.equal(i.activeReserved, d.status === 'CANCELED' ? 0 : i.quantity);
  const d = await read(id);
  assert.ok(d.blockers.includes('ORDER_CANCELED'));
  assert.ok(d.blockers.includes('RESERVATION_RELEASED'));
  assert.ok(d.items.every((i: { activeReserved: number }) => i.activeReserved === 0));
});
test('frozen stock, disabled locations and elapsed expiry block preparation and refresh clears only corrected causes', async () => {
  const id = await f.create(),
    a = await f.runtime.db.orderAllocation.findFirstOrThrow({
      where: { orderId: id },
      include: { position: true },
    });
  await f.runtime.db.stockBalance.update({
    where: { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: a.skuId } },
    data: { inventoryHold: true },
  });
  await f.runtime.db.warehouseLocation.update({
    where: { id: a.position.locationId },
    data: { enabled: false },
  });
  await f.runtime.db.stockLot.update({
    where: { id: a.lotId },
    data: { producedAt: new Date(0), expiresAt: new Date(86400000) },
  });
  const d = await read(id);
  for (const code of ['STOCK_FROZEN', 'LOCATION_DISABLED', 'LOT_EXPIRED'])
    assert.ok(d.blockers.includes(code));
  await f.runtime.db.stockBalance.update({
    where: { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: a.skuId } },
    data: { inventoryHold: false },
  });
  const fresh = await read(id);
  assert.ok(!fresh.blockers.includes('STOCK_FROZEN'));
  assert.ok(fresh.blockers.includes('LOT_EXPIRED'));
  assert.equal(fresh.claimEnabled, false);
});
test('payment preparations and successful synthetic evidence cannot create a claimable order or enable mutation endpoints', async () => {
  const id = await f.create();
  assert.equal((await f.call('/consumer/orders/' + id + '/payment-preparation', {})).status, 200);
  const csrf = (await f.staff('/staff/me', f.extraCookies[0]!)).data.csrfToken;
  const headers = {
    Cookie: f.extraCookies[0]!,
    Origin: 'http://127.0.0.1:5188',
    'X-CSRF-Token': csrf,
    'Content-Type': 'application/json',
  };
  const created = await fetch(
    f.base + '/api/v1/admin/payment-attempt-lab?warehouseId=' + f.warehouseId,
    { method: 'POST', headers, body: JSON.stringify({ key: randomUUID() }) },
  );
  assert.equal(created.status, 200);
  const attempt = (await created.json()).data.attempt.id;
  assert.equal(
    (
      await fetch(
        f.base +
          '/api/v1/admin/payment-attempt-lab/' +
          attempt +
          '/actions/success-result?warehouseId=' +
          f.warehouseId,
        { method: 'POST', headers, body: JSON.stringify({ key: randomUUID() }) },
      )
    ).status,
    200,
  );
  const d = await read(id);
  assert.equal(d.paymentState, 'NOT_STARTED');
  assert.equal(d.claimEnabled, false);
  assert.ok(d.blockers.includes('PAYMENT_UNCONFIRMED'));
  for (const action of ['claim', 'complete', 'ship'])
    assert.equal(
      (
        await f.staff(
          base + '/' + id + '/' + action + '?warehouseId=' + f.warehouseId,
          f.extraCookies[0]!,
          'POST',
        )
      ).status,
      404,
    );
  await assert.rejects(
    f.runtime.db.consumerOrder.update({
      where: { id },
      data: { paymentState: 'SUCCESS', status: 'ACTIVE', fulfillmentState: 'READY_TO_PICK' },
    }),
  );
});
test('real API pagination and case insensitive order prefix do not duplicate or fabricate tasks', async () => {
  for (let i = 0; i < 19; i++) {
    const id = await f.create();
    assert.equal((await f.call('/consumer/orders/' + id + '/cancel', {})).status, 200);
  }
  const token = await f.secondCustomer();
  for (let i = 0; i < 2; i++) {
    const id = await f.create(token);
    assert.equal((await f.call('/consumer/orders/' + id + '/cancel', {}, token)).status, 200);
  }
  const first = await read();
  assert.equal(first.items.length, 20);
  assert.ok(first.nextCursor);
  const second = await f.staff(path() + '&cursor=' + first.nextCursor, f.pickerCookie);
  assert.equal(second.status, 200);
  assert.equal(second.data.items.length, 1);
  assert.equal(
    new Set([...first.items, ...second.data.items].map((i: { id: string }) => i.id)).size,
    21,
  );
  const q = await f.staff(path() + '&q=' + first.items[0].orderNo.toLowerCase(), f.pickerCookie);
  assert.equal(q.data.items.length, 1);
  assert.equal((await f.staff(path() + '&q=NOTFOUND', f.pickerCookie)).data.items.length, 0);
});
async function facts() {
  const db = f.runtime.db;
  return {
    orders: await db.consumerOrder.findMany({
      select: { id: true, status: true, paymentState: true, fulfillmentState: true, version: true },
    }),
    allocations: await db.orderAllocation.findMany(),
    balances: await db.stockBalance.findMany(),
    positions: await db.stockPosition.findMany(),
    lots: await db.stockLot.findMany(),
    ledger: await db.stockLedger.count(),
    audit: await db.businessAudit.count(),
  };
}
