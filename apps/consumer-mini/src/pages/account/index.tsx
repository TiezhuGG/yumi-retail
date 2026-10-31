import { View, Text, Button } from '@tarojs/components';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import { initialSessionState } from '../../consumer-session';
import { consumerSession } from '../../session-storage';
declare const CONSUMER_DEV_LOGIN: boolean;
export default function Account() {
  const [state, setState] = useState(initialSessionState);
  const session = useRef<ReturnType<typeof consumerSession> | null>(null);
  if (!session.current) session.current = consumerSession(setState);
  useDidShow(() => {
    void session.current!.restore();
  });
  useDidHide(() => session.current!.cancel());
  useEffect(() => () => session.current!.cancel(), []);
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
              {profile ? '开发身份 · 非微信登录' : '好好生活，从日常开始'}
            </Text>
          </View>
        </View>
      </View>
      <View className="account-content">
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
              : '浏览商品和保存本机购物车无需登录。微信登录接入后，可继续完善个人服务。'}
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
            <Button className="account-primary" disabled>
              微信登录尚未开放
            </Button>
          )}
        </View>
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
            <Text className="account-chip">本机草稿</Text>
          </View>
          <Text className="account-copy">
            草稿保存在这台设备，当前登录不会合并到账号。切换身份后仍是同一份本机草稿；结算尚未开放。
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
          <View>
            <Text>收货地址</Text>
            <Text>待开放</Text>
          </View>
          <View>
            <Text>我的订单</Text>
            <Text>待开放</Text>
          </View>
          <View>
            <Text>售后服务</Text>
            <Text>待开放</Text>
          </View>
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
