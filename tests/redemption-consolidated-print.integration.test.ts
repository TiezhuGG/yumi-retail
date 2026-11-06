import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { RedemptionPrintPreview } from '../packages/contracts/src/index.ts';
import { expressShippingFixture } from './helpers/express-shipping-fixture.ts';
const path = '/admin/redemptions/consolidated-print-preview';
type F = Awaited<ReturnType<typeof expressShippingFixture>>;
async function setup(work: (f: F, ids: string[]) => Promise<void>) {
  const f = await expressShippingFixture();
  try {
    await work(f, [await f.createExpress(), await f.createExpress(2)]);
  } finally {
    await f.cleanup();
  }
}
async function snapshot(f: F) {
  const d = f.runtime.db;
  return {
    orders: await d.redemptionOrder.findMany({ orderBy: { id: 'asc' } }),
    jobs: await d.redemptionOutbox.findMany({ orderBy: { orderId: 'asc' } }),
    stock: await d.stockBalance.findMany({ orderBy: { skuId: 'asc' } }),
    allocations: await d.redemptionAllocation.findMany({ orderBy: { id: 'asc' } }),
    points: await d.pointsAccount.findMany({ orderBy: { userId: 'asc' } }),
    entries: await d.pointsEntry.count(),
    audit: await d.businessAudit.count(),
  };
}
test('consolidated preview aggregates quantities, retains original order details and is read only', async () =>
  setup(async (f, ids) => {
    const before = await snapshot(f);
    const r = await f.api(path, { ids: [...ids].reverse() });
    assert.equal(r.status, 200);
    const p = r.data as unknown as RedemptionPrintPreview;
    assert.deepEqual(
      p.items.map((x) => x.id),
      [...ids].reverse(),
    );
    assert.equal(p.consolidatedLines!.length, 1);
    assert.equal(p.consolidatedLines![0]!.quantity, 3);
    assert.equal(
      p.items.reduce((n, o) => n + BigInt(o.totalPoints), 0n),
      360n,
    );
    assert.equal(p.items[0]!.address.contactName, '合成快递收件人');
    assert.equal('userId' in p.items[0]!, false);
    assert.equal((await f.api(path, { ids })).status, 200);
    assert.deepEqual(await snapshot(f), before);
  }));
test('limits, duplicates, missing orders, role, CSRF and warehouse are enforced without partial data', async () =>
  setup(async (f, ids) => {
    for (const body of [
      { ids: [] },
      { ids: [ids[0]] },
      { ids: [ids[0], ids[0]] },
      { ids: Array.from({ length: 21 }, () => randomUUID()) },
      { ids: ['bad', 'bad2'] },
      { ids, extra: true },
    ])
      assert.equal((await f.api(path, body)).status, 400);
    const missing = await f.api(path, { ids: [ids[0], randomUUID()] });
    assert.equal(missing.status, 404);
    assert.equal(missing.data, undefined);
    const picker = await f.workerActor('PICKER');
    assert.equal(
      (await f.api(path, { ids }, randomUUID(), picker.cookie, picker.csrf)).status,
      403,
    );
    assert.equal((await f.api(path, { ids }, randomUUID(), f.cookie, 'invalid')).status, 403);
    const staff = await f.runtime.db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } });
    await f.runtime.db.staffWarehouse.deleteMany({
      where: { staffId: staff.id, warehouseId: f.warehouseId },
    });
    assert.equal((await f.api(path, { ids })).status, 403);
  }));
test('a subsequent print rejects cancelled and shipped orders after a successful preview', async () =>
  setup(async (f, ids) => {
    assert.equal((await f.api(path, { ids })).status, 200);
    assert.equal(
      (
        await f.api('/admin/redemptions/' + ids[0] + '/ship', {
          version: 0,
          carrierCode: 'SF',
          trackingNo: 'SF0000009999',
          dispatchConfirmed: true,
        })
      ).status,
      200,
    );
    const sent = await f.api(path, { ids });
    assert.equal(sent.status, 409);
    assert.equal(sent.data, undefined);
    assert.equal(
      (await f.call('/consumer/redemptions/' + ids[1] + '/cancel', { version: 0 })).status,
      200,
    );
    assert.equal((await f.api(path, { ids })).status, 409);
  }));
test('same customer with different address and different customer with identical address are both rejected', async () => {
  const f = await expressShippingFixture();
  try {
    const first = await f.createExpress();
    const address = {
      version: 0,
      province: '浙江省',
      city: '杭州市',
      district: '西湖区',
      detailAddress: '合成快递路1号101',
      contactName: '合成快递收件人',
      phone: '00000000000',
      note: '合成收件说明',
      isDefault: true,
    };
    async function create(token: string, detailAddress: string, version: number) {
      const a = await f.call(
        '/consumer/express-addresses',
        { ...address, version, detailAddress },
        randomUUID(),
        token,
      );
      assert.equal(a.status, 200);
      const q = await f.call(
        '/consumer/redemption-quotes',
        {
          ...f.input,
          quantity: 1,
          deliveryMode: 'EXPRESS',
          addressId: a.data.id,
          addressVersion: version + 1,
        },
        randomUUID(),
        token,
      );
      assert.equal(q.status, 200);
      const o = await f.call('/consumer/redemptions', { quoteId: q.data.id }, randomUUID(), token);
      assert.equal(o.status, 200);
      return o.data.id;
    }
    const differentAddress = await create(f.identity.token, '合成另一地址202', 1);
    const differentCustomer = await create(f.identityB.token, address.detailAddress, 0);
    for (const second of [differentAddress, differentCustomer]) {
      const r = await f.api(path, { ids: [first, second] });
      assert.equal(r.status, 409);
      assert.equal(r.data, undefined);
    }
  } finally {
    await f.cleanup();
  }
});
test('different SKUs remain separate even with identical titles, and local delivery cannot enter express summary', async () => {
  const f = await expressShippingFixture();
  try {
    const first = await f.createExpress();
    const published = await f.api('/admin/rewards/store/create', {
      skuId: f.catalog.skuIds[1],
      title: '日常柔软纸巾',
      pointsPrice: '200',
      perUserLimit: 3,
      totalQuota: 20,
      sortOrder: 20,
      startsAt: null,
      endsAt: null,
      reason: '合成不同规格',
    });
    assert.equal(published.status, 200);
    assert.equal(
      (
        await f.api('/admin/rewards/' + published.data.id + '/publish', {
          version: 0,
          reason: '合成上架',
        })
      ).status,
      200,
    );
    const book = await f.call<{ version: number; items: Array<{ id: string }> }>(
      '/consumer/express-addresses',
    );
    const q = await f.call('/consumer/redemption-quotes', {
      ...f.input,
      rewardId: published.data.id,
      quantity: 1,
      deliveryMode: 'EXPRESS',
      addressId: book.data.items[0]!.id,
      addressVersion: book.data.version,
    });
    assert.equal(q.status, 200);
    const second = await f.call('/consumer/redemptions', { quoteId: q.data.id });
    assert.equal(second.status, 200);
    const result = await f.api(path, { ids: [first, second.data.id] });
    assert.equal(result.status, 200);
    assert.equal((result.data as unknown as RedemptionPrintPreview).consolidatedLines!.length, 2);
    const localQuote = await f.call('/consumer/redemption-quotes', f.input);
    assert.equal(localQuote.status, 200);
    const local = await f.call('/consumer/redemptions', { quoteId: localQuote.data.id });
    assert.equal(local.status, 200);
    const rejected = await f.api(path, { ids: [first, local.data.id] });
    assert.equal(rejected.status, 409);
    assert.equal(rejected.data, undefined);
  } finally {
    await f.cleanup();
  }
});
