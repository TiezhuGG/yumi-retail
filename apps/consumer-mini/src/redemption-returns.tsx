import { View, Text, Button, Input, Textarea } from '@tarojs/components';
import Taro, { useDidHide, useDidShow } from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import type { RedemptionReturnPage } from '../../../packages/contracts/src/index';
import { cartIdentity } from './account-cart';
import { addressRequest, AddressRequestError } from './address-api';
import { addressOperationKey } from './address-api';
const states = {
  REQUESTED: '等待门店审核',
  WAIT_RETURN: '审核通过 · 等待退货',
  READY_TO_REFUND: '已审核 · 等待退积分',
  REFUNDED: '积分已退还',
  REJECTED: '申请未通过',
  CANCELED: '申请已撤销',
};
export function RedemptionReturns({ orderId, returnId }: { orderId: string; returnId?: string }) {
  const [page, setPage] = useState<RedemptionReturnPage | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [quantity, setQuantity] = useState('1'),
    [reason, setReason] = useState(''),
    [pending, setPending] = useState(false),
    [recoverHere, setRecoverHere] = useState(true);
  const seq = useRef(0),
    writing = useRef(false),
    owner = useRef('');
  const prefix = '/consumer/redemptions/' + orderId + '/returns',
    storage = (u: string) => 'yumi.return.v1:' + u + ':' + orderId;
  type Intent = { key: string; id?: string; body: Record<string, unknown> };
  function stored(u: string): Intent | null {
    const v = Taro.getStorageSync(storage(u)) as Intent | null;
    if (v && (!v.key || !v.body || typeof v.body !== 'object'))
      throw Error('原售后请求无法读取，请联系门店核实');
    return v;
  }
  async function load() {
    const n = ++seq.current;
    setLoading(true);
    setPage(null);
    setError('');
    try {
      const who = await cartIdentity();
      if (!who) throw Error('请先登录查看本人售后');
      if (n !== seq.current) return;
      owner.current = who.profile.user.id;
      const original = stored(owner.current);
      setPending(!!original);
      setRecoverHere(!returnId || original?.id === returnId);
      const p = await addressRequest<RedemptionReturnPage>(who, prefix);
      if (n === seq.current) {
        if (returnId && !p.items.some((v) => v.id === returnId)) throw Error('未找到本人售后申请');
        setPage(p);
      }
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '售后读取失败');
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      seq.current++;
    };
  }, [orderId, returnId]);
  useDidShow(() => {
    if (returnId) void load();
  });
  useDidHide(() => {
    seq.current++;
    setPage(null);
    setReason('');
  });
  async function write(id?: string) {
    if (writing.current || !page) return;
    writing.current = true;
    setBusy(true);
    setError('');
    const n = seq.current;
    try {
      const who = await cartIdentity();
      if (!who || who.profile.user.id !== owner.current)
        throw Error('登录账号已变化，请重新进入订单');
      const intent = stored(owner.current) ?? {
        key: addressOperationKey(),
        id,
        body: id ? {} : { quantity: Number(quantity), reason: reason.trim() },
      };
      Taro.setStorageSync(storage(owner.current), intent);
      setPending(true);
      setRecoverHere(true);
      await addressRequest(
        who,
        prefix + (intent.id ? '/' + intent.id + '/cancel' : ''),
        intent.body,
        intent.key,
      );
      Taro.removeStorageSync(storage(owner.current));
      if (n === seq.current) {
        setPending(false);
        setReason('');
        await load();
      }
    } catch (e) {
      if (n === seq.current) {
        if (e instanceof AddressRequestError && e.status < 500) {
          Taro.removeStorageSync(storage(owner.current));
          setPending(false);
          if ([401, 403, 404].includes(e.status)) {
            setPage(null);
            setReason('');
          }
        }
        setError(
          e instanceof Error && !(e instanceof TypeError)
            ? e.message
            : '提交结果暂未确认，请使用原请求核实',
        );
      }
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  const valid =
    /^[1-9]\d*$/.test(quantity) &&
    Number(quantity) <= (page?.remainingQuantity ?? 0) &&
    !!reason.trim();
  return (
    <View className="account-card return-card">
      <Text className="account-card-title">退货 / 退积分</Text>
      {!returnId && (
        <Text className="account-copy">
          按原兑换积分价申请，由门店审核。需要退货时，请先联系门店确认寄回方式。
        </Text>
      )}
      {loading && <Text className="account-copy">正在读取售后申请…</Text>}
      {error && (
        <View className="account-error">
          <Text>{error}</Text>
        </View>
      )}
      {pending && (
        <Button
          className="points-action"
          disabled={busy || loading}
          onClick={() =>
            recoverHere
              ? void write()
              : void Taro.navigateTo({ url: '/pages/redemption/index?id=' + orderId })
          }
        >
          {recoverHere ? '使用原请求核实售后' : '到订单核实原售后'}
        </Button>
      )}
      {page?.items
        .filter((v) => !returnId || v.id === returnId)
        .map((v) => (
          <View className="after-sales-event" key={v.id}>
            <Text className="account-card-title">{states[v.state]}</Text>
            {returnId && (
              <>
                <Text className="account-copy">{v.title}</Text>
                <Text className="account-copy">订单号：{v.orderNo}</Text>
                <Text className="account-copy">
                  申请时间：
                  {new Date(v.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                </Text>
              </>
            )}
            <Text className="account-copy">
              {v.quantity} 件 · {v.points} 积分
            </Text>
            <Text className="account-copy">申请说明：{v.reason}</Text>
            {v.events.map((e) => (
              <View key={e.kind}>
                <Text className="account-copy">
                  {new Date(e.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })} ·{' '}
                  {e.kind === 'REFUND'
                    ? '已原额退积分'
                    : e.kind === 'RECEIVE'
                      ? '门店已核验退货'
                      : e.kind === 'APPROVE'
                        ? v.requiresReturn
                          ? '请联系门店寄回商品'
                          : '无需退货，等待退积分'
                        : e.kind === 'REJECT'
                          ? '审核未通过'
                          : '已撤销'}
                </Text>
                <Text className="account-copy">{e.reason}</Text>
              </View>
            ))}
            {v.state === 'REQUESTED' && (
              <Button
                className="account-link"
                disabled={busy || pending || !page.enabled}
                onClick={() => void write(v.id)}
              >
                撤销本次申请
              </Button>
            )}
          </View>
        ))}
      {page && !returnId && page.remainingQuantity > 0 && !pending && (
        <>
          <Text className="account-card-title">申请售后</Text>
          <Text className="account-copy">
            最多可申请 {page.remainingQuantity} 件，申请中及已退件数占用可退额度。
          </Text>
          <Input
            type="number"
            aria-label="售后申请件数"
            value={quantity}
            disabled={busy || !page.enabled}
            onInput={(e) => setQuantity(e.detail.value)}
          />
          <Textarea
            className="after-sales-input"
            aria-label="退货退积分原因"
            placeholder="请说明商品问题及希望的处理方式"
            maxlength={500}
            value={reason}
            disabled={busy || !page.enabled}
            onInput={(e) => setReason(e.detail.value)}
          />
          <Button
            className="points-action"
            disabled={busy || !page.enabled || !valid}
            onClick={() => void write()}
          >
            提交申请
            {valid ? ' · ' + String(Number(page.unitPoints) * Number(quantity)) + ' 积分' : ''}
          </Button>
        </>
      )}
      {page && !page.enabled && (
        <Text className="account-copy">当前售后操作暂未开放，已有记录仍可查看。</Text>
      )}
      <Button className="account-link" disabled={loading || busy} onClick={() => void load()}>
        刷新售后进度
      </Button>
    </View>
  );
}
