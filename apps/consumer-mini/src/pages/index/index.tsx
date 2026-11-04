import { View, Text, Button, Input } from '@tarojs/components';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import { request } from '../../api';
import type { PublicCategoryPage } from '../../api';
import { createCategoryLoader, initialCategoryState } from '../../category-loader';
import { RewardCard } from '../../components/RewardCard';
import { openRewards } from '../../reward-navigation';
import type { Reward, RewardPage } from '../../rewards-api';
import { cartIdentity } from '../../account-cart';
import { CartRequestError } from '../../cart-merge';

export default function Index() {
  const [keyword, setKeyword] = useState('');
  const [categories, setCategories] = useState(initialCategoryState);
  const [rewards, setRewards] = useState<Reward[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [guest, setGuest] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const sequence = useRef(0);
  const identitySequence = useRef(0);
  const loader = useRef<ReturnType<typeof createCategoryLoader> | null>(null);
  if (!loader.current)
    loader.current = createCategoryLoader(
      (path) => request<PublicCategoryPage>(path),
      setCategories,
    );

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
    loader.current?.cancel();
  }

  useDidShow(() => {
    const current = ++identitySequence.current;
    setGuest(false);
    void cartIdentity().then(
      (identity) => {
        if (current === identitySequence.current) setGuest(!identity);
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
    void loader.current!.load();
    void loadRewards();
  });
  useDidHide(cancel);
  useEffect(() => cancel, []);

  return (
    <View className="store-page points-home">
      <View className="store-header">
        <View className="store-brand">
          <Text className="corn">🌽</Text>
          <View>
            <Text className="store-name">玉米百货</Text>
            <Text className="store-tagline">积分兑换日常好物</Text>
          </View>
        </View>
        <View className="store-search">
          <Input
            value={keyword}
            maxlength={80}
            placeholder="搜索兑换商品"
            confirmType="search"
            onInput={(event) => setKeyword(event.detail.value)}
            onConfirm={() => void openRewards(keyword.trim())}
          />
          <Button onClick={() => void openRewards(keyword.trim())}>搜索</Button>
        </View>
      </View>
      <View className="store-content">
        {guest && !dismissed && (
          <View className="points-login-hint">
            <Button
              className="category-refresh"
              onClick={() => void Taro.navigateTo({ url: '/pages/login/index' })}
            >
              微信登录，查看我的积分 ›
            </Button>
            <Button className="category-refresh" onClick={() => setDismissed(true)}>
              稍后
            </Button>
          </View>
        )}
        <View className="category-panel">
          <View className="category-panel-heading">
            <Text>商品分类</Text>
          </View>
          <View className="points-home-categories">
            <Button className="category-chip" onClick={() => void openRewards()}>
              全部好物
            </Button>
            {categories.rows.map((category) => (
              <Button
                key={category.id}
                className="category-chip"
                onClick={() => void openRewards('', category.id)}
              >
                {category.parentName ? category.parentName + ' / ' : ''}
                {category.name}
              </Button>
            ))}
          </View>
          {categories.busy && <Text className="category-status">正在加载分类…</Text>}
          {categories.error && (
            <View className="category-error">
              <Text>分类加载失败</Text>
              <Button onClick={() => void loader.current!.retry()}>重试分类</Button>
            </View>
          )}
          {!categories.busy && !categories.error && !categories.rows.length && (
            <Text className="category-status">暂无分类，可查看全部好物。</Text>
          )}
          {categories.cursor && !categories.error && (
            <Button
              className="category-more"
              disabled={categories.busy}
              onClick={() => void loader.current!.load(true)}
            >
              更多分类
            </Button>
          )}
        </View>
        <View className="points-home-heading">
          <Text>精选兑换</Text>
          <Button className="category-refresh" onClick={() => void openRewards()}>
            查看全部 ›
          </Button>
        </View>
        {loading ? (
          <Text className="category-status">正在加载兑换商品…</Text>
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
