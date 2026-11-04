import { View, Text, Button, Input, Textarea, Switch } from '@tarojs/components';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
import { useRef, useState } from 'react';
import type {
  RedemptionExpressPolicy,
  ExpressAddressBook,
  ExpressAddress,
  ExpressAddressInput,
} from '../../../../../packages/contracts/src/index';
import { request } from '../../api';
import { cartIdentity } from '../../account-cart';
import type { CartIdentity } from '../../account-cart';
import { addressRequest, addressOperationKey, AddressRequestError } from '../../address-api';
const empty: ExpressAddressInput = {
  province: '',
  city: '',
  district: '',
  detailAddress: '',
  contactName: '',
  phone: '',
  note: '',
  isDefault: false,
};
type Intent = { identity: CartIdentity; path: string; body: unknown; key: string };
export default function Addresses() {
  const [identity, setIdentity] = useState<CartIdentity | null>(null),
    [policy, setPolicy] = useState<RedemptionExpressPolicy | null>(null),
    [book, setBook] = useState<ExpressAddressBook | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [unknown, setUnknown] = useState(false),
    [conflict, setConflict] = useState(false);
  const [editor, setEditor] = useState<{ id?: string; data: ExpressAddressInput } | null>(null);
  const sequence = useRef(0),
    intent = useRef<Intent | null>(null),
    writing = useRef(false);
  async function load() {
    if (writing.current || intent.current) return;
    const current = ++sequence.current;
    setLoading(true);
    setError('');
    setBook(null);
    setIdentity(null);
    try {
      const who = await cartIdentity();
      if (current !== sequence.current) return;
      setIdentity(who);
      if (!who) return;
      const [fresh, shipping] = await Promise.all([
        addressRequest<ExpressAddressBook>(who, '/consumer/express-addresses'),
        request<RedemptionExpressPolicy>('/redemption-express-policy').catch(() => null),
      ]);
      if (current !== sequence.current) return;
      setBook(fresh);
      setPolicy(shipping);
    } catch (e) {
      if (current === sequence.current)
        setError(e instanceof Error ? e.message : '地址读取失败，请重试');
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  }
  useDidShow(() => {
    if (!intent.current) {
      void load();
      return;
    }
    void (async () => {
      const n = ++sequence.current;
      const who = await cartIdentity();
      if (n !== sequence.current) return;
      if (!who || who.profile.user.id !== intent.current?.identity.profile.user.id) {
        setIdentity(null);
        setBook(null);
        setEditor(null);
        setError('有原账号的地址操作待核实，请恢复原账号后继续');
        return;
      }
      intent.current!.identity = who;
      setIdentity(who);
      setUnknown(true);
      setError('有一笔地址操作待核实，请使用原操作重试确认');
    })();
  });
  useDidHide(() => {
    sequence.current++;
    setIdentity(null);
    setBook(null);
    setEditor(null);
    setPolicy(null);
    setBusy(false);
  });
  async function send(attempt: Intent) {
    if (writing.current) return;
    writing.current = true;
    intent.current = attempt;
    setBusy(true);
    setError('');
    const wasUnknown = unknown;
    const n = sequence.current;
    try {
      await addressRequest(attempt.identity, attempt.path, attempt.body, attempt.key);
      intent.current = null;
      if (n !== sequence.current) return;
      setUnknown(false);
      setEditor(null);
      setConflict(false);
      writing.current = false;
      await load();
    } catch (e) {
      if (n !== sequence.current) return;
      if (
        e instanceof AddressRequestError &&
        e.status < 500 &&
        !(wasUnknown && [401, 403, 429].includes(e.status))
      ) {
        intent.current = null;
        setUnknown(false);
        setConflict(e.code === 'ADDRESS_VERSION_CONFLICT');
        setError(e.message);
      } else {
        setUnknown(true);
        setError(
          '保存结果尚未确认，请保留本页并使用原操作重试；离开后请先核对地址列表，避免重复录入。',
        );
      }
    } finally {
      writing.current = false;
      if (n === sequence.current) setBusy(false);
    }
  }
  function act(path: string, body: unknown) {
    if (!identity || writing.current || intent.current) return;
    void send({ identity, path, body, key: addressOperationKey() });
  }
  async function remove(row: ExpressAddress) {
    if (busy || unknown || !book) return;
    const confirmed = await Taro.showModal({
      title: '删除这个收货地址？',
      content: '删除后不会自动指定其他默认地址。已有订单中的地址快照不随此更改。',
      confirmText: '删除地址',
    });
    if (confirmed.confirm)
      act(`/consumer/express-addresses/${row.id}/delete`, { version: book.version });
  }
  function edit(row?: ExpressAddress) {
    if (!book || busy || unknown) return;
    setError('');
    setConflict(false);
    setEditor({
      id: row?.id,
      data: row
        ? {
            province: row.province,
            city: row.city,
            district: row.district,
            detailAddress: row.detailAddress,
            contactName: row.contactName,
            phone: row.phone,
            note: row.note,
            isDefault: row.isDefault,
          }
        : { ...empty },
    });
  }
  const update = (field: keyof ExpressAddressInput, value: string | boolean) =>
    setEditor((old) => (old ? { ...old, data: { ...old.data, [field]: value } } : old));
  const blocked = busy || unknown || conflict;
  const valid =
    editor &&
    editor.data.province.trim() &&
    editor.data.city.trim() &&
    editor.data.district.trim() &&
    editor.data.detailAddress.trim() &&
    editor.data.contactName.trim() &&
    /^\+?[0-9]{6,20}$/.test(editor.data.phone.trim());
  return (
    <View className="address-page">
      <View className="address-hero">
        <Text className="account-eyebrow">YUMI · YOUR HOME</Text>
        <Text className="address-title">
          {editor ? (editor.id ? '编辑快递地址' : '新增快递地址') : '我的快递地址'}
        </Text>
        <Text className="address-subtitle">让日常好物，找到你的家</Text>
      </View>
      <View className="address-content">
        {error && (
          <View className="address-alert">
            <Text>{error}</Text>
            {unknown && (
              <Button
                className="account-primary"
                disabled={busy}
                onClick={() => intent.current && void send(intent.current)}
              >
                原操作重试确认
              </Button>
            )}
            {conflict && (
              <Button
                onClick={() => {
                  setEditor(null);
                  setConflict(false);
                  void load();
                }}
              >
                放弃本次编辑并重新读取
              </Button>
            )}
          </View>
        )}
        {loading ? (
          <View className="address-state">正在读取本人地址…</View>
        ) : !identity ? (
          <View className="address-state">
            <Text>{error ? '暂时无法核验身份' : '登录后管理本人收货地址'}</Text>
            <Button onClick={() => void Taro.navigateTo({ url: '/pages/login/index' })}>
              前往我的
            </Button>
            <Button onClick={() => void load()}>重新读取</Button>
          </View>
        ) : !book ? (
          <View className="address-state">
            <Text>暂时无法读取地址</Text>
            <Button onClick={() => void load()}>重试读取</Button>
          </View>
        ) : editor ? (
          <View className="address-form">
            <Text className="address-section-title">快递收货位置</Text>
            {(['province', 'city', 'district', 'detailAddress'] as const).map((field) => (
              <View key={field}>
                <Text className="address-label">
                  {
                    {
                      province: '省 / 自治区 / 直辖市',
                      city: '市',
                      district: '区 / 县',
                      detailAddress: '详细地址',
                    }[field]
                  }{' '}
                  *
                </Text>
                <Input
                  className="address-input"
                  disabled={blocked}
                  maxlength={field === 'detailAddress' ? 200 : 40}
                  value={editor.data[field]}
                  placeholder={
                    {
                      province: '填写完整省名，如浙江省',
                      city: '填写城市',
                      district: '填写区县',
                      detailAddress: '街道、门牌号及收件位置',
                    }[field]
                  }
                  onInput={(e) => update(field, e.detail.value)}
                />
              </View>
            ))}
            <Text className="address-section-title">联系信息</Text>
            <Text className="address-label">联系人 *</Text>
            <Input
              className="address-input"
              disabled={blocked}
              maxlength={40}
              value={editor.data.contactName}
              placeholder="请填写联系人"
              onInput={(e) => update('contactName', e.detail.value)}
            />
            <Text className="address-label">联系电话 *</Text>
            <Input
              className="address-input"
              disabled={blocked}
              maxlength={21}
              value={editor.data.phone}
              placeholder="6至20位数字，可带 + 国际区号"
              onInput={(e) => update('phone', e.detail.value)}
            />
            <Text className="address-label">补充说明（选填）</Text>
            <Textarea
              className="address-note"
              disabled={blocked}
              maxlength={200}
              value={editor.data.note}
              placeholder="补充收件说明"
              onInput={(e) => update('note', e.detail.value)}
            />
            <View className="address-default">
              <View>
                <Text>设为默认地址</Text>
                <Text className="address-hint">由你选择，不自动替换</Text>
              </View>
              <Switch
                color="#008a42"
                checked={editor.data.isDefault}
                disabled={blocked}
                onChange={(e) => update('isDefault', e.detail.value)}
              />
            </View>
            <Button
              className="account-primary address-save"
              disabled={blocked || !valid}
              onClick={() =>
                act(
                  editor.id
                    ? `/consumer/express-addresses/${editor.id}/update`
                    : '/consumer/express-addresses',
                  {
                    version: book.version,
                    ...editor.data,
                  },
                )
              }
            >
              {busy ? '正在保存…' : '保存地址'}
            </Button>
            <Button
              className="address-cancel"
              disabled={busy || unknown}
              onClick={() => {
                setEditor(null);
                setError('');
                setConflict(false);
              }}
            >
              返回地址列表
            </Button>
          </View>
        ) : (
          <>
            <View className="address-notice">
              填写完整省市区和街道门牌，寄送范围以门店规则为准。联系电话由本人填写，请核实无误。
            </View>
            <View className="address-notice">
              {policy?.enabled
                ? '可寄送：' + policy.provinces.join('、') + ' · 商家承担运费'
                : '快递范围尚未开放或暂无法读取，地址仍可保存'}
            </View>
            <View className="address-toolbar">
              <Text>{book.items.length} 个地址</Text>
              <Button disabled={busy || unknown} onClick={() => void load()}>
                刷新地址
              </Button>
            </View>
            {!book.items.length && (
              <View className="address-state">
                <Text className="address-empty-icon">⌂</Text>
                <Text>还没有保存收货地址</Text>
                <Text className="address-hint">填写省市区和详细地址，快递范围由门店核验</Text>
              </View>
            )}
            {book.items.map((row) => (
              <View key={row.id} className="address-card address-book-card">
                <View className="address-card-heading">
                  <Text className="address-recipient">{row.contactName}</Text>
                  {row.isDefault && <Text className="address-default-tag">默认地址</Text>}
                </View>
                <Text className="address-contact">{row.phone}</Text>
                <Text className="address-room">
                  {row.province} · {row.city} · {row.district} · {row.detailAddress}
                </Text>
                {row.note && <Text className="address-hint">{row.note}</Text>}
                {!row.available && (
                  <Text className="address-unavailable">此地址暂不在有效配送范围</Text>
                )}
                <View className="address-actions">
                  {!row.isDefault && (
                    <Button
                      disabled={busy || unknown || !row.available}
                      onClick={() =>
                        act(`/consumer/express-addresses/${row.id}/default`, {
                          version: book.version,
                        })
                      }
                    >
                      设为默认
                    </Button>
                  )}
                  <Button disabled={busy || unknown} onClick={() => edit(row)}>
                    编辑
                  </Button>
                  <Button disabled={busy || unknown} onClick={() => void remove(row)}>
                    删除
                  </Button>
                </View>
              </View>
            ))}
            <View className="address-action-dock">
              <Button
                className="account-primary address-add"
                disabled={busy || unknown || book.items.length >= 20}
                onClick={() => edit()}
              >
                ＋ 新增快递地址
              </Button>
              <Button
                className="address-cancel"
                disabled={busy || unknown}
                onClick={() => void load()}
              >
                刷新寄送范围
              </Button>
            </View>
          </>
        )}
      </View>
    </View>
  );
}
