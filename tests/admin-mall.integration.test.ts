import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rewardsFixture } from './helpers/rewards-fixture.ts';
let f: Awaited<ReturnType<typeof rewardsFixture>>;
before(async () => {
  f = await rewardsFixture();
  await f.seed();
});
after(async () => {
  await f?.cleanup();
});
const product = () => ({
  categoryId: f.catalog.categoryId,
  name: '合成双价商品',
  description: '隔离验证',
  skus: [
    {
      code: 'MALL-' + randomUUID().slice(0, 8),
      spec: '1件装',
      unit: '件',
      priceCents: 1999,
      expiryManaged: false,
    },
  ],
  pointsPrice: '180',
  reason: '合成新商品测试',
});
async function api(
  path: string,
  body?: unknown,
  cookie = f.cookie,
  csrf = f.profile.csrfToken,
  k = randomUUID(),
) {
  const r = await fetch(f.base + '/api/v1' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Cookie: cookie,
      Origin: 'http://127.0.0.1:5188',
      'X-CSRF-Token': csrf,
      'Idempotency-Key': k,
      'Content-Type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, ...(await r.json()) };
}
test('one transaction creates cash and points drafts; concurrent same-key replay cannot duplicate them', async () => {
  const input = product(),
    k = randomUUID(),
    [a, b] = await Promise.all([
      api('/admin/mall-products', input, undefined, undefined, k),
      api('/admin/mall-products', input, undefined, undefined, k),
    ]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(a.data, b.data);
  const p = await f.runtime.db.product.findUniqueOrThrow({
      where: { id: a.data.id },
      include: { skus: true },
    }),
    reward = await f.runtime.db.rewardProduct.findUniqueOrThrow({ where: { id: a.data.rewardId } });
  assert.equal(p.status, 'DRAFT');
  assert.equal(p.skus[0]!.priceCents, 1999n);
  assert.equal(reward.pointsPrice, 180n);
  assert.equal(reward.status, 'DRAFT');
  assert.equal(reward.skuId, p.skus[0]!.id);
  assert.equal(
    (await api('/admin/mall-products', { ...input, pointsPrice: '181' }, undefined, undefined, k))
      .status,
    409,
  );
  const list = await api('/admin/rewards?keyword=' + encodeURIComponent(input.name));
  assert.equal(list.data.items[0].priceCents, 1999);
  assert.equal(list.data.items[0].pointsPrice, '180');
});
test('cash-only draft is allowed; invalid pricing, extra fields, categories and duplicate SKU are rejected without partial rows', async () => {
  const input = product(),
    a = await api('/admin/mall-products', { ...input, description: undefined, pointsPrice: null });
  assert.equal(a.status, 200);
  assert.equal(a.data.rewardId, null);
  const count = await f.runtime.db.product.count();
  for (const patch of [
    { pointsPrice: '0' },
    { pointsPrice: '1.5' },
    { pointsPrice: '1000000001' },
    { pointsPrice: 30 },
    { priceCents: 1 },
    { categoryId: randomUUID() },
  ])
    assert.equal((await api('/admin/mall-products', { ...product(), ...patch })).status, 400);
  assert.equal((await api('/admin/mall-products', input)).status, 409);
  assert.equal(await f.runtime.db.product.count(), count);
});
test('late reward audit failure rolls back product, SKU, reward and idempotency; original request can recover', async () => {
  const d = f.runtime.db,
    input = product(),
    k = randomUUID(),
    before = await d.product.count();
  await d.$executeRawUnsafe(
    "CREATE FUNCTION fail_mall_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='REWARD_CREATE' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$",
  );
  await d.$executeRawUnsafe(
    'CREATE TRIGGER fail_mall_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_mall_audit()',
  );
  try {
    assert.equal((await api('/admin/mall-products', input, undefined, undefined, k)).status, 500);
    assert.equal(await d.product.count(), before);
    assert.equal(await d.sku.count({ where: { code: input.skus[0]!.code } }), 0);
  } finally {
    await d.$executeRawUnsafe('DROP TRIGGER fail_mall_audit ON business_audits');
  }
  assert.equal((await api('/admin/mall-products', input, undefined, undefined, k)).status, 200);
});
test('customer directory includes zero-balance and disabled users, paginates and exposes only permitted profile fields', async () => {
  const d = f.runtime.db;
  await d.consumerUser.update({ where: { id: f.identityB.user.id }, data: { enabled: false } });
  const a = await api('/admin/customers');
  assert.equal(a.status, 200);
  assert.equal(a.data.items.length, 20);
  assert.ok(a.data.nextCursor);
  const b = await api('/admin/customers?cursor=' + a.data.nextCursor);
  assert.equal(b.status, 200);
  assert.equal(
    new Set([...a.data.items, ...b.data.items].map((u: { id: string }) => u.id)).size,
    25,
  );
  const filtered = await api('/admin/customers?enabled=false&provider=DEVELOPMENT');
  assert.equal(filtered.data.items.length, 1);
  assert.equal(filtered.data.items[0].id, f.identityB.user.id);
  assert.equal(filtered.data.items[0].balance, '0');
  const detail = await api('/admin/customers/' + f.identity.user.id);
  assert.equal(detail.status, 200);
  assert.equal(detail.data.user.balance, '250');
  assert.ok(detail.data.lastLoginAt);
  assert.equal(detail.data.redemptions, 0);
  const keys = Object.keys(detail.data.user).sort();
  assert.deepEqual(keys, ['balance', 'createdAt', 'displayName', 'enabled', 'id', 'provider']);
  for (const q of [
    '?enabled=1',
    '?provider=OTHER',
    '?userId=' + f.identity.user.id,
    '?keyword=a&keyword=b',
    '?cursor=' + randomUUID(),
  ])
    assert.ok([400, 409].includes((await api('/admin/customers' + q)).status));
  assert.equal((await api('/admin/customers/' + randomUUID())).status, 404);
  assert.equal(
    (await api('/admin/customers?keyword=unknown&cursor=' + a.data.items[0].id)).status,
    409,
  );
});
test('per-customer grant/correction queues and sources retain independent approval, balance and immutable history', async () => {
  const a = f.identity.user.id,
    b = f.identityB.user.id,
    prefix = '/admin/points/grants/';
  await f.runtime.db.consumerUser.update({ where: { id: b }, data: { enabled: true } });
  assert.equal(
    (
      await api(prefix + 'store/policy', {
        version: 0,
        enabled: true,
        singleLimit: '1000',
        dailyLimit: '10000',
        reason: '合成预算',
      })
    ).status,
    200,
  );
  const grant = await api(prefix + 'store/create', {
    userId: a,
    amount: '40',
    reference: 'MALL-CUSTOMER-A',
    reason: '合成发放',
  });
  assert.equal(grant.status, 200);
  assert.equal(
    (await api(prefix + grant.data.id + '/approve', { version: 0, reason: '禁止自审' })).status,
    403,
  );
  const reviewer = await f.reviewer(),
    me = await api('/staff/me', undefined, reviewer),
    k = randomUUID();
  assert.equal(
    (
      await api(
        prefix + grant.data.id + '/approve',
        { version: 0, reason: '核验合成凭据' },
        reviewer,
        me.data.csrfToken,
        k,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await api(
        prefix + grant.data.id + '/approve',
        { version: 0, reason: '核验合成凭据' },
        reviewer,
        me.data.csrfToken,
        k,
      )
    ).status,
    200,
  );
  assert.equal((await api('/admin/customers/' + a)).data.user.balance, '290');
  assert.equal((await api(prefix + '?userId=' + b)).data.items.length, 0);
  const sources = await api('/admin/points/corrections/sources?userId=' + a);
  assert.equal(sources.data.items[0].id, grant.data.id);
  assert.equal((await api('/admin/points/corrections/sources?userId=' + b)).data.items.length, 0);
  const correction = await api('/admin/points/corrections/store/create', {
    grantId: grant.data.id,
    amount: '10',
    reference: 'MALL-CUSTOMER-A-CORR',
    reason: '合成误发冲正',
  });
  assert.equal(correction.status, 200);
  assert.equal((await api('/admin/points/corrections?userId=' + a)).data.items.length, 1);
  assert.equal((await api('/admin/points/corrections?userId=' + b)).data.items.length, 0);
  assert.equal((await api('/admin/customers/' + a)).data.pendingCorrections, 1);
  assert.equal(
    (
      await api(
        '/admin/points/corrections/' + correction.data.id + '/approve',
        { version: 0, reason: '核对冲正依据' },
        reviewer,
        me.data.csrfToken,
      )
    ).status,
    200,
  );
  assert.equal((await api('/admin/customers/' + a)).data.user.balance, '280');
});
test('consumer, warehouse role, removed warehouse binding and revoked roles cannot inspect or create', async () => {
  assert.equal((await api('/admin/customers', undefined, '')).status, 401);
  const me = await api('/staff/me'),
    staffId = me.data.id;
  await f.runtime.db.staffRole.updateMany({
    where: { staffId },
    data: { roleCode: 'WAREHOUSE_MANAGER' },
  });
  try {
    assert.equal((await api('/admin/customers')).status, 403);
    assert.equal((await api('/admin/mall-products', product())).status, 403);
  } finally {
    await f.runtime.db.staffRole.updateMany({
      where: { staffId },
      data: { roleCode: 'SUPER_ADMIN' },
    });
  }
  await f.runtime.db.staffWarehouse.deleteMany({ where: { staffId, warehouseId: f.warehouseId } });
  assert.equal((await api('/admin/customers')).status, 403);
  assert.equal((await api('/admin/mall-products', product())).status, 403);
});
