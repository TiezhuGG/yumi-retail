import { View, Text } from '@tarojs/components';
export default function Index() {
  return <View style={{ padding: '24px', background: '#f3f4f6', minHeight: '100vh' }}>
    <Text style={{ color: '#008a42', fontSize: '24px', fontWeight: 'bold' }}>玉米百货</Text>
    <View style={{ marginTop: '20px', padding: '20px', background: '#fff', borderRadius: '12px' }}>
      <Text>开发验证环境</Text>
      <View style={{ marginTop: '12px' }}><Text>正在建设商品与仓库流程，暂未开放购物。</Text></View>
    </View>
  </View>;
}
