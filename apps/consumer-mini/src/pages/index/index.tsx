import { View, Text, Button, Input } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import { useState } from 'react';
import { request } from '../../api';
import type { ProductPage, SaleSku } from '../../api';
export default function Index() {
  const [rows, setRows] = useState<SaleSku[]>([]);
  const [keyword, setKeyword] = useState('');
  const [activeKeyword, setActiveKeyword] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load(search = activeKeyword, more = false) {
    setBusy(true);
    setError('');
    try {
      const result = await request<ProductPage>(
        `/products?limit=20${search ? `&keyword=${encodeURIComponent(search)}` : ''}${more && cursor ? `&cursor=${cursor}` : ''}`,
      );
      setRows((old) => (more ? [...old, ...result.items] : result.items));
      setCursor(result.nextCursor);
      setActiveKeyword(search);
    } catch (err) {
      setError(err instanceof Error ? err.message : '连接未能完成，请检查网络后重试');
    } finally {
      setBusy(false);
    }
  }
  useDidShow(() => {
    void load();
  });
  return (
    <View style={{ padding: '24px', background: '#f3f4f6', minHeight: '100vh' }}>
      <Text style={{ color: '#008a42', fontSize: '24px', fontWeight: 'bold' }}>玉米百货</Text>
      <View
        style={{ marginTop: '20px', padding: '20px', background: '#fff', borderRadius: '12px' }}
      >
        <Text>开发演示 · 单小区配送</Text>
        <View style={{ marginTop: '12px', color: '#667085' }}>
          <Text>商品来自实际入库数据，当前仅开放浏览。</Text>
        </View>
        <Input
          placeholder="搜索商品名称或规格"
          maxlength={80}
          value={keyword}
          onInput={(event) => setKeyword(event.detail.value)}
          style={{ marginTop: '16px', padding: '12px', background: '#f3f4f6', borderRadius: '8px' }}
        />
        <Button size="mini" disabled={busy} onClick={() => void load(keyword.trim())}>
          搜索
        </Button>
        <Button
          size="mini"
          disabled={busy}
          onClick={() => {
            setKeyword('');
            void load('');
          }}
        >
          全部商品
        </Button>
      </View>
      {busy && (
        <View style={{ padding: '16px' }}>
          <Text>正在加载商品…</Text>
        </View>
      )}
      {error && (
        <View style={{ padding: '16px' }}>
          <Text>{error}</Text>
          <Button disabled={busy} onClick={() => void load()}>
            重试
          </Button>
        </View>
      )}
      {!busy && !error && !rows.length && (
        <View style={{ padding: '20px' }}>
          <Text>暂无符合条件的商品，请稍后再来。</Text>
        </View>
      )}
      {rows.map((row) => (
        <View
          key={row.id}
          style={{ marginTop: '12px', padding: '20px', background: '#fff', borderRadius: '12px' }}
          onClick={() => void Taro.navigateTo({ url: `/pages/product/index?id=${row.id}` })}
        >
          <Text style={{ fontWeight: 'bold', fontSize: '18px' }}>{row.name}</Text>
          <View style={{ marginTop: '8px', color: '#667085' }}>
            <Text>{row.spec}</Text>
          </View>
          <View style={{ marginTop: '12px', color: '#008a42' }}>
            <Text>
              ¥{(row.priceCents / 100).toFixed(2)}/{row.unit}
            </Text>
            <Text> · {row.available > 0 ? `可售 ${row.available} 件` : '暂时缺货'}</Text>
          </View>
        </View>
      ))}
      {cursor && !error && (
        <Button disabled={busy} onClick={() => void load(activeKeyword, true)}>
          加载更多
        </Button>
      )}
    </View>
  );
}
