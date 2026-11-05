import { LoadingState } from '../../components/LoadingState';
import { View, Text, Button, Image } from '@tarojs/components';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import { request } from '../../api';
import { addressRequest } from '../../address-api';
import { RewardCard } from '../../components/RewardCard';
import { openRewards } from '../../reward-navigation';
import type { Reward, RewardPage } from '../../rewards-api';
import { cartIdentity } from '../../account-cart';
import { CartRequestError } from '../../cart-merge';
import heroImage from '../../assets/yumi-hero.png';

export default function Index() {
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [guest, setGuest] = useState(false);
  const [balance, setBalance] = useState<string | null>(null);
  const sequence = useRef(0);
  const identitySequence = useRef(0);
  async function loadRewards() {
    const current = ++sequence.current;
    setLoading(true);
    setError(false);
    try {
      const page = await request<RewardPage>('/rewards');
      if (current === sequence.current) setRewards(page.items.slice(0, 6));
    } catch {
      if (current === sequence.current) setError(true);
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  }

  function cancel() {
    sequence.current++;
    identitySequence.current++;
  }

  useDidShow(() => {
    const current = ++identitySequence.current;
    setGuest(false);
    setBalance(null);
    void cartIdentity().then(
      async (identity) => {
        if (current !== identitySequence.current) return;
        setGuest(!identity);
        if (!identity) return;
        try {
          const account = await addressRequest<{ balance: string }>(identity, '/consumer/points');
          if (current === identitySequence.current) setBalance(account.balance);
        } catch {
          // Keep the points detail entry available when the balance cannot be read.
        }
      },
      (error: unknown) => {
        if (
          current === identitySequence.current &&
          error instanceof CartRequestError &&
          error.status === 401
        )
          setGuest(true);
      },
    );
    void loadRewards();
  });
  useDidHide(cancel);
  useEffect(() => cancel, []);

  return (
    <View className="store-page points-home">
      <View className="store-header">
        <View className="store-brand">
          <View className="points-brand-mark" aria-hidden="true">
            <View />
            <View />
            <View />
            <View />
          </View>
          <Text className="store-name">玉米百货</Text>
        </View>
        <Text className="points-store-tag">日常好物</Text>
      </View>
      <View className="store-content">
        <View className="points-store-hero">
          <Image className="points-hero-image" src={heroImage} mode="aspectFill" />
          <Text className="points-hero-kicker">YUMI DAILY</Text>
          <Text className="points-hero-title">用积分，换日常好物</Text>
          <Text className="points-hero-copy">把好物寄到家</Text>
        </View>
        <Button
          className="points-balance-strip"
          onClick={() =>
            void Taro.navigateTo({
              url: guest ? '/pages/login/index' : '/pages/points/index',
            })
          }
        >
          <Text>{guest ? '微信登录' : '可用积分'}</Text>
          {balance !== null && <Text className="points-balance-value">{balance}</Text>}
          <Text className="points-balance-link">{guest ? '查看我的积分 ›' : '积分明细 ›'}</Text>
        </Button>
        <View className="points-home-heading">
          <Text>精选可兑换</Text>
          <Button className="category-refresh" onClick={() => void openRewards()}>
            查看全部 ›
          </Button>
        </View>
        {loading ? (
          <LoadingState label="正在加载兑换商品…" />
        ) : error ? (
          <View className="category-error">
            <Text>商品加载失败</Text>
            <Button onClick={() => void loadRewards()}>重试商品</Button>
          </View>
        ) : rewards.length ? (
          <View className="reward-grid">
            {rewards.map((reward) => (
              <RewardCard key={reward.id} reward={reward} />
            ))}
          </View>
        ) : (
          <Text className="category-status">暂无兑换商品，欢迎稍后再来。</Text>
        )}
      </View>
    </View>
  );
}
