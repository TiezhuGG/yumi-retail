import { useEffect, useRef, useState } from 'react';
import type {
  StaffProfile,
  WarehouseSummary,
  RedemptionDeliveryView,
  RedemptionDeliveryPage,
} from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
const states = {
  UNASSIGNED: '已出库 · 待分配骑手',
  ASSIGNED: '已分配 · 待骑手接货',
  HANDED_OVER: '骑手已接货 · 待开始配送',
  DELIVERING: '骑手配送中',
  DELIVERED: '骑手已确认送达',
};
const blockers: Record<string, string> = {
  WAREHOUSE_PAUSED: '仓库已暂停',
  SOURCE_UNAVAILABLE: '原商品或规格已暂停',
  INVENTORY_HELD: '库存冻结或盘点中',
  ALLOCATION_RELEASED: '原预占被释放',
  LOT_EXPIRED: '原批次已过期',
  LOCATION_DISABLED: '原库位已停用',
  RESERVATION_UNAVAILABLE: '库存或预占需核查',
  POINTS_EVIDENCE_MISSING: '扣积分凭据需核查',
  SHIPMENT_UNVERIFIED: '原出库凭据不完整',
  CONSUMPTION_UNVERIFIED: '出库消费需核查',
  RIDER_UNAVAILABLE: '被分配骑手已停用、撤权或移出本仓',
  DELIVERY_EXCEPTION_OPEN: '配送异常待处理，已暂停继续配送/送达',
  ASSIGNER_UNAVAILABLE: '原分配人已停用、撤权或移出本仓',
};
type Intent = {
  id: string;
  action:
    | 'assign'
    | 'accept'
    | 'start'
    | 'complete'
    | 'exception'
    | 'resolve'
    | 'withdraw'
    | 'return-custody';
  key: string;
  body: Record<string, unknown>;
};
export function RedemptionDeliveryWorkbench({ profile }: { profile: StaffProfile }) {
  const [warehouses, setWarehouses] = useState<WarehouseSummary[]>([]),
    [w, setW] = useState(''),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const seq = useRef(0);
  async function load() {
    const n = ++seq.current;
    setLoading(true);
    setError('');
    try {
      const p = await staffRequest<{ items: WarehouseSummary[] }>('/warehouse/warehouses');
      if (n === seq.current) {
        setWarehouses(p.items);
        setW((old) => (p.items.some((v) => v.id === old) ? old : (p.items[0]?.id ?? '')));
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
    <section aria-label="兑换骑手交接">
      <div className="notice">
        来自已完成实物出库的兑换单。管理人员分配本仓骑手，被分配骑手核对包裹和逐项件数后接货；接货后由本人开始配送、交付全部包裹后确认送达。
      </div>
      {loading && <p role="status">正在读取交接仓库…</p>}
      {error && (
        <p role="alert">
          {error}
          <button className="secondary-button" onClick={() => void load()}>
            重试读取仓库
          </button>
        </p>
      )}
      <label className="readiness-warehouse">
        交接仓库
        <select aria-label="交接仓库" value={w} onChange={(e) => setW(e.target.value)}>
          {warehouses.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </label>
      {!loading && !error && !warehouses.length && <p>暂无授权交接仓库</p>}
      {w && <DeliveryPanel key={profile.id + ':' + w} profile={profile} w={w} />}
    </section>
  );
}
function DeliveryPanel({ profile, w }: { profile: StaffProfile; w: string }) {
  const [items, setItems] = useState<RedemptionDeliveryView[]>([]),
    [detail, setDetail] = useState<RedemptionDeliveryView | null>(null),
    [cursor, setCursor] = useState<string | null>(null),
    [status, setStatus] = useState(''),
    [enabled, setEnabled] = useState(false),
    [selfOnly, setSelfOnly] = useState(true),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [intent, setIntent] = useState<Intent | null>(null),
    [corrupt, setCorrupt] = useState(false),
    [riders, setRiders] = useState<Array<{ id: string; displayName: string }>>([]),
    [riderError, setRiderError] = useState(''),
    [riderLoading, setRiderLoading] = useState(false);
  const seq = useRef(0),
    riderSeq = useRef(0),
    writing = useRef(false),
    applied = useRef(''),
    last = useRef<{ id?: string; cursor?: string }>({});
  const base = '/warehouse/warehouses/' + w + '/redemption-delivery',
    storage = 'yumi.redemption-delivery.v1:' + profile.id + ':' + w,
    manage = profile.permissions.includes('redemption-delivery.assign');
  function stored() {
    const raw = sessionStorage.getItem(storage);
    if (!raw) return null;
    const v = JSON.parse(raw) as Intent;
    if (
      !/^[a-f0-9-]{36}$/i.test(v.id) ||
      !/^[a-f0-9-]{36}$/i.test(v.key) ||
      ![
        'assign',
        'accept',
        'start',
        'complete',
        'exception',
        'resolve',
        'withdraw',
        'return-custody',
      ].includes(v.action) ||
      !v.body ||
      typeof v.body !== 'object' ||
      Array.isArray(v.body)
    )
      throw Error('原交接操作记录无法读取，请保留并核实');
    return v;
  }
  async function load(target: { id?: string; cursor?: string } = {}) {
    const n = ++seq.current;
    last.current = target;
    setLoading(true);
    setError('');
    try {
      const q = new URLSearchParams();
      if (applied.current) q.set('status', applied.current);
      if (target.cursor) q.set('cursor', target.cursor);
      const p = await staffRequest<RedemptionDeliveryPage>(
        base + (target.id ? '/' + target.id : '?' + q),
      );
      if (n !== seq.current) return;
      setEnabled(p.enabled);
      setSelfOnly(p.selfOnly);
      if (target.id) setDetail(p.items[0] ?? null);
      else {
        setItems((old) => (target.cursor ? [...old, ...p.items] : p.items));
        setCursor(p.nextCursor);
        setDetail(null);
      }
    } catch (e) {
      if (n === seq.current) {
        setError(e instanceof Error ? e.message : '交接读取失败');
        if (e instanceof StaffRequestError && [401, 403, 404].includes(e.status)) {
          setItems([]);
          setDetail(null);
          setRiders([]);
        }
      }
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }
  async function loadRiders() {
    const n = ++riderSeq.current;
    setRiderLoading(true);
    setRiderError('');
    try {
      const p = await staffRequest<{ items: Array<{ id: string; displayName: string }> }>(
        base + '/riders',
      );
      if (n === riderSeq.current) setRiders(p.items);
    } catch (e) {
      if (n === riderSeq.current) {
        setRiders([]);
        setRiderError(e instanceof Error ? e.message : '骑手读取失败');
      }
    } finally {
      if (n === riderSeq.current) setRiderLoading(false);
    }
  }
  useEffect(() => {
    try {
      const v = stored();
      setIntent(v);
      void load(v ? { id: v.id } : {});
      if (manage) void loadRiders();
    } catch (e) {
      setCorrupt(true);
      setError(e instanceof Error ? e.message : '原操作无法读取');
      setLoading(false);
    }
    return () => {
      seq.current++;
      riderSeq.current++;
    };
  }, []);
  async function write(action: Intent['action'], body: Record<string, unknown> = {}) {
    if (writing.current || corrupt || !detail) return;
    writing.current = true;
    setBusy(true);
    setError('');
    const n = seq.current;
    try {
      const v = stored() ?? { id: detail.id, action, key: crypto.randomUUID(), body };
      sessionStorage.setItem(storage, JSON.stringify(v));
      setIntent(v);
      await staffRequest(base + '/' + v.id + '/' + v.action, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': profile.csrfToken,
          'Idempotency-Key': v.key,
        },
        body: JSON.stringify(v.body),
      });
      sessionStorage.removeItem(storage);
      if (n !== seq.current) return;
      setIntent(null);
      await load({ id: v.id });
    } catch (e) {
      if (n === seq.current) {
        if (e instanceof StaffRequestError && e.status < 500) {
          sessionStorage.removeItem(storage);
          setIntent(null);
        }
        setError(e instanceof Error ? e.message : '交接结果未知，请使用原请求核实');
        if (e instanceof StaffRequestError && [401, 403, 404].includes(e.status)) {
          setItems([]);
          setDetail(null);
          setRiders([]);
        }
      }
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  const disabled = busy || loading || !!intent || !enabled || corrupt;
  return (
    <div className="redemption-delivery-panel">
      <div className="points-toolbar">
        <label>
          交接状态
          <select
            aria-label="交接状态"
            value={status}
            disabled={busy || !!intent}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">全部交接</option>
            {Object.entries(states).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button
          className="secondary-button"
          disabled={busy || loading || !!intent}
          onClick={() => {
            applied.current = status;
            void load();
          }}
        >
          查询交接单
        </button>
        <button
          className="secondary-button"
          disabled={busy || loading}
          onClick={() => void load(detail ? { id: detail.id } : {})}
        >
          刷新交接
        </button>
      </div>
      {!enabled && !loading && <p className="notice">交接写入尚未启用，当前只读。</p>}
      {selfOnly && <p className="muted">仅显示分配给本人的兑换出库单。</p>}
      {loading && <p role="status">正在核实兑换交接…</p>}
      {error && (
        <div className="notice task-error" role="alert">
          {error}
          <button
            className="secondary-button"
            disabled={busy || loading}
            onClick={() => void load(last.current)}
          >
            重试读取交接
          </button>
        </div>
      )}
      {detail ? (
        <div className="reward-detail">
          <button
            className="secondary-button"
            disabled={busy || !!intent}
            onClick={() => void load()}
          >
            返回交接列表
          </button>
          <h2>{detail.title}</h2>
          <p>
            {detail.spec} · {detail.quantity} 件 · {detail.packageCount} 个包裹
          </p>
          <p className="redemption-order-no">兑换单号：{detail.orderNo}</p>
          <p className="delivery-state">
            {detail.exception && !detail.exception.resolution
              ? '配送异常待处理'
              : states[detail.state]}
          </p>
          <h3>按原出库实物核对</h3>
          {detail.lines.map((l) => (
            <article className="picking-allocation" key={l.allocationId}>
              <strong>
                {l.batchNo} · {l.quantity} 件
              </strong>
              <p>
                {l.locationName}（{l.locationCode}）
              </p>
              <p>
                {l.expiresAt
                  ? '到期：' +
                    new Date(l.expiresAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) +
                    '（北京时间）'
                  : '此批次未设效期'}
              </p>
            </article>
          ))}
          {!!detail.readiness.blockers.length && (
            <p className="notice task-error">
              {detail.readiness.blockers.map((v) => blockers[v] ?? v).join('；')}
            </p>
          )}
          {intent ? (
            <button
              className="primary-button"
              disabled={busy || corrupt}
              onClick={() => void write(intent.action)}
            >
              {busy
                ? '正在核实…'
                : '使用原请求核实' +
                  {
                    assign: '分配',
                    accept: '接货',
                    start: '开始配送',
                    complete: '送达',
                    exception: '上报异常',
                    resolve: '处置异常',
                    withdraw: '撤回分配',
                    'return-custody': '实物回交',
                  }[intent.action]}
            </button>
          ) : (
            <>
              {manage && ['HANDED_OVER', 'DELIVERING'].includes(detail.state) && (
                <CustodyReturnForm
                  key={detail.handoff!.id}
                  detail={detail}
                  disabled={disabled}
                  write={write}
                />
              )}
              {manage && detail.state === 'ASSIGNED' && (
                <WithdrawForm
                  key={detail.assignment!.id}
                  detail={detail}
                  disabled={disabled}
                  write={write}
                />
              )}
              {manage && detail.state === 'UNASSIGNED' && (
                <>
                  <button
                    className="secondary-button"
                    disabled={riderLoading || busy}
                    onClick={() => void loadRiders()}
                  >
                    刷新本仓骑手
                  </button>
                  {riderLoading && <p>正在读取本仓骑手…</p>}
                  {riderError && <p role="alert">{riderError}</p>}
                  {!riderLoading && !riderError && !riders.length && (
                    <p>暂无有效本仓骑手，请先核实人员角色和仓库授权。</p>
                  )}
                  <AssignForm
                    key={detail.id}
                    riders={riders}
                    disabled={disabled || riderLoading || !!riderError || !detail.readiness.ready}
                    write={write}
                  />
                </>
              )}
              {detail.state === 'ASSIGNED' &&
                detail.assignment?.riderId === profile.id &&
                profile.permissions.includes('redemption-delivery.accept') && (
                  <AcceptForm
                    key={detail.assignment.id}
                    detail={detail}
                    disabled={disabled || !detail.readiness.ready}
                    write={write}
                  />
                )}
              {['HANDED_OVER', 'DELIVERING'].includes(detail.state) &&
                detail.assignment?.riderId === profile.id &&
                profile.permissions.includes('redemption-delivery.work') && (
                  <JourneyForm
                    key={detail.state + detail.id}
                    detail={detail}
                    disabled={
                      disabled ||
                      (detail.state === 'HANDED_OVER' ? !detail.canStart : !detail.canComplete)
                    }
                    write={write}
                  />
                )}
            </>
          )}
          {detail.state === 'ASSIGNED' && detail.assignment?.riderId !== profile.id && (
            <p className="notice">等待被分配骑手本人核对接货，管理人员不能代接。</p>
          )}
          {detail.exception && !detail.exception.resolution && (
            <div className="notice task-error" role="alert">
              配送异常待处理：{detail.exception.reason}（
              {new Date(detail.exception.createdAt).toLocaleString('zh-CN', {
                timeZone: 'Asia/Shanghai',
              })}
              ）。请联系本仓负责人核查；恢复不改变原骑手或原收货地址。
            </div>
          )}
          {(!detail.exception || !!detail.exception.resolution) &&
            detail.handoff &&
            !detail.journey.completion &&
            detail.assignment?.riderId === profile.id &&
            profile.permissions.includes('redemption-delivery.work') && (
              <DeliveryExceptionForm detail={detail} disabled={disabled} write={write} />
            )}
          {!detail.exception && detail.state === 'HANDED_OVER' && (
            <p className="notice">骑手已核对接货，等待开始配送。本次接货没有再次扣减库存或积分。</p>
          )}
          {!detail.exception && detail.state === 'DELIVERING' && (
            <p className="notice">骑手配送中，请按原收货地址交付全部包裹后确认送达。</p>
          )}
          {manage && detail.returnHistory.length > 0 && (
            <section className="picking-pack-proof">
              <h3>实物回交与保管记录</h3>
              {detail.returnHistory.map((x) => (
                <div key={x.id}>
                  <p>
                    原骑手：{x.riderName} · {x.hadStarted ? '曾开始配送' : '接货后未开始配送'} ·
                    已回交仓库
                  </p>
                  <p>
                    接收人：{x.actorName} · {x.reason} ·{' '}
                    {new Date(x.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                  </p>
                  {x.exceptions.map((e, i) => (
                    <p key={i}>
                      原异常：{e.reason} ·{' '}
                      {e.resolved ? '此前已处置' : '随本次回交终止原配送，原异常保留'}
                    </p>
                  ))}
                </div>
              ))}
              <p>仅保管回交，未增加可售库存或退积分；重新分配仍须通过当前资格核验。</p>
            </section>
          )}
          {manage && detail.assignmentHistory.some((x) => x.withdrawal || x.returned) && (
            <section className="detail-card">
              <h3>分配与撤回记录</h3>
              {detail.assignmentHistory.map((x) => (
                <p key={x.id}>
                  分配给{x.riderName} · 分配人：{x.actorName} ·{' '}
                  {new Date(x.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                  {x.withdrawal ? (
                    <>
                      {' '}
                      · 已撤回：{x.withdrawal.actorName} · {x.withdrawal.reason} ·{' '}
                      {new Date(x.withdrawal.createdAt).toLocaleString('zh-CN', {
                        timeZone: 'Asia/Shanghai',
                      })}
                    </>
                  ) : x.returned ? (
                    ' · 实物已回交，本次分配结束'
                  ) : (
                    ' · 当前有效'
                  )}
                </p>
              ))}
            </section>
          )}
          {detail.exception && !detail.exception.resolution && manage && (
            <DeliveryResolutionForm detail={detail} disabled={disabled} write={write} />
          )}
          {detail.exceptionHistory.some((e) => e.resolution) && (
            <section className="picking-pack-proof">
              <h3>配送异常处置记录</h3>
              {detail.exceptionHistory.map((e) => (
                <article key={e.id}>
                  <p>原异常：{e.reason}</p>
                  {e.resolution ? (
                    <p>
                      处置人：{e.resolution.actorName} · {e.resolution.reason} ·{' '}
                      {new Date(e.resolution.createdAt).toLocaleString('zh-CN', {
                        timeZone: 'Asia/Shanghai',
                      })}
                      （北京时间）。允许原骑手继续，仍须满足当前资格。
                    </p>
                  ) : (
                    <p>待处置</p>
                  )}
                </article>
              ))}
            </section>
          )}
          {detail.state === 'DELIVERED' && (
            <p className="notice">
              骑手已确认全部包裹交付原收货人。此记录为骑手声明，不代表收货人独立确认。
            </p>
          )}
          {detail.address && (
            <section className="picking-pack-proof">
              <h3>收货地址快照</h3>
              <p>
                {detail.address.areaName} {detail.address.buildingName} {detail.address.unit}{' '}
                {detail.address.room}
              </p>
              <p>
                {detail.address.contactName} · {detail.address.phone}
              </p>
              {detail.address.note && <p>{detail.address.note}</p>}
              {detail.address.orderNote && <p>{detail.address.orderNote}</p>}
            </section>
          )}
          <details className="picking-pack-proof">
            <summary>出库与交接记录</summary>
            <p>
              仓库出库：
              {new Date(detail.shippedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
              （北京时间）
            </p>
            {detail.assignment && (
              <p>
                分配骑手：{detail.assignment.riderName} · 分配人：{detail.assignment.actorName} ·{' '}
                {new Date(detail.assignment.createdAt).toLocaleString('zh-CN', {
                  timeZone: 'Asia/Shanghai',
                })}
                （北京时间）
              </p>
            )}
            {detail.handoff && (
              <p>
                本人接货：{detail.handoff.packageCount} 个包裹 ·{' '}
                {new Date(detail.handoff.createdAt).toLocaleString('zh-CN', {
                  timeZone: 'Asia/Shanghai',
                })}
                （北京时间）
              </p>
            )}
            {detail.journey.start && (
              <p>
                本人开始配送：
                {new Date(detail.journey.start.createdAt).toLocaleString('zh-CN', {
                  timeZone: 'Asia/Shanghai',
                })}
                （北京时间）
              </p>
            )}
            {detail.journey.completion && (
              <p>
                本人确认送达：
                {new Date(detail.journey.completion.createdAt).toLocaleString('zh-CN', {
                  timeZone: 'Asia/Shanghai',
                })}
                （北京时间）
              </p>
            )}
          </details>
        </div>
      ) : (
        <>
          {!loading && !error && !items.length && (
            <div className="points-empty">暂无匹配的兑换交接单</div>
          )}
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>兑换商品 / 规格</th>
                  <th>件数</th>
                  <th>包裹</th>
                  <th>骑手</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {items.map((v) => (
                  <tr key={v.id}>
                    <td>
                      <strong>{v.title}</strong>
                      <small>{v.spec}</small>
                    </td>
                    <td>{v.quantity}</td>
                    <td>{v.packageCount}</td>
                    <td>{v.assignment?.riderName ?? '—'}</td>
                    <td>
                      <span className="badge amber">{states[v.state]}</span>
                      {v.exception && !v.exception.resolution && <small>配送异常待处理</small>}
                    </td>
                    <td>
                      <button
                        className="secondary-button"
                        disabled={busy || !!intent}
                        onClick={() => void load({ id: v.id })}
                      >
                        查看交接详情
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {cursor && !error && (
            <button
              className="secondary-button"
              disabled={busy || loading || !!intent}
              onClick={() => void load({ cursor })}
            >
              加载更多交接
            </button>
          )}
        </>
      )}
    </div>
  );
}
function AssignForm({
  riders,
  disabled,
  write,
}: {
  riders: Array<{ id: string; displayName: string }>;
  disabled: boolean;
  write: (action: Intent['action'], body: Record<string, unknown>) => Promise<void>;
}) {
  const [rider, setRider] = useState('');
  return (
    <form
      className="picking-pack-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (riders.some((v) => v.id === rider)) void write('assign', { riderId: rider });
      }}
    >
      <h3>分配本仓骑手</h3>
      <label>
        接货骑手
        <select
          aria-label="接货骑手"
          disabled={disabled}
          value={rider}
          onChange={(e) => setRider(e.target.value)}
        >
          <option value="">请选择骑手</option>
          {riders.map((v) => (
            <option key={v.id} value={v.id}>
              {v.displayName}
            </option>
          ))}
        </select>
      </label>
      <p>提交后保留分配凭据。尚未接货可由管理人员先撤回再重新分配；接货须由当前骑手本人完成。</p>
      <button className="primary-button" disabled={disabled || !riders.some((v) => v.id === rider)}>
        确认分配骑手
      </button>
    </form>
  );
}
function AcceptForm({
  detail,
  disabled,
  write,
}: {
  detail: RedemptionDeliveryView;
  disabled: boolean;
  write: (action: Intent['action'], body: Record<string, unknown>) => Promise<void>;
}) {
  const [count, setCount] = useState(''),
    [quantities, setQuantities] = useState<Record<string, string>>({}),
    [confirmed, setConfirmed] = useState(false);
  const valid =
    /^[1-9]\d*$/.test(count) &&
    Number(count) === detail.packageCount &&
    detail.lines.every(
      (l) =>
        /^[1-9]\d*$/.test(quantities[l.allocationId] ?? '') &&
        Number(quantities[l.allocationId]) === l.quantity,
    ) &&
    confirmed;
  return (
    <form
      className="picking-pack-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid)
          void write('accept', {
            assignmentId: detail.assignment!.id,
            packageCount: Number(count),
            lines: detail.lines.map((l) => ({
              allocationId: l.allocationId,
              quantity: Number(quantities[l.allocationId]),
            })),
            physicalConfirmed: true,
          });
      }}
    >
      <h3>本人核对接货</h3>
      <label>
        实际接货包裹数
        <input
          aria-label="实际接货包裹数"
          type="number"
          min="1"
          max={detail.packageCount}
          step="1"
          value={count}
          disabled={disabled}
          onChange={(e) => setCount(e.target.value)}
        />
      </label>
      {detail.lines.map((l) => (
        <label key={l.allocationId}>
          {l.batchNo} · 应接 {l.quantity} 件
          <input
            aria-label={'接货件数 ' + l.batchNo + ' ' + l.locationCode}
            type="number"
            min="1"
            max={l.quantity}
            step="1"
            value={quantities[l.allocationId] ?? ''}
            disabled={disabled}
            onChange={(e) => setQuantities((old) => ({ ...old, [l.allocationId]: e.target.value }))}
          />
        </label>
      ))}
      <label className="picking-physical">
        <input
          type="checkbox"
          disabled={disabled}
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        已核验包裹及每项实物，确认本人接货
      </label>
      <p>实物、数量或包裹不符时请停止接货并联系仓管核查。</p>
      <button className="primary-button" disabled={disabled || !valid}>
        确认本人接货
      </button>
    </form>
  );
}

function JourneyForm({
  detail,
  disabled,
  write,
}: {
  detail: RedemptionDeliveryView;
  disabled: boolean;
  write: (action: Intent['action'], body: Record<string, unknown>) => Promise<void>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const start = detail.state === 'HANDED_OVER';
  return (
    <form
      className="picking-pack-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (confirmed)
          void write(
            start ? 'start' : 'complete',
            start
              ? { handoffId: detail.handoff!.id, departureConfirmed: true }
              : { startId: detail.journey.start!.id, deliveryConfirmed: true },
          );
      }}
    >
      <h3>{start ? '本人开始配送' : '本人确认送达'}</h3>
      <label className="picking-physical">
        <input
          type="checkbox"
          checked={confirmed}
          disabled={disabled}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        {start ? '已携带本单全部包裹，确认实际出发配送' : '已按原收货地址将全部包裹交付收货人'}
      </label>
      <p>
        {start
          ? '请在实际出发时操作，开始记录不能撤回。'
          : '无法交付或存在异常时请联系仓管核查，不要确认送达。此记录为骑手本人声明。'}
      </p>
      <button className="primary-button" disabled={disabled || !confirmed}>
        {start ? '确认开始配送' : '确认全部送达'}
      </button>
    </form>
  );
}

function DeliveryExceptionForm({
  detail,
  disabled,
  write,
}: {
  detail: RedemptionDeliveryView;
  disabled: boolean;
  write: (action: Intent['action'], body: Record<string, unknown>) => Promise<void>;
}) {
  const [kind, setKind] = useState('CONTACT_FAILED'),
    [reason, setReason] = useState('');
  return (
    <form
      className="picking-check-form delivery-exception-form"
      onSubmit={(e) => {
        e.preventDefault();
        void write('exception', { handoffId: detail.handoff!.id, kind, reason });
      }}
    >
      <h3>上报配送异常</h3>
      <label>
        异常类型
        <select
          aria-label="异常类型"
          value={kind}
          disabled={disabled}
          onChange={(e) => setKind(e.target.value)}
        >
          <option value="CONTACT_FAILED">无法联系</option>
          <option value="ADDRESS_ISSUE">地址异常</option>
          <option value="DAMAGED">包裹破损</option>
          <option value="REFUSED">收货人拒收</option>
          <option value="OTHER">其他</option>
        </select>
      </label>
      <label>
        异常说明
        <textarea
          aria-label="异常说明"
          maxLength={300}
          value={reason}
          disabled={disabled}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <p>提交后暂停继续配送和确认送达，请联系负责人核查。</p>
      <button className="secondary-button" disabled={disabled || !reason.trim()}>
        提交配送异常
      </button>
    </form>
  );
}

function DeliveryResolutionForm({
  detail,
  disabled,
  write,
}: {
  detail: RedemptionDeliveryView;
  disabled: boolean;
  write: (action: Intent['action'], body: Record<string, unknown>) => Promise<void>;
}) {
  const [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const blocked = detail.readiness.blockers.some((x) => x !== 'DELIVERY_EXCEPTION_OPEN');
  return (
    <form
      className="picking-check-form delivery-exception-form"
      onSubmit={(e) => {
        e.preventDefault();
        void write('resolve', {
          exceptionId: detail.exception!.id,
          reason,
          continuationConfirmed: confirmed,
        });
      }}
    >
      <h3>处置异常并允许继续配送</h3>
      <label>
        处置说明
        <textarea
          aria-label="处置说明"
          maxLength={300}
          disabled={disabled}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <label>
        <input
          type="checkbox"
          disabled={disabled}
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        已核实异常已处理、包裹及原地址可由原骑手继续配送
      </label>
      <p>不改变原骑手、收货地址、库存或积分；原异常记录保留。</p>
      <button
        className="primary-button"
        disabled={disabled || blocked || !reason.trim() || !confirmed}
      >
        确认处置并允许继续
      </button>
    </form>
  );
}

function WithdrawForm({
  detail,
  disabled,
  write,
}: {
  detail: RedemptionDeliveryView;
  disabled: boolean;
  write: (action: Intent['action'], body: Record<string, unknown>) => Promise<void>;
}) {
  const [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  return (
    <form
      className="delivery-exception-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (reason.trim() && confirmed)
          void write('withdraw', {
            assignmentId: detail.assignment!.id,
            reason: reason.trim(),
            warehouseCustodyConfirmed: true,
          });
      }}
    >
      <h3>撤回未接货分配</h3>
      <p>
        当前骑手：{detail.assignment!.riderName}
        。撤回后旧骑手将失去本单访问和接货权限，原凭据保留；可再选择有效本仓骑手分配。货品异常仍会阻断新分配。
      </p>
      <label>
        撤回原因
        <textarea
          aria-label="撤回原因"
          maxLength={300}
          value={reason}
          disabled={disabled}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <label>
        <input
          type="checkbox"
          disabled={disabled}
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        已核实骑手尚未接货，全部包裹仍由仓库保管
      </label>
      <button className="primary-button" disabled={disabled || !reason.trim() || !confirmed}>
        确认撤回分配
      </button>
    </form>
  );
}

function CustodyReturnForm({
  detail,
  disabled,
  write,
}: {
  detail: RedemptionDeliveryView;
  disabled: boolean;
  write: (action: Intent['action'], body: Record<string, unknown>) => Promise<void>;
}) {
  const [count, setCount] = useState(''),
    [quantities, setQuantities] = useState<Record<string, string>>({}),
    [confirmed, setConfirmed] = useState(false),
    [reason, setReason] = useState(''),
    [redispatch, setRedispatch] = useState(false);
  const valid =
    /^[1-9]\d*$/.test(count) &&
    Number(count) === detail.packageCount &&
    detail.lines.every(
      (l) =>
        /^[1-9]\d*$/.test(quantities[l.allocationId] ?? '') &&
        Number(quantities[l.allocationId]) === l.quantity,
    ) &&
    confirmed &&
    redispatch &&
    !!reason.trim();
  return (
    <form
      className="picking-pack-form delivery-exception-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid)
          void write('return-custody', {
            handoffId: detail.handoff!.id,
            reason: reason.trim(),
            packageCount: Number(count),
            lines: detail.lines.map((l) => ({
              allocationId: l.allocationId,
              quantity: Number(quantities[l.allocationId]),
            })),
            intactCustodyConfirmed: true,
            redispatchConfirmed: true,
          });
      }}
    >
      <h3>核验整单实物回交</h3>
      <p>
        须先从原骑手收回原单全部包裹，逐项核对完整完好；回交后原配送结束，旧骑手失去本单操作权限。冻结等仍会阻断重新分配。部分、破损或已送达不能使用此流程。
      </p>
      <label>
        回交原因
        <textarea
          aria-label="回交原因"
          maxLength={300}
          disabled={disabled}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <label>
        实际回交包裹数
        <input
          aria-label="实际回交包裹数"
          type="number"
          min="1"
          max={detail.packageCount}
          step="1"
          value={count}
          disabled={disabled}
          onChange={(e) => setCount(e.target.value)}
        />
      </label>
      {detail.lines.map((l) => (
        <label key={l.allocationId}>
          {l.batchNo} · 应回交 {l.quantity} 件
          <input
            aria-label={'回交件数 ' + l.batchNo + ' ' + l.locationCode}
            type="number"
            min="1"
            max={l.quantity}
            step="1"
            value={quantities[l.allocationId] ?? ''}
            disabled={disabled}
            onChange={(e) => setQuantities((old) => ({ ...old, [l.allocationId]: e.target.value }))}
          />
        </label>
      ))}
      <label className="picking-physical">
        <input
          type="checkbox"
          disabled={disabled}
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        已收到原单全部包裹，逐项完整完好，可重新安排配送
      </label>
      <p>
        回交确认由本仓管理人员声明，不会回补库存或退积分。原异常保留，回交终止原配送，不冒充异常恢复凭据。
      </p>
      <label className="picking-physical">
        <input
          type="checkbox"
          disabled={disabled}
          checked={redispatch}
          onChange={(e) => setRedispatch(e.target.checked)}
        />
        已核验原地址及异常情况，可重新安排配送
      </label>
      <button className="primary-button" disabled={disabled || !valid}>
        确认完整回交仓库
      </button>
    </form>
  );
}
