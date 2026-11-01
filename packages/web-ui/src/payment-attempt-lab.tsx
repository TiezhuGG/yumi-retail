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
  UNKNOWN_RESULT: '已记录未知结果',
  CLOSED_RESULT: '已记录合成关闭证据',
  SUCCESS_RESULT: '已记录合成成功证据',
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
    [message, setMessage] = useState(''),
    [scenario, setScenario] = useState('NOTPAY');
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
      const response = await staffRequest<{ processed?: boolean }>(
        base + (retry ? '/' + selected!.id + '/retry-query' : '/run-query-cycle') + query,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
          body: JSON.stringify(retry ? { key: keyFor(op) } : { scenario }),
        },
      );
      if (retry) clearKey(op);
      if (n !== seq.current) return;
      setMessage(
        retry
          ? '合成查询已重新安排，仍未调用真实渠道。'
          : response.processed
            ? '本仓一轮合成查询已处理，请查看任务状态及分类历史。'
            : '本仓暂无可领取的到期查询；请刷新查看，待核查任务不会自动领取。',
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
                  适配器只使用固定内存场景，不访问微信。自动 Worker
                  默认关闭且启用时使用“未支付”合成场景；手动运行处理本仓下一个到期任务，可能是其他尝试，未到期时不执行。待人工核查后停止自动领取，备注不恢复查询。
                </p>
                {selected.queryJob ? (
                  <>
                    <span
                      className={
                        'badge ' +
                        (['EXHAUSTED', 'REVIEW'].includes(selected.queryJob.state)
                          ? 'red'
                          : 'amber')
                      }
                    >
                      {
                        (
                          {
                            RETRY: '等待到期重试',
                            LEASED: '已领取，租约执行中',
                            DONE: '任务已停止，仍需核对结果',
                            EXHAUSTED: '已耗尽，等待核查',
                            REVIEW: '待人工核查，自动查询已停止',
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
                <label className="query-scenario">
                  下一轮合成查询场景
                  <select
                    aria-label="下一轮合成查询场景"
                    value={scenario}
                    disabled={busy || !data.enabled}
                    onChange={(e) => setScenario(e.target.value)}
                  >
                    {data.queryScenarios.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.title}
                      </option>
                    ))}
                  </select>
                </label>
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
                                    NOTIFICATION_EVIDENCE: '收到合成通知证据，已停止或转核查',
                                    REVIEW_REQUIRED: '已停止查询，转人工核查',
                                    CLASSIFIED_KNOWN: '已记录合成已知证据，等待事务核对',
                                  } as Record<string, string>
                                )[e.reason]
                              }
                            </h3>
                          </div>
                          {e.classification ? (
                            <p>
                              分类：{e.classification} · 场景：{e.scenario}
                              <br />
                              查询证据：{evidenceLabel[e.resultEvidence ?? 'UNKNOWN']} · 建议：
                              {e.next === 'RETRY'
                                ? '继续查单'
                                : e.next === 'REVIEW'
                                  ? '人工核查'
                                  : '事务核对'}
                              ；冲突证据优先人工核查。
                            </p>
                          ) : (
                            <p>本事件不含查询响应。</p>
                          )}
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
              <section className="readiness-help notification-binding-panel">
                <h3>合成通知关联</h3>
                {selected.notificationBinding ? (
                  <>
                    <p>
                      固定测试金额 ¥{(selected.notificationBinding.amountCents / 100).toFixed(2)}{' '}
                      {selected.notificationBinding.currency}，仅供通知核验，不是订单应付。
                    </p>
                    <p className="binding-number">
                      测试商户单号：{selected.notificationBinding.outTradeNo}
                    </p>
                    <p>
                      在“通知记录”选择本次合成尝试生成通知。下方显示最近20条关联通知；多条通知可共用同一条成功证据，冲突不会覆盖。
                    </p>
                    {selected.notifications.length ? (
                      <div className="readiness-checks">
                        {selected.notifications.map((n) => (
                          <article className="readiness-check" key={n.id}>
                            <h3>已关联通知 · {n.notificationId.slice(-8)}</h3>
                            <p>
                              {new Date(n.createdAt).toLocaleString('zh-CN', {
                                timeZone: 'Asia/Shanghai',
                                hour12: false,
                              })}
                            </p>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <p>暂无关联通知</p>
                    )}
                  </>
                ) : (
                  <p>旧合成尝试没有通知绑定，请新建合成尝试后验证；历史不自动补造绑定。</p>
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
