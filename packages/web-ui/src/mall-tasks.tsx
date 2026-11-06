import { useEffect, useRef, useState } from 'react';
import type { MallTasks, StaffProfile } from '@yumi/contracts';
import { staffRequest } from './index.js';
export type MallTaskCode = MallTasks['queues'][number]['code'];
const labels: Record<MallTaskCode, string> = {
  WAIT_SHIP: '待快递发货',
  GRANTS: '积分发放待审批',
  CORRECTIONS: '积分冲正待审批',
  FEEDBACK_OPEN: '售后反馈待处理',
  FEEDBACK_PROCESSING: '售后反馈处理中',
  REQUESTED: '退货退积分待审核',
  WAIT_RETURN: '等待退回验收',
  READY_TO_REFUND: '待退积分',
};
export function MallTasksWorkbench({
  profile,
  onQueue,
  onReward,
}: {
  profile: StaffProfile;
  onQueue: (code: MallTaskCode) => void;
  onReward: (id: string) => void;
}) {
  const [data, setData] = useState<MallTasks | null>(null),
    [threshold, setThreshold] = useState('5'),
    [filter, setFilter] = useState('ALL'),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const seq = useRef(0),
    applied = useRef({ threshold: '5', stock: 'ALL' }),
    pending = useRef<string | undefined>(undefined);
  async function load(cursor?: string) {
    const n = ++seq.current;
    pending.current = cursor;
    setLoading(true);
    setError('');
    // Clear stale counts on every request; a failed refresh must never look current.
    if (!cursor) setData(null);
    try {
      const q = new URLSearchParams(applied.current);
      if (cursor) q.set('cursor', cursor);
      const next = await staffRequest<MallTasks>('/admin/mall-tasks?' + q);
      if (n === seq.current)
        setData((old) => ({
          ...next,
          stock: {
            ...next.stock,
            items: cursor && old ? [...old.stock.items, ...next.stock.items] : next.stock.items,
          },
        }));
    } catch (e) {
      if (n === seq.current) {
        setData(null);
        pending.current = undefined;
        setError(e instanceof Error ? e.message : '商城待办读取失败');
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
    <section aria-label="商城待办" className="mall-tasks-workbench">
      <div className="surface mall-task-toolbar">
        <div>
          <h2>需要处理的事项</h2>
          <p>当前经营仓实时查询；查看时间以本次刷新为准。</p>
        </div>
        <button className="primary-button" disabled={loading} onClick={() => void load()}>
          刷新待办
        </button>
      </div>
      {loading && <p role="status">正在读取商城待办…</p>}
      {error && (
        <div className="notice task-error" role="alert">
          {error}
          <button onClick={() => void load(pending.current)}>重试待办</button>
        </div>
      )}
      {data && (
        <>
          <p className="muted">
            更新于 {new Date(data.checkedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
            （北京时间）
          </p>
          <div className="express-readiness-metrics mall-task-queues">
            {data.queues.map((q) => (
              <article key={q.code}>
                <span>{labels[q.code]}</span>
                <strong>{q.count}</strong>
                <small>
                  {q.oldestAt
                    ? (q.code.startsWith('FEEDBACK_') ? '最早更新：' : '最早进入：') +
                      new Date(q.oldestAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
                    : '当前无待办'}
                </small>
                {q.count > 0 && (
                  <button
                    className="secondary-button"
                    disabled={
                      (q.code === 'GRANTS' || q.code === 'CORRECTIONS') &&
                      !profile.permissions.includes('points.write')
                    }
                    onClick={() => onQueue(q.code)}
                  >
                    查看{labels[q.code]}
                  </button>
                )}
              </article>
            ))}
          </div>
          <p className="muted">
            审批仍由另一名负责人执行；等待退回需结合用户寄回情况核实。未设置超时规则。
          </p>
        </>
      )}
      <section className="surface mall-task-stock" aria-label="库存提醒">
        <h2>库存提醒</h2>
        <p>只统计当前开放展示的已上架商品，按可兑换库存计算；0件为缺货，1至查看阈值为低库存。</p>
        <form
          className="mall-task-filters"
          onSubmit={(e) => {
            e.preventDefault();
            applied.current = { threshold, stock: filter };
            void load();
          }}
        >
          <label>
            低库存查看阈值（件）
            <input
              type="number"
              min="0"
              max="1000"
              step="1"
              required
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
            />
          </label>
          <div className="mall-task-field">
            <label htmlFor="mall-task-stock-filter">
              <span>库存范围</span>
            </label>
            <select
              id="mall-task-stock-filter"
              aria-label="库存范围"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="ALL">缺货与低库存</option>
              <option value="ZERO">仅缺货</option>
              <option value="LOW">仅低库存</option>
            </select>
          </div>
          <button className="primary-button" disabled={loading}>
            查看库存
          </button>
        </form>
        <p className="muted">阈值仅用于本次查看，不会保存为经营设置或发送通知。</p>
        {data && (
          <>
            <div className="mall-stock-summary">
              <span>
                缺货 <strong>{data.stock.outOfStock}</strong> 个
              </span>
              <span>
                低库存 <strong>{data.stock.lowStock}</strong> 个（查看阈值 {data.lowStockThreshold}{' '}
                件）
              </span>
            </div>
            {data.stock.items.length === 0 ? (
              <div className="points-empty">当前范围没有缺货或低库存商品</div>
            ) : (
              <div className="points-table-wrap">
                <table className="points-table">
                  <thead>
                    <tr>
                      <th>商品</th>
                      <th>规格</th>
                      <th>可兑换库存</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.stock.items.map((item) => (
                      <tr key={item.id}>
                        <td>
                          <strong>{item.title}</strong>
                          <small className="mall-stock-name">{item.name}</small>
                        </td>
                        <td>
                          {item.spec} / {item.unit}
                        </td>
                        <td>
                          <span className={'badge ' + (item.available === 0 ? 'amber' : '')}>
                            {item.available === 0 ? '缺货' : item.available + '件'}
                          </span>
                        </td>
                        <td>
                          {profile.permissions.includes('points.write') ? (
                            <button className="secondary-button" onClick={() => onReward(item.id)}>
                              检查商品
                            </button>
                          ) : (
                            <span>请有商品维护权限的人员处理</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {data.stock.nextCursor && (
              <button
                className="secondary-button"
                disabled={loading}
                onClick={() => void load(data.stock.nextCursor!)}
              >
                加载更多库存提醒
              </button>
            )}
          </>
        )}
      </section>
    </section>
  );
}
