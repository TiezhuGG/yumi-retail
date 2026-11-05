import { addAccountPointsCart } from '../../points-cart-api';
import { readPointsIntent, pointsCheckoutKey } from '../../points-cart';
import { LoadingState } from '../../components/LoadingState';
import { View, Text, Button, Input } from '@tarojs/components';
import Taro, { useDidShow, useDidHide, useRouter } from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import { request } from '../../api';
import type { Reward } from '../../rewards-api';
import { ProductVisual } from '../../components/ProductVisual';
const time = (s: string) =>
  new Date(Date.parse(s) + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
export default function RewardDetail() {
  const id = useRouter().params.id;
  const [item, setItem] = useState<Reward | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [quantity, setQuantity] = useState('1'),
    [adding, setAdding] = useState(false);
  const addLock = useRef(false);
  const seq = useRef(0);
  async function load() {
    const n = ++seq.current;
    setLoading(true);
    setError('');
    setItem(null);
    try {
      if (!id) throw Error('兑换商品编号无效');
      const p = await request<Reward>('/rewards/' + encodeURIComponent(id));
      if (n === seq.current) {
        setItem(p);
        setQuantity('1');
      }
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '商品加载失败');
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }
  useDidShow(() => {
    void load();
  });
  useDidHide(() => {
    seq.current++;
  });
  useEffect(
    () => () => {
      seq.current++;
    },
    [],
  );
  const count = /^[1-9]\d{0,5}$/.test(quantity) ? Number(quantity) : 0;
  const valid = !!item && count >= 1 && count <= item.available;
  // Values are bounded to 1e9 points and 1e5 pieces, within JS safe integer range.
  return (
    <View className="detail-page retail-product-page reward-detail-page reward-product-page">
      <View className="account-content">
        {loading && <LoadingState label="正在读取商品详情…" />}
        {error && (
          <View className="account-error">
            <Text>{error}</Text>
            <Button className="points-action" onClick={() => void load()}>
              重试读取
            </Button>
            <Button
              className="account-link"
              onClick={() => void Taro.switchTab({ url: '/pages/points-cart/index' })}
            >
              查看购物车
            </Button>
          </View>
        )}
        {item && (
          <>
            <View className="detail-visual">
              <ProductVisual name={item.name} imageUrl={item.imageUrl} large />
              <Text className="detail-caption">日常好物 / YUMI ESSENTIALS</Text>
            </View>
            <View className="reward-product-heading retail-product-heading">
              <View>
                <Text className="points-store-tag">积分商城</Text>
                <Text className="reward-product-name">{item.title}</Text>
              </View>
              <View className="detail-price points-detail-price">
                <Text>{item.pointsPrice}</Text>
                <Text className="detail-unit"> 积分 / {item.unit}</Text>
              </View>
            </View>
            <View className="detail-card">
              <Text className="detail-heading">商品规格</Text>
              <Text className="detail-spec">
                {item.spec} / {item.unit}
              </Text>
              <View className="detail-promises">
                <Text>✓ 积分兑换</Text>
                <Text>{item.available > 0 ? '✓ 当前有货' : '暂时缺货'}</Text>
              </View>
              <Text className="detail-description">{item.description || '暂无更多商品说明'}</Text>
            </View>
            <View className="detail-card points-quantity-card">
              <Text className="detail-heading">数量</Text>
              <View className="reward-quantity">
                <Button
                  disabled={count <= 1}
                  onClick={() => setQuantity(String(Math.max(1, count - 1)))}
                >
                  −
                </Button>
                <Input
                  type="number"
                  value={quantity}
                  maxlength={6}
                  onInput={(e) => setQuantity(e.detail.value)}
                />
                <Button
                  disabled={count >= item.available}
                  onClick={() => setQuantity(String(count + 1))}
                >
                  ＋
                </Button>
              </View>
              <Text className="points-total-line">
                合计 <Text>{valid ? String(Number(item.pointsPrice) * count) : '—'} 积分</Text>
              </Text>
              {!valid && <Text className="detail-spec-help">当前库存不足，请调整数量。</Text>}
            </View>
            <View className="detail-card points-availability-card">
              <Text className="detail-heading">配送与兑换</Text>
              <Text className="detail-spec-help">
                {item.startsAt ? '开售时间：' + time(item.startsAt) + '（北京时间）' : '随时可兑换'}
                {item.endsAt ? ' · 截止：' + time(item.endsAt) + '（北京时间）' : ''}
              </Text>
              <Button
                className="account-link"
                onClick={() => void Taro.navigateTo({ url: '/pages/service-area/index' })}
              >
                查看配送范围 ›
              </Button>
            </View>
            <View className="reward-action-dock">
              <Button
                className="points-cart-add"
                disabled={!valid || adding}
                onClick={() =>
                  void (async () => {
                    if (addLock.current) return;
                    addLock.current = true;
                    setAdding(true);
                    try {
                      await addAccountPointsCart(item.id, count);
                      await Taro.showToast({ title: '已加入购物车', icon: 'success' });
                    } catch (e) {
                      setError(e instanceof Error ? e.message : '加入失败');
                    } finally {
                      addLock.current = false;
                      setAdding(false);
                    }
                  })()
                }
              >
                加入购物车
              </Button>
              <Button
                className="points-action"
                disabled={!valid}
                onClick={() => {
                  try {
                    const previous = readPointsIntent();
                    if (previous?.result && previous.cleared)
                      Taro.removeStorageSync(pointsCheckoutKey);
                    void Taro.navigateTo({
                      url: '/pages/points-checkout/index?id=' + item.id + '&quantity=' + count,
                    });
                  } catch (e) {
                    setError(e instanceof Error ? e.message : '无法打开结算');
                  }
                }}
              >
                立即兑换
              </Button>
            </View>
          </>
        )}
      </View>
    </View>
  );
}
