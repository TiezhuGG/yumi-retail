import { LoadingState } from '../../components/LoadingState';
import { View, Text, Button, Input } from '@tarojs/components';
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
    { label: '待收货', query: 'fulfillment=EXPRESS_WAIT_RECEIPT' },
    { label: '已完成', query: 'fulfillment=EXPRESS_RECEIVED' },
    { label: '已取消', query: 'status=CANCELED' },
  ];
  const [filter, setFilter] = useState(() =>
    afterSales || ['EXPRESS_SHIPPED', 'EXPRESS_WAIT_RECEIPT'].includes(params.fulfillment ?? '')
      ? 2
      : params.fulfillment === 'EXPRESS_WAIT_SHIP'
        ? 1
        : params.fulfillment === 'EXPRESS_RECEIVED'
          ? 3
          : params.status === 'CANCELED'
            ? 4
            : 0,
  );
  const [items, setItems] = useState<RedemptionOrderView[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [guest, setGuest] = useState(false),
    [keyword, setKeyword] = useState(''),
    [searchTerm, setSearchTerm] = useState('');
  const seq = useRef(0),
    activeLoad = useRef<number | null>(null),
    pending = useRef<string | undefined>(undefined),
    owner = useRef(''),
    applied = useRef({ filter, serviceOnly: afterSales, keyword: '' });
  async function load(
    next?: string,
    selected = applied.current.filter,
    serviceOnly = applied.current.serviceOnly,
    term = applied.current.keyword,
    restoreSearch = false,
  ) {
    if (next && activeLoad.current !== null) return;
    applied.current = { filter: selected, serviceOnly, keyword: term };
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
        owner.current = '';
        applied.current = { filter: 0, serviceOnly: false, keyword: '' };
        setKeyword('');
        setSearchTerm('');
        setFilter(0);
        setAfterSales(false);
        setItems([]);
        setCursor(null);
        return;
      }
      const changed = !!owner.current && owner.current !== who.profile.user.id;
      owner.current = who.profile.user.id;
      if (changed) {
        selected = 0;
        serviceOnly = false;
        term = '';
        applied.current = { filter: 0, serviceOnly: false, keyword: '' };
        setFilter(0);
        setAfterSales(false);
        setKeyword('');
        setSearchTerm('');
        setItems([]);
        setCursor(null);
        if (next) {
          pending.current = undefined;
          throw Error('账号已变化，请重新读取');
        }
      }
      if (!changed && restoreSearch) {
        setKeyword(term);
        setSearchTerm(term);
      }
      const query = [
        serviceOnly ? 'fulfillment=EXPRESS_SHIPPED' : filters[selected]?.query,
        next ? 'cursor=' + encodeURIComponent(next) : '',
        term ? 'keyword=' + encodeURIComponent(term) : '',
      ]
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
        } else {
          if (e instanceof AddressRequestError && e.code === 'CURSOR_INVALID') {
            pending.current = undefined;
            setItems([]);
            setCursor(null);
          }
          setError(e instanceof Error ? e.message : '订单读取失败');
        }
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
        : ['EXPRESS_SHIPPED', 'EXPRESS_WAIT_RECEIPT'].includes(view?.status ?? '')
          ? 2
          : view?.status === 'EXPRESS_RECEIVED'
            ? 3
            : view?.status === 'CANCELED'
              ? 4
              : view
                ? 0
                : applied.current.filter;
    const serviceOnly = view ? view.service === 'after-sales' : applied.current.serviceOnly;
    const term = view ? '' : applied.current.keyword;
    setAfterSales(serviceOnly);
    if (view) {
      setKeyword('');
      setSearchTerm('');
      setFilter(nextFilter);
    }
    setItems([]);
    setCursor(null);
    void load(undefined, nextFilter, serviceOnly, term, true);
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
    setKeyword('');
    setSearchTerm('');
    setItems([]);
    setCursor(null);
  });
  useEffect(
    () => () => {
      seq.current++;
    },
    [],
  );
  function search(value = keyword) {
    const term = value.trim();
    setKeyword(term);
    setSearchTerm(term);
    void load(undefined, applied.current.filter, applied.current.serviceOnly, term);
  }
  return (
    <View className="account-page reward-detail-page redemption-list-page">
      <View className="account-hero">
        <Text className="account-name">{afterSales ? '兑换售后' : '订单'}</Text>
      </View>
      <View className="account-content">
        <View className="reward-search redemption-search">
          <Input
            aria-label="搜索订单"
            value={keyword}
            maxlength={80}
            placeholder="商品名或订单号"
            confirmType="search"
            onInput={(e) => setKeyword(e.detail.value)}
            onConfirm={() => search()}
          />
          {!!keyword && (
            <Button className="redemption-search-clear" onClick={() => search('')}>
              清除
            </Button>
          )}
          <Button onClick={() => search()}>搜索</Button>
        </View>
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
            <Text>{searchTerm ? '没有找到相关订单' : '暂无订单'}</Text>
            {searchTerm ? (
              <Button className="account-link" onClick={() => search('')}>
                清除搜索
              </Button>
            ) : (
              <Button
                className="account-link"
                onClick={() => void Taro.switchTab({ url: '/pages/index/index' })}
              >
                去逛商城 ›
              </Button>
            )}
          </View>
        )}
        {items.map((o) => {
          const status =
            o.status === 'CANCELED'
              ? '已取消 · 积分已退还'
              : o.deliveryMode === 'EXPRESS'
                ? o.expressShipment
                  ? o.expressShipment.receivedAt
                    ? '已完成 · 已确认收货'
                    : `待收货 · ${o.expressShipment.carrierName}`
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
