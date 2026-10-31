import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowseLoader, initialBrowseState } from '../apps/consumer-mini/src/browse-loader.ts';
import type { BrowseState } from '../apps/consumer-mini/src/browse-loader.ts';
import type { ProductCardPage, ProductCard } from '../apps/consumer-mini/src/api.ts';
const row = (id: string) => ({ id }) as ProductCard;
const page = (ids: string[], cursor: string | null = null): ProductCardPage => ({
  items: ids.map(row),
  nextCursor: cursor,
  hasMore: !!cursor,
});

test('failed append retries the exact page and search without dropping prior goods', async () => {
  let state: BrowseState = initialBrowseState;
  const paths: string[] = [];
  let reject = true;
  const loader = createBrowseLoader(
    async (path) => {
      paths.push(path);
      if (!path.includes('cursor=')) return page(['one'], 'page/2');
      if (reject) throw new Error('合成断网');
      return page(['one', 'two']);
    },
    (next) => {
      state = next;
    },
  );
  await loader.load('纸 巾');
  await loader.load('纸 巾', true);
  assert.deepEqual(
    state.rows.map((r) => r.id),
    ['one'],
  );
  assert.equal(state.error, '合成断网');
  reject = false;
  await loader.retry();
  assert.equal(paths[1], paths[2]);
  assert.match(paths[2]!, /keyword=%E7%BA%B8%20%E5%B7%BE&cursor=page%2F2/);
  assert.deepEqual(
    state.rows.map((r) => r.id),
    ['one', 'two'],
  );
  assert.equal(state.cursor, null);
  assert.equal(state.error, '');
});

test('failed search labels the attempted keyword, clears the old cursor, and retries it', async () => {
  let state: BrowseState = initialBrowseState;
  let reject = false;
  const paths: string[] = [];
  const loader = createBrowseLoader(
    async (path) => {
      paths.push(path);
      if (reject) throw Error('失败');
      return page(['old'], 'old-cursor');
    },
    (next) => {
      state = next;
    },
  );
  await loader.load('原词');
  reject = true;
  await loader.load(' 新词 ');
  assert.equal(state.keyword, '新词');
  assert.equal(state.cursor, null);
  assert.deepEqual(state.rows, []);
  await loader.retry();
  assert.equal(paths.at(-1), paths.at(-2));
});

test('late success or failure cannot overwrite newer search or cancelled page', async () => {
  let state: BrowseState = initialBrowseState;
  const pending: { resolve: (p: ProductCardPage) => void; reject: (e: Error) => void }[] = [];
  const loader = createBrowseLoader(
    () => new Promise<ProductCardPage>((resolve, reject) => pending.push({ resolve, reject })),
    (next) => {
      state = next;
    },
  );
  const old = loader.load('旧词');
  const fresh = loader.load('新词');
  pending[1]!.resolve(page(['fresh']));
  await fresh;
  pending[0]!.reject(Error('过期错误'));
  await old;
  assert.equal(state.keyword, '新词');
  assert.equal(state.error, '');
  assert.deepEqual(
    state.rows.map((r) => r.id),
    ['fresh'],
  );
  const cancelled = loader.load('离开页面');
  loader.cancel();
  const snapshot = state;
  pending[2]!.resolve(page(['cancelled']));
  await cancelled;
  assert.equal(state, snapshot);
});

test('no next page or duplicate in-flight append cannot issue extra requests', async () => {
  let calls = 0;
  let resolve!: (p: ProductCardPage) => void;
  const loader = createBrowseLoader(
    async () => {
      calls++;
      if (calls === 1) return page(['one'], 'two');
      return new Promise<ProductCardPage>((done) => {
        resolve = done;
      });
    },
    () => {},
  );
  await loader.load('', true);
  assert.equal(calls, 0);
  await loader.load();
  const append = loader.load('', true);
  await loader.load('', true);
  assert.equal(calls, 2);
  resolve(page([]));
  await append;
  await loader.load('', true);
  assert.equal(calls, 2);
});

test('category and keyword persist through append and exact retry, explicit null clears scope', async () => {
  let state: BrowseState = initialBrowseState;
  const paths: string[] = [];
  let fail = false;
  const loader = createBrowseLoader(
    async (path) => {
      paths.push(path);
      if (fail) throw Error('offline');
      return page(['a'], path.includes('cursor=') ? null : 'next');
    },
    (s) => {
      state = s;
    },
  );
  await loader.load(' 纸 ', false, 'cat/a');
  assert.equal(state.categoryId, 'cat/a');
  fail = true;
  await loader.load('纸', true);
  assert.deepEqual(
    state.rows.map((r) => r.id),
    ['a'],
  );
  fail = false;
  await loader.retry();
  assert.equal(paths[1], paths[2]);
  assert(paths[2]!.includes('categoryId=cat%2Fa'));
  assert(paths[2]!.includes('keyword=%E7%BA%B8'));
  await loader.load('', false, null);
  assert.equal(state.categoryId, null);
  assert(!paths.at(-1)!.includes('categoryId='));
});
test('category switch drops prior rows/cursor and late old append cannot restore them', async () => {
  let state: BrowseState = initialBrowseState;
  let resolve!: (p: ProductCardPage) => void;
  const loader = createBrowseLoader(
    async (path) =>
      path.includes('cursor=')
        ? new Promise((r) => {
            resolve = r;
          })
        : page([path.includes('cat-b') ? 'b' : 'a'], 'next'),
    (s) => {
      state = s;
    },
  );
  await loader.load('', false, 'cat-a');
  const pending = loader.load('', true);
  await loader.load('', false, 'cat-b');
  resolve(page(['old']));
  await pending;
  assert.equal(state.categoryId, 'cat-b');
  assert.deepEqual(
    state.rows.map((r) => r.id),
    ['b'],
  );
});
test('append with a changed filter is refused and refresh retains current scope', async () => {
  let calls = 0,
    path = '';
  const loader = createBrowseLoader(
    async (p) => {
      calls++;
      path = p;
      return page(['a'], 'next');
    },
    () => {},
  );
  await loader.load('x', false, 'cat');
  await loader.load('y', true, 'cat');
  await loader.load('x', true, 'other');
  assert.equal(calls, 1);
  await loader.load();
  assert(path.includes('keyword=x'));
  assert(path.includes('categoryId=cat'));
});

test('card loader uses product endpoint and product identity even when entry SKU changes on a later page', async () => {
  let state: BrowseState = initialBrowseState;
  const paths: string[] = [];
  const loader = createBrowseLoader(
    async (path) => {
      paths.push(path);
      return path.includes('cursor=')
        ? { ...page(['p', 'q']), items: [{ ...row('p'), entrySkuId: 'new-sku' }, row('q')] }
        : { ...page(['p'], 'next-product'), items: [{ ...row('p'), entrySkuId: 'old-sku' }] };
    },
    (s) => {
      state = s;
    },
  );
  await loader.load();
  await loader.load('', true);
  assert(paths.every((p) => p.startsWith('/storefront/products?')));
  assert.deepEqual(
    state.rows.map((r) => r.id),
    ['p', 'q'],
  );
  assert.equal(state.rows[0]!.entrySkuId, 'new-sku');
});
