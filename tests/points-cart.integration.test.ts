import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { pointsCartFixture } from './helpers/points-cart-fixture.ts';
type Quote = { quotes: Array<{ id: string; snapshot: { rewardId: string } }>; totalPoints: string };
type Result = { orderIds: string[]; totalPoints: string };
test('cart checkout atomically reserves all SKUs, debits exact total and replays concurrently', async () => {
  const f = await pointsCartFixture();
  try {
    const q = await f.call<Quote>('/consumer/redemption-cart-quotes', f.cartInput);
    assert.equal(q.status, 200);
    assert.equal(q.data.totalPoints, '520');
    const key = randomUUID(),
      body = { quoteIds: q.data.quotes.map((i) => i.id) };
    const [a, b] = await Promise.all([
      f.call<Result>('/consumer/redemption-cart-orders', body, key),
      f.call<Result>('/consumer/redemption-cart-orders', body, key),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual(a.data, b.data);
    assert.equal(a.data.orderIds.length, 2);
    assert.equal(a.data.totalPoints, '520');
    assert.equal((await f.call('/consumer/points')).data.balance, '480');
    assert.equal(await f.runtime.db.redemptionOrder.count(), 2);
    assert.equal(
      await f.runtime.db.pointsEntry.count({ where: { redemptionAction: 'REDEEM' } }),
      2,
    );
    const alloc = await f.runtime.db.redemptionAllocation.findMany();
    assert.equal(
      alloc.reduce((s, i) => s + i.quantity, 0),
      3,
    );
    const foreign = await f.call(
      '/consumer/redemption-cart-orders',
      body,
      randomUUID(),
      f.identityB.token,
    );
    assert.equal(foreign.status, 404);
    const again = await f.call('/consumer/redemption-cart-orders', body);
    assert.equal(again.status, 409);
    assert.equal(await f.runtime.db.redemptionOrder.count(), 2);
    for (const id of a.data.orderIds)
      assert.equal(
        (await f.call('/consumer/redemptions/' + id + '/cancel', { version: 0 })).status,
        200,
      );
    assert.equal((await f.call('/consumer/points')).data.balance, '1000');
  } finally {
    await f.cleanup();
  }
});
test('cart enforces aggregate balance, rejects duplicate lines and mismatched addresses', async () => {
  const f = await pointsCartFixture();
  try {
    const expensive = {
      ...f.cartInput,
      items: f.cartInput.items.map((i) => ({ ...i, quantity: 4 })),
    };
    const q = await f.call('/consumer/redemption-cart-quotes', expensive);
    assert.equal(q.status, 409);
    assert.equal(q.error?.code, 'POINTS_INSUFFICIENT');
    assert.equal(await f.runtime.db.redemptionQuote.count(), 0);
    assert.equal(
      (
        await f.call('/consumer/redemption-cart-quotes', {
          ...f.cartInput,
          items: [f.cartInput.items[0], f.cartInput.items[0]],
        })
      ).status,
      400,
    );
    const first = await f.call<Quote>('/consumer/redemption-cart-quotes', f.cartInput);
    assert.equal(first.status, 200);
    const other = await f.call('/consumer/redemption-quotes', f.input);
    assert.equal(other.status, 200);
    const mixed = await f.call('/consumer/redemption-cart-orders', {
      quoteIds: [
        first.data.quotes.find((q) => q.snapshot.rewardId !== f.rewardId)!.id,
        other.data.id,
      ],
    });
    assert.equal(mixed.status, 409);
    assert.equal(await f.runtime.db.redemptionOrder.count(), 0);
  } finally {
    await f.cleanup();
  }
});
test('late database failure rolls back every child order, points, allocations and outbox', async () => {
  const f = await pointsCartFixture();
  try {
    const q = await f.call<Quote>('/consumer/redemption-cart-quotes', f.cartInput);
    assert.equal(q.status, 200);
    await f.runtime.db.$executeRawUnsafe(
      `CREATE FUNCTION fail_second_cart() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF (SELECT count(*) FROM redemption_orders)>1 THEN RAISE EXCEPTION 'synthetic late cart failure'; END IF; RETURN NEW; END $$`,
    );
    await f.runtime.db.$executeRawUnsafe(
      `CREATE TRIGGER cart_fail AFTER INSERT ON redemption_events FOR EACH ROW EXECUTE FUNCTION fail_second_cart()`,
    );
    const key = randomUUID(),
      body = { quoteIds: q.data.quotes.map((i) => i.id) },
      bad = await f.call('/consumer/redemption-cart-orders', body, key);
    assert.equal(bad.status, 500);
    assert.equal(await f.runtime.db.redemptionOrder.count(), 0);
    assert.equal(await f.runtime.db.redemptionAllocation.count(), 0);
    assert.equal(await f.runtime.db.redemptionOutbox.count(), 0);
    assert.equal((await f.call('/consumer/points')).data.balance, '1000');
    await f.runtime.db.$executeRawUnsafe('DROP TRIGGER cart_fail ON redemption_events');
    assert.equal((await f.call('/consumer/redemption-cart-orders', body, key)).status, 200);
  } finally {
    await f.cleanup();
  }
});
test('competing carts cannot overdraw points or reserve stock twice', async () => {
  const f = await pointsCartFixture();
  try {
    const [q1, q2] = await Promise.all([
      f.call<Quote>('/consumer/redemption-cart-quotes', f.cartInput),
      f.call<Quote>('/consumer/redemption-cart-quotes', f.cartInput),
    ]);
    assert.equal(q1.status, 200);
    assert.equal(q2.status, 200);
    const results = await Promise.all(
      [q1, q2].map((q) =>
        f.call('/consumer/redemption-cart-orders', { quoteIds: q.data.quotes.map((i) => i.id) }),
      ),
    );
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(await f.runtime.db.redemptionOrder.count(), 2);
    assert.equal((await f.call('/consumer/points')).data.balance, '480');
  } finally {
    await f.cleanup();
  }
});

test('one expired quote rolls back the entire cart and preserves unexpired quotes', async () => {
  const f = await pointsCartFixture();
  try {
    const q = await f.call<Quote>('/consumer/redemption-cart-quotes', f.cartInput);
    assert.equal(q.status, 200);
    const source = await f.runtime.db.redemptionQuote.findUniqueOrThrow({
      where: { id: q.data.quotes[0]!.id },
    });
    const expiredId = randomUUID();
    await f.runtime.db.redemptionQuote.create({
      data: {
        id: expiredId,
        userId: source.userId,
        rewardId: source.rewardId,
        snapshot:
          source.snapshot as import('../packages/database/src/index.ts').Prisma.InputJsonValue,
        createdAt: new Date(Date.now() - 130000),
        expiresAt: new Date(Date.now() - 10000),
      },
    });
    const bad = await f.call('/consumer/redemption-cart-orders', {
      quoteIds: [expiredId, q.data.quotes[1]!.id],
    });
    assert.equal(bad.status, 409);
    assert.equal(await f.runtime.db.redemptionOrder.count(), 0);
    assert.equal((await f.call('/consumer/points')).data.balance, '1000');
    assert.equal(
      (
        await f.call('/consumer/redemption-cart-orders', {
          quoteIds: q.data.quotes.map((q) => q.id),
        })
      ).status,
      200,
    );
  } finally {
    await f.cleanup();
  }
});
