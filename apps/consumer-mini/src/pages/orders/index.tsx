import { View, Text, Button } from '@tarojs/components';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
import { useRef, useState } from 'react';
import type { ConsumerOrder } from '../../../../../packages/contracts/src/index';
import { cartIdentity } from '../../account-cart';
import type { CartIdentity } from '../../account-cart';
import { addressRequest } from '../../address-api';
export default function Orders() {
  const [identity, setIdentity] = useState<CartIdentity | null>(null),
    [items, setItems] = useState<ConsumerOrder[]>([]),
    [loading, setLoading] = useState(true),
    [more, setMore] = useState<string | null>(null),
    [error, setError] = useState('');
  const sequence = useRef(0),
    writing = useRef(false);
  async function load(append = false) {
    if (writing.current) return;
    writing.current = true;
    const n = ++sequence.current;
    setLoading(true);
    setError('');
    if (!append) {
      setItems([]);
      setIdentity(null);
      setMore(null);
    }
    try {
      const who = append ? identity : await cartIdentity();
      if (n !== sequence.current) return;
      setIdentity(who);
      if (!who) return;
      const result = await addressRequest<{
        items: ConsumerOrder[];
        nextCursor: string | null;
        hasMore: boolean;
      }>(who, '/consumer/orders' + (append && more ? '?cursor=' + more : ''));
      if (n !== sequence.current) return;
      setItems((old) =>
        append
          ? [...old, ...result.items.filter((i) => !old.some((o) => o.id === i.id))]
          : result.items,
      );
      setMore(result.hasMore ? result.nextCursor : null);
    } catch (e) {
      if (n === sequence.current) setError(e instanceof Error ? e.message : '订单读取失败');
    } finally {
      if (n === sequence.current) {
        writing.current = false;
        setLoading(false);
      }
    }
  }
  useDidShow(() => {
    void load();
  });
  useDidHide(() => {
    sequence.current++;
    writing.current = false;
  });
  return (
    <View className="orders-page retail-order-list">
      <View className="address-hero">
        <Text className="address-title">零售订单</Text>
      </View>
      <View className="address-content">
        {error && (
          <View className="address-alert">
            {error}
            <Button className="checkout-link" disabled={loading} onClick={() => void load()}>
              重新读取
            </Button>
          </View>
        )}
        {loading && !items.length ? (
          <View className="address-state">正在读取本人订单…</View>
        ) : !identity ? (
          <View className="address-state">
            <Text>登录后查看本人订单</Text>
            <Button onClick={() => void Taro.navigateTo({ url: '/pages/login/index' })}>
              前往我的
            </Button>
          </View>
        ) : (
          <>
            {!items.length && !error && (
              <View className="address-state">
                <Text className="address-empty-icon">▣</Text>
                <Text>还没有订单</Text>
                <Text className="address-hint">有订单后可在这里查看详情。</Text>
              </View>
            )}
            {items.map((order) => (
              <View className="address-card order-card" key={order.id}>
                <View className="checkout-heading">
                  <Text className="order-number">{order.orderNo}</Text>
                  <Text className="order-status">
                    {order.status === 'CANCELED' ? '已取消' : '待支付'}
                  </Text>
                </View>
                <Text className="address-hint">
                  {new Date(order.createdAt).toLocaleString('zh-CN', { hour12: false })}
                </Text>
                {order.items.slice(0, 3).map((i) => (
                  <View className="checkout-draft" key={i.skuId}>
                    <View>
                      <Text>{i.name}</Text>
                      <Text className="address-hint">{i.spec}</Text>
                    </View>
                    <Text>×{i.quantity}</Text>
                  </View>
                ))}
                {order.items.length > 3 && (
                  <Text className="address-hint">另有 {order.items.length - 3} 种规格</Text>
                )}
                <View className="retail-order-footer">
                  <View className="checkout-total">
                    <Text>订单金额</Text>
                    <Text>¥{(order.payableCents / 100).toFixed(2)}</Text>
                  </View>
                  <Button
                    className="retail-order-open"
                    onClick={() =>
                      void Taro.navigateTo({ url: '/pages/order/index?id=' + order.id })
                    }
                  >
                    查看详情 ›
                  </Button>
                </View>
              </View>
            ))}
            {more && (
              <Button className="checkout-link" disabled={loading} onClick={() => void load(true)}>
                {loading ? '正在读取…' : '加载更多订单'}
              </Button>
            )}
            <Button className="address-cancel" disabled={loading} onClick={() => void load()}>
              刷新订单
            </Button>
          </>
        )}
      </View>
    </View>
  );
}
