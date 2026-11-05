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
    ['待发货', 'EXPRESS_WAIT_SHIP', 'waiting'],
    ['已发货', 'EXPRESS_SHIPPED', 'shipped'],
    ['已取消', 'CANCELED', 'canceled'],
  ];
  const protectedOpen = (url: string) => (profile ? open(url) : open('login/index'));
  const viewOrders = (status?: string, afterSales = false) =>
    profile
      ? void openRedemptions(afterSales ? { service: 'after-sales' } : { status })
      : open('login/index');
  return (
    <View className="account-page account-center member-simple">
      <View className="member-header">
        <View className="member-heading">
          <Text>我的</Text>
          <Button className="member-settings" onClick={() => setSettings(!settings)}>
            {settings ? '收起设置' : '账号设置'}
          </Button>
        </View>
        <View className="member-profile member-simple-profile">
          <Text className="member-avatar">玉</Text>
          <View className="member-profile-copy">
            <Text className="member-name">
              {busy ? '正在核验账号…' : (profile?.user.displayName ?? '欢迎来到玉米百货')}
            </Text>
          </View>
        </View>
        {!profile && !busy && phase === 'guest' && (
          <Button className="member-login" onClick={() => open('login/index')}>
            微信登录 / 查看我的积分
          </Button>
        )}
      </View>
      <View className="member-content">
        {error && (
          <View className="account-error">
            <Text>{error}</Text>
            {phase === 'error' && (
              <Button disabled={busy} onClick={() => void session.current!.restore()}>
                重试核验账号
              </Button>
            )}
          </View>
        )}
        <View className="member-wallet member-simple-wallet">
          <View className="member-wallet-top">
            <View>
              <Text className="member-wallet-label">可用积分</Text>
              <Text
                className={
                  balance !== null && profile && !balanceFailed
                    ? 'member-wallet-value'
                    : 'member-wallet-status'
                }
              >
                {profile
                  ? balanceFailed
                    ? '暂时未能读取'
                    : balance === null
                      ? '读取中…'
                      : balance
                  : '登录后查看'}
              </Text>
            </View>
            <Button
              className="member-wallet-link"
              onClick={() =>
                balanceFailed ? void session.current!.restore() : protectedOpen('points/index')
              }
            >
              {balanceFailed ? '重新读取' : '收支明细 ›'}
            </Button>
          </View>
          <View className="member-wallet-bottom">
            <Button onClick={() => void Taro.switchTab({ url: '/pages/index/index' })}>
              去逛商城 →
            </Button>
          </View>
        </View>
        <View className="member-section member-orders">
          <View className="member-section-heading">
            <Text className="member-section-title">我的订单</Text>
            <Button onClick={() => viewOrders()}>查看全部 ›</Button>
          </View>
          <View className="member-order-grid">
            {orders.map(([label, status, icon]) => (
              <Button key={label} className="member-order-link" onClick={() => viewOrders(status)}>
                <View className={'member-order-icon member-order-icon-' + icon} />
                <Text>{label}</Text>
              </Button>
            ))}
            <Button className="member-order-link" onClick={() => viewOrders(undefined, true)}>
              <View className="member-order-icon member-order-icon-service" />
              <Text>售后服务</Text>
            </Button>
          </View>
        </View>
        <View className="member-section member-services">
          <Text className="member-section-title">常用服务</Text>
          <Button
            className="member-service-row"
            onClick={() => protectedOpen('express-addresses/index')}
          >
            <View>
              <Text className="member-service-title">收货地址</Text>
            </View>
            <Text>›</Text>
          </Button>
          <Button className="member-service-row" onClick={() => protectedOpen('points/index')}>
            <View>
              <Text className="member-service-title">积分记录</Text>
            </View>
            <Text>›</Text>
          </Button>
          <Button className="member-service-row" onClick={showRules}>
            <View>
              <Text className="member-service-title">兑换说明</Text>
            </View>
            <Text>{rules ? '⌃' : '›'}</Text>
          </Button>
          {rules && (
            <View className="member-rules">
              <Text className="account-copy">
                所需积分以确认页为准。未发货订单可在详情核验能否取消；已发货可在订单中申请售后，由门店审核处理。
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
        {settings && (
          <View className="member-section member-settings-panel">
            <Text className="member-section-title">账号与隐私</Text>
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
                清除本机登录记录
              </Button>
            )}
          </View>
        )}
      </View>
    </View>
  );
}
