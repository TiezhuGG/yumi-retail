import type { ProductCardPage, ProductCard } from './api';

export interface BrowseState {
  rows: ProductCard[];
  keyword: string;
  categoryId: string | null;
  cursor: string | null;
  busy: boolean;
  error: string;
}
export const initialBrowseState: BrowseState = {
  rows: [],
  keyword: '',
  categoryId: null,
  cursor: null,
  busy: false,
  error: '',
};
interface Intent {
  keyword: string;
  categoryId: string | null;
  cursor: string | null;
  append: boolean;
}

// A retry belongs to the failed query/page, not to text edited after that request.
export function createBrowseLoader(
  fetchPage: (path: string) => Promise<ProductCardPage>,
  changed: (state: BrowseState) => void,
) {
  let state = initialBrowseState;
  let sequence = 0;
  let failed: Intent | null = null;
  const publish = (next: BrowseState) => {
    state = next;
    changed(next);
  };
  async function run(intent: Intent) {
    const token = ++sequence;
    failed = null;
    publish({
      ...state,
      keyword: intent.keyword,
      categoryId: intent.categoryId,
      rows: intent.append ? state.rows : [],
      cursor: intent.append ? state.cursor : null,
      busy: true,
      error: '',
    });
    try {
      const result = await fetchPage(
        `/storefront/products?limit=20${intent.keyword ? `&keyword=${encodeURIComponent(intent.keyword)}` : ''}${intent.categoryId ? `&categoryId=${encodeURIComponent(intent.categoryId)}` : ''}${intent.cursor ? `&cursor=${encodeURIComponent(intent.cursor)}` : ''}`,
      );
      if (token !== sequence) return;
      const rows = intent.append ? [...state.rows, ...result.items] : result.items;
      publish({
        ...state,
        rows: [...new Map(rows.map((row) => [row.id, row])).values()],
        cursor: result.nextCursor,
        busy: false,
      });
    } catch (e) {
      if (token !== sequence) return;
      failed = intent;
      publish({
        ...state,
        busy: false,
        error: e instanceof Error ? e.message : '网络有点忙，请稍后再试',
      });
    }
  }
  return {
    load(keyword = state.keyword, more = false, categoryId = state.categoryId) {
      if (
        more &&
        (state.busy ||
          !state.cursor ||
          categoryId !== state.categoryId ||
          keyword.trim() !== state.keyword)
      )
        return Promise.resolve();
      return run({
        keyword: keyword.trim(),
        categoryId,
        cursor: more ? state.cursor : null,
        append: more,
      });
    },
    retry: () => (failed ? run(failed) : Promise.resolve()),
    cancel: () => {
      sequence++;
    },
  };
}
