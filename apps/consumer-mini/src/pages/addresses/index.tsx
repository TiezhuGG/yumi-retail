import { View, Text, Button, Input, Textarea, Picker, Switch } from '@tarojs/components';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
import { useRef, useState } from 'react';
import type {
  ConsumerAddressBook,
  ConsumerAddress,
  ConsumerAddressInput,
  PublicServiceArea,
  PublicServiceBuildings,
} from '../../../../../packages/contracts/src/index';
import { cartIdentity } from '../../account-cart';
import type { CartIdentity } from '../../account-cart';
import { request } from '../../api';
import { addressRequest, addressOperationKey, AddressRequestError } from '../../address-api';
const empty: ConsumerAddressInput = {
  areaId: '',
  buildingId: '',
  unit: '',
  room: '',
  contactName: '',
  phone: '',
  note: '',
  isDefault: false,
};
type Intent = { identity: CartIdentity; path: string; body: unknown; key: string };
export default function Addresses() {
  const [identity, setIdentity] = useState<CartIdentity | null>(null),
    [book, setBook] = useState<ConsumerAddressBook | null>(null),
    [range, setRange] = useState<PublicServiceBuildings | null>(null),
    [rangeError, setRangeError] = useState('');
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [unknown, setUnknown] = useState(false),
    [conflict, setConflict] = useState(false);
  const [editor, setEditor] = useState<{ id?: string; data: ConsumerAddressInput } | null>(null);
  const sequence = useRef(0),
    intent = useRef<Intent | null>(null),
    writing = useRef(false);
  async function load() {
    if (writing.current || intent.current) return;
    const current = ++sequence.current;
    setLoading(true);
    setError('');
    setRangeError('');
    setBook(null);
    setRange(null);
    setIdentity(null);
    try {
      const who = await cartIdentity();
      if (current !== sequence.current) return;
      setIdentity(who);
      if (!who) return;
      const fresh = await addressRequest<ConsumerAddressBook>(who, '/consumer/addresses');
      if (current !== sequence.current) return;
      setBook(fresh);
      try {
        const areas = await request<{ items: PublicServiceArea[] }>('/service-areas');
        const selected = areas.items[0];
        const available = selected
          ? await request<PublicServiceBuildings>(`/service-areas/${selected.id}/buildings`)
          : null;
        if (current === sequence.current) setRange(available);
      } catch {
        if (current === sequence.current)
          setRangeError('配送范围暂时无法读取，已有地址仍可查看或删除。');
      }
    } catch (e) {
      if (current === sequence.current)
        setError(e instanceof Error ? e.message : '地址读取失败，请重试');
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  }
  useDidShow(() => {
    if (!intent.current && !editor) void load();
  });
  useDidHide(() => {
    sequence.current++;
  });
  async function send(attempt: Intent) {
    if (writing.current) return;
    writing.current = true;
    intent.current = attempt;
    setBusy(true);
    setError('');
    const wasUnknown = unknown;
    try {
      await addressRequest(attempt.identity, attempt.path, attempt.body, attempt.key);
      intent.current = null;
      setUnknown(false);
      setEditor(null);
      setConflict(false);
      writing.current = false;
      await load();
    } catch (e) {
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
      setBusy(false);
    }
  }
  function act(path: string, body: unknown) {
    if (!identity || writing.current || intent.current) return;
    void send({ identity, path, body, key: addressOperationKey() });
  }
  async function remove(row: ConsumerAddress) {
    if (busy || unknown || !book) return;
    const confirmed = await Taro.showModal({
      title: '删除这个收货地址？',
      content: '删除后不会自动指定其他默认地址。已有订单中的地址快照不随此更改。',
      confirmText: '删除地址',
    });
    if (confirmed.confirm) act(`/consumer/addresses/${row.id}/delete`, { version: book.version });
  }
  function edit(row?: ConsumerAddress) {
    if (!book || busy || unknown) return;
    setError('');
    setConflict(false);
    setEditor({
      id: row?.id,
      data: row
        ? {
            areaId: row.areaId,
            buildingId: row.buildingId,
            unit: row.unit,
            room: row.room,
            contactName: row.contactName,
            phone: row.phone,
            note: row.note,
            isDefault: row.isDefault,
          }
        : { ...empty, areaId: range?.area.id ?? '' },
    });
  }
  const update = (field: keyof ConsumerAddressInput, value: string | boolean) =>
    setEditor((old) => (old ? { ...old, data: { ...old.data, [field]: value } } : old));
  const blocked = busy || unknown || conflict;
  const valid =
    editor &&
    range &&
    editor.data.areaId === range.area.id &&
    range.items.some((b) => b.id === editor.data.buildingId) &&
    editor.data.room.trim() &&
    editor.data.contactName.trim() &&
    /^\+?[0-9]{6,20}$/.test(editor.data.phone.trim());
  return (
    <View className="address-page">
      <View className="address-hero">
        <Text className="account-eyebrow">YUMI · YOUR HOME</Text>
        <Text className="address-title">
          {editor ? (editor.id ? '编辑收货地址' : '新增收货地址') : '我的收货地址'}
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
            <Button onClick={() => void Taro.navigateTo({ url: '/pages/account/index' })}>
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
            <Text className="address-section-title">配送位置</Text>
            <Text className="address-label">服务小区</Text>
            <View className="address-fixed">{range?.area.name ?? '暂无开放的服务小区'}</View>
            {rangeError && <Text className="address-hint">{rangeError}</Text>}
            <Text className="address-label">楼栋 *</Text>
            <Picker
              disabled={blocked || !range?.items.length}
              mode="selector"
              range={range?.items.map((b) => b.name) ?? []}
              value={Math.max(
                0,
                range?.items.findIndex((b) => b.id === editor.data.buildingId) ?? 0,
              )}
              onChange={(e) => {
                const b = range?.items[Number(e.detail.value)];
                if (b) {
                  update('areaId', range!.area.id);
                  update('buildingId', b.id);
                }
              }}
            >
              <View className="address-picker">
                {range?.items.find((b) => b.id === editor.data.buildingId)?.name ??
                  '请选择有效楼栋'}
                <Text>⌄</Text>
              </View>
            </Picker>
            {editor.id && !range?.items.some((b) => b.id === editor.data.buildingId) && (
              <Text className="address-hint">原楼栋不在当前有效范围，请重新选择后保存。</Text>
            )}
            <View className="address-pair">
              <View>
                <Text className="address-label">单元（选填）</Text>
                <Input
                  className="address-input"
                  disabled={blocked}
                  maxlength={20}
                  value={editor.data.unit}
                  placeholder="如：1单元"
                  onInput={(e) => update('unit', e.detail.value)}
                />
              </View>
              <View>
                <Text className="address-label">房号 *</Text>
                <Input
                  className="address-input"
                  disabled={blocked}
                  maxlength={30}
                  value={editor.data.room}
                  placeholder="填写房号"
                  onInput={(e) => update('room', e.detail.value)}
                />
              </View>
            </View>
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
              placeholder="如门口位置，不改变配送范围"
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
                act(editor.id ? `/consumer/addresses/${editor.id}/update` : '/consumer/addresses', {
                  version: book.version,
                  ...editor.data,
                })
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
              地址仅用于本人配送资料管理，在线下单尚未开放。联系电话为自行填写，未作号码归属验证。
            </View>
            {rangeError && <View className="address-alert">{rangeError}</View>}
            {!range?.items.length && !rangeError && (
              <View className="address-alert">
                当前暂无开放的服务楼栋，暂不能新增地址。旧地址可以保留或删除。
              </View>
            )}
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
                <Text className="address-hint">选择服务小区中的楼栋，完善你的收货信息</Text>
              </View>
            )}
            {book.items.map((row) => (
              <View key={row.id} className="address-card">
                <View className="address-card-heading">
                  <Text>
                    {row.areaName} · {row.buildingName}
                  </Text>
                  {row.isDefault && <Text className="address-default-tag">默认</Text>}
                </View>
                <Text className="address-room">
                  {row.unit} {row.room}
                </Text>
                <Text className="address-contact">
                  {row.contactName} {row.phone}
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
                        act(`/consumer/addresses/${row.id}/default`, { version: book.version })
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
            <Button
              className="account-primary address-add"
              disabled={busy || unknown || !range?.items.length || book.items.length >= 20}
              onClick={() => edit()}
            >
              ＋ 新增收货地址
            </Button>
            <Button
              className="address-cancel"
              disabled={busy || unknown}
              onClick={() => void Taro.navigateTo({ url: '/pages/service-area/index' })}
            >
              查看配送范围
            </Button>
          </>
        )}
      </View>
    </View>
  );
}
