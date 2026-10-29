import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowseLoader, initialBrowseState } from '../apps/consumer-mini/src/browse-loader.ts';
import type { BrowseState } from '../apps/consumer-mini/src/browse-loader.ts';
import type { ProductPage, SaleSku } from '../apps/consumer-mini/src/api.ts';
const row = (id: string) => ({ id }) as SaleSku;
const page = (ids: string[], cursor: string | null = null): ProductPage => ({
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
  const pending: { resolve: (p: ProductPage) => void; reject: (e: Error) => void }[] = [];
  const loader = createBrowseLoader(
    () => new Promise<ProductPage>((resolve, reject) => pending.push({ resolve, reject })),
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
  let resolve!: (p: ProductPage) => void;
  const loader = createBrowseLoader(
    async () => {
      calls++;
      if (calls === 1) return page(['one'], 'two');
      return new Promise<ProductPage>((done) => {
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
