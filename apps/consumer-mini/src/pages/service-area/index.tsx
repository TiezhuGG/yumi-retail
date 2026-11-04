import { View, Text, Button, Input } from '@tarojs/components';
import Taro, { useDidShow, useDidHide } from '@tarojs/taro';
import { useEffect, useRef, useState } from 'react';
interface PublicServiceArea {
  id: string;
  name: string;
  version: number;
}
interface PublicServiceBuildings {
  area: PublicServiceArea;
  items: Array<{ id: string; name: string }>;
}
import { request } from '../../api';
export default function ServiceArea() {
  const [result, setResult] = useState<PublicServiceBuildings | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [filter, setFilter] = useState('');
  const sequence = useRef(0);
  async function load() {
    const current = ++sequence.current;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const areas = await request<{ items: PublicServiceArea[] }>('/service-areas');
      if (current !== sequence.current) return;
      const area = areas.items[0];
      const fresh = area
        ? await request<PublicServiceBuildings>(`/service-areas/${area.id}/buildings`)
        : null;
      if (current === sequence.current) setResult(fresh);
    } catch {
      if (current === sequence.current) setError('暂时无法读取配送范围，请稍后重试。');
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  }
  useDidShow(() => {
    void load();
  });
  useDidHide(() => {
    sequence.current++;
  });
  useEffect(
    () => () => {
      sequence.current++;
    },
    [],
  );
  const items =
    result?.items.filter((b) => b.name.toLowerCase().includes(filter.trim().toLowerCase())) ?? [];
  return (
    <View className="range-page">
      <View className="range-hero">
        <Text className="account-eyebrow">YUMI · NEIGHBORHOOD</Text>
        <Text className="range-title">小区配送范围</Text>
        <Text className="range-subtitle">查询已开通服务的小区与楼栋</Text>
      </View>
      <View className="range-content">
        {loading ? (
          <View className="range-state">
            <Text>正在读取配送范围…</Text>
          </View>
        ) : error ? (
          <View className="range-state">
            <Text>{error}</Text>
            <Button className="account-primary" onClick={() => void load()}>
              重新读取
            </Button>
          </View>
        ) : !result ? (
          <View className="range-state">
            <Text className="range-state-icon">⌂</Text>
            <Text className="range-state-title">配送范围暂未开放</Text>
            <Text>服务资料确认后将在这里展示，请稍后再来看看。</Text>
            <Button onClick={() => void load()}>刷新范围</Button>
          </View>
        ) : (
          <>
            <View className="range-community">
              <View>
                <Text className="range-community-label">当前服务小区</Text>
                <Text className="range-community-name">{result.area.name}</Text>
              </View>
              <Text className="range-count">{result.items.length} 栋</Text>
            </View>
            <View className="range-buildings">
              <View className="range-heading">
                <Text>服务楼栋</Text>
                <Button onClick={() => void load()}>刷新</Button>
              </View>
              <Input
                className="range-search"
                value={filter}
                maxlength={80}
                placeholder="输入楼栋名称查找"
                onInput={(e) => setFilter(e.detail.value)}
              />
              <View className="range-building-list">
                {items.map((b) => (
                  <View key={b.id} className="range-building">
                    <Text>{b.name}</Text>
                    <Text className="range-building-tag">已开通</Text>
                  </View>
                ))}
              </View>
              {!items.length && (
                <Text className="range-empty">
                  {filter ? '没有匹配楼栋，请调整名称。' : '当前暂无开放的服务楼栋。'}
                </Text>
              )}
            </View>
          </>
        )}
        <Button
          className="range-back"
          onClick={() =>
            void Taro.navigateBack().catch(() => Taro.reLaunch({ url: '/pages/index/index' }))
          }
        >
          返回逛逛
        </Button>
      </View>
    </View>
  );
}
