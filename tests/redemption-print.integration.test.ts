import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { RedemptionPrintPreview } from '../packages/contracts/src/index.ts';
import { redemptionDeliveryFixture } from './helpers/redemption-delivery-fixture.ts';
type F = Awaited<ReturnType<typeof redemptionDeliveryFixture>>;
async function setup(work: (f: F) => Promise<void>) {
  const f = await redemptionDeliveryFixture();
  try {
    await work(f);
  } finally {
    await f.cleanup();
  }
}
async function order(f: F) {
  const q = await f.call('/consumer/redemption-quotes', f.input);
  assert.equal(q.status, 200);
  const o = await f.call('/consumer/redemptions', { quoteId: q.data.id });
  assert.equal(o.status, 200);
  return o.data.id;
}
async function snapshot(f: F) {
  const d = f.runtime.db;
  return {
    points: await d.pointsAccount.findMany(),
    entries: await d.pointsEntry.count(),
    orders: await d.redemptionOrder.findMany(),
    stock: await d.stockBalance.findMany(),
    positions: await d.stockPosition.findMany(),
    ledger: await d.stockLedger.count(),
    allocations: await d.redemptionAllocation.findMany(),
    jobs: await d.redemptionOutbox.findMany(),
    tasks: await d.redemptionPickingTask.findMany(),
    events: await d.redemptionEvent.count(),
  };
}
async function preview(f: F, ids: string[]) {
  const r = await fetch(f.base + '/api/v1/admin/redemptions/print-preview', {
    method: 'POST',
    headers: {
      Cookie: f.cookie,
      Origin: 'http://127.0.0.1:5188',
      'X-CSRF-Token': f.profile.csrfToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ids }),
  });
  return { status: r.status, headers: r.headers, ...(await r.json()) } as {
    status: number;
    headers: Headers;
    data: RedemptionPrintPreview;
    error?: { code: string };
  };
}
test('single/batch preview preserves request order, decrypts original address snapshot and changes no order, stock, points or job', async () =>
  setup(async (f) => {
    const first = await order(f),
      second = await order(f),
      before = await snapshot(f);
    assert.equal(
      (
        await f.call('/consumer/addresses/' + f.input.addressId + '/update', {
          ...f.addressInput,
          version: 1,
          room: '合成202新地址',
          contactName: '合成新联系人',
        })
      ).status,
      200,
    );
    const p = await preview(f, [second, first]);
    assert.equal(p.status, 200);
    assert.equal(p.headers.get('cache-control'), 'no-store');
    assert.deepEqual(
      p.data.items.map((x) => x.id),
      [second, first],
    );
    assert.equal(
      'room' in p.data.items[0]!.address ? p.data.items[0]!.address.room : '',
      '合成101',
    );
    assert.equal(p.data.items[0]!.address.contactName, '合成验证联系人');
    assert.equal(p.data.items[0]!.deliveryMode, 'LOCAL_NO_CASH');
    assert.equal('userId' in p.data.items[0]!, false);
    assert.equal('addressPayload' in p.data.items[0]!, false);
    assert.equal((await preview(f, [first])).status, 200);
    assert.equal((await preview(f, [first])).status, 200);
    assert.deepEqual(await snapshot(f), before);
    assert.equal('address' in (await f.api('/admin/redemptions')).data.items[0]!, false);
  }));
test('batch validates all orders, cancellation and malformed input without partial private responses', async () =>
  setup(async (f) => {
    const first = await order(f),
      second = await order(f);
    assert.equal(
      (await f.call('/consumer/redemptions/' + second + '/cancel', { version: 0 })).status,
      200,
    );
    const cancelled = await preview(f, [first, second]);
    assert.equal(cancelled.status, 409);
    assert.equal(cancelled.data, undefined);
    assert.equal((await preview(f, [first, randomUUID()])).status, 404);
    for (const b of [
      { ids: [] },
      { ids: [first, first] },
      { ids: Array.from({ length: 21 }, () => randomUUID()) },
      { ids: ['invalid'] },
      { ids: [first], extra: true },
    ])
      assert.equal((await f.api('/admin/redemptions/print-preview', b)).status, 400);
    // An existing preview never authorizes a later print after cancellation.
    assert.equal((await preview(f, [first])).status, 200);
    assert.equal(
      (await f.call('/consumer/redemptions/' + first + '/cancel', { version: 0 })).status,
      200,
    );
    assert.equal((await preview(f, [first])).status, 409);
  }));
test('preview enforces role, CSRF, current session and warehouse scope', async () =>
  setup(async (f) => {
    const id = await order(f),
      picker = await f.workerActor('PICKER');
    assert.equal(
      (
        await f.api(
          '/admin/redemptions/print-preview',
          { ids: [id] },
          randomUUID(),
          picker.cookie,
          picker.csrf,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.api(
          '/admin/redemptions/print-preview',
          { ids: [id] },
          randomUUID(),
          f.cookie,
          'invalid',
        )
      ).status,
      403,
    );
    const foreignWarehouse = randomUUID();
    await f.runtime.db.warehouse.create({
      data: { id: foreignWarehouse, code: 'PRINT-OTHER', name: '合成另一仓' },
    });
    const foreign = await f.workerActor('OPERATIONS', foreignWarehouse);
    assert.equal(
      (
        await f.api(
          '/admin/redemptions/print-preview',
          { ids: [id] },
          randomUUID(),
          foreign.cookie,
          foreign.csrf,
        )
      ).status,
      403,
    );
    const staff = await f.runtime.db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } });
    await f.runtime.db.staffWarehouse.deleteMany({
      where: { staffId: staff.id, warehouseId: f.warehouseId },
    });
    assert.equal((await preview(f, [id])).status, 403);
  }));
