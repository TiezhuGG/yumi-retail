import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { checkoutFixture } from './helpers/checkout-fixture.ts';
import type {
  CheckoutPreview,
  CheckoutQuote,
  CheckoutPolicy,
  StaffProfile,
} from '../packages/contracts/src/index.ts';
let f: Awaited<ReturnType<typeof checkoutFixture>>,
  body: { addressId: string; addressVersion: number; cartVersion: number };
const sessions: Array<{ cookie: string; csrf: string }> = [];
async function call<T = CheckoutPreview>(
  path: string,
  input?: unknown,
  token = f.identity.token,
  key = randomUUID(),
  headers: Record<string, string> = {},
) {
  const r = await fetch(f.base + '/api/v1' + path, {
    method: input === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + token,
      'Idempotency-Key': key,
      ...headers,
    },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  return { status: r.status, ...((await r.json()) as { data: T; error?: { code: string } }) };
}
async function admin<T = { policy: CheckoutPolicy }>(
  input?: unknown,
  actor = 0,
  key = randomUUID(),
  extra: Record<string, string> = {},
) {
  return call<T>('/admin/checkout-policy', input, '', key, {
    Cookie: sessions[actor]!.cookie,
    Origin: 'http://127.0.0.1:5173',
    'X-CSRF-Token': sessions[actor]!.csrf,
    ...extra,
  });
}
const check = () => call('/consumer/checkout/preview', body);
const quote = (key = randomUUID()) =>
  call<CheckoutQuote>('/consumer/checkout/quotes', body, f.identity.token, key);
async function policy(values: Partial<CheckoutPolicy> = {}) {
  const old = (await admin()).data.policy;
  const r = await admin({
    ...(old ?? {
      version: null,
      deliveryFeeCents: 300,
      minGoodsCents: 0,
      freeDeliveryThresholdCents: null,
      open: false,
    }),
    ...values,
  });
  assert.equal(r.status, 200, JSON.stringify(r));
  return r.data.policy;
}
before(async () => {
  f = await checkoutFixture();
  body = { addressId: f.addressId, addressVersion: 1, cartVersion: 3 };
  for (let i = 0; i < 3; i++) {
    const r = await fetch(f.base + '/api/v1/staff/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
      body: JSON.stringify({ loginName: 'quote-ui-' + i, password: f.password }),
    });
    assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie')!.split(';')[0]!;
    const me = await call<StaffProfile>('/staff/me', undefined, '', randomUUID(), {
      Cookie: cookie,
    });
    sessions.push({ cookie, csrf: me.data.csrfToken });
  }
});
after(async () => {
  if (f) await f.cleanup();
});
test('scope, CSRF, strict input and owner checks apply to policy and checkout', async () => {
  assert.equal((await call('/consumer/checkout/preview', body, '')).status, 401);
  assert.equal((await admin(undefined, 1)).status, 403);
  assert.equal((await admin(undefined, 2)).status, 403);
  assert.equal(
    (
      await admin(
        {
          version: null,
          deliveryFeeCents: 300,
          minGoodsCents: 0,
          freeDeliveryThresholdCents: null,
          open: false,
        },
        0,
        randomUUID(),
        { 'X-CSRF-Token': '' },
      )
    ).status,
    403,
  );
  for (const change of [
    { userId: randomUUID() },
    { payableCents: 1 },
    { items: [] },
    { addressId: 'bad' },
    { cartVersion: -1 },
  ])
    assert.equal((await call('/consumer/checkout/preview', { ...body, ...change })).status, 400);
  assert.equal(
    (await call('/consumer/checkout/preview', { ...body, addressId: randomUUID() })).status,
    404,
  );
  assert.equal(
    (await call('/consumer/checkout/preview', { ...body, addressVersion: 0 })).status,
    409,
  );
  assert.equal((await call('/consumer/checkout/preview', { ...body, cartVersion: 0 })).status, 409);
  assert.equal((await call('/store?warehouseId=' + f.warehouseId)).status, 400);
});
test('unconfigured rules show blockers and null payable, never a fabricated zero shipping fee', async () => {
  const r = await check();
  assert.equal(r.status, 200);
  assert.equal(r.data.goodsCents, 2199);
  assert.equal(r.data.ready, false);
  assert.equal(r.data.deliveryFeeCents, null);
  assert.equal(r.data.payableCents, null);
  assert.ok(r.data.issues.some((i) => i.code === 'POLICY_UNCONFIGURED'));
  assert.equal((await quote()).status, 409);
  assert.equal(await f.runtime.db.checkoutQuote.count(), 0);
});
test('new policy must be paused; version/idempotency and public status are enforced', async () => {
  const p = {
    version: null,
    deliveryFeeCents: 300,
    minGoodsCents: 0,
    freeDeliveryThresholdCents: null,
    open: false,
  };
  assert.equal((await admin({ ...p, open: true })).status, 400);
  assert.equal((await admin({ ...p, deliveryFeeCents: 1.2 })).status, 400);
  const key = randomUUID(),
    r = await admin(p, 0, key);
  assert.equal(r.status, 200);
  assert.deepEqual((await admin(p, 0, key)).data, r.data);
  assert.equal((await admin({ ...p, minGoodsCents: 1 }, 0, key)).status, 409);
  assert.equal((await admin(p)).status, 409);
  assert.ok((await check()).data.issues.some((i) => i.code === 'STORE_PAUSED'));
  assert.equal((await call<{ status: string }>('/store')).data.status, 'PAUSED');
});
test('integer-cent calculation, minimum and exact free-shipping threshold are server authoritative', async () => {
  await policy({ open: true, minGoodsCents: 2200 });
  let r = await check();
  assert.equal(r.data.payableCents, null);
  assert.ok(r.data.issues.some((i) => i.code === 'BELOW_MINIMUM'));
  await policy({ open: true, minGoodsCents: 2199, freeDeliveryThresholdCents: 2200 });
  r = await check();
  assert.equal(r.data.goodsCents, 2199);
  assert.equal(r.data.deliveryFeeCents, 300);
  assert.equal(r.data.payableCents, 2499);
  assert.equal(r.data.lines[0]!.lineCents! + r.data.lines[1]!.lineCents!, 2199);
  await policy({ open: true, minGoodsCents: 2199, freeDeliveryThresholdCents: 2199 });
  assert.equal((await check()).data.payableCents, 2199);
  await policy({ open: true, minGoodsCents: 0, freeDeliveryThresholdCents: null });
});
test('concurrent same-key quotes replay one immutable snapshot; current price/policy changes need a new quote', async () => {
  const before = await f.runtime.db.stockBalance.findMany(),
    ledger = await f.runtime.db.stockLedger.count(),
    key = randomUUID();
  const rs = await Promise.all([quote(key), quote(key)]);
  assert.equal(rs[0]!.status, 200);
  assert.equal(rs[1]!.status, 200);
  assert.deepEqual(rs[0]!.data, rs[1]!.data);
  assert.equal(await f.runtime.db.checkoutQuote.count(), 1);
  assert.equal(Date.parse(rs[0]!.data.expiresAt) - Date.parse(rs[0]!.data.createdAt), 120000);
  const old = rs[0]!.data;
  await f.runtime.db.sku.update({ where: { id: f.catalog.skuIds[0]! }, data: { priceCents: 451 } });
  await policy({ open: true, deliveryFeeCents: 301 });
  assert.deepEqual((await quote(key)).data, old);
  assert.equal((await check()).data.payableCents, 2502);
  const fresh = await quote();
  assert.equal(fresh.data.preview.payableCents, 2502);
  assert.notEqual(fresh.data.id, old.id);
  assert.deepEqual(await f.runtime.db.stockBalance.findMany(), before);
  assert.equal(await f.runtime.db.stockLedger.count(), ledger);
  const stored = JSON.stringify(await f.runtime.db.checkoutQuote.findMany());
  for (const secret of ['00000000000', '合成验收联系人', '合成门牌101'])
    assert.equal(stored.includes(secret), false);
  assert.equal(
    (await call('/consumer/checkout/quotes', { ...body, addressVersion: 0 }, f.identity.token, key))
      .status,
    409,
  );
});
test('disabled/expired stock, safety/holds, hidden goods and quantity excess are never silently priced as ready', async () => {
  const skuId = f.catalog.skuIds[0]!,
    where = { warehouseId_skuId: { warehouseId: f.warehouseId, skuId } };
  await f.runtime.db.stockBalance.update({ where, data: { inventoryHold: true } });
  let r = await check();
  assert.ok(r.data.lines.some((i) => i.status === 'EXCESS'));
  assert.equal(r.data.goodsCents, null);
  assert.equal((await quote()).status, 409);
  await f.runtime.db.stockBalance.update({ where, data: { inventoryHold: false } });
  await f.runtime.db.stockBalance.update({ where, data: { safety: 4 } });
  assert.ok((await check()).data.lines.some((i) => i.status === 'EXCESS'));
  await f.runtime.db.stockBalance.update({ where, data: { safety: 0 } });
  const lot = await f.runtime.db.stockLot.findFirstOrThrow({ where: { skuId } });
  await f.runtime.db.stockLot.update({
    where: { id: lot.id },
    data: { producedAt: new Date(0), expiresAt: new Date(86400000) },
  });
  assert.ok((await check()).data.lines.some((i) => i.status === 'EXCESS'));
  await f.runtime.db.stockLot.update({
    where: { id: lot.id },
    data: { producedAt: null, expiresAt: null },
  });
  await f.runtime.db.category.update({
    where: { id: f.catalog.categoryId },
    data: { enabled: false },
  });
  r = await check();
  assert.ok(r.data.lines.every((i) => i.status === 'UNAVAILABLE'));
  assert.ok(r.data.lines.every((i) => i.priceCents === null));
  await f.runtime.db.category.update({
    where: { id: f.catalog.categoryId },
    data: { enabled: true },
  });
});
test('address/range/cart changes block new quotes and deleted address cannot be reused', async () => {
  await f.runtime.db.serviceBuilding.update({
    where: { id: f.buildingId },
    data: { enabled: false },
  });
  assert.ok((await check()).data.issues.some((i) => i.code === 'ADDRESS_OUT_OF_RANGE'));
  assert.equal((await quote()).status, 409);
  await f.runtime.db.serviceBuilding.update({
    where: { id: f.buildingId },
    data: { enabled: true },
  });
  await f.runtime.db.consumerCartItem.updateMany({
    where: { userId: f.identity.user.id },
    data: { selected: false },
  });
  assert.ok((await check()).data.issues.some((i) => i.code === 'EMPTY_SELECTION'));
  await f.runtime.db.consumerCartItem.updateMany({
    where: { userId: f.identity.user.id },
    data: { selected: true },
  });
  const other = await f.call('/consumer/auth/dev-session', { profile: 'customer-b' }, '');
  assert.equal(other.status, 200);
  assert.equal((await call('/consumer/checkout/preview', body, other.data.token)).status, 404);
  const saved = await f.runtime.db.checkoutQuote.findFirstOrThrow();
  assert.equal(
    (await call('/consumer/checkout/quotes/' + saved.id, undefined, other.data.token)).status,
    404,
  );
  const added = await f.call('/consumer/addresses', {
    version: 1,
    areaId: f.areaId,
    buildingId: f.buildingId,
    unit: '',
    room: '合成待删除地址',
    contactName: '合成联系人',
    phone: '00000000000',
    note: '',
    isDefault: false,
  });
  assert.equal(added.status, 200);
  body.addressVersion = 2;
  const removed = await f.call(`/consumer/addresses/${added.data.id}/delete`, { version: 2 });
  assert.equal(removed.status, 200);
  body.addressVersion = 3;
  assert.equal(
    (await call('/consumer/checkout/preview', { ...body, addressId: added.data.id })).status,
    404,
  );
});
test('expiry is explicit and historical replay never extends a quote; SQL failure leaves no receipt', async () => {
  const key = randomUUID(),
    r = await quote(key);
  assert.equal(r.status, 200);
  await f.runtime.db.checkoutQuote.update({
    where: { id: r.data.id },
    data: { createdAt: new Date(Date.now() - 300000), expiresAt: new Date(Date.now() - 1000) },
  });
  const replay = await quote(key);
  assert.equal(replay.data.expired, true);
  assert.ok(Date.parse(replay.data.expiresAt) < Date.now());
  assert.equal(
    (await call<CheckoutQuote>('/consumer/checkout/quotes/' + r.data.id)).data.expired,
    true,
  );
  await f.runtime.db.$executeRawUnsafe(
    `CREATE FUNCTION fail_quote() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$`,
  );
  await f.runtime.db.$executeRawUnsafe(
    'CREATE TRIGGER fail_quote BEFORE INSERT ON checkout_quotes FOR EACH ROW EXECUTE FUNCTION fail_quote()',
  );
  const count = await f.runtime.db.checkoutQuote.count();
  try {
    assert.equal((await quote()).status, 500);
  } finally {
    await f.runtime.db.$executeRawUnsafe('DROP TRIGGER fail_quote ON checkout_quotes');
    await f.runtime.db.$executeRawUnsafe('DROP FUNCTION fail_quote()');
  }
  assert.equal(await f.runtime.db.checkoutQuote.count(), count);
});

test('lot expiry is checked after a quote waits for policy locks, rather than at transaction start', async () => {
  const skuId = f.catalog.skuIds[0]!,
    lot = await f.runtime.db.stockLot.findFirstOrThrow({ where: { skuId } });
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  const holder = f.runtime.db.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT warehouse_id FROM checkout_policies WHERE warehouse_id=${f.warehouseId}::uuid FOR UPDATE`;
      entered();
      await gate;
    },
    { timeout: 10000 },
  );
  await ready;
  const expiresAt = new Date(Date.now() + 1800);
  await f.runtime.db.stockLot.update({
    where: { id: lot.id },
    data: { producedAt: new Date(Date.now() - 10000), expiresAt },
  });
  const pending = check();
  let blocked = false;
  try {
    for (let i = 0; i < 40; i++) {
      const rows = await f.runtime.db.$queryRaw<
        Array<{ count: bigint }>
      >`SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock' AND query LIKE '%checkout_policies%' AND query LIKE '%FOR SHARE%'`;
      if (Number(rows[0]?.count) > 0) {
        blocked = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(blocked, true);
    assert.ok(Date.now() < expiresAt.getTime());
    await new Promise((r) => setTimeout(r, Math.max(0, expiresAt.getTime() - Date.now() + 100)));
    release();
    await holder;
    const result = await pending;
    assert.ok(result.data.lines.some((i) => i.skuId === skuId && i.status === 'EXCESS'));
    assert.equal(result.data.payableCents, null);
  } finally {
    release();
    await holder;
    await f.runtime.db.stockLot.update({
      where: { id: lot.id },
      data: { producedAt: null, expiresAt: null },
    });
  }
});
