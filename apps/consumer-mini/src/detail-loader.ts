import type { SaleSkuDetail } from './api';
export interface DetailState {
  id: string;
  detail: SaleSkuDetail | null;
  busy: boolean;
  error: string;
}
export const initialDetailState: DetailState = { id: '', detail: null, busy: true, error: '' };
// Each retry belongs to the attempted SKU. A late request cannot restore an older selection.
export function createDetailLoader(
  fetchDetail: (path: string) => Promise<SaleSkuDetail>,
  changed: (state: DetailState) => void,
) {
  let state = initialDetailState;
  let sequence = 0;
  const publish = (next: DetailState) => {
    state = next;
    changed(next);
  };
  async function load(id: string) {
    const token = ++sequence;
    publish({ id, detail: null, busy: true, error: '' });
    try {
      if (!id) throw Error('暂未找到这件商品');
      const detail = await fetchDetail(`/products/${encodeURIComponent(id)}`);
      if (token !== sequence) return;
      // Old API responses can still display one SKU; a fresh API supplies all variants.
      if (detail.id !== id) throw Error('商品规格资料不一致，请重新加载');
      const variants = detail.variants ?? [detail];
      if (
        !variants.length ||
        !variants.some((v) => v.id === id) ||
        variants.some((v) => v.productId !== detail.productId)
      )
        throw Error('商品规格资料不完整，请重新加载');
      publish({ id, detail: { ...detail, variants }, busy: false, error: '' });
    } catch (e) {
      if (token !== sequence) return;
      publish({
        id,
        detail: null,
        busy: false,
        error: e instanceof Error ? e.message : '商品加载失败',
      });
    }
  }
  return {
    load,
    retry: () => load(state.id),
    cancel: () => {
      sequence++;
    },
  };
}
