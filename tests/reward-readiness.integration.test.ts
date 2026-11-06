import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { RewardReadiness } from '../packages/contracts/src/index.ts';
import { rewardsFixture } from './helpers/rewards-fixture.ts';
let f: Awaited<ReturnType<typeof rewardsFixture>>, id: string;
before(async () => {
  f = await rewardsFixture();
  const r = await f.api('/admin/rewards/store/create', f.input);
  assert.equal(r.status, 200);
  id = r.data.id;
});
after(async () => {
  await f?.cleanup();
});
async function report() {
  const r = await f.api('/admin/rewards/' + id + '/readiness');
  assert.equal(r.status, 200);
  return r.data as unknown as RewardReadiness;
}
const status = (d: RewardReadiness, code: string) => d.checks.find((c) => c.code === code)!.status;
test('check is read-only and distinguishes warnings from original publishing blockers', async () => {
  const db = f.runtime.db;
  const before = JSON.stringify(
    [
      await db.product.findMany(),
      await db.rewardProduct.findMany(),
      await db.stockBalance.findMany(),
      await db.businessAudit.count(),
      await db.idempotencyRecord.count(),
    ],
    (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
  );
  const r = await report();
  assert.equal(r.canPublish, true);
  assert.equal(r.displayableNow, false);
  assert.equal(r.inventoryAvailable, 5);
  assert.equal(r.submissionEnabled, false);
  assert.equal(status(r, 'IMAGE'), 'WARNING');
  assert.equal(status(r, 'SHIPPING'), 'WARNING');
  assert.equal(status(r, 'SUBMISSION'), 'WARNING');
  assert.equal(status(r, 'PRICE'), 'READY');
  assert.equal(r.checks.length, 10);
  assert.equal(
    JSON.stringify(
      [
        await db.product.findMany(),
        await db.rewardProduct.findMany(),
        await db.stockBalance.findMany(),
        await db.businessAudit.count(),
        await db.idempotencyRecord.count(),
      ],
      (_k, v) => (typeof v === 'bigint' ? v.toString() : v),
    ),
    before,
  );
  const encoded = JSON.stringify(r);
  for (const key of ['warehouseId', 'objectKey', 'token', 'userId', 'unitCost', 'subject'])
    assert.ok(!encoded.includes(key));
});
test('unpublished source blocks publication while physical stock remains accurately visible', async () => {
  const db = f.runtime.db;
  await db.product.update({ where: { id: f.catalog.productId }, data: { status: 'UNPUBLISHED' } });
  try {
    const r = await report();
    assert.equal(r.canPublish, false);
    assert.equal(status(r, 'PRODUCT'), 'BLOCKING');
    assert.equal(r.inventoryAvailable, 5);
    assert.equal(r.reward.available, 0);
    assert.equal(
      (
        await f.api('/admin/rewards/' + id + '/publish', {
          version: (await report()).reward.version,
          reason: '合成检查后提交',
        })
      ).status,
      409,
    );
  } finally {
    await db.product.update({ where: { id: f.catalog.productId }, data: { status: 'PUBLISHED' } });
  }
});
test('disabled category and parent are identified, including the exact category maintenance target', async () => {
  const db = f.runtime.db;
  await db.category.update({ where: { id: f.catalog.categoryId }, data: { enabled: false } });
  try {
    const r = await report();
    assert.equal(status(r, 'CATEGORY'), 'BLOCKING');
    assert.equal(r.product.categoryToEditId, f.catalog.categoryId);
  } finally {
    await db.category.update({ where: { id: f.catalog.categoryId }, data: { enabled: true } });
  }
  const parent = await db.category.create({ data: { id: randomUUID(), name: '合成父分类' } }),
    child = await db.category.create({
      data: { id: randomUUID(), name: '合成子分类', parentId: parent.id },
    });
  await db.product.update({ where: { id: f.catalog.productId }, data: { categoryId: child.id } });
  await db.category.update({ where: { id: parent.id }, data: { enabled: false } });
  try {
    const r = await report();
    assert.equal(r.canPublish, false);
    assert.equal(r.product.categoryToEditId, parent.id);
  } finally {
    await db.product.update({
      where: { id: f.catalog.productId },
      data: { categoryId: f.catalog.categoryId },
    });
  }
});
test('disabled SKU and ended schedule block, future start only warns and existing write semantics remain intact', async () => {
  const db = f.runtime.db;
  await db.sku.update({ where: { id: f.input.skuId }, data: { enabled: false } });
  try {
    assert.equal(status(await report(), 'SKU'), 'BLOCKING');
  } finally {
    await db.sku.update({ where: { id: f.input.skuId }, data: { enabled: true } });
  }
  await db.rewardProduct.update({
    where: { id },
    data: { version: { increment: 1 }, endsAt: new Date(Date.now() - 3600000) },
  });
  assert.equal(status(await report(), 'SCHEDULE'), 'BLOCKING');
  assert.equal(
    (
      await f.api('/admin/rewards/' + id + '/publish', {
        version: (await report()).reward.version,
        reason: '合成结束时间',
      })
    ).status,
    409,
  );
  await db.rewardProduct.update({
    where: { id },
    data: {
      version: { increment: 1 },
      startsAt: new Date(Date.now() + 3600000),
      endsAt: new Date(Date.now() + 7200000),
    },
  });
  let r = await report();
  assert.equal(r.canPublish, true);
  assert.equal(status(r, 'SCHEDULE'), 'WARNING');
  assert.equal(
    (
      await f.api('/admin/rewards/' + id + '/publish', {
        version: (await report()).reward.version,
        reason: '提前上架合成商品',
      })
    ).status,
    200,
  );
  r = await report();
  assert.equal(r.canPublish, false);
  assert.equal(r.displayableNow, false);
  await db.rewardProduct.update({
    where: { id },
    data: { version: { increment: 1 }, startsAt: null, endsAt: null },
  });
  r = await report();
  assert.equal(r.displayableNow, true);
  assert.equal(r.canPublish, false);
});
test('inventory safety, holds, expiry and disabled locations match existing public sellability', async () => {
  const db = f.runtime.db,
    where = { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.input.skuId } },
    lot = await db.stockLot.findFirstOrThrow({ where: { skuId: f.input.skuId } }),
    position = await db.stockPosition.findFirstOrThrow({ where: { lotId: lot.id } });
  const equal = async (amount: number) => {
    assert.equal((await report()).inventoryAvailable, amount);
    assert.equal((await f.api('/rewards/' + id)).data.available, amount);
  };
  await db.stockBalance.update({ where, data: { safety: 4 } });
  await equal(1);
  await db.stockBalance.update({ where, data: { safety: 5 } });
  await equal(0);
  assert.equal(status(await report(), 'STOCK'), 'WARNING');
  await db.stockBalance.update({ where, data: { safety: 0, inventoryHold: true } });
  await equal(0);
  await db.stockBalance.update({ where, data: { inventoryHold: false } });
  await db.stockLot.update({
    where: { id: lot.id },
    data: { producedAt: new Date(0), expiresAt: new Date(86400000) },
  });
  await equal(0);
  await db.stockLot.update({ where: { id: lot.id }, data: { producedAt: null, expiresAt: null } });
  await db.warehouseLocation.update({
    where: { id: position.locationId },
    data: { enabled: false },
  });
  await equal(0);
  await db.warehouseLocation.update({
    where: { id: position.locationId },
    data: { enabled: true },
  });
  await equal(5);
});
test('shipping configuration is factual and does not change publish or operating switches', async () => {
  const db = f.runtime.db;
  await db.redemptionExpressPolicy.create({
    data: {
      warehouseId: f.warehouseId,
      enabled: true,
      provinces: ['浙江省'],
      shippingFeeMode: 'SENDER_PAID',
    },
  });
  const r = await report();
  assert.equal(status(r, 'SHIPPING'), 'READY');
  assert.equal(r.submissionEnabled, false);
  await db.redemptionExpressPolicy.update({
    where: { warehouseId: f.warehouseId },
    data: { enabled: false },
  });
  assert.equal(status(await report(), 'SHIPPING'), 'WARNING');
});
test('fresh writes recheck changed catalogue facts instead of trusting a previous successful check', async () => {
  const db = f.runtime.db;
  assert.equal(
    (
      await f.api('/admin/rewards/' + id + '/unpublish', {
        version: (await report()).reward.version,
        reason: '合成恢复草稿',
      })
    ).status,
    200,
  );
  assert.equal((await report()).canPublish, true);
  await db.sku.update({ where: { id: f.input.skuId }, data: { enabled: false } });
  assert.equal(
    (
      await f.api('/admin/rewards/' + id + '/publish', {
        version: (await report()).reward.version,
        reason: '检查后发生并发变化',
      })
    ).status,
    409,
  );
  await db.sku.update({ where: { id: f.input.skuId }, data: { enabled: true } });
});
test('strict input, missing/foreign resource, role and warehouse checks protect the report', async () => {
  const path = '/admin/rewards/' + id + '/readiness';
  assert.equal((await f.api(path + '?unexpected=1')).status, 400);
  assert.equal((await f.api('/admin/rewards/not-a-uuid/readiness')).status, 400);
  assert.equal((await f.api('/admin/rewards/' + randomUUID() + '/readiness')).status, 404);
  const d = f.runtime.db,
    w = await d.warehouse.create({
      data: { id: randomUUID(), code: 'CHECK-FOREIGN', name: '合成外仓' },
    }),
    foreign = await d.rewardProduct.create({
      data: {
        id: randomUUID(),
        warehouseId: w.id,
        skuId: f.input.skuId,
        title: '外仓合成兑换',
        pointsPrice: 1n,
        perUserLimit: 1,
        totalQuota: 1,
      },
    });
  assert.equal((await f.api('/admin/rewards/' + foreign.id + '/readiness')).status, 404);
  const response = await fetch(f.base + '/api/v1' + path, {
    headers: { Authorization: 'Bearer ' + f.identity.token },
  });
  assert.equal(response.status, 401);
  const me = await fetch(f.base + '/api/v1/staff/me', { headers: { Cookie: f.cookie } }),
    { data: profile } = await me.json();
  await d.staffRole.updateMany({
    where: { staffId: profile.id },
    data: { roleCode: 'WAREHOUSE_MANAGER' },
  });
  assert.equal((await f.api(path)).status, 403);
  await d.staffRole.updateMany({
    where: { staffId: profile.id },
    data: { roleCode: 'SUPER_ADMIN' },
  });
  await d.staffWarehouse.deleteMany({ where: { staffId: profile.id, warehouseId: f.warehouseId } });
  assert.equal((await f.api(path)).status, 403);
});
