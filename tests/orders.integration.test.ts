import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { checkoutFixture } from './helpers/checkout-fixture.ts';
import { expireUnpaidOrders, releaseUnpaidOrder } from '../packages/database/dist/index.js';
import { applicationConfig } from '../apps/api/dist/config.js';
import { CatalogService } from '../apps/api/dist/catalog-service.js';
import { InventoryService } from '../apps/api/dist/inventory-service.js';
import { OrderService } from '../apps/api/dist/orders.js';
import { CheckoutService } from '../apps/api/dist/checkout.js';
import { ConsumerAddressService } from '../apps/api/dist/consumer-address.js';
import type { ApiRequest } from '../apps/api/dist/http.js';
import type { ConsumerOrder, CheckoutQuote } from '../packages/contracts/src/index.ts';
let f: Awaited<ReturnType<typeof checkoutFixture>>;
async function call<T = ConsumerOrder>(
  path: string,
  body?: unknown,
  token = f.identity.token,
  key = randomUUID(),
) {
  const r = await fetch(f.base + '/api/v1' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
      'Idempotency-Key': key,
      'X-Yumi-Dev-Login': '1',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: r.status, ...((await r.json()) as { data: T; error?: { code: string } }) };
}
async function quote(addressId = f.addressId, token = f.identity.token) {
  const book = await call<{ version: number }>('/consumer/addresses', undefined, token),
    cart = await call<{ version: number }>('/consumer/cart', undefined, token);
  const r = await call<CheckoutQuote>(
    '/consumer/checkout/quotes',
    { addressId, addressVersion: book.data.version, cartVersion: cart.data.version },
    token,
  );
  assert.equal(r.status, 200, JSON.stringify(r));
  return r.data;
}
const create = (id: string, key = randomUUID(), token = f.identity.token) =>
  call<{ id: string }>('/consumer/orders', { quoteId: id }, token, key);
const cancel = (id: string, token = f.identity.token) =>
  call<{ id: string }>(`/consumer/orders/${id}/cancel`, {}, token);
async function verifyInventory() {
  const service = new InventoryService(new CatalogService(f.runtime.db, f.warehouseId));
  for (const id of f.catalog.skuIds) {
    const issues = await service.issues(f.runtime.db, f.warehouseId, id);
    assert.equal(issues.issueCount, 0);
    assert.deepEqual(issues.issues, []);
  }
}
before(async () => {
  f = await checkoutFixture({ orders: true, holdSeconds: 3 });
  await f.runtime.db.checkoutPolicy.create({
    data: {
      warehouseId: f.warehouseId,
      deliveryFeeCents: 300,
      minGoodsCents: 0,
      freeDeliveryThresholdCents: null,
      open: true,
    },
  });
});
after(async () => {
  if (f) await f.cleanup();
});
test('local-only feature, strict inputs, identity and quotation ownership are enforced', async () => {
  assert.throws(() =>
    applicationConfig({
      NODE_ENV: 'production',
      STAFF_ALLOWED_ORIGINS: 'https://retail.invalid',
      ORDER_DEV_SUBMIT_ENABLED: '1',
    }),
  );
  assert.throws(() => applicationConfig({ ORDER_DEV_HOLD_SECONDS: '0' }));
  assert.equal((await call('/consumer/orders', { quoteId: randomUUID() }, '')).status, 401);
  for (const body of [
    { quoteId: 'bad' },
    { quoteId: randomUUID(), payableCents: 1 },
    { quoteId: randomUUID(), userId: randomUUID() },
  ])
    assert.equal((await call('/consumer/orders', body)).status, 400);
  assert.equal((await create(randomUUID())).status, 404);
  const disabled = new OrderService(
    new CheckoutService(new CatalogService(f.runtime.db, f.warehouseId)),
    new ConsumerAddressService(new CatalogService(f.runtime.db, f.warehouseId)),
  );
  await assert.rejects(
    () =>
      disabled.create(
        { method: 'POST', headers: {}, socket: {}, requestId: randomUUID() },
        randomUUID(),
        { quoteId: randomUUID() },
      ),
    (e: unknown) =>
      Boolean(
        e &&
        typeof e === 'object' &&
        'getStatus' in e &&
        (e as { getStatus: () => number }).getStatus() === 503,
      ),
  );
  const other = await f.call('/consumer/auth/dev-session', { profile: 'customer-b' }, '');
  const owned = await quote();
  assert.equal((await create(owned.id, randomUUID(), other.data.token)).status, 404);

  assert.equal((await call('/consumer/orders?userId=' + randomUUID())).status, 400);
});
test('same-key concurrent submit makes one order and balanced real reservations; new key cannot reuse quote', async () => {
  const q = await quote(),
    key = randomUUID(),
    before = await f.runtime.db.stockLedger.count();
  const rs = await Promise.all([create(q.id, key), create(q.id, key)]);
  assert.equal(rs[0]!.status, 200, JSON.stringify(rs));
  assert.equal(rs[1]!.status, 200, JSON.stringify(rs));
  assert.equal(rs[0]!.data.id, rs[1]!.data.id);
  const id = rs[0]!.data.id;
  assert.equal((await create(q.id)).status, 409);
  assert.equal(
    (await call('/consumer/orders', { quoteId: randomUUID() }, f.identity.token, key)).status,
    409,
  );
  const balances = await f.runtime.db.stockBalance.findMany({
    where: { warehouseId: f.warehouseId },
    orderBy: { skuId: 'asc' },
  });
  assert.equal(
    balances.reduce((n, b) => n + b.reserved, 0),
    3,
  );
  assert.equal(
    balances.reduce((n, b) => n + b.onHand, 0),
    10,
  );
  assert.equal(await f.runtime.db.stockLedger.count(), before + 2);
  await verifyInventory();
  const order = (await call('/consumer/orders/' + id)).data;
  assert.equal(order.payableCents, 2499);
  assert.equal(order.paymentState, 'NOT_STARTED');
  await cancel(id);
  await verifyInventory();
  assert.equal((await create(q.id, key)).data.id, id);
});
test('different-key concurrent orders cannot oversell and failed orders reserve nothing', async () => {
  const qs = await Promise.all([quote(), quote(), quote()]);
  const rs = await Promise.all(qs.map((q) => create(q.id)));
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 200, 409]);
  const rows = await f.runtime.db.stockBalance.findMany({ where: { warehouseId: f.warehouseId } });
  assert.equal(rows.find((r) => r.skuId === f.catalog.skuIds[0])!.reserved, 4);
  assert.equal(rows.find((r) => r.skuId === f.catalog.skuIds[1])!.reserved, 2);
  for (const r of rs) if (r.status === 200) await cancel(r.data.id);
  await verifyInventory();
});
test('price, range, address and cart changes reject stale quotes without reservations', async () => {
  const q = await quote();
  await f.runtime.db.sku.update({ where: { id: f.catalog.skuIds[0]! }, data: { priceCents: 451 } });
  assert.equal((await create(q.id)).status, 409);
  await f.runtime.db.sku.update({ where: { id: f.catalog.skuIds[0]! }, data: { priceCents: 450 } });
  const q2 = await quote();
  await f.runtime.db.serviceBuilding.update({
    where: { id: f.buildingId },
    data: { enabled: false },
  });
  assert.equal((await create(q2.id)).status, 409);
  await f.runtime.db.serviceBuilding.update({
    where: { id: f.buildingId },
    data: { enabled: true },
  });
  const q3 = await quote();
  await f.runtime.db.consumerCart.update({
    where: { userId: f.identity.user.id },
    data: { version: { increment: 1 } },
  });
  assert.equal((await create(q3.id)).status, 409);
  assert.equal(
    (await f.runtime.db.stockBalance.aggregate({ _sum: { reserved: true } }))._sum.reserved,
    0,
  );
});
test('late event failure rolls back order, allocations, balances, position ledgers and quote consumption', async () => {
  const q = await quote(),
    key = randomUUID(),
    before = await f.runtime.db.stockLedger.count(),
    orders = await f.runtime.db.consumerOrder.count();
  await f.runtime.db.$executeRawUnsafe(
    `CREATE FUNCTION fail_order_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$`,
  );
  await f.runtime.db.$executeRawUnsafe(
    'CREATE TRIGGER fail_order_event BEFORE INSERT ON order_events FOR EACH ROW EXECUTE FUNCTION fail_order_event()',
  );
  try {
    assert.equal((await create(q.id, key)).status, 500);
  } finally {
    await f.runtime.db.$executeRawUnsafe('DROP TRIGGER fail_order_event ON order_events');
    await f.runtime.db.$executeRawUnsafe('DROP FUNCTION fail_order_event()');
  }
  assert.equal(await f.runtime.db.consumerOrder.count(), orders);
  assert.equal(await f.runtime.db.stockLedger.count(), before);
  assert.equal(
    (await f.runtime.db.stockBalance.aggregate({ _sum: { reserved: true } }))._sum.reserved,
    0,
  );
  const result = await create(q.id, key);
  assert.equal(result.status, 200);
  await cancel(result.data.id);
  await verifyInventory();
});
test('immutable encrypted order address survives address deletion and cancellation is owner-only/idempotent', async () => {
  const book = await call<{ version: number }>('/consumer/addresses');
  const added = await f.call('/consumer/addresses', {
    version: book.data.version,
    areaId: f.areaId,
    buildingId: f.buildingId,
    unit: '合成单元',
    room: '合成独立门牌',
    contactName: '合成订单联系人',
    phone: '00000000000',
    note: '合成门口位置',
    isDefault: false,
  });
  const q = await quote(added.data.id),
    created = await call<{ id: string }>('/consumer/orders', {
      quoteId: q.id,
      note: '合成订单备注',
    });
  assert.equal(created.status, 200);
  const id = created.data.id,
    row = await f.runtime.db.consumerOrder.findUniqueOrThrow({ where: { id } });
  for (const field of ['合成独立门牌', '合成订单联系人', '00000000000'])
    assert.equal(
      JSON.stringify(row, (_key, value) =>
        typeof value === 'bigint' ? value.toString() : value,
      ).includes(field),
      false,
    );
  const updated = await call<{ version: number }>('/consumer/addresses');
  await f.call(`/consumer/addresses/${added.data.id}/delete`, { version: updated.data.version });
  assert.equal((await call('/consumer/orders/' + id)).data.address.room, '合成独立门牌');
  const snapshot = (await call('/consumer/orders/' + id)).data.address;
  assert.equal(snapshot.note, '合成门口位置');
  assert.equal(snapshot.orderNote, '合成订单备注');
  await assert.rejects(() =>
    f.runtime.db.consumerOrder.update({ where: { id }, data: { addressPayload: 'bad' } }),
  );
  const other = await f.call('/consumer/auth/dev-session', { profile: 'customer-b' }, '');
  assert.equal((await cancel(id, other.data.token)).status, 404);
  assert.equal((await call('/consumer/orders/' + id, undefined, other.data.token)).status, 404);
  const rs = await Promise.all([cancel(id), cancel(id)]);
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal((await call('/consumer/orders/' + id)).data.status, 'CANCELED');
  await verifyInventory();
});
test('parallel timeout workers release once with system audit and no physical stock movement', async () => {
  const q = await quote(),
    r = await create(q.id);
  assert.equal(r.status, 200);
  const before = await f.runtime.db.stockLedger.count();
  await new Promise((resolve) => setTimeout(resolve, 3200));
  const jobs = await Promise.all([
    expireUnpaidOrders(f.runtime.db),
    expireUnpaidOrders(f.runtime.db),
  ]);
  assert.equal(jobs[0] + jobs[1], 1);
  assert.equal(await f.runtime.db.stockLedger.count(), before + 2);
  const order = (await call('/consumer/orders/' + r.data.id)).data;
  assert.equal(order.cancelReason, 'PAYMENT_TIMEOUT');
  assert.equal(order.paymentState, 'NOT_STARTED');
  const ledgers = await f.runtime.db.stockLedger.findMany({ where: { actorKind: 'SYSTEM' } });
  assert.ok(ledgers.length >= 2);
  assert.ok(ledgers.every((l) => l.actorId === null && l.consumerActorId === null));
  await cancel(r.data.id);
  await verifyInventory();
});
test('FEFO picks a real earlier-expiry receipt before non-expiring stock', async () => {
  const staff = await f.runtime.db.staff.findMany({
      where: { loginName: { startsWith: 'cart-fixture-' } },
      orderBy: { loginName: 'asc' },
    }),
    service = new CatalogService(f.runtime.db, f.warehouseId);
  const req = (i: number): ApiRequest => ({
    method: 'POST',
    headers: {},
    socket: {},
    requestId: randomUUID(),
    staffContext: {
      sessionId: randomUUID(),
      staffId: staff[i]!.id,
      loginName: 'fixture',
      displayName: 'fixture',
      roles: ['SUPER_ADMIN'],
      permissions: [],
      warehouseIds: [f.warehouseId],
      csrfToken: '',
    },
  });
  const sourceRef = randomUUID();
  await service.createReceipt(req(0), randomUUID(), f.warehouseId, {
    sourceRef,
    lines: [
      {
        skuId: f.catalog.skuIds[0]!,
        batchNo: 'EARLY-EXPIRY',
        quantity: 1,
        unitCostCents: 100,
        producedAt: new Date(Date.now() - 86400000).toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      },
    ],
  });
  const receipt = await f.runtime.db.inboundReceipt.findFirstOrThrow({ where: { sourceRef } });
  await service.receiptAction(req(1), randomUUID(), f.warehouseId, receipt.id, 0, false);
  await service.receiptAction(req(0), randomUUID(), f.warehouseId, receipt.id, 1, true);
  const lot = await f.runtime.db.stockLot.findFirstOrThrow({ where: { batchNo: 'EARLY-EXPIRY' } }),
    q = await quote(),
    created = await create(q.id);
  assert.equal(created.status, 200);
  const allocation = await f.runtime.db.orderAllocation.findFirstOrThrow({
    where: { orderId: created.data.id, lotId: lot.id },
  });
  assert.equal(allocation.quantity, 1);
  await assert.rejects(() => f.runtime.db.orderAllocation.delete({ where: { id: allocation.id } }));
  await cancel(created.data.id);
  await verifyInventory();
});

test('two consumers racing for the last units cannot bypass the global balance lock', async () => {
  const other = await f.call('/consumer/auth/dev-session', { profile: 'customer-b' }, ''),
    token = other.data.token;
  const book = await call<{ version: number; items: Array<{ id: string }> }>(
    '/consumer/addresses',
    undefined,
    token,
  );
  let addressId = book.data.items[0]?.id;
  if (!addressId) {
    const added = await f.call(
      '/consumer/addresses',
      {
        version: book.data.version,
        areaId: f.areaId,
        buildingId: f.buildingId,
        unit: '',
        room: '合成B门牌',
        contactName: '合成B联系人',
        phone: '00000000000',
        note: '',
        isDefault: true,
      },
      token,
    );
    assert.equal(added.status, 200);
    addressId = added.data.id;
  }
  const cart = await call<{ version: number; items: Array<{ skuId: string; quantity: number }> }>(
    '/consumer/cart',
    undefined,
    token,
  );
  for (let i = 0; i < 4; i++) {
    const added = await f.call(
      '/consumer/cart/items',
      { version: cart.data.version + i, skuId: f.catalog.skuIds[0] },
      token,
    );
    assert.equal(added.status, 200);
  }
  // FEFO test added one physical unit, so consume a five-unit competitor against a two-unit order (total seven > six).
  const added = await f.call(
    '/consumer/cart/items',
    { version: cart.data.version + 4, skuId: f.catalog.skuIds[0] },
    token,
  );
  assert.equal(added.status, 200);
  const a = await quote(),
    b = await quote(addressId, token);
  const results = await Promise.all([create(a.id), create(b.id, randomUUID(), token)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const balance = await f.runtime.db.stockBalance.findUniqueOrThrow({
    where: { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.catalog.skuIds[0]! } },
  });
  assert.ok(balance.reserved <= balance.onHand);
  if (results[0]!.status === 200) await cancel(results[0]!.data.id);
  if (results[1]!.status === 200) await cancel(results[1]!.data.id, token);
  await verifyInventory();
});
test('consumer cancellation races timeout safely and a payment-started state is never eligible for direct release', async () => {
  const q = await quote(),
    created = await create(q.id);
  assert.equal(created.status, 200);
  const row = await f.runtime.db.consumerOrder.findUniqueOrThrow({
    where: { id: created.data.id },
  });
  await assert.rejects(() =>
    f.runtime.db.$transaction((tx) =>
      releaseUnpaidOrder(tx, { ...row, paymentState: 'PENDING' }, 'PAYMENT_TIMEOUT', randomUUID()),
    ),
  );
  const count = await f.runtime.db.stockLedger.count();
  const allocations = await f.runtime.db.orderAllocation.count({ where: { orderId: row.id } });
  await new Promise((r) => setTimeout(r, 3200));
  await Promise.all([cancel(row.id), expireUnpaidOrders(f.runtime.db)]);
  assert.equal(await f.runtime.db.stockLedger.count(), count + allocations);
  assert.equal((await call('/consumer/orders/' + row.id)).data.status, 'CANCELED');
  await verifyInventory();
});
