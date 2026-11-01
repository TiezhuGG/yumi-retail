import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { orderAdminFixture } from './helpers/order-admin-fixture.ts';
import { expireUnpaidOrders } from '../packages/database/dist/index.js';
import { PaymentPreparationService } from '../apps/api/dist/payment-preparation.js';
import { CheckoutService } from '../apps/api/dist/checkout.js';
import { CatalogService } from '../apps/api/dist/catalog-service.js';
import type { ApiRequest } from '../apps/api/dist/http.js';
let f: Awaited<ReturnType<typeof orderAdminFixture>>;
const path = (id: string) => `/consumer/orders/${id}/payment-preparation`;
const cancel = (id: string) => f.call(`/consumer/orders/${id}/cancel`, {});
before(async () => {
  f = await orderAdminFixture();
});
after(async () => {
  if (f) await f.cleanup();
});
test('preparation is owned, strict and development-only; it does not expose a provider or payment endpoint', async () => {
  const id = await f.create(),
    foreign = await f.call('/consumer/auth/dev-session', { profile: 'customer-b' }, '');
  assert.equal((await f.call(path(id), {}, '')).status, 401);
  assert.equal((await f.call(path(id), undefined, foreign.data.token)).status, 404);
  assert.equal((await f.call(path(id), {}, foreign.data.token)).status, 404);
  assert.equal((await f.call(path(id), { amountCents: 1 })).status, 400);
  assert.equal((await f.call(path(id) + '?status=PAID', {})).status, 400);
  assert.equal((await f.call(path('bad'))).status, 400);
  const missing = await fetch(f.base + '/api/v1' + path(id), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + f.identity.token, 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(missing.status, 400);
  const disabled = new PaymentPreparationService(
    new CheckoutService(new CatalogService(f.runtime.db, f.warehouseId), false),
  );
  await assert.rejects(
    () => disabled.prepare({} as ApiRequest, id, randomUUID()),
    (e: unknown) => (e as { status: number }).status === 503,
  );
  assert.deepEqual((await f.call(path(id))).data, { enabled: true, intent: null });
  await cancel(id);
});
test('same-key concurrent preparation is once, exact server amount, no payment or inventory transition', async () => {
  const id = await f.create(),
    key = randomUUID(),
    before = await f.runtime.db.stockBalance.findMany(),
    ledgers = await f.runtime.db.stockLedger.count();
  const rs = await Promise.all(
    Array.from({ length: 10 }, () => f.call(path(id), {}, f.identity.token, key)),
  );
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(new Set(rs.map((r) => r.data.id)).size, 1);
  const row = (await f.call(path(id))).data.intent;
  assert.equal(row.amountCents, 2499);
  assert.equal(row.state, 'PREPARED');
  assert.equal(row.channel, 'DISABLED');
  assert.equal(row.currency, 'CNY');
  assert.equal(
    await f.runtime.db.paymentPreparationEvent.count({
      where: { preparationId: row.id, type: 'PREPARED' },
    }),
    1,
  );
  assert.deepEqual(await f.runtime.db.stockBalance.findMany(), before);
  assert.equal(await f.runtime.db.stockLedger.count(), ledgers);
  assert.equal((await f.call('/consumer/orders/' + id)).data.paymentState, 'NOT_STARTED');
  for (const field of [
    'key',
    'userId',
    'warehouseId',
    'requestId',
    'provider',
    'prepayId',
    'signature',
    'address',
    'note',
  ])
    assert.ok(!(field in row), field);
  assert.equal((await f.call(path(id), {})).status, 409);
  const other = await f.create();
  assert.equal((await f.call(path(other), {}, f.identity.token, key)).status, 409);
  await cancel(other);
  await cancel(id);
  await cancel(id);
  const closed = (await f.call(path(id))).data.intent;
  assert.equal(closed.state, 'CLOSED');
  assert.equal(closed.closeReason, 'CONSUMER_CANCEL');
  assert.ok(closed.closedAt);
  assert.equal((await f.call(path(id), {}, f.identity.token, key)).data.id, row.id);
  assert.equal((await f.call(path(id), {})).status, 409);
  assert.equal(
    await f.runtime.db.paymentPreparationEvent.count({ where: { preparationId: row.id } }),
    2,
  );
});
test('prepare versus cancel serializes on order; no surviving prepared record on canceled order', async () => {
  for (let i = 0; i < 4; i++) {
    const id = await f.create();
    const [p, c] = await Promise.all([f.call(path(id), {}), cancel(id)]);
    assert.equal(c.status, 200);
    assert.ok([200, 409].includes(p.status));
    const r = (await f.call(path(id))).data.intent;
    assert.ok(r === null || r.state === 'CLOSED');
  }
});
test('late preparation audit failure rolls back intent and original key can recover', async () => {
  const id = await f.create(),
    key = randomUUID();
  await f.runtime.db.$executeRawUnsafe(
    "CREATE FUNCTION fail_payment_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic late payment event failure'; END $$",
  );
  await f.runtime.db.$executeRawUnsafe(
    'CREATE TRIGGER fail_payment_event BEFORE INSERT ON payment_preparation_events FOR EACH ROW EXECUTE FUNCTION fail_payment_event()',
  );
  try {
    assert.equal((await f.call(path(id), {}, f.identity.token, key)).status, 500);
    assert.equal(await f.runtime.db.paymentPreparation.count({ where: { orderId: id } }), 0);
  } finally {
    await f.runtime.db.$executeRawUnsafe(
      'DROP TRIGGER fail_payment_event ON payment_preparation_events',
    );
  }
  assert.equal((await f.call(path(id), {}, f.identity.token, key)).status, 200);
  await cancel(id);
});
test('late close failure rolls back cancellation, release ledgers and payment state together', async () => {
  const id = await f.create();
  await f.call(path(id), {});
  const stock = await f.runtime.db.stockBalance.findMany(),
    n = await f.runtime.db.stockLedger.count();
  await f.runtime.db.$executeRawUnsafe(
    "CREATE FUNCTION fail_payment_close() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.type='CLOSED' THEN RAISE EXCEPTION 'synthetic close failure'; END IF; RETURN NEW; END $$",
  );
  await f.runtime.db.$executeRawUnsafe(
    'CREATE TRIGGER fail_payment_close BEFORE INSERT ON payment_preparation_events FOR EACH ROW EXECUTE FUNCTION fail_payment_close()',
  );
  try {
    assert.equal((await cancel(id)).status, 500);
    assert.deepEqual(await f.runtime.db.stockBalance.findMany(), stock);
    assert.equal(await f.runtime.db.stockLedger.count(), n);
    assert.equal((await f.call(path(id))).data.intent.state, 'PREPARED');
    assert.equal((await f.call('/consumer/orders/' + id)).data.status, 'AWAITING_PAYMENT');
  } finally {
    await f.runtime.db.$executeRawUnsafe(
      'DROP TRIGGER fail_payment_close ON payment_preparation_events',
    );
  }
  await cancel(id);
});
test('database disallows forged amount, unsupported success, reopening, deleting and unpaired order close', async () => {
  const id = await f.create();
  for (const patch of [
    { amountCents: 1n },
    { userId: randomUUID() },
    { channel: 'WECHAT' },
    { state: 'SUCCEEDED' },
  ]) {
    await assert.rejects(() =>
      f.runtime.db.$transaction(async (tx) => {
        const p = await tx.paymentPreparation.create({
          data: {
            id: randomUUID(),
            orderId: id,
            userId: f.identity.user.id,
            warehouseId: f.warehouseId,
            key: randomUUID(),
            amountCents: 2499n,
            ...patch,
          },
        });
        await tx.paymentPreparationEvent.create({
          data: {
            id: randomUUID(),
            preparationId: p.id,
            type: 'PREPARED',
            actorKind: 'CONSUMER',
            requestId: randomUUID(),
          },
        });
      }),
    );
  }
  await assert.rejects(() =>
    f.runtime.db.paymentPreparation.create({
      data: {
        id: randomUUID(),
        orderId: id,
        userId: f.identity.user.id,
        warehouseId: f.warehouseId,
        key: randomUUID(),
        amountCents: 2499n,
      },
    }),
  );
  assert.equal(await f.runtime.db.paymentPreparation.count({ where: { orderId: id } }), 0);
  await f.call(path(id), {});
  const p = await f.runtime.db.paymentPreparation.findUniqueOrThrow({ where: { orderId: id } });
  await assert.rejects(() =>
    f.runtime.db.paymentPreparation.update({ where: { id: p.id }, data: { amountCents: 1 } }),
  );
  await assert.rejects(() =>
    f.runtime.db.paymentPreparation.update({ where: { id: p.id }, data: { state: 'SUCCEEDED' } }),
  );
  await assert.rejects(() => f.runtime.db.paymentPreparation.delete({ where: { id: p.id } }));
  await assert.rejects(() =>
    f.runtime.db.paymentPreparationEvent.deleteMany({ where: { preparationId: p.id } }),
  );
  await assert.rejects(() =>
    f.runtime.db.paymentPreparation.update({
      where: { id: p.id },
      data: { state: 'CLOSED', closedAt: null, closeReason: 'CONSUMER_CANCEL' },
    }),
  );
  await assert.rejects(() =>
    f.runtime.db.consumerOrder.update({
      where: { id },
      data: { status: 'CANCELED', cancelReason: 'CONSUMER_CANCEL', version: { increment: 1 } },
    }),
  );
  await cancel(id);
  await assert.rejects(() =>
    f.runtime.db.paymentPreparation.update({
      where: { id: p.id },
      data: { state: 'PREPARED', closedAt: null, closeReason: null },
    }),
  );
});
test('admin projection keeps warehouse scope and no key/contact data while showing actual preparation', async () => {
  const id = await f.create();
  await f.call(path(id), {});
  const url = `/admin/orders/${id}?warehouseId=${f.warehouseId}`;
  const r = await f.staff(url);
  assert.equal(r.status, 200);
  assert.equal(r.data.paymentPreparation.amountCents, 2499);
  assert.equal(r.data.paymentPreparation.state, 'PREPARED');
  assert.equal((await f.staff(url, f.cookies[2]!)).status, 403);
  assert.equal((await f.staff(url, f.cookies[1]!)).status, 403);
  for (const field of ['key', 'userId', 'warehouseId', 'requestId', 'address', 'note'])
    assert.ok(!(field in r.data.paymentPreparation));
  await cancel(id);
});
test('actual expiry worker kernel closes prepared record once with system audit and restores reservations', async () => {
  const g = await orderAdminFixture({ holdSeconds: 2 });
  try {
    const id = await g.create();
    assert.equal((await g.call(path(id), {})).status, 200);
    await new Promise((r) => setTimeout(r, 2200));
    assert.equal((await g.call(path(id), {})).status, 409);
    const counts = await Promise.all([
      expireUnpaidOrders(g.runtime.db),
      expireUnpaidOrders(g.runtime.db),
    ]);
    assert.equal(
      counts.reduce((a, b) => a + b),
      1,
    );
    const p = (await g.call(path(id))).data.intent;
    assert.equal(p.state, 'CLOSED');
    assert.equal(p.closeReason, 'PAYMENT_TIMEOUT');
    assert.equal(
      (
        await g.runtime.db.paymentPreparationEvent.findFirstOrThrow({
          where: { preparationId: p.id, type: 'CLOSED' },
        })
      ).actorKind,
      'SYSTEM',
    );
    assert.equal(
      (await g.runtime.db.stockBalance.aggregate({ _sum: { reserved: true } }))._sum.reserved,
      0,
    );
  } finally {
    await g.cleanup();
  }
});
