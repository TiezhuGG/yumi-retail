import { View, Text } from '@tarojs/components';
export function ProductVisual({ name, large = false }: { name: string; large?: boolean }) {
  const kind = /纸|巾/.test(name) ? 'paper' : /袋/.test(name) ? 'bag' : 'bottle';
  return (
    <View className={`product-visual ${kind} ${large ? 'large' : ''}`}>
      <View className="visual-orbit" />
      <View className="visual-package">
        <View className="visual-top" />
        <Text className="visual-name">
          {kind === 'paper' ? '柔软日常' : kind === 'bag' ? '整洁生活' : '清新洗护'}
        </Text>
        <Text className="visual-brand">YUMI · DAILY</Text>
        <View className="visual-stripe" />
      </View>
      <Text className="visual-caption">包装示意</Text>
    </View>
  );
}
