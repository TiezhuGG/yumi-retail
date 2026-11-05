import { View, Text, Button, Picker } from '@tarojs/components';
import Taro, { useDidShow, useDidHide, useRouter } from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import type {
  ExpressAddressBook,
  RedemptionCartQuoteView,
} from '../../../../../packages/contracts/src/index';
import { cartIdentity } from '../../account-cart';
import type { CartIdentity } from '../../account-cart';
import { addressRequest, addressOperationKey, AddressRequestError } from '../../address-api';
import { request } from '../../api';
import type { Reward } from '../../rewards-api';
import {
  pointsCartKey,
  pointsCheckoutKey,
  readPointsIntent,
  consumePointsCart,
} from '../../points-cart';
import type { PointsCartLine, PointsCheckoutIntent } from '../../points-cart';
import { LoadingState } from '../../components/LoadingState';
type Quote = RedemptionCartQuoteView;
export default function PointsCheckout() {
  const params = useRouter().params;
  const [identity, setIdentity] = useState<CartIdentity | null>(null),
    [book, setBook] = useState<ExpressAddressBook | null>(null),
    [items, setItems] = useState<Array<PointsCartLine & { product: Reward }>>([]),
    [addressId, setAddressId] = useState(''),
    [quote, setQuote] = useState<Quote | null>(null),
    [intent, setIntent] = useState<PointsCheckoutIntent | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [reason, setReason] = useState(''),
    [canSubmit, setCanSubmit] = useState(false),
    [rejected, setRejected] = useState(false),
    [now, setNow] = useState(Date.now()),
    [quoteUnknown, setQuoteUnknown] = useState(false);
  const seq = useRef(0),
    writing = useRef(false),
    quoteRequest = useRef<{ key: string; body: unknown } | null>(null);
  async function load() {
    const n = ++seq.current;
    setLoading(true);
    setError('');
    setIdentity(null);
    setBook(null);
    setItems([]);
    setIntent(null);
    setQuote(null);
    try {
      const who = await cartIdentity();
      if (n !== seq.current) return;
      setIdentity(who);
      if (!who) return;
      const pending = readPointsIntent();
      if (pending && pending.userId !== who.profile.user.id)
        throw Error('有其他账号的兑换记录待核实，请恢复原账号处理');
      setIntent(pending);
      if (pending) {
        if (pending.result && !pending.cleared) {
          consumePointsCart(pending);
          const completed = { ...pending, cleared: true };
          Taro.setStorageSync(pointsCheckoutKey, completed);
          setIntent(completed);
        }
        return;
      }
      const raw: unknown = params.id
        ? [{ rewardId: params.id, quantity: Number(params.quantity ?? 1) }]
        : Taro.getStorageSync(pointsCartKey(who.profile.user.id) + ':selection');
      if (
        !Array.isArray(raw) ||
        !raw.length ||
        raw.length > 20 ||
        raw.some(
          (i) =>
            typeof i.rewardId !== 'string' ||
            !Number.isInteger(i.quantity) ||
            i.quantity < 1 ||
            i.quantity > 100000,
        )
      )
        throw Error('请选择要兑换的商品');
      const [addresses, access, products] = await Promise.all([
        addressRequest<ExpressAddressBook>(who, '/consumer/express-addresses'),
        addressRequest<{ canSubmit: boolean; reason: string }>(who, '/consumer/redemption-access'),
        Promise.all(
          (raw as PointsCartLine[]).map(async (i) => ({
            ...i,
            product: await request<Reward>('/rewards/' + encodeURIComponent(i.rewardId)),
          })),
        ),
      ]);
      if (n !== seq.current) return;
      setBook(addresses);
      setCanSubmit(access.canSubmit);
      setReason(access.reason);
      setItems(products);
      setAddressId(
        addresses.items.find((a) => a.available && a.isDefault)?.id ??
          addresses.items.find((a) => a.available)?.id ??
          '',
      );
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '兑换资料加载失败');
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }
  useDidShow(() => {
    void load();
  });
  useDidHide(() => {
    seq.current++;
    setIdentity(null);
    setBook(null);
    setQuote(null);
    quoteRequest.current = null;
    setQuoteUnknown(false);
  });
  useEffect(
    () => () => {
      seq.current++;
    },
    [],
  );
  useEffect(() => {
    if (!quote) return;
    const timer = setTimeout(
      () => setNow(Date.now()),
      Math.max(1, Date.parse(quote.expiresAt) - Date.now() + 10),
    );
    return () => clearTimeout(timer);
  }, [quote]);
  async function makeQuote() {
    if (writing.current || !identity || !book) return;
    writing.current = true;
    setBusy(true);
    setError('');
    const n = seq.current;
    try {
      quoteRequest.current ??= {
        key: addressOperationKey(),
        body: {
          items: items.map((i) => ({
            rewardId: i.rewardId,
            rewardVersion: i.product.version,
            quantity: i.quantity,
          })),
          addressId,
          addressVersion: book.version,
        },
      };
      const result = await addressRequest<Quote>(
        identity,
        '/consumer/redemption-cart-quotes',
        quoteRequest.current.body,
        quoteRequest.current.key,
      );
      quoteRequest.current = null;
      if (n !== seq.current) return;
      setQuote(result);
      setNow(Date.now());
      setQuoteUnknown(false);
    } catch (e) {
      const unknown = !(e instanceof AddressRequestError) || e.status >= 500;
      if (!unknown) quoteRequest.current = null;
      if (n === seq.current) {
        setQuote(null);
        setQuoteUnknown(unknown);
        setError(e instanceof Error ? e.message : '报价暂未确认');
      }
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  async function submit() {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    setError('');
    setRejected(false);
    const n = seq.current;
    try {
      const who = await cartIdentity();
      if (!who) throw Error('请先登录');
      let original = readPointsIntent();
      if (original && original.userId !== who.profile.user.id) throw Error('请恢复原账号核实兑换');
      if (!original) {
        if (
          !identity ||
          identity.profile.user.id !== who.profile.user.id ||
          !quote ||
          Date.parse(quote.expiresAt) <= Date.now()
        )
          throw Error('请重新核验有效报价');
        original = {
          cartMode: !params.id,
          cloudCart: !params.id,
          userId: who.profile.user.id,
          key: addressOperationKey(),
          quoteIds: quote.quotes.map((q) => q.id),
          items: items.map((i) => ({ rewardId: i.rewardId, quantity: i.quantity })),
        };
        Taro.setStorageSync(pointsCheckoutKey, original);
        if (n === seq.current) setIntent(original);
      }
      if (!original.result) {
        const result = await addressRequest<{ orderIds: string[]; totalPoints: string }>(
          who,
          '/consumer/redemption-cart-orders',
          { quoteIds: original.quoteIds, ...(original.cloudCart ? { consumeCart: true } : {}) },
          original.key,
        );
        original = { ...original, result };
        Taro.setStorageSync(pointsCheckoutKey, original);
      }
      // Remove only the quantities actually bought; preserve products added meanwhile and direct-buy cart.
      if (!original.cleared) {
        consumePointsCart(original);
        original = { ...original, cleared: true };
        Taro.setStorageSync(pointsCheckoutKey, original);
      }
      if (n === seq.current) setIntent(original);
    } catch (e) {
      if (n === seq.current) {
        setError(e instanceof Error ? e.message : '兑换结果暂未确认，请用原请求重试');
        setRejected(e instanceof AddressRequestError && [400, 403, 404, 409].includes(e.status));
      }
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  const choices = book?.items.filter((a) => a.available) ?? [],
    address = choices.find((a) => a.id === addressId),
    expired = !!quote && Date.parse(quote.expiresAt) <= now;
  return (
    <View className="account-page">
      <View className="account-content">
        <Text className="account-name">{intent?.result ? '兑换成功' : '确认订单'}</Text>
        {loading && <LoadingState label="正在准备订单…" />}
        {error && (
          <View className="account-error">
            <Text>{error}</Text>
          </View>
        )}
        {!loading && !identity && (
          <Button
            className="points-action"
            onClick={() => void Taro.navigateTo({ url: '/pages/login/index' })}
          >
            登录后兑换
          </Button>
        )}
        {intent?.result ? (
          <View className="account-card">
            <Text className="account-card-title">
              已兑换 {intent.result.orderIds.length} 种商品
            </Text>
            <Text className="reward-price">合计扣除 {intent.result.totalPoints} 积分</Text>
            <Text className="account-copy">已按商品生成订单，可分别查看发货和申请售后。</Text>
            {intent.result.orderIds.map((id, index) => (
              <Button
                key={id}
                className="account-link"
                onClick={() => void Taro.navigateTo({ url: '/pages/redemption/index?id=' + id })}
              >
                查看商品订单 {index + 1} →
              </Button>
            ))}
            <Button
              className="points-action"
              onClick={() => void Taro.switchTab({ url: '/pages/redemptions/index' })}
            >
              查看全部订单
            </Button>
          </View>
        ) : intent ? (
          <View className="account-card">
            <Text className="account-card-title">正在核实上次兑换</Text>
            <Text className="account-copy">已保留原请求。请核实结果，避免重复扣积分。</Text>
            <Button disabled={busy} className="points-action" onClick={() => void submit()}>
              使用原请求核实兑换
            </Button>
            {rejected && (
              <Button
                disabled={busy}
                className="account-link"
                onClick={() => {
                  if (identity && readPointsIntent()?.userId === identity.profile.user.id) {
                    Taro.removeStorageSync(pointsCheckoutKey);
                    void load();
                  }
                }}
              >
                已确认未创建，重新核验
              </Button>
            )}
          </View>
        ) : (
          !!items.length && (
            <>
              <View className="account-card">
                <Text className="account-card-title">收货地址</Text>
                <Picker
                  disabled={busy || quoteUnknown}
                  range={choices.map((a) => a.province + a.city + a.district + a.detailAddress)}
                  value={Math.max(
                    0,
                    choices.findIndex((a) => a.id === addressId),
                  )}
                  onChange={(e) => {
                    setAddressId(choices[Number(e.detail.value)]?.id ?? '');
                    setQuote(null);
                  }}
                >
                  <View className="redemption-address">
                    {address ? (
                      <>
                        <Text>
                          {address.contactName} · {address.phone}
                        </Text>
                        <Text>
                          {address.province +
                            address.city +
                            address.district +
                            address.detailAddress}
                        </Text>
                      </>
                    ) : (
                      '请选择快递收货地址'
                    )}
                  </View>
                </Picker>
                <Button
                  disabled={busy || quoteUnknown}
                  className="account-link"
                  onClick={() => void Taro.navigateTo({ url: '/pages/express-addresses/index' })}
                >
                  添加或管理地址 →
                </Button>
              </View>
              <View className="account-card">
                <Text className="account-card-title">商品清单 · {items.length} 种</Text>
                {items.map((i) => (
                  <View key={i.rewardId} className="points-checkout-line">
                    <Text>{i.product.title}</Text>
                    <Text className="account-copy">
                      {i.product.spec} · {i.quantity} 件
                    </Text>
                    <Text>{Number(i.product.pointsPrice) * i.quantity} 积分</Text>
                  </View>
                ))}
              </View>
              <View className="reward-notice">
                <Text>本次仅使用积分，无需现金支付；运费由商家承担。</Text>
                <Text>
                  统一确认，有商品无法兑换时本次不会扣除积分。每种商品生成一个订单，可分别查看发货、取消及售后。
                </Text>
              </View>
              {!canSubmit && <Text className="account-error">{reason}</Text>}
              <Button
                disabled={busy || !canSubmit || !addressId}
                className="points-action"
                onClick={() => void makeQuote()}
              >
                {quoteUnknown ? '用原请求重新核验' : '核验积分与库存'}
              </Button>
              {quote && (
                <View className="account-card">
                  <Text className="reward-price">合计 {quote.totalPoints} 积分</Text>
                  <Text className="account-copy">
                    当前余额 {quote.balance} · 兑换后 {quote.remainingBalance}
                  </Text>
                  <Text className="account-copy">
                    {expired ? '报价已过期，请重新核验' : '报价两分钟内有效，提交时再次核验'}
                  </Text>
                  <Button
                    className="points-action"
                    disabled={busy || expired}
                    onClick={() => void submit()}
                  >
                    {busy ? '正在兑换…' : '确认兑换'}
                  </Button>
                </View>
              )}
            </>
          )
        )}
        {!busy && !quoteUnknown && !intent && (
          <Button className="account-link" onClick={() => void load()}>
            重新读取订单资料
          </Button>
        )}
      </View>
    </View>
  );
}
