import { View, Text, Button } from '@tarojs/components';
import { useDidShow, useDidHide } from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import type { PaymentPreparationView } from '../../../../packages/contracts/src/index';
import type { CartIdentity } from '../account-cart';
import { addressRequest, addressOperationKey } from '../address-api';
export function PaymentPreparationCard({
  identity,
  orderId,
  canceled,
}: {
  identity: CartIdentity;
  orderId: string;
  canceled: boolean;
}) {
  const [value, setValue] = useState<PaymentPreparationView | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [unknown, setUnknown] = useState(false);
  const seq = useRef(0),
    active = useRef(false),
    key = useRef<string | null>(null);
  const path = '/consumer/orders/' + orderId + '/payment-preparation';
  async function load() {
    const n = ++seq.current;
    setLoading(true);
    setValue(null);
    setError('');
    try {
      const result = await addressRequest<PaymentPreparationView>(identity, path);
      if (n === seq.current) {
        setValue(result);
        setUnknown(false);
      }
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '支付准备读取失败');
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }
  useDidShow(() => {
    void load();
  });
  useDidHide(() => {
    seq.current++;
  });
  useEffect(() => {
    void load();
    return () => {
      seq.current++;
    };
  }, [orderId, identity.token]);
  async function prepare() {
    if (active.current || loading || unknown) return;
    active.current = true;
    setBusy(true);
    setError('');
    const n = seq.current;
    try {
      key.current ??= addressOperationKey();
      await addressRequest(identity, path, {}, key.current);
      if (n === seq.current) await load();
    } catch (e) {
      if (n === seq.current) {
        setUnknown(true);
        setError(
          (e instanceof Error ? e.message : '支付准备结果暂未确认') +
            '；请刷新核实，本操作不会扣款。',
        );
      }
    } finally {
      active.current = false;
      if (n <= seq.current) setBusy(false);
    }
  }
  return (
    <View className="address-card payment-preparation">
      <Text className="address-section-title">支付准备</Text>
      <Text className="address-hint">
        支付渠道尚未接入。这里只保存金额与准备状态，不发起扣款，也不代表支付成功。
      </Text>
      {error && <View className="address-alert preparation-error">{error}</View>}
      {loading ? (
        <View className="address-state preparation-loading">正在读取支付准备…</View>
      ) : value?.intent ? (
        <View className="preparation-result">
          <Text>
            {value.intent.state === 'CLOSED' ? '准备记录已关闭' : '准备记录已建立 · 尚未扣款'}
          </Text>
          <Text className="address-hint">
            准备金额：¥{(value.intent.amountCents / 100).toFixed(2)}
          </Text>
          <Text className="address-hint">
            {value.intent.state === 'CLOSED'
              ? value.intent.closeReason === 'PAYMENT_TIMEOUT'
                ? '订单超时取消，准备记录同步关闭。'
                : '订单已取消，准备记录同步关闭。'
              : '本单仍为待支付，库存预占期限不延长。'}
          </Text>
        </View>
      ) : (
        !error && (
          <Text className="address-hint">
            {canceled ? '本单未建立支付准备记录。' : '尚无支付准备记录。'}
          </Text>
        )
      )}
      {!canceled && !value?.intent && value?.enabled && (
        <Button
          className="account-primary preparation-create"
          disabled={loading || busy || unknown || !!error}
          onClick={() => void prepare()}
        >
          {busy ? '正在保存准备记录…' : '建立支付准备记录（开发）'}
        </Button>
      )}
      <Button
        className="checkout-link preparation-refresh"
        disabled={loading || busy}
        onClick={() => void load()}
      >
        刷新支付准备记录
      </Button>
    </View>
  );
}
