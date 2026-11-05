import { View, Text, Button, Input } from '@tarojs/components';
import Taro, { useDidShow, useDidHide, usePullDownRefresh, useReachBottom } from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import type { RedemptionAfterSalesPage } from '../../../../../packages/contracts/src/index';
import { cartIdentity } from '../../account-cart';
import { addressRequest, AddressRequestError } from '../../address-api';

const filters = [
  ['全部', ''],
  ['待门店处理', 'OPEN'],
  ['处理中', 'PROCESSING'],
  ['已结束', 'CLOSED'],
] as const;
const categories: Record<string, string> = {
  NOT_RECEIVED: '未收到商品',
  DAMAGED: '商品破损',
  WRONG_ITEM: '商品不符',
  OTHER: '其他问题',
};
type Query = { status: string; keyword: string };

export default function ReturnFeedbackList() {
  const [data, setData] = useState<RedemptionAfterSalesPage['items']>([]),
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
      setData([]);
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
        setData([]);
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
        setData([]);
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
      const result = await addressRequest<RedemptionAfterSalesPage>(
        who,
        '/consumer/redemption-after-sales' + (args ? '?' + args : ''),
      );
      if (n !== seq.current) return;
      setData((old) => (next ? [...old, ...result.items] : result.items));
      setCursor(result.nextCursor);
    } catch (e) {
      if (n === seq.current) {
        if (e instanceof AddressRequestError && e.status === 401) {
          setGuest(true);
          setData([]);
          setCursor(null);
          setKeyword('');
          setAppliedKeyword('');
          applied.current = { status: '', keyword: '' };
        } else {
          if (e instanceof AddressRequestError && e.code === 'CURSOR_INVALID') {
            retry.current = undefined;
            setData([]);
            setCursor(null);
          }
          setError(e instanceof Error ? e.message : '售后反馈暂时无法读取');
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
    setData([]);
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
        <Text className="account-name">售后反馈</Text>
        <Button className="account-link" onClick={() => void Taro.navigateBack()}>
          退货退积分
        </Button>
      </View>
      <View className="account-content">
        <View className="reward-search redemption-search">
          <Input
            aria-label="搜索售后反馈"
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
        {loading && <Text className="account-copy">正在读取售后反馈…</Text>}
        {guest && (
          <Button
            className="points-action"
            onClick={() => void Taro.navigateTo({ url: '/pages/login/index' })}
          >
            登录后查看售后反馈
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
              重新读取售后反馈
            </Button>
          </View>
        )}
        {!loading && !guest && !error && !data.length && (
          <View className="account-card redemption-empty">
            <Text>{appliedKeyword ? '没有找到相关反馈' : '暂无售后反馈'}</Text>
            {!!appliedKeyword && (
              <Button className="account-link" onClick={() => search('')}>
                清除搜索
              </Button>
            )}
          </View>
        )}
        {data.map((item) => (
          <View className="account-card return-list-card" key={item.orderId}>
            <Text className="account-card-title">
              {item.status === 'OPEN'
                ? '待门店处理'
                : item.status === 'PROCESSING'
                  ? '处理中'
                  : '本次反馈已结束'}
            </Text>
            <Text className="return-list-product">{item.title}</Text>
            <Text className="account-copy">{categories[item.category] ?? '售后问题'}</Text>
            <Text className="account-copy">订单号：{item.orderNo}</Text>
            <Text className="account-copy">
              最近更新：
              {new Date(item.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
            </Text>
            <Button
              className="account-link"
              onClick={() =>
                void Taro.navigateTo({ url: '/pages/redemption/index?id=' + item.orderId })
              }
            >
              查看反馈详情 ›
            </Button>
          </View>
        ))}
        {!loading && !error && !cursor && !!data.length && (
          <Text className="account-copy orders-load-more">已经到底了</Text>
        )}
      </View>
    </View>
  );
}
