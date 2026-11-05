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
    [categoryOpen, setCategoryOpen] = useState(false),
    [categories, setCategories] = useState<PublicCategory[]>([]),
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
  async function loadCategories() {
    const n = ++categorySeq.current;
    setCategoryLoading(true);
    setCategoryError('');
    const all: PublicCategory[] = [],
      seen = new Set<string>();
    let next: string | null = null;
    try {
      do {
        const p: { items: PublicCategory[]; nextCursor: string | null } = await request(
          '/categories' + (next ? '?cursor=' + encodeURIComponent(next) : ''),
        );
        if (n !== categorySeq.current) return;
        all.push(...p.items);
        setCategories([...new Map(all.map((c) => [c.id, c])).values()]);
        next = p.nextCursor;
        if (next && seen.has(next)) throw Error('分类列表已变化，请重试');
        if (next) seen.add(next);
      } while (next);
    } catch {
      if (n === categorySeq.current) setCategoryError('分类未能全部加载，请重试');
    } finally {
      if (n === categorySeq.current) setCategoryLoading(false);
    }
  }
  function selectCategory(id: string) {
    setCategory(id);
    setCategoryOpen(false);
    applied.current = { keyword: keyword.trim(), category: id };
    void load();
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
    setCategoryOpen(false);
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
        <View className="reward-filter-bar">
          <Text className="reward-filter-current">
            {category
              ? (categories.find((c) => c.id === category)?.name ?? '已选分类')
              : '全部商品'}
          </Text>
          <Button
            className="reward-filter-button"
            onClick={() => {
              setCategoryOpen(true);
              void loadCategories();
            }}
          >
            选择分类 ▾
          </Button>
          {category && (
            <Button className="reward-filter-clear" onClick={() => selectCategory('')}>
              清除筛选
            </Button>
          )}
        </View>
        {categoryOpen && (
          <View
            className="category-popup-backdrop"
            catchMove
            onClick={() => setCategoryOpen(false)}
          >
            <View
              className="category-popup"
              onClick={(e) => e.stopPropagation()}
              aria-label="选择商品分类"
            >
              <View className="category-popup-heading">
                <View>
                  <Text className="category-popup-title">商品分类</Text>
                  <Text className="account-copy">选择标签，找到想兑换的好物</Text>
                </View>
                <Button
                  aria-label="关闭分类"
                  className="category-popup-close"
                  onClick={() => setCategoryOpen(false)}
                >
                  ×
                </Button>
              </View>
              <ScrollView scrollY className="category-popup-scroll">
                <View className="category-popup-tags">
                  <Button
                    className={!category ? 'selected' : ''}
                    onClick={() => selectCategory('')}
                  >
                    全部商品
                  </Button>
                  {categories.map((c) => (
                    <Button
                      key={c.id}
                      className={category === c.id ? 'selected' : ''}
                      onClick={() => selectCategory(c.id)}
                    >
                      {c.parentName ? c.parentName + ' / ' : ''}
                      {c.name}
                    </Button>
                  ))}
                </View>
                {categoryLoading && <Text className="account-copy">正在读取全部分类…</Text>}
                {!categoryLoading && !categories.length && !categoryError && (
                  <Text className="account-copy">暂时没有商品分类</Text>
                )}
                {categoryError && (
                  <View className="account-error">
                    <Text>{categoryError}</Text>
                    <Button onClick={() => void loadCategories()}>重试加载分类</Button>
                  </View>
                )}
              </ScrollView>
            </View>
          </View>
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
