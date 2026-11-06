import { View, Text, Input, Button } from '@tarojs/components';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import type { ConsumerNicknameInput } from '../../../../../packages/contracts/src/index';
import { cartIdentity, type CartIdentity } from '../../account-cart';
import { addressRequest, AddressRequestError } from '../../address-api';
import { parseSession, type ConsumerProfile } from '../../consumer-session';
import { sessionStorageKey } from '../../session-storage';
import { CartRequestError } from '../../cart-merge';
declare const API_BASE_URL: string;
const storageKey = (id: string) => 'yumi.nickname.v1:' + API_BASE_URL + ':' + id;
function stored(id: string): ConsumerNicknameInput | null {
  const v = Taro.getStorageSync(storageKey(id)) as ConsumerNicknameInput | null;
  if (!v) return null;
  if (typeof v.displayName !== 'string' || typeof v.expectedDisplayName !== 'string')
    throw Error('原保存内容无法读取，请保留并联系门店核实');
  return v;
}
function clearIntent(id: string, input: ConsumerNicknameInput) {
  const current = stored(id);
  if (
    current?.displayName === input.displayName &&
    current.expectedDisplayName === input.expectedDisplayName
  )
    Taro.removeStorageSync(storageKey(id));
}
export default function Profile() {
  const [identity, setIdentity] = useState<CartIdentity | null>(null),
    [name, setName] = useState(''),
    [savedName, setSavedName] = useState(''),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState(false),
    [guest, setGuest] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const seq = useRef(0),
    owner = useRef(''),
    writing = useRef(false);
  function clearView() {
    setIdentity(null);
    setName('');
    setSavedName('');
    setPending(false);
  }
  async function load(keepDraft = false) {
    const n = ++seq.current;
    setLoading(true);
    setBusy(false);
    setError('');
    setNotice('');
    setGuest(false);
    try {
      const who = await cartIdentity();
      if (n !== seq.current) return;
      if (!who) {
        owner.current = '';
        clearView();
        setGuest(true);
        return;
      }
      if (parseSession(Taro.getStorageSync(sessionStorageKey))?.token !== who.token)
        throw Error('登录记录已变化，请重新读取本人昵称');
      const changed = owner.current !== who.profile.user.id;
      owner.current = who.profile.user.id;
      const intent = stored(owner.current),
        current = who.profile.user.displayName;
      setIdentity(who);
      setSavedName(current);
      setPending(false);
      if (intent) {
        setName(intent.displayName);
        if (current === intent.displayName) {
          clearIntent(owner.current, intent);
          setNotice('昵称已保存');
        } else if (current !== intent.expectedDisplayName) {
          clearIntent(owner.current, intent);
          setError('昵称已在其他设备修改，请核对当前昵称后保存');
        } else setPending(true);
      } else if (!keepDraft || changed) setName(current);
    } catch (e) {
      if (n === seq.current) {
        clearView();
        setGuest(e instanceof CartRequestError && e.status === 401);
        setError(e instanceof Error ? e.message : '昵称读取失败');
      }
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }
  useDidShow(() => void load());
  useDidHide(() => {
    seq.current++;
    clearView();
    setError('');
    setNotice('');
    setBusy(false);
  });
  useEffect(
    () => () => {
      seq.current++;
    },
    [],
  );
  async function save() {
    if (writing.current || !identity || loading) return;
    writing.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const n = seq.current,
      shown = identity;
    let input: ConsumerNicknameInput | null = null;
    try {
      const who = await cartIdentity();
      if (n !== seq.current) return;
      if (!who || who.profile.user.id !== owner.current || who.token !== shown.token)
        throw Error('登录账号已变化，请重新读取本人昵称');
      input = stored(owner.current) ?? {
        displayName: name.trim().normalize('NFC'),
        expectedDisplayName: savedName,
      };
      if (
        !input.displayName ||
        Array.from(input.displayName).length > 20 ||
        /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(input.displayName)
      )
        throw Error('请填写1至20个可见字符，不含换行或隐藏字符');
      Taro.setStorageSync(storageKey(owner.current), input);
      setPending(true);
      const result = await addressRequest<ConsumerProfile>(
        who,
        '/consumer/profile/nickname',
        input,
      );
      clearIntent(who.profile.user.id, input);
      if (n === seq.current) {
        setIdentity({ token: who.token, profile: result });
        setSavedName(result.user.displayName);
        setName(result.user.displayName);
        setPending(false);
        setNotice('昵称已保存');
      }
    } catch (e) {
      if (n === seq.current) {
        let sameSession = false;
        try {
          sameSession = parseSession(Taro.getStorageSync(sessionStorageKey))?.token === shown.token;
        } catch {
          /* Hide unverified details. */
        }
        if (!sameSession) {
          clearView();
          setError('登录记录已变化，请重新读取本人昵称');
        } else {
          if (e instanceof AddressRequestError && e.status < 500) {
            if (input) {
              try {
                clearIntent(shown.profile.user.id, input);
              } catch {
                setError('本机保存记录未能清理，请保留原内容并重试');
                return;
              }
            }
            setPending(false);
            if (e.status === 409) await load(true);
            if (e.status === 401) {
              clearView();
              setGuest(true);
            }
          }
          setError(e instanceof Error ? e.message : '暂未确认保存结果，请核实后重试');
        }
      }
    } finally {
      writing.current = false;
      if (n === seq.current) setBusy(false);
    }
  }
  const count = Array.from(name.trim().normalize('NFC')).length;
  return (
    <View className="account-page profile-page">
      <View className="account-content">
        {loading && <Text className="account-copy">正在读取昵称…</Text>}
        {!!error && <View className="account-error">{error}</View>}
        {!!notice && <View className="profile-success">{notice}</View>}
        {!loading && !identity && (
          <View className="account-card">
            {guest && (
              <Button
                className="points-action"
                onClick={() => void Taro.navigateTo({ url: '/pages/login/index' })}
              >
                微信登录
              </Button>
            )}
            <Button className="account-link" onClick={() => void load()}>
              重新读取
            </Button>
          </View>
        )}
        {!loading && identity && (
          <View className="account-card profile-form">
            <Text className="profile-label">昵称</Text>
            <View className="profile-input-row">
              <Input
                aria-label="昵称"
                value={name}
                maxlength={80}
                placeholder="填写昵称"
                disabled={busy || pending}
                onInput={(e) => {
                  setName(e.detail.value);
                  setNotice('');
                }}
                confirmType="done"
                onConfirm={() => void save()}
              />
              <Text className={count > 20 ? 'profile-count invalid' : 'profile-count'}>
                {count}/20
              </Text>
            </View>
            <Text className="profile-current">当前昵称：{savedName}</Text>
            {pending && (
              <Text className="account-copy">暂未确认保存结果，请先核实或使用原内容重试。</Text>
            )}
            <Button
              className="points-action"
              disabled={
                busy ||
                (!pending && (!count || count > 20 || name.trim().normalize('NFC') === savedName))
              }
              onClick={() => void save()}
            >
              {busy ? '正在保存…' : pending ? '使用原内容重试' : '保存昵称'}
            </Button>
            {pending && (
              <Button className="account-link" disabled={busy} onClick={() => void load()}>
                核实保存结果
              </Button>
            )}
          </View>
        )}
      </View>
    </View>
  );
}
