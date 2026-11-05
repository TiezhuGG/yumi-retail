import { createApplication } from '../apps/api/dist/app.js';
import type { Prisma } from '../packages/database/src/index.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { redemptionFixture } from './helpers/redemption-fixture.ts';
import { applicationConfig } from '../apps/api/dist/config.js';
import { RedemptionService } from '../apps/api/dist/redemptions.js';
async function fixture(
  work: (f: Awaited<ReturnType<typeof redemptionFixture>>) => Promise<void>,
  options: Parameters<typeof redemptionFixture>[0] = {},
) {
  const f = await redemptionFixture(options);
  try {
    await work(f);
  } finally {
    await f.cleanup();
  }
}
test('local gate is default closed, rejects production and remote databases; disabled mode creates no quotes', async () => {
  assert.equal(applicationConfig({}).redemptionDevSubmit, false);
  await assert.rejects(
    createApplication('postgresql://unused:unused@example.invalid/yumi_test', {
      config: applicationConfig({ REDEMPTION_DEV_SUBMIT_ENABLED: '1' }),
    }),
  );
  assert.throws(() =>
    applicationConfig({
      NODE_ENV: 'production',
      STAFF_ALLOWED_ORIGINS: 'https://example.invalid',
      REDEMPTION_DEV_SUBMIT_ENABLED: '1',
    }),
  );
  assert.throws(() => applicationConfig({ REDEMPTION_DEV_SUBMIT_ENABLED: 'bad' }));
  assert.throws(() =>
    applicationConfig({ API_HOST: '0.0.0.0', REDEMPTION_DEV_SUBMIT_ENABLED: '1' }),
  );
  await fixture(
    async (f) => {
      assert.equal(
        (await f.call('/consumer/redemption-quotes', f.input)).error?.code,
        'REDEMPTION_SUBMISSION_DISABLED',
      );
      assert.equal(await f.runtime.db.redemptionQuote.count(), 0);
    },
    { enabled: false },
  );
});
test('quote is server priced, private, idempotent and side effect free; stale address and reward are rejected', async () =>
  fixture(async (f) => {
    const db = f.runtime.db,
      before = await db.stockBalance.findMany(),
      key = randomUUID();
    const a = await f.call('/consumer/redemption-quotes', f.input, key),
      b = await f.call('/consumer/redemption-quotes', f.input, key);
    assert.equal(a.status, 200);
    assert.equal(a.data.id, b.data.id);
    assert.equal(a.data.snapshot.totalPoints, '120');
    assert.equal(a.data.snapshot.remainingBalance, '880');
    assert.deepEqual(await db.stockBalance.findMany(), before);
    assert.equal(await db.redemptionOrder.count(), 0);
    assert.equal(
      (await f.call('/consumer/redemption-quotes', { ...f.input, quantity: 2 }, key)).error?.code,
      'IDEMPOTENCY_CONFLICT',
    );
    assert.equal(
      (await f.call('/consumer/redemption-quotes', { ...f.input, totalPoints: '1' })).status,
      400,
    );
    assert.equal(
      (await f.call('/consumer/redemption-quotes', { ...f.input, rewardVersion: 0 })).error?.code,
      'QUOTE_CHANGED',
    );
    assert.equal(
      (await f.call('/consumer/redemption-quotes', { ...f.input, addressVersion: 0 })).error?.code,
      'ADDRESS_VERSION_CONFLICT',
    );
    assert.equal(
      (
        await f.call(
          '/consumer/redemption-quotes/' + a.data.id,
          undefined,
          randomUUID(),
          f.identityB.token,
        )
      ).status,
      404,
    );
    assert.equal(
      (await f.call('/consumer/redemption-quotes', { ...f.input, addressId: f.inputB.addressId }))
        .status,
      404,
    );
    assert.equal(
      JSON.stringify(await db.redemptionQuote.findMany()).includes('00000000000'),
      false,
    );
  }));
test('create/cancel writes one coherent ledger/reservation/outbox and recovers original requests without a second debit/refund', async () =>
  fixture(async (f) => {
    const db = f.runtime.db,
      q = await f.call('/consumer/redemption-quotes', f.input),
      key = randomUUID();
    const [a, b] = await Promise.all([
      f.call('/consumer/redemptions', { quoteId: q.data.id }, key),
      f.call('/consumer/redemptions', { quoteId: q.data.id }, key),
    ]);
    assert.equal(a.status, 200);
    assert.equal(a.data.id, b.data.id);
    const id = a.data.id;
    assert.equal(
      (await f.call('/consumer/redemptions', { quoteId: q.data.id })).error?.code,
      'QUOTE_ALREADY_USED',
    );
    assert.equal(
      (await db.pointsAccount.findUniqueOrThrow({ where: { userId: f.identity.user.id } })).balance,
      880n,
    );
    assert.equal(
      (
        await db.stockBalance.findUniqueOrThrow({
          where: { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.catalog.skuIds[0]! } },
        })
      ).reserved,
      1,
    );
    assert.equal(
      (await db.redemptionOutbox.findUniqueOrThrow({ where: { orderId: id } })).state,
      'PENDING',
    );
    const own = await f.call('/consumer/redemptions/' + id);
    assert.equal(own.data.address?.phone, '00000000000');
    assert.equal(
      (await f.call('/consumer/redemptions/' + id, undefined, randomUUID(), f.identityB.token))
        .status,
      404,
    );
    assert.equal(
      (
        await f.call(
          '/consumer/redemptions/' + id + '/cancel',
          { version: 0 },
          randomUUID(),
          f.identityB.token,
        )
      ).status,
      404,
    );
    const admin = await f.api('/admin/redemptions/' + id);
    assert.equal(admin.status, 200);
    assert.equal('address' in admin.data, false);
    const cancelKey = randomUUID();
    const outcomes = await Promise.all([
      f.call('/consumer/redemptions/' + id + '/cancel', { version: 0 }, cancelKey),
      f.call('/consumer/redemptions/' + id + '/cancel', { version: 0 }),
    ]);
    assert.ok(outcomes.every((r) => r.status === 200));
    assert.equal(
      (await f.call('/consumer/redemptions/' + id + '/cancel', { version: 0 }, cancelKey)).status,
      200,
    );
    assert.equal(
      (await db.pointsAccount.findUniqueOrThrow({ where: { userId: f.identity.user.id } })).balance,
      1000n,
    );
    assert.equal(await db.pointsEntry.count({ where: { redemptionId: id } }), 2);
    assert.equal(
      (
        await db.stockBalance.findUniqueOrThrow({
          where: { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.catalog.skuIds[0]! } },
        })
      ).reserved,
      0,
    );
    assert.equal(
      (await db.redemptionOutbox.findUniqueOrThrow({ where: { orderId: id } })).state,
      'CANCELED',
    );
    assert.equal(await db.consumerOrder.count(), 0);
    assert.equal(await db.pickingLabTask.count(), 0);
    const ledger = await f.call<{ items: Array<{ entryKind: string; redemptionId: string }> }>(
      '/consumer/points/ledger',
    );
    assert.ok(
      ledger.data.items.some((e) => e.entryKind === 'REDEMPTION_RETURN' && e.redemptionId === id),
    );
    await assert.rejects(
      db.$executeRaw`UPDATE redemption_orders SET total_points=1 WHERE id=${id}::uuid`,
    );
    await assert.rejects(
      db.$executeRaw`DELETE FROM redemption_allocations WHERE order_id=${id}::uuid`,
    );
    assert.equal((await f.call('/consumer/redemption-quotes', f.input)).status, 200);
  }));
test('two devices cannot spend the last points twice', async () =>
  fixture(
    async (f) => {
      const [q1, q2] = await Promise.all([
        f.call('/consumer/redemption-quotes', f.input),
        f.call('/consumer/redemption-quotes', f.input),
      ]);
      const r = await Promise.all([
        f.call('/consumer/redemptions', { quoteId: q1.data.id }),
        f.call('/consumer/redemptions', { quoteId: q2.data.id }),
      ]);
      assert.deepEqual(r.map((x) => x.status).sort(), [200, 409]);
      assert.equal(r.find((x) => x.status === 409)?.error?.code, 'POINTS_INSUFFICIENT');
      assert.equal(await f.runtime.db.redemptionOrder.count(), 1);
      assert.equal(
        (
          await f.runtime.db.pointsAccount.findUniqueOrThrow({
            where: { userId: f.identity.user.id },
          })
        ).balance,
        0n,
      );
    },
    { balance: 120 },
  ));
test('legacy per-user and total quotas do not restrict actual available inventory', async () =>
  fixture(
    async (f) => {
      assert.equal((await f.api('/rewards/' + f.rewardId)).data.available, 5);
      const q1 = await f.call('/consumer/redemption-quotes', { ...f.input, quantity: 2 });
      const q2 = await f.call(
        '/consumer/redemption-quotes',
        { ...f.inputB, quantity: 2 },
        randomUUID(),
        f.identityB.token,
      );
      assert.equal(q1.status, 200);
      assert.equal(q2.status, 200);
      const results = await Promise.all([
        f.call('/consumer/redemptions', { quoteId: q1.data.id }),
        f.call('/consumer/redemptions', { quoteId: q2.data.id }, randomUUID(), f.identityB.token),
      ]);
      assert.deepEqual(
        results.map((r) => r.status),
        [200, 200],
      );
      assert.equal((await f.api('/rewards/' + f.rewardId)).data.available, 1);
      assert.equal(await f.runtime.db.redemptionOrder.count(), 2);
    },
    { limit: 1, quota: 1 },
  ));
test('one user can repeatedly redeem above old cumulative limits while stock and balance still apply', async () =>
  fixture(
    async (f) => {
      for (let i = 0; i < 2; i++) {
        const q = await f.call('/consumer/redemption-quotes', { ...f.input, quantity: 2 });
        assert.equal(q.status, 200);
        assert.equal((await f.call('/consumer/redemptions', { quoteId: q.data.id })).status, 200);
      }
      const soldOut = await f.call('/consumer/redemption-quotes', { ...f.input, quantity: 2 });
      assert.equal(soldOut.status, 409);
      assert.equal(soldOut.error?.code, 'STOCK_UNAVAILABLE');
      assert.equal((await f.call('/consumer/points')).data.balance, '520');
      const update = {
        title: '日常柔软纸巾',
        pointsPrice: '120',
        sortOrder: 10,
        perUserLimit: 1,
        totalQuota: 1,
        startsAt: null,
        endsAt: null,
        version: 1,
        reason: '历史字段兼容，不限制兑换',
      };
      assert.equal((await f.api('/admin/rewards/' + f.rewardId + '/update', update)).status, 200);
      assert.equal((await f.api('/rewards/' + f.rewardId)).data.available, 1);
    },
    { limit: 1, quota: 1 },
  ));
test('cash orders and point redemptions compete for the same last sellable piece', async () =>
  fixture(async (f) => {
    const db = f.runtime.db;
    await db.stockBalance.update({
      where: { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.catalog.skuIds[0]! } },
      data: { safety: 4 },
    });
    await db.checkoutPolicy.create({
      data: { warehouseId: f.warehouseId, deliveryFeeCents: 0, minGoodsCents: 0, open: true },
    });
    assert.equal(
      (await f.call('/consumer/cart/items', { version: 0, skuId: f.catalog.skuIds[0]! })).status,
      200,
    );
    const cash = await f.call('/consumer/checkout/quotes', {
        addressId: f.input.addressId,
        addressVersion: 1,
        cartVersion: 1,
      }),
      points = await f.call('/consumer/redemption-quotes', f.input);
    assert.equal(cash.status, 200);
    assert.equal(points.status, 200);
    const r = await Promise.all([
      f.call('/consumer/orders', { quoteId: cash.data.id }),
      f.call('/consumer/redemptions', { quoteId: points.data.id }),
    ]);
    assert.equal(r.filter((x) => x.status === 200).length, 1);
    assert.equal(r.filter((x) => x.status === 409).length, 1);
    assert.equal(
      (
        await db.stockBalance.findUniqueOrThrow({
          where: { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.catalog.skuIds[0]! } },
        })
      ).reserved,
      1,
    );
    assert.equal((await db.consumerOrder.count()) + (await db.redemptionOrder.count()), 1);
  }));
test('changed price, unpublished goods, held stock, invalid service area and expired quote never debit points', async () =>
  fixture(async (f) => {
    const db = f.runtime.db,
      q = await f.call('/consumer/redemption-quotes', f.input);
    await db.rewardProduct.update({
      where: { id: f.rewardId },
      data: { pointsPrice: 121n, version: { increment: 1 } },
    });
    assert.equal(
      (await f.call('/consumer/redemptions', { quoteId: q.data.id })).error?.code,
      'QUOTE_CHANGED',
    );
    const updated = { ...f.input, rewardVersion: 2 },
      q2 = await f.call('/consumer/redemption-quotes', updated);
    await db.stockBalance.update({
      where: { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.catalog.skuIds[0]! } },
      data: { inventoryHold: true },
    });
    assert.equal(
      (await f.call('/consumer/redemptions', { quoteId: q2.data.id })).error?.code,
      'STOCK_UNAVAILABLE',
    );
    await db.stockBalance.update({
      where: { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.catalog.skuIds[0]! } },
      data: { inventoryHold: false },
    });
    await db.serviceBuilding.update({ where: { id: f.buildingId }, data: { enabled: false } });
    assert.equal(
      (await f.call('/consumer/redemptions', { quoteId: q2.data.id })).error?.code,
      'ADDRESS_OUT_OF_RANGE',
    );
    await db.serviceBuilding.update({ where: { id: f.buildingId }, data: { enabled: true } });
    const quote = await db.redemptionQuote.findUniqueOrThrow({ where: { id: q2.data.id } }),
      expired = await db.redemptionQuote.create({
        data: {
          ...quote,
          snapshot: quote.snapshot as Prisma.InputJsonValue,
          id: randomUUID(),
          createdAt: new Date(0),
          expiresAt: new Date(120000),
        },
      });
    assert.equal(
      (await f.call('/consumer/redemptions', { quoteId: expired.id })).error?.code,
      'QUOTE_EXPIRED',
    );
    await db.rewardProduct.update({
      where: { id: f.rewardId },
      data: { status: 'UNPUBLISHED', version: { increment: 1 } },
    });
    assert.equal((await f.call('/consumer/redemptions', { quoteId: q2.data.id })).status, 409);
    assert.equal(await db.redemptionOrder.count(), 0);
    assert.equal(
      await db.stockLedger.count({ where: { actionKey: { startsWith: 'REDEMPTION_' } } }),
      0,
    );
  }));
test('late event failure rolls back all debit/reservation/quota/outbox and cancellation; same key recovers after repair', async () =>
  fixture(async (f) => {
    const db = f.runtime.db,
      q = await f.call('/consumer/redemption-quotes', f.input),
      key = randomUUID();
    await db.$executeRawUnsafe(
      "CREATE FUNCTION fail_redemption_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic event failure'; END $$",
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER fail_redemption_event BEFORE INSERT ON redemption_events FOR EACH ROW EXECUTE FUNCTION fail_redemption_event()',
    );
    assert.equal((await f.call('/consumer/redemptions', { quoteId: q.data.id }, key)).status, 500);
    assert.equal(await db.redemptionOrder.count(), 0);
    assert.equal(await db.redemptionOutbox.count(), 0);
    assert.equal(await db.redemptionAllocation.count(), 0);
    assert.equal(
      (await db.pointsAccount.findUniqueOrThrow({ where: { userId: f.identity.user.id } })).balance,
      1000n,
    );
    await db.$executeRawUnsafe('DROP TRIGGER fail_redemption_event ON redemption_events');
    const o = await f.call('/consumer/redemptions', { quoteId: q.data.id }, key);
    assert.equal(o.status, 200);
    await db.$executeRawUnsafe(
      'CREATE TRIGGER fail_redemption_event BEFORE INSERT ON redemption_events FOR EACH ROW EXECUTE FUNCTION fail_redemption_event()',
    );
    const ck = randomUUID();
    assert.equal(
      (await f.call('/consumer/redemptions/' + o.data.id + '/cancel', { version: 0 }, ck)).status,
      500,
    );
    assert.equal(
      (await db.pointsAccount.findUniqueOrThrow({ where: { userId: f.identity.user.id } })).balance,
      880n,
    );
    assert.equal(
      (await db.redemptionOutbox.findUniqueOrThrow({ where: { orderId: o.data.id } })).state,
      'PENDING',
    );
    await db.$executeRawUnsafe('DROP TRIGGER fail_redemption_event ON redemption_events');
    assert.equal(
      (await f.call('/consumer/redemptions/' + o.data.id + '/cancel', { version: 0 }, ck)).status,
      200,
    );
    assert.equal(await db.pointsEntry.count({ where: { redemptionId: o.data.id } }), 2);
  }));
test('new submission can be disabled while original successful requests and cancellation remain recoverable', async () =>
  fixture(async (f) => {
    const q = await f.call('/consumer/redemption-quotes', f.input),
      key = randomUUID(),
      o = await f.call('/consumer/redemptions', { quoteId: q.data.id }, key);
    const service = f.runtime.app.get(RedemptionService);
    Object.defineProperty(service, 'enabled', { value: false, configurable: true });
    assert.equal(
      (await f.call('/consumer/redemptions', { quoteId: q.data.id }, key)).data.id,
      o.data.id,
    );
    assert.equal(
      (await f.call('/consumer/redemption-quotes', f.input)).error?.code,
      'REDEMPTION_SUBMISSION_DISABLED',
    );
    assert.equal(
      (await f.call('/consumer/redemptions/' + o.data.id + '/cancel', { version: 0 })).status,
      200,
    );
  }));

test('session expiring during commit rolls back; admin warehouse and allocation source boundaries remain enforced', async () =>
  fixture(async (f) => {
    const db = f.runtime.db,
      q = await f.call('/consumer/redemption-quotes', f.input);
    await db.$executeRawUnsafe(
      'CREATE FUNCTION delay_redemption_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$',
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER delay_redemption_event BEFORE INSERT ON redemption_events FOR EACH ROW EXECUTE FUNCTION delay_redemption_event()',
    );
    await db.$executeRaw`UPDATE consumer_sessions SET expires_at=clock_timestamp()+interval '700 milliseconds' WHERE user_id=${f.identity.user.id}::uuid`;
    assert.equal((await f.call('/consumer/redemptions', { quoteId: q.data.id })).status, 401);
    assert.equal(await db.redemptionOrder.count(), 0);
    assert.equal(
      (await db.pointsAccount.findUniqueOrThrow({ where: { userId: f.identity.user.id } })).balance,
      1000n,
    );
    await db.$executeRawUnsafe('DROP TRIGGER delay_redemption_event ON redemption_events');
    const bq = await f.call(
        '/consumer/redemption-quotes',
        f.inputB,
        randomUUID(),
        f.identityB.token,
      ),
      o = await f.call(
        '/consumer/redemptions',
        { quoteId: bq.data.id },
        randomUUID(),
        f.identityB.token,
      );
    const staff = await db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } });
    await db.staffWarehouse.deleteMany({ where: { staffId: staff.id } });
    assert.equal((await f.api('/admin/redemptions/' + o.data.id)).status, 403);
    await db.staffWarehouse.create({ data: { staffId: staff.id, warehouseId: f.warehouseId } });
    const a = await db.redemptionAllocation.findFirstOrThrow({ where: { orderId: o.data.id } });
    await assert.rejects(
      db.redemptionAllocation.create({
        data: { ...a, id: randomUUID(), warehouseId: randomUUID(), positionId: randomUUID() },
      }),
    );
    assert.equal(
      (await f.call('/consumer/redemptions', undefined, randomUUID(), f.identityB.token)).data.items
        .length,
      1,
    );
  }));

test('lot expiring during a late event write rolls back points, reservations and outbox', async () =>
  fixture(async (f) => {
    const db = f.runtime.db,
      q = await f.call('/consumer/redemption-quotes', f.input);
    const lot = await db.stockLot.findFirstOrThrow({ where: { skuId: f.catalog.skuIds[0]! } });
    await db.stockLot.update({
      where: { id: lot.id },
      data: { producedAt: new Date(0), expiresAt: new Date(Date.now() + 700) },
    });
    await db.$executeRawUnsafe(
      'CREATE FUNCTION delay_lot_expiry() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$',
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER delay_lot_expiry BEFORE INSERT ON redemption_events FOR EACH ROW EXECUTE FUNCTION delay_lot_expiry()',
    );
    assert.equal(
      (await f.call('/consumer/redemptions', { quoteId: q.data.id })).error?.code,
      'QUOTE_EXPIRED',
    );
    assert.equal(await db.redemptionOrder.count(), 0);
    assert.equal(await db.redemptionOutbox.count(), 0);
    assert.equal(await db.redemptionAllocation.count(), 0);
    assert.equal(await db.pointsEntry.count({ where: { redemptionAction: 'REDEEM' } }), 0);
    assert.equal(
      (
        await db.stockBalance.findUniqueOrThrow({
          where: { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.catalog.skuIds[0]! } },
        })
      ).reserved,
      0,
    );
  }));
