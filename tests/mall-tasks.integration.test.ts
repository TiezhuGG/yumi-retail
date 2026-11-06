import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { MallTasks } from '../packages/contracts/src/index.ts';
import { rewardsFixture } from './helpers/rewards-fixture.ts';
import { expressShippingFixture } from './helpers/express-shipping-fixture.ts';
let f: Awaited<ReturnType<typeof rewardsFixture>>, id: string;
before(async () => {
  f = await rewardsFixture();
  const c = await f.api('/admin/rewards/store/create', f.input);
  id = c.data.id;
  assert.equal(
    (await f.api('/admin/rewards/' + id + '/publish', { version: 0, reason: '合成待办测试' }))
      .status,
    200,
  );
});
after(async () => {
  await f?.cleanup();
});
async function read(query = '') {
  const r = await f.api('/admin/mall-tasks' + query);
  assert.equal(r.status, 200);
  return r.data as unknown as MallTasks;
}
test('snapshot is read-only, uses actual stock, separates zero/low, and does not expose personal or cost data', async () => {
  const db = f.runtime.db;
  const snapshot = async () =>
    JSON.stringify(
      [
        await db.stockBalance.findMany(),
        await db.rewardProduct.findMany(),
        await db.businessAudit.count(),
        await db.idempotencyRecord.count(),
      ],
      (_, v) => (typeof v === 'bigint' ? v.toString() : v),
    );
  const before = await snapshot(),
    r = await read();
  assert.equal(r.stock.lowStock, 1);
  assert.equal(r.stock.outOfStock, 0);
  assert.equal(r.stock.items[0]!.available, 5);
  assert.equal(r.queues.length, 8);
  assert.ok(r.queues.every((q) => q.count === 0 && q.oldestAt === null));
  assert.equal((await read('?threshold=4')).stock.items.length, 0);
  assert.equal((await read('?threshold=0')).stock.lowStock, 0);
  assert.equal(await snapshot(), before);
  for (const key of ['phone', 'address', 'userId', 'subject', 'unitCost', 'token', 'warehouseId'])
    assert.ok(!JSON.stringify(r).includes(key));
});
test('stock follows public safety, hold, expiry and location constraints; restored availability removes zero warning', async () => {
  const db = f.runtime.db,
    where = { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.input.skuId } },
    lot = await db.stockLot.findFirstOrThrow({
      where: { warehouseId: f.warehouseId, skuId: f.input.skuId },
    }),
    pos = await db.stockPosition.findFirstOrThrow({ where: { lotId: lot.id } });
  async function equal(n: number) {
    const r = await read();
    assert.equal(r.stock.items[0]!.available, n);
    assert.equal(r.stock.outOfStock, n === 0 ? 1 : 0);
    const pub = await f.api('/rewards/' + id);
    assert.equal(pub.data.available, n);
  }
  await db.stockBalance.update({ where, data: { safety: 5 } });
  await equal(0);
  await db.stockBalance.update({ where, data: { safety: 0, inventoryHold: true } });
  await equal(0);
  await db.stockBalance.update({ where, data: { inventoryHold: false } });
  await db.stockLot.update({
    where: { id: lot.id },
    data: { producedAt: new Date(0), expiresAt: new Date(86400000) },
  });
  await equal(0);
  await db.stockLot.update({ where: { id: lot.id }, data: { producedAt: null, expiresAt: null } });
  await db.warehouseLocation.update({ where: { id: pos.locationId }, data: { enabled: false } });
  await equal(0);
  await db.warehouseLocation.update({ where: { id: pos.locationId }, data: { enabled: true } });
  await equal(5);
  assert.equal((await read('?stock=ZERO')).stock.items.length, 0);
});
test('draft, closed schedule, hidden source and foreign warehouse do not pollute active storefront stock alerts', async () => {
  const db = f.runtime.db;
  await db.rewardProduct.update({
    where: { id },
    data: { endsAt: new Date(1), version: { increment: 1 } },
  });
  assert.equal((await read()).stock.items.length, 0);
  await db.rewardProduct.update({
    where: { id },
    data: { endsAt: null, version: { increment: 1 } },
  });
  await db.sku.update({ where: { id: f.input.skuId }, data: { enabled: false } });
  assert.equal((await read()).stock.items.length, 0);
  await db.sku.update({ where: { id: f.input.skuId }, data: { enabled: true } });
  const w = await db.warehouse.create({
    data: { id: randomUUID(), code: 'TASK-FOREIGN', name: '合成外仓' },
  });
  await db.rewardProduct.create({
    data: {
      id: randomUUID(),
      warehouseId: w.id,
      skuId: f.input.skuId,
      title: '不应出现的外仓商品',
      pointsPrice: 1n,
      perUserLimit: 1,
      totalQuota: 1,
      status: 'PUBLISHED',
    },
  });
  assert.equal((await read()).stock.items.length, 1);
});
test('stable key pagination has no duplicate or missing low-stock products and stock filter precedes paging', async () => {
  const db = f.runtime.db;
  for (let i = 0; i < 22; i++) {
    const sku = await db.sku.create({
      data: {
        id: randomUUID(),
        productId: f.catalog.productId,
        code: 'TASK-' + i,
        spec: '合成规格' + i,
        unit: '件',
        priceCents: 100n,
        expiryManaged: false,
      },
    });
    await db.rewardProduct.create({
      data: {
        id: randomUUID(),
        warehouseId: f.warehouseId,
        skuId: sku.id,
        title: '合成缺货' + i,
        pointsPrice: 10n,
        status: 'PUBLISHED',
        perUserLimit: 1,
        totalQuota: 1,
      },
    });
  }
  const first = await read('?stock=ZERO');
  assert.equal(first.stock.items.length, 20);
  assert.equal(first.stock.outOfStock, 22);
  assert.ok(first.stock.nextCursor);
  const second = await read('?stock=ZERO&cursor=' + first.stock.nextCursor);
  assert.equal(second.stock.items.length, 2);
  assert.equal(second.stock.nextCursor, null);
  assert.equal(new Set([...first.stock.items, ...second.stock.items].map((i) => i.id)).size, 22);
  assert.equal((await read('?stock=LOW')).stock.items.length, 1);
});
test('grant and correction pending counts/filtering reflect real application transitions, old clients remain compatible', async () => {
  const g = await f.api('/admin/points/grants/store/create', {
    userId: f.identity.user.id,
    amount: '10',
    reason: '合成待办申请',
    reference: 'TASK',
  });
  assert.equal(g.status, 200);
  assert.equal((await read()).queues.find((q) => q.code === 'GRANTS')!.count, 1);
  assert.equal((await f.api('/admin/points/grants?status=SUBMITTED')).data.items.length, 1);
  assert.equal((await f.api('/admin/points/grants?status=APPROVED')).data.items.length, 0);
  assert.equal((await f.api('/admin/points/grants?status=oops')).status, 400);
  assert.equal((await f.api('/admin/points/corrections?status=oops')).status, 400);
  assert.equal(
    (
      await f.api('/admin/points/grants/' + g.data.id + '/cancel', {
        version: 0,
        reason: '合成取消',
      })
    ).status,
    200,
  );
  assert.equal((await read()).queues.find((q) => q.code === 'GRANTS')!.count, 0);
  assert.equal((await f.api('/admin/points/grants')).data.items.length, 1);
  assert.equal(
    (
      await f.api('/admin/points/grants/store/policy', {
        version: 0,
        enabled: true,
        singleLimit: '100',
        dailyLimit: '1000',
        reason: '合成测试预算',
      })
    ).status,
    200,
  );
  const source = await f.api('/admin/points/grants/store/create', {
    userId: f.identity.user.id,
    amount: '10',
    reason: '合成可冲正来源',
    reference: 'TASK-SOURCE',
  });
  const reviewer = await f.reviewer();
  const { data: reviewProfile } = await (
    await fetch(f.base + '/api/v1/staff/me', { headers: { Cookie: reviewer } })
  ).json();
  assert.equal(
    (
      await f.api(
        '/admin/points/grants/' + source.data.id + '/approve',
        { version: 0, reason: '合成独立审批' },
        randomUUID(),
        reviewer,
        reviewProfile.csrfToken,
      )
    ).status,
    200,
  );
  const correction = await f.api('/admin/points/corrections/store/create', {
    grantId: source.data.id,
    amount: '2',
    reason: '合成待办冲正',
    reference: 'TASK-CORRECTION',
  });
  assert.equal(correction.status, 200);
  assert.equal((await read()).queues.find((q) => q.code === 'CORRECTIONS')!.count, 1);
  assert.equal((await f.api('/admin/points/corrections?status=SUBMITTED')).data.items.length, 1);
  assert.equal((await f.api('/admin/points/corrections?status=APPROVED')).data.items.length, 0);
  assert.equal(
    (
      await f.api('/admin/points/corrections/' + correction.data.id + '/cancel', {
        version: 0,
        reason: '合成撤销',
      })
    ).status,
    200,
  );
  assert.equal((await read()).queues.find((q) => q.code === 'CORRECTIONS')!.count, 0);
});
test('strict input, consumer/warehouse role and revoked warehouse deny access', async () => {
  for (const query of [
    '?threshold=-1',
    '?threshold=1001',
    '?threshold=1.2',
    '?threshold=',
    '?threshold=01',
    '?stock=oops',
    '?cursor=bad',
    '?warehouseId=' + randomUUID(),
  ])
    assert.equal((await f.api('/admin/mall-tasks' + query)).status, 400, query);
  assert.equal(
    (
      await fetch(f.base + '/api/v1/admin/mall-tasks', {
        headers: { Authorization: 'Bearer ' + f.identity.token },
      })
    ).status,
    401,
  );
  const { data: p } = await (
    await fetch(f.base + '/api/v1/staff/me', { headers: { Cookie: f.cookie } })
  ).json();
  const db = f.runtime.db;
  await db.staffRole.updateMany({
    where: { staffId: p.id },
    data: { roleCode: 'WAREHOUSE_MANAGER' },
  });
  assert.equal((await f.api('/admin/mall-tasks')).status, 403);
  await db.staffRole.updateMany({ where: { staffId: p.id }, data: { roleCode: 'SUPER_ADMIN' } });
  await db.staffWarehouse.deleteMany({ where: { staffId: p.id, warehouseId: f.warehouseId } });
  assert.equal((await f.api('/admin/mall-tasks')).status, 403);
});
test('real express shipping, feedback and return stages move counts and stage timestamps without double counting', async () => {
  const e = await expressShippingFixture();
  try {
    const report = async () => {
      const r = await e.api('/admin/mall-tasks');
      assert.equal(r.status, 200);
      return r.data as unknown as MallTasks;
    };
    const queue = async (code: string) => (await report()).queues.find((q) => q.code === code)!;
    const o = await e.createExpress(2);
    assert.equal((await queue('WAIT_SHIP')).count, 1);
    assert.equal(
      (
        await e.api('/admin/redemptions/' + o + '/ship', {
          version: 0,
          carrierCode: 'SF',
          trackingNo: 'SF-TASKS',
          dispatchConfirmed: true,
        })
      ).status,
      200,
    );
    assert.equal((await queue('WAIT_SHIP')).count, 0);

    const feedbackPath = '/consumer/redemptions/' + o + '/after-sales';
    const feedback = await e.call(feedbackPath, { category: 'DAMAGED', message: '合成待办反馈' });
    assert.equal(feedback.status, 200);
    assert.equal((await queue('FEEDBACK_OPEN')).count, 1);
    assert.equal(
      (
        await e.api('/admin/redemption-after-sales/' + o + '/reply', {
          version: 0,
          message: '合成正在处理',
        })
      ).status,
      200,
    );
    assert.equal((await queue('FEEDBACK_OPEN')).count, 0);
    assert.equal((await queue('FEEDBACK_PROCESSING')).count, 1);
    assert.equal(
      (
        await e.api('/admin/redemption-after-sales/' + o + '/close', {
          version: 1,
          message: '合成结束',
        })
      ).status,
      200,
    );
    assert.equal((await queue('FEEDBACK_PROCESSING')).count, 0);
    const created = await e.call('/consumer/redemptions/' + o + '/returns', {
      quantity: 1,
      reason: '合成待办退款',
    });
    assert.equal(created.status, 200);
    const rid = created.data.id;
    assert.equal((await queue('REQUESTED')).count, 1);
    assert.equal(
      (
        await e.api('/admin/redemption-returns/' + rid + '/approve', {
          requiresReturn: true,
          reason: '请寄回合成商品',
        })
      ).status,
      200,
    );
    assert.equal((await queue('REQUESTED')).count, 0);
    assert.equal((await queue('WAIT_RETURN')).count, 1);
    const approval = await e.runtime.db.redemptionReturnEvent.findFirstOrThrow({
      where: { returnId: rid, kind: 'APPROVE' },
    });
    assert.equal((await queue('WAIT_RETURN')).oldestAt, approval.createdAt.toISOString());
    assert.equal(
      (
        await e.api('/admin/redemption-returns/' + rid + '/receive', {
          quantity: 1,
          condition: 'DAMAGED',
          location: '合成隔离区',
          physicalConfirmed: true,
          reason: '合成验收',
        })
      ).status,
      200,
    );
    assert.equal((await queue('WAIT_RETURN')).count, 0);
    assert.equal((await queue('READY_TO_REFUND')).count, 1);
    const receipt = await e.runtime.db.redemptionReturnEvent.findFirstOrThrow({
      where: { returnId: rid, kind: 'RECEIVE' },
    });
    assert.equal((await queue('READY_TO_REFUND')).oldestAt, receipt.createdAt.toISOString());
    assert.equal(
      (
        await e.api('/admin/redemption-returns/' + rid + '/refund', {
          confirmed: true,
          reason: '合成原价退分',
        })
      ).status,
      200,
    );
    assert.equal((await queue('READY_TO_REFUND')).count, 0);
  } finally {
    await e.cleanup();
  }
});
