import { useEffect, useState } from 'react';
import type { CSSProperties, FormEvent, ReactNode } from 'react';
import type { StaffProfile, WarehouseSummary } from '@yumi/contracts';

export type { StaffProfile };
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
}: {
  children: (profile: StaffProfile) => ReactNode;
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
  if (loading) return <p role="status">正在确认登录状态…</p>;
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
          {children(profile)}
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
