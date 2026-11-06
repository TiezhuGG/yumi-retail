import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import type { RedemptionAfterSalesPage } from '../packages/contracts/src/index.ts';
import { consumerFeedbackFixture } from './helpers/consumer-feedback-fixture.ts';
const base = '/consumer/redemption-after-sales';

test('consumer feedback summaries filter real statuses and search literally without leaking private contents', async () => {
  const f = await consumerFeedbackFixture();
  try {
    const read = (q = '') => f.call<RedemptionAfterSalesPage>(base + q);
    const all = await read();
    assert.equal(all.status, 200);
    assert.equal(all.data.items.length, 3);
    assert.deepEqual(all.data.items.map((v) => v.status).sort(), ['CLOSED', 'OPEN', 'PROCESSING']);
    for (const status of ['OPEN', 'PROCESSING', 'CLOSED'])
      assert.equal((await read('?status=' + status)).data.items.length, 1);
    const item = all.data.items[0]!;
    assert.deepEqual(
      Object.keys(item).sort(),
      ['orderId', 'orderNo', 'title', 'category', 'status', 'createdAt', 'updatedAt'].sort(),
    );
    assert.equal((await read('?keyword=' + item.orderNo.toLowerCase())).data.items.length, 1);
    assert.equal(
      (await read('?keyword=' + encodeURIComponent('纸巾') + '&status=OPEN')).data.items.length,
      1,
    );
    for (const keyword of ['%', '_', '\\', '没有此商品'])
      assert.equal((await read('?keyword=' + encodeURIComponent(keyword))).data.items.length, 0);
    for (const query of [
      '?status=INVALID',
      '?userId=' + f.identityB.user.id,
      '?keyword=' + 'x'.repeat(81),
      '?status=OPEN&status=CLOSED',
    ])
      assert.equal((await read(query)).status, 400);
    assert.deepEqual(
      (await f.call<RedemptionAfterSalesPage>(base, undefined, undefined, f.identityB.token)).data
        .items,
      [],
    );
    assert.equal(
      (await f.call(base + '?cursor=' + f.cases[0]!.id, undefined, undefined, f.identityB.token))
        .status,
      409,
    );
    assert.equal((await read('?cursor=' + randomUUID())).status, 409);
    assert.equal((await read('?status=CLOSED&cursor=' + f.cases[0]!.id)).status, 409);
    const before = await Promise.all([
      f.runtime.db.pointsEntry.count(),
      f.runtime.db.stockLedger.count(),
      f.runtime.db.redemptionAfterSalesEvent.count(),
    ]);
    await read();
    assert.deepEqual(
      await Promise.all([
        f.runtime.db.pointsEntry.count(),
        f.runtime.db.stockLedger.count(),
        f.runtime.db.redemptionAfterSalesEvent.count(),
      ]),
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

test('consumer feedback pagination keeps status and keyword scope and rejects a cursor after its status changes', async () => {
  const f = await consumerFeedbackFixture(23);
  try {
    const read = (q = '') => f.call<RedemptionAfterSalesPage>(base + q);
    const first = await read();
    assert.equal(first.data.items.length, 20);
    assert.ok(first.data.nextCursor);
    const next = await read('?cursor=' + first.data.nextCursor);
    assert.equal(next.data.items.length, 3);
    assert.equal(next.data.nextCursor, null);
    assert.equal(new Set([...first.data.items, ...next.data.items].map((v) => v.orderId)).size, 23);
    assert.equal((await read('?keyword=missing&cursor=' + first.data.nextCursor)).status, 409);
    const filtered = await read('?status=OPEN&keyword=' + encodeURIComponent('纸巾'));
    assert.equal(filtered.data.items.length, 20);
    assert.ok(filtered.data.nextCursor);
    const last = await read(
      '?status=OPEN&keyword=' + encodeURIComponent('纸巾') + '&cursor=' + filtered.data.nextCursor,
    );
    assert.equal(last.data.items.length, 1);
    const c = f.cases.find((v) => v.id === filtered.data.nextCursor)!;
    assert.equal(
      (
        await f.api('/admin/redemption-after-sales/' + c.orderId + '/reply', {
          version: 0,
          message: '合成处理中',
        })
      ).status,
      200,
    );
    assert.equal((await read('?status=OPEN&cursor=' + c.id)).status, 409);
  } finally {
    await f.cleanup();
  }
});
