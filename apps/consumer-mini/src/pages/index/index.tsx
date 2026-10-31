import { View, Text, Button, Input } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import { useState, useRef, useEffect } from 'react';
import { request } from '../../api';
import type { ProductPage } from '../../api';
import { createBrowseLoader, initialBrowseState } from '../../browse-loader';
import { ProductVisual } from '../../components/ProductVisual';
const themes = [
  { name: '全部好物', icon: '▦', keyword: '', tone: 'cream' },
  { name: '日用纸品', icon: '▤', keyword: '纸', tone: 'pink' },
  { name: '衣物清洁', icon: '♧', keyword: '洗', tone: 'mint' },
  { name: '家居收纳', icon: '▣', keyword: '袋', tone: 'blue' },
];
export default function Index() {
  const [browse, setBrowse] = useState(initialBrowseState);
  const [keyword, setKeyword] = useState('');
  const [tab, setTab] = useState('home');
  const loader = useRef<ReturnType<typeof createBrowseLoader> | null>(null);
  if (!loader.current)
    loader.current = createBrowseLoader((path) => request<ProductPage>(path), setBrowse);
  const { rows, keyword: activeKeyword, cursor, busy, error } = browse;
  const load = (search?: string, more = false) => loader.current!.load(search, more);
  useEffect(() => () => loader.current?.cancel(), []);
  useDidShow(() => {
    void load();
  });
  function choose(search: string) {
    setKeyword(search);
    void load(search);
  }
  const upcoming = (name: string) =>
    void Taro.showModal({
      title: `${name}暂未开放`,
      content: '当前可以浏览与查找商品，在线下单和个人服务将在开放后提供。',
      showCancel: false,
    });
  return (
    <View className="store-page">
      <View className="store-header">
        <View className="store-brand">
          <Text className="corn">🌽</Text>
          <View>
            <Text className="store-name">玉米百货</Text>
            <Text className="store-tagline">家门口的好生活</Text>
          </View>
        </View>
        <View className="community">
          <Text>⌂ 单小区配送</Text>
          <Text className="community-note">用心选好物</Text>
        </View>
        <View className="store-search">
          <Text className="search-symbol">⌕</Text>
          <Input
            value={keyword}
            maxlength={80}
            placeholder="纸巾、洗衣液、日用好物…"
            onInput={(e) => setKeyword(e.detail.value)}
            onConfirm={() => void load(keyword.trim())}
            confirmType="search"
          />
          <Button disabled={busy} onClick={() => void load(keyword.trim())}>
            搜索
          </Button>
        </View>
      </View>
      <View className="store-content">
        <Text className="browse-note">快捷找好物 · 按关键词查找，完整商品分类待开放</Text>
        <View className="theme-grid">
          {themes.map((t) => (
            <Button
              className="theme"
              key={t.name}
              disabled={busy}
              onClick={() => {
                setTab('category');
                choose(t.keyword);
              }}
            >
              <View className={`theme-icon ${t.tone}`}>{t.icon}</View>
              <Text>{t.name}</Text>
            </Button>
          ))}
        </View>
        {tab === 'home' && !activeKeyword && (
          <View className="store-hero">
            <View className="hero-badge">日常好物 · 用心甄选</View>
            <Text className="hero-title">
              把日常，<Text>过得更好。</Text>
            </Text>
            <Text className="hero-copy">从一包柔软抽纸，到一份整洁生活</Text>
            <Button
              className="hero-button"
              onClick={() => {
                setTab('category');
                choose('');
              }}
            >
              逛逛好物 →
            </Button>
            <View className="hero-art">
              <View className="hero-circle" />
              <View className="hero-stack one" />
              <View className="hero-stack two" />
              <View className="hero-bottle" />
              <View className="hero-leaf" />
            </View>
          </View>
        )}
        <View className="store-section-title">
          <View>
            <Text className="section-en">EVERYDAY ESSENTIALS</Text>
            <Text className="section-name">
              {activeKeyword
                ? `“${activeKeyword}”相关好物`
                : tab === 'category'
                  ? '全部商品'
                  : '为你精选'}
            </Text>
          </View>
          {activeKeyword ? (
            <Button className="section-link" disabled={busy} onClick={() => choose('')}>
              查看全部
            </Button>
          ) : (
            <Text className="section-subtitle">好好生活，从小事开始</Text>
          )}
        </View>
        {error && (
          <View className="store-feedback">
            <Text>暂时没能加载商品</Text>
            <Text className="feedback-copy">{error}</Text>
            <Button onClick={() => void loader.current!.retry()}>重新加载</Button>
          </View>
        )}
        {busy && !rows.length && (
          <View className="product-grid">
            {[0, 1, 2, 3].map((i) => (
              <View key={i} className="product-card skeleton">
                <View />
                <Text />
                <Text />
              </View>
            ))}
          </View>
        )}
        {!busy && !error && !rows.length && (
          <View className="store-feedback">
            <Text className="empty-symbol">⌕</Text>
            <Text>还没找到这件好物</Text>
            <Text className="feedback-copy">换个关键词，或看看其他商品吧</Text>
            <Button onClick={() => choose('')}>看看全部商品</Button>
          </View>
        )}
        <View className={`product-grid ${tab === 'category' ? 'category-products' : ''}`}>
          {rows.map((row) => (
            <View
              key={row.id}
              className="product-card"
              onClick={() => void Taro.navigateTo({ url: `/pages/product/index?id=${row.id}` })}
            >
              <ProductVisual name={row.name} imageUrl={row.imageUrl} />
              <View className="product-info">
                <Text className="product-title">{row.name}</Text>
                <Text className="product-spec">
                  {row.spec} / {row.unit}
                </Text>
                <View className="product-bottom">
                  <Text className="product-price">
                    <Text>¥</Text>
                    {(row.priceCents / 100).toFixed(2)}
                  </Text>
                  <Text className={row.available > 0 ? 'product-open' : 'product-out'}>
                    {row.available > 0 ? '›' : '缺货'}
                  </Text>
                </View>
              </View>
            </View>
          ))}
        </View>
        {cursor && !error && (
          <Button
            className="load-more"
            disabled={busy}
            onClick={() => void load(activeKeyword, true)}
          >
            {busy ? '正在加载…' : '再看看更多好物'}
          </Button>
        )}
        {!busy && rows.length > 0 && !cursor && (
          <Text className="store-end">— 每一份日常，都值得用心 —</Text>
        )}
        <Text className="browse-note">商品包装为示意图 · 在线下单尚未开放</Text>
      </View>
      <View className="store-tabs">
        <Button
          className={tab === 'home' ? 'selected' : ''}
          onClick={() => {
            setTab('home');
            choose('');
          }}
        >
          <Text>⌂</Text>
          <Text>首页</Text>
        </Button>
        <Button
          className={tab === 'category' ? 'selected' : ''}
          onClick={() => {
            setTab('category');
            choose('');
          }}
        >
          <Text>▦</Text>
          <Text>找好物</Text>
        </Button>
        <Button onClick={() => upcoming('购物车')}>
          <Text>♧</Text>
          <Text>
            购物车<Text className="coming-soon">待开放</Text>
          </Text>
        </Button>
        <Button onClick={() => upcoming('我的服务')}>
          <Text>♙</Text>
          <Text>
            我的<Text className="coming-soon">待开放</Text>
          </Text>
        </Button>
      </View>
    </View>
  );
}
