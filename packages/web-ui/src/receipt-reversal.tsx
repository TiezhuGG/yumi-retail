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
    [message, setMessage] = useState('');
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
  useEffect(() => {
    void load().catch((e: Error) => setMessage(e.message));
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
    setSelected(row);
    await refresh();
  }
  async function work(run: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await run();
      setMessage('操作完成，逆向单与库存已刷新');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '操作失败，请刷新核验后重试');
    } finally {
      setBusy(false);
    }
  }
  async function open(id: string) {
    const row = await staffRequest<ReceiptReversal>(`${root}/receipt-reversals/${id}`);
    setSelected(row);
    await openSource(row.positionId);
  }
  function form(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    return new FormData(e.currentTarget);
  }
  const selectedPosition = positions.find((p) => p.id === source?.positionId);
  return (
    <section style={box} aria-label="收货入库逆向纠错">
      <h3>收货入库逆向纠错</h3>
      <p>仅冲回原收货误录数量。原单与流水保留，正确资料另建收货单；损坏货品请走隔离报损。</p>
      <p>申请不预扣额度，审批须另一员工。取消申请不改库存，过账后不能撤销。</p>
      <p role="status" aria-live="polite">
        {message}
      </p>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
        <button style={button} onClick={() => void work(refresh)}>
          刷新逆向单与库存
        </button>
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
          <p>位置来自上方列表；找不到时先按规格筛选或加载更多。</p>
          <button style={button}>核对原收货及额度</button>
        </form>
        {source && (
          <section style={box} aria-label="原收货核对">
            <h4>原收货与当前纠错额度</h4>
            <p>
              {selectedPosition?.name ?? source.positionId} · 批次 {source.batchNo}
            </p>
            <p>
              原单 {source.receiptId} · {source.sourceRef}
            </p>
            <p>原收货行 {source.receiptLineId}</p>
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
        <h4>逆向单据</h4>
        {!rows.length && <p>尚无逆向申请。</p>}
        {rows.map((d) => (
          <article key={d.id} style={box}>
            <strong>
              收货纠错 {d.quantity} 件 · {states[d.status]}
            </strong>
            <p>
              {positions.find((p) => p.id === d.positionId)?.name ?? d.positionId} · {d.reason}
            </p>
            <p>单号 {d.id}</p>
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
        {selected && (
          <section style={box} aria-label="逆向单详情">
            <h4>当前逆向单详情</h4>
            <p>{selected.id}</p>
            <p>
              冲回 {selected.quantity} 件 · {states[selected.status]}
            </p>
            <p>原因：{selected.reason}</p>
            <p>
              申请员工 {selected.createdBy} · 审批员工 {selected.reviewedBy ?? '待审批'}
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
        )}
      </fieldset>
    </section>
  );
}
