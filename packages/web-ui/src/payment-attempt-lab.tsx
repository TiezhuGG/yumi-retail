import { useEffect, useRef, useState } from 'react';
import type {
  PaymentAttemptLabList,
  PaymentAttemptLabDetail,
  PaymentAttemptLabWrite,
  StaffProfile,
  WarehouseSummary,
} from '@yumi/contracts';
import { staffRequest } from './index.js';
export function PaymentAttemptLabWorkbench({ profile }: { profile: StaffProfile }) {
  const [warehouses, setWarehouses] = useState<WarehouseSummary[]>([]),
    [warehouseId, setWarehouseId] = useState(''),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const seq = useRef(0);
  async function load() {
    const n = ++seq.current;
    setLoading(true);
    setError('');
    try {
      const r = await staffRequest<{ items: WarehouseSummary[] }>('/warehouse/warehouses');
      if (n === seq.current) {
        setWarehouses(r.items);
        setWarehouseId((old) => (r.items.some((w) => w.id === old) ? old : (r.items[0]?.id ?? '')));
      }
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '仓库读取失败');
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
    <div className="payment-readiness-workbench">
      <div className="notice">
        独立记录合成支付尝试与结果。不会调用真实渠道、记账、释放库存或修改订单；模拟成功不代表真实收款。
      </div>
      {loading ? (
        <div className="surface empty-state" role="status">
          正在读取授权仓库…
        </div>
      ) : error ? (
        <div className="notice task-error" role="alert">
          {error}
          <button onClick={() => void load()}>重试读取仓库</button>
        </div>
      ) : !warehouses.length ? (
        <div className="surface empty-state">暂无授权仓库，请联系负责人。</div>
      ) : (
        <>
          <div className="toolbar">
            <label className="readiness-warehouse">
              验证仓库
              <select
                aria-label="验证仓库"
                value={warehouseId}
                onChange={(e) => setWarehouseId(e.target.value)}
              >
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <AttemptsPanel key={warehouseId} warehouseId={warehouseId} profile={profile} />
        </>
      )}
    </div>
  );
}
const evidenceLabel: Record<string, string> = {
  NONE: '已记录尝试，尚无结果',
  UNKNOWN: '结果未知，等待核查',
  CLOSED: '合成关闭结果待核对',
  SUCCEEDED: '合成成功结果待核对',
  CONFLICT: '结果冲突，需核查',
};
const actionLabel: Record<string, string> = {
  STARTED: '开始合成尝试',
  UNKNOWN_RESULT: '模拟响应丢失',
  CLOSED_RESULT: '模拟查单关闭',
  SUCCESS_RESULT: '模拟查单成功',
};
const planLabel: Record<string, string> = {
  REQUEST_CHANNEL_CLOSE: '后续应请求渠道关闭；本页未调用渠道。',
  QUERY_CHANNEL: '后续应查单；未知结果不能按失败释放预占。',
  RECONCILE_CLOSE: '后续须事务核对关闭结果；本页不释放库存。',
  RECONCILE_PAYMENT: '后续须事务核对支付结果；本页不入账。',
  REVIEW_CONFLICT: '成功与关闭结果矛盾，保留证据等待核查。',
};
function AttemptsPanel({ warehouseId, profile }: { warehouseId: string; profile: StaffProfile }) {
  const [data, setData] = useState<PaymentAttemptLabList | null>(null),
    [selected, setSelected] = useState<PaymentAttemptLabDetail | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const seq = useRef(0),
    active = useRef(false),
    keys = useRef<Record<string, string>>({});
  const base = '/admin/payment-attempt-lab',
    query = '?warehouseId=' + warehouseId;
  const storagePrefix = 'yumi.attempt-lab:' + profile.id + ':' + warehouseId + ':';
  function keyFor(op: string) {
    if (keys.current[op]) return keys.current[op];
    let saved: string | null = null;
    try {
      saved = sessionStorage.getItem(storagePrefix + op);
    } catch {
      /* memory fallback */
    }
    const key = saved && /^[a-f0-9-]{36}$/.test(saved) ? saved : crypto.randomUUID();
    keys.current[op] = key;
    try {
      sessionStorage.setItem(storagePrefix + op, key);
    } catch {
      /* memory fallback */
    }
    return key;
  }
  function clearKey(op: string) {
    delete keys.current[op];
    try {
      sessionStorage.removeItem(storagePrefix + op);
    } catch {
      /* memory fallback */
    }
  }
  async function load(cursor?: string) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError('');
    const n = ++seq.current;
    try {
      const r = await staffRequest<PaymentAttemptLabList>(
        base + query + (cursor ? '&cursor=' + cursor : ''),
      );
      if (n === seq.current)
        setData((old) => (cursor && old ? { ...r, items: [...old.items, ...r.items] } : r));
      if (selected && !cursor) {
        const detail = await staffRequest<PaymentAttemptLabDetail>(
          base + '/' + selected.id + query,
        );
        if (n === seq.current) setSelected(detail);
      }
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '尝试记录读取失败');
    } finally {
      if (n === seq.current) {
        active.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    void load();
    return () => {
      seq.current++;
      active.current = false;
    };
  }, [warehouseId]);
  async function select(id: string) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    setSelected(null);
    const n = ++seq.current;
    try {
      const r = await staffRequest<PaymentAttemptLabDetail>(base + '/' + id + query);
      if (n === seq.current) setSelected(r);
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '详情读取失败');
    } finally {
      if (n === seq.current) {
        active.current = false;
        setBusy(false);
      }
    }
  }
  async function write(action?: string) {
    if (active.current || !data?.enabled || (action && !selected)) return;
    active.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    const n = ++seq.current,
      op = action ? selected!.id + ':' + action : 'create';
    try {
      const r = await staffRequest<PaymentAttemptLabWrite>(
        base + (action ? '/' + selected!.id + '/actions/' + action : '') + query,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
          body: JSON.stringify({ key: keyFor(op) }),
        },
      );
      clearKey(op);
      if (n !== seq.current) return;
      setSelected(r.attempt);
      setMessage(
        r.duplicate
          ? '原操作已记录，返回当前尝试，未重复追加事件。'
          : '合成操作已保存，未调用渠道或改变真实订单。',
      );
      const fresh = await staffRequest<PaymentAttemptLabList>(base + query);
      if (n === seq.current) setData(fresh);
    } catch (e) {
      if (n === seq.current)
        setError(
          (e instanceof Error ? e.message : '结果尚未确认') + '；请刷新查询，或点击原动作重试。',
        );
    } finally {
      if (n === seq.current) {
        active.current = false;
        setBusy(false);
      }
    }
  }
  async function queryAction(retry = false) {
    if (active.current || !data?.enabled || (retry && !selected)) return;
    active.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    const n = ++seq.current,
      op = selected?.id + ':retry-query';
    try {
      await staffRequest(
        base + (retry ? '/' + selected!.id + '/retry-query' : '/run-query-cycle') + query,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
          body: JSON.stringify(retry ? { key: keyFor(op) } : {}),
        },
      );
      if (retry) clearKey(op);
      if (n !== seq.current) return;
      setMessage(
        retry
          ? '合成查询已重新安排，仍未调用真实渠道。'
          : '本仓一轮合成查询已检查，请查看任务状态及历史。',
      );
      if (selected) {
        const detail = await staffRequest<PaymentAttemptLabDetail>(
          base + '/' + selected.id + query,
        );
        if (n === seq.current) setSelected(detail);
      }
      const list = await staffRequest<PaymentAttemptLabList>(base + query);
      if (n === seq.current) setData(list);
    } catch (e) {
      if (n === seq.current)
        setError((e instanceof Error ? e.message : '执行结果未确认') + '；请刷新查询任务状态。');
    } finally {
      if (n === seq.current) {
        active.current = false;
        setBusy(false);
      }
    }
  }

  return (
    <>
      <div className="readiness-heading">
        <div>
          <h2>合成支付尝试</h2>
          <p>先记录尝试，再保存结果；未知和冲突不会被覆盖为失败。</p>
        </div>
        <button className="secondary-button" disabled={busy} onClick={() => void load()}>
          刷新尝试记录
        </button>
      </div>
      {error && (
        <div className="notice task-error" role="alert">
          {error}
          <button className="text-button" disabled={busy} onClick={() => void load()}>
            重试读取尝试
          </button>
        </div>
      )}
      {message && (
        <div className="notice" role="status">
          {message}
        </div>
      )}
      {!data ? (
        <div className="surface empty-state" role="status">
          {busy ? '正在读取合成尝试…' : '记录暂不可用，请重试。'}
        </div>
      ) : (
        <>
          <section className="surface readiness-summary">
            <span className="badge amber">合成材料 · 非真实支付</span>
            <h2>{data.enabled ? '可创建本机合成尝试' : '本机合成尝试尚未开启'}</h2>
            <p>尝试和事件独立持久化。结果只用于处理预案，真实支付、退款与库存操作仍关闭。</p>
            <button
              className="primary-button"
              disabled={busy || !data.enabled}
              onClick={() => void write()}
            >
              {busy ? '正在处理…' : '创建合成尝试'}
            </button>
          </section>
          <section className="surface">
            <div className="service-area-list-heading">
              <h2>尝试历史</h2>
              <small>全部为合成记录</small>
            </div>
            {!data.items.length ? (
              <div className="empty-state">暂无合成支付尝试</div>
            ) : (
              <div className="readiness-checks">
                {data.items.map((row) => (
                  <article className="readiness-check" key={row.id}>
                    <div>
                      <h3>合成尝试 · {row.id.slice(-8)}</h3>
                      <span className={'badge ' + (row.evidence === 'CONFLICT' ? 'red' : 'amber')}>
                        {evidenceLabel[row.evidence]}
                      </span>
                    </div>
                    <p>
                      {new Date(row.createdAt).toLocaleString('zh-CN', {
                        timeZone: 'Asia/Shanghai',
                        hour12: false,
                      })}
                    </p>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => void select(row.id)}
                    >
                      查看尝试
                    </button>
                  </article>
                ))}
              </div>
            )}
            {data.nextCursor && (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => void load(data.nextCursor!)}
              >
                加载更多尝试
              </button>
            )}
          </section>
          {selected && (
            <section className="surface readiness-summary payment-attempt-detail">
              <h2>合成尝试详情</h2>
              <span className={'badge ' + (selected.evidence === 'CONFLICT' ? 'red' : 'amber')}>
                {evidenceLabel[selected.evidence]}
              </span>
              <p>{planLabel[selected.plan] ?? '仅提供核查预案，不执行资金或库存动作。'}</p>
              <p>
                可按不同顺序模拟结果。矛盾证据会保留为冲突，未知结果不会覆盖已知结果。每个尝试最多记录100次结果。
              </p>
              <div className="toolbar">
                {[
                  ['unknown-result', '模拟响应丢失'],
                  ['closed-result', '模拟查单关闭'],
                  ['success-result', '模拟查单成功'],
                ].map(([action, title]) => (
                  <button
                    className="secondary-button"
                    key={action}
                    disabled={busy || !data.enabled || selected.version >= 100}
                    onClick={() => void write(action)}
                  >
                    {title}
                  </button>
                ))}
              </div>
              <section className="readiness-help query-lab-panel">
                <h3>合成查询补偿任务</h3>
                <p>
                  适配器只返回合成未知结果，不访问微信。自动 Worker
                  默认关闭；手动运行只处理本仓一个到期任务，未到期时不会执行。
                </p>
                {selected.queryJob ? (
                  <>
                    <span
                      className={
                        'badge ' + (selected.queryJob.state === 'EXHAUSTED' ? 'red' : 'amber')
                      }
                    >
                      {
                        (
                          {
                            RETRY: '等待到期重试',
                            LEASED: '已领取，租约执行中',
                            DONE: '任务已停止，仍需核对结果',
                            EXHAUSTED: '已耗尽，等待核查',
                          } as Record<string, string>
                        )[selected.queryJob.state]
                      }
                    </span>
                    <p>
                      本轮已领取 {selected.queryJob.attempts} / 3 次；到期时间{' '}
                      {new Date(selected.queryJob.nextRunAt).toLocaleString('zh-CN', {
                        timeZone: 'Asia/Shanghai',
                        hour12: false,
                      })}
                    </p>
                    {selected.queryJob.leaseUntil && (
                      <p>
                        租约截止{' '}
                        {new Date(selected.queryJob.leaseUntil).toLocaleString('zh-CN', {
                          timeZone: 'Asia/Shanghai',
                          hour12: false,
                        })}
                      </p>
                    )}
                  </>
                ) : (
                  <p>尚无查询任务；记录未知结果后会自动安排。</p>
                )}
                <div className="toolbar">
                  <button
                    className="secondary-button"
                    disabled={busy || !data.enabled}
                    onClick={() => void queryAction()}
                  >
                    运行本仓一轮合成查询
                  </button>
                  <button
                    className="secondary-button"
                    disabled={
                      busy ||
                      !data.enabled ||
                      selected.evidence !== 'UNKNOWN' ||
                      selected.queryJob?.state !== 'EXHAUSTED'
                    }
                    onClick={() => void queryAction(true)}
                  >
                    重新安排合成查询
                  </button>
                </div>
                {selected.queryJob && (
                  <>
                    <h3>任务历史（系统合成操作）</h3>
                    <div className="readiness-checks">
                      {selected.queryJob.events.map((e) => (
                        <article className="readiness-check" key={e.id}>
                          <div>
                            <h3>
                              {
                                (
                                  {
                                    SCHEDULED: '已安排查询',
                                    CLAIMED: '已领取任务',
                                    LEASE_RECOVERED: '已回收过期租约',
                                    RETRY_UNKNOWN: '仍未知，已安排重试',
                                    EXHAUSTED_UNKNOWN: '仍未知，本轮已耗尽',
                                    STOPPED_KNOWN: '结果已变化，停止自动查询',
                                    EVENT_LIMIT: '证据记录已达上限，停止查询',
                                    MANUAL_RETRY: '负责人重新安排查询',
                                    LEASE_EXHAUSTED: '租约多次中断，等待核查',
                                  } as Record<string, string>
                                )[e.reason]
                              }
                            </h3>
                          </div>
                          <p>
                            {new Date(e.createdAt).toLocaleString('zh-CN', {
                              timeZone: 'Asia/Shanghai',
                              hour12: false,
                            })}
                          </p>
                        </article>
                      ))}
                    </div>
                  </>
                )}
              </section>
              <h3>不可变事件历史</h3>
              <div className="readiness-checks">
                {selected.events.map((e) => (
                  <article className="readiness-check" key={e.id}>
                    <div>
                      <h3>{actionLabel[e.action]}</h3>
                      <span className="badge">{evidenceLabel[e.evidence]}</span>
                    </div>
                    <p>
                      {new Date(e.createdAt).toLocaleString('zh-CN', {
                        timeZone: 'Asia/Shanghai',
                        hour12: false,
                      })}
                    </p>
                  </article>
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </>
  );
}
