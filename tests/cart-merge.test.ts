import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  createCartMerge,
  readMergeIntent,
  assertGuestWritable,
  CartRequestError,
} from '../apps/consumer-mini/src/cart-merge.ts';
const user = randomUUID(),
  row = {
    skuId: randomUUID(),
    quantity: 2,
    selected: false,
    name: '草稿纸巾',
    spec: '包',
    unit: '包',
  };
function fixture() {
  let raw: unknown = { version: 1, items: [{ ...row }] };
  let fail = false;
  let sender = async (_v: unknown): Promise<unknown> => ({});
  const calls: unknown[] = [];
  const store = createCartMerge({
    read: () => structuredClone(raw),
    write: (v) => {
      if (fail) throw Error('保存失败');
      raw = structuredClone(v);
    },
    newKey: () => randomUUID(),
    send: async (v) => {
      calls.push(v);
      return sender(v);
    },
  });
  return {
    store,
    calls,
    get raw() {
      return raw;
    },
    set raw(v: unknown) {
      raw = v;
    },
    set fail(v: boolean) {
      fail = v;
    },
    set sender(v: (intent: unknown) => Promise<unknown>) {
      sender = v;
    },
  };
}
test('persists intent before sending and clears guest only after acknowledged commit', async () => {
  const f = fixture();
  f.sender = async () => {
    assert.ok(readMergeIntent(f.raw));
    return {};
  };
  await f.store.merge(user);
  assert.deepEqual(f.raw, { version: 1, items: [] });
  assert.equal(f.calls.length, 1);
});
test('unknown result and app restart preserve original intent/key and frozen quantity', async () => {
  const f = fixture();
  f.sender = async () => {
    throw Error('timeout');
  };
  await assert.rejects(f.store.merge(user));
  const pending = readMergeIntent(f.raw)!;
  assert.equal(pending.userId, user);
  assert.deepEqual(pending.items, [row]);
  assert.throws(() => assertGuestWritable(f.raw));
  f.sender = async () => ({});
  await f.store.merge(user);
  assert.deepEqual(f.calls[0], f.calls[1]);
});
test('pending owner cannot change on account switch and no request is sent', async () => {
  const f = fixture();
  f.sender = async () => {
    throw Error('unknown');
  };
  await assert.rejects(f.store.merge(user));
  const before = structuredClone(f.raw);
  await assert.rejects(f.store.merge(randomUUID()));
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.raw, before);
});
test('initial storage failure sends no request', async () => {
  const f = fixture();
  f.fail = true;
  await assert.rejects(f.store.merge(user));
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.raw, { version: 1, items: [row] });
});
test('storage failure after commit replays same key without double add', async () => {
  const f = fixture();
  const keys = new Set();
  let added = 0;
  f.sender = async (v) => {
    const key = (v as { key: string }).key;
    if (!keys.has(key)) {
      added += row.quantity;
      keys.add(key);
    }
    f.fail = true;
    return {};
  };
  await assert.rejects(f.store.merge(user));
  f.fail = false;
  f.sender = async (v) => {
    const key = (v as { key: string }).key;
    if (!keys.has(key)) {
      added += row.quantity;
      keys.add(key);
    }
    return {};
  };
  await f.store.merge(user);
  assert.equal(added, 2);
  assert.deepEqual(f.raw, { version: 1, items: [] });
});
test('authoritative limit rejection unlocks original draft; 401/unknown preserves intent', async () => {
  const f = fixture();
  f.sender = async () => {
    throw new CartRequestError(409, 'CART_LIMIT_EXCEEDED', 'limit');
  };
  await assert.rejects(f.store.merge(user));
  assert.equal(readMergeIntent(f.raw), null);
  assert.deepEqual(f.raw, { version: 1, items: [row] });
  f.sender = async () => {
    throw new CartRequestError(401, 'SESSION_EXPIRED', 'expired');
  };
  await assert.rejects(f.store.merge(user));
  assert.ok(readMergeIntent(f.raw));
});
test('external/corrupt modifications preserve data and prevent destructive clear', async () => {
  const f = fixture();
  f.sender = async () => {
    const value = f.raw as { items: (typeof row)[] };
    value.items[0]!.quantity = 3;
    f.raw = value;
    return {};
  };
  await assert.rejects(f.store.merge(user));
  assert.equal((f.raw as { items: (typeof row)[] }).items[0]!.quantity, 3);
  assert.throws(() => readMergeIntent(f.raw));
  assert.throws(() => assertGuestWritable({ version: 1, items: [row], merge: { key: 'bad' } }));
});
test('duplicate clicks cannot send another merge while first is in flight', async () => {
  const f = fixture();
  let resolve!: (v: unknown) => void;
  f.sender = () =>
    new Promise((r) => {
      resolve = r;
    });
  const first = f.store.merge(user);
  await assert.rejects(f.store.merge(user));
  assert.equal(f.calls.length, 1);
  resolve({});
  await first;
});
