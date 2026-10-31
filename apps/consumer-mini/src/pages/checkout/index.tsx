import { View, Text, Button, Picker } from '@tarojs/components';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import type {
  ConsumerAddressBook,
  ConsumerCart,
  CheckoutPolicy,
  CheckoutPreview,
  CheckoutQuote,
} from '../../../../../packages/contracts/src/index';
import { cartIdentity, readAccountCart, pendingMerge } from '../../account-cart';
import type { CartIdentity } from '../../account-cart';
import { addressRequest, addressOperationKey, AddressRequestError } from '../../address-api';
import { request } from '../../api';
const money = (c: number | null) => (c === null ? '待核验' : '¥' + (c / 100).toFixed(2));
export default function Checkout() {
  const [identity, setIdentity] = useState<CartIdentity | null>(null),
    [addresses, setAddresses] = useState<ConsumerAddressBook | null>(null),
    [cart, setCart] = useState<ConsumerCart | null>(null),
    [store, setStore] = useState<{ status: string; policy: CheckoutPolicy | null } | null>(null),
    [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [preview, setPreview] = useState<CheckoutPreview | null>(null),
    [quote, setQuote] = useState<CheckoutQuote | null>(null),
    [unknown, setUnknown] = useState(false),
    [mergePending, setMergePending] = useState(false),
    [now, setNow] = useState(Date.now());
  const sequence = useRef(0),
    writing = useRef(false),
    intent = useRef<{ identity: CartIdentity; key: string; body: unknown } | null>(null);
  useEffect(() => {
    if (!quote) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(0, Date.parse(quote.expiresAt) - Date.now() + 10),
    );
    return () => clearTimeout(timer);
  }, [quote]);
  async function load() {
    if (writing.current || intent.current) return;
    const n = ++sequence.current;
    setLoading(true);
    setError('');
    setPreview(null);
    setQuote(null);
    setIdentity(null);
    setAddresses(null);
    setCart(null);
    setStore(null);
    try {
      const who = await cartIdentity();
      if (n !== sequence.current) return;
      setIdentity(who);
      if (!who) return;
      const [book, basket, policy] = await Promise.all([
        addressRequest<ConsumerAddressBook>(who, '/consumer/addresses'),
        readAccountCart(who),
        request<{ status: string; policy: CheckoutPolicy | null }>('/store'),
      ]);
      if (n !== sequence.current) return;
      setAddresses(book);
      setCart(basket);
      setStore(policy);
      setSelected(book.items.find((a) => a.isDefault && a.available)?.id ?? '');
      setMergePending(Boolean(pendingMerge()));
    } catch (e) {
      if (n === sequence.current)
        setError(e instanceof Error ? e.message : '结算资料读取失败，请重试');
    } finally {
      if (n === sequence.current) setLoading(false);
    }
  }
  useDidShow(() => {
    if (!intent.current) void load();
  });
  useDidHide(() => {
    sequence.current++;
  });
  function body() {
    return { addressId: selected, addressVersion: addresses!.version, cartVersion: cart!.version };
  }
  async function check() {
    if (!identity || !addresses || !cart || !selected || writing.current || intent.current) return;
    const n = ++sequence.current;
    writing.current = true;
    setBusy(true);
    setError('');
    setPreview(null);
    setQuote(null);
    try {
      const result = await addressRequest<CheckoutPreview>(
        identity,
        '/consumer/checkout/preview',
        body(),
      );
      if (n === sequence.current) setPreview(result);
    } catch (e) {
      if (n === sequence.current) setError(e instanceof Error ? e.message : '核验失败，请重新读取');
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  async function generate() {
    if (writing.current || (!intent.current && (!identity || !preview?.ready))) return;
    const attempt = intent.current ?? {
      identity: identity!,
      key: addressOperationKey(),
      body: body(),
    };
    intent.current = attempt;
    writing.current = true;
    setBusy(true);
    setError('');
    const wasUnknown = unknown;
    try {
      const result = await addressRequest<CheckoutQuote>(
        attempt.identity,
        '/consumer/checkout/quotes',
        attempt.body,
        attempt.key,
      );
      intent.current = null;
      setUnknown(false);
      setQuote(result);
      setPreview(result.preview);
      setNow(Date.now());
    } catch (e) {
      if (
        e instanceof AddressRequestError &&
        e.status < 500 &&
        !(wasUnknown && [401, 403, 429].includes(e.status))
      ) {
        intent.current = null;
        setUnknown(false);
        setPreview(null);
        setQuote(null);
        setError(e.message + '。请重新核验，必要时刷新资料。');
      } else {
        setUnknown(true);
        setError('报价结果尚未确认，请保留本页，使用原操作重试确认；报价不会占用库存。');
      }
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  const row = addresses?.items.find((a) => a.id === selected);
  const selectedCount = cart?.items.filter((i) => i.selected).length ?? 0;
  const expired = quote && (quote.expired || Date.parse(quote.expiresAt) <= now);
  return (
    <View className="checkout-page">
      <View className="address-hero">
        <Text className="account-eyebrow">YUMI · CHECK BEFORE ORDER</Text>
        <Text className="address-title">结算核验</Text>
        <Text className="address-subtitle">核对商品、地址与费用，放心准备下一步</Text>
      </View>
      <View className="address-content">
        <View className="checkout-notice">
          当前可以核验和查看报价，提交订单及支付尚未开放。报价不锁价、不占库存，正式下单时仍须重新校验。
        </View>
        {error && (
          <View className="address-alert checkout-error">
            <Text>{error}</Text>
            {unknown && (
              <Button className="account-primary" disabled={busy} onClick={() => void generate()}>
                原报价操作重试
              </Button>
            )}
          </View>
        )}
        {loading ? (
          <View className="address-state">正在读取结算资料…</View>
        ) : !identity ? (
          <View className="address-state">
            <Text>登录后可核验账号购物车</Text>
            <Button onClick={() => void Taro.navigateTo({ url: '/pages/account/index' })}>
              前往我的
            </Button>
            <Button onClick={() => void load()}>重新读取</Button>
          </View>
        ) : !addresses || !cart || !store ? (
          <View className="address-state">
            <Text>结算资料暂未读取完整</Text>
            <Button onClick={() => void load()}>重试读取</Button>
          </View>
        ) : (
          <>
            {store.status !== 'OPEN' && (
              <View className="address-alert checkout-store">
                {store.status === 'UNCONFIGURED'
                  ? '运费、起送和报价状态尚未配置，可先核验商品与地址。'
                  : '当前暂停生成报价，可先核验商品与地址。'}
              </View>
            )}
            {mergePending && (
              <View className="address-alert">请先回购物车处理待确认的本机草稿合并。</View>
            )}
            <View className="checkout-address address-card">
              <Text className="address-section-title">收货地址</Text>
              <Picker
                mode="selector"
                disabled={busy || unknown}
                range={[
                  '请选择收货地址',
                  ...addresses.items.map(
                    (a) =>
                      `${a.areaName} ${a.buildingName} ${a.room}${a.available ? '' : '（暂不可配送）'}`,
                  ),
                ]}
                value={addresses.items.findIndex((a) => a.id === selected) + 1}
                onChange={(e) => {
                  setSelected(addresses.items[Number(e.detail.value) - 1]?.id ?? '');
                  setPreview(null);
                  setQuote(null);
                  setError('');
                }}
              >
                <View className="address-picker">
                  {row ? `${row.areaName} · ${row.buildingName}` : '请选择本人收货地址'}
                  <Text>⌄</Text>
                </View>
              </Picker>
              {row && (
                <>
                  <Text className="address-room">
                    {row.unit} {row.room}
                  </Text>
                  <Text className="address-contact">
                    {row.contactName} {row.phone}
                  </Text>
                  {!row.available && (
                    <Text className="address-unavailable">此地址暂不在有效配送范围</Text>
                  )}
                </>
              )}
              <Button
                className="checkout-link"
                disabled={busy || unknown}
                onClick={() => void Taro.navigateTo({ url: '/pages/addresses/index' })}
              >
                管理收货地址
              </Button>
            </View>
            <View className="address-card">
              <View className="checkout-heading">
                <Text className="address-section-title">已选商品</Text>
                <Text>{selectedCount} 种规格</Text>
              </View>
              {!selectedCount && (
                <Text className="address-hint">请在账号购物车勾选需要核验的商品。</Text>
              )}
              {cart.items
                .filter((i) => i.selected)
                .map((i) => (
                  <View className="checkout-draft" key={i.skuId}>
                    <View>
                      <Text>{i.name}</Text>
                      <Text className="address-hint">
                        {i.spec} · {i.unit}
                      </Text>
                    </View>
                    <Text>×{i.quantity}</Text>
                  </View>
                ))}
              <Button
                className="checkout-link"
                disabled={busy || unknown}
                onClick={() => void Taro.navigateTo({ url: '/pages/cart/index' })}
              >
                返回购物车调整
              </Button>
            </View>
            <Button
              className="account-primary checkout-check"
              disabled={busy || unknown || !selected || !selectedCount || mergePending}
              onClick={() => void check()}
            >
              {busy ? '正在核验…' : '核验商品与费用'}
            </Button>
            {preview && (
              <View className="address-card checkout-result">
                <Text className="address-section-title">{quote ? '本次报价' : '核验结果'}</Text>
                {preview.issues.map((i) => (
                  <View className="address-alert checkout-issue" key={i.code}>
                    {i.message}
                  </View>
                ))}
                {preview.lines.map((line) => (
                  <View className="checkout-line" key={line.skuId}>
                    <View>
                      <Text>{line.name}</Text>
                      <Text className="address-hint">
                        {line.spec} · {line.quantity}
                        {line.unit}
                      </Text>
                      <Text
                        className={
                          line.status === 'AVAILABLE' ? 'checkout-good' : 'address-unavailable'
                        }
                      >
                        {line.status === 'AVAILABLE'
                          ? '当前可售'
                          : line.status === 'EXCESS'
                            ? '当前库存不足'
                            : '商品已失效'}
                      </Text>
                    </View>
                    <View>
                      <Text>{money(line.lineCents)}</Text>
                      <Text className="address-hint">
                        {line.priceCents === null
                          ? '未取得有效售价'
                          : money(line.priceCents) + ' / ' + line.unit}
                      </Text>
                    </View>
                  </View>
                ))}
                <View className="checkout-amount">
                  <Text>商品金额</Text>
                  <Text>{money(preview.goodsCents)}</Text>
                </View>
                <View className="checkout-amount">
                  <Text>配送费</Text>
                  <Text>
                    {preview.deliveryFeeCents === null
                      ? '暂未报价'
                      : money(preview.deliveryFeeCents)}
                  </Text>
                </View>
                <View className="checkout-total">
                  <Text>合计</Text>
                  <Text>
                    {preview.payableCents === null ? '暂不能确定' : money(preview.payableCents)}
                  </Text>
                </View>
                {preview.policy && (
                  <Text className="address-hint">
                    起送商品金额 {money(preview.policy.minGoodsCents)} ·{' '}
                    {preview.policy.freeDeliveryThresholdCents === null
                      ? '不设免运'
                      : '满' + money(preview.policy.freeDeliveryThresholdCents) + '免配送费'}
                  </Text>
                )}
                {quote ? (
                  <View className="checkout-expiry">
                    <Text>
                      {expired
                        ? '本次报价已过期，请重新核验'
                        : `报价有效至 ${new Date(quote.expiresAt).toLocaleTimeString('zh-CN', { hour12: false })}`}
                    </Text>
                    <Text className="address-hint">
                      以上为生成时的费用，后续商品、地址或规则变化需重新确认。
                    </Text>
                  </View>
                ) : (
                  preview.ready && (
                    <Button
                      className="account-primary checkout-generate"
                      disabled={busy || unknown}
                      onClick={() => void generate()}
                    >
                      生成本次报价
                    </Button>
                  )
                )}
              </View>
            )}
            <Button
              className="checkout-refresh address-cancel"
              disabled={busy || unknown}
              onClick={() => void load()}
            >
              刷新购物车与地址资料
            </Button>
            <Button disabled className="checkout-order-disabled">
              提交订单尚未开放
            </Button>
          </>
        )}
      </View>
    </View>
  );
}
