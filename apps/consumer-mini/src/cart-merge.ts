import { parseCart } from './guest-cart';
import type { CartItem } from './guest-cart';
export interface MergeIntent {
  key: string;
  userId: string;
  items: CartItem[];
}
export class CartRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function readMergeIntent(raw: unknown): MergeIntent | null {
  if (!raw || typeof raw !== 'object' || !('merge' in raw)) return null;
  const pending = raw.merge as MergeIntent;
  if (
    !pending ||
    !uuid.test(pending.key) ||
    !uuid.test(pending.userId) ||
    JSON.stringify(parseCart({ version: 1, items: pending.items }).items) !==
      JSON.stringify(parseCart(raw).items)
  )
    throw Error('合并记录与原草稿不一致，资料已保留，请勿重复合并。');
  return { key: pending.key, userId: pending.userId, items: parseCart(raw).items };
}
export function assertGuestWritable(raw: unknown) {
  if (readMergeIntent(raw)) throw Error('有一笔草稿合并待确认，请先在购物车完成重试。');
}
export function createCartMerge(io: {
  read(): unknown;
  write(value: unknown): void;
  newKey(): string;
  send(intent: MergeIntent): Promise<unknown>;
}) {
  let running = false;
  return {
    async merge(userId: string) {
      if (running) throw Error('正在合并，请稍候');
      running = true;
      try {
        const raw = io.read(),
          draft = parseCart(raw);
        let pending = readMergeIntent(raw);
        if (pending && pending.userId !== userId)
          throw Error('待确认合并属于另一个账号，请切回原账号完成重试；原草稿已保留。');
        if (!pending) {
          if (!draft.items.length) return;
          pending = { key: io.newKey(), userId, items: draft.items.map((item) => ({ ...item })) };
          io.write({ ...draft, merge: pending });
        }
        try {
          await io.send(pending);
        } catch (error) {
          // Only authoritative validation/cap rejection guarantees that no merge was committed.
          if (
            error instanceof CartRequestError &&
            ['VALIDATION_ERROR', 'CART_LIMIT_EXCEEDED'].includes(error.code)
          ) {
            const current = io.read(),
              saved = readMergeIntent(current);
            if (saved?.key === pending.key)
              io.write({ version: 1, items: parseCart(current).items });
          }
          throw error;
        }
        const current = io.read(),
          saved = readMergeIntent(current);
        if (saved?.key !== pending.key || saved.userId !== userId)
          throw Error('合并已保存，但本机草稿已变化，未清除资料，请核查后重试。');
        io.write({ version: 1, items: [] });
      } finally {
        running = false;
      }
    },
  };
}
