import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { orderAdminFixture } from './helpers/order-admin-fixture.ts';
import type { AdminOrderDetail } from '../packages/contracts/src/index.ts';
let f: Awaited<ReturnType<typeof orderAdminFixture>>, first: string, pending: string;
const root = () => '/admin/orders?warehouseId=' + f.warehouseId;
const detail = (id: string = first, warehouseId: string = f.warehouseId) =>
  `/admin/orders/${id}?warehouseId=${warehouseId}`;
before(async () => {
  f = await orderAdminFixture();
  first = await f.create();
});
after(async () => {
  if (f) await f.cleanup();
});
test('staff-only explicit order permission rejects consumer, warehouse and rider identities', async () => {
  assert.equal((await f.staff(root(), '')).status, 401);
  assert.equal((await f.call(root())).status, 401);
  for (const c of [f.cookies[1]!, f.extraCookies[1]!]) {
    assert.equal((await f.staff(root(), c)).status, 403);
    assert.equal((await f.staff(detail(), c)).status, 403);
  }
  for (const c of [f.cookies[0]!, f.extraCookies[0]!])
    assert.equal((await f.staff(root(), c)).status, 200);
});
test('warehouse scope, enabled warehouse and scoped cursor/detail protect other warehouses', async () => {
  assert.equal((await f.staff(root(), f.cookies[2]!)).status, 403);
  const other = (
    await f.runtime.db.staffWarehouse.findFirstOrThrow({ where: { staffId: f.staffIds[2] } })
  ).warehouseId;
  assert.equal((await f.staff(detail(first, other))).status, 403);
  assert.equal((await f.staff(detail(first, other), f.cookies[2]!)).status, 404);
  assert.equal(
    (await f.staff('/admin/orders?warehouseId=' + other + '&cursor=' + first, f.cookies[2]!))
      .status,
    404,
  );
  await f.runtime.db.warehouse.update({ where: { id: f.warehouseId }, data: { enabled: false } });
  try {
    assert.equal((await f.staff(root())).status, 403);
    assert.equal((await f.staff(detail())).status, 403);
  } finally {
    await f.runtime.db.warehouse.update({ where: { id: f.warehouseId }, data: { enabled: true } });
  }
});
test('strict query validation rejects extra fields, malformed ids, repeated fields and wildcard searches', async () => {
  for (const suffix of [
    '&limit=100',
    '&status=PAID',
    '&q=%25',
    '&q=',
    '&q=' + 'A'.repeat(41),
    '&cursor=wrong',
    '&warehouseId=' + randomUUID(),
    '&customerId=' + randomUUID(),
  ])
    assert.equal((await f.staff(root() + suffix)).status, 400, suffix);
  assert.equal((await f.staff('/admin/orders')).status, 400);
  assert.equal((await f.staff('/admin/orders/not-uuid?warehouseId=' + f.warehouseId)).status, 400);
  assert.equal((await f.staff(detail() + '&q=Y')).status, 400);
  assert.equal((await f.staff(detail(randomUUID()))).status, 404);
  assert.equal(
    (
      await f.staff(
        `/admin/orders/${first}/cancel?warehouseId=${f.warehouseId}`,
        f.cookies[0]!,
        'POST',
      )
    ).status,
    404,
  );
});
function verifyPrivacy(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) {
    assert.ok(
      ![
        'userId',
        'address',
        'addressPayload',
        'phone',
        'contactName',
        'note',
        'orderNote',
        'digest',
        'key',
        'quoteId',
        'requestId',
        'payload',
        'consumerActorId',
      ].includes(k),
      k,
    );
    verifyPrivacy(v);
  }
}
test('detail shows real lot/location reservations and immutable money without contact data or private internals', async () => {
  const r = await f.staff(detail());
  assert.equal(r.status, 200);
  const row = r.data as AdminOrderDetail;
  assert.equal(row.payableCents, 2499);
  assert.equal(
    row.allocations.reduce((n, a) => n + a.quantity, 0),
    3,
  );
  assert.ok(
    row.allocations.every(
      (a) => a.batchNo && a.locationCode && a.reservedAt && a.releasedAt === null,
    ),
  );
  assert.deepEqual(
    row.events.map((e) => e.type),
    ['ORDER_CREATED'],
  );
  verifyPrivacy(row);
  verifyPrivacy((await f.staff(root())).data);
  assert.ok(!JSON.stringify(row).includes('合成订单私密备注'));
  assert.ok(!JSON.stringify(row).includes('合成门牌'));
  const consumer = await f.call('/consumer/orders/' + first);
  assert.equal(consumer.data.address.orderNote, '合成订单私密备注');
});
test('cancelled orders expose matched original reservations and release times while reads never mutate inventory', async () => {
  const concurrent = await Promise.all([
    f.call(`/consumer/orders/${first}/cancel`, {}),
    ...Array.from({ length: 8 }, () => f.staff(detail())),
  ]);
  assert.equal(concurrent[0]!.status, 200);
  for (const response of concurrent.slice(1)) {
    assert.equal(response.status, 200);
    const snapshot = response.data as AdminOrderDetail;
    assert.ok(
      snapshot.allocations.every(
        (a) => (a.releasedAt !== null) === (snapshot.status === 'CANCELED'),
      ),
    );
    assert.equal(snapshot.events.length, snapshot.status === 'CANCELED' ? 2 : 1);
  }
  const before = await f.runtime.db.stockBalance.findMany(),
    ledgers = await f.runtime.db.stockLedger.count(),
    events = await f.runtime.db.orderEvent.count();
  const row = (await f.staff(detail())).data as AdminOrderDetail;
  assert.equal(row.status, 'CANCELED');
  assert.ok(row.allocations.every((a) => a.releasedAt !== null));
  assert.equal(row.events.length, 2);
  for (let i = 0; i < 3; i++) await f.staff(root());
  assert.deepEqual(await f.runtime.db.stockBalance.findMany(), before);
  assert.equal(await f.runtime.db.stockLedger.count(), ledgers);
  assert.equal(await f.runtime.db.orderEvent.count(), events);
});
test('multi-page scoped query and server-side filters return every order once', async () => {
  // Every row is made through the real checkout/reservation/cancel APIs; no direct fabricated order inserts.
  for (let i = 0; i < 19; i++) {
    const id = await f.create();
    assert.equal((await f.call(`/consumer/orders/${id}/cancel`, {})).status, 200);
  }
  const token = await f.secondCustomer();
  const second = await f.create(token);
  await f.call(`/consumer/orders/${second}/cancel`, {}, token);
  pending = await f.create(token);
  const a = await f.staff(root());
  assert.equal(a.data.items.length, 20);
  assert.equal(a.data.hasMore, true);
  const b = await f.staff(root() + '&cursor=' + a.data.nextCursor);
  assert.equal(b.data.items.length, 2);
  assert.equal(b.data.hasMore, false);
  assert.equal(
    new Set([...a.data.items, ...b.data.items].map((o: { id: string }) => o.id)).size,
    22,
  );
  const r = await f.staff(root() + '&status=AWAITING_PAYMENT');
  assert.deepEqual(
    r.data.items.map((o: { id: string }) => o.id),
    [pending],
  );
  const number = r.data.items[0].orderNo;
  const search = await f.staff(root() + '&q=' + number.toLowerCase());
  assert.deepEqual(
    search.data.items.map((o: { id: string }) => o.id),
    [pending],
  );
  assert.equal((await f.staff(root() + '&q=ZNOORDER')).data.items.length, 0);
  assert.equal((await f.staff(root() + '&status=CANCELED&cursor=' + pending)).status, 404);
  assert.equal((await f.staff(root() + '&cursor=' + randomUUID())).status, 404);
});
test('revoked session and removed roles/scopes apply on the next order read', async () => {
  await f.runtime.db.staffWarehouse.deleteMany({ where: { staffId: f.staffIds[0] } });
  assert.equal((await f.staff(root())).status, 403);
  await f.runtime.db.staffRole.deleteMany({ where: { staffId: f.staffIds[0] } });
  assert.equal((await f.staff(root())).status, 403);
  await f.runtime.db.staff.update({ where: { id: f.staffIds[0] }, data: { enabled: false } });
  assert.equal((await f.staff(root())).status, 401);
});
