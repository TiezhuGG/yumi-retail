import { Button, Text, View } from '@tarojs/components';
import Taro, { useDidHide, useDidShow } from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import { request } from '../../api';
import { initialSessionState } from '../../consumer-session';
import { consumerSession } from '../../session-storage';

declare const CONSUMER_DEV_LOGIN: boolean;

export default function Login() {
  const [state, setState] = useState(initialSessionState);
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [methodsFailed, setMethodsFailed] = useState(false);
  const methodSequence = useRef(0);
  const returning = useRef(false);
  const session = useRef<ReturnType<typeof consumerSession> | null>(null);
  if (!session.current) session.current = consumerSession(setState);

  async function loadMethods() {
    const current = ++methodSequence.current;
    setEnabled(null);
    setMethodsFailed(false);
    try {
      const result = await request<{ wechatLoginEnabled: boolean }>('/consumer/auth/methods');
      if (typeof result.wechatLoginEnabled !== 'boolean') throw Error('Invalid login methods');
      if (current === methodSequence.current) setEnabled(result.wechatLoginEnabled);
    } catch {
      if (current === methodSequence.current) setMethodsFailed(true);
    }
  }

  function cancel() {
    session.current?.cancel();
    methodSequence.current++;
  }

  function back() {
    if (returning.current) return;
    returning.current = true;
    cancel();
    void Taro.navigateBack()
      .catch(() => Taro.switchTab({ url: '/pages/index/index' }))
      .catch(() => {
        returning.current = false;
        void Taro.showToast({ title: '暂时无法返回，请重试', icon: 'none' });
      });
  }

  useDidShow(() => {
    void session.current!.restore();
    void loadMethods();
  });
  useDidHide(cancel);
  useEffect(() => cancel, []);
  useEffect(() => {
    if (state.phase === 'authenticated') back();
  }, [state.phase]);

  return (
    <View className="account-page points-page consumer-login-page">
      <View className="account-content">
        <View className="account-card">
          <View className="consumer-login-brand">
            <View className="points-brand-mark" aria-hidden="true">
              <View />
              <View />
              <View />
              <View />
            </View>
            <Text>玉米百货</Text>
          </View>
          <Text className="account-name">微信登录</Text>
          {state.error && <Text className="account-error">{state.error}</Text>}
          {methodsFailed && (
            <Button onClick={() => void loadMethods()}>登录方式加载失败，点击重试</Button>
          )}
          <Button
            className="points-action"
            disabled={enabled !== true || state.busy || !['guest', 'error'].includes(state.phase)}
            onClick={() => void session.current!.wechatLogin()}
          >
            {state.busy
              ? '正在核验…'
              : enabled === false
                ? '微信登录暂未开放'
                : enabled === true
                  ? state.phase === 'error'
                    ? '重新微信登录'
                    : '使用微信登录'
                  : '正在读取登录方式…'}
          </Button>
          {state.phase === 'error' && (
            <Button className="account-link" onClick={() => void session.current!.restore()}>
              重新检查登录状态
            </Button>
          )}
          {CONSUMER_DEV_LOGIN && state.phase === 'guest' && (
            <View className="account-dev-actions">
              <Button
                className="account-link"
                onClick={() => void session.current!.login('customer-a')}
              >
                使用开发顾客 A
              </Button>
              <Button
                className="account-link"
                onClick={() => void session.current!.login('customer-b')}
              >
                使用开发顾客 B
              </Button>
            </View>
          )}
        </View>
      </View>
    </View>
  );
}
