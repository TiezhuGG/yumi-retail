import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, Layout, Typography } from 'antd';
import { StaffSessionPanel, StaffScopeSummary } from '@yumi/web-ui';
const { Header, Content } = Layout;
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider theme={{ token: { colorPrimary: '#008a42' } }}>
      <Layout style={{ minHeight: '100vh' }}>
        <Header style={{ background: '#fff', color: '#008a42', fontWeight: 700 }}>
          玉米百货 · 运营后台
        </Header>
        <Content style={{ margin: 24 }}>
          <Typography.Title level={2}>开发工作台</Typography.Title>
          <StaffSessionPanel>
            {(profile) => <StaffScopeSummary profile={profile} />}
          </StaffSessionPanel>
        </Content>
      </Layout>
    </ConfigProvider>
  </React.StrictMode>,
);
