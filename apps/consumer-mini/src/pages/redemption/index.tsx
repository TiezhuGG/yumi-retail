import { View, Text, Button } from '@tarojs/components';
import Taro, { useDidShow, useDidHide, useRouter } from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import type { RedemptionOrderView } from '../../../../../packages/contracts/src/index';
import { cartIdentity } from '../../account-cart';
import { addressRequest, addressOperationKey } from '../../address-api';
import { acknowledgeRedemption, redemptionCancelKey } from '../../redemption-storage';
export default function RedemptionDetail() {
  const id = useRouter().params.id;
  const [order, setOrder] = useState<RedemptionOrderView | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const seq = useRef(0),
    writing = useRef(false);
  async function load() {
    const n = ++seq.current;
    setLoading(true);
    setOrder(null);
    setError('');
    try {
      const who = await cartIdentity();
      if (!who) throw Error('请登录后查看本人兑换单');
      if (!id) throw Error('兑换单入口无效');
      const o = await addressRequest<RedemptionOrderView>(who, '/consumer/redemptions/' + id);
      if (n !== seq.current) return;
      setOrder(o);
      acknowledgeRedemption(who.profile.user.id, o.id);
      if (o.status === 'CANCELED')
        Taro.removeStorageSync(redemptionCancelKey(who.profile.user.id, o.id));
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '兑换单读取失败');
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }
  useDidShow(() => {
    void load();
  });
  useDidHide(() => {
    seq.current++;
    setBusy(false);
    setOrder(null);
  });
  useEffect(
    () => () => {
      seq.current++;
    },
    [],
  );
  async function cancel() {
    if (writing.current || !order) return;
    writing.current = true;
    setBusy(true);
    setError('');
    const n = seq.current;
    try {
      const who = await cartIdentity();
      if (!who) throw Error('请先登录');
      const storage = redemptionCancelKey(who.profile.user.id, order.id),
        raw = Taro.getStorageSync(storage) as { key: string; version: number } | null;
      const intent = raw || { key: addressOperationKey(), version: order.version };
      if (typeof intent.key !== 'string' || !Number.isInteger(intent.version))
        throw Error('取消记录无法读取，请保留并核实本人订单');
      Taro.setStorageSync(storage, intent);
      await addressRequest(
        who,
        '/consumer/redemptions/' + order.id + '/cancel',
        { version: intent.version },
        intent.key,
      );
      if (n === seq.current) await load();
    } catch (e) {
      if (n === seq.current)
        setError(
          (e instanceof Error ? e.message : '取消结果未知') +
            '；请刷新核实，或使用原请求重试取消。',
        );
    } finally {
      writing.current = false;
      if (n === seq.current || n + 1 === seq.current) setBusy(false);
    }
  }
  return (
    <View className="account-page reward-detail-page">
      <View className="account-hero">
        <Text className="account-eyebrow">YUMI · 兑换详情</Text>
        <Text className="account-name">
          {order?.status === 'CANCELED' ? '兑换已取消' : '积分兑换单'}
        </Text>
      </View>
      <View className="account-content">
        {loading && <Text>正在核实兑换状态…</Text>}
        {error && (
          <View className="account-error">
            <Text>{error}</Text>
          </View>
        )}
        {order && (
          <>
            <View className="account-card">
              <Text className="account-card-title">{order.title}</Text>
              <Text className="account-copy">
                {order.spec} / {order.unit} · {order.quantity} 件
              </Text>
              <Text className="reward-price">{order.totalPoints} 积分</Text>
              <Text className="account-copy">
                {order.status === 'CANCELED'
                  ? '积分已退还，库存和限兑配额已释放。'
                  : order.deliveryExceptionReported
                    ? '配送异常待处理'
                    : order.fulfillmentState === 'DELIVERED'
                      ? '骑手已确认送达。'
                      : order.fulfillmentState === 'DELIVERING'
                        ? '骑手配送中。'
                        : order.fulfillmentState === 'RIDER_RECEIVED_WAIT_START'
                          ? '骑手已核对接货，等待开始配送。'
                          : order.fulfillmentState === 'ASSIGNED_WAIT_HANDOFF'
                            ? order.deliveryReturnRecorded
                              ? '已重新分配，等待骑手核对接货。'
                              : '已分配骑手，等待骑手核对接货；尚未开始配送。'
                            : order.fulfillmentState === 'SHIPPED_WAIT_HANDOFF'
                              ? order.deliveryReturnRecorded
                                ? '包裹已回交，等待门店重新安排配送。'
                                : '已出库，等待骑手接货；尚未开始配送。'
                              : order.fulfillmentState === 'PACKED_WAIT_SHIP'
                                ? '已打包，等待仓库出库；尚未配送。'
                                : order.fulfillmentState === 'PICKED_WAIT_PACK'
                                  ? '拣货已核对完成，等待打包；尚未出库或配送。'
                                  : order.fulfillmentState === 'PICKING'
                                    ? '仓库已领取，正在准备拣货；尚未出库或配送。'
                                    : order.fulfillmentState === 'READY_TO_PICK'
                                      ? '已创建拣货任务，等待仓库领取。'
                                      : order.fulfillmentState === 'REVIEW_REQUIRED'
                                        ? '履约待办需要门店核查，积分和预占仍保留。'
                                        : '已扣积分并预占库存，正在等待创建拣货任务。'}
              </Text>
              <Text className="account-copy redemption-order-no">兑换单号：{order.orderNo}</Text>
              {order.deliveryReturnRecorded && (
                <Text className="account-copy">
                  曾回交仓库，以下为重新安排的配送进度；积分未重复扣减。
                </Text>
              )}
            </View>
            {[
              'PICKING',
              'PICKED_WAIT_PACK',
              'PACKED_WAIT_SHIP',
              'SHIPPED_WAIT_HANDOFF',
              'ASSIGNED_WAIT_HANDOFF',
              'RIDER_RECEIVED_WAIT_START',
              'DELIVERING',
              'DELIVERED',
            ].includes(order.fulfillmentState) && (
              <View className="account-card">
                <Text className="account-copy">
                  {order.deliveryExceptionReported
                    ? '配送遇到异常，门店待核查；请联系门店处理。'
                    : order.fulfillmentState === 'DELIVERED'
                      ? '如有未收到或商品问题，请联系门店核实。'
                      : order.fulfillmentState === 'DELIVERING'
                        ? '骑手正在配送，无法直接取消。如需协助，请联系门店核实。'
                        : '仓库已开始作业，暂不支持直接取消。如需停止履约，请联系门店核实。'}
                </Text>
              </View>
            )}
            {order.address && (
              <View className="account-card">
                <Text className="account-card-title">收货地址快照</Text>
                <Text className="account-copy">
                  {order.address.areaName} {order.address.buildingName} {order.address.unit}{' '}
                  {order.address.room}
                </Text>
                <Text className="account-copy">
                  {order.address.contactName} · {order.address.phone}
                </Text>
              </View>
            )}
            {order.status === 'ACTIVE' &&
              ![
                'PICKING',
                'PICKED_WAIT_PACK',
                'PACKED_WAIT_SHIP',
                'SHIPPED_WAIT_HANDOFF',
                'ASSIGNED_WAIT_HANDOFF',
                'RIDER_RECEIVED_WAIT_START',
                'DELIVERING',
                'DELIVERED',
              ].includes(order.fulfillmentState) && (
                <View className="account-card">
                  <Text className="account-copy">
                    仓库领取前可直接取消，退还全部积分并释放预占；领取和取消以服务端先完成的结果为准。
                  </Text>
                  <Button
                    className="points-action"
                    disabled={busy || loading}
                    onClick={() => void cancel()}
                  >
                    取消兑换并退还 {order.totalPoints} 积分
                  </Button>
                </View>
              )}
          </>
        )}
        <Button className="points-action" disabled={busy || loading} onClick={() => void load()}>
          刷新兑换状态
        </Button>
        <Button
          className="account-link"
          onClick={() => void Taro.navigateTo({ url: '/pages/redemptions/index' })}
        >
          查看全部兑换单 →
        </Button>
      </View>
    </View>
  );
}
