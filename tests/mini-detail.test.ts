import assert from 'node:assert/strict';
import test from 'node:test';
import { createDetailLoader, initialDetailState } from '../apps/consumer-mini/src/detail-loader.ts';
import type { DetailState } from '../apps/consumer-mini/src/detail-loader.ts';
import type { SaleSkuDetail } from '../apps/consumer-mini/src/api.ts';
const detail = (id: string) =>
  ({
    id,
    productId: 'p1',
    priceCents: id === 'a' ? 450 : 1299,
    available: id === 'a' ? 3 : 0,
    variants: [
      { id: 'a', productId: 'p1' },
      { id: 'b', productId: 'p1' },
    ],
  }) as SaleSkuDetail;
test('variant switch clears the previous price/stock and retry belongs to the exact failed SKU', async () => {
  let state: DetailState = initialDetailState,
    fail = false;
  const paths: string[] = [];
  const loader = createDetailLoader(
    async (path) => {
      paths.push(path);
      if (fail) throw Error('合成断网');
      return detail(path.split('/').at(-1)!);
    },
    (s) => {
      state = s;
    },
  );
  await loader.load('a');
  assert.equal(state.detail!.priceCents, 450);
  fail = true;
  const attempt = loader.load('b');
  assert.equal(state.detail, null);
  assert.equal(state.busy, true);
  await attempt;
  assert.equal(state.id, 'b');
  assert.equal(state.detail, null);
  assert.equal(state.error, '合成断网');
  fail = false;
  await loader.retry();
  assert.equal(paths[1], paths[2]);
  assert.equal(state.detail!.id, 'b');
  assert.equal(state.detail!.priceCents, 1299);
  assert.equal(state.detail!.available, 0);
});
test('late success and failure cannot replace a newer SKU or a cancelled page', async () => {
  let state: DetailState = initialDetailState;
  let complete!: (row: SaleSkuDetail) => void, reject!: (error: Error) => void;
  const loader = createDetailLoader(
    (path) =>
      path.endsWith('/a')
        ? new Promise((r, j) => {
            complete = r;
            reject = j;
          })
        : Promise.resolve(detail('b')),
    (s) => {
      state = s;
    },
  );
  let first = loader.load('a');
  await loader.load('b');
  complete(detail('a'));
  await first;
  assert.equal(state.detail!.id, 'b');
  first = loader.load('a');
  await loader.load('b');
  reject(Error('late'));
  await first;
  assert.equal(state.detail!.id, 'b');
  assert.equal(state.error, '');
  first = loader.load('a');
  loader.cancel();
  complete(detail('a'));
  await first;
  assert.equal(state.detail, null);
});
test('missing SKU never requests and path encodes the selected identity', async () => {
  let state: DetailState = initialDetailState;
  const paths: string[] = [];
  const loader = createDetailLoader(
    async (path) => {
      paths.push(path);
      return detail('a/b?');
    },
    (s) => {
      state = s;
    },
  );
  await loader.load('');
  assert.equal(paths.length, 0);
  assert(state.error);
  await loader.load('a/b?');
  assert.equal(paths[0], '/products/a%2Fb%3F');
});
test('mismatched selected identity, empty variants and another product are rejected', async () => {
  for (const result of [
    detail('b'),
    { ...detail('a'), variants: [] },
    { ...detail('a'), variants: [{ id: 'a', productId: 'other' }] },
  ]) {
    let state: DetailState = initialDetailState;
    const loader = createDetailLoader(
      async () => result as SaleSkuDetail,
      (s) => {
        state = s;
      },
    );
    await loader.load('a');
    assert.equal(state.detail, null);
    assert(state.error);
    assert.equal(state.busy, false);
  }
});
test('an older detail response without variants remains a single-spec display', async () => {
  let state: DetailState = initialDetailState;
  const old = { ...detail('a') };
  delete (old as Partial<SaleSkuDetail>).variants;
  const loader = createDetailLoader(
    async () => old,
    (s) => {
      state = s;
    },
  );
  await loader.load('a');
  assert.equal(state.detail!.variants.length, 1);
  assert.equal(state.detail!.variants[0]!.id, 'a');
});
