import { View, Text, Button, Picker } from '@tarojs/components';
import Taro, { useDidShow, useDidHide, useRouter } from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import type {
  ExpressAddressBook,
  RedemptionExpressPolicy,
  RedemptionQuoteView,
} from '../../../../../packages/contracts/src/index';
import { cartIdentity } from '../../account-cart';
import type { CartIdentity } from '../../account-cart';
import { addressRequest, addressOperationKey, AddressRequestError } from '../../address-api';
import { request } from '../../api';
import type { Reward } from '../../rewards-api';
import { orderSubmission, parseOrderIntent, OrderIntentRejection } from '../../order-intent';
import { redemptionIntentKey } from '../../redemption-storage';
export default function RedemptionCheckout() {
  const [access, setAccess] = useState<{
    executionMode: string;
    canSubmit: boolean;
    reason: string;
  } | null>(null);
  const params = useRouter().params;
  const [identity, setIdentity] = useState<CartIdentity | null>(null),
    [policy, setPolicy] = useState<RedemptionExpressPolicy | null>(null),
    [book, setBook] = useState<ExpressAddressBook | null>(null),
    [reward, setReward] = useState<Reward | null>(null),
    [selected, setSelected] = useState(''),
    [quote, setQuote] = useState<RedemptionQuoteView | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false),
    [rejected, setRejected] = useState(false),
    [now, setNow] = useState(Date.now());
  const seq = useRef(0),
    writing = useRef(false),
    quoteIntent = useRef<{ key: string; body: unknown } | null>(null);
  const [quoteUnknown, setQuoteUnknown] = useState(false);
  const read = () => Taro.getStorageSync(redemptionIntentKey);
  async function load() {
    const n = ++seq.current;
    setLoading(true);
    setIdentity(null);
    setAccess(null);
    setBook(null);
    setReward(null);
    setPolicy(null);
    setQuote(null);
    setError('');
    try {
      const who = await cartIdentity();
      if (n !== seq.current) return;
      setIdentity(who);
      if (!who) return;
      const original = parseOrderIntent(read());
      setPending(!!original);
      if (original && original.userId !== who.profile.user.id)
        throw Error('有其他账号的兑换待核实，请恢复原账号处理。');
      const [addresses, product, shippingPolicy, accessInfo] = await Promise.all([
        addressRequest<ExpressAddressBook>(who, '/consumer/express-addresses'),
        request<Reward>('/rewards/' + encodeURIComponent(params.id ?? '')),
        request<RedemptionExpressPolicy>('/redemption-express-policy'),
        addressRequest<{ executionMode: string; canSubmit: boolean; reason: string }>(
          who,
          '/consumer/redemption-access',
        ),
      ]);
      if (n !== seq.current) return;
      setBook(addresses);
      setReward(product);
      setPolicy(shippingPolicy);
      setAccess(accessInfo);
      setSelected(addresses.items.find((a) => a.isDefault && a.available)?.id ?? '');
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '兑换资料读取失败');
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }
  useDidShow(() => {
    void load();
  });
  useDidHide(() => {
    seq.current++;
    quoteIntent.current = null;
    setQuoteUnknown(false);
    setBusy(false);
    setIdentity(null);
    setBook(null);
    setQuote(null);
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
    if (writing.current || !identity || !book || !reward) return;
    writing.current = true;
    setBusy(true);
    setError('');
    const n = seq.current;
    try {
      const quantity = Number(params.quantity ?? '1');
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000)
        throw Error('兑换数量无效，请返回商品详情');
      if (!selected) throw Error('请选择本人有效收货地址');
      quoteIntent.current ??= {
        key: addressOperationKey(),
        body: {
          rewardId: reward.id,
          rewardVersion: reward.version,
          quantity,
          addressId: selected,
          addressVersion: book.version,
          deliveryMode: 'EXPRESS',
        },
      };
      const q = await addressRequest<RedemptionQuoteView>(
        identity,
        '/consumer/redemption-quotes',
        quoteIntent.current.body,
        quoteIntent.current.key,
      );
      quoteIntent.current = null;
      if (n !== seq.current) return;
      setQuote(q);
      setNow(Date.now());
      setQuoteUnknown(false);
    } catch (e) {
      const uncertain = !(e instanceof AddressRequestError) || e.status >= 500;
      if (!uncertain) quoteIntent.current = null;
      if (n === seq.current) {
        setQuoteUnknown(uncertain && !!quoteIntent.current);
        setQuote(null);
        setError(e instanceof Error ? e.message : '报价读取失败');
      }
    } finally {
      writing.current = false;
      if (n === seq.current) setBusy(false);
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
      let original = parseOrderIntent(read());
      if (!original && (!quote || quote.expired || Date.parse(quote.expiresAt) <= Date.now()))
        throw Error('请先生成并确认有效报价');
      const flow = orderSubmission({
        read,
        write: (v) => {
          Taro.setStorageSync(redemptionIntentKey, v);
          if (n === seq.current) setPending(true);
        },
        newKey: addressOperationKey,
        send: async (v) => {
          try {
            return await addressRequest<{ id: string }>(
              who,
              '/consumer/redemptions',
              { quoteId: v.quoteId },
              v.key,
            );
          } catch (e) {
            if (e instanceof AddressRequestError)
              throw new OrderIntentRejection(
                e.status,
                e.code === 'EXPRESS_SUBMISSION_PAUSED'
                  ? '新兑换已暂停，已受理订单仍可查询与处理'
                  : e.message,
              );
            throw e;
          }
        },
      });
      const id = await flow.submit(who.profile.user.id, original?.quoteId ?? quote!.id);
      original = parseOrderIntent(read());
      if (n === seq.current && original?.userId === who.profile.user.id)
        await Taro.navigateTo({ url: '/pages/redemption/index?id=' + id });
    } catch (e) {
      if (n === seq.current) {
        setError(e instanceof Error ? e.message : '兑换结果尚未确认，请使用原请求核实');
        setRejected(e instanceof OrderIntentRejection && [400, 403, 404, 409].includes(e.status));
      }
    } finally {
      writing.current = false;
      if (n === seq.current) setBusy(false);
    }
  }
  function clearRejected() {
    try {
      const v = parseOrderIntent(read());
      if (!rejected || !identity || v?.userId !== identity.profile.user.id || v.orderId)
        throw Error('请先核实本人原兑换');
      Taro.removeStorageSync(redemptionIntentKey);
      setPending(false);
      setRejected(false);
      setQuote(null);
      setError('本次未创建兑换单，请重新读取商品和地址后报价。');
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作记录保留');
    }
  }
  const choices = book?.items.filter((a) => a.available) ?? [],
    address = choices.find((a) => a.id === selected);
  return (
    <View className="account-page reward-detail-page">
      <View className="account-hero">
        <Text className="account-eyebrow">YUMI · 积分兑换</Text>
        <Text className="account-name">确认兑换</Text>
      </View>
      <View className="account-content">
        <View className="reward-notice">
          <Text>确认后扣除积分并预占商品，订单进入待快递发货。</Text>
          <Text>寄送范围和运费以本次核验为准。</Text>
        </View>
        {loading && <Text className="account-copy">正在读取兑换资料…</Text>}
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
            前往登录
          </Button>
        )}
        {pending && (
          <View className="account-card">
            <Text className="account-card-title">有一笔兑换待核实</Text>
            <Text className="account-copy">
              已保留原账号、报价与操作编号，请使用原请求核实，避免重复兑换。
            </Text>
            <Button className="points-action" disabled={busy} onClick={() => void submit()}>
              核实原兑换操作
            </Button>
            {rejected && (
              <Button className="points-action" disabled={busy} onClick={clearRejected}>
                已确认未创建，重新核验
              </Button>
            )}
          </View>
        )}
        {!pending && reward && book && (
          <>
            <View className="account-card">
              <Text className="account-card-title">快递收货地址</Text>
              <Text className="account-copy">
                {policy?.enabled
                  ? '可寄送：' + policy.provinces.join('、') + ' · 商家承担运费'
                  : '快递兑换暂未开放，请联系门店核实寄送规则'}
              </Text>
              <Text className="account-copy">请选择本人有效快递地址</Text>
              <Picker
                disabled={busy || quoteUnknown}
                range={choices.map((a) =>
                  [a.province, a.city, a.district, a.detailAddress].join(' '),
                )}
                value={Math.max(
                  0,
                  choices.findIndex((a) => a.id === selected),
                )}
                onChange={(e) => {
                  setSelected(choices[Number(e.detail.value)]?.id ?? '');
                  setQuote(null);
                }}
              >
                <View className="redemption-address">
                  {address
                    ? [
                        address.province,
                        address.city,
                        address.district,
                        address.detailAddress,
                      ].join(' ')
                    : '点击选择收货地址'}
                </View>
              </Picker>
              <Button
                className="account-link"
                disabled={busy || quoteUnknown}
                onClick={() => void Taro.navigateTo({ url: '/pages/express-addresses/index' })}
              >
                管理快递地址 →
              </Button>
            </View>
            <View className="account-card">
              <Text className="account-card-title">兑换商品</Text>
              <Text className="account-copy">{reward.title}</Text>
              <Text className="account-copy">
                {reward.spec} / {reward.unit} · {params.quantity ?? '1'} 件
              </Text>
            </View>
            {access && (
              <Text className="account-copy">
                {access.canSubmit
                  ? '可继续核验商品、地址与积分'
                  : access.reason === '当前仅向受控测试账号开放兑换'
                    ? '当前账号暂不可兑换'
                    : access.reason}
              </Text>
            )}
            <Button
              className="points-action"
              disabled={
                busy ||
                !access?.canSubmit ||
                !reward.redemptionEnabled ||
                !policy?.enabled ||
                !selected
              }
              onClick={() => void makeQuote()}
            >
              {quoteUnknown ? '使用原请求重试报价' : '核验并生成兑换报价'}
            </Button>
            {quote && (
              <View className="account-card">
                <Text className="account-card-title">
                  确认扣除 {quote.snapshot.totalPoints} 积分
                </Text>
                <Text className="account-copy">
                  积分单价 {quote.snapshot.pointsPrice} · 数量 {quote.snapshot.quantity} 件
                </Text>
                <Text className="account-copy">运费由商家承担，无需另付现金</Text>
                <Text className="account-copy">
                  核验时余额 {quote.snapshot.balance} · 兑换后剩余 {quote.snapshot.remainingBalance}
                </Text>
                <Text className="account-copy">
                  {quote.expired || Date.parse(quote.expiresAt) <= now
                    ? '报价已过期，请重新核验'
                    : '报价有效期2分钟，提交时将再次核验'}
                </Text>
                <Button
                  className="points-action"
                  disabled={busy || quote.expired || Date.parse(quote.expiresAt) <= now}
                  onClick={() => void submit()}
                >
                  {busy ? '正在确认兑换…' : '确认扣除 ' + quote.snapshot.totalPoints + ' 积分兑换'}
                </Button>
              </View>
            )}
          </>
        )}
        <Button
          className="account-link"
          disabled={busy || quoteUnknown}
          onClick={() => void load()}
        >
          重新读取商品与地址
        </Button>
        <Button
          className="account-link"
          onClick={() => void Taro.switchTab({ url: '/pages/redemptions/index' })}
        >
          我的兑换订单 →
        </Button>
      </View>
    </View>
  );
}
