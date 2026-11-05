import Taro from '@tarojs/taro';
import type { RewardCart, RewardCartLine } from '../../../packages/contracts/src/index';
import { cartIdentity, type CartIdentity } from './account-cart';
import { addressRequest, addressOperationKey, AddressRequestError } from './address-api';
import { addPointsCart, pointsCartKey, consumeLocalPointsCart } from './points-cart';
type Pending = {
  key: string;
  body: { action: 'REPLACE' | 'MERGE'; version: number; items: RewardCartLine[] };
  source?: 'guest' | 'account';
  userId: string;
};
const pendingKey = (id: string) => pointsCartKey(id) + ':sync';
const base = '/consumer/points-cart';
const guestPendingKey = pointsCartKey() + ':sync';
function pendingFor(id: string): Pending | undefined {
  const own = Taro.getStorageSync(pendingKey(id)) as Pending | undefined;
  const guest = Taro.getStorageSync(guestPendingKey) as Pending | undefined;
  return own || (guest?.userId === id ? guest : undefined);
}
const storageKey = (pending: Pending) =>
  pending.source === 'guest' ? guestPendingKey : pendingKey(pending.userId);
async function finish(identity: CartIdentity, pending: Pending) {
  if (pending.userId !== identity.profile.user.id) throw Error('请恢复原账号核实购物车');
  await addressRequest<RewardCart>(identity, base, pending.body, pending.key);
  if (pending.source)
    consumeLocalPointsCart(
      pending.key,
      pending.body.items,
      pending.source === 'account' ? identity.profile.user.id : undefined,
    );
  Taro.removeStorageSync(storageKey(pending));
}
export async function readCloudPointsCart(identity: CartIdentity): Promise<RewardCart> {
  const saved = pendingFor(identity.profile.user.id);
  if (saved) {
    try {
      await finish(identity, saved);
    } catch (e) {
      if (
        e instanceof AddressRequestError &&
        e.status === 409 &&
        e.code === 'CART_VERSION_CONFLICT'
      ) {
        // This request definitely did not commit; retain the local source for explicit import again.
        Taro.removeStorageSync(storageKey(saved));
      } else throw e;
    }
  }
  return addressRequest<RewardCart>(identity, base);
}
export async function saveCloudPointsCart(
  identity: CartIdentity,
  version: number,
  items: RewardCartLine[],
  source?: 'guest' | 'account',
) {
  const id = identity.profile.user.id;
  if (pendingFor(id)) throw Error('有购物车保存待核实，请先重新读取');
  if (source === 'guest' && Taro.getStorageSync(guestPendingKey))
    throw Error('未登录商品有原账号导入结果待核实，请恢复原账号处理');
  const pending: Pending = {
    key: addressOperationKey(),
    userId: id,
    body: { action: source ? 'MERGE' : 'REPLACE', version, items },
    ...(source ? { source } : {}),
  };
  Taro.setStorageSync(storageKey(pending), pending);
  try {
    await finish(identity, pending);
  } catch (e) {
    if (e instanceof AddressRequestError && e.status < 500 && ![401, 403].includes(e.status))
      Taro.removeStorageSync(storageKey(pending));
    if (!(e instanceof AddressRequestError)) throw Error('保存结果待核实，请重新读取购物车');
    throw e;
  }
  return addressRequest<RewardCart>(identity, base);
}
export async function addAccountPointsCart(rewardId: string, quantity: number) {
  const identity = await cartIdentity();
  if (!identity) {
    addPointsCart(rewardId, quantity);
    return;
  }
  if (pendingFor(identity.profile.user.id)) throw Error('上次加购结果待核实，请先到购物车重新读取');
  const cart = await readCloudPointsCart(identity),
    items = cart.items.map((i) => ({ ...i })),
    old = items.find((i) => i.rewardId === rewardId);
  if (old) old.quantity += quantity;
  else items.push({ rewardId, quantity });
  if (items.length > 20 || items.some((i) => i.quantity > 100000))
    throw Error('购物车超过技术容量，请先调整商品');
  await saveCloudPointsCart(identity, cart.version, items);
}
