import { View, Text, Button } from '@tarojs/components';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
import type { RedemptionExpressPolicy } from '../../../../../packages/contracts/src/index';
import { initialSessionState, parseSession } from '../../consumer-session';
import { consumerSession, sessionStorageKey } from '../../session-storage';
import { addressRequest } from '../../address-api';
import { request } from '../../api';
import { openRedemptions } from '../../reward-navigation';

export default function Account() {
  const [state, setState] = useState(initialSessionState);
  const [balance, setBalance] = useState<string | null>(null);
  const [balanceFailed, setBalanceFailed] = useState(false);
  const [settings, setSettings] = useState(false);
  const [rules, setRules] = useState(false);
  const [policy, setPolicy] = useState<RedemptionExpressPolicy | null>(null);
  const [policyFailed, setPolicyFailed] = useState(false);
  const policySequence = useRef(0);
  const session = useRef<ReturnType<typeof consumerSession> | null>(null);
  if (!session.current) session.current = consumerSession(setState);
  const { profile, phase, busy, error } = state;

  function cancel() {
    session.current?.cancel();
    policySequence.current++;
  }

  useDidShow(() => void session.current!.restore());
  useDidHide(() => {
    cancel();
    setState(initialSessionState);
    setBalance(null);
    setBalanceFailed(false);
    setSettings(false);
    setRules(false);
  });
  useEffect(() => cancel, []);
  useEffect(() => {
    let active = true;
    setBalance(null);
    setBalanceFailed(false);
    if (profile) {
      void (async () => {
        try {
          const saved = parseSession(Taro.getStorageSync(sessionStorageKey));
          if (!saved) throw Error('Session missing');
          const result = await addressRequest<{ balance: string }>(
            { ...saved, profile },
            '/consumer/points',
          );
          if (active) setBalance(result.balance);
        } catch {
          if (active) setBalanceFailed(true);
        }
      })();
    }
    return () => {
      active = false;
    };
  }, [profile]);

  const open = (url: string) => void Taro.navigateTo({ url: '/pages/' + url });
  function showRules() {
    const next = !rules;
    setRules(next);
    const sequence = ++policySequence.current;
    if (!next) return;
    setPolicy(null);
    setPolicyFailed(false);
    void request<RedemptionExpressPolicy>('/redemption-express-policy').then(
      (result) => {
        if (sequence === policySequence.current) setPolicy(result);
      },
      () => {
        if (sequence === policySequence.current) setPolicyFailed(true);
      },
    );
  }

  async function clearLocal() {
    const result = await Taro.showModal({
      title: '清除本机登录记录？',
      content: '清除后需要重新登录。服务端会话将在到期后失效。',
      confirmText: '清除记录',
    });
    if (result.confirm) session.current!.clearLocal();
  }

  function privacy() {
    const fail = () => void Taro.showToast({ title: '暂时无法打开隐私保护指引', icon: 'none' });
    if (typeof Taro.openPrivacyContract === 'function') Taro.openPrivacyContract({ fail });
    else fail();
  }

  const orders = [
    ['全部订单', '', 'all'],
    ['待发货', 'EXPRESS_WAIT_SHIP', 'waiting'],
    ['已发货', 'EXPRESS_SHIPPED', 'shipped'],
    ['已取消', 'CANCELED', 'canceled'],
  ];
  return (
    <View className="account-page account-center">
      <View className="member-header">
        <View className="member-heading">
          <Text>会员中心</Text>
          <Button className="member-settings" onClick={() => setSettings(!settings)}>
            {settings ? '收起设置' : '设置 ›'}
          </Button>
        </View>
        <View className="member-identity-card">
        <View className="member-profile">
          <Text className="member-avatar">玉</Text>
          <View className="member-profile-copy">
            <Text className="member-name">
              {busy ? '正在核验账号…' : (profile?.user.displayName ?? '欢迎来到玉米百货')}
            </Text>
            <Text className="member-note">{profile ? '玉米百货会员' : '登录后查看积分和订单'}</Text>
          </View>
        </View>
        {!profile && !busy && phase === 'guest' && (
          <Button className="member-login" onClick={() => open('login/index')}>
            微信登录
          </Button>
        )}
        </View>
      </View>
      <View className="member-content">
        <View className="member-wallet">
          <View className="member-points-main">
            <Text className="member-wallet-label">我的积分</Text>
            <Text
              className={
                balance !== null && profile && !balanceFailed
                  ? 'member-wallet-value'
                  : 'member-wallet-status'
              }
            >
              {profile
                ? balanceFailed
                  ? '积分暂不可用'
                  : balance === null
                    ? '正在读取…'
                    : balance + ' 积分'
                : '登录后查看积分'}
            </Text>
          </View>
          <Button
            className="member-wallet-link"
            onClick={() => (balanceFailed ? void session.current!.restore() : open('points/index'))}
          >
            {profile && balanceFailed ? '重试' : '积分明细 ›'}
          </Button>
        </View>
        {settings && (
          <View className="member-section member-settings-panel">
            <Button className="member-service-row" onClick={privacy}>
              <Text>隐私保护指引</Text>
              <Text>›</Text>
            </Button>
            {profile && (
              <Button
                className="member-service-row"
                disabled={busy}
                onClick={() => void session.current!.logout()}
              >
                退出登录
              </Button>
            )}
            {phase === 'error' && (
              <Button className="member-service-row" onClick={() => void clearLocal()}>
                清除登录记录
              </Button>
            )}
          </View>
        )}
        {error && (
          <View className="account-error">
            <Text>{error}</Text>
            {phase === 'error' && (
              <Button disabled={busy} onClick={() => void session.current!.restore()}>
                重试核验
              </Button>
            )}
          </View>
        )}
        <View className="member-section member-orders">
          <Text className="member-section-title">兑换订单</Text>
          <View className="member-order-grid">
            {orders.map(([label, status, icon]) => (
              <Button
                key={label}
                className="member-order-link"
                onClick={() => void openRedemptions({ status: status || undefined })}
              >
                <View className={'member-order-icon member-order-icon-' + icon} />
                <Text>{label}</Text>
              </Button>
            ))}
          </View>
        </View>
        <View className="member-section member-services">
          <Text className="member-section-title">常用服务</Text>
          <Button className="member-service-row" onClick={() => open('express-addresses/index')}>
            <Text>快递收货地址</Text>
            <Text className="member-chevron">›</Text>
          </Button>
          <Button
            className="member-service-row"
            onClick={() => void openRedemptions({ service: 'after-sales' })}
          >
            <Text>兑换售后</Text>
            <Text className="member-chevron">›</Text>
          </Button>
          <Button className="member-service-row" onClick={showRules}>
            <Text>兑换规则</Text>
            <Text className="member-chevron">{rules ? '⌃' : '›'}</Text>
          </Button>
          {rules && (
            <View className="member-rules">
              <Text className="account-copy">
                所需积分以确认页为准。发货前可在订单详情核验能否取消，发货后可在订单详情提交反馈。
              </Text>
              <Text className="account-copy">
                {policyFailed
                  ? '寄送范围读取失败，请收起后重试。'
                  : !policy
                    ? '正在读取寄送范围…'
                    : policy.enabled
                      ? '商家承担运费。寄送范围：' + policy.provinces.join('、')
                      : '快递兑换暂未开放。'}
              </Text>
            </View>
          )}
        </View>
      </View>
    </View>
  );
}
