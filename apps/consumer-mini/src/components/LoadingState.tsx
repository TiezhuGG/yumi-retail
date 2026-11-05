import { View, Text } from '@tarojs/components';

export function LoadingState({ label }: { label: string }) {
  return (
    <View className="atlas-loading" role="status" aria-live="polite">
      <View className="atlas-skeleton atlas-skeleton-banner" aria-hidden="true" />
      <View className="atlas-skeleton-row" aria-hidden="true">
        <View className="atlas-skeleton" />
        <View className="atlas-skeleton" />
      </View>
      <Text className="account-copy">{label}</Text>
    </View>
  );
}
