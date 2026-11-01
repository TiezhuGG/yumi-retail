import { View, Text, Button } from '@tarojs/components';
import Taro, { useDidShow, useDidHide, useRouter } from '@tarojs/taro';
import { useRef, useState } from 'react';
import type { ConsumerOrder } from '../../../../../packages/contracts/src/index';
import { cartIdentity } from '../../account-cart';
import type { CartIdentity } from '../../account-cart';
import { addressRequest } from '../../address-api';
import { PaymentPreparationCard } from '../../components/PaymentPreparation';
import { acknowledgeOrder } from '../../order-storage';
export default function OrderDetail() {
  const id = useRouter().params.id;
  const [identity, setIdentity] = useState<CartIdentity | null>(null),
    [order, setOrder] = useState<ConsumerOrder | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const sequence = useRef(0),
    writing = useRef(false);
  async function load() {
    const n = ++sequence.current;
    setLoading(true);
    setError('');
    setOrder(null);
    setIdentity(null);
    try {
      if (!id || !/^[a-f0-9-]{36}$/i.test(id)) throw Error('订单入口无效，请从本人订单列表进入');
      const who = await cartIdentity();
      if (n !== sequence.current) return;
      setIdentity(who);
      if (!who) return;
      const result = await addressRequest<ConsumerOrder>(who, '/consumer/orders/' + id);
      if (n !== sequence.current) return;
      setOrder(result);
      acknowledgeOrder(who.profile.user.id, result.id);
    } catch (e) {
      if (n === sequence.current) setError(e instanceof Error ? e.message : '订单读取失败');
    } finally {
      if (n === sequence.current) setLoading(false);
    }
  }
  useDidShow(() => {
    void load();
  });
  useDidHide(() => {
    sequence.current++;
  });
  async function cancel() {
    if (writing.current || !identity || !order) return;
    writing.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await Taro.showModal({
        title: '取消这笔未支付订单？',
        content: '本订单尚未开始支付。取消后会释放预占库存，不会发起退款。',
        confirmText: '确认取消',
      });
      if (!result.confirm) return;
      await addressRequest(identity, `/consumer/orders/${order.id}/cancel`, {});
      await load();
    } catch (e) {
      setError(
        (e instanceof Error ? e.message : '暂未确认取消结果') +
          '；可刷新状态，仍待支付时重试取消。',
      );
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  return (
    <View className="orders-page">
      <View className="address-hero">
        <Text className="account-eyebrow">YUMI · ORDER DETAIL</Text>
        <Text className="address-title">订单详情</Text>
        <Text className="address-subtitle">本机开发订单 · 支付尚未开放</Text>
      </View>
      <View className="address-content">
        {error && <View className="address-alert order-error">{error}</View>}
        {loading ? (
          <View className="address-state">正在核实订单状态…</View>
        ) : !identity ? (
          <View className="address-state">
            <Text>请核实本人登录状态</Text>
            <Button onClick={() => void Taro.navigateTo({ url: '/pages/account/index' })}>
              前往我的
            </Button>
            <Button onClick={() => void load()}>重新读取</Button>
          </View>
        ) : !order ? (
          <View className="address-state">
            <Text>暂时无法读取这笔订单</Text>
            <Button onClick={() => void load()}>重新读取</Button>
          </View>
        ) : (
          <>
            <View className="address-card order-state">
              <Text className="address-section-title">
                {order.status === 'CANCELED' ? '订单已取消' : '待支付 · 尚未开始支付'}
              </Text>
              <Text className="address-hint">
                {order.status === 'CANCELED'
                  ? order.cancelReason === 'PAYMENT_TIMEOUT'
                    ? '未开始支付且已超时，预占已释放。'
                    : '你已取消订单，预占已释放。'
                  : '测试库存已预占，实物尚未出库。支付、拣货和配送未开放。'}
              </Text>
              <Text className="address-hint">
                预占截止：
                {new Date(order.paymentDeadline).toLocaleString('zh-CN', { hour12: false })}
              </Text>
              <Text className="order-number">{order.orderNo}</Text>
            </View>
            <View className="address-card">
              <Text className="address-section-title">收货信息</Text>
              <Text>
                {order.address.areaName} · {order.address.buildingName}
              </Text>
              <Text className="address-room">
                {order.address.unit} {order.address.room}
              </Text>
              <Text className="address-contact">
                {order.address.contactName} {order.address.phone}
              </Text>
              {order.address.note && <Text className="address-hint">{order.address.note}</Text>}
              {order.address.orderNote && (
                <Text className="address-hint">订单备注：{order.address.orderNote}</Text>
              )}
              <Text className="address-hint">后续修改或删除收货地址不会更改这笔订单的资料。</Text>
            </View>
            <View className="address-card">
              <Text className="address-section-title">商品与金额</Text>
              {order.items.map((i) => (
                <View className="checkout-line" key={i.skuId}>
                  <View>
                    <Text>{i.name}</Text>
                    <Text className="address-hint">
                      {i.spec} · {i.quantity}
                      {i.unit}
                    </Text>
                  </View>
                  <Text>¥{(i.lineCents / 100).toFixed(2)}</Text>
                </View>
              ))}
              <View className="checkout-amount">
                <Text>商品金额</Text>
                <Text>¥{(order.goodsCents / 100).toFixed(2)}</Text>
              </View>
              <View className="checkout-amount">
                <Text>配送费</Text>
                <Text>¥{(order.deliveryFeeCents / 100).toFixed(2)}</Text>
              </View>
              <View className="checkout-total">
                <Text>订单金额</Text>
                <Text>¥{(order.payableCents / 100).toFixed(2)}</Text>
              </View>
            </View>
            <PaymentPreparationCard
              identity={identity}
              orderId={order.id}
              canceled={order.status === 'CANCELED'}
            />
            {order.status === 'AWAITING_PAYMENT' && (
              <>
                <Button disabled className="checkout-order-disabled">
                  支付尚未开放
                </Button>
                <Button className="order-cancel" disabled={busy} onClick={() => void cancel()}>
                  {busy ? '正在核实…' : '取消未支付订单'}
                </Button>
              </>
            )}
            <Button
              className="address-cancel order-refresh"
              disabled={busy}
              onClick={() => void load()}
            >
              刷新订单状态
            </Button>
          </>
        )}
        <Button
          className="checkout-link"
          disabled={busy}
          onClick={() => void Taro.navigateTo({ url: '/pages/orders/index' })}
        >
          查看本人订单列表
        </Button>
      </View>
    </View>
  );
}
