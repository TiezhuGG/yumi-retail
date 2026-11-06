import { useEffect, useRef, useState } from 'react';
import {
  MALL_AUDIT_GROUPS,
  MALL_AUDIT_ACTIONS,
  POINTS_REPORT_KIND_LABELS,
  type MallAuditPage,
  type MallAuditEntry,
  type MallAuditDetail,
  type PointsReportKind,
} from '@yumi/contracts';
import { staffRequest } from './index.js';
import { Modal } from './modal.js';
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const stamp = (v: string) =>
  new Date(v).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
function AuditDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const [data, setData] = useState<MallAuditDetail | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const seq = useRef(0);
  async function load() {
    const n = ++seq.current;
    setLoading(true);
    setError('');
    setData(null);
    try {
      const v = await staffRequest<MallAuditDetail>('/admin/mall/audits/' + id);
      if (n === seq.current) setData(v);
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '操作记录读取失败');
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      seq.current++;
    };
  }, []);
  return (
    <Modal title="商城操作记录详情" onClose={onClose}>
      {loading && <p role="status">正在读取操作详情…</p>}
      {error && (
        <div role="alert" className="notice task-error">
          {error}
          <button className="secondary-button" disabled={loading} onClick={() => void load()}>
            重试操作详情
          </button>
        </div>
      )}
      {data && (
        <>
          <dl className="points-export-scope">
            <div>
              <dt>操作</dt>
              <dd>{MALL_AUDIT_ACTIONS[data.action].label}</dd>
            </div>
            <div>
              <dt>时间（北京时间）</dt>
              <dd>{stamp(data.createdAt)}</dd>
            </div>
            <div>
              <dt>操作人（当前名称）</dt>
              <dd>{data.actorName}</dd>
            </div>
            <div>
              <dt>关联资料</dt>
              <dd>{data.sourceLabel}</dd>
            </div>
          </dl>
          {data.orderNos.length > 0 && (
            <section>
              <h3>关联订单</h3>
              <ul className="mall-audit-orders">
                {data.orderNos.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </section>
          )}
          {data.exportSummary && (
            <section className="notice">
              <h3>文件生成范围</h3>
              <p>
                {data.exportSummary.dataset === 'LEDGER' ? '积分入账明细' : '每日积分汇总'} ·{' '}
                {data.exportSummary.rowCount}行
              </p>
              <p>
                {data.exportSummary.from} 至 {data.exportSummary.to}（北京时间，含结束当日）
              </p>
              <p>
                积分类型：
                {data.exportSummary.kind
                  ? POINTS_REPORT_KIND_LABELS[data.exportSummary.kind as PointsReportKind]
                  : '全部类型'}
              </p>
              <p>生成时间：{stamp(data.exportSummary.generatedAt)}（北京时间）</p>
              <p>此记录表示文件已生成，不保存文件正文。</p>
            </section>
          )}
          {data.action === 'POINTS_REPORT_EXPORT' && !data.exportSummary && (
            <p className="notice">此记录没有可验证的文件生成范围。</p>
          )}
          <p className="muted">
            关联名称来自当前资料。详细原因及隐私内容请在原业务页面按权限查看。
          </p>
          <details>
            <summary>追溯编号</summary>
            <p className="mall-audit-code">记录：{data.id}</p>
            <p className="mall-audit-code">请求：{data.requestId}</p>
          </details>
        </>
      )}
    </Modal>
  );
}
export function MallAuditWorkbench() {
  const [from, setFrom] = useState(() =>
      new Date(Date.parse(today() + 'T00:00:00Z') - 29 * 86400000).toISOString().slice(0, 10),
    ),
    [to, setTo] = useState(today),
    [group, setGroup] = useState(''),
    [actor, setActor] = useState('');
  const [items, setItems] = useState<MallAuditEntry[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [detailId, setDetailId] = useState<string | null>(null);
  const seq = useRef(0),
    applied = useRef({ from, to, group, actor });
  async function load(next?: string) {
    const n = ++seq.current;
    setLoading(true);
    setError('');
    setDetailId(null);
    if (!next) {
      setItems([]);
      setCursor(null);
    }
    try {
      const q = new URLSearchParams({ from: applied.current.from, to: applied.current.to });
      if (applied.current.group) q.set('group', applied.current.group);
      if (applied.current.actor.trim()) q.set('actor', applied.current.actor.trim());
      if (next) q.set('cursor', next);
      const v = await staffRequest<MallAuditPage>('/admin/mall/audits?' + q);
      if (n === seq.current) {
        setItems((old) => (next ? [...old, ...v.items] : v.items));
        setCursor(v.nextCursor);
      }
    } catch (e) {
      if (n === seq.current) {
        setItems([]);
        setCursor(null);
        setError(e instanceof Error ? e.message : '商城操作记录读取失败');
      }
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      seq.current++;
    };
  }, []);
  return (
    <section aria-label="商城操作记录">
      <form
        className="surface points-report-filters"
        onSubmit={(e) => {
          e.preventDefault();
          applied.current = { from, to, group, actor };
          void load();
        }}
      >
        <label>
          开始日期
          <input
            type="date"
            required
            value={from}
            disabled={loading}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          结束日期
          <input
            type="date"
            required
            value={to}
            disabled={loading}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <label>
          操作类别
          <select
            aria-label="操作类别"
            value={group}
            disabled={loading}
            onChange={(e) => setGroup(e.target.value)}
          >
            <option value="">全部已接入类别</option>
            {Object.entries(MALL_AUDIT_GROUPS).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          操作人
          <input
            aria-label="操作人"
            placeholder="按当前名称查询"
            value={actor}
            maxLength={80}
            disabled={loading}
            onChange={(e) => setActor(e.target.value)}
          />
        </label>
        <button className="primary-button" disabled={loading}>
          查询操作记录
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={loading}
          onClick={() => void load()}
        >
          刷新操作记录
        </button>
      </form>
      {loading && <p role="status">正在读取商城操作记录…</p>}
      {error && (
        <div role="alert" className="notice task-error">
          {error}
          <button className="secondary-button" disabled={loading} onClick={() => void load()}>
            重试操作记录
          </button>
        </div>
      )}
      {!loading && !error && !items.length && (
        <div className="surface points-empty">当前条件暂无商城操作记录</div>
      )}
      {items.length > 0 && (
        <section className="surface points-report-section">
          <table className="points-table mall-audit-table">
            <thead>
              <tr>
                <th>时间（北京时间）</th>
                <th>操作</th>
                <th>操作人（当前名称）</th>
                <th>关联资料</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td data-label="时间">{stamp(a.createdAt)}</td>
                  <td data-label="操作">
                    <strong>{MALL_AUDIT_ACTIONS[a.action].label}</strong>
                    <small>{MALL_AUDIT_GROUPS[a.group]}</small>
                  </td>
                  <td data-label="操作人（当前名称）">{a.actorName}</td>
                  <td data-label="关联资料">{a.sourceLabel}</td>
                  <td>
                    <button
                      className="secondary-button"
                      disabled={loading}
                      onClick={() => setDetailId(a.id)}
                    >
                      查看记录
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">已加载 {items.length} 条</p>
          {cursor && (
            <button
              className="secondary-button"
              disabled={loading}
              onClick={() => void load(cursor)}
            >
              加载更多操作记录
            </button>
          )}
        </section>
      )}
      {detailId && <AuditDetail key={detailId} id={detailId} onClose={() => setDetailId(null)} />}
    </section>
  );
}
