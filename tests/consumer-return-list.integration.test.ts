import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { consumerReturnsFixture } from './helpers/consumer-returns-fixture.ts';
import type { ConsumerReturnList } from '../packages/contracts/src/index.ts';
const base = '/consumer/redemption-returns';
test('consumer return progress is scoped, grouped by real events and returns only summary fields', async () => {
  const f = await consumerReturnsFixture();
  try {
    const read = async (q = '') => f.call<ConsumerReturnList>(base + q);
    const result = await read();
    assert.equal(result.status, 200);
    assert.equal(result.data.items.length, 6);
    const states = Object.fromEntries(result.data.items.map((v) => [v.id, v.state]));
    assert.deepEqual(states, {
      [f.requested]: 'REQUESTED',
      [f.waiting]: 'WAIT_RETURN',
      [f.ready]: 'READY_TO_REFUND',
      [f.refunded]: 'REFUNDED',
      [f.rejected]: 'REJECTED',
      [f.canceled]: 'CANCELED',
    });
    assert.equal((await read('?status=PROCESSING')).data.items.length, 3);
    assert.equal((await read('?status=CLOSED')).data.items.length, 2);
    assert.equal((await read('?status=REFUNDED')).data.items[0]!.id, f.refunded);
    assert.ok(result.data.items.every((v) => v.points === '120' && v.quantity === 1));
    assert.equal(JSON.stringify(result.data).includes('合成待审核说明'), false);
    assert.equal('events' in result.data.items[0]!, false);
    assert.deepEqual(
      (await f.call<ConsumerReturnList>(base, undefined, undefined, f.identityB.token)).data.items,
      [],
    );
    const order = await f.runtime.db.redemptionOrder.findUniqueOrThrow({
      where: { id: f.orderId },
    });
    assert.equal((await read('?keyword=' + order.orderNo.toLowerCase())).data.items.length, 6);
    assert.equal(
      (await read('?keyword=' + encodeURIComponent('纸巾') + '&status=REFUNDED')).data.items.length,
      1,
    );
    assert.equal((await read('?keyword=%25')).data.items.length, 0);
    assert.equal((await read('?keyword=' + encodeURIComponent('不存在'))).data.items.length, 0);
    for (const query of [
      '?status=NOT_REAL',
      '?userId=' + f.identityB.user.id,
      '?keyword=' + 'x'.repeat(81),
      '?status=CLOSED&status=PROCESSING',
    ])
      assert.equal((await read(query)).status, 400);
    assert.equal((await read('?status=PROCESSING&cursor=' + f.refunded)).status, 409);
    assert.equal((await read('?cursor=' + randomUUID())).status, 409);
    const before = {
      points: await f.runtime.db.pointsEntry.count(),
      stock: await f.runtime.db.stockLedger.count(),
      events: await f.runtime.db.redemptionReturnEvent.count(),
    };
    await read('?status=PROCESSING');
    assert.deepEqual(
      {
        points: await f.runtime.db.pointsEntry.count(),
        stock: await f.runtime.db.stockLedger.count(),
        events: await f.runtime.db.redemptionReturnEvent.count(),
      },
      before,
    );
    const res = await fetch(f.base + '/api/v1' + base, {
      headers: { Authorization: 'Bearer ' + f.identity.token },
    });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.equal((await fetch(f.base + '/api/v1' + base)).status, 401);
  } finally {
    await f.cleanup();
  }
});
test('consumer progress paginates without duplicates and rejects cursors when a case leaves its group', async () => {
  const f = await consumerReturnsFixture(21);
  try {
    const first = await f.call<ConsumerReturnList>(base);
    assert.equal(first.data.items.length, 20);
    assert.ok(first.data.nextCursor);
    const second = await f.call<ConsumerReturnList>(base + '?cursor=' + first.data.nextCursor);
    assert.equal(second.status, 200);
    assert.equal(second.data.items.length, 7);
    assert.equal(second.data.nextCursor, null);
    assert.equal(new Set([...first.data.items, ...second.data.items].map((v) => v.id)).size, 27);
    assert.equal(
      (await f.call(base + '?keyword=missing&cursor=' + first.data.nextCursor)).status,
      409,
    );
    assert.equal(
      (
        await f.call(
          '/consumer/redemptions/' + f.orderId + '/returns/' + f.requested + '/cancel',
          {},
        )
      ).status,
      200,
    );
    assert.equal((await f.call(base + '?status=PROCESSING&cursor=' + f.requested)).status, 409);
    assert.equal(
      (await f.call<ConsumerReturnList>(base + '?status=PROCESSING')).data.items.length,
      2,
    );
  } finally {
    await f.cleanup();
  }
});
