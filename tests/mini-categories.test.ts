import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCategoryLoader,
  initialCategoryState,
} from '../apps/consumer-mini/src/category-loader.ts';
import type { CategoryState } from '../apps/consumer-mini/src/category-loader.ts';
import type { PublicCategoryPage } from '../apps/consumer-mini/src/api.ts';
const page = (ids: string[], cursor: string | null = null): PublicCategoryPage => ({
  items: ids.map((id) => ({ id, name: id, parentId: null, parentName: null })),
  hasMore: !!cursor,
  nextCursor: cursor,
});
test('category append failure preserves rows and retries exact cursor without duplicates', async () => {
  let state: CategoryState = initialCategoryState,
    fail = false;
  const paths: string[] = [];
  const loader = createCategoryLoader(
    async (path) => {
      paths.push(path);
      if (fail) throw Error('offline');
      return path.includes('cursor=') ? page(['a', 'b']) : page(['a'], 'next/x');
    },
    (s) => {
      state = s;
    },
  );
  await loader.load();
  fail = true;
  await loader.load(true);
  assert.deepEqual(
    state.rows.map((r) => r.id),
    ['a'],
  );
  fail = false;
  await loader.retry();
  assert.equal(paths[1], paths[2]);
  assert(paths[2]!.includes('cursor=next%2Fx'));
  assert.deepEqual(
    state.rows.map((r) => r.id),
    ['a', 'b'],
  );
});
test('category refresh and cancellation discard late pages and errors', async () => {
  let state: CategoryState = initialCategoryState;
  let resolve!: (p: PublicCategoryPage) => void;
  let reject!: (e: Error) => void;
  let calls = 0;
  const loader = createCategoryLoader(
    async () => {
      calls++;
      return calls === 1
        ? new Promise((r, j) => {
            resolve = r;
            reject = j;
          })
        : page(['new']);
    },
    (s) => {
      state = s;
    },
  );
  const old = loader.load();
  await loader.load();
  reject(Error('old'));
  await old;
  assert.equal(state.error, '');
  assert.equal(state.rows[0]!.id, 'new');
  const pending = createCategoryLoader(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
    (s) => {
      state = s;
    },
  );
  const request = pending.load();
  const snapshot = state;
  pending.cancel();
  resolve(page(['late']));
  await request;
  assert.equal(state, snapshot);
});
test('category first-page failure can retry to empty; duplicate/no-cursor append does not request', async () => {
  let state: CategoryState = initialCategoryState,
    fail = true,
    calls = 0;
  const loader = createCategoryLoader(
    async () => {
      calls++;
      if (fail) throw Error('offline');
      return page([]);
    },
    (s) => {
      state = s;
    },
  );
  await loader.load();
  assert(state.error);
  fail = false;
  await loader.retry();
  assert.equal(state.rows.length, 0);
  assert.equal(state.error, '');
  await loader.load(true);
  assert.equal(calls, 2);
});
