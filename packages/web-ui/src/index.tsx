import { useEffect, useState } from 'react';
import type { CSSProperties, FormEvent, ReactNode } from 'react';
import type { StaffProfile, WarehouseSummary } from '@yumi/contracts';

export type { StaffProfile };
export { CatalogWorkbench } from './catalog.js';
export { Workspace } from './workspace.js';
import { Brand } from './brand.js';
const button: CSSProperties = {
  background: '#008a42',
  color: 'white',
  border: 0,
  borderRadius: 8,
  padding: '12px 20px',
  fontSize: 16,
  cursor: 'pointer',
  minHeight: 44,
};
const input: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: 12,
  fontSize: 16,
  border: '1px solid #d0d5dd',
  borderRadius: 8,
  marginTop: 6,
};

export async function staffRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, { ...init, credentials: 'same-origin' });
  const body = (await response.json()) as { data: T; error?: { message?: string } };
  if (!response.ok) throw new Error(body.error?.message ?? '请求未能完成，请稍后再试');
  return body.data;
}

export function StaffSessionPanel({
  children,
  workspace = false,
}: {
  children: (profile: StaffProfile, sessionControl: ReactNode) => ReactNode;
  workspace?: boolean;
}) {
  const [profile, setProfile] = useState<StaffProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    staffRequest<StaffProfile>('/staff/me')
      .then((value) => {
        if (active) setProfile(value);
      })
      .catch(() => {})
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);
  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setMessage('');
    const data = new FormData(event.currentTarget);
    try {
      await staffRequest('/staff/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ loginName: data.get('loginName'), password: data.get('password') }),
      });
      setProfile(await staffRequest<StaffProfile>('/staff/me'));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '登录失败');
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    if (!profile) return;
    setBusy(true);
    setMessage('');
    try {
      await staffRequest('/staff/auth/logout', {
        method: 'POST',
        headers: { 'X-CSRF-Token': profile.csrfToken },
      });
      setProfile(null);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '退出失败');
    } finally {
      setBusy(false);
    }
  }
  if (loading)
    return (
      <div className="session-loading" role="status">
        <Brand />
        <p>正在进入工作空间…</p>
      </div>
    );
  const sessionControl = (
    <button className="logout-button" disabled={busy} onClick={() => void logout()}>
      退出登录
    </button>
  );
  if (workspace && profile)
    return (
      <>
        {message && (
          <p role="alert" className="session-error">
            {message}
          </p>
        )}
        {children(profile, sessionControl)}
      </>
    );
  if (workspace && !profile)
    return (
      <div className="login-page">
        <header>
          <Brand />
          <span>用心服务，近在身边</span>
        </header>
        <main className="login-layout">
          <section className="login-story">
            <span className="eyebrow">YOUR NEIGHBORHOOD, OUR CARE</span>
            <h1>
              让社区生活
              <br />
              更简单<span>。</span>
            </h1>
            <p>
              好物触手可及，经营井然有序。
              <br />
              每一份日常，都值得用心对待。
            </p>
            <div className="shop-illustration" aria-hidden="true">
              <div className="shop-sun" />
              <div className="shop-tree left" />
              <div className="shop-tree right" />
              <div className="shop-building">
                <div className="shop-sign">🌽 玉米百货</div>
                <div className="shop-awning" />
                <div className="shop-windows">
                  <i />
                  <b />
                  <i />
                </div>
                <div className="shop-step" />
              </div>
              <div className="shop-parcel one">好物</div>
              <div className="shop-parcel two">日常</div>
              <div className="shop-ground" />
            </div>
            <div className="story-benefits">
              <span>✧ 品质好物</span>
              <span>⌂ 社区配送</span>
              <span>✓ 放心经营</span>
            </div>
          </section>
          <section className="login-card">
            <span className="login-kicker">欢迎回来</span>
            <h2>登录工作空间</h2>
            <p>玉米百货 · 运营与仓库作业</p>
            <form onSubmit={(e) => void login(e)}>
              <label>
                员工账号
                <input
                  name="loginName"
                  autoComplete="username"
                  required
                  maxLength={64}
                  placeholder="请输入员工账号"
                />
              </label>
              <label>
                登录密码
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={128}
                  placeholder="请输入登录密码"
                />
              </label>
              {message && (
                <p className="form-error" role="alert">
                  {message}
                </p>
              )}
              <button className="primary-button login-submit" disabled={busy}>
                {busy ? '正在登录…' : '登录工作空间 →'}
              </button>
            </form>
            <div className="login-help">账号由管理员分配 · 需要帮助请联系负责人</div>
            <div className="login-security">
              <span className="live-dot" /> 员工专属 · 安全访问
            </div>
          </section>
        </main>
        <footer>
          玉米百货 <span>社区里的好生活</span>
        </footer>
      </div>
    );
  return (
    <section>
      {message && (
        <p role="alert" style={{ color: '#b42318' }}>
          {message}
        </p>
      )}
      {profile ? (
        <>
          <div
            style={{
              display: 'flex',
              gap: 16,
              alignItems: 'center',
              justifyContent: 'space-between',
              flexWrap: 'wrap',
            }}
          >
            <p>你好，{profile.displayName}</p>
            <button style={button} disabled={busy} onClick={() => void logout()}>
              退出登录
            </button>
          </div>
          {children(profile, sessionControl)}
        </>
      ) : (
        <form
          onSubmit={(event) => void login(event)}
          style={{
            maxWidth: 380,
            margin: '40px auto',
            background: 'white',
            borderRadius: 12,
            padding: 24,
          }}
        >
          <h2>员工登录</h2>
          <p style={{ color: '#667085' }}>使用管理员提供的账号</p>
          <label style={{ display: 'block', marginTop: 20 }}>
            账号
            <input name="loginName" autoComplete="username" required maxLength={64} style={input} />
          </label>
          <label style={{ display: 'block', marginTop: 20 }}>
            密码
            <input
              name="password"
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
              style={input}
            />
          </label>
          <button type="submit" disabled={busy} style={{ ...button, width: '100%', marginTop: 24 }}>
            {busy ? '正在登录…' : '登录'}
          </button>
        </form>
      )}
    </section>
  );
}

export function StaffScopeSummary({ profile }: { profile: StaffProfile }) {
  const [warehouses, setWarehouses] = useState<WarehouseSummary[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!profile.permissions.includes('warehouse.read')) return;
    let active = true;
    staffRequest<{ items: WarehouseSummary[] }>('/warehouse/warehouses')
      .then((data) => {
        if (active) setWarehouses(data.items);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : '仓库读取失败');
      });
    return () => {
      active = false;
    };
  }, [profile]);
  const labels: Record<string, string> = {
    SUPER_ADMIN: '管理员',
    OPERATIONS: '运营',
    WAREHOUSE_MANAGER: '仓管',
    PICKER: '拣货员',
    DISPATCHER: '调度',
    RIDER: '骑手',
    CUSTOMER_SERVICE: '客服',
  };
  return (
    <section style={{ background: '#f3f4f6', borderRadius: 12, padding: 20 }}>
      <h2 style={{ fontSize: 18 }}>当前工作权限</h2>
      <p>角色：{profile.roles.map((role) => labels[role] ?? role).join('、') || '未分配'}</p>
      {error && <p role="alert">{error}</p>}
      {profile.permissions.includes('warehouse.read') ? (
        <p>授权仓库：{warehouses.map((w) => w.name).join('、') || '暂无'}</p>
      ) : (
        <p>当前账号未开放仓库管理权限。</p>
      )}
      <p>商品作业与配送任务将逐步开放。</p>
    </section>
  );
}
