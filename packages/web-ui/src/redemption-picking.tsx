import { useEffect, useRef, useState } from 'react';
import type {
  StaffProfile,
  WarehouseSummary,
  RedemptionPickingView,
  RedemptionPickingPage,
} from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
const states: Record<string, string> = {
  PENDING: '待建拣货任务',
  LEASED: '正在创建任务',
  RETRY: '等待自动重试',
  FAILED: '建任务失败 · 待核查',
  READY: '待领取',
  CLAIMED: '已领取 · 待逐项核对',
  CANCELED: '已取消',
  CHECKED: '拣货完成 · 待打包',
};
const reasons: Record<string, string> = {
  WAREHOUSE_PAUSED: '仓库暂停',
  SOURCE_UNAVAILABLE: '商品或规格暂停',
  RESERVATION_UNAVAILABLE: '实物预占或批次资格异常',
  PROCESSING_FAILED: '处理失败，待重试',
  LEASE_EXHAUSTED: '处理租约连续过期',
  ORDER_CANCELED: '兑换已取消',
  INVENTORY_HELD: '库存冻结或预占不足',
  ALLOCATION_RELEASED: '预占已释放',
  LOCATION_DISABLED: '库位停用',
  LOT_EXPIRED: '批次已过期',
  ALLOCATION_INCOMPLETE: '预占件数不完整',
  POINTS_EVIDENCE_MISSING: '积分扣除证据异常',
};
type Action = 'claim' | 'retry' | 'check' | 'report' | 'resolve' | 'complete';
type Intent = {
  id: string;
  action: Action;
  key: string;
  version: number;
  body?: Record<string, unknown>;
};
export function RedemptionPickingWorkbench({ profile }: { profile: StaffProfile }) {
  const [warehouses, setWarehouses] = useState<WarehouseSummary[]>([]),
    [w, setW] = useState(''),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const rootSeq = useRef(0);
  async function loadWarehouses() {
    const n = ++rootSeq.current;
    setLoading(true);
    setError('');
    try {
      const p = await staffRequest<{ items: WarehouseSummary[] }>('/warehouse/warehouses');
      if (n === rootSeq.current) {
        setWarehouses(p.items);
        setW((old) => (p.items.some((v) => v.id === old) ? old : (p.items[0]?.id ?? '')));
      }
    } catch (e) {
      if (n === rootSeq.current) setError(e instanceof Error ? e.message : '仓库读取失败');
    } finally {
      if (n === rootSeq.current) setLoading(false);
    }
  }
  useEffect(() => {
    void loadWarehouses();
    return () => {
      rootSeq.current++;
    };
  }, []);
  return (
    <section aria-label="兑换拣货作业">
      <div className="notice">
        来自已扣积分、已预占实物的兑换单。领取后按原预占批次和库位核对。缺货或破损须上报，仓管确认原需求备齐后重新核对；完成拣货后等待打包。
      </div>
      {error && (
        <p role="alert">
          {error}
          <button
            className="secondary-button"
            disabled={loading}
            onClick={() => void loadWarehouses()}
          >
            重试读取仓库
          </button>
        </p>
      )}
      <label className="readiness-warehouse">
        作业仓库
        <select aria-label="作业仓库" value={w} onChange={(e) => setW(e.target.value)}>
          {warehouses.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
      </label>
      {loading && <p role="status">正在读取授权仓库…</p>}
      {!loading && !error && !warehouses.length && <p>暂无授权仓库</p>}
      {w && <PickingPanel key={profile.id + ':' + w} profile={profile} w={w} />}
    </section>
  );
}
function PickingPanel({ profile, w }: { profile: StaffProfile; w: string }) {
  const [items, setItems] = useState<RedemptionPickingView[]>([]),
    [detail, setDetail] = useState<RedemptionPickingView | null>(null),
    [status, setStatus] = useState(''),
    [mine, setMine] = useState(false),
    [cursor, setCursor] = useState<string | null>(null),
    [enabled, setEnabled] = useState(false),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [intent, setIntent] = useState<Intent | null>(null),
    [corrupt, setCorrupt] = useState(false);
  const seq = useRef(0),
    applied = useRef({ status: '', mine: false }),
    last = useRef<{ id?: string; cursor?: string }>({}),
    writing = useRef(false);
  const base = '/warehouse/warehouses/' + w + '/redemption-picking',
    storage = 'yumi.redemption-picking.v1:' + profile.id + ':' + w;
  function stored() {
    const raw = sessionStorage.getItem(storage);
    if (!raw) return null;
    const v = JSON.parse(raw) as Intent;
    if (
      !/^[a-f0-9-]{36}$/i.test(v.id) ||
      !/^[a-f0-9-]{36}$/i.test(v.key) ||
      !['claim', 'retry', 'check', 'report', 'resolve', 'complete'].includes(v.action) ||
      !Number.isInteger(v.version)
    )
      throw Error('原作业操作记录无法读取，请保留并核实');
    return v;
  }
  async function load(target: { id?: string; cursor?: string } = {}) {
    const n = ++seq.current;
    last.current = target;
    setLoading(true);
    setError('');
    try {
      const q = new URLSearchParams();
      if (applied.current.status) q.set('status', applied.current.status);
      if (applied.current.mine) q.set('mine', '1');
      if (target.cursor) q.set('cursor', target.cursor);
      const p = await staffRequest<RedemptionPickingPage>(
        base + (target.id ? '/' + target.id : '?' + q),
      );
      if (n !== seq.current) return;
      setEnabled(p.enabled);
      if (target.id) setDetail(p.items[0] ?? null);
      else {
        setItems((old) => (target.cursor ? [...old, ...p.items] : p.items));
        setCursor(p.nextCursor);
        setDetail(null);
      }
    } catch (e) {
      if (n === seq.current) {
        setError(e instanceof Error ? e.message : '作业读取失败');
        if (e instanceof StaffRequestError && [401, 403].includes(e.status)) {
          setItems([]);
          setDetail(null);
          setCursor(null);
        }
      }
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }
  useEffect(() => {
    try {
      const v = stored();
      setIntent(v);
      void load(v ? { id: v.id } : {});
    } catch (e) {
      setCorrupt(true);
      setError(e instanceof Error ? e.message : '原操作无法读取');
      setLoading(false);
    }
    return () => {
      seq.current++;
    };
  }, []);
  async function write(action: Action, body?: Record<string, unknown>) {
    if (writing.current || corrupt || !detail) return;
    writing.current = true;
    setBusy(true);
    setError('');
    const n = seq.current;
    try {
      const old = stored(),
        v = old ?? {
          id: detail.id,
          action,
          key: crypto.randomUUID(),
          version: action === 'retry' ? detail.job.version : detail.task!.version,
          body,
        };
      sessionStorage.setItem(storage, JSON.stringify(v));
      setIntent(v);
      await staffRequest(base + '/' + v.id + '/' + v.action, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': profile.csrfToken,
          'Idempotency-Key': v.key,
        },
        body: JSON.stringify({ ...v.body, version: v.version }),
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
        setError(e instanceof Error ? e.message : '作业结果尚未确认，请使用原请求核实');
        if (e instanceof StaffRequestError && [401, 403].includes(e.status)) {
          setItems([]);
          setDetail(null);
        }
      }
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="redemption-picking-panel">
      <div className="points-toolbar">
        <label>
          任务状态
          <select
            aria-label="任务状态"
            value={status}
            disabled={busy || !!intent}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">全部任务</option>
            <option value="QUEUED">待创建/重试中</option>
            <option value="READY">待领取</option>
            <option value="CLAIMED">已领取</option>
            <option value="CHECKED">拣货完成 · 待打包</option>
            <option value="FAILED">创建失败</option>
            <option value="CANCELED">已取消</option>
          </select>
        </label>
        <label className="picking-mine">
          <input
            type="checkbox"
            checked={mine}
            disabled={busy || !!intent}
            onChange={(e) => setMine(e.target.checked)}
          />
          仅本人领取
        </label>
        <button
          className="secondary-button"
          disabled={loading || busy || !!intent}
          onClick={() => {
            applied.current = { status, mine };
            void load();
          }}
        >
          查询作业
        </button>
        <button
          className="secondary-button"
          disabled={loading || busy}
          onClick={() => void load(detail ? { id: detail.id } : {})}
        >
          刷新作业
        </button>
      </div>
      {!enabled && !loading && (
        <div className="notice">作业写入尚未启用，当前只读；后台任务处理器需单独启用。</div>
      )}
      {loading && <p role="status">正在核实兑换拣货任务…</p>}
      {error && (
        <div className="notice task-error" role="alert">
          {error}
          <button
            className="secondary-button"
            disabled={loading || busy}
            onClick={() => void load(last.current)}
          >
            重试读取
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
            返回拣货列表
          </button>
          <h2>{detail.title}</h2>
          <p>
            {detail.spec} · {detail.quantity} 件
          </p>
          <p className="redemption-order-no">兑换单号：{detail.orderNo}</p>
          <p className="picking-state">{states[detail.state] ?? detail.state}</p>
          {detail.task?.ownerName && (
            <p>
              领取人：{detail.task.ownerName}
              {detail.task.ownerId === profile.id ? '（本人）' : ''}
            </p>
          )}
          <h3>按预占批次与库位备货</h3>
          {detail.lines.map((l) => (
            <article className="picking-allocation" key={l.id}>
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
              <p>
                {l.issue
                  ? (l.issue.kind === 'SHORTAGE' ? '缺货' : '破损') +
                    ' ' +
                    l.issue.quantity +
                    ' 件 · 待仓管处置，整项阻断'
                  : l.checked
                    ? '已核对原预占完整件数'
                    : '待领取人核对'}
              </p>
              {detail.state === 'CLAIMED' && (
                <AllocationWork
                  key={l.id + ':' + detail.task!.version}
                  line={l}
                  owner={detail.task?.ownerId === profile.id}
                  manager={profile.permissions.includes('redemption-picking.resolve')}
                  disabled={busy || loading || !!intent || !enabled || corrupt}
                  blocked={detail.readiness.blockers.length > 0}
                  write={write}
                />
              )}
            </article>
          ))}
          {detail.readiness.blockers.length > 0 && (
            <div className="notice task-error">
              {detail.readiness.blockers.map((b) => reasons[b] ?? b).join('；')}
            </div>
          )}
          <p>
            建任务进度：
            {states[detail.job.state] ??
              (detail.job.state === 'COMPLETED' ? '已创建一次有效任务' : detail.job.state)}{' '}
            · 本轮尝试 {detail.job.attempts}/3
          </p>
          {detail.job.lastErrorCode && (
            <p>{reasons[detail.job.lastErrorCode] ?? detail.job.lastErrorCode}</p>
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
                    claim: '领取',
                    retry: '重试',
                    check: '核对',
                    report: '上报',
                    resolve: '处置',
                    complete: '完成拣货',
                  }[intent.action]}
            </button>
          ) : (
            <>
              {detail.task?.state === 'READY' && (
                <button
                  className="primary-button"
                  disabled={busy || loading || !enabled || !detail.readiness.ready || corrupt}
                  onClick={() => void write('claim')}
                >
                  领取并开始本人拣货
                </button>
              )}
              {detail.job.state === 'FAILED' &&
                profile.permissions.includes('redemption-picking.retry') && (
                  <button
                    className="secondary-button"
                    disabled={busy || loading || !enabled || corrupt}
                    onClick={() => void write('retry')}
                  >
                    核查后重试创建任务
                  </button>
                )}
            </>
          )}
          {detail.state === 'CLAIMED' && detail.task?.ownerId === profile.id && !intent && (
            <button
              className="primary-button"
              disabled={busy || loading || !enabled || !detail.work.canComplete || corrupt}
              onClick={() => void write('complete')}
            >
              全部核对后完成拣货
            </button>
          )}
          {detail.state === 'CHECKED' && (
            <div className="notice">
              原预占逐项核对已完成，等待打包。尚未出库或配送，实物预占和积分保持不变。
            </div>
          )}
          {!!detail.history.length && (
            <details>
              <summary>查看核对与异常记录（{detail.history.length}）</summary>
              {detail.history.map((e) => (
                <p key={e.id}>
                  {
                    (
                      {
                        CHECK: '完整件数核对',
                        SHORTAGE: '缺货上报',
                        DAMAGE: '破损上报',
                        RESOLVE: '原需求备齐确认',
                        COMPLETE: '完成拣货',
                      } as Record<string, string>
                    )[e.action]
                  }
                  {e.quantity === null ? '' : ' · ' + e.quantity + ' 件'} ·{' '}
                  {e.allocationId && (
                    <>
                      {' '}
                      · {detail.lines.find((l) => l.id === e.allocationId)?.batchNo} /{' '}
                      {detail.lines.find((l) => l.id === e.allocationId)?.locationName}
                    </>
                  )}{' '}
                  · {e.actorId === detail.task?.ownerId ? '领取人' : '仓管/负责人'} ·{' '}
                  {new Date(e.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                  （北京时间）
                </p>
              ))}
            </details>
          )}
          {detail.task?.state === 'CLAIMED' && (
            <div className="notice">
              消费者直接取消已停止。异常处置只确认原预占需求已备齐，须由领取人重新核对；不得用处置代替调账、换批或退分。
            </div>
          )}
        </div>
      ) : (
        <>
          {!loading && !error && !items.length && (
            <div className="points-empty">暂无匹配兑换拣货任务</div>
          )}
          <div className="picking-cards">
            {items.map((t) => (
              <article className="picking-allocation" key={t.id}>
                <strong>
                  {t.title} · {t.quantity} 件
                </strong>
                <p>{t.spec}</p>
                <p>
                  {states[t.state] ?? t.state}
                  {t.task?.ownerName ? ' · ' + t.task.ownerName : ''}
                </p>
                <button
                  className="secondary-button"
                  disabled={loading || busy}
                  onClick={() => void load({ id: t.id })}
                >
                  查看拣货详情
                </button>
              </article>
            ))}
          </div>
          {cursor && !error && (
            <button
              className="secondary-button"
              disabled={loading || busy}
              onClick={() => void load({ cursor })}
            >
              加载更多
            </button>
          )}
        </>
      )}
    </div>
  );
}

function AllocationWork({
  line,
  owner,
  manager,
  disabled,
  blocked,
  write,
}: {
  line: RedemptionPickingView['lines'][number];
  owner: boolean;
  manager: boolean;
  disabled: boolean;
  blocked: boolean;
  write: (action: Action, body?: Record<string, unknown>) => Promise<void>;
}) {
  const [quantity, setQuantity] = useState(''),
    [kind, setKind] = useState('SHORTAGE');
  const valid = /^[1-9]\d*$/.test(quantity) && Number(quantity) <= line.quantity;
  return (
    <div className="picking-line-work">
      {line.issue
        ? manager && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void write('resolve', {
                  allocationId: line.id,
                  issueId: line.issue!.id,
                  quantity: Number(quantity),
                });
              }}
            >
              <label>
                确认原预占已备齐件数
                <input
                  aria-label="确认原预占已备齐件数"
                  type="number"
                  min="1"
                  max={line.quantity}
                  step="1"
                  value={quantity}
                  disabled={disabled}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </label>
              <button
                className="secondary-button"
                disabled={disabled || blocked || Number(quantity) !== line.quantity}
              >
                确认原需求已备齐
              </button>
              <p>仅确认原批次、原库位完整需求已恢复；领取人仍须重新核对。</p>
            </form>
          )
        : owner && (
            <form onSubmit={(e) => e.preventDefault()}>
              <label>
                实际核对或异常件数
                <input
                  aria-label="实际核对或异常件数"
                  type="number"
                  min="1"
                  max={line.quantity}
                  step="1"
                  disabled={disabled}
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </label>
              {!line.checked && (
                <button
                  className="primary-button"
                  disabled={disabled || blocked || Number(quantity) !== line.quantity}
                  onClick={() =>
                    void write('check', { allocationId: line.id, quantity: Number(quantity) })
                  }
                >
                  确认此项完整件数
                </button>
              )}
              <label>
                异常原因
                <select
                  aria-label="异常原因"
                  value={kind}
                  disabled={disabled}
                  onChange={(e) => setKind(e.target.value)}
                >
                  <option value="SHORTAGE">缺货</option>
                  <option value="DAMAGE">破损</option>
                </select>
              </label>
              <button
                className="secondary-button"
                disabled={disabled || !valid}
                onClick={() =>
                  void write('report', { allocationId: line.id, quantity: Number(quantity), kind })
                }
              >
                上报此项异常
              </button>
            </form>
          )}
    </div>
  );
}
