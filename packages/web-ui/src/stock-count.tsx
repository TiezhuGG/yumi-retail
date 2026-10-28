import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import type { Page, StaffProfile, StockCount, StockPosition } from '@yumi/contracts';
import { staffRequest } from './index.js';
import { Modal } from './modal.js';
const control: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: 10,
  minHeight: 44,
  marginTop: 6,
};
const button: CSSProperties = {
  padding: 10,
  minHeight: 44,
  margin: '8px 8px 0 0',
  background: '#008a42',
  color: 'white',
  border: 0,
  borderRadius: 6,
};
const states = {
  FROZEN: '冻结待录入',
  SUBMITTED: '待独立审批',
  APPROVED: '已审批待过账',
  POSTED: '已过账',
  CANCELLED: '已终止',
};
export function StockCountWorkbench({
  profile,
  warehouseId,
  onChanged,
  positions = [],
}: {
  profile: StaffProfile;
  warehouseId: string;
  onChanged: () => Promise<void>;
  positions?: StockPosition[];
}) {
  const [rows, setRows] = useState<StockCount[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [selected, setSelected] = useState<StockCount | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState(''),
    [creating, setCreating] = useState(false),
    [statusFilter, setStatusFilter] = useState('');
  const intentions = useRef(new Map<string, string>());
  const sequence = useRef(0);
  const root = `/warehouse/warehouses/${warehouseId}`;
  const can = (p: string) => profile.permissions.includes(p);
  async function load(after?: string) {
    const sequenceId = ++sequence.current;
    const result = await staffRequest<Page<StockCount>>(
      `${root}/stock-counts?limit=10${after ? `&cursor=${after}` : ''}`,
    );
    if (sequenceId !== sequence.current) return;
    setRows((old) => (after ? [...old, ...result.items] : result.items));
    setCursor(result.nextCursor);
  }
  async function reload() {
    setLoading(true);
    setLoadError('');
    try {
      await load();
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : '盘点单加载失败');
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
  async function post(path: string, body: unknown) {
    const signature = path + JSON.stringify(body),
      key = intentions.current.get(signature) ?? crypto.randomUUID();
    intentions.current.set(signature, key);
    const row = await staffRequest<StockCount>(`${root}/stock-counts${path}`, {
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
    await load();
    await onChanged();
  }
  async function work(run: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await run();
      setMessage('操作完成，盘点数据已刷新');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '操作失败，请刷新后使用原操作重试');
    } finally {
      setBusy(false);
    }
  }
  async function open(id: string) {
    setSelected(await staffRequest<StockCount>(`${root}/stock-counts/${id}`));
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!selected) return;
    const data = new FormData(e.currentTarget);
    void work(() =>
      post(`/${selected.id}/submit`, {
        version: selected.version,
        lines: selected.lines.map((l) => ({
          positionId: l.positionId,
          counted: Number(data.get(l.id)),
        })),
      }),
    );
  }
  const shown = rows.filter((row) => !statusFilter || row.status === statusFilter);
  return (
    <section
      className="count-workbench"
      style={{
        borderTop: '1px solid #d0d5dd',
        marginTop: 24,
        paddingTop: 12,
        overflowWrap: 'anywhere',
      }}
    >
      <div className="surface-head">
        <div>
          <h2>盘点作业</h2>
          <p>按商品规格核实实物，独立审批后过账。</p>
        </div>
        {can('count.write') && (
          <button
            className="primary-button"
            disabled={busy}
            onClick={() => {
              setMessage('');
              setCreating(true);
            }}
          >
            ＋ 发起盘点
          </button>
        )}
      </div>
      <p>
        按单规格冻结全部位置后盘点。冻结期间暂停销售、收货和移位；未结束的盘点须过账或明确终止，不会自动解冻。
      </p>
      <p role="status" aria-live="polite">
        {message}
      </p>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
        {creating && can('count.write') && (
          <Modal title="发起实物盘点" busy={busy} onClose={() => setCreating(false)}>
            <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
              <form
                className="count-create"
                onSubmit={(e) => {
                  e.preventDefault();
                  const data = new FormData(e.currentTarget);
                  const skuId = String(data.get('skuId')).trim();
                  void work(async () => {
                    const result = await staffRequest<Page<{ version: number }>>(
                      `${root}/stock?limit=1&skuId=${encodeURIComponent(skuId)}`,
                    );
                    if (!result.items[0]) throw new Error('该仓尚无此规格库存');
                    await post('', {
                      skuId,
                      version: result.items[0].version,
                      reason: data.get('reason'),
                    });
                  });
                }}
              >
                <label>
                  盘点商品规格
                  <select name="skuId" style={control} required defaultValue="">
                    <option value="">请选择商品与规格</option>
                    {[...new Map(positions.map((p) => [p.skuId, p])).values()].map((p) => (
                      <option value={p.skuId} key={p.skuId}>
                        {p.name} · {p.spec} · {p.skuCode}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  发起原因
                  <input name="reason" style={control} required maxLength={200} />
                </label>
                <p className="count-warning">
                  提交后立即冻结该规格全部位置，请确认实物作业已准备好。
                </p>
                {message && <p role="status">{message}</p>}
                <button style={button}>确认发起并冻结</button>
              </form>
            </fieldset>
          </Modal>
        )}
        <div className="toolbar">
          <label>
            盘点状态{' '}
            <select
              aria-label="筛选盘点状态"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">全部状态</option>
              {Object.entries(states).map(([value, name]) => (
                <option key={value} value={value}>
                  {name}
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
            正在加载盘点单…
          </div>
        )}
        {loadError && (
          <div className="empty-state" role="alert">
            <p>{loadError}</p>
            <button className="secondary-button" onClick={() => void reload()}>
              重新加载盘点单
            </button>
          </div>
        )}
        {!loading && !loadError && !shown.length && (
          <div className="empty-state">
            <h3>{rows.length ? '没有符合状态的盘点单' : '还没有盘点任务'}</h3>
            <p>
              {rows.length
                ? '请切换状态筛选，或继续加载更多单据。'
                : '准备好实物后，从“发起盘点”开始。'}
            </p>
          </div>
        )}
        <div className="count-list">
          {!loading &&
            !loadError &&
            shown.map((row) => (
              <article key={row.id} className="count-card">
                <div>
                  <span className={`count-state count-state-${row.status}`}>
                    {states[row.status]}
                  </span>
                  <h3>{positions.find((p) => p.skuId === row.skuId)?.name ?? '商品资料未载入'}</h3>
                  <p>
                    {row.lines.length} 个位置 · {new Date(row.createdAt).toLocaleString('zh-CN')}
                  </p>
                  <p>{row.reason}</p>
                  <small>单号尾号 {row.id.slice(-8)}</small>
                </div>
                <button className="secondary-button" onClick={() => void work(() => open(row.id))}>
                  查看详情 →
                </button>
              </article>
            ))}
        </div>
        {cursor && (
          <button className="secondary-button" onClick={() => void work(() => load(cursor))}>
            加载更多盘点单
          </button>
        )}
        {selected && (
          <Modal
            title={`盘点详情 · ${states[selected.status]}`}
            busy={busy}
            onClose={() => setSelected(null)}
          >
            <fieldset
              className="count-detail"
              disabled={busy}
              style={{ border: 0, padding: 0, minWidth: 0 }}
            >
              {message && <p role="status">{message}</p>}
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => void work(() => open(selected.id))}
              >
                刷新当前单据
              </button>
              <article
                key={`${selected.id}:${selected.version}`}
                style={{ border: '1px solid #98a2b3', padding: 12, marginTop: 16 }}
              >
                <h3>盘点明细 · {states[selected.status]}</h3>
                <details>
                  <summary>单号 …{selected.id.slice(-8)}</summary>
                  <p>{selected.id}</p>
                </details>
                <p>
                  发起人：{selected.createdBy === profile.id ? '你' : '其他授权员工'} · 审批：
                  {selected.reviewedBy
                    ? selected.reviewedBy === profile.id
                      ? '你已审批'
                      : '其他员工已审批'
                    : '待独立审批'}
                </p>
                <p>
                  实盘数包含不可售库存；不得低于预占与不可售数量之和。盘盈仅适用于已存在的位置/批次。
                </p>
                <form onSubmit={submit} className="count-lines-form">
                  {selected.lines.map((l) => (
                    <div key={l.id} className="count-line">
                      <p>
                        {positions.find((p) => p.id === l.positionId)?.name ?? '库存位置'} ·{' '}
                        {positions.find((p) => p.id === l.positionId)?.locationCode ?? '未载入库位'}{' '}
                        · 批次 {positions.find((p) => p.id === l.positionId)?.batchNo ?? '未载入'}
                      </p>
                      <p>
                        账面 {l.snapshotOnHand} / 预占 {l.snapshotReserved} / 不可售{' '}
                        {l.snapshotBlocked}
                      </p>
                      {selected.status === 'FROZEN' &&
                      can('count.write') &&
                      selected.createdBy === profile.id ? (
                        <label>
                          实盘件数
                          <input
                            name={l.id}
                            type="number"
                            min={l.snapshotReserved + l.snapshotBlocked}
                            max={1000000000}
                            step={1}
                            style={control}
                            required
                          />
                        </label>
                      ) : (
                        <p>
                          实盘 {l.counted ?? '未录入'} / 差异{' '}
                          {l.counted === null ? '未录入' : l.counted - l.snapshotOnHand}
                        </p>
                      )}
                    </div>
                  ))}
                  {selected.status === 'FROZEN' &&
                    can('count.write') &&
                    selected.createdBy === profile.id && (
                      <button style={button}>提交全部实盘数</button>
                    )}
                </form>
                {selected.status === 'SUBMITTED' &&
                  can('count.approve') &&
                  (selected.createdBy === profile.id ? (
                    <p>请另一位有审批权限的员工登录审核；发起人不能自审。</p>
                  ) : (
                    <form
                      onSubmit={(e) => {
                        e.preventDefault();
                        const data = new FormData(e.currentTarget);
                        void work(() =>
                          post(`/${selected.id}/approve`, {
                            version: selected.version,
                            reason: data.get('reason'),
                          }),
                        );
                      }}
                    >
                      <label>
                        审批意见
                        <input name="reason" style={control} required maxLength={200} />
                      </label>
                      <button style={button}>审批盘点差异</button>
                    </form>
                  ))}
                {selected.reviewReason && <p>审批意见：{selected.reviewReason}</p>}
                {selected.status === 'APPROVED' && can('count.post') && (
                  <button
                    style={button}
                    onClick={() =>
                      void work(() => post(`/${selected.id}/post`, { version: selected.version }))
                    }
                  >
                    按已审批实盘数过账并解冻
                  </button>
                )}
                {!['POSTED', 'CANCELLED'].includes(selected.status) && can('count.write') && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const data = new FormData(e.currentTarget);
                      void work(() =>
                        post(`/${selected.id}/cancel`, {
                          version: selected.version,
                          reason: data.get('reason'),
                        }),
                      );
                    }}
                  >
                    <label>
                      终止原因
                      <input name="reason" style={control} required maxLength={200} />
                    </label>
                    <button style={button}>终止盘点并释放冻结</button>
                  </form>
                )}
                {selected.cancelReason && <p>终止原因：{selected.cancelReason}</p>}
              </article>
            </fieldset>
          </Modal>
        )}
      </fieldset>
    </section>
  );
}
