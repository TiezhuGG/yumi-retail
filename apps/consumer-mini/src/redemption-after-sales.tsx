import { View, Text, Button, Picker, Textarea } from '@tarojs/components';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import type { RedemptionAfterSalesView } from '../../../packages/contracts/src/index';
import { cartIdentity } from './account-cart';
import { addressRequest, addressOperationKey, AddressRequestError } from './address-api';
const categories = [
  ['NOT_RECEIVED', '未收到商品'],
  ['DAMAGED', '商品破损'],
  ['WRONG_ITEM', '商品不符'],
  ['OTHER', '其他问题'],
];
const statuses: Record<string, string> = {
  OPEN: '待门店处理',
  PROCESSING: '处理中',
  CLOSED: '本次反馈已结束',
};
type Intent = {
  key: string;
  action: 'create' | 'supplement' | 'reopen';
  body: Record<string, unknown>;
};
export function RedemptionAfterSales({ orderId }: { orderId: string }) {
  const [view, setView] = useState<RedemptionAfterSalesView | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [category, setCategory] = useState(0);
  const seq = useRef(0),
    writing = useRef(false),
    owner = useRef('');
  const storage = (u: string) => 'yumi.redemption-aftersales.v1:' + u + ':' + orderId;
  function stored(u: string): Intent | null {
    const v = Taro.getStorageSync(storage(u)) as Intent | null;
    if (!v) return null;
    if (
      typeof v.key !== 'string' ||
      !['create', 'supplement', 'reopen'].includes(v.action) ||
      !v.body ||
      typeof v.body !== 'object'
    )
      throw Error('原反馈请求无法读取，请保留并联系门店核实');
    return v;
  }
  async function load() {
    const n = ++seq.current;
    setLoading(true);
    setView(null);
    setMessage('');
    setError('');
    setPending(false);
    try {
      const who = await cartIdentity();
      if (n !== seq.current) return;
      if (!who) throw Error('请登录后查看本人反馈');
      owner.current = who.profile.user.id;
      setPending(!!stored(owner.current));
      const v = await addressRequest<RedemptionAfterSalesView>(
        who,
        '/consumer/redemptions/' + orderId + '/after-sales',
      );
      if (n === seq.current) setView(v);
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '反馈读取失败');
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }
  useDidShow(() => {
    void load();
  });
  useDidHide(() => {
    seq.current++;
    owner.current = '';
    setView(null);
    setMessage('');
    setError('');
    setPending(false);
    setBusy(false);
  });
  useEffect(
    () => () => {
      seq.current++;
    },
    [],
  );
  async function submit() {
    if (writing.current || !view) return;
    writing.current = true;
    setBusy(true);
    setError('');
    const n = seq.current;
    let user = '';
    try {
      const who = await cartIdentity();
      if (!who || who.profile.user.id !== owner.current)
        throw Error('登录账号已变化，请刷新本人反馈');
      user = who.profile.user.id;
      const action = !view.ticket
        ? 'create'
        : view.ticket.status === 'CLOSED'
          ? 'reopen'
          : 'supplement';
      const intent = stored(user) ?? {
        key: addressOperationKey(),
        action,
        body: {
          message: message.trim(),
          ...(!view.ticket
            ? { category: categories[category]![0] }
            : { version: view.ticket.version }),
        },
      };
      Taro.setStorageSync(storage(user), intent);
      setPending(true);
      await addressRequest(
        who,
        '/consumer/redemptions/' +
          orderId +
          '/after-sales' +
          (intent.action === 'create' ? '' : '/' + intent.action),
        intent.body,
        intent.key,
      );
      Taro.removeStorageSync(storage(user));
      if (n === seq.current) {
        setBusy(false);
        await load();
      }
    } catch (e) {
      if (n === seq.current) {
        if (e instanceof AddressRequestError && e.status < 500) {
          if (user) Taro.removeStorageSync(storage(user));
          setPending(false);
          setView(null);
          setMessage('');
        }
        setError(e instanceof Error ? e.message : '反馈结果未知，请使用原请求核实');
      }
    } finally {
      writing.current = false;
      if (n === seq.current) setBusy(false);
    }
  }
  const ticket = view?.ticket;
  return (
    <View className="account-card after-sales-card">
      <Text className="account-card-title">售后反馈</Text>
      <Text className="account-copy">商品或配送遇到问题，可在此反馈并查看门店回复。</Text>
      {loading && <Text className="account-copy">正在读取反馈进度…</Text>}
      {error && (
        <View className="account-error">
          <Text>{error}</Text>
        </View>
      )}
      {view && (
        <>
          <Text className="account-card-title">
            {ticket ? statuses[ticket.status] : '暂无售后反馈'}
          </Text>
          {ticket && (
            <>
              <Text className="account-copy">
                问题类型：{categories.find((c) => c[0] === ticket.category)?.[1] ?? ticket.category}
              </Text>
              {ticket.events.map((e) => (
                <View key={e.version} className="after-sales-event">
                  <Text className="account-card-title">
                    {e.actor === 'CUSTOMER'
                      ? e.kind === 'SUBMITTED'
                        ? '我的反馈'
                        : e.kind === 'REOPENED'
                          ? '重新反馈'
                          : '补充说明'
                      : e.kind === 'CLOSED'
                        ? '门店处理说明'
                        : '门店回复'}
                  </Text>
                  <Text className="account-copy after-sales-message">{e.message}</Text>
                  <Text className="account-copy">
                    {new Date(e.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                    （北京时间）
                  </Text>
                </View>
              ))}
            </>
          )}
          {pending ? (
            <>
              <Text className="account-copy">有一笔反馈请求待核实，请保留原请求。</Text>
              <Button
                className="account-primary after-sales-submit"
                disabled={busy || loading}
                onClick={() => void submit()}
              >
                核实原反馈请求
              </Button>
            </>
          ) : view.enabled && (ticket || view.canSubmit) ? (
            <>
              {!ticket && (
                <>
                  <Text className="account-copy">问题类型</Text>
                  <Picker
                    range={categories.map((c) => c[1]!)}
                    value={category}
                    disabled={busy}
                    onChange={(e) => setCategory(Number(e.detail.value))}
                  >
                    <View className="after-sales-picker">{categories[category]![1]} ▾</View>
                  </Picker>
                </>
              )}
              <Textarea
                className="after-sales-input"
                maxlength={500}
                disabled={busy}
                value={message}
                onInput={(e) => setMessage(e.detail.value)}
                placeholder={
                  ticket
                    ? ticket.status === 'CLOSED'
                      ? '仍需帮助？请说明原因重新反馈'
                      : '补充问题说明（最多500字）'
                    : '请描述商品或配送问题（最多500字）'
                }
              />
              <Text className="account-copy">
                请勿填写电话、地址等个人信息。反馈由门店人工处理，处理进度以此处回复为准。
              </Text>
              <Button
                className="account-primary after-sales-submit"
                disabled={busy || loading || !message.trim()}
                onClick={() => void submit()}
              >
                {busy
                  ? '正在提交…'
                  : !ticket
                    ? '提交售后反馈'
                    : ticket.status === 'CLOSED'
                      ? '重新反馈'
                      : '补充说明'}
              </Button>
            </>
          ) : (
            <Text className="account-copy">反馈操作暂未开放，可稍后刷新查看。</Text>
          )}
        </>
      )}
      <Button className="account-link" disabled={loading || busy} onClick={() => void load()}>
        刷新反馈进度
      </Button>
    </View>
  );
}
