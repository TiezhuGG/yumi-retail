import type { SaleSku } from './api';
export interface CartItem {
  skuId: string;
  quantity: number;
  selected: boolean;
  name: string;
  spec: string;
  unit: string;
}
export interface CartDraft {
  version: 1;
  items: CartItem[];
}
export type CartCheck =
  | { status: 'ready'; sku: SaleSku }
  | { status: 'gone' | 'unknown'; message: string };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= max;
export function parseCart(value: unknown): CartDraft {
  if (value === '' || value === null || value === undefined) return { version: 1, items: [] };
  const invalid = () => {
    throw Error('本机购物车资料无法读取，原资料已保留。可重试，或明确重置本机草稿。');
  };
  if (
    !value ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('items' in value) ||
    !Array.isArray(value.items) ||
    value.items.length > 50
  )
    return invalid();
  const items: CartItem[] = [];
  for (const row of value.items) {
    if (
      !row ||
      typeof row !== 'object' ||
      typeof row.skuId !== 'string' ||
      !uuid.test(row.skuId) ||
      !Number.isInteger(row.quantity) ||
      row.quantity < 1 ||
      row.quantity > 200 ||
      typeof row.selected !== 'boolean' ||
      !text(row.name, 120) ||
      !text(row.spec, 100) ||
      !text(row.unit, 16)
    )
      return invalid();
    items.push({
      skuId: row.skuId,
      quantity: row.quantity,
      selected: row.selected,
      name: row.name,
      spec: row.spec,
      unit: row.unit,
    });
  }
  if (
    new Set(items.map((i) => i.skuId)).size !== items.length ||
    items.reduce((n, i) => n + i.quantity, 0) > 200
  )
    return invalid();
  return { version: 1, items };
}
export function verifiedSku(sku: SaleSku, id: string) {
  if (
    sku.id !== id ||
    !uuid.test(id) ||
    !text(sku.name, 120) ||
    !text(sku.spec, 100) ||
    !text(sku.unit, 16) ||
    !Number.isSafeInteger(sku.priceCents) ||
    sku.priceCents < 1 ||
    sku.priceCents > 100000000 ||
    !Number.isSafeInteger(sku.available) ||
    sku.available < 0 ||
    sku.available > 1000000000
  )
    throw Error('商品核验资料不完整，请刷新后重试');
  return sku;
}
export function createGuestCart(storage: { read(): unknown; write(value: CartDraft): void }) {
  const read = () => parseCart(storage.read());
  function commit(change: (items: CartItem[]) => CartItem[]) {
    const current = read(),
      items = change(current.items);
    if (
      items.length > 50 ||
      items.reduce((n, i) => n + i.quantity, 0) > 200 ||
      items.some((i) => !Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 200)
    )
      throw Error('草稿最多50种规格、合计200件，请先调整数量');
    const draft = parseCart({ version: 1, items });
    storage.write(draft); // Publish only after the synchronous write succeeds.
    return draft;
  }
  return {
    read,
    add(sku: SaleSku) {
      verifiedSku(sku, sku.id);
      if (sku.available < 1) throw Error('该规格暂时缺货，请刷新商品资料后再试');
      return commit((items) => {
        const found = items.some((i) => i.skuId === sku.id);
        const labels = { name: sku.name, spec: sku.spec, unit: sku.unit };
        return found
          ? items.map((i) =>
              i.skuId === sku.id ? { ...i, ...labels, quantity: i.quantity + 1 } : i,
            )
          : [...items, { skuId: sku.id, ...labels, quantity: 1, selected: true }];
      });
    },
    adjust(id: string, delta: number) {
      if (!Number.isInteger(delta) || Math.abs(delta) !== 1) throw Error('每次只能增加或减少1件');
      return commit((items) =>
        items.map((i) => (i.skuId === id ? { ...i, quantity: i.quantity + delta } : i)),
      );
    },
    quantity(id: string, quantity: number) {
      return commit((items) => items.map((i) => (i.skuId === id ? { ...i, quantity } : i)));
    },
    toggle(id: string) {
      return commit((items) =>
        items.map((i) => (i.skuId === id ? { ...i, selected: !i.selected } : i)),
      );
    },
    select(ids: string[], selected: boolean) {
      return commit((items) => items.map((i) => (ids.includes(i.skuId) ? { ...i, selected } : i)));
    },
    remove(id: string) {
      return commit((items) => items.filter((i) => i.skuId !== id));
    },
    reset() {
      const empty: CartDraft = { version: 1, items: [] };
      storage.write(empty);
      return empty;
    },
  };
}
export function cartSummary(items: CartItem[], checks: Record<string, CartCheck>) {
  let totalCents = 0,
    units = 0,
    excluded = 0;
  for (const item of items) {
    if (!item.selected) continue;
    const check = checks[item.skuId];
    if (
      check?.status !== 'ready' ||
      check.sku.available < item.quantity ||
      check.sku.available < 1
    ) {
      excluded++;
      continue;
    }
    totalCents += check.sku.priceCents * item.quantity;
    units += item.quantity;
  }
  return { totalCents, units, excluded };
}
export async function checkCart(
  items: CartItem[],
  fetchSku: (id: string) => Promise<SaleSku>,
  isGone: (error: unknown) => boolean,
  changed: (checks: Record<string, CartCheck>) => void,
  cancelled: () => boolean,
) {
  const checks: Record<string, CartCheck> = {};
  for (let start = 0; start < items.length; start += 4) {
    if (cancelled()) return;
    const batch = await Promise.all(
      items.slice(start, start + 4).map(async (item) => {
        try {
          return [
            item.skuId,
            { status: 'ready', sku: verifiedSku(await fetchSku(item.skuId), item.skuId) },
          ] as const;
        } catch (e) {
          return [
            item.skuId,
            {
              status: isGone(e) ? 'gone' : 'unknown',
              message: isGone(e) ? '商品已不可用' : e instanceof Error ? e.message : '暂未核验',
            },
          ] as const;
        }
      }),
    );
    if (cancelled()) return;
    for (const [id, result] of batch) checks[id] = result;
    changed({ ...checks });
  }
}
