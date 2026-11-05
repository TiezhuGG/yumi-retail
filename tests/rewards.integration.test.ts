import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rewardsFixture } from './helpers/rewards-fixture.ts';
let f: Awaited<ReturnType<typeof rewardsFixture>>, id: string;
before(async () => {
  f = await rewardsFixture();
});
after(async () => {
  await f?.cleanup();
});
test('draft creation is idempotent, validated and private; publishing requires a real enabled source', async () => {
  const k = randomUUID(),
    [a, b] = await Promise.all([
      f.api('/admin/rewards/store/create', f.input, k),
      f.api('/admin/rewards/store/create', f.input, k),
    ]);
  assert.equal(a.status, 200);
  assert.equal(b.data.id, a.data.id);
  id = a.data.id;
  assert.equal(
    (await f.api('/admin/rewards/store/create', { ...f.input, title: '修改摘要' }, k)).error?.code,
    'IDEMPOTENCY_CONFLICT',
  );
  assert.equal((await f.api('/rewards/' + id)).status, 404);
  for (const patch of [
    { pointsPrice: 120 },
    { pointsPrice: '0' },
    { pointsPrice: '1000000001' },
    { perUserLimit: 21 },
    { startsAt: '2026-02-30T00:00:00Z' },
    { startsAt: '2027-01-02T00:00:00Z', endsAt: '2027-01-01T00:00:00Z' },
    { status: 'PUBLISHED' },
  ])
    assert.equal(
      (await f.api('/admin/rewards/store/create', { ...f.input, ...patch })).status,
      400,
    );
  await f.runtime.db.sku.update({ where: { id: f.input.skuId }, data: { enabled: false } });
  assert.equal(
    (await f.api('/admin/rewards/' + id + '/publish', { version: 0, reason: '合成上架' })).error
      ?.code,
    'REWARD_UNAVAILABLE',
  );
  await f.runtime.db.sku.update({ where: { id: f.input.skuId }, data: { enabled: true } });
  assert.equal(
    (await f.api('/admin/rewards/' + id + '/publish', { version: 0, reason: '合成上架' })).status,
    200,
  );
  const detail = await f.api('/rewards/' + id);
  assert.equal(detail.data.pointsPrice, '120');
  assert.equal(detail.data.available, 5);
  assert.equal(detail.data.redemptionEnabled, false);
  assert.equal((await f.api('/admin/rewards/store/create', f.input)).status, 409);
});
test('sellability follows shared inventory safety, count holds, expiry, disabled positions and source visibility', async () => {
  const db = f.runtime.db,
    where = { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.input.skuId } };
  const before = await db.stockBalance.findUniqueOrThrow({ where });
  await db.stockBalance.update({ where, data: { inventoryHold: true } });
  assert.equal((await f.api('/rewards/' + id)).data.available, 0);
  await db.stockBalance.update({ where, data: { inventoryHold: false, safety: 4 } });
  assert.equal((await f.api('/rewards/' + id)).data.available, 1);
  await db.stockBalance.update({ where, data: { safety: 0 } });
  const lot = await db.stockLot.findFirstOrThrow({ where: { skuId: f.input.skuId } });
  await db.stockLot.update({
    where: { id: lot.id },
    data: { producedAt: new Date(0), expiresAt: new Date(86400000) },
  });
  assert.equal((await f.api('/rewards/' + id)).data.available, 0);
  await db.stockLot.update({ where: { id: lot.id }, data: { producedAt: null, expiresAt: null } });
  const position = await db.stockPosition.findFirstOrThrow({ where: { lotId: lot.id } });
  await db.warehouseLocation.update({
    where: { id: position.locationId },
    data: { enabled: false },
  });
  assert.equal((await f.api('/rewards/' + id)).data.available, 0);
  await db.warehouseLocation.update({
    where: { id: position.locationId },
    data: { enabled: true },
  });
  await db.category.update({ where: { id: f.catalog.categoryId }, data: { enabled: false } });
  assert.equal((await f.api('/rewards/' + id)).status, 404);
  await db.category.update({ where: { id: f.catalog.categoryId }, data: { enabled: true } });
  assert.deepEqual(await db.stockBalance.findUniqueOrThrow({ where }), before);
  assert.equal(await db.pointsEntry.count(), 0);
});
test('concurrent rules updates have one winner; stale versions, schedule and unpublish are enforced', async () => {
  const { skuId: _, ...body } = f.input;
  void _;
  const outcomes = await Promise.all([
    f.api('/admin/rewards/' + id + '/update', { ...body, version: 1, pointsPrice: '130' }),
    f.api('/admin/rewards/' + id + '/update', { ...body, version: 1, pointsPrice: '140' }),
  ]);
  assert.deepEqual(outcomes.map((r) => r.status).sort(), [200, 409]);
  assert.equal(
    (await f.api('/admin/rewards/' + id + '/unpublish', { version: 1, reason: '旧版本' })).error
      ?.code,
    'VERSION_CONFLICT',
  );
  assert.equal(
    (
      await f.api('/admin/rewards/' + id + '/update', {
        ...body,
        version: 2,
        startsAt: '2099-01-01T00:00:00Z',
      })
    ).status,
    200,
  );
  assert.equal((await f.api('/rewards/' + id)).status, 404);
  assert.equal(
    (await f.api('/admin/rewards/' + id + '/update', { ...body, version: 3 })).status,
    200,
  );
  assert.equal(
    (await f.api('/admin/rewards/' + id + '/unpublish', { version: 4, reason: '合成下架' })).status,
    200,
  );
  assert.equal((await f.api('/rewards/' + id)).status, 404);
  assert.equal(
    (await f.api('/admin/rewards/' + id + '/publish', { version: 5, reason: '重新上架' })).status,
    200,
  );
});
test('authorization and CSRF remain server enforced; cross-warehouse access is rejected', async () => {
  assert.equal((await f.api('/admin/rewards', undefined, randomUUID(), '')).status, 401);
  assert.equal(
    (
      await f.api(
        '/admin/rewards/' + id + '/unpublish',
        { version: 6, reason: '缺CSRF' },
        randomUUID(),
        f.cookie,
        '',
      )
    ).status,
    403,
  );
  const db = f.runtime.db;
  const session = await db.staffSession.findFirstOrThrow({
    where: { staff: { loginName: 'points-ui' } },
  });
  await db.staffRole.deleteMany({ where: { staffId: session.staffId } });
  await db.staffRole.create({ data: { staffId: session.staffId, roleCode: 'RIDER' } });
  assert.equal((await f.api('/admin/rewards')).status, 403);
  await db.staffRole.deleteMany({ where: { staffId: session.staffId } });
  await db.staffRole.create({ data: { staffId: session.staffId, roleCode: 'SUPER_ADMIN' } });
  await db.staffWarehouse.deleteMany({ where: { staffId: session.staffId } });
  assert.equal((await f.api('/admin/rewards')).status, 403);
  await db.staffWarehouse.create({
    data: { staffId: session.staffId, warehouseId: f.warehouseId },
  });
  const other = await db.warehouse.create({
    data: { id: randomUUID(), code: 'REWARD-OTHER', name: '其他合成仓' },
  });
  const hidden = await db.rewardProduct.create({
    data: {
      id: randomUUID(),
      warehouseId: other.id,
      skuId: f.input.skuId,
      title: '其他仓',
      pointsPrice: 1n,
      perUserLimit: 1,
      totalQuota: 1,
      status: 'PUBLISHED',
    },
  });
  assert.equal((await f.api('/rewards/' + hidden.id)).status, 404);
  assert.equal(
    (await f.api('/admin/rewards/' + hidden.id + '/unpublish', { version: 0, reason: '跨仓' }))
      .status,
    404,
  );
});
test('late audit failure rolls back a rules change and allows recovery with the original key; SQL source cannot change', async () => {
  const db = f.runtime.db,
    k = randomUUID(),
    path = '/admin/rewards/' + id + '/unpublish',
    body = { version: 6, reason: '故障恢复验证' };
  await db.$executeRawUnsafe(
    "CREATE FUNCTION reject_reward_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='REWARD_UNPUBLISH' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$",
  );
  await db.$executeRawUnsafe(
    'CREATE TRIGGER reject_reward_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION reject_reward_audit()',
  );
  assert.equal((await f.api(path, body, k)).status, 500);
  assert.equal((await db.rewardProduct.findUniqueOrThrow({ where: { id } })).version, 6);
  await db.$executeRawUnsafe('DROP TRIGGER reject_reward_audit ON business_audits');
  assert.equal((await f.api(path, body, k)).status, 200);
  assert.equal((await f.api(path, body, k)).status, 200);
  assert.equal((await db.rewardProduct.findUniqueOrThrow({ where: { id } })).version, 7);
  await assert.rejects(
    db.$executeRaw`UPDATE reward_products SET sku_id=${f.catalog.skuIds[1]}::uuid,version=version+1 WHERE id=${id}::uuid`,
  );
  await assert.rejects(db.$executeRaw`DELETE FROM reward_products WHERE id=${id}::uuid`);
});
test('stable sort pagination and search/category/status isolate results; public responses have no warehouse or cost', async () => {
  const db = f.runtime.db;
  const ids = Array.from({ length: 23 }, () => randomUUID()).sort();
  for (const [i, rid] of ids.entries()) {
    const sku = await db.sku.create({
      data: {
        id: randomUUID(),
        productId: f.catalog.productId,
        code: 'REWARD-PAGE-' + i,
        spec: '合成分页' + i,
        unit: '件',
        priceCents: 1n,
        expiryManaged: false,
      },
    });
    await db.rewardProduct.create({
      data: {
        id: rid,
        warehouseId: f.warehouseId,
        skuId: sku.id,
        title: '分页商品' + String(i).padStart(2, '0'),
        pointsPrice: 1n,
        status: 'PUBLISHED',
        sortOrder: i % 3,
        perUserLimit: 1,
        totalQuota: 1,
      },
    });
  }
  const first = await f.api('/rewards?keyword=' + encodeURIComponent('分页商品'));
  assert.equal(first.data.items.length, 20);
  assert.ok(first.data.nextCursor);
  const second = await f.api(
    '/rewards?keyword=' + encodeURIComponent('分页商品') + '&cursor=' + first.data.nextCursor,
  );
  assert.equal(second.data.items.length, 3);
  assert.equal(new Set([...first.data.items, ...second.data.items].map((r) => r.id)).size, 23);
  assert.equal((await f.api('/rewards?categoryId=' + randomUUID())).data.items.length, 0);
  assert.equal((await f.api('/rewards?status=DRAFT')).status, 400);
  assert.equal((await f.api('/rewards?cursor=' + randomUUID())).error?.code, 'CURSOR_INVALID');
  for (const row of first.data.items) {
    assert.equal('warehouseId' in row, false);
    assert.equal('priceCents' in row, false);
    assert.equal('cost' in row, false);
  }
  assert.equal((await f.api('/admin/rewards?status=UNPUBLISHED')).data.items.length, 1);
});
