import Taro from '@tarojs/taro';
declare const API_BASE_URL: string;
export type PointsCartLine = { rewardId: string; quantity: number };
const prefix = 'yumi.points-cart.v1:' + API_BASE_URL + ':';
export const pointsCartKey = (userId?: string) => prefix + (userId ?? 'guest');
export const pointsCheckoutKey = prefix + 'checkout';
export function readPointsCart(userId?: string): PointsCartLine[] {
  const saved: unknown = Taro.getStorageSync(pointsCartKey(userId));
  const raw =
    saved && typeof saved === 'object' && !Array.isArray(saved)
      ? (saved as { items: unknown }).items
      : saved;
  if (!raw) return [];
  if (
    !Array.isArray(raw) ||
    raw.length > 20 ||
    raw.some(
      (i) =>
        !i ||
        typeof i.rewardId !== 'string' ||
        !/^[a-f0-9-]{36}$/i.test(i.rewardId) ||
        !Number.isInteger(i.quantity) ||
        i.quantity < 1 ||
        i.quantity > 100000,
    ) ||
    new Set(raw.map((i) => i.rewardId)).size !== raw.length
  )
    throw Error('购物车记录无法读取，请清空本机购物车后重新选择');
  return raw as PointsCartLine[];
}
export function savePointsCart(items: PointsCartLine[], userId?: string) {
  const saved = Taro.getStorageSync(pointsCartKey(userId));
  Taro.setStorageSync(pointsCartKey(userId), {
    items,
    completed: Array.isArray(saved?.completed) ? saved.completed : [],
  });
}
export function addPointsCart(rewardId: string, quantity: number, userId?: string) {
  const items = readPointsCart(userId),
    old = items.find((i) => i.rewardId === rewardId);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) throw Error('商品数量无效');
  if (old) old.quantity = Math.min(100000, old.quantity + quantity);
  else {
    if (items.length >= 20) throw Error('购物车最多放入20种商品');
    items.push({ rewardId, quantity });
  }
  savePointsCart(items, userId);
}
export type PointsCheckoutIntent = {
  cartMode: boolean;
  cloudCart?: boolean;
  userId: string;
  key: string;
  quoteIds: string[];
  items: PointsCartLine[];
  result?: { orderIds: string[]; totalPoints: string };
  cleared?: boolean;
};
export function readPointsIntent(): PointsCheckoutIntent | null {
  const raw = Taro.getStorageSync(pointsCheckoutKey) as PointsCheckoutIntent | undefined;
  if (!raw) return null;
  const uuid = (s: unknown) =>
    typeof s === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s);
  if (
    typeof raw.cartMode !== 'boolean' ||
    (raw.cloudCart !== undefined && typeof raw.cloudCart !== 'boolean') ||
    !uuid(raw.userId) ||
    !uuid(raw.key) ||
    !Array.isArray(raw.quoteIds) ||
    !raw.quoteIds.length ||
    raw.quoteIds.length > 20 ||
    !raw.quoteIds.every(uuid) ||
    !Array.isArray(raw.items) ||
    raw.items.length !== raw.quoteIds.length ||
    raw.items.some(
      (i) =>
        !uuid(i.rewardId) || !Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 100000,
    ) ||
    (raw.result &&
      (!Array.isArray(raw.result.orderIds) ||
        raw.result.orderIds.length !== raw.items.length ||
        !raw.result.orderIds.every(uuid) ||
        !/^\d+$/.test(raw.result.totalPoints)))
  )
    throw Error('上次兑换记录无法读取，请保留记录并核实订单');
  return raw;
}

export function consumePointsCart(intent: PointsCheckoutIntent) {
  if (!intent.cartMode || intent.cloudCart) return;
  consumeLocalPointsCart(intent.key, intent.items, intent.userId);
}
export function consumeLocalPointsCart(key: string, purchased: PointsCartLine[], userId?: string) {
  const saved = Taro.getStorageSync(pointsCartKey(userId));
  const completed: string[] = Array.isArray(saved?.completed) ? saved.completed : [];
  if (completed.includes(key)) return;
  const items = readPointsCart(userId)
    .map((i) => ({
      ...i,
      quantity: i.quantity - (purchased.find((o) => o.rewardId === i.rewardId)?.quantity ?? 0),
    }))
    .filter((i) => i.quantity > 0);
  Taro.setStorageSync(pointsCartKey(userId), { items, completed: [...completed.slice(-99), key] });
}
