import { View, Text, Button, Input, ScrollView } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import { useState, useRef, useEffect } from 'react';
import { request } from '../../api';
import type { ProductCardPage, PublicCategory, PublicCategoryPage } from '../../api';
import { createBrowseLoader, initialBrowseState } from '../../browse-loader';
import { createCategoryLoader, initialCategoryState } from '../../category-loader';
import { ProductVisual } from '../../components/ProductVisual';
export default function Index() {
  const [browse, setBrowse] = useState(initialBrowseState);
  const [keyword, setKeyword] = useState('');
  const [tab, setTab] = useState('home');
  const [categories, setCategories] = useState(initialCategoryState);
  const [selectedCategory, setSelectedCategory] = useState<PublicCategory | null>(null);
  useEffect(() => {
    setSelectedCategory((selected) =>
      selected ? (categories.rows.find((c) => c.id === selected.id) ?? selected) : null,
    );
  }, [categories.rows]);
  const categoryLoader = useRef<ReturnType<typeof createCategoryLoader> | null>(null);
  if (!categoryLoader.current)
    categoryLoader.current = createCategoryLoader(
      (path) => request<PublicCategoryPage>(path),
      setCategories,
    );
  const loader = useRef<ReturnType<typeof createBrowseLoader> | null>(null);
  if (!loader.current)
    loader.current = createBrowseLoader((path) => request<ProductCardPage>(path), setBrowse);
  const { rows, keyword: activeKeyword, cursor, busy, error } = browse;
  const load = (search?: string, more = false) => loader.current!.load(search, more);
  useEffect(
    () => () => {
      loader.current?.cancel();
      categoryLoader.current?.cancel();
    },
    [],
  );
  useDidShow(() => {
    void load();
    void categoryLoader.current!.load();
  });
  function chooseCategory(category: PublicCategory | null, targetTab = 'category') {
    setTab(targetTab);
    setSelectedCategory(category);
    setKeyword('');
    void loader.current!.load('', false, category?.id ?? null);
  }
  const categoryName = selectedCategory
    ? selectedCategory.parentName
      ? `${selectedCategory.parentName} / ${selectedCategory.name}`
      : selectedCategory.name
    : '全部商品';
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
        <View className="category-panel">
          <View className="category-panel-heading">
            <Text>商品分类</Text>
            <Button
              className="category-refresh"
              disabled={categories.busy}
              onClick={() => {
                void categoryLoader.current!.load();
                void load();
              }}
            >
              刷新分类
            </Button>
          </View>
          <ScrollView scrollX className="category-scroll">
            <View className="category-chips">
              <Button
                className={`category-chip ${!selectedCategory ? 'selected' : ''}`}
                onClick={() => chooseCategory(null)}
              >
                全部商品
              </Button>
              {categories.rows.map((category) => (
                <Button
                  key={category.id}
                  className={`category-chip ${selectedCategory?.id === category.id ? 'selected' : ''}`}
                  onClick={() => chooseCategory(category)}
                >
                  {category.parentName
                    ? `${category.parentName} / ${category.name}`
                    : category.name}
                </Button>
              ))}
            </View>
          </ScrollView>
          {categories.busy && <Text className="category-status">正在加载分类…</Text>}
          {categories.error && (
            <View className="category-error">
              <Text>分类暂时没能加载：{categories.error}</Text>
              <Button onClick={() => void categoryLoader.current!.retry()}>重试分类</Button>
            </View>
          )}
          {!categories.busy && !categories.error && !categories.rows.length && (
            <Text className="category-status">暂无可浏览分类，可先查看全部商品。</Text>
          )}
          {categories.cursor && !categories.error && (
            <Button
              className="category-more"
              disabled={categories.busy}
              onClick={() => void categoryLoader.current!.load(true)}
            >
              更多分类
            </Button>
          )}
        </View>
        {tab === 'home' && !activeKeyword && !selectedCategory && (
          <View className="store-hero">
            <View className="hero-badge">日常好物 · 用心甄选</View>
            <Text className="hero-title">
              把日常，<Text>过得更好。</Text>
            </Text>
            <Text className="hero-copy">从一包柔软抽纸，到一份整洁生活</Text>
            <Button
              className="hero-button"
              onClick={() => {
                chooseCategory(null);
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
                  ? categoryName
                  : '为你精选'}
            </Text>
          </View>
          {activeKeyword ? (
            <Button className="section-link" disabled={busy} onClick={() => choose('')}>
              {selectedCategory ? '清除关键词' : '查看全部'}
            </Button>
          ) : (
            <Text className="section-subtitle">好好生活，从小事开始</Text>
          )}
        </View>
        {(selectedCategory || activeKeyword) && (
          <View className="category-context">
            <Text>
              当前分类：{categoryName}
              {activeKeyword ? ` · 关键词：${activeKeyword}` : ''}
            </Text>
            <Button onClick={() => chooseCategory(null)}>清除筛选</Button>
          </View>
        )}
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
            <Text className="feedback-copy">当前筛选下暂无商品，换个分类或清除筛选再看看吧</Text>
            <Button onClick={() => chooseCategory(null)}>看看全部商品</Button>
          </View>
        )}
        <View className={`product-grid ${tab === 'category' ? 'category-products' : ''}`}>
          {rows.map((row) => (
            <View
              key={row.id}
              className="product-card"
              onClick={() =>
                void Taro.navigateTo({ url: `/pages/product/index?id=${row.entrySkuId}` })
              }
            >
              <ProductVisual name={row.name} imageUrl={row.imageUrl} />
              <View className="product-info">
                <Text className="product-title">{row.name}</Text>
                <Text className="product-spec">
                  {row.variantCount > 1
                    ? `${row.variantCount}${activeKeyword ? '个匹配规格' : '种规格'} · 进入选择`
                    : `${row.spec} / ${row.unit}`}
                </Text>
                <Text className="product-price-note">
                  {row.hasStock
                    ? row.variantCount > 1
                      ? '有货规格起价'
                      : '当前规格售价'
                    : '缺货参考价'}
                </Text>
                <View className="product-bottom">
                  <Text className="product-price">
                    <Text>¥</Text>
                    {(row.priceCents / 100).toFixed(2)}
                    {row.variantCount > 1 && <Text className="price-from">起</Text>}
                  </Text>
                  <Text className={row.hasStock ? 'product-open' : 'product-out'}>
                    {row.hasStock ? (row.variantCount > 1 ? '选规格' : '查看') : '缺货'}
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
        <Text className="browse-note">未上传图片时显示包装示意 · 在线下单尚未开放</Text>
      </View>
      <View className="store-tabs">
        <Button
          className={tab === 'home' ? 'selected' : ''}
          onClick={() => {
            chooseCategory(null, 'home');
          }}
        >
          <Text>⌂</Text>
          <Text>首页</Text>
        </Button>
        <Button
          className={tab === 'category' ? 'selected' : ''}
          onClick={() => {
            chooseCategory(null);
          }}
        >
          <Text>▦</Text>
          <Text>分类</Text>
        </Button>
        <Button onClick={() => void Taro.navigateTo({ url: '/pages/cart/index' })}>
          <Text>♧</Text>
          <Text>
            购物车<Text className="coming-soon">本机草稿</Text>
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
