import { View, Text } from '@tarojs/components';
import { useRouter } from '@tarojs/taro';
import { RedemptionReturns } from '../../redemption-returns';
export default function ReturnDetail() {
  const { orderId, id } = useRouter().params;
  const valid = (value?: string) =>
    !!value && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
  return (
    <View className="account-page">
      <View className="account-content">
        <Text className="account-name">售后详情</Text>
        {valid(orderId) && valid(id) ? (
          <RedemptionReturns orderId={orderId!} returnId={id!} />
        ) : (
          <View className="account-error">售后入口无效</View>
        )}
      </View>
    </View>
  );
}
