import { LoadingState } from '../../components/LoadingState';
import { View, Text, Button } from '@tarojs/components';
import Taro, {
  useDidShow,
  useDidHide,
  useRouter,
  useReachBottom,
  usePullDownRefresh,
} from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import type {
  RedemptionOrderView,
  RedemptionOrderPage,
} from '../../../../../packages/contracts/src/index';
import { cartIdentity } from '../../account-cart';
import { addressRequest, AddressRequestError } from '../../address-api';
import { CartRequestError } from '../../cart-merge';
import { takeRedemptionView } from '../../reward-navigation';
export default function Redemptions() {
  const { params } = useRouter();
  const [afterSales, setAfterSales] = useState(params.service === 'after-sales');
  const filters = [
    { label: '全部', query: '' },
    { label: '待发货', query: 'fulfillment=EXPRESS_WAIT_SHIP' },
    { label: '已发货', query: 'fulfillment=EXPRESS_SHIPPED' },
    { label: '已取消', query: 'status=CANCELED' },
  ];
  const [filter, setFilter] = useState(() =>
    afterSales || params.fulfillment === 'EXPRESS_SHIPPED'
      ? 2
      : params.fulfillment === 'EXPRESS_WAIT_SHIP'
        ? 1
        : params.status === 'CANCELED'
          ? 3
          : 0,
  );
  const [items, setItems] = useState<RedemptionOrderView[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [guest, setGuest] = useState(false);
  const seq = useRef(0),
    activeLoad = useRef<number | null>(null),
    pending = useRef<string | undefined>(undefined),
    owner = useRef('');
  async function load(next?: string, selected = filter) {
    if (next && activeLoad.current !== null) return;
    const n = ++seq.current;
    activeLoad.current = n;
    pending.current = next;
    setLoading(true);
    setError('');
    if (!next) {
      setItems([]);
      setCursor(null);
    }
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
      const query = [filters[selected]?.query, next ? 'cursor=' + encodeURIComponent(next) : '']
        .filter(Boolean)
        .join('&');
      const p = await addressRequest<RedemptionOrderPage>(
        who,
        '/consumer/redemptions' + (query ? '?' + query : ''),
      );
      if (n !== seq.current) return;
      setItems((old) => (next ? [...old, ...p.items] : p.items));
      setCursor(p.nextCursor);
    } catch (e) {
      if (n === seq.current) {
        if (
          (e instanceof CartRequestError || e instanceof AddressRequestError) &&
          e.status === 401
        ) {
          setGuest(true);
          setItems([]);
          setCursor(null);
        } else setError(e instanceof Error ? e.message : '兑换单读取失败');
      }
    } finally {
      if (activeLoad.current === n) {
        activeLoad.current = null;
        setLoading(false);
      }
      if (!next) Taro.stopPullDownRefresh();
    }
  }
  useDidShow(() => {
    const view = takeRedemptionView();
    const nextFilter = view?.service
      ? 2
      : view?.status === 'EXPRESS_WAIT_SHIP'
        ? 1
        : view?.status === 'EXPRESS_SHIPPED'
          ? 2
          : view?.status === 'CANCELED'
            ? 3
            : filter;
    if (view) {
      setAfterSales(view.service === 'after-sales');
      setFilter(nextFilter);
    } else setAfterSales(false);
    setItems([]);
    setCursor(null);
    void load(undefined, nextFilter);
  });
  useReachBottom(() => {
    if (cursor && !loading && !error) void load(cursor);
  });
  usePullDownRefresh(() => {
    void load();
  });
  useDidHide(() => {
    seq.current++;
    activeLoad.current = null;
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
    <View className="account-page reward-detail-page redemption-list-page">
      <View className="account-hero">
        <Text className="account-name">{afterSales ? '兑换售后' : '订单'}</Text>
      </View>
      <View className="account-content">
        {!afterSales && (
          <View className="reward-categories">
            {filters.map(({ label }, index) => (
              <Button
                key={label}
                className={filter === index ? 'active' : ''}
                onClick={() => {
                  if (index === filter) return;
                  setFilter(index);
                  void load(undefined, index);
                }}
              >
                {label}
              </Button>
            ))}
          </View>
        )}
        {loading && <LoadingState label="正在读取兑换单…" />}
        {guest && (
          <Button
            className="points-action"
            onClick={() => void Taro.navigateTo({ url: '/pages/login/index' })}
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
          <View className="account-card redemption-empty">
            <Text>暂无订单</Text>
            <Button
              className="account-link"
              onClick={() => void Taro.switchTab({ url: '/pages/index/index' })}
            >
              去逛商城 ›
            </Button>
          </View>
        )}
        {items.map((o) => {
          const status =
            o.status === 'CANCELED'
              ? '已取消 · 积分已退还'
              : o.deliveryMode === 'EXPRESS'
                ? o.expressShipment
                  ? `已发货 · ${o.expressShipment.carrierName}`
                  : '待发货'
                : o.deliveryExceptionReported
                  ? '配送异常待处理'
                  : o.fulfillmentState === 'DELIVERED'
                    ? '已送达'
                    : o.fulfillmentState === 'DELIVERING'
                      ? '配送中'
                      : o.fulfillmentState === 'RIDER_RECEIVED_WAIT_START'
                        ? '骑手已接货'
                        : o.fulfillmentState === 'ASSIGNED_WAIT_HANDOFF'
                          ? '等待骑手接货'
                          : o.fulfillmentState === 'SHIPPED_WAIT_HANDOFF'
                            ? '等待骑手接货'
                            : o.fulfillmentState === 'PACKED_WAIT_SHIP'
                              ? '仓库待出库'
                              : o.fulfillmentState === 'PICKED_WAIT_PACK'
                                ? '仓库待打包'
                                : o.fulfillmentState === 'PICKING'
                                  ? '仓库处理中'
                                  : o.fulfillmentState === 'READY_TO_PICK'
                                    ? '等待仓库领取'
                                    : o.fulfillmentState === 'REVIEW_REQUIRED'
                                      ? '门店核查中'
                                      : '处理中';
          return (
            <View className="account-card redemption-list-card" key={o.id}>
              <View className="redemption-list-heading">
                <Text className="redemption-list-status">{status}</Text>
                <Text className="redemption-list-number">{o.orderNo}</Text>
              </View>
              <Text className="account-card-title">
                {o.title} × {o.quantity}
              </Text>
              <Text className="account-copy">
                {o.spec} · {o.totalPoints} 积分
              </Text>
              {o.deliveryReturnRecorded && (
                <Text className="redemption-list-note">配送已重新安排，积分未重复扣减</Text>
              )}
              <Button
                className="redemption-list-open"
                onClick={() => void Taro.navigateTo({ url: '/pages/redemption/index?id=' + o.id })}
              >
                查看详情 ›
              </Button>
            </View>
          );
        })}
        {loading && cursor && (
          <Text className="account-copy orders-load-more">正在加载更多订单…</Text>
        )}
        {!loading && !error && !cursor && items.length > 0 && (
          <Text className="account-copy orders-load-more">已经到底了</Text>
        )}
      </View>
    </View>
  );
}
