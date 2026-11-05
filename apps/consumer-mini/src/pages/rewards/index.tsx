import { LoadingState } from '../../components/LoadingState';
import { View, Text, Button, Input, ScrollView } from '@tarojs/components';
import { useDidShow, useDidHide } from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import { request } from '../../api';
import type { PublicCategory } from '../../api';
import type { Reward, RewardPage } from '../../rewards-api';
import { RewardCard } from '../../components/RewardCard';
import { takeRewardFilter } from '../../reward-navigation';
export default function Rewards() {
  const [items, setItems] = useState<Reward[]>([]),
    [keyword, setKeyword] = useState(''),
    [category, setCategory] = useState(''),
    [categories, setCategories] = useState<PublicCategory[]>([]),
    [categoryCursor, setCategoryCursor] = useState<string | null>(null),
    [categoryError, setCategoryError] = useState(''),
    [categoryLoading, setCategoryLoading] = useState(false),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const seq = useRef(0),
    categorySeq = useRef(0),
    applied = useRef({ keyword: '', category: '' }),
    pending = useRef<string | undefined>(undefined);
  async function load(next?: string) {
    const n = ++seq.current;
    pending.current = next;
    setLoading(true);
    setError('');
    if (!next) {
      setItems([]);
      setCursor(null);
    }
    const q = [];
    if (applied.current.keyword) q.push('keyword=' + encodeURIComponent(applied.current.keyword));
    if (applied.current.category)
      q.push('categoryId=' + encodeURIComponent(applied.current.category));
    if (next) q.push('cursor=' + encodeURIComponent(next));
    try {
      const p = await request<RewardPage>('/rewards?' + q.join('&'));
      if (n !== seq.current) return;
      setItems((old) => (next ? [...old, ...p.items] : p.items));
      setCursor(p.nextCursor);
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '商城加载失败');
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }
  async function loadCategories(next?: string) {
    const n = ++categorySeq.current;
    setCategoryLoading(true);
    setCategoryError('');
    try {
      const p = await request<{ items: PublicCategory[]; nextCursor: string | null }>(
        '/categories' + (next ? '?cursor=' + next : ''),
      );
      if (n === categorySeq.current) {
        setCategories((old) => (next ? [...old, ...p.items] : p.items));
        setCategoryCursor(p.nextCursor);
      }
    } catch {
      if (n === categorySeq.current) setCategoryError('分类读取失败');
    } finally {
      if (n === categorySeq.current) setCategoryLoading(false);
    }
  }
  useDidShow(() => {
    const filter = takeRewardFilter();
    if (filter) {
      applied.current = filter;
      setKeyword(filter.keyword);
      setCategory(filter.category);
    }
    void load();
    void loadCategories();
  });
  useDidHide(() => {
    seq.current++;
    categorySeq.current++;
  });
  useEffect(
    () => () => {
      seq.current++;
      categorySeq.current++;
    },
    [],
  );
  const query = () => {
    applied.current = { keyword: keyword.trim(), category };
    void load();
  };
  return (
    <View className="account-page rewards-page">
      <View className="account-content">
        <View className="reward-catalog-heading">
          <Text className="account-eyebrow">YUMI DAILY</Text>
          <Text className="account-name">兑换好物</Text>
          <Text className="account-copy">按名称或分类查找可兑换商品</Text>
        </View>
        <View className="reward-search">
          <Input
            value={keyword}
            maxlength={80}
            placeholder="搜索兑换好物"
            onInput={(e) => setKeyword(e.detail.value)}
            confirmType="search"
            onConfirm={query}
          />
          <Button disabled={loading} onClick={query}>
            搜索
          </Button>
        </View>
        <ScrollView scrollX className="reward-category-scroll">
          <View className="reward-categories reward-category-track">
            <Button
              className={category === '' ? 'active' : ''}
              onClick={() => {
                setCategory('');
                applied.current = { keyword: keyword.trim(), category: '' };
                void load();
              }}
            >
              全部
            </Button>
            {categories.map((c) => (
              <Button
                key={c.id}
                className={category === c.id ? 'active' : ''}
                onClick={() => {
                  setCategory(c.id);
                  applied.current = { keyword: keyword.trim(), category: c.id };
                  void load();
                }}
              >
                {c.parentName ? c.parentName + ' / ' : ''}
                {c.name}
              </Button>
            ))}
            {categoryCursor && (
              <Button
                disabled={categoryLoading}
                onClick={() => void loadCategories(categoryCursor)}
              >
                更多分类
              </Button>
            )}
          </View>
        </ScrollView>
        {categoryError && (
          <Button disabled={categoryLoading} onClick={() => void loadCategories()}>
            {categoryError}，重试
          </Button>
        )}
        {loading && <LoadingState label="正在读取兑换商品…" />}
        {error && (
          <View className="account-error">
            <Text>{error}</Text>
            <Button
              className="points-action"
              disabled={loading}
              onClick={() => void load(pending.current)}
            >
              重试读取
            </Button>
            <Button className="points-action" disabled={loading} onClick={() => void load()}>
              重新查询
            </Button>
          </View>
        )}
        {!loading && !error && !items.length && (
          <View className="account-card">
            <Text className="account-card-title">暂无兑换商品</Text>
            <Text className="account-copy">可以换个关键词，或稍后再来逛逛。</Text>
          </View>
        )}
        <View className="reward-grid">
          {items.map((reward) => (
            <RewardCard key={reward.id} reward={reward} />
          ))}
        </View>
        {cursor && !error && (
          <Button className="points-action" disabled={loading} onClick={() => void load(cursor)}>
            加载更多
          </Button>
        )}
      </View>
    </View>
  );
}
