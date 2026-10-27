import React from 'react';
import { createRoot } from 'react-dom/client';
import { StaffSessionPanel, StaffScopeSummary } from '@yumi/web-ui';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <main
      style={{
        fontFamily: 'system-ui',
        maxWidth: 480,
        margin: '0 auto',
        padding: 24,
        color: '#1f2937',
      }}
    >
      <h1 style={{ color: '#008a42', fontSize: 24 }}>玉米百货 · 移动作业</h1>
      <p>仓库与骑手工作入口</p>
      <StaffSessionPanel>{(profile) => <StaffScopeSummary profile={profile} />}</StaffSessionPanel>
    </main>
  </React.StrictMode>,
);
