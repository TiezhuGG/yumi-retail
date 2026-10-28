import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import type {
  Page,
  StaffProfile,
  StockDisposition,
  StockIsolation,
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
export function StockDispositionWorkbench({
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
  const [isolations, setIsolations] = useState<StockIsolation[]>([]),
    [documents, setDocuments] = useState<StockDisposition[]>([]);
  const [isoCursor, setIsoCursor] = useState<string | null>(null),
    [docCursor, setDocCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<StockIsolation | null>(null),
    [position, setPosition] = useState<StockPosition | null>(null),
    [document, setDocument] = useState<StockDisposition | null>(null);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const root = `/warehouse/warehouses/${warehouseId}`,
    intentions = useRef(new Map<string, string>()),
    sequence = useRef(0);
  const can = (p: string) => profile.permissions.includes(p);
  async function loadIsolations(after?: string) {
    const token = sequence.current;
    const p = await staffRequest<Page<StockIsolation>>(
      `${root}/stock-isolations?limit=10${after ? `&cursor=${after}` : ''}`,
    );
    if (token !== sequence.current) return;
    setIsolations((old) => (after ? [...old, ...p.items] : p.items));
    setIsoCursor(p.nextCursor);
  }
  async function loadDocuments(after?: string) {
    const token = sequence.current;
    const p = await staffRequest<Page<StockDisposition>>(
      `${root}/stock-dispositions?limit=10${after ? `&cursor=${after}` : ''}`,
    );
    if (token !== sequence.current) return;
    setDocuments((old) => (after ? [...old, ...p.items] : p.items));
    setDocCursor(p.nextCursor);
  }
  useEffect(() => {
    void Promise.all([loadIsolations(), loadDocuments()]).catch((e: Error) =>
      setMessage(e.message),
    );
    return () => {
      sequence.current++;
    };
  }, [warehouseId]);
  async function openIsolation(id: string) {
    const i = await staffRequest<StockIsolation>(`${root}/stock-isolations/${id}`);
    let cursor: string | null = null,
      p: StockPosition | undefined;
    do {
      const page: Page<StockPosition> = await staffRequest<Page<StockPosition>>(
        `${root}/positions?skuId=${i.skuId}&limit=50${cursor ? `&cursor=${cursor}` : ''}`,
      );
      p = page.items.find((row) => row.id === i.positionId);
      cursor = page.nextCursor;
    } while (!p && cursor);
    if (!p) throw new Error('位置不存在，请重新核查');
    setSelected(i);
    setPosition(p);
  }
  async function post<T>(suffix: string, body: unknown) {
    const signature = suffix + JSON.stringify(body),
      key = intentions.current.get(signature) ?? crypto.randomUUID();
    intentions.current.set(signature, key);
    const row = await staffRequest<T>(`${root}/${suffix}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': profile.csrfToken,
        'Idempotency-Key': key,
      },
      body: JSON.stringify(body),
    });
    intentions.current.delete(signature);
    return row;
  }
  async function work(run: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    try {
      await run();
      setMessage('操作完成，已刷新隔离与处置记录');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : '操作失败，请刷新后重试');
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    await Promise.all([loadIsolations(), loadDocuments(), onChanged()]);
    if (selected) await openIsolation(selected.id);
  }
  function form(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    return new FormData(e.currentTarget);
  }
  const name = (id: string) => {
    const p = positions.find((row) => row.id === id);
    return p ? `${p.name} · ${p.batchNo} · ${p.locationCode}` : id;
  };
  return (
    <section style={box} aria-label="隔离与报损">
      <h3>问题库存隔离与报损</h3>
      <p>
        先隔离问题数量，立即减少可售。解除与报损均需另一位员工审批后过账。草稿不预扣额度，取消申请不会解除隔离。
      </p>
      <p role="status" aria-live="polite">
        {message}
      </p>
      <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
        <button style={button} onClick={() => void work(refresh)}>
          刷新隔离与处置
        </button>
        {can('stock.isolate') && (
          <form
            style={box}
            onSubmit={(e) => {
              const d = form(e),
                p = positions.find((row) => row.id === d.get('positionId'));
              if (!p) return;
              void work(async () => {
                const row = await post<StockIsolation>('stock-isolations', {
                  positionId: p.id,
                  version: p.version,
                  quantity: Number(d.get('quantity')),
                  reason: d.get('reason'),
                });
                await refresh();
                await openIsolation(row.id);
              });
            }}
          >
            <h4>立即隔离</h4>
            <label>
              问题货品位置
              <select name="positionId" style={control} required defaultValue="">
                <option value="">请选择</option>
                {positions
                  .filter((p) => p.onHand - p.reserved - p.blocked > 0)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.batchNo} · {p.locationCode} · 可隔离{' '}
                      {p.onHand - p.reserved - p.blocked}
                    </option>
                  ))}
              </select>
            </label>
            <p>这里使用上方库存位置列表；找不到时先按规格筛选或加载更多位置。</p>
            <label>
              隔离数量
              <input
                name="quantity"
                type="number"
                min={1}
                max={100000}
                step={1}
                style={control}
                required
              />
            </label>
            <label>
              问题说明
              <input name="reason" maxLength={200} style={control} required />
            </label>
            <button style={button}>确认立即隔离</button>
          </form>
        )}
        <h4>隔离记录</h4>
        {!isolations.length && <p>尚无隔离记录。</p>}
        {isolations.map((i) => (
          <article key={i.id} style={box}>
            <strong>{name(i.positionId)}</strong>
            <p>
              隔离 {i.quantity} 件 · 剩余 {i.remaining} 件 · {i.reason}
            </p>
            <p>隔离编号 {i.id}</p>
            <button style={button} onClick={() => void work(() => openIsolation(i.id))}>
              查看隔离并申请处置
            </button>
          </article>
        ))}
        {isoCursor && (
          <button style={button} onClick={() => void work(() => loadIsolations(isoCursor))}>
            更多隔离记录
          </button>
        )}
        {selected && position && (
          <section style={box} aria-label="隔离详情">
            <h4>当前隔离详情</h4>
            <p>
              {position.name} · {position.batchNo} · {position.locationCode}
            </p>
            <p>
              {selected.id} · 剩余 {selected.remaining} 件
            </p>
            <p>
              实物 {position.onHand} / 预占 {position.reserved} / 不可售 {position.blocked} ·{' '}
              {position.expired ? '已过期' : '未过期'} ·{' '}
              {position.locationEnabled ? '库位启用' : '库位停用'}
            </p>
            {can('disposition.write') && selected.remaining > 0 && (
              <form
                onSubmit={(e) => {
                  const d = form(e);
                  void work(async () => {
                    setDocument(
                      await post<StockDisposition>('stock-dispositions', {
                        isolationId: selected.id,
                        kind: d.get('kind'),
                        quantity: Number(d.get('quantity')),
                        positionVersion: position.version,
                        isolationVersion: selected.version,
                        reason: d.get('reason'),
                      }),
                    );
                    await refresh();
                  });
                }}
              >
                <label>
                  处置类型
                  <select name="kind" style={control} defaultValue="DAMAGE">
                    <option value="DAMAGE">报损（减少实物及不可售）</option>
                    <option
                      value="RELEASE"
                      disabled={position.expired || !position.locationEnabled}
                    >
                      解除隔离（恢复可售资格）
                    </option>
                  </select>
                </label>
                <label>
                  处置数量
                  <input
                    name="quantity"
                    type="number"
                    min={1}
                    max={Math.min(100000, selected.remaining)}
                    step={1}
                    required
                    style={control}
                  />
                </label>
                <label>
                  申请原因
                  <input name="reason" maxLength={200} required style={control} />
                </label>
                <button style={button}>提交处置申请</button>
              </form>
            )}
          </section>
        )}
        <h4>处置单据</h4>
        {!documents.length && <p>尚无处置申请。</p>}
        {documents.map((d) => (
          <article key={d.id} style={box}>
            <strong>
              {d.kind === 'DAMAGE' ? '报损' : '解除隔离'} · {d.quantity} 件 · {states[d.status]}
            </strong>
            <p>{name(d.positionId)}</p>
            <p>
              {d.reason} · 单号 {d.id}
            </p>
            <button
              style={button}
              onClick={() =>
                void work(async () =>
                  setDocument(
                    await staffRequest<StockDisposition>(`${root}/stock-dispositions/${d.id}`),
                  ),
                )
              }
            >
              查看处置单
            </button>
          </article>
        ))}
        {docCursor && (
          <button style={button} onClick={() => void work(() => loadDocuments(docCursor))}>
            更多处置申请
          </button>
        )}
        {document && (
          <section style={box} aria-label="处置单详情">
            <h4>当前处置单详情</h4>
            <p>{document.id}</p>
            <p>
              {document.kind === 'DAMAGE' ? '报损' : '解除隔离'} {document.quantity} 件 ·{' '}
              {states[document.status]}
            </p>
            <p>申请原因：{document.reason}</p>
            <p>
              申请员工 {document.createdBy} · 审批员工 {document.reviewedBy ?? '待审批'}
            </p>
            {document.reviewReason && <p>审批说明：{document.reviewReason}</p>}
            {document.cancelReason && <p>取消说明：{document.cancelReason}</p>}
            {document.physicalEvidence && <p>实物核验：{document.physicalEvidence}</p>}
            {document.status === 'DRAFT' && document.createdBy === profile.id && (
              <p>请让另一位管理员或仓管登录后独立审批。</p>
            )}
            {document.status === 'DRAFT' &&
              document.createdBy !== profile.id &&
              can('disposition.approve') && (
                <form
                  onSubmit={(e) => {
                    const d = form(e);
                    void work(async () => {
                      setDocument(
                        await post<StockDisposition>(`stock-dispositions/${document.id}/approve`, {
                          version: document.version,
                          reason: d.get('reason'),
                        }),
                      );
                      await refresh();
                    });
                  }}
                >
                  <label>
                    审批说明
                    <input name="reason" style={control} maxLength={200} required />
                  </label>
                  <button style={button}>确认独立审批</button>
                </form>
              )}
            {document.status === 'APPROVED' && can('disposition.post') && (
              <form
                onSubmit={(e) => {
                  const d = form(e);
                  void work(async () => {
                    setDocument(
                      await post<StockDisposition>(`stock-dispositions/${document.id}/post`, {
                        version: document.version,
                        ...(document.kind === 'DAMAGE'
                          ? {
                              physicalConfirmed: d.get('physicalConfirmed') === 'on',
                              physicalEvidence: d.get('physicalEvidence'),
                            }
                          : {}),
                      }),
                    );
                    await refresh();
                  });
                }}
              >
                {document.kind === 'DAMAGE' ? (
                  <>
                    <label>
                      <input name="physicalConfirmed" type="checkbox" required />{' '}
                      已核验本次报损实物并完成处理
                    </label>
                    <label>
                      实物核验说明（不填写顾客信息）
                      <input name="physicalEvidence" style={control} maxLength={200} required />
                    </label>
                  </>
                ) : (
                  <p>确认货品可以恢复销售；过账时再次检查效期和库位。</p>
                )}
                <button style={button}>
                  {document.kind === 'DAMAGE' ? '确认报损过账' : '确认解除隔离过账'}
                </button>
              </form>
            )}
            {['DRAFT', 'APPROVED'].includes(document.status) && can('disposition.write') && (
              <form
                onSubmit={(e) => {
                  const d = form(e);
                  void work(async () => {
                    setDocument(
                      await post<StockDisposition>(`stock-dispositions/${document.id}/cancel`, {
                        version: document.version,
                        reason: d.get('reason'),
                      }),
                    );
                    await refresh();
                  });
                }}
              >
                <label>
                  取消原因
                  <input name="reason" style={control} maxLength={200} required />
                </label>
                <button style={button}>取消申请并保留隔离</button>
              </form>
            )}
          </section>
        )}
      </fieldset>
    </section>
  );
}
