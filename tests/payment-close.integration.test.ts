import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { orderAdminFixture } from './helpers/order-admin-fixture.ts';
import { releaseUnpaidOrder, expireUnpaidOrders } from '../packages/database/dist/index.js';
let f: Awaited<ReturnType<typeof orderAdminFixture>>, csrf: string;
const path = (run = false) =>
  '/admin/payment-close-lab' + (run ? '/run' : '') + '?warehouseId=' + f.warehouseId;
async function run(body: unknown = {}, cookie = f.extraCookies[0]!, token = csrf) {
  const r = await fetch(f.base + '/api/v1' + path(true), {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: 'http://127.0.0.1:5188',
      'X-CSRF-Token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, ...(await r.json()) };
}
before(async () => {
  f = await orderAdminFixture({ notificationLab: true, holdSeconds: 3 });
  csrf = (await f.staff('/staff/me', f.extraCookies[0]!)).data.csrfToken;
});
after(async () => {
  if (f) await f.cleanup();
});
test('lab requires admin scope, CSRF, strict empty input and remains a no-write plan', async () => {
  assert.equal((await f.staff(path(), '')).status, 401);
  for (const cookie of f.cookies) assert.equal((await f.staff(path(), cookie)).status, 403);
  assert.equal((await run({}, f.extraCookies[0]!, '')).status, 403);
  assert.equal((await run({ paymentState: 'PAID' })).status, 400);
  assert.equal((await run({ rawBody: 'x' })).status, 400);
  assert.equal(
    (await f.staff('/admin/payment-close-lab?warehouseId=' + randomUUID(), f.extraCookies[0]!))
      .status,
    403,
  );
  const snapshot = async () => ({
    orders: await f.runtime.db.consumerOrder.count(),
    records: await f.runtime.db.notificationLabRecord.count(),
    audits: await f.runtime.db.businessAudit.count(),
    ledgers: await f.runtime.db.stockLedger.count(),
  });
  const before = await snapshot();
  const r = await run();
  assert.equal(r.status, 200);
  assert.equal(r.data.results.length, 12);
  assert.ok(r.data.results.every((x: { status: string }) => x.status === 'PASSED'));
  assert.equal(r.data.callbackEnabled, false);
  assert.deepEqual(await snapshot(), before);
});
test('concurrent close calls with the same stale snapshot reread locked state and release exactly once', async () => {
  const id = await f.create(),
    order = await f.runtime.db.consumerOrder.findUniqueOrThrow({ where: { id } });
  await f.call('/consumer/orders/' + id + '/payment-preparation', {});
  const before = await f.runtime.db.stockLedger.count(),
    allocations = await f.runtime.db.orderAllocation.count({ where: { orderId: id } });
  await Promise.all(
    Array.from({ length: 6 }, () =>
      f.runtime.db.$transaction((tx) =>
        releaseUnpaidOrder(tx, order, 'CONSUMER_CANCEL', randomUUID()),
      ),
    ),
  );
  assert.equal(await f.runtime.db.stockLedger.count(), before + allocations);
  assert.equal(
    await f.runtime.db.orderEvent.count({ where: { orderId: id, type: 'ORDER_CANCELED' } }),
    1,
  );
  const prep = await f.runtime.db.paymentPreparation.findUniqueOrThrow({ where: { orderId: id } });
  assert.equal(prep.state, 'CLOSED');
  assert.equal(
    await f.runtime.db.paymentPreparationEvent.count({
      where: { preparationId: prep.id, type: 'CLOSED' },
    }),
    1,
  );
});
test('caller-forged canceled snapshot cannot bypass locking or leave an awaiting order reserved forever', async () => {
  const id = await f.create(),
    order = await f.runtime.db.consumerOrder.findUniqueOrThrow({ where: { id } });
  await f.runtime.db.$transaction((tx) =>
    releaseUnpaidOrder(tx, { ...order, status: 'CANCELED' }, 'CONSUMER_CANCEL', randomUUID()),
  );
  assert.equal(
    (await f.runtime.db.consumerOrder.findUniqueOrThrow({ where: { id } })).status,
    'CANCELED',
  );
});
test('mismatched ownership and uncertain payment snapshot reject before ledger changes', async () => {
  const id = await f.create(),
    order = await f.runtime.db.consumerOrder.findUniqueOrThrow({ where: { id } }),
    before = await f.runtime.db.stockLedger.count();
  for (const patch of [
    { warehouseId: randomUUID() },
    { userId: randomUUID() },
    { paymentState: 'PENDING' },
    { paymentState: 'PAID' },
  ])
    await assert.rejects(() =>
      f.runtime.db.$transaction((tx) =>
        releaseUnpaidOrder(tx, { ...order, ...patch }, 'CONSUMER_CANCEL', randomUUID()),
      ),
    );
  assert.equal(await f.runtime.db.stockLedger.count(), before);
  assert.equal(
    (await f.runtime.db.consumerOrder.findUniqueOrThrow({ where: { id } })).status,
    'AWAITING_PAYMENT',
  );
  assert.equal((await f.call('/consumer/orders/' + id + '/cancel', {})).status, 200);
});
test('timeout and cancellation compete without double releases; paid writes remain impossible', async () => {
  const id = await f.create();
  await f.call('/consumer/orders/' + id + '/payment-preparation', {});
  const before = await f.runtime.db.stockLedger.count(),
    allocations = await f.runtime.db.orderAllocation.count({ where: { orderId: id } });
  await new Promise((r) => setTimeout(r, 3200));
  await Promise.all([
    expireUnpaidOrders(f.runtime.db),
    f.call('/consumer/orders/' + id + '/cancel', {}),
  ]);
  assert.equal(await f.runtime.db.stockLedger.count(), before + allocations);
  await assert.rejects(() =>
    f.runtime.db.consumerOrder.update({
      where: { id },
      data: { paymentState: 'PAID', status: 'PAID' },
    }),
  );
  const balances = await f.runtime.db.stockBalance.findMany();
  assert.ok(balances.every((b) => b.reserved === 0));
});
test('default-off lab cannot run and revoked warehouse cannot inspect scenarios', async () => {
  const g = await orderAdminFixture();
  try {
    const token = (await g.staff('/staff/me', g.extraCookies[0]!)).data.csrfToken;
    const r = await fetch(
      g.base + '/api/v1/admin/payment-close-lab/run?warehouseId=' + g.warehouseId,
      {
        method: 'POST',
        headers: {
          Cookie: g.extraCookies[0]!,
          Origin: 'http://127.0.0.1:5188',
          'X-CSRF-Token': token,
          'Content-Type': 'application/json',
        },
        body: '{}',
      },
    );
    assert.equal(r.status, 503);
  } finally {
    await g.cleanup();
  }
  const me = (await f.staff('/staff/me', f.extraCookies[0]!)).data;
  await f.runtime.db.staffWarehouse.deleteMany({ where: { staffId: me.id } });
  assert.equal((await f.staff(path(), f.extraCookies[0]!)).status, 403);
});
