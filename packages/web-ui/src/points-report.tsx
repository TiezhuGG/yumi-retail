import { useEffect, useRef, useState } from 'react';
import {
  POINTS_REPORT_KIND_LABELS as labels,
  type PointsReport,
  type PointsReportKind,
  type StaffProfile,
} from '@yumi/contracts';
import { PointsReportExportDialog, type PointsReportExportFilter } from './points-report-export.js';
import { staffRequest } from './index.js';
import { PointsWorkbench } from './points.js';
import { Modal } from './modal.js';
const issues = {
  MISSING: '缺少入账流水',
  INVALID: '金额或归属不符',
  UNEXPECTED: '业务未入账却有流水',
};
const amount = (v: string) => BigInt(v).toLocaleString('zh-CN');
const stamp = (v: string) => new Date(v).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
export function PointsReportWorkbench({ profile }: { profile: StaffProfile }) {
  const [exportFilter, setExportFilter] = useState<PointsReportExportFilter | null>(null);
  const [from, setFrom] = useState(() =>
      new Date(Date.parse(today() + 'T00:00:00Z') - 29 * 86400000).toISOString().slice(0, 10),
    ),
    [to, setTo] = useState(today),
    [kind, setKind] = useState(''),
    [view, setView] = useState('LEDGER');
  const [data, setData] = useState<PointsReport | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [account, setAccount] = useState<{ id: string; displayName: string; balance: string } | null>(
      null,
    );
  const seq = useRef(0),
    applied = useRef({ from, to, kind, view });
  async function load(cursor?: string, accountCursor?: string) {
    const n = ++seq.current;
    setLoading(true);
    setError('');
    if (!cursor && !accountCursor) setData(null);
    try {
      const q = new URLSearchParams(applied.current);
      if (!applied.current.kind) q.delete('kind');
      if (cursor) q.set('cursor', cursor);
      if (accountCursor) q.set('accountCursor', accountCursor);
      const next = await staffRequest<PointsReport>('/admin/points/report?' + q);
      if (n === seq.current)
        setData((old) => ({
          ...next,
          items:
            cursor && old
              ? [...old.items, ...next.items]
              : accountCursor && old
                ? old.items
                : next.items,
          nextCursor: accountCursor && old ? old.nextCursor : next.nextCursor,
          accountDifferences:
            cursor && old
              ? old.accountDifferences
              : {
                  ...next.accountDifferences,
                  items:
                    accountCursor && old
                      ? [...old.accountDifferences.items, ...next.accountDifferences.items]
                      : next.accountDifferences.items,
                },
        }));
    } catch (e) {
      if (n === seq.current) {
        setData(null);
        setError(e instanceof Error ? e.message : '积分报表读取失败');
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
    <section aria-label="积分运营报表" className="points-report-workbench">
      <form
        className="surface points-report-filters"
        onSubmit={(e) => {
          e.preventDefault();
          applied.current = { from, to, kind, view };
          void load();
        }}
      >
        <label>
          开始日期
          <input type="date" required value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          结束日期
          <input type="date" required value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <button className="primary-button" disabled={loading}>
          查询报表
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={loading}
          onClick={() => void load()}
        >
          刷新报表
        </button>
      </form>
      <p className="muted">
        按北京时间自然日查询本仓实际入账流水，结束日期包含当日，最多366天。待审批申请不计入发放。
      </p>
      {loading && <p role="status">正在核对积分报表…</p>}
      {error && (
        <div className="notice task-error" role="alert">
          {error}
          <button onClick={() => void load()}>重试积分报表</button>
        </div>
      )}
      {data && (
        <>
          <p>
            统计期间：{data.from} 至 {data.to} · 更新于 {stamp(data.checkedAt)}
          </p>
          <div className="express-readiness-metrics points-report-metrics">
            {data.totals.map((t) => (
              <article key={t.kind}>
                <span>{labels[t.kind]}</span>
                <strong>{amount(t.points)}</strong>
                <small>{t.count} 笔 · 积分变动</small>
              </article>
            ))}
          </div>
          <p className="points-report-net">
            本仓期间净变动 <strong>{amount(data.netPoints)}</strong> 积分
          </p>
          <section className="surface points-report-section" aria-label="当前积分核对">
            <div className="readiness-heading">
              <h2>当前积分核对</h2>
              <span
                className={
                  'badge ' +
                  (data.reconciliation.sourceIssues +
                    data.reconciliation.accountIssues +
                    data.reconciliation.unassignedCount >
                  0
                    ? 'amber'
                    : '')
                }
              >
                {data.reconciliation.sourceIssues + data.reconciliation.accountIssues > 0
                  ? '发现差异'
                  : data.reconciliation.unassignedCount > 0
                    ? '存在未归属流水'
                    : '本次核对未发现差异'}
              </span>
            </div>
            <p>
              以下为当前全历史核对，不随上方日期或明细类型筛选；账户余额是全局余额，不作为本仓期间余额。
            </p>
            <div className="points-report-checks">
              <article>
                <span>当前全局账户余额</span>
                <strong>{amount(data.reconciliation.currentGlobalBalance)}</strong>
              </article>
              <article>
                <span>全局累计流水净额</span>
                <strong>{amount(data.reconciliation.globalLedgerTotal)}</strong>
              </article>
              <article>
                <span>账户与流水不一致</span>
                <strong>{data.reconciliation.accountIssues} 个</strong>
              </article>
              <article>
                <span>本仓业务与流水差异</span>
                <strong>{data.reconciliation.sourceIssues} 笔</strong>
              </article>
            </div>
            <p>
              缺少流水 {data.reconciliation.missingLedger} 笔 · 金额或归属不符{' '}
              {data.reconciliation.invalidLedger} 笔 · 非入账状态却有流水{' '}
              {data.reconciliation.unexpectedLedger} 笔
            </p>
            {data.reconciliation.unassignedCount > 0 && (
              <p className="notice">
                全局有 {data.reconciliation.unassignedCount} 笔未归属业务流水，净额{' '}
                {amount(data.reconciliation.unassignedPoints)}{' '}
                积分，需另行核实；未计入本仓发放、兑换等汇总。
              </p>
            )}
            <p className="muted">发现差异时核对原始记录，不提供自动调平或任意改余额。</p>
            {data.accountDifferences.items.length > 0 && (
              <div className="points-report-accounts">
                <h3>账户差异</h3>
                {data.accountDifferences.items.map((a) => (
                  <article key={a.userId}>
                    <strong>{a.displayName}</strong>
                    <span>
                      余额 {amount(a.balance)} / 累计流水 {amount(a.ledgerTotal)}
                    </span>
                    <button
                      className="secondary-button"
                      onClick={() =>
                        setAccount({ id: a.userId, displayName: a.displayName, balance: a.balance })
                      }
                    >
                      查看账户流水
                    </button>
                  </article>
                ))}
                {data.accountDifferences.nextCursor && (
                  <button
                    className="secondary-button"
                    disabled={loading}
                    onClick={() => void load(undefined, data.accountDifferences.nextCursor!)}
                  >
                    加载更多账户差异
                  </button>
                )}
              </div>
            )}
          </section>
          <details className="surface points-report-section">
            <summary>每日积分变动（{data.daily.length} 个有流水日期）</summary>
            <button
              className="secondary-button points-report-export-button"
              disabled={loading}
              onClick={() => setExportFilter({ dataset: 'DAILY', from: data.from, to: data.to })}
            >
              导出每日汇总
            </button>
            {data.daily.length === 0 ? (
              <p>所选期间暂无已入账流水</p>
            ) : (
              <div className="points-table-wrap">
                <table className="points-table">
                  <thead>
                    <tr>
                      <th>日期（北京时间）</th>
                      <th>增加积分</th>
                      <th>扣减积分</th>
                      <th>净变动</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.daily.map((d) => (
                      <tr key={d.date}>
                        <td>{d.date}</td>
                        <td>{amount(d.incoming)}</td>
                        <td>{amount(d.outgoing)}</td>
                        <td>{amount(d.net)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </details>
          <section className="surface points-report-section" aria-label="积分报表明细">
            <div className="points-report-filters">
              <label htmlFor="points-report-view">明细范围</label>
              <select
                id="points-report-view"
                value={view}
                onChange={(e) => {
                  const v = e.target.value;
                  setView(v);
                  applied.current = { ...applied.current, view: v };
                  void load();
                }}
              >
                <option value="LEDGER">所选期间入账流水</option>
                <option value="ISSUES">本仓全历史业务差异</option>
              </select>
              <label htmlFor="points-report-kind">类型</label>
              <select
                id="points-report-kind"
                value={kind}
                onChange={(e) => {
                  const k = e.target.value;
                  setKind(k);
                  applied.current = { ...applied.current, kind: k };
                  void load();
                }}
              >
                <option value="">全部类型</option>
                {Object.entries(labels).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </div>
            <button
              className="secondary-button points-report-export-button"
              disabled={loading || view !== 'LEDGER'}
              title={
                view === 'LEDGER' ? '导出全部匹配的入账明细' : '请切换到所选期间入账流水后导出'
              }
              onClick={() =>
                setExportFilter({
                  dataset: 'LEDGER',
                  from: data.from,
                  to: data.to,
                  ...(applied.current.kind
                    ? { kind: applied.current.kind as PointsReportKind }
                    : {}),
                })
              }
            >
              导出入账明细
            </button>
            {data.items.length === 0 ? (
              <div className="points-empty">
                {data.view === 'ISSUES'
                  ? '当前类型未发现业务流水差异'
                  : '所选期间和类型暂无入账流水'}
              </div>
            ) : (
              <div className="points-table-wrap points-report-entries">
                <table className="points-table">
                  <thead>
                    <tr>
                      <th>业务 / 依据</th>
                      <th>顾客</th>
                      <th>应记 / 实记积分</th>
                      <th>时间（北京时间）</th>
                      <th>核对结果</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((row) => (
                      <tr key={row.key}>
                        <td>
                          <strong>{labels[row.kind]}</strong>
                          <small>{row.reference}</small>
                        </td>
                        <td>{row.displayName}</td>
                        <td>
                          {amount(row.expectedPoints)} /{' '}
                          {row.actualPoints === null ? '无流水' : amount(row.actualPoints)}
                        </td>
                        <td>
                          {stamp(row.ledgerAt ?? row.occurredAt)}
                          <small>{row.ledgerAt ? '入账时间' : '业务时间'}</small>
                        </td>
                        <td>
                          <span className={'badge ' + (row.issue ? 'amber' : '')}>
                            {row.issue ? issues[row.issue] : '本次核对一致'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {data.nextCursor && (
              <button
                className="secondary-button"
                disabled={loading}
                onClick={() => void load(data.nextCursor!)}
              >
                加载更多积分明细
              </button>
            )}
          </section>
        </>
      )}
      {exportFilter && (
        <PointsReportExportDialog
          filter={exportFilter}
          profile={profile}
          onClose={() => setExportFilter(null)}
        />
      )}
      {account && (
        <Modal title={account.displayName + ' · 账户流水'} onClose={() => setAccount(null)}>
          <PointsWorkbench account={account} />
        </Modal>
      )}
    </section>
  );
}
