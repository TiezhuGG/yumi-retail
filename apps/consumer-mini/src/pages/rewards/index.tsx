import { View, Text, Button, Input } from '@tarojs/components';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import { request } from '../../api';
import type { PublicCategory } from '../../api';
import type { Reward, RewardPage } from '../../rewards-api';
import { ProductVisual } from '../../components/ProductVisual';
import { cartIdentity } from '../../account-cart';
import { addressRequest } from '../../address-api';
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
    [error, setError] = useState(''),
    [balance, setBalance] = useState('登录查看积分');
  const seq = useRef(0),
    accountSeq = useRef(0),
    categorySeq = useRef(0),
    applied = useRef({ keyword: '', category: '' }),
    pending = useRef<string | undefined>(undefined);
  async function load(next?: string) {
    const n = ++seq.current;
    pending.current = next;
    setLoading(true);
    setError('');
    const q = [];
    if (applied.current.keyword) q.push('keyword=' + encodeURIComponent(applied.current.keyword));
    if (applied.current.category) q.push('categoryId=' + applied.current.category);
    if (next) q.push('cursor=' + next);
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
  async function account() {
    const n = ++accountSeq.current;
    setBalance('正在读取积分…');
    try {
      const identity = await cartIdentity();
      if (n !== accountSeq.current) return;
      if (!identity) {
        setBalance('登录查看积分');
        return;
      }
      const p = await addressRequest<{ balance: string }>(identity, '/consumer/points');
      if (n === accountSeq.current) setBalance(p.balance + ' 积分');
    } catch {
      if (n === accountSeq.current) setBalance('积分读取失败，点击重试');
    }
  }
  useDidShow(() => {
    void load();
    void loadCategories();
    void account();
  });
  useDidHide(() => {
    seq.current++;
    accountSeq.current++;
    categorySeq.current++;
    setBalance('登录查看积分');
  });
  useEffect(
    () => () => {
      seq.current++;
      accountSeq.current++;
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
      <View className="account-hero">
        <Text className="account-eyebrow">YUMI · 好物积分</Text>
        <Text className="account-name">积分商城</Text>
        <Text className="account-copy">把每一份心意，留给日常好生活</Text>
        <Button
          className="reward-balance"
          onClick={() =>
            balance.includes('失败')
              ? void account()
              : void Taro.navigateTo({ url: '/pages/points/index' })
          }
        >
          {balance} ›
        </Button>
      </View>
      <View className="account-content">
        <View className="reward-notice">
          <Text>商城商品可浏览，正式兑换尚未开放；本机开发兑换仅用于隔离验证。</Text>
          <Text>积分不兑换现金；具体兑换、配送与售后规则正式开放前公布。</Text>
        </View>
        <View className="reward-search">
          <Input
            value={keyword}
            maxlength={80}
            placeholder="搜索兑换好物"
            onInput={(e) => setKeyword(e.detail.value)}
            onConfirm={query}
          />
          <Button disabled={loading} onClick={query}>
            搜索
          </Button>
        </View>
        <View className="reward-categories">
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
            <Button disabled={categoryLoading} onClick={() => void loadCategories(categoryCursor)}>
              更多分类
            </Button>
          )}
        </View>
        {categoryError && (
          <Button disabled={categoryLoading} onClick={() => void loadCategories()}>
            {categoryError}，重试
          </Button>
        )}
        {loading && <Text className="account-copy">正在读取兑换商品…</Text>}
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
          {items.map((r) => (
            <View
              className="reward-card"
              key={r.id}
              onClick={() => void Taro.navigateTo({ url: '/pages/reward/index?id=' + r.id })}
            >
              <ProductVisual name={r.name} imageUrl={r.imageUrl} />
              <View className="reward-card-copy">
                <Text className="reward-title">{r.title}</Text>
                <Text className="account-copy">
                  {r.spec} / {r.unit}
                </Text>
                <Text className="reward-price">
                  {r.pointsPrice} <Text>积分</Text>
                </Text>
                <Text className="reward-stock">
                  {r.available > 0 ? '每人限兑 ' + r.perUserLimit + ' 件' : '暂时缺货'}
                </Text>
                <Button
                  className="points-action"
                  onClick={(e) => {
                    e.stopPropagation();
                    void Taro.navigateTo({ url: '/pages/reward/index?id=' + r.id });
                  }}
                >
                  查看详情
                </Button>
              </View>
            </View>
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
