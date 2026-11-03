import { View, Text, Button } from '@tarojs/components';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import { initialSessionState } from '../../consumer-session';
import { consumerSession } from '../../session-storage';
declare const CONSUMER_DEV_LOGIN: boolean;
declare const API_BASE_URL: string;
export default function Account() {
  const [state, setState] = useState(initialSessionState);
  const [methods, setMethods] = useState<{ wechatLoginEnabled: boolean } | null>(null),
    [methodError, setMethodError] = useState('');
  const methodSeq = useRef(0);
  async function loadMethods() {
    const n = ++methodSeq.current;
    setMethods(null);
    setMethodError('');
    try {
      const r = await Taro.request<{ data: { wechatLoginEnabled: boolean } }>({
        url: API_BASE_URL + '/consumer/auth/methods',
        method: 'GET',
        timeout: 10000,
      });
      if (n !== methodSeq.current) return;
      if (r.statusCode !== 200 || typeof r.data?.data?.wechatLoginEnabled !== 'boolean')
        throw Error('METHODS');
      setMethods(r.data.data);
    } catch {
      if (n === methodSeq.current) setMethodError('登录方式读取失败，请重试');
    }
  }
  const session = useRef<ReturnType<typeof consumerSession> | null>(null);
  if (!session.current) session.current = consumerSession(setState);
  useDidShow(() => {
    void session.current!.restore();
    void loadMethods();
  });
  useDidHide(() => {
    session.current!.cancel();
    methodSeq.current++;
    setState(initialSessionState);
    setMethods(null);
    setMethodError('');
  });
  useEffect(
    () => () => {
      session.current!.cancel();
      methodSeq.current++;
    },
    [],
  );
  const { profile, phase, busy, error } = state;
  async function clearLocal() {
    const result = await Taro.showModal({
      title: '清除本机登录记录？',
      content:
        '这不会撤销服务端会话，会话将在到期后失效。购物车草稿会保留。正常退出请使用“退出当前登录”。',
      confirmText: '清除记录',
    });
    if (result.confirm) session.current!.clearLocal();
  }
  return (
    <View className="account-page">
      <View className="account-hero">
        <Text className="account-eyebrow">YUMI · EVERYDAY</Text>
        <View className="account-identity">
          <View className="account-avatar">🌽</View>
          <View>
            <Text className="account-name">
              {busy ? '正在核验身份…' : profile ? profile.user.displayName : '欢迎来到玉米百货'}
            </Text>
            <Text className="account-tag">
              {profile
                ? profile.user.provider === 'WECHAT'
                  ? '微信账号'
                  : '开发身份 · 非微信登录'
                : '好好生活，从日常开始'}
            </Text>
          </View>
        </View>
      </View>
      <View className="account-content">
        <View className="account-card">
          <Text className="account-card-title">我的积分</Text>
          <Text className="account-copy">查看积分余额与收支明细</Text>
          <Button
            className="account-link"
            onClick={() => Taro.navigateTo({ url: '/pages/points/index' })}
          >
            查看积分
          </Button>
        </View>
        {error && (
          <View className="account-error">
            <Text>{error}</Text>
            <Button disabled={busy} onClick={() => void session.current!.restore()}>
              重试核验
            </Button>
            {phase === 'error' && (
              <Button disabled={busy} onClick={() => void clearLocal()}>
                清除本机登录记录
              </Button>
            )}
          </View>
        )}
        <View className="account-card">
          <Text className="account-card-title">
            {profile
              ? '当前登录'
              : phase === 'error'
                ? '暂时无法确认登录状态'
                : busy
                  ? '正在读取登录状态'
                  : '先随意逛逛'}
          </Text>
          <Text className="account-copy">
            {profile
              ? `有效至 ${profile.expiresAt.slice(0, 16).replace('T', ' ')} UTC。退出后可继续浏览商品。`
              : '浏览商品和保存本机购物车无需登录。登录后可查看本人积分、收货地址和兑换订单。'}
          </Text>
          {profile ? (
            <Button
              className="account-primary"
              disabled={busy}
              onClick={() => void session.current!.logout()}
            >
              退出当前登录
            </Button>
          ) : (
            <Button
              className="account-primary"
              disabled={busy || phase !== 'guest' || !methods?.wechatLoginEnabled}
              onClick={() => void session.current!.wechatLogin()}
            >
              {methods?.wechatLoginEnabled
                ? '微信登录'
                : methodError
                  ? '登录方式暂不可用'
                  : methods
                    ? '微信登录暂未开放'
                    : '正在读取登录方式…'}
            </Button>
          )}
        </View>
        {methodError && !profile && (
          <View className="account-error">
            <Text>{methodError}</Text>
            <Button onClick={() => void loadMethods()}>重试登录方式</Button>
          </View>
        )}
        {CONSUMER_DEV_LOGIN && !profile && (
          <View className="account-card account-dev">
            <Text className="account-card-title">本机开发验证</Text>
            <Text className="account-copy">
              以下是预设测试身份，用于验证会话与权限，不代表真实微信用户。
            </Text>
            <View className="account-dev-actions">
              <Button
                disabled={busy || phase !== 'guest'}
                onClick={() => void session.current!.login('customer-a')}
              >
                使用开发顾客 A
              </Button>
              <Button
                disabled={busy || phase !== 'guest'}
                onClick={() => void session.current!.login('customer-b')}
              >
                使用开发顾客 B
              </Button>
            </View>
          </View>
        )}
        <View className="account-card">
          <View className="account-link-heading">
            <Text className="account-card-title">我的购物车</Text>
            <Text className="account-chip">{profile ? '账号购物车' : '本机草稿'}</Text>
          </View>
          <Text className="account-copy">
            {profile
              ? '登录后加购保存到本人账号。本机草稿可在购物车确认合并；响应未知时请保留原稿并重试。'
              : '游客草稿保存在这台设备。登录后可在购物车确认合并，退出不会清空账号购物车；结算尚未开放。'}
          </Text>
          <Button
            className="account-link"
            onClick={() => void Taro.navigateTo({ url: '/pages/cart/index' })}
          >
            查看购物车 →
          </Button>
        </View>
        <View className="account-card account-services">
          <Text className="account-card-title">个人服务</Text>
          <Button
            className="account-link"
            onClick={() => void Taro.navigateTo({ url: '/pages/redemptions/index' })}
          >
            我的兑换订单 →
          </Button>
          <Button
            className="account-link"
            onClick={() => void Taro.navigateTo({ url: '/pages/rewards/index' })}
          >
            积分商城 →
          </Button>
          <Button
            className="account-link"
            onClick={() => void Taro.navigateTo({ url: '/pages/service-area/index' })}
          >
            查看配送范围 →
          </Button>
          <Button
            className="account-link"
            onClick={() => void Taro.navigateTo({ url: '/pages/addresses/index' })}
          >
            小区收货地址 →
          </Button>
          <Button
            className="account-link"
            onClick={() => void Taro.navigateTo({ url: '/pages/express-addresses/index' })}
          >
            快递收货地址 →
          </Button>
          <Button
            className="account-link"
            onClick={() => void Taro.navigateTo({ url: '/pages/orders/index' })}
          >
            我的订单 →
          </Button>
          <Button
            className="account-link"
            onClick={() => void Taro.navigateTo({ url: '/pages/redemptions/index' })}
          >
            兑换售后反馈 →
          </Button>
        </View>
        {!busy && (
          <Button className="account-clear" onClick={() => void clearLocal()}>
            清除本机登录记录
          </Button>
        )}
        <Text className="account-footnote">不读取头像、昵称或手机号 · 在线下单尚未开放</Text>
      </View>
      <View className="store-tabs">
        <Button
          onClick={() =>
            void Taro.navigateBack({ delta: 1 }).catch(() =>
              Taro.reLaunch({ url: '/pages/index/index' }),
            )
          }
        >
          <Text>⌂</Text>
          <Text>返回逛逛</Text>
        </Button>
        <Button className="selected">
          <Text>♙</Text>
          <Text>我的</Text>
        </Button>
      </View>
    </View>
  );
}
