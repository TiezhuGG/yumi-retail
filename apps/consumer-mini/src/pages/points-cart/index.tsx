import { View, Text, Button } from '@tarojs/components';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
import { useRef, useState } from 'react';
import { cartIdentity, type CartIdentity } from '../../account-cart';
import { readCloudPointsCart, saveCloudPointsCart } from '../../points-cart-api';
import { request } from '../../api';
import type { Reward } from '../../rewards-api';
import { ProductVisual } from '../../components/ProductVisual';
import { LoadingState } from '../../components/LoadingState';
import {
  readPointsCart,
  savePointsCart,
  pointsCartKey,
  readPointsIntent,
  pointsCheckoutKey,
} from '../../points-cart';
import type { PointsCartLine } from '../../points-cart';
export default function PointsCart() {
  const [items, setItems] = useState<PointsCartLine[]>([]),
    [products, setProducts] = useState<Record<string, Reward>>({}),
    [selected, setSelected] = useState<string[]>([]),
    [userId, setUserId] = useState<string | undefined>(),
    [guest, setGuest] = useState(false),
    [legacy, setLegacy] = useState(false),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false);
  const seq = useRef(0),
    writing = useRef(false),
    identity = useRef<CartIdentity | null>(null),
    version = useRef(0);
  async function load(keepSelection = false) {
    const n = ++seq.current;
    setLoading(true);
    setError('');
    setItems([]);
    setProducts({});
    try {
      const who = await cartIdentity();
      if (n !== seq.current) return;
      const uid = who?.profile.user.id;
      const cloud = who ? await readCloudPointsCart(who) : null;
      if (n !== seq.current) return;
      identity.current = who;
      version.current = cloud?.version ?? 0;
      const rows = cloud?.items ?? readPointsCart(),
        intent = readPointsIntent();
      setUserId(uid);
      setGuest(!!uid && readPointsCart().length > 0);
      setLegacy(!!uid && readPointsCart(uid).length > 0);
      setPending(!!intent && (!intent.result || !intent.cleared));
      const all = await Promise.all(
        rows.map(async (i) => {
          try {
            return await request<Reward>('/rewards/' + i.rewardId);
          } catch {
            return null;
          }
        }),
      );
      if (n !== seq.current) return;
      setItems(rows);
      setProducts(Object.fromEntries(all.filter((p): p is Reward => !!p).map((p) => [p.id, p])));
      setSelected((old) =>
        keepSelection
          ? old.filter((id) => rows.some((i) => i.rewardId === id))
          : rows.map((i) => i.rewardId),
      );
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '购物车读取失败');
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }
  useDidShow(() => {
    void load();
  });
  useDidHide(() => {
    seq.current++;
    setItems([]);
    setProducts({});
    identity.current = null;
  });
  async function persist(next: PointsCartLine[], source?: 'guest' | 'account') {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    setError('');
    const n = seq.current;
    try {
      const who = identity.current;
      if (who) await saveCloudPointsCart(who, version.current, next, source);
      else savePointsCart(next);
      if (n === seq.current) await load(!source);
    } catch (e) {
      if (n === seq.current) {
        setItems([]);
        setProducts({});
        setError(e instanceof Error ? e.message : '保存结果待核实，请重新读取');
      }
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  function change(id: string, delta: number) {
    void persist(
      items.map((i) =>
        i.rewardId === id
          ? { ...i, quantity: Math.max(1, Math.min(100000, i.quantity + delta)) }
          : i,
      ),
    );
  }
  function remove(id: string) {
    void persist(items.filter((i) => i.rewardId !== id));
  }
  const chosen = items.filter((i) => selected.includes(i.rewardId)),
    total = chosen.reduce(
      (sum, i) => sum + Number(products[i.rewardId]?.pointsPrice ?? 0) * i.quantity,
      0,
    ),
    invalid = chosen.some(
      (i) => !products[i.rewardId] || i.quantity > products[i.rewardId]!.available,
    );
  function checkout() {
    try {
      if (!userId) {
        void Taro.navigateTo({ url: '/pages/login/index' });
        return;
      }
      const intent = readPointsIntent();
      if (intent && (!intent.result || !intent.cleared)) {
        void Taro.navigateTo({ url: '/pages/points-checkout/index' });
        return;
      }
      if (intent?.result) Taro.removeStorageSync(pointsCheckoutKey);
      Taro.setStorageSync(pointsCartKey(userId) + ':selection', chosen);
      void Taro.navigateTo({ url: '/pages/points-checkout/index' });
    } catch (e) {
      setError(e instanceof Error ? e.message : '无法结算');
    }
  }
  return (
    <View className="account-page points-cart-page">
      <View className="account-content">
        <Text className="account-name">购物车</Text>
        {loading && <LoadingState label="正在读取购物车…" />}
        {error && (
          <View className="account-error">
            <Text>{error}</Text>
            <Button disabled={busy} onClick={() => void load()}>
              重新读取
            </Button>
          </View>
        )}
        {!loading && guest && (
          <Button
            className="account-link"
            disabled={busy || !!error}
            onClick={() => void persist(readPointsCart(), 'guest')}
          >
            导入未登录时加入的商品
          </Button>
        )}
        {!loading && legacy && (
          <Button
            className="account-link"
            disabled={busy || !!error}
            onClick={() => void persist(readPointsCart(userId), 'account')}
          >
            导入本机账号商品
          </Button>
        )}
        {pending && (
          <Button
            className="points-action"
            onClick={() => void Taro.navigateTo({ url: '/pages/points-checkout/index' })}
          >
            核实上次兑换结果
          </Button>
        )}
        {!loading && !error && !items.length && (
          <View className="account-card">
            <Text className="account-card-title">购物车还是空的</Text>
            <Button
              className="points-action"
              onClick={() => void Taro.switchTab({ url: '/pages/index/index' })}
            >
              去选商品
            </Button>
          </View>
        )}
        {items.map((i) => {
          const p = products[i.rewardId];
          return (
            <View className="account-card points-cart-row" key={i.rewardId}>
              <Button
                className="cart-select"
                onClick={() =>
                  setSelected(
                    selected.includes(i.rewardId)
                      ? selected.filter((id) => id !== i.rewardId)
                      : [...selected, i.rewardId],
                  )
                }
              >
                {selected.includes(i.rewardId) ? '☑' : '□'}
              </Button>
              <View className="points-cart-product">
                <View
                  className="points-cart-thumbnail"
                  onClick={() =>
                    void Taro.navigateTo({ url: '/pages/reward/index?id=' + i.rewardId })
                  }
                >
                  <ProductVisual name={p?.name ?? '商品暂不可用'} imageUrl={p?.imageUrl ?? null} />
                </View>
                <Text className="account-card-title">{p?.title ?? '商品暂不可用'}</Text>
                <Text className="account-copy">
                  {p ? p.spec + ' / ' + p.unit : '请删除后重新选择'}
                </Text>
                <Text className="reward-price">
                  {p ? p.pointsPrice + ' 积分 / 件' : '暂不可兑换'}
                </Text>
                {p && i.quantity > p.available && (
                  <Text className="account-error">库存不足，请减少数量或取消勾选</Text>
                )}
                <View className="reward-quantity">
                  <Button
                    disabled={busy || loading || i.quantity <= 1}
                    onClick={() => change(i.rewardId, -1)}
                  >
                    −
                  </Button>
                  <Text>{i.quantity}</Text>
                  <Button
                    disabled={busy || loading || i.quantity >= Math.min(100000, p?.available ?? 0)}
                    onClick={() => change(i.rewardId, 1)}
                  >
                    ＋
                  </Button>
                  <Button disabled={busy || loading} onClick={() => remove(i.rewardId)}>
                    删除
                  </Button>
                </View>
              </View>
            </View>
          );
        })}
        {!!items.length && (
          <View className="account-card points-cart-summary">
            <Button
              className="account-link"
              onClick={() =>
                setSelected(selected.length === items.length ? [] : items.map((i) => i.rewardId))
              }
            >
              {selected.length === items.length ? '取消全选' : '全选'}
            </Button>
            <Text className="reward-price">合计 {total} 积分</Text>
            <Text className="account-copy">
              已选 {chosen.length} 种 · {chosen.reduce((sum, i) => sum + i.quantity, 0)} 件
            </Text>
            <Button
              className="points-action"
              disabled={!chosen.length || invalid || loading || busy || !!error}
              onClick={checkout}
            >
              {userId ? '去兑换' : '登录后兑换'}
            </Button>
          </View>
        )}
      </View>
    </View>
  );
}
