// Public local API smoke check. Does not simulate WeChat runtime or a device.
import assert from 'node:assert/strict';
const base = new URL(process.env.YUMI_MINI_API_URL || 'http://127.0.0.1:3000/api/v1/');
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(base.hostname))
  throw Error('Only a local HTTP API is allowed');
if (!base.pathname.endsWith('/')) base.pathname += '/';
async function read(path, expected = 200) {
  const response = await fetch(new URL(path, base), {
    signal: globalThis.AbortSignal.timeout(10000),
  });
  assert.equal(response.status, expected, `Unexpected status for ${path}`);
  return (await response.json()).data;
}
const first = await read('products?limit=1');
assert(first.items.length, 'Seed published synthetic goods before this check');
const sku = first.items[0];
assert.equal(typeof sku.name, 'string');
assert(Number.isSafeInteger(sku.priceCents) && sku.priceCents > 0);
assert(Number.isSafeInteger(sku.available) && sku.available >= 0);
assert.equal('unitCostCents' in sku, false);
const detail = await read(`products/${encodeURIComponent(sku.id)}`);
assert.deepEqual(detail, sku);
if (first.nextCursor) {
  const next = await read(`products?limit=1&cursor=${encodeURIComponent(first.nextCursor)}`);
  assert(next.items.every((r) => r.id !== sku.id));
}
const search = await read(`products?limit=20&keyword=${encodeURIComponent(sku.name)}`);
assert(search.items.some((r) => r.id === sku.id));
const empty = await read(
  `products?limit=20&keyword=${encodeURIComponent('UI验收不存在商品_9d38c1')}`,
);
assert.equal(empty.items.length, 0);
await read('products/not-a-uuid', 400);
await read('products/00000000-0000-4000-8000-000000000000', 404);
console.log(
  'Local public mini API passed: list/detail consistency, integer price/availability, cursor, keyword/empty, invalid/missing SKU. No writes. This is not WeChat runtime acceptance.',
);
