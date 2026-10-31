import { View, Text, Button } from '@tarojs/components';
import Taro, { useDidShow } from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import type { CheckoutQuote } from '../../../../packages/contracts/src/index';
import type { CartIdentity } from '../account-cart';
import { addressRequest, addressOperationKey, AddressRequestError } from '../address-api';
import { orderSubmission, parseOrderIntent, OrderIntentRejection } from '../order-intent';
import { orderIntentKey } from '../order-storage';
export function OrderSubmit({
  identity,
  quote,
  allowed,
  onPending,
}: {
  identity: CartIdentity;
  quote: CheckoutQuote | null;
  allowed: boolean;
  onPending: (v: boolean) => void;
}) {
  const [pending, setPending] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [rejected, setRejected] = useState(false),
    [corrupt, setCorrupt] = useState(false);
  const active = useRef(false),
    read = () => Taro.getStorageSync(orderIntentKey);
  function refresh() {
    try {
      const intent = parseOrderIntent(read());
      setPending(Boolean(intent));
      onPending(Boolean(intent));
      setCorrupt(false);
    } catch (e) {
      setCorrupt(true);
      onPending(true);
      setError(e instanceof Error ? e.message : '下单记录无法读取');
    }
  }
  useDidShow(refresh);
  useEffect(refresh, []);
  const submission = useRef<ReturnType<typeof orderSubmission> | null>(null);
  // Bind each attempt to the current verified identity; callbacks never silently adopt a different account.
  async function submit() {
    if (active.current || corrupt) return;
    active.current = true;
    setBusy(true);
    setError('');
    setRejected(false);
    try {
      const original = parseOrderIntent(read());
      if (!original) {
        if (!quote || !allowed || quote.expired || Date.parse(quote.expiresAt) <= Date.now())
          throw Error('请先生成有效报价');
        const result = await Taro.showModal({
          title: '创建开发测试订单？',
          content:
            '此操作会真实预占本机测试库存，支付尚未接入。可在订单页取消，未开始支付的超时订单由后台释放。',
          confirmText: '确认创建',
        });
        if (!result.confirm) return;
      }
      submission.current = orderSubmission({
        read,
        write: (v) => {
          Taro.setStorageSync(orderIntentKey, v);
          setPending(true);
          onPending(true);
        },
        newKey: addressOperationKey,
        send: async (intent) => {
          try {
            return await addressRequest<{ id: string }>(
              identity,
              '/consumer/orders',
              { quoteId: intent.quoteId },
              intent.key,
            );
          } catch (e) {
            if (e instanceof AddressRequestError)
              throw new OrderIntentRejection(e.status, e.message);
            throw e;
          }
        },
      });
      const id = await submission.current.submit(
        identity.profile.user.id,
        original?.quoteId ?? quote!.id,
      );
      await Taro.navigateTo({ url: '/pages/order/index?id=' + id });
    } catch (e) {
      setError(e instanceof Error ? e.message : '下单结果未知，请保留原操作重试');
      setRejected(e instanceof OrderIntentRejection && [400, 404, 409].includes(e.status));
      refresh();
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  function acknowledgeRejection() {
    try {
      const value = parseOrderIntent(read());
      if (value?.userId !== identity.profile.user.id || value.orderId)
        throw Error('该下单记录不能直接清除，请核实本人订单');
      Taro.removeStorageSync(orderIntentKey);
      setPending(false);
      onPending(false);
      setRejected(false);
      setError('请重新核验后生成新的报价。');
    } catch (e) {
      setError(e instanceof Error ? e.message : '下单记录未清除');
    }
  }
  return (
    <View className="order-submit">
      <Text className="address-hint">
        {allowed
          ? '本机开发订单：支付尚未开放，创建后会预占测试库存。购物车商品暂时保留，再次购买需重新核验报价。'
          : '订单提交基础尚未开放。'}
      </Text>
      {error && <View className="address-alert order-submit-error">{error}</View>}
      {pending && (
        <Text className="address-hint">有一笔下单操作待核实，原账号、报价和操作编号已保留。</Text>
      )}
      <Button
        className="account-primary order-create"
        disabled={
          busy ||
          corrupt ||
          (!pending &&
            (!allowed || !quote || quote.expired || Date.parse(quote.expiresAt) <= Date.now()))
        }
        onClick={() => void submit()}
      >
        {busy
          ? '正在确认订单…'
          : pending
            ? '核实原下单操作'
            : allowed
              ? '创建开发测试订单'
              : '订单提交尚未开放'}
      </Button>
      {rejected && (
        <Button disabled={busy} className="checkout-link" onClick={acknowledgeRejection}>
          已确认本次未创建，重新核验
        </Button>
      )}
      <Button
        className="checkout-link"
        disabled={busy}
        onClick={() => void Taro.navigateTo({ url: '/pages/orders/index' })}
      >
        查看本人订单
      </Button>
    </View>
  );
}
