import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  createGuestCart,
  parseCart,
  cartSummary,
  checkCart,
} from '../apps/consumer-mini/src/guest-cart.ts';
import type { CartCheck, CartDraft } from '../apps/consumer-mini/src/guest-cart.ts';
import type { SaleSku } from '../apps/consumer-mini/src/api.ts';
const sku = (id: string = randomUUID(), priceCents = 450, available = 3): SaleSku => ({
  id,
  productId: randomUUID(),
  name: '合成商品',
  description: '',
  spec: '3包装',
  unit: '组',
  priceCents,
  available,
});
function repository() {
  let raw: unknown = '';
  let fail = false;
  let writes = 0;
  const store = createGuestCart({
    read: () => structuredClone(raw),
    write: (v) => {
      if (fail) throw Error('synthetic disk full');
      raw = structuredClone(v);
      writes++;
    },
  });
  return {
    store,
    get raw() {
      return raw;
    },
    set raw(v: unknown) {
      raw = v;
    },
    set fail(v: boolean) {
      fail = v;
    },
    get writes() {
      return writes;
    },
  };
}
test('same SKU adds latest quantity without storing price/stock; different variants remain separate and unchecked stays unchecked', () => {
  const r = repository(),
    a = sku(),
    b = sku();
  r.store.add(a);
  r.store.toggle(a.id);
  r.store.add({ ...a, name: '新名称', priceCents: 999 });
  r.store.add(b);
  const items = r.store.read().items;
  assert.equal(items.length, 2);
  assert.equal(items[0]!.quantity, 2);
  assert.equal(items[0]!.selected, false);
  assert.equal(items[0]!.name, '新名称');
  assert(!JSON.stringify(r.raw).includes('priceCents'));
  assert(!JSON.stringify(r.raw).includes('available'));
  r.store.adjust(a.id, 1);
  r.store.adjust(a.id, 1);
  assert.equal(r.store.read().items[0]!.quantity, 4);
  assert.equal(
    createGuestCart({ read: () => r.raw, write: () => {} }).read().items[0]!.quantity,
    4,
  );
});
test('corrupt/unsupported/duplicate storage is preserved until explicit reset', () => {
  const r = repository(),
    a = sku();
  r.store.add(a);
  const valid = r.store.read();
  for (const raw of [
    { version: 2, items: [] },
    { version: 1, items: [...valid.items, ...valid.items] },
    { version: 1, items: [{ ...valid.items[0], quantity: 0 }] },
    'bad',
    { version: 1, items: [{ ...valid.items[0], skuId: 'bad' }] },
  ]) {
    r.raw = raw;
    const writes = r.writes;
    assert.throws(() => r.store.read());
    assert.throws(() => r.store.add(a));
    assert.equal(r.writes, writes);
    assert.deepEqual(r.raw, raw);
  }
  r.store.reset();
  assert.deepEqual(r.store.read(), { version: 1, items: [] });
});
test('write failure never claims changed draft and retry applies once', () => {
  const r = repository(),
    a = sku();
  r.store.add(a);
  const before = r.raw;
  r.fail = true;
  assert.throws(() => r.store.add(a));
  assert.deepEqual(r.raw, before);
  assert.throws(() => r.store.remove(a.id));
  assert.deepEqual(r.raw, before);
  r.fail = false;
  r.store.add(a);
  assert.equal(r.store.read().items[0]!.quantity, 2);
});
test('integer 50-SKU/200-unit limits reject without clamping or dropping lines', () => {
  const r = repository(),
    a = sku();
  r.store.add(a);
  r.store.quantity(a.id, 200);
  assert.throws(() => r.store.add(a));
  assert.equal(r.store.read().items[0]!.quantity, 200);
  for (const n of [0, -1, 1.5, NaN, Infinity, 201]) assert.throws(() => r.store.quantity(a.id, n));
  assert.throws(() => r.store.add(sku()));
  r.store.reset();
  for (let i = 0; i < 50; i++) r.store.add(sku());
  assert.throws(() => r.store.add(sku()));
  assert.equal(r.store.read().items.length, 50);
  assert.throws(() => r.store.add(sku(undefined, 100, 0)));
  assert.throws(() => r.store.adjust(a.id, 0));
});
test('summary includes only checked, verified, sufficient-stock lines with current integer-cent price', () => {
  const r = repository(),
    a = sku(undefined, 451, 3),
    b = sku(),
    c = sku(),
    d = sku(),
    e = sku();
  for (const s of [a, b, c, d, e]) r.store.add(s);
  r.store.quantity(a.id, 2);
  r.store.toggle(e.id);
  const checks: Record<string, CartCheck> = {
    [a.id]: { status: 'ready', sku: a },
    [b.id]: { status: 'gone', message: 'gone' },
    [c.id]: { status: 'unknown', message: 'offline' },
    [d.id]: { status: 'ready', sku: { ...d, available: 0 } },
    [e.id]: { status: 'ready', sku: e },
  };
  assert.deepEqual(cartSummary(r.store.read().items, checks), {
    totalCents: 902,
    units: 2,
    excluded: 3,
  });
  checks[a.id] = { status: 'ready', sku: { ...a, priceCents: 499 } };
  assert.equal(cartSummary(r.store.read().items, checks).totalCents, 998);
  checks[a.id] = { status: 'ready', sku: { ...a, available: 1 } };
  assert.equal(cartSummary(r.store.read().items, checks).totalCents, 0);
});
test('unverified and insufficient quantities remain in draft; selection/removal use SKU identity', () => {
  const r = repository(),
    a = sku(),
    b = sku();
  r.store.add(a);
  r.store.add(b);
  r.store.quantity(a.id, 5);
  assert.equal(cartSummary(r.store.read().items, {}).excluded, 2);
  assert.equal(r.store.read().items[0]!.quantity, 5);
  r.store.select([a.id], false);
  assert.equal(r.store.read().items[1]!.selected, true);
  r.store.remove(a.id);
  assert.equal(r.store.read().items[0]!.skuId, b.id);
});
test('checking separates 404 unavailable from transient errors and rejects mismatched/invalid catalog data', async () => {
  const r = repository(),
    rows = Array.from({ length: 5 }, () => sku());
  for (const s of rows) r.store.add(s);
  let result: Record<string, CartCheck> = {};
  await checkCart(
    r.store.read().items,
    async (id) => {
      const i = rows.findIndex((s) => s.id === id);
      if (i === 0) throw { status: 404 };
      if (i === 1) throw { status: 503 };
      if (i === 2) return { ...rows[i]!, priceCents: -1 };
      if (i === 3) return { ...rows[i]!, id: randomUUID() };
      return rows[i]!;
    },
    (e) => !!e && typeof e === 'object' && 'status' in e && e.status === 404,
    (next) => {
      result = next;
    },
    () => false,
  );
  assert.equal(result[rows[0]!.id]!.status, 'gone');
  for (const i of [1, 2, 3]) assert.equal(result[rows[i]!.id]!.status, 'unknown');
  assert.equal(result[rows[4]!.id]!.status, 'ready');
});
test('checking concurrency is at most four; cancelled batches never publish or start the next batch', async () => {
  const r = repository();
  for (let i = 0; i < 9; i++) r.store.add(sku());
  let active = 0,
    max = 0,
    published = 0,
    cancel = false;
  const finish: (() => void)[] = [];
  const pending = checkCart(
    r.store.read().items,
    async (id) => {
      active++;
      max = Math.max(max, active);
      await new Promise<void>((resolve) => finish.push(resolve));
      active--;
      return sku(id);
    },
    () => false,
    () => {
      published++;
    },
    () => cancel,
  );
  assert.equal(finish.length, 4);
  assert.equal(max, 4);
  cancel = true;
  for (const resolve of finish) resolve();
  await pending;
  assert.equal(published, 0);
  assert.equal(finish.length, 4);
});
test('missing draft is empty, read errors and unsupported metadata never silently discard a draft', () => {
  assert.deepEqual(parseCart(''), { version: 1, items: [] });
  assert.throws(() =>
    createGuestCart({
      read: () => {
        throw Error('read failure');
      },
      write: () => {},
    }).read(),
  );
  const bad: CartDraft = {
    version: 1,
    items: [
      {
        skuId: randomUUID(),
        quantity: 1,
        selected: true,
        name: 'x'.repeat(121),
        spec: '1包',
        unit: '包',
      },
    ],
  };
  assert.throws(() => parseCart(bad));
});
