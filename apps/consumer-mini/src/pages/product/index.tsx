import { useState } from 'react';
import Taro, { useLoad } from '@tarojs/taro';
import { View, Text, Button } from '@tarojs/components';
import { request } from '../../api';
import type { SaleSku } from '../../api';
import { ProductVisual } from '../../components/ProductVisual';
export default function ProductDetail() {
  const [product, setProduct] = useState<SaleSku | null>(null),
    [id, setId] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(true);
  async function load(sku: string) {
    setBusy(true);
    setError('');
    try {
      if (!sku) throw Error('暂未找到这件商品');
      setProduct(await request<SaleSku>(`/products/${encodeURIComponent(sku)}`));
    } catch (e) {
      setError(e instanceof Error ? e.message : '商品加载失败');
      setProduct(null);
    } finally {
      setBusy(false);
    }
  }
  useLoad((params) => {
    setId(params.id ?? '');
    void load(params.id ?? '');
  });
  const back = () => void Taro.reLaunch({ url: '/pages/index/index' });
  return (
    <View className="detail-page">
      {busy && <View className="store-feedback">正在为你准备好物…</View>}
      {error && (
        <View className="store-feedback">
          <Text>{error}</Text>
          <Button onClick={() => void load(id)}>重新加载</Button>
          <Button onClick={back}>返回首页</Button>
        </View>
      )}
      {product && (
        <>
          <View className="detail-visual">
            <ProductVisual name={product.name} imageUrl={product.imageUrl} large />
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
            <View className="spec-choice">
              {product.spec} / {product.unit}
            </View>
            <Text className="detail-heading">商品介绍</Text>
            <Text className="detail-description">
              {product.description || '用心挑选日常好物，更多商品信息整理中。'}
            </Text>
            <View className="detail-tip">
              {product.imageUrl
                ? '商品主图由运营上传，具体以实际商品为准。'
                : '包装图为示意，具体以实际商品为准。'}
              当前开放商品浏览，在线下单和支付尚未开放。
            </View>
          </View>
          <View className="detail-footer">
            <Button className="back-home" onClick={back}>
              <Text>⌂</Text>首页
            </Button>
            <Button className="detail-buy" disabled>
              {product.available > 0 ? '在线下单待开放' : '商品暂时缺货'}
            </Button>
          </View>
        </>
      )}
    </View>
  );
}
