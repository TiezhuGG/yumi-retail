import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { seedCancelledRedemptions } from './helpers/redemption-fixture.ts';
import { expressShippingFixture } from './helpers/express-shipping-fixture.ts';
import type { RedemptionOrderPage } from '../packages/contracts/src/index.ts';
const base = '/consumer/redemptions';
test('consumer search matches own title and order number, combines receipt status and treats wildcard characters literally', async () => {
  const f = await expressShippingFixture();
  try {
    const first = await f.createExpress();
    const second = await f.api('/admin/rewards/store/create', {
      pointsPrice: '200',
      sortOrder: 20,
      perUserLimit: 5,
      totalQuota: 20,
      startsAt: null,
      endsAt: null,
      reason: '合成搜索商品',
      skuId: f.catalog.skuIds[1],
      title: 'Paper %_\\ Special',
    });
    assert.equal(second.status, 200);
    assert.equal(
      (
        await f.api('/admin/rewards/' + second.data.id + '/publish', {
          version: 0,
          reason: '合成搜索商品',
        })
      ).status,
      200,
    );
    const book = await f.call<{ version: number; items: Array<{ id: string }> }>(
      '/consumer/express-addresses',
    );
    const quote = await f.call<{ id: string }>('/consumer/redemption-quotes', {
      ...f.input,
      rewardId: second.data.id,
      rewardVersion: 1,
      deliveryMode: 'EXPRESS',
      addressId: book.data.items[0]!.id,
      addressVersion: book.data.version,
    });
    assert.equal(quote.status, 200);
    const literal = await f.call<{ id: string }>('/consumer/redemptions', {
      quoteId: quote.data.id,
    });
    assert.equal(literal.status, 200);
    const order = await f.runtime.db.redemptionOrder.findUniqueOrThrow({ where: { id: first } });
    const search = async (keyword: string, extra = '', token = f.identity.token) =>
      f.call<RedemptionOrderPage>(
        base + '?keyword=' + encodeURIComponent(keyword) + extra,
        undefined,
        undefined,
        token,
      );
    for (const term of [
      '纸巾',
      '  柔软  ',
      order.orderNo.toLowerCase(),
      order.orderNo.slice(-12),
    ]) {
      const r = await search(term);
      assert.equal(r.status, 200);
      assert.deepEqual(
        r.data.items.map((o) => o.id),
        [first],
      );
    }
    for (const term of ['paper', '%', '_', '\\']) {
      const r = await search(term);
      assert.equal(r.status, 200);
      assert.deepEqual(
        r.data.items.map((o) => o.id),
        [literal.data.id],
      );
    }
    assert.deepEqual((await search("' OR 1=1 --")).data.items, []);
    assert.deepEqual((await search(order.orderNo, '', f.identityB.token)).data.items, []);
    assert.equal((await search('a'.repeat(81))).status, 400);
    assert.equal((await f.call(base + '?keyword=x&keyword=y')).status, 400);
    assert.equal((await f.call(base + '?keyword=纸巾&userId=' + f.identityB.user.id)).status, 400);
    assert.equal((await search('')).data.items.length, 2);
    assert.equal((await search('纸巾', '&fulfillment=EXPRESS_WAIT_SHIP')).data.items.length, 1);
    assert.equal(
      (
        await f.api('/admin/redemptions/' + first + '/ship', {
          version: 0,
          carrierCode: 'SF',
          trackingNo: 'SF-SEARCH-001',
          dispatchConfirmed: true,
        })
      ).status,
      200,
    );
    assert.equal((await search('纸巾', '&fulfillment=EXPRESS_WAIT_SHIP')).data.items.length, 0);
    assert.equal((await search('纸巾', '&fulfillment=EXPRESS_WAIT_RECEIPT')).data.items.length, 1);
    await f.call(base + '/' + first + '/confirm-receipt', { received: true });
    assert.equal((await search('纸巾', '&fulfillment=EXPRESS_RECEIVED')).data.items.length, 1);
    assert.equal((await search('纸巾', '&fulfillment=EXPRESS_SHIPPED')).data.items.length, 1);
    assert.equal((await search('paper', '&cursor=' + first)).status, 409);
    const before = {
      audit: await f.runtime.db.businessAudit.count(),
      points: await f.runtime.db.pointsEntry.count(),
      stock: await f.runtime.db.stockLedger.count(),
    };
    await search('纸巾');
    assert.deepEqual(
      {
        audit: await f.runtime.db.businessAudit.count(),
        points: await f.runtime.db.pointsEntry.count(),
        stock: await f.runtime.db.stockLedger.count(),
      },
      before,
    );
    const response = await fetch(
      f.base + '/api/v1' + base + '?keyword=' + encodeURIComponent('纸巾'),
      { headers: { Authorization: 'Bearer ' + f.identity.token } },
    );
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(f.base + '/api/v1' + base + '?keyword=test')).status, 401);
  } finally {
    await f.cleanup();
  }
});
test('search paginates only matching own orders and rejects cursors outside keyword or state scope', async () => {
  const f = await expressShippingFixture();
  try {
    const canceled = await f.createExpress();
    assert.equal((await f.call(base + '/' + canceled + '/cancel', { version: 0 })).status, 200);
    const active = await f.createExpress();
    await seedCancelledRedemptions(f, 21);
    const q = base + '?keyword=' + encodeURIComponent('纸巾');
    const first = await f.call<RedemptionOrderPage>(q);
    assert.equal(first.status, 200);
    assert.equal(first.data.items.length, 20);
    assert.ok(first.data.nextCursor);
    const second = await f.call<RedemptionOrderPage>(q + '&cursor=' + first.data.nextCursor);
    assert.equal(second.status, 200);
    assert.equal(second.data.items.length, 3);
    assert.equal(second.data.nextCursor, null);
    assert.equal(new Set([...first.data.items, ...second.data.items].map((o) => o.id)).size, 23);
    assert.equal(
      (await f.call(base + '?keyword=不存在&cursor=' + first.data.nextCursor)).status,
      409,
    );
    assert.equal((await f.call(q + '&status=CANCELED&cursor=' + active)).status, 409);
    assert.equal((await f.call(q + '&cursor=' + randomUUID())).status, 409);
    assert.equal(
      (await f.call<RedemptionOrderPage>(q + '&fulfillment=EXPRESS_WAIT_SHIP')).data.items[0]!.id,
      active,
    );
  } finally {
    await f.cleanup();
  }
});
