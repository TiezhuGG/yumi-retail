import { View, Text, Button } from '@tarojs/components';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import type {
  RedemptionOrderView,
  RedemptionOrderPage,
} from '../../../../../packages/contracts/src/index';
import { cartIdentity } from '../../account-cart';
import { addressRequest } from '../../address-api';
export default function Redemptions() {
  const [items, setItems] = useState<RedemptionOrderView[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [guest, setGuest] = useState(false);
  const seq = useRef(0),
    pending = useRef<string | undefined>(undefined),
    owner = useRef('');
  async function load(next?: string) {
    const n = ++seq.current;
    pending.current = next;
    setLoading(true);
    setError('');
    try {
      const who = await cartIdentity();
      if (n !== seq.current) return;
      setGuest(!who);
      if (!who) {
        setItems([]);
        setCursor(null);
        return;
      }
      if (next && owner.current !== who.profile.user.id) throw Error('账号已变化，请重新读取');
      owner.current = who.profile.user.id;
      const p = await addressRequest<RedemptionOrderPage>(
        who,
        '/consumer/redemptions' + (next ? '?cursor=' + next : ''),
      );
      if (n !== seq.current) return;
      setItems((old) => (next ? [...old, ...p.items] : p.items));
      setCursor(p.nextCursor);
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '兑换单读取失败');
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }
  useDidShow(() => {
    setItems([]);
    setCursor(null);
    void load();
  });
  useDidHide(() => {
    seq.current++;
    setItems([]);
    setCursor(null);
  });
  useEffect(
    () => () => {
      seq.current++;
    },
    [],
  );
  return (
    <View className="account-page reward-detail-page">
      <View className="account-hero">
        <Text className="account-eyebrow">YUMI · 我的积分</Text>
        <Text className="account-name">兑换订单</Text>
      </View>
      <View className="account-content">
        <Text className="account-copy">本机开发兑换，按真实预占进入拣货；出库与配送尚未开放。</Text>
        {loading && <Text>正在读取兑换单…</Text>}
        {guest && (
          <Button
            className="points-action"
            onClick={() => void Taro.navigateTo({ url: '/pages/account/index' })}
          >
            登录后查看
          </Button>
        )}
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
          </View>
        )}
        {!loading && !guest && !error && !items.length && (
          <View className="account-card">
            <Text>暂无兑换订单</Text>
          </View>
        )}
        {items.map((o) => (
          <View className="account-card" key={o.id}>
            <Text className="account-card-title">{o.title}</Text>
            <Text className="account-copy">
              {o.spec} · {o.quantity} 件
            </Text>
            <Text className="reward-price">{o.totalPoints} 积分</Text>
            {o.deliveryReturnRecorded && (
              <Text className="account-copy">
                曾回交仓库，以下为重新安排的配送进度；积分未重复扣减。
              </Text>
            )}
            <Text className="account-copy">
              {o.status === 'CANCELED'
                ? '已取消 · 积分已退还'
                : o.deliveryExceptionReported
                  ? '配送异常待处理'
                  : o.fulfillmentState === 'DELIVERED'
                    ? '骑手已确认送达。'
                    : o.fulfillmentState === 'DELIVERING'
                      ? '骑手配送中。'
                      : o.fulfillmentState === 'RIDER_RECEIVED_WAIT_START'
                        ? '骑手已核对接货，等待开始配送。'
                        : o.fulfillmentState === 'ASSIGNED_WAIT_HANDOFF'
                          ? o.deliveryReturnRecorded
                            ? '已重新分配，等待骑手核对接货。'
                            : '已分配骑手，等待骑手核对接货；尚未开始配送。'
                          : o.fulfillmentState === 'SHIPPED_WAIT_HANDOFF'
                            ? o.deliveryReturnRecorded
                              ? '包裹已回交，等待门店重新安排配送。'
                              : '已出库，等待骑手接货；尚未开始配送。'
                            : o.fulfillmentState === 'PACKED_WAIT_SHIP'
                              ? '已打包，等待仓库出库；尚未配送。'
                              : o.fulfillmentState === 'PICKED_WAIT_PACK'
                                ? '拣货已核对完成，等待打包；尚未出库或配送。'
                                : o.fulfillmentState === 'PICKING'
                                  ? '仓库已领取'
                                  : o.fulfillmentState === 'READY_TO_PICK'
                                    ? '待仓库领取'
                                    : o.fulfillmentState === 'REVIEW_REQUIRED'
                                      ? '待门店核查'
                                      : '待创建拣货任务'}
            </Text>
            <Button
              className="points-action"
              onClick={() => void Taro.navigateTo({ url: '/pages/redemption/index?id=' + o.id })}
            >
              查看兑换单
            </Button>
          </View>
        ))}
        {cursor && !error && (
          <Button className="points-action" disabled={loading} onClick={() => void load(cursor)}>
            加载更多
          </Button>
        )}
        <Button className="account-link" disabled={loading} onClick={() => void load()}>
          刷新兑换订单
        </Button>
      </View>
    </View>
  );
}
