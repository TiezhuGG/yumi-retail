import { useEffect, useRef, useState } from 'react';
import Taro, { useLoad } from '@tarojs/taro';
import { View, Text, Button, Swiper, SwiperItem } from '@tarojs/components';
import { request } from '../../api';
import { createDetailLoader, initialDetailState } from '../../detail-loader';
import { guestCart } from '../../cart-storage';
import { ProductVisual } from '../../components/ProductVisual';
export default function ProductDetail() {
  const [state, setState] = useState(initialDetailState),
    [imageIndex, setImageIndex] = useState(0);
  const loader = useRef<ReturnType<typeof createDetailLoader> | null>(null);
  if (!loader.current) loader.current = createDetailLoader(request, setState);
  useEffect(() => () => loader.current?.cancel(), []);
  useLoad((params) => {
    void loader.current!.load(params.id ?? '');
  });
  const { detail: product, busy, error } = state;
  useEffect(() => {
    // Clearing a long detail page can leave native scrolling below the error/retry controls.
    if (busy || error) void Taro.pageScrollTo({ scrollTop: 0, duration: 0 }).catch(() => {});
  }, [busy, error]);
  useEffect(() => setImageIndex(0), [product?.id]);
  const images = product?.imageUrls?.length
    ? product.imageUrls
    : product?.imageUrl
      ? [product.imageUrl]
      : [];
  function addToCart() {
    if (!product) return;
    try {
      guestCart.add(product);
      void Taro.showToast({ title: '已加入本机草稿', icon: 'success' });
    } catch (e) {
      void Taro.showModal({
        title: '未能加入购物车',
        content: e instanceof Error ? e.message : '请重试',
        showCancel: false,
      });
    }
  }
  const back = () => void Taro.reLaunch({ url: '/pages/index/index' });
  return (
    <View className="detail-page">
      {busy && <View className="store-feedback">正在为你准备好物…</View>}
      {error && (
        <View className="store-feedback">
          <Text>{error}</Text>
          <Button onClick={() => void loader.current!.retry()}>重新加载</Button>
          <Button onClick={back}>返回首页</Button>
        </View>
      )}
      {product && (
        <>
          <View className="detail-visual">
            {images.length ? (
              <>
                <Swiper
                  className="detail-gallery"
                  current={imageIndex}
                  onChange={(e) => setImageIndex(e.detail.current)}
                >
                  {images.map((url) => (
                    <SwiperItem key={url}>
                      <ProductVisual name={product.name} imageUrl={url} large />
                    </SwiperItem>
                  ))}
                </Swiper>
                <Text className="detail-image-count">
                  {imageIndex + 1} / {images.length}
                </Text>
                {images.length > 1 && (
                  <View className="detail-gallery-controls">
                    <Button disabled={imageIndex === 0} onClick={() => setImageIndex((i) => i - 1)}>
                      上一张
                    </Button>
                    <Text>左右滑动查看商品图片</Text>
                    <Button
                      disabled={imageIndex === images.length - 1}
                      onClick={() => setImageIndex((i) => i + 1)}
                    >
                      下一张
                    </Button>
                  </View>
                )}
              </>
            ) : (
              <ProductVisual name={product.name} large />
            )}
            <View className="detail-caption">日常好物 / YUMI ESSENTIALS</View>
          </View>
          <View className="detail-card">
            <View className="detail-price">
              <Text>¥</Text>
              {(product.priceCents / 100).toFixed(2)}
              <Text className="detail-unit"> / {product.unit}</Text>
            </View>
            <Text className="detail-name">{product.name}</Text>
            <Text className="detail-spec">{product.spec}</Text>
            <View className="detail-promises">
              <Text>✓ 按规格售卖</Text>
              <Text>✓ 社区配送</Text>
              <Text>{product.available > 0 ? '✓ 当前有货' : '暂时缺货'}</Text>
            </View>
          </View>
          <View className="detail-card">
            <Text className="detail-heading">商品规格</Text>
            <Text className="detail-spec-help">
              选择规格查看对应售价与有货状态，信息以重新加载结果为准。
            </Text>
            <View className="detail-spec-options">
              {product.variants.map((variant) => (
                <Button
                  key={variant.id}
                  className={`spec-choice ${variant.id === product.id ? 'selected' : ''} ${variant.spec.length > 40 ? 'wide' : ''}`}
                  aria-label={`${variant.spec} / ${variant.unit}${variant.id === product.id ? '，已选' : ''}`}
                  onClick={() => {
                    if (variant.id !== product.id) void loader.current!.load(variant.id);
                  }}
                >
                  <Text className="spec-option-name">
                    {variant.spec} / {variant.unit}
                  </Text>
                  <Text className="spec-option-price">
                    ¥{(variant.priceCents / 100).toFixed(2)}
                  </Text>
                  <Text className="spec-option-status">
                    {variant.id === product.id ? '已选 · ' : ''}
                    {variant.available > 0 ? '当前有货' : '暂时缺货'}
                  </Text>
                </Button>
              ))}
            </View>
            <Button
              className="detail-refresh"
              onClick={() => void loader.current!.load(product.id)}
            >
              刷新当前规格
            </Button>
            <Text className="detail-heading">商品介绍</Text>
            <Text className="detail-description">
              {product.description || '用心挑选日常好物，更多商品信息整理中。'}
            </Text>
            <View className="detail-tip">
              {product.imageUrl
                ? '商品图片由运营上传，具体以实际商品为准。'
                : '包装图为示意，具体以实际商品为准。'}
              当前开放商品浏览，在线下单和支付尚未开放。
            </View>
          </View>
          <View className="detail-footer">
            <Button className="back-home" onClick={back}>
              <Text>⌂</Text>首页
            </Button>
            <Button
              className="detail-cart-link"
              onClick={() => void Taro.navigateTo({ url: '/pages/cart/index' })}
            >
              购物车草稿
            </Button>
            <Button className="detail-buy" disabled={product.available < 1} onClick={addToCart}>
              {product.available > 0 ? '加入本机草稿' : '商品暂时缺货'}
            </Button>
          </View>
        </>
      )}
    </View>
  );
}
