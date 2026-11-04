import { View, Text, Button } from '@tarojs/components';
import Taro from '@tarojs/taro';
import { ProductVisual } from './ProductVisual';
import type { Reward } from '../rewards-api';

export function RewardCard({ reward }: { reward: Reward }) {
  const open = () => void Taro.navigateTo({ url: '/pages/reward/index?id=' + reward.id });
  return (
    <View className="reward-card" onClick={open}>
      <ProductVisual name={reward.name} imageUrl={reward.imageUrl} />
      <View className="reward-card-copy">
        <Text className="reward-title">{reward.title}</Text>
        <Text className="account-copy">
          {reward.spec} / {reward.unit}
        </Text>
        <Text className="reward-price">
          {reward.pointsPrice} <Text>积分</Text>
        </Text>
        <Text className="reward-stock">
          {reward.available <= 0
            ? '暂时缺货'
            : reward.redemptionEnabled
              ? '每人限兑 ' + reward.perUserLimit + ' 件'
              : '可浏览 · 兑换暂未开放'}
        </Text>
        <Button
          className="points-action"
          onClick={(event) => {
            event.stopPropagation();
            open();
          }}
        >
          查看详情
        </Button>
      </View>
    </View>
  );
}
