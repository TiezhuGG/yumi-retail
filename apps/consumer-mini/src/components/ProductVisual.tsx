import { useEffect, useState } from 'react';
import { productImageUrl } from '../api';
import { View, Text, Image } from '@tarojs/components';
export function ProductVisual({
  name,
  large = false,
  imageUrl,
}: {
  name: string;
  large?: boolean;
  imageUrl?: string | null;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [imageUrl]);
  if (imageUrl && !failed)
    return (
      <View className={`product-visual ${large ? 'large' : ''}`}>
        <Image
          style={{ width: '100%', height: '100%' }}
          mode="aspectFit"
          src={productImageUrl(imageUrl)}
          onError={() => setFailed(true)}
        />
      </View>
    );
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
