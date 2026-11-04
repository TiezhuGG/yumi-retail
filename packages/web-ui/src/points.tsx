import { useEffect, useRef, useState } from 'react';
import { staffRequest } from './index.js';
type Account = { id: string; displayName: string; balance: string };
type Entry = {
  id: string;
  delta: string;
  reason: string;
  createdAt: string;
  entryKind?: string;
  sourceAmount?: string | null;
  sourceCreatedAt?: string | null;
};
type Page<T> = { items: T[]; nextCursor: string | null };
type Intent = { account: Account | null; keyword: string; cursor?: string };
export function PointsWorkbench() {
  const [accounts, setAccounts] = useState<Account[]>([]),
    [entries, setEntries] = useState<Entry[]>([]);
  const [selected, setSelected] = useState<Account | null>(null),
    [keyword, setKeyword] = useState('');
  const [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const seq = useRef(0),
    applied = useRef(''),
    pending = useRef<Intent | null>(null);
  async function load(intent: Intent) {
    const n = ++seq.current;
    pending.current = intent;
    setLoading(true);
    setError('');
    try {
      if (intent.account) {
        const p = await staffRequest<Page<Entry>>(
          '/admin/points/accounts/' +
            intent.account.id +
            '/ledger' +
            (intent.cursor ? '?cursor=' + intent.cursor : ''),
        );
        if (n !== seq.current) return;
        setEntries((old) => (intent.cursor ? [...old, ...p.items] : p.items));
        setCursor(p.nextCursor);
      } else {
        const q = new URLSearchParams();
        if (intent.keyword) q.set('keyword', intent.keyword);
        if (intent.cursor) q.set('cursor', intent.cursor);
        const p = await staffRequest<Page<Account>>('/admin/points/accounts?' + q);
        if (n !== seq.current) return;
        setAccounts((old) => (intent.cursor ? [...old, ...p.items] : p.items));
        setCursor(p.nextCursor);
      }
      pending.current = null;
    } catch (e) {
      if (n === seq.current) {
        setError(e instanceof Error ? e.message : '读取失败');
        // A permission failure clears previously loaded personal data.
        if (e && typeof e === 'object' && 'status' in e && [401, 403].includes(Number(e.status))) {
          setAccounts([]);
          setEntries([]);
          setCursor(null);
          setSelected(null);
        }
      }
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }
  useEffect(() => {
    setCursor(null);
    void load({ account: selected, keyword: applied.current });
    return () => {
      seq.current++;
    };
  }, [selected]);
  const rows = selected ? entries : accounts;
  return (
    <section className="points-workbench" aria-label="积分账户查询">
      <div className="notice">
        积分发放请前往积分发放审批，商品兑换正在准备中。此处查询账户余额与明细。
      </div>
      {selected ? (
        <div className="points-toolbar">
          <button
            className="secondary-button"
            onClick={() => {
              setSelected(null);
              setEntries([]);
            }}
          >
            返回账户列表
          </button>
          <div>
            <h2>{selected.displayName} · 积分明细</h2>
            <p>
              列表查询时余额：<strong>{selected.balance}</strong> 积分
            </p>
          </div>
          <button
            className="secondary-button"
            disabled={loading}
            onClick={() => void load({ account: selected, keyword: applied.current })}
          >
            刷新明细
          </button>
        </div>
      ) : (
        <form
          className="points-toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            applied.current = keyword.trim();
            void load({ account: null, keyword: applied.current });
          }}
        >
          <label>
            用户名称
            <input
              value={keyword}
              maxLength={80}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="输入用户名称"
            />
          </label>
          <button className="primary-button" disabled={loading}>
            查询账户
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={loading}
            onClick={() => {
              setKeyword('');
              applied.current = '';
              void load({ account: null, keyword: '' });
            }}
          >
            重置筛选
          </button>
        </form>
      )}
      {loading && <p role="status">正在读取积分记录…</p>}
      {error && (
        <div className="notice task-error" role="alert">
          {error}
          <button
            className="secondary-button"
            disabled={loading}
            onClick={() => pending.current && void load(pending.current)}
          >
            重试读取
          </button>
        </div>
      )}
      {!loading && !error && rows.length === 0 && (
        <div className="points-empty">{selected ? '暂无积分流水' : '暂无匹配用户'}</div>
      )}
      {!selected && accounts.length > 0 && (
        <div className="points-table-wrap">
          <table className="points-table">
            <thead>
              <tr>
                <th>用户名称</th>
                <th>积分余额</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {accounts.map((a) => (
                <tr key={a.id}>
                  <td>{a.displayName}</td>
                  <td>{a.balance} 积分</td>
                  <td>
                    <button
                      className="secondary-button"
                      disabled={loading}
                      onClick={() => setSelected(a)}
                    >
                      查看明细
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && entries.length > 0 && (
        <div className="points-table-wrap">
          <table className="points-table">
          <thead><tr><th>时间（北京时间）</th><th>积分变动</th><th>说明</th></tr></thead>
          <tbody>
          {entries.map((e) => (
            <tr key={e.id}>
              <td>
                <time>
                  {new Date(e.createdAt).toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                    hour12: false,
                  })}
                </time>
              </td>
              <td>
              <strong className={e.delta.startsWith('-') ? 'points-debit' : 'points-credit'}>
                {e.delta.startsWith('-') ? '' : '+'}
                {e.delta} 积分
              </strong>
              </td>
              <td>
              <p>{e.reason}</p>
              {e.entryKind === 'GRANT_REVERSAL' && (
                <p>
                  误发冲正 · 原发放 {e.sourceAmount} 积分
                  {e.sourceCreatedAt
                    ? ' · ' +
                      new Date(e.sourceCreatedAt).toLocaleString('zh-CN', {
                        timeZone: 'Asia/Shanghai',
                      })
                    : ''}
                </p>
              )}
              </td>
            </tr>
          ))}
          </tbody>
          </table>
        </div>
      )}
      {cursor && !error && (
        <button
          className="secondary-button"
          disabled={loading}
          onClick={() => void load({ account: selected, keyword: applied.current, cursor })}
        >
          加载更多
        </button>
      )}
    </section>
  );
}
