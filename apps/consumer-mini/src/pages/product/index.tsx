import { useState } from 'react';
import Taro, { useLoad } from '@tarojs/taro';
import { View, Text, Button } from '@tarojs/components';
import { request } from '../../api';
import type { SaleSku } from '../../api';
export default function ProductDetail() {
  const [product, setProduct] = useState<SaleSku | null>(null);
  const [id, setId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  async function load(skuId: string) {
    setBusy(true);
    setError('');
    try {
      if (!skuId) throw new Error('商品编号无效');
      setProduct(await request<SaleSku>(`/products/${encodeURIComponent(skuId)}`));
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载失败');
      setProduct(null);
    } finally {
      setBusy(false);
    }
  }
  useLoad((params) => {
    setId(params.id ?? '');
    void load(params.id ?? '');
  });
  return (
    <View style={{ padding: '24px' }}>
      {busy && <Text>正在加载商品…</Text>}
      {error && (
        <View>
          <Text>{error}</Text>
          <Button disabled={busy} onClick={() => void load(id)}>
            重试
          </Button>
        </View>
      )}
      {product && (
        <View>
          <Text style={{ fontSize: '24px', fontWeight: 'bold' }}>{product.name}</Text>
          <View style={{ marginTop: '16px' }}>
            <Text>
              {product.spec} / {product.unit}
            </Text>
          </View>
          <View style={{ marginTop: '16px', color: '#008a42' }}>
            <Text>¥{(product.priceCents / 100).toFixed(2)}</Text>
          </View>
          <View style={{ marginTop: '16px' }}>
            <Text>{product.available > 0 ? `当前可售 ${product.available} 件` : '暂时缺货'}</Text>
          </View>
          <View style={{ marginTop: '24px' }}>
            <Text>{product.description || '暂无更多商品说明'}</Text>
          </View>
          <View style={{ marginTop: '24px', color: '#667085' }}>
            <Text>当前为浏览演示，购物车和支付尚未开放。</Text>
          </View>
        </View>
      )}
      <Button style={{ marginTop: '24px' }} onClick={() => void Taro.navigateBack()}>
        返回商品列表
      </Button>
    </View>
  );
}
