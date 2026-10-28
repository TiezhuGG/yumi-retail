import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import type {
  Page,
  ReceiptReversal,
  ReceiptReversalSource,
  StaffProfile,
  StockPosition,
} from '@yumi/contracts';
import { staffRequest } from './index.js';
import { TaskDialog } from './task-dialog.js';
const control: CSSProperties = {
  display: 'block',
  width: '100%',
  boxSizing: 'border-box',
  minHeight: 44,
  padding: 10,
  margin: '6px 0 12px',
};
const button: CSSProperties = {
  padding: 10,
  minHeight: 44,
  margin: '8px 8px 8px 0',
  background: '#008a42',
  color: 'white',
  border: 0,
  borderRadius: 6,
};
const box: CSSProperties = {
  borderTop: '1px solid #d0d5dd',
  marginTop: 20,
  paddingTop: 12,
  overflowWrap: 'anywhere',
};
const states = {
  DRAFT: '待独立审批',
  APPROVED: '已审批待过账',
  POSTED: '已过账',
  CANCELLED: '已取消',
};
export function ReceiptReversalWorkbench({
  profile,
  warehouseId,
  positions,
  onChanged,
}: {
  profile: StaffProfile;
  warehouseId: string;
  positions: StockPosition[];
  onChanged: () => Promise<void>;
}) {
  const [rows, setRows] = useState<ReceiptReversal[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [selected, setSelected] = useState<ReceiptReversal | null>(null),
    [source, setSource] = useState<ReceiptReversalSource | null>(null),
    [positionId, setPositionId] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [failed, setFailed] = useState(false),
    [creating, setCreating] = useState(false),
    [statusFilter, setStatusFilter] = useState(''),
    [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState('');
  const root = `/warehouse/warehouses/${warehouseId}`,
    sequence = useRef(0),
    intentions = useRef(new Map<string, string>());
  const can = (permission: string) => profile.permissions.includes(permission);
  async function load(after?: string) {
    const token = sequence.current;
    const p = await staffRequest<Page<ReceiptReversal>>(
      `${root}/receipt-reversals?limit=10${after ? `&cursor=${after}` : ''}`,
    );
    if (token !== sequence.current) return;
    setRows((old) => (after ? [...old, ...p.items] : p.items));
    setCursor(p.nextCursor);
  }
  async function openSource(id: string) {
    const s = await staffRequest<ReceiptReversalSource>(`${root}/receipt-reversal-sources/${id}`);
    setSource(s);
    setPositionId(id);
  }
  async function reload() {
    setLoading(true);
    setLoadError('');
    try {
      await load();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '列表加载失败');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
    return () => {
      sequence.current++;
    };
  }, [warehouseId]);
  async function refresh() {
    await Promise.all([load(), onChanged()]);
    if (source) await openSource(source.positionId);
  }
  async function post(suffix: string, body: unknown) {
    const signature = suffix + JSON.stringify(body),
      key = intentions.current.get(signature) ?? crypto.randomUUID();
    intentions.current.set(signature, key);
    const row = await staffRequest<ReceiptReversal>(`${root}/receipt-reversals${suffix}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': profile.csrfToken,
        'Idempotency-Key': key,
      },
      body: JSON.stringify(body),
    });
    intentions.current.delete(signature);
    setCreating(false);
    setSelected(row);
    await refresh();
  }
  async function work(run: () => Promise<void>) {
    setBusy(true);
    setFailed(false);
    setMessage('');
    try {
      await run();
      setMessage('操作完成，逆向单与库存已刷新');
    } catch (e) {
      setFailed(true);
      setMessage(e instanceof Error ? e.message : '操作失败，请刷新核验后重试');
    } finally {
      setBusy(false);
    }
  }
  async function open(id: string) {
    const row = await staffRequest<ReceiptReversal>(`${root}/receipt-reversals/${id}`);
    const latestSource = await staffRequest<ReceiptReversalSource>(
      `${root}/receipt-reversal-sources/${row.positionId}`,
    );
    setSource(latestSource);
    setPositionId(row.positionId);
    setSelected(row);
  }
  function form(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    return new FormData(e.currentTarget);
  }
  const selectedPosition = positions.find((p) => p.id === source?.positionId);
  return (
    <section className="task-workbench" aria-label="收货入库逆向纠错">
      <div className="surface-head">
        <div>
          <h3>收货入库逆向纠错</h3>
          <p>核对原单，独立审批，保留历史。</p>
        </div>
        {can('reversal.write') && (
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => {
              setSelected(null);
              setSource(null);
              setPositionId('');
              setMessage('');
              setCreating(true);
            }}
          >
            ＋ 新建纠错申请
          </button>
        )}
      </div>
      <p>仅冲回原收货误录数量。原单与流水保留，正确资料另建收货单；损坏货品请走隔离报损。</p>
      <p>申请不预扣额度，审批须另一员工。取消申请不改库存，过账后不能撤销。</p>
      <p
        className={failed ? 'task-error' : undefined}
        role={failed ? 'alert' : 'status'}
        aria-live="polite"
      >
        {message}
      </p>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
        <div className="toolbar">
          <label>
            纠错状态{' '}
            <select
              aria-label="筛选纠错状态"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">全部状态</option>
              {Object.entries(states).map(([v, n]) => (
                <option key={v} value={v}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <button className="secondary-button" disabled={loading} onClick={() => void reload()}>
            刷新列表
          </button>
          <span>筛选当前已载入的 {rows.length} 张单据</span>
        </div>
        {loading && (
          <div className="empty-state" role="status">
            正在加载纠错申请…
          </div>
        )}
        {loadError && (
          <div className="empty-state" role="alert">
            <p>{loadError}</p>
            <button className="secondary-button" onClick={() => void reload()}>
              重新加载列表
            </button>
          </div>
        )}
        {creating && (
          <TaskDialog
            title="新建收货纠错"
            busy={busy}
            message={message}
            error={failed}
            onClose={() => setCreating(false)}
          >
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void work(() => openSource(positionId));
              }}
            >
              <label>
                纠错库存位置
                <select
                  style={control}
                  value={positionId}
                  onChange={(e) => {
                    setPositionId(e.target.value);
                    setSource(null);
                  }}
                  required
                >
                  <option value="">请选择</option>
                  {positions.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.batchNo} · {p.locationCode} · 自由{' '}
                      {p.onHand - p.reserved - p.blocked}
                    </option>
                  ))}
                </select>
              </label>
              <p>请选择原收货批次所在位置；如未找到，可加载更多可选批次位置。</p>
              <button style={button}>核对原收货及额度</button>
            </form>
            {source && (
              <section style={box} aria-label="原收货核对">
                <h4>原收货与当前纠错额度</h4>
                <p>
                  {selectedPosition?.name ?? '商品位置资料未载入'} · 批次 {source.batchNo}
                </p>
                <p>
                  {source.sourceRef} · 原单尾号 {source.receiptId.slice(-8)}
                </p>
                <details>
                  <summary>原始记录编号</summary>
                  <p>收货单 {source.receiptId}</p>
                  <p>收货行 {source.receiptLineId}</p>
                </details>
                <p>
                  原入库 {source.originalQuantity} 件 · 已冲回 {source.reversedQuantity} 件 ·
                  批次剩余额度 {source.remaining} 件
                </p>
                <p>当前位置自由数量 {source.freeQuantity} 件；预占和隔离数量不可冲回。</p>
                {can('reversal.write') && Math.min(source.freeQuantity, source.remaining) > 0 && (
                  <form
                    onSubmit={(e) => {
                      const d = form(e);
                      void work(() =>
                        post('', {
                          positionId: source.positionId,
                          quantity: Number(d.get('quantity')),
                          positionVersion: source.positionVersion,
                          reason: d.get('reason'),
                        }),
                      );
                    }}
                  >
                    <label>
                      误录纠错数量
                      <input
                        name="quantity"
                        style={control}
                        type="number"
                        min={1}
                        max={Math.min(100000, source.freeQuantity, source.remaining)}
                        step={1}
                        required
                      />
                    </label>
                    <label>
                      误录原因
                      <input name="reason" style={control} maxLength={200} required />
                    </label>
                    <button style={button}>提交逆向申请</button>
                  </form>
                )}
              </section>
            )}
          </TaskDialog>
        )}
        {!loading && !loadError && (
          <>
            <h4>纠错申请</h4>
            {!rows.some((d) => !statusFilter || d.status === statusFilter) && (
              <div className="empty-state">暂无符合条件的纠错申请，请调整筛选或新建申请。</div>
            )}
            {rows
              .filter((d) => !statusFilter || d.status === statusFilter)
              .map((d) => (
                <article key={d.id} className="task-card">
                  <strong>
                    收货纠错 {d.quantity} 件 · {states[d.status]}
                  </strong>
                  <p>
                    {positions.find((p) => p.id === d.positionId)?.name ?? '商品位置资料未载入'} ·{' '}
                    {d.reason}
                  </p>
                  <p>单号尾号 {d.id.slice(-8)}</p>
                  <button style={button} onClick={() => void work(() => open(d.id))}>
                    查看逆向单
                  </button>
                </article>
              ))}
            {cursor && (
              <button style={button} onClick={() => void work(() => load(cursor))}>
                更多逆向单
              </button>
            )}
          </>
        )}
        {selected && (
          <TaskDialog
            title={`收货纠错详情 · ${states[selected.status]}`}
            busy={busy}
            message={message}
            error={failed}
            onClose={() => setSelected(null)}
          >
            <button className="secondary-button" onClick={() => void work(() => open(selected.id))}>
              刷新纠错单据
            </button>
            {source && (
              <div className="task-summary">
                <h4>原收货与当前额度</h4>
                <p>
                  {selectedPosition?.name ?? '商品位置资料未载入'} · {source.batchNo} ·{' '}
                  {source.sourceRef}
                </p>
                <p>
                  原入库 {source.originalQuantity} 件 · 已冲回 {source.reversedQuantity} 件 ·
                  剩余额度 {source.remaining} 件 · 当前自由 {source.freeQuantity} 件
                </p>
              </div>
            )}
            <section style={box} aria-label="逆向单详情">
              <h4>当前逆向单详情</h4>
              <details>
                <summary>单号 …{selected.id.slice(-8)}</summary>
                <p>{selected.id}</p>
              </details>
              <p>
                冲回 {selected.quantity} 件 · {states[selected.status]}
              </p>
              <p>原因：{selected.reason}</p>
              <p>
                申请人：{selected.createdBy === profile.id ? '你' : '其他授权员工'} · 审批：
                {selected.reviewedBy
                  ? selected.reviewedBy === profile.id
                    ? '你已审批'
                    : '已由其他员工审批'
                  : '待独立审批'}
              </p>
              {selected.reviewReason && <p>审批说明：{selected.reviewReason}</p>}
              {selected.physicalEvidence && <p>核验说明：{selected.physicalEvidence}</p>}
              {selected.cancelReason && <p>取消说明：{selected.cancelReason}</p>}
              {source &&
                selected.positionId === source.positionId &&
                selected.positionVersion !== source.positionVersion &&
                ['DRAFT', 'APPROVED'].includes(selected.status) && (
                  <p>位置版本已变化，请取消本申请并按最新库存重新申请。</p>
                )}
              {selected.status === 'DRAFT' && selected.createdBy === profile.id && (
                <p>请另一位管理员或仓管独立核验并审批。</p>
              )}
              {selected.status === 'DRAFT' &&
                selected.createdBy !== profile.id &&
                can('reversal.approve') && (
                  <form
                    onSubmit={(e) => {
                      const d = form(e);
                      void work(() =>
                        post(`/${selected.id}/approve`, {
                          version: selected.version,
                          reason: d.get('reason'),
                        }),
                      );
                    }}
                  >
                    <label>
                      逆向审批说明
                      <input name="reason" style={control} maxLength={200} required />
                    </label>
                    <button style={button}>确认独立审批逆向单</button>
                  </form>
                )}
              {selected.status === 'APPROVED' && can('reversal.post') && (
                <form
                  onSubmit={(e) => {
                    const d = form(e);
                    void work(() =>
                      post(`/${selected.id}/post`, {
                        version: selected.version,
                        physicalConfirmed: d.get('physicalConfirmed') === 'on',
                        physicalEvidence: d.get('physicalEvidence'),
                      }),
                    );
                  }}
                >
                  <label>
                    <input name="physicalConfirmed" type="checkbox" required />{' '}
                    已核验原收货记录和实物，确认本次数量属于误录
                  </label>
                  <label>
                    原单及实物核验说明
                    <input name="physicalEvidence" style={control} maxLength={200} required />
                  </label>
                  <button style={button}>确认逆向纠错过账</button>
                </form>
              )}
              {['DRAFT', 'APPROVED'].includes(selected.status) && can('reversal.write') && (
                <form
                  onSubmit={(e) => {
                    const d = form(e);
                    void work(() =>
                      post(`/${selected.id}/cancel`, {
                        version: selected.version,
                        reason: d.get('reason'),
                      }),
                    );
                  }}
                >
                  <label>
                    逆向取消原因
                    <input name="reason" style={control} maxLength={200} required />
                  </label>
                  <button style={button}>取消逆向申请</button>
                </form>
              )}
            </section>
          </TaskDialog>
        )}
      </fieldset>
    </section>
  );
}
