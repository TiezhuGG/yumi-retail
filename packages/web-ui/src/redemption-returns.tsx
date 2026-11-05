import { useEffect, useRef, useState } from 'react';
import type { RedemptionReturnPage, RedemptionReturnView, StaffProfile } from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
const states = {
  REQUESTED: '待审核',
  WAIT_RETURN: '待退货验收',
  READY_TO_REFUND: '待退积分',
  REFUNDED: '积分已退还',
  REJECTED: '已驳回',
  CANCELED: '用户已撤销',
};
type Intent = { id: string; action: string; body: Record<string, unknown>; key: string };
export function RedemptionReturnsWorkbench({ profile }: { profile: StaffProfile }) {
  const [items, setItems] = useState<RedemptionReturnView[]>([]),
    [view, setView] = useState<RedemptionReturnView | null>(null),
    [enabled, setEnabled] = useState(false),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [pending, setPending] = useState<Intent | null>(null);
  const [keyword, setKeyword] = useState(''),
    [status, setStatus] = useState('');
  const applied = useRef({ keyword: '', status: '' });
  const seq = useRef(0),
    writing = useRef(false),
    current = useRef<string | undefined>(undefined);
  const storage = 'yumi.return.staff.v1:' + profile.id,
    base = '/admin/redemption-returns';
  function stored(): Intent | null {
    const raw = sessionStorage.getItem(storage);
    if (!raw) return null;
    const v = JSON.parse(raw) as Intent;
    if (
      !/^[a-f0-9-]{36}$/i.test(v.id) ||
      !/^[a-f0-9-]{36}$/i.test(v.key) ||
      !['approve', 'reject', 'receive', 'refund'].includes(v.action) ||
      !v.body ||
      typeof v.body !== 'object'
    )
      throw Error('原售后请求无法读取，请保留并核实');
    return v;
  }
  async function load(id?: string, next?: string) {
    const n = ++seq.current;
    current.current = id;
    setLoading(true);
    setError('');
    setView(null);
    try {
      if (id) {
        const p = await staffRequest<RedemptionReturnPage>(base + '/' + id);
        if (n === seq.current) {
          setView(p.items.find((v) => v.id === id) ?? null);
          setEnabled(p.enabled);
        }
      } else {
        const q = new URLSearchParams();
        if (next) q.set('cursor', next);
        if (applied.current.keyword) q.set('keyword', applied.current.keyword);
        if (applied.current.status) q.set('status', applied.current.status);
        const p = await staffRequest<{ items: RedemptionReturnView[]; nextCursor: string | null }>(
          base + '?' + q,
        );
        if (n === seq.current) {
          setItems((old) => (next ? [...old, ...p.items] : p.items));
          setCursor(p.nextCursor);
        }
      }
    } catch (e) {
      if (n === seq.current) {
        setError(e instanceof Error ? e.message : '售后读取失败');
        if (e instanceof StaffRequestError && [401, 403, 404].includes(e.status)) {
          setView(null);
          setItems([]);
        }
      }
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }
  useEffect(() => {
    try {
      const p = stored();
      setPending(p);
      void load(p?.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : '原记录异常');
      setLoading(false);
    }
    return () => {
      seq.current++;
    };
  }, []);
  async function write(action: string, body: Record<string, unknown> = {}) {
    if (writing.current || !view) return;
    writing.current = true;
    setBusy(true);
    setError('');
    const n = seq.current;
    try {
      const p = stored() ?? { id: view.id, action, body, key: crypto.randomUUID() };
      sessionStorage.setItem(storage, JSON.stringify(p));
      setPending(p);
      await staffRequest(base + '/' + p.id + '/' + p.action, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': profile.csrfToken,
          'Idempotency-Key': p.key,
        },
        body: JSON.stringify(p.body),
      });
      sessionStorage.removeItem(storage);
      if (n === seq.current) {
        setPending(null);
        await load(p.id);
      }
    } catch (e) {
      if (n === seq.current) {
        if (e instanceof StaffRequestError && e.status < 500) {
          sessionStorage.removeItem(storage);
          setPending(null);
          if ([401, 403, 404].includes(e.status)) {
            setView(null);
            setItems([]);
          }
        }
        setError(e instanceof Error ? e.message : '结果未知，请用原请求核实');
      }
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  return (
    <section aria-label="退货退积分">
      <div className="notice">
        已发货兑换售后：按原积分价、原订单完整件数处理。退回实物登记隔离保管，不自动回补可售库存；退积分保留原订单和发货记录。
      </div>
      {!view && (
        <form
          className="points-toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            applied.current = { keyword: keyword.trim(), status };
            void load();
          }}
        >
          <label>
            订单号或商品
            <input
              aria-label="售后订单或商品"
              value={keyword}
              maxLength={80}
              disabled={busy || !!pending}
              onChange={(e) => setKeyword(e.target.value)}
            />
          </label>
          <label>
            处理状态
            <select
              aria-label="售后处理状态"
              value={status}
              disabled={busy || !!pending}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="">全部申请</option>
              {Object.entries(states).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <button className="primary-button" disabled={loading || busy || !!pending}>
            查询申请
          </button>
        </form>
      )}
      <div className="points-toolbar">
        <button
          className="secondary-button"
          disabled={busy || loading}
          onClick={() => void load(current.current)}
        >
          刷新售后
        </button>
      </div>
      {loading && <p role="status">正在读取退货退积分…</p>}
      {error && (
        <p role="alert" className="notice task-error">
          {error}
          <button onClick={() => void load(current.current)}>重试读取售后</button>
        </p>
      )}
      {view ? (
        <div className="reward-detail">
          <button
            className="secondary-button"
            disabled={busy || !!pending}
            onClick={() => void load()}
          >
            返回申请列表
          </button>
          <h2>{view.title}</h2>
          <p>兑换单：{view.orderNo}</p>
          <h3 className="return-state">{states[view.state]}</h3>
          <p>
            {view.quantity} 件 · 退还 {view.points} 积分
          </p>
          <p>用户说明：{view.reason}</p>
          {view.events.map((e) => (
            <article className="picking-pack-proof" key={e.kind}>
              <strong>
                {e.kind === 'APPROVE'
                  ? '审核通过'
                  : e.kind === 'REJECT'
                    ? '审核驳回'
                    : e.kind === 'RECEIVE'
                      ? '退货隔离验收'
                      : e.kind === 'REFUND'
                        ? '退积分成功'
                        : '用户撤销'}
              </strong>
              <p>{e.reason}</p>
              {e.quantity && (
                <p>
                  实收 {e.quantity} 件 ·{' '}
                  {(
                    {
                      UNOPENED: '包装完整',
                      DAMAGED: '商品或包装破损',
                      WRONG_ITEM: '商品不符',
                    } as Record<string, string>
                  )[e.condition ?? ''] ?? '待核查'}{' '}
                  · 隔离位置：{e.location}
                </p>
              )}
              <small>
                {e.staffName} ·{' '}
                {new Date(e.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
              </small>
            </article>
          ))}
          {pending ? (
            <button
              className="primary-button"
              disabled={busy}
              onClick={() => void write(pending.action)}
            >
              使用原请求核实售后
            </button>
          ) : (
            profile.permissions.includes('returns.manage') &&
            ['REQUESTED', 'WAIT_RETURN', 'READY_TO_REFUND'].includes(view.state) && (
              <ReturnForm
                key={view.id + view.state}
                view={view}
                disabled={busy || loading || !enabled}
                write={write}
              />
            )
          )}{' '}
          {!enabled && <p className="notice">当前售后写入未开放，仅可查询记录。</p>}
        </div>
      ) : (
        <>
          <div className="picking-cards">
            {items.map((v) => (
              <article className="reward-card" key={v.id}>
                <h3>{v.title}</h3>
                <p>{v.orderNo}</p>
                <p>
                  {v.quantity} 件 · {v.points} 积分 · {states[v.state]}
                </p>
                <button
                  className="secondary-button"
                  disabled={!!pending || busy}
                  onClick={() => void load(v.id)}
                >
                  查看售后申请
                </button>
              </article>
            ))}
          </div>
          {!loading && !error && !items.length && (
            <p className="points-empty">暂无退货退积分申请</p>
          )}
          {cursor && (
            <button
              disabled={loading || busy || !!pending}
              onClick={() => void load(undefined, cursor)}
            >
              加载更多申请
            </button>
          )}
        </>
      )}
    </section>
  );
}
function ReturnForm({
  view,
  disabled,
  write,
}: {
  view: RedemptionReturnView;
  disabled: boolean;
  write: (action: string, body: Record<string, unknown>) => Promise<void>;
}) {
  const [reason, setReason] = useState(''),
    [requiresReturn, setRequiresReturn] = useState(true),
    [quantity, setQuantity] = useState(''),
    [condition, setCondition] = useState('UNOPENED'),
    [location, setLocation] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const receive = view.state === 'WAIT_RETURN',
    refund = view.state === 'READY_TO_REFUND';
  return (
    <div className="picking-pack-form">
      <h3>{receive ? '核验完整退回实物' : refund ? '确认退还原积分' : '审核本次申请'}</h3>
      {view.state === 'REQUESTED' && (
        <label>
          <input
            type="checkbox"
            checked={requiresReturn}
            disabled={disabled}
            onChange={(e) => setRequiresReturn(e.target.checked)}
          />
          需要用户退回商品后再退积分
        </label>
      )}
      {receive && (
        <>
          <label>
            实际退回件数
            <input
              aria-label="实际退回件数"
              type="number"
              min="1"
              max={view.quantity}
              value={quantity}
              disabled={disabled}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </label>
          <label>
            退货状况
            <select
              aria-label="退货状况"
              value={condition}
              disabled={disabled}
              onChange={(e) => setCondition(e.target.value)}
            >
              <option value="UNOPENED">包装完整</option>
              <option value="DAMAGED">商品或包装破损</option>
              <option value="WRONG_ITEM">商品不符</option>
            </select>
          </label>
          <label>
            实际隔离存放位置
            <input
              aria-label="实际隔离存放位置"
              value={location}
              maxLength={100}
              disabled={disabled}
              onChange={(e) => setLocation(e.target.value)}
            />
          </label>
        </>
      )}
      {refund && (
        <p>本次实际退还 {view.points} 积分到原用户账户。此动作不改变原发货记录，不回补可售库存。</p>
      )}
      <label>
        处理说明
        <textarea
          aria-label="退货处理说明"
          value={reason}
          maxLength={500}
          disabled={disabled}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      <label>
        <input
          type="checkbox"
          checked={confirmed}
          disabled={disabled}
          onChange={(e) => setConfirmed(e.target.checked)}
        />
        {receive
          ? '已核对全部实物并放入隔离位置'
          : refund
            ? '确认按原兑换积分价退还上述积分'
            : '确认审核结论和退货要求，并展示说明给用户'}
      </label>
      <div className="points-toolbar">
        <button
          className="primary-button"
          disabled={
            disabled ||
            !reason.trim() ||
            !confirmed ||
            (receive &&
              (!/^[1-9]\d*$/.test(quantity) ||
                Number(quantity) !== view.quantity ||
                !location.trim()))
          }
          onClick={() =>
            void write(
              receive ? 'receive' : refund ? 'refund' : 'approve',
              receive
                ? {
                    quantity: Number(quantity),
                    condition,
                    location: location.trim(),
                    physicalConfirmed: true,
                    reason: reason.trim(),
                  }
                : refund
                  ? { confirmed: true, reason: reason.trim() }
                  : { requiresReturn, reason: reason.trim() },
            )
          }
        >
          {receive ? '确认退货隔离验收' : refund ? '确认退还 ' + view.points + ' 积分' : '审核通过'}
        </button>
        {view.state === 'REQUESTED' && (
          <button
            className="secondary-button"
            disabled={disabled || !reason.trim() || !confirmed}
            onClick={() => void write('reject', { reason: reason.trim() })}
          >
            驳回申请
          </button>
        )}
      </div>
    </div>
  );
}
