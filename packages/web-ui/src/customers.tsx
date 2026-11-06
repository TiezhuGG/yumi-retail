import { CustomerNotesPanel } from './customer-notes.js';
import { CustomerStatusPanel } from './customer-status.js';
import { useEffect, useRef, useState } from 'react';
import type { StaffProfile } from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
import { PointsWorkbench } from './points.js';
import { PointsGrants } from './points-grants.js';
type Customer = {
  id: string;
  displayName: string;
  provider: string;
  enabled: boolean;
  stateVersion: number;
  createdAt: string;
  balance: string;
};
type Detail = {
  user: Customer;
  lastLoginAt: string | null;
  orders: number;
  redemptions: number;
  pendingGrants: number;
  pendingCorrections: number;
};
const date = (value: string | null) =>
  value ? new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '暂无记录';
export function CustomersWorkbench({ profile }: { profile: StaffProfile }) {
  const [items, setItems] = useState<Customer[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [keyword, setKeyword] = useState(''),
    [provider, setProvider] = useState(''),
    [enabled, setEnabled] = useState('');
  const [selected, setSelected] = useState<string | null>(null),
    [detail, setDetail] = useState<Detail | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [tab, setTab] = useState<'ledger' | 'grants' | 'corrections'>('ledger'),
    [locked, setLocked] = useState(false),
    [statusLocked, setStatusLocked] = useState(false),
    [notesLocked, setNotesLocked] = useState(false);
  const sequence = useRef(0),
    applied = useRef({ keyword: '', provider: '', enabled: '' }),
    pending = useRef<string | undefined>(undefined);
  async function load(next?: string) {
    const n = ++sequence.current;
    setLoading(true);
    setError('');
    pending.current = next;
    try {
      if (selected) {
        const d = await staffRequest<Detail>('/admin/customers/' + selected);
        if (n === sequence.current) setDetail(d);
      } else {
        const q = new URLSearchParams();
        for (const [k, v] of Object.entries(applied.current)) if (v) q.set(k, v);
        if (next) q.set('cursor', next);
        const d = await staffRequest<{ items: Customer[]; nextCursor: string | null }>(
          '/admin/customers?' + q,
        );
        if (n === sequence.current) {
          setItems((old) => (next ? [...old, ...d.items] : d.items));
          setCursor(d.nextCursor);
        }
      }
    } catch (e) {
      if (n === sequence.current) {
        setError(e instanceof Error ? e.message : '顾客资料读取失败');
        if (e instanceof StaffRequestError && [401, 403].includes(e.status)) {
          setItems([]);
          setCursor(null);
          setDetail(null);
        }
      }
    } finally {
      if (n === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    setDetail(null);
    setTab('ledger');
    void load();
    return () => {
      sequence.current++;
    };
  }, [selected]);
  return (
    <section aria-label="顾客管理" className="points-workbench">
      {selected ? (
        <div className="points-toolbar">
          <button
            className="secondary-button"
            disabled={locked || statusLocked || notesLocked}
            onClick={() => setSelected(null)}
          >
            返回顾客列表
          </button>
          <button
            className="secondary-button"
            disabled={loading || locked || statusLocked || notesLocked}
            onClick={() => void load()}
          >
            刷新资料
          </button>
        </div>
      ) : (
        <form
          className="points-toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            applied.current = { keyword: keyword.trim(), provider, enabled };
            void load();
          }}
        >
          <label>
            顾客名称
            <input maxLength={80} value={keyword} onChange={(e) => setKeyword(e.target.value)} />
          </label>
          <label>
            账号来源
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="">全部</option>
              <option value="WECHAT">微信顾客</option>
              <option value="DEVELOPMENT">开发测试顾客</option>
            </select>
          </label>
          <label>
            账号状态
            <select value={enabled} onChange={(e) => setEnabled(e.target.value)}>
              <option value="">全部</option>
              <option value="true">正常</option>
              <option value="false">已停用</option>
            </select>
          </label>
          <button className="primary-button" disabled={loading}>
            查询顾客
          </button>
        </form>
      )}
      {loading && <p role="status">正在读取顾客资料…</p>}
      {error && (
        <div className="notice task-error" role="alert">
          {error}
          <button
            className="secondary-button"
            disabled={loading}
            onClick={() => void load(pending.current)}
          >
            重试读取
          </button>
        </div>
      )}
      {!selected && !error && items.length > 0 && (
        <div className="points-table-wrap">
          <table className="points-table">
            <thead>
              <tr>
                <th>顾客</th>
                <th>账号来源 / 状态</th>
                <th>注册时间</th>
                <th>可用积分</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((u) => (
                <tr key={u.id}>
                  <td>{u.displayName}</td>
                  <td>
                    {u.provider === 'WECHAT' ? '微信顾客' : '开发测试顾客'}
                    <p>{u.enabled ? '正常' : '已停用'}</p>
                  </td>
                  <td>{date(u.createdAt)}</td>
                  <td>{u.balance}</td>
                  <td>
                    <button
                      className="secondary-button"
                      disabled={loading}
                      onClick={() => setSelected(u.id)}
                    >
                      查看顾客
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!selected && !loading && !error && !items.length && (
        <div className="points-empty">暂无匹配顾客</div>
      )}
      {!selected && cursor && !error && (
        <button className="secondary-button" disabled={loading} onClick={() => void load(cursor)}>
          加载更多顾客
        </button>
      )}
      {detail && selected === detail.user.id && !error && (
        <>
          <div className="surface">
            <h2>{detail.user.displayName}</h2>
            <div className="reward-form-grid">
              <p>账号来源：{detail.user.provider === 'WECHAT' ? '微信顾客' : '开发测试顾客'}</p>
              <p>状态：{detail.user.enabled ? '正常' : '已停用'}</p>
              <p>注册时间：{date(detail.user.createdAt)}</p>
              <p>最近登录：{date(detail.lastLoginAt)}</p>
              <p>
                可用积分：<strong>{detail.user.balance}</strong>
              </p>
              <p>
                兑换订单：{detail.redemptions} · 现金订单：{detail.orders}
              </p>
              <p>
                待审发放：{detail.pendingGrants} · 待审冲正：{detail.pendingCorrections}
              </p>
              <p>绑定手机号：尚未采集</p>
            </div>
            <details>
              <summary>顾客编号</summary>
              {detail.user.id}
            </details>
          </div>
          <CustomerStatusPanel
            key={detail.user.id}
            customer={detail.user}
            profile={profile}
            locked={locked || loading || notesLocked}
            onPendingChange={setStatusLocked}
            onChanged={() => void load()}
          />
          <CustomerNotesPanel
            key={'notes:' + detail.user.id}
            id={detail.user.id}
            profile={profile}
            locked={locked || statusLocked || loading}
            onPendingChange={setNotesLocked}
          />
          <div className="points-toolbar">
            {(['ledger', 'grants', 'corrections'] as const)
              .filter((t) => t === 'ledger' || profile.permissions.includes('points.write'))
              .map((t) => (
                <button
                  key={t}
                  className={tab === t ? 'primary-button' : 'secondary-button'}
                  disabled={locked || statusLocked || notesLocked}
                  onClick={() => setTab(t)}
                >
                  {t === 'ledger' ? '积分明细' : t === 'grants' ? '发放积分' : '误发冲正'}
                </button>
              ))}
          </div>
          {tab === 'ledger' ? (
            <PointsWorkbench key={detail.user.id + detail.user.balance} account={detail.user} />
          ) : (
            <PointsGrants
              key={detail.user.id + tab}
              profile={profile}
              correction={tab === 'corrections'}
              targetCustomer={detail.user}
              onPendingChange={setLocked}
            />
          )}
        </>
      )}
    </section>
  );
}
