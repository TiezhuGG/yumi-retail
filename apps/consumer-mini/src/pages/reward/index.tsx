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
    [quantity, setQuantity] = useState('1');
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
    <View className="account-page reward-detail-page">
      <View className="account-content">
        {loading && <Text className="account-copy">正在读取商品详情…</Text>}
        {error && (
          <View className="account-error">
            <Text>{error}</Text>
            <Button className="points-action" onClick={() => void load()}>
              重试读取
            </Button>
            <Button
              className="points-action"
              onClick={() => void Taro.navigateTo({ url: '/pages/rewards/index' })}
            >
              返回积分商城
            </Button>
          </View>
        )}
        {item && (
          <>
            <ProductVisual name={item.name} imageUrl={item.imageUrl} large />
            <View className="account-card">
              <Text className="account-eyebrow">积分兑换好物</Text>
              <Text className="account-card-title">{item.title}</Text>
              <Text className="account-copy">
                {item.name} · {item.spec} / {item.unit}
              </Text>
              <Text className="reward-price">{item.pointsPrice} 积分 / 件</Text>
              <Text className="account-copy">{item.description || '暂无更多商品说明'}</Text>
            </View>
            <View className="account-card">
              <Text className="account-card-title">兑换数量与限额</Text>
              <Text className="account-copy">
                每人累计限兑 {item.perUserLimit} 件 · 总配额 {item.totalQuota} 件
              </Text>
              <Text className="account-copy">
                {item.available > 0
                  ? '当前最多可选 ' + item.available + ' 件，最终以提交核验为准'
                  : '当前暂时缺货'}
              </Text>
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
              <Text className="reward-price">
                合计 {valid ? String(Number(item.pointsPrice) * count) : '—'} 积分
              </Text>
              {!valid && <Text className="account-copy">请填写可选范围内的整数件数。</Text>}
            </View>
            <View className="account-card">
              <Text className="account-card-title">兑换说明</Text>
              <Text className="account-copy">
                {item.startsAt ? '开始：' + time(item.startsAt) + '（北京时间）' : '开始时间不限'}
                {item.endsAt ? '；结束：' + time(item.endsAt) + '（北京时间）' : '；结束时间不限'}
              </Text>
              <Text className="account-copy">
                当前仅展示商品与积分合计，不扣积分、不占用库存。配送、取消与售后规则待正式开放前公布。
              </Text>
              <Button
                className="account-link"
                onClick={() => void Taro.navigateTo({ url: '/pages/service-area/index' })}
              >
                查看配送范围 →
              </Button>
              <Button className="points-action" disabled>
                兑换下单待开放
              </Button>
            </View>
          </>
        )}
      </View>
    </View>
  );
}
