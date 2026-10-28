import React from 'react';
import { createRoot } from 'react-dom/client';
import { StaffSessionPanel, Workspace } from '@yumi/web-ui';
import '@yumi/web-ui/styles.css';
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StaffSessionPanel workspace>
      {(profile, sessionControl) => <Workspace profile={profile} sessionControl={sessionControl} />}
    </StaffSessionPanel>
  </React.StrictMode>,
);
