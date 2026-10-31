import type { PublicCategory, PublicCategoryPage } from './api';
export interface CategoryState {
  rows: PublicCategory[];
  cursor: string | null;
  busy: boolean;
  error: string;
}
export const initialCategoryState: CategoryState = {
  rows: [],
  cursor: null,
  busy: true,
  error: '',
};
export function createCategoryLoader(
  fetchPage: (path: string) => Promise<PublicCategoryPage>,
  changed: (state: CategoryState) => void,
) {
  let state = initialCategoryState,
    sequence = 0;
  let failed: { cursor: string | null; append: boolean } | null = null;
  const publish = (next: CategoryState) => {
    state = next;
    changed(next);
  };
  async function run(intent: { cursor: string | null; append: boolean }) {
    const token = ++sequence;
    failed = null;
    publish({
      rows: intent.append ? state.rows : [],
      cursor: intent.append ? state.cursor : null,
      busy: true,
      error: '',
    });
    try {
      const page = await fetchPage(
        `/categories?limit=20${intent.cursor ? `&cursor=${encodeURIComponent(intent.cursor)}` : ''}`,
      );
      if (token !== sequence) return;
      publish({
        rows: [
          ...new Map(
            [...(intent.append ? state.rows : []), ...page.items].map((r) => [r.id, r]),
          ).values(),
        ],
        cursor: page.nextCursor,
        busy: false,
        error: '',
      });
    } catch (e) {
      if (token !== sequence) return;
      failed = intent;
      publish({ ...state, busy: false, error: e instanceof Error ? e.message : '分类加载失败' });
    }
  }
  return {
    load(more = false) {
      if (more && (state.busy || !state.cursor)) return Promise.resolve();
      return run({ cursor: more ? state.cursor : null, append: more });
    },
    retry: () => (failed ? run(failed) : Promise.resolve()),
    cancel: () => {
      sequence++;
    },
  };
}
