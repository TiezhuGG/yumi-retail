import { View, Text, Button, Input } from '@tarojs/components';
import Taro, { useDidShow, useDidHide, usePullDownRefresh, useReachBottom } from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import type {
  ConsumerReturnList,
  RedemptionReturnSummary,
} from '../../../../../packages/contracts/src/index';
import { cartIdentity } from '../../account-cart';
import { addressRequest, AddressRequestError } from '../../address-api';
import { openRedemptions } from '../../reward-navigation';
const filters = [
  ['全部', ''],
  ['处理中', 'PROCESSING'],
  ['已退积分', 'REFUNDED'],
  ['已结束', 'CLOSED'],
] as const;
const labels = {
  REQUESTED: '等待门店审核',
  WAIT_RETURN: '审核通过 · 等待退货',
  READY_TO_REFUND: '等待退积分',
  REFUNDED: '积分已退还',
  REJECTED: '申请未通过',
  CANCELED: '申请已撤销',
};
type Query = { status: string; keyword: string };
export default function Returns() {
  const [items, setItems] = useState<RedemptionReturnSummary[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [status, setStatus] = useState(''),
    [keyword, setKeyword] = useState(''),
    [appliedKeyword, setAppliedKeyword] = useState(''),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [guest, setGuest] = useState(false);
  const seq = useRef(0),
    active = useRef<number | null>(null),
    owner = useRef(''),
    applied = useRef<Query>({ status: '', keyword: '' }),
    retry = useRef<string>();
  async function load(next?: string, query = applied.current, restore = false) {
    if (next && active.current !== null) return;
    const n = ++seq.current;
    active.current = n;
    retry.current = next;
    applied.current = query;
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
        applied.current = { status: '', keyword: '' };
        setStatus('');
        setKeyword('');
        setAppliedKeyword('');
        setItems([]);
        setCursor(null);
        return;
      }
      const changed = !!owner.current && owner.current !== who.profile.user.id;
      owner.current = who.profile.user.id;
      if (changed) {
        query = { status: '', keyword: '' };
        applied.current = query;
        setStatus('');
        setKeyword('');
        setAppliedKeyword('');
        setItems([]);
        setCursor(null);
        if (next) {
          retry.current = undefined;
          throw Error('账号已变化，请重新读取');
        }
      }
      if (restore && !changed) {
        setStatus(query.status);
        setKeyword(query.keyword);
        setAppliedKeyword(query.keyword);
      }
      const args = [
        query.status ? 'status=' + query.status : '',
        query.keyword ? 'keyword=' + encodeURIComponent(query.keyword) : '',
        next ? 'cursor=' + encodeURIComponent(next) : '',
      ]
        .filter(Boolean)
        .join('&');
      const result = await addressRequest<ConsumerReturnList>(
        who,
        '/consumer/redemption-returns' + (args ? '?' + args : ''),
      );
      if (n !== seq.current) return;
      setItems((old) => (next ? [...old, ...result.items] : result.items));
      setCursor(result.nextCursor);
    } catch (e) {
      if (n === seq.current) {
        if (e instanceof AddressRequestError && e.status === 401) {
          setGuest(true);
          setItems([]);
          setCursor(null);
          setKeyword('');
          setAppliedKeyword('');
          applied.current = { status: '', keyword: '' };
        } else {
          if (e instanceof AddressRequestError && e.code === 'CURSOR_INVALID') {
            retry.current = undefined;
            setItems([]);
            setCursor(null);
          }
          setError(e instanceof Error ? e.message : '售后暂时无法读取');
        }
      }
    } finally {
      if (active.current === n) {
        active.current = null;
        setLoading(false);
      }
      if (!next) Taro.stopPullDownRefresh();
    }
  }
  useDidShow(() => void load(undefined, applied.current, true));
  useDidHide(() => {
    seq.current++;
    active.current = null;
    setItems([]);
    setCursor(null);
    setKeyword('');
    setAppliedKeyword('');
  });
  useEffect(
    () => () => {
      seq.current++;
    },
    [],
  );
  usePullDownRefresh(() => void load());
  useReachBottom(() => {
    if (cursor && !loading && !error) void load(cursor);
  });
  function search(value = keyword) {
    const term = value.trim();
    setKeyword(term);
    setAppliedKeyword(term);
    void load(undefined, { ...applied.current, keyword: term });
  }
  return (
    <View className="account-page redemption-list-page">
      <View className="account-hero return-list-heading">
        <Text className="account-name">售后</Text>
        <Button
          className="account-link"
          onClick={() =>
            guest
              ? void Taro.navigateTo({ url: '/pages/login/index' })
              : void openRedemptions({ service: 'after-sales' })
          }
        >
          申请售后
        </Button>
      </View>
      <View className="account-content">
        <View className="reward-search redemption-search">
          <Input
            aria-label="搜索售后"
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
        <View className="reward-categories">
          {filters.map(([label, value]) => (
            <Button
              key={value}
              className={status === value ? 'active' : ''}
              onClick={() => {
                setStatus(value);
                void load(undefined, { ...applied.current, status: value });
              }}
            >
              {label}
            </Button>
          ))}
        </View>
        {loading && <Text className="account-copy">正在读取售后申请…</Text>}
        {guest && (
          <Button
            className="points-action"
            onClick={() => void Taro.navigateTo({ url: '/pages/login/index' })}
          >
            登录后查看售后
          </Button>
        )}
        {!!error && (
          <View className="account-error">
            <Text>{error}</Text>
            <Button
              disabled={loading}
              className="points-action"
              onClick={() => void load(retry.current)}
            >
              重新读取售后
            </Button>
          </View>
        )}
        {!loading && !guest && !error && !items.length && (
          <View className="account-card redemption-empty">
            <Text>{appliedKeyword ? '没有找到相关申请' : '暂无退货退积分申请'}</Text>
            {!!appliedKeyword && (
              <Button className="account-link" onClick={() => search('')}>
                清除搜索
              </Button>
            )}
          </View>
        )}
        {items.map((v) => (
          <View className="account-card return-list-card" key={v.id}>
            <Text className="account-card-title">{labels[v.state]}</Text>
            <Text className="return-list-product">{v.title}</Text>
            <Text className="account-copy">
              {v.quantity} 件 · {v.points} 积分
            </Text>
            <Text className="account-copy">订单号：{v.orderNo}</Text>
            <Text className="account-copy">
              申请时间：
              {new Date(v.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
            </Text>
            <Button
              className="account-link"
              onClick={() =>
                void Taro.navigateTo({
                  url: '/pages/return/index?orderId=' + v.orderId + '&id=' + v.id,
                })
              }
            >
              查看售后详情 ›
            </Button>
          </View>
        ))}
        {!loading && !error && !cursor && !!items.length && (
          <Text className="account-copy orders-load-more">已经到底了</Text>
        )}
      </View>
    </View>
  );
}
