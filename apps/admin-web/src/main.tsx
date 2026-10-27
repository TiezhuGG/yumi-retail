import React from 'react';
import { createRoot } from 'react-dom/client';
import { Alert, ConfigProvider, Layout, Typography } from 'antd';
import { applicationStage } from '@yumi/contracts';
const { Header, Content } = Layout;
createRoot(document.getElementById('root')!).render(<React.StrictMode><ConfigProvider theme={{ token: { colorPrimary: '#008a42' } }}><Layout style={{ minHeight: '100vh' }}>
  <Header style={{ background: '#fff', color: '#008a42', fontWeight: 700 }}>玉米百货 · 运营后台</Header>
  <Content style={{ margin: 24 }}><Typography.Title level={2}>开发工作台</Typography.Title>
    <Alert type="info" showIcon message={`当前处于 ${applicationStage} 工程验证阶段`} description="商品、仓储和配送业务将分阶段接入；此页面尚不提供业务操作。" />
  </Content>
</Layout></ConfigProvider></React.StrictMode>);
