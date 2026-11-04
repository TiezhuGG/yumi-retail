import { View, Text, Button } from '@tarojs/components';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import { cartIdentity } from '../../account-cart';
import { CartRequestError } from '../../cart-merge';
import { addressRequest } from '../../address-api';
type Entry = {
  id: string;
  delta: string;
  reason: string;
  createdAt: string;
  entryKind?: string;
  redemptionId?: string | null;
  redemptionOrderNo?: string | null;
  sourceAmount?: string | null;
  sourceCreatedAt?: string | null;
};
type Page = { items: Entry[]; nextCursor: string | null };
export default function Points() {
  const [balance, setBalance] = useState('0'),
    [items, setItems] = useState<Entry[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [guest, setGuest] = useState(false);
  const seq = useRef(0),
    pendingCursor = useRef<string | undefined>(undefined);
  async function load(next?: string) {
    const n = ++seq.current;
    pendingCursor.current = next;
    setLoading(true);
    setGuest(false);
    setError('');
    try {
      const identity = await cartIdentity();
      if (n !== seq.current) return;
      if (!identity) {
        setGuest(true);
        setItems([]);
        setBalance('0');
        return;
      }
      setGuest(false);
      const [account, page] = await Promise.all([
        addressRequest<{ balance: string }>(identity, '/consumer/points'),
        addressRequest<Page>(identity, '/consumer/points/ledger' + (next ? '?cursor=' + next : '')),
      ]);
      if (n !== seq.current) return;
      setBalance(account.balance);
      setItems((old) => (next ? [...old, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch (e) {
      if (n === seq.current) {
        if (e instanceof CartRequestError && e.status === 401) {
          setGuest(true);
          setItems([]);
          setBalance('0');
          setCursor(null);
        } else setError(e instanceof Error ? e.message : '积分读取失败');
      }
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
    setBalance('0');
  });
  useEffect(
    () => () => {
      seq.current++;
    },
    [],
  );
  return (
    <View className="account-page points-page points-ledger-page">
      <View className="points-ledger-balance">
        <Text className="points-ledger-label">可用积分</Text>
        <Text className="account-name">
          {loading
            ? '正在读取…'
            : guest
              ? '登录后查看积分'
              : error
                ? '积分暂不可用'
                : balance + ' 积分'}
        </Text>
        <Text className="points-ledger-label">YUMI DAILY · 积分账户</Text>
      </View>
      <View className="account-content">
        {guest ? (
          <View className="account-card">
            <Text>登录后可查看本人积分和明细。</Text>
            <Button
              className="points-action"
              onClick={() => Taro.navigateTo({ url: '/pages/login/index' })}
            >
              前往登录
            </Button>
          </View>
        ) : error ? (
          <View className="account-error">
            <Text>{error}</Text>
            <Button className="points-action" onClick={() => void load(pendingCursor.current)}>
              重试读取
            </Button>
          </View>
        ) : (
          !loading && (
            <>
              <View className="account-card">
                <Text className="account-card-title">积分明细</Text>
                <Text className="account-copy">
                  积分不兑换现金。发放记录以到账明细为准，兑换扣除及取消退还可查看关联兑换单。
                </Text>
                {items.length === 0 && <Text>暂无积分记录</Text>}
              </View>
              {items.map((e) => (
                <View className="account-card points-ledger-entry" key={e.id}>
                  <View className="points-ledger-entry-heading">
                  <Text className="account-card-title">{e.reason}</Text>
                  <Text className="points-ledger-delta">
                    {e.delta.startsWith('-') ? '' : '+'}
                    {e.delta} 积分
                  </Text>
                  </View>
                  {e.redemptionId && (
                    <Button
                      className="account-link redemption-order-no"
                      onClick={() =>
                        void Taro.navigateTo({
                          url: '/pages/redemption/index?id=' + e.redemptionId,
                        })
                      }
                    >
                      {e.entryKind === 'REDEMPTION_RETURN' ? '取消退积分' : '兑换扣积分'} ·
                      查看兑换单
                    </Button>
                  )}
                  {e.entryKind === 'GRANT_REVERSAL' && (
                    <Text className="account-copy">
                      误发冲正 · 原发放 {e.sourceAmount} 积分
                      {e.sourceCreatedAt
                        ? ' · ' +
                          new Date(Date.parse(e.sourceCreatedAt) + 8 * 60 * 60 * 1000)
                            .toISOString()
                            .slice(0, 16)
                            .replace('T', ' ') +
                          '（北京时间）'
                        : ''}
                    </Text>
                  )}
                  <Text className="account-copy">
                    {new Date(Date.parse(e.createdAt) + 8 * 60 * 60 * 1000)
                      .toISOString()
                      .slice(0, 16)
                      .replace('T', ' ')}
                    （北京时间）
                  </Text>
                </View>
              ))}
              {cursor && (
                <Button className="points-action" onClick={() => void load(cursor)}>
                  加载更多
                </Button>
              )}
            </>
          )
        )}
      </View>
    </View>
  );
}
