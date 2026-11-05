import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { pointsCartFixture } from './helpers/points-cart-fixture.ts';
import type { RewardCart } from '../packages/contracts/src/index.ts';
const path = '/consumer/points-cart';
test('account cart isolates users, persists across requests, detects concurrent versions and replays merges once', async () => {
  const f = await pointsCartFixture();
  try {
    const item = { rewardId: f.rewardId, quantity: 2 };
    assert.deepEqual((await f.call<RewardCart>(path)).data, { version: 0, items: [] });
    const body = { action: 'MERGE', version: 0, items: [item] },
      key = randomUUID();
    const [a, b] = await Promise.all([
      f.call<RewardCart>(path, body, key),
      f.call<RewardCart>(path, body, key),
    ]);
    assert.equal(a.status, 200);
    assert.deepEqual(a.data, b.data);
    assert.equal(a.data.items[0]!.quantity, 2);
    assert.deepEqual(
      (await f.call<RewardCart>(path, undefined, undefined, f.identityB.token)).data.items,
      [],
    );
    assert.equal(
      (await f.call(path, { ...body, items: [{ ...item, quantity: 3 }] }, key)).status,
      409,
    );
    const races = await Promise.all(
      [3, 4].map((quantity) =>
        f.call(path, { action: 'REPLACE', version: 1, items: [{ ...item, quantity }] }),
      ),
    );
    assert.deepEqual(races.map((r) => r.status).sort(), [200, 409]);
    assert.equal((await f.call<RewardCart>(path, body, key)).data.version, 1);
    const fresh = (await f.call<RewardCart>(path)).data;
    assert.equal(fresh.version, 2);
    assert.ok([3, 4].includes(fresh.items[0]!.quantity));
    assert.equal(await f.runtime.db.rewardCartAudit.count(), 2);
    assert.equal(await f.runtime.db.redemptionOrder.count(), 0);
    assert.equal((await f.call('/consumer/points')).data.balance, '1000');
    assert.equal((await f.call(path + '?userId=' + f.identityB.user.id)).status, 400);
    assert.equal((await f.call(path, { ...body, userId: f.identityB.user.id })).status, 400);
    const unauth = await fetch(f.base + '/api/v1' + path);
    assert.equal(unauth.status, 401);
    const response = await fetch(f.base + '/api/v1' + path, {
      headers: { Authorization: 'Bearer ' + f.identity.token },
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  } finally {
    await f.cleanup();
  }
});
test('cloud checkout subtracts bought quantities once, preserves concurrent additions, direct checkout and old replay remain compatible', async () => {
  const f = await pointsCartFixture();
  try {
    const initial = {
      action: 'REPLACE',
      version: 0,
      items: [
        { rewardId: f.rewardId, quantity: 1 },
        { rewardId: f.secondRewardId, quantity: 2 },
      ],
    };
    assert.equal((await f.call(path, initial)).status, 200);
    const q = await f.call<{ quotes: Array<{ id: string }> }>(
      '/consumer/redemption-cart-quotes',
      f.cartInput,
    );
    assert.equal(q.status, 200);
    assert.equal(
      (
        await f.call(path, {
          action: 'MERGE',
          version: 1,
          items: [{ rewardId: f.rewardId, quantity: 2 }],
        })
      ).status,
      200,
    );
    const key = randomUUID(),
      body = { quoteIds: q.data.quotes.map((i) => i.id), consumeCart: true };
    const [a, b] = await Promise.all([
      f.call('/consumer/redemption-cart-orders', body, key),
      f.call('/consumer/redemption-cart-orders', body, key),
    ]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.deepEqual((await f.call<RewardCart>(path)).data.items, [
      { rewardId: f.rewardId, quantity: 2 },
    ]);
    assert.equal(await f.runtime.db.rewardCartAudit.count({ where: { action: 'CHECKOUT' } }), 1);
    const direct = await f.call<{ quotes: Array<{ id: string }> }>(
      '/consumer/redemption-cart-quotes',
      { ...f.cartInput, items: [f.cartInput.items[0]] },
    );
    assert.equal(direct.status, 200);
    const oldKey = randomUUID(),
      oldBody = { quoteIds: direct.data.quotes.map((i) => i.id) };
    assert.equal((await f.call('/consumer/redemption-cart-orders', oldBody, oldKey)).status, 200);
    assert.equal(
      (await f.call('/consumer/redemption-cart-orders', { ...oldBody, consumeCart: false }, oldKey))
        .status,
      200,
    );
    assert.deepEqual((await f.call<RewardCart>(path)).data.items, [
      { rewardId: f.rewardId, quantity: 2 },
    ]);
  } finally {
    await f.cleanup();
  }
});
test('cart audit failure rolls back orders, debit and cart subtraction; same key recovers atomically', async () => {
  const f = await pointsCartFixture();
  try {
    assert.equal(
      (
        await f.call(path, {
          action: 'REPLACE',
          version: 0,
          items: [{ rewardId: f.rewardId, quantity: 2 }],
        })
      ).status,
      200,
    );
    const q = await f.call<{ quotes: Array<{ id: string }> }>(
      '/consumer/redemption-cart-quotes',
      f.cartInput,
    );
    const body = { quoteIds: q.data.quotes.map((i) => i.id), consumeCart: true },
      key = randomUUID();
    await f.runtime.db.$executeRawUnsafe(
      "CREATE FUNCTION fail_cloud_cart() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='CHECKOUT' THEN RAISE EXCEPTION 'synthetic cart audit failure'; END IF; RETURN NEW; END $$",
    );
    await f.runtime.db.$executeRawUnsafe(
      'CREATE TRIGGER fail_cloud_cart BEFORE INSERT ON reward_cart_audits FOR EACH ROW EXECUTE FUNCTION fail_cloud_cart()',
    );
    assert.equal((await f.call('/consumer/redemption-cart-orders', body, key)).status, 500);
    assert.equal(await f.runtime.db.redemptionOrder.count(), 0);
    assert.equal(await f.runtime.db.redemptionAllocation.count(), 0);
    assert.equal((await f.call('/consumer/points')).data.balance, '1000');
    assert.equal((await f.call<RewardCart>(path)).data.version, 1);
    await f.runtime.db.$executeRawUnsafe('DROP TRIGGER fail_cloud_cart ON reward_cart_audits');
    assert.equal((await f.call('/consumer/redemption-cart-orders', body, key)).status, 200);
    assert.equal((await f.call<RewardCart>(path)).data.items[0]!.quantity, 1);
  } finally {
    await f.cleanup();
  }
});
test('cart strictly validates capacity and fields while retaining unavailable references for removal', async () => {
  const f = await pointsCartFixture();
  try {
    const item = { rewardId: randomUUID(), quantity: 1 },
      body = { action: 'REPLACE', version: 0, items: [item] };
    for (const items of [
      [item, item],
      Array.from({ length: 21 }, () => ({ rewardId: randomUUID(), quantity: 1 })),
      [{ ...item, quantity: 0 }],
      [{ ...item, quantity: 1.5 }],
      [{ ...item, pointsPrice: '1' }],
    ])
      assert.equal((await f.call(path, { ...body, items })).status, 400);
    assert.equal((await f.call(path, body)).status, 200);
    assert.equal((await f.call(path, { action: 'REPLACE', version: 1, items: [] })).status, 200);
    assert.deepEqual((await f.call<RewardCart>(path)).data.items, []);
  } finally {
    await f.cleanup();
  }
});
test('session expiration during cart audit rolls back mutation and its idempotency record', async () => {
  const f = await pointsCartFixture();
  try {
    await f.runtime.db.$executeRawUnsafe(
      'CREATE FUNCTION slow_cloud_cart() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$',
    );
    await f.runtime.db.$executeRawUnsafe(
      'CREATE TRIGGER slow_cloud_cart BEFORE INSERT ON reward_cart_audits FOR EACH ROW EXECUTE FUNCTION slow_cloud_cart()',
    );
    await f.runtime.db.consumerSession.updateMany({
      where: { userId: f.identity.user.id },
      data: { expiresAt: new Date(Date.now() + 700) },
    });
    assert.equal(
      (
        await f.call(path, {
          action: 'REPLACE',
          version: 0,
          items: [{ rewardId: f.rewardId, quantity: 1 }],
        })
      ).status,
      401,
    );
    assert.equal(await f.runtime.db.rewardCart.count(), 0);
    assert.equal(await f.runtime.db.rewardCartAudit.count(), 0);
  } finally {
    await f.cleanup();
  }
});
