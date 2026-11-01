import { PickingPackingPanel } from './picking-packing.js';
import { PickingShortagesPanel } from './picking-shortages.js';
import { useEffect, useRef, useState } from 'react';
import type {
  PickingLabTask,
  PickingLabList,
  PickingLabWrite,
  StaffProfile,
  WarehouseSummary,
} from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
export type Operation = {
  path: string;
  body: {
    key: string;
    version: number;
    exceptionVersion?: number;
    lineId?: string;
    quantity?: number;
    missingQuantity?: number;
    reason?: string;
    shortageVersion?: number;
    confirmedQuantity?: number;
    packageCount?: number;
    singleQuantity?: number;
    tripleQuantity?: number;
    packId?: string;
  };
  label: string;
};
const states = { READY: '待领取', PICKING: '本人逐行核对中', CHECKED: '演练核对完成' };
export function PickingLabWorkbench({ profile }: { profile: StaffProfile }) {
  const [warehouses, setWarehouses] = useState<WarehouseSummary[]>([]),
    [w, setW] = useState(''),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const seq = useRef(0),
    pending = useRef(new Map<string, Operation>()),
    creates = useRef(new Map<string, string>());
  async function load() {
    const n = ++seq.current;
    setLoading(true);
    setError('');
    try {
      const r = await staffRequest<{ items: WarehouseSummary[] }>('/warehouse/warehouses');
      if (n === seq.current) {
        setWarehouses(r.items);
        setW((old) => (r.items.some((i) => i.id === old) ? old : (r.items[0]?.id ?? '')));
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
    <div className="picking-workbench">
      <div className="notice">
        拣货隔离演练 ·
        固定合成商品、批次和库位。未关联真实订单或库存，所有演练操作均不会扣真实库存、记真实付款或生成真实配送。
      </div>
      {loading ? (
        <div className="surface empty-state" role="status">
          正在读取演练仓库…
        </div>
      ) : error ? (
        <div className="notice task-error" role="alert">
          {error}
          <button onClick={() => void load()}>重试演练仓库</button>
        </div>
      ) : !warehouses.length ? (
        <div className="surface empty-state">暂无授权仓库</div>
      ) : (
        <>
          <div className="toolbar">
            <label className="readiness-warehouse">
              演练仓库
              <select aria-label="演练仓库" value={w} onChange={(e) => setW(e.target.value)}>
                {warehouses.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <LabPanel
            key={w}
            w={w}
            profile={profile}
            pending={pending.current}
            creates={creates.current}
          />
        </>
      )}
    </div>
  );
}
function LabPanel({
  w,
  profile,
  pending,
  creates,
}: {
  w: string;
  profile: StaffProfile;
  pending: Map<string, Operation>;
  creates: Map<string, string>;
}) {
  const [list, setList] = useState<PickingLabList | null>(null),
    [detail, setDetail] = useState<PickingLabTask | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [quantities, setQuantities] = useState<Record<string, string>>({});
  const seq = useRef(0),
    running = useRef(false);
  const base = '/warehouse/picking-lab',
    query = '?warehouseId=' + w;
  function start() {
    if (running.current) return null;
    running.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    return ++seq.current;
  }
  function finish(n: number) {
    if (n === seq.current) {
      running.current = false;
      setBusy(false);
    }
  }
  async function load(cursor?: string) {
    const n = start();
    if (n === null) return;
    try {
      const r = await staffRequest<PickingLabList>(
        base + query + (cursor ? '&cursor=' + cursor : ''),
      );
      if (n === seq.current) {
        setList((old) => (cursor && old ? { ...r, items: [...old.items, ...r.items] } : r));
        setEnabled(r.enabled);
      }
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '演练列表读取失败');
    } finally {
      finish(n);
    }
  }
  async function open(id: string) {
    const n = start();
    if (n === null) return;
    setSelected(id);
    setDetail(null);
    setQuantities({});
    try {
      const r = await staffRequest<{ enabled: boolean; task: PickingLabTask }>(
        base + '/' + id + query,
      );
      if (n === seq.current) {
        setDetail(r.task);
        setEnabled(r.enabled);
      }
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '演练详情读取失败');
    } finally {
      finish(n);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      seq.current++;
      running.current = false;
    };
  }, [w]);
  async function create() {
    const n = start();
    if (n === null) return;
    const key = creates.get(w) ?? crypto.randomUUID();
    creates.set(w, key);
    try {
      const r = await staffRequest<PickingLabWrite>(base + query, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
        body: JSON.stringify({ key }),
      });
      if (n === seq.current) {
        creates.delete(w);
        setSelected(r.task.id);
        setDetail(r.task);
        setMessage(
          r.duplicate ? '原演练任务已恢复，未重复创建。' : '固定合成任务已创建，尚未领取。',
        );
        setQuantities({});
      }
    } catch (e) {
      if (n === seq.current) {
        if (e instanceof StaffRequestError && [400, 401, 403, 409].includes(e.status))
          creates.delete(w);
        setError(
          (e instanceof Error ? e.message : '创建结果未确认') +
            '；结果未知时请使用原创建操作重试。',
        );
      }
    } finally {
      finish(n);
    }
  }
  async function execute(op: Operation) {
    if (!selected) return;
    const n = start();
    if (n === null) return;
    const scope = w + ':' + selected;
    pending.set(scope, op);
    try {
      const r = await staffRequest<PickingLabWrite>(op.path + query, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
        body: JSON.stringify(op.body),
      });
      if (n === seq.current) {
        pending.delete(scope);
        setDetail(r.task);
        setMessage(
          r.duplicate ? '原操作已恢复，未重复追加记录。' : '演练操作已保存；真实订单与库存未改变。',
        );
        if (op.body.lineId) setQuantities((old) => ({ ...old, [op.body.lineId!]: '' }));
      }
    } catch (e) {
      if (n === seq.current) {
        if (e instanceof StaffRequestError && [400, 401, 403, 404, 409].includes(e.status))
          pending.delete(scope);
        setError(e instanceof Error ? e.message : '操作结果未确认');
      }
    } finally {
      finish(n);
    }
  }
  const op = selected ? pending.get(w + ':' + selected) : undefined;
  return (
    <>
      {!enabled && list && (
        <div className="notice">本机拣货演练写入尚未开启；已有记录可只读查看。</div>
      )}
      {error && (
        <div className="notice task-error" role="alert">
          {error}
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void (selected ? open(selected) : load())}
          >
            刷新演练记录
          </button>
        </div>
      )}
      {message && (
        <div className="notice" role="status">
          {message}
        </div>
      )}
      {op && !busy && (
        <div className="notice" role="status">
          {op.label}结果未确认；刷新不能代替原操作确认。
          <button
            className="secondary-button"
            disabled={busy || !enabled}
            onClick={() => void execute(op)}
          >
            按原操作重试
          </button>
        </div>
      )}
      {!selected ? (
        <section className="surface" aria-label="拣货演练任务">
          <div className="service-area-list-heading">
            <div>
              <h2>拣货演练任务</h2>
              <p>已载入 {list?.items.length ?? 0} 个合成任务，不是实际待发货订单。</p>
            </div>
            <button className="secondary-button" disabled={busy} onClick={() => void load()}>
              刷新演练列表
            </button>
            {profile.permissions.includes('picking-lab.create') && (
              <button
                className="primary-button"
                disabled={busy || !enabled}
                onClick={() => void create()}
              >
                {creates.has(w) ? '重试创建演练任务' : '创建固定演练任务'}
              </button>
            )}
          </div>
          {!list && busy ? (
            <div className="empty-state" role="status">
              正在读取演练任务…
            </div>
          ) : !list?.items.length ? (
            <div className="empty-state">暂无合成拣货任务</div>
          ) : (
            <div className="picking-order-grid">
              {list.items.map((t) => (
                <article className="readiness-check picking-order-card" key={t.id}>
                  <h3>{t.label}</h3>
                  <span className="badge amber">
                    {t.shortages.some((s) => s.state === 'OPEN')
                      ? '有未决缺货，暂停核对'
                      : t.state === 'PICKING'
                        ? '已领取，核对中'
                        : t.pack?.dispatch
                          ? '合成出库已记录'
                          : t.pack
                            ? '合成打包已记录'
                            : states[t.state]}
                  </span>
                  <p>
                    领取人：{t.ownerName ?? '尚未领取'} · 已核对{' '}
                    {t.lines.filter((i) => i.checked).length}/2 行
                  </p>
                  <button className="text-button" disabled={busy} onClick={() => void open(t.id)}>
                    查看演练任务
                  </button>
                </article>
              ))}
            </div>
          )}
          {list?.nextCursor && (
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => void load(list.nextCursor!)}
            >
              加载更多演练任务
            </button>
          )}
        </section>
      ) : (
        <section className="surface" aria-label="演练任务详情">
          <div className="service-area-list-heading">
            <h2>演练任务详情</h2>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => {
                setSelected(null);
                setDetail(null);
                setMessage('');
                void load();
              }}
            >
              返回演练列表
            </button>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => void open(selected)}
            >
              刷新演练详情
            </button>
          </div>
          {!detail && busy ? (
            <div className="empty-state" role="status">
              正在读取演练详情…
            </div>
          ) : (
            detail && (
              <>
                <h3>{detail.label}</h3>
                <span className="badge amber">
                  {detail.shortages.some((s) => s.state === 'OPEN')
                    ? '有未决缺货，暂停核对'
                    : detail.state === 'PICKING' && detail.ownerId !== profile.id
                      ? '由其他人员领取，核对中'
                      : detail.pack?.dispatch
                        ? '合成出库已记录'
                        : detail.pack
                          ? '合成打包已记录'
                          : states[detail.state]}
                </span>
                <p>领取人：{detail.ownerName ?? '尚未领取'}</p>
                {detail.state === 'READY' && profile.permissions.includes('picking-lab.work') && (
                  <button
                    className="primary-button"
                    disabled={
                      busy ||
                      !enabled ||
                      !!op ||
                      (detail?.shortages.some((s) => s.state === 'OPEN') ?? false)
                    }
                    onClick={() =>
                      void execute({
                        path: base + '/' + detail.id + '/claim',
                        body: {
                          key: crypto.randomUUID(),
                          version: detail.version,
                          exceptionVersion: detail.exceptionVersion,
                        },
                        label: '领取演练任务',
                      })
                    }
                  >
                    领取演练任务
                  </button>
                )}
                {detail.state === 'CHECKED' && !detail.pack && (
                  <div className="notice">全部演练明细已核对；未打包、未出库、未交接骑手。</div>
                )}
                <PickingShortagesPanel
                  task={detail}
                  profile={profile}
                  disabled={busy || !enabled || !!op}
                  onExecute={execute}
                />
                {detail.lines.map((i) => (
                  <article className="picking-line" key={i.id}>
                    <h3>
                      {i.name} · {i.spec}
                    </h3>
                    <p>
                      {i.location} · 批次 {i.batchNo}
                    </p>
                    <p>
                      固定演练需求：{i.required} {i.unit}
                    </p>
                    {i.checked ? (
                      <span className="badge green">该行演练已核对</span>
                    ) : detail.state === 'PICKING' &&
                      detail.ownerId === profile.id &&
                      profile.permissions.includes('picking-lab.work') ? (
                      <form
                        className="picking-check-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          void execute({
                            path: base + '/' + detail.id + '/check',
                            body: {
                              key: crypto.randomUUID(),
                              version: detail.version,
                              exceptionVersion: detail.exceptionVersion,
                              lineId: i.id,
                              quantity: Number(quantities[i.id]),
                            },
                            label: i.name + ' ' + i.spec + '核对',
                          });
                        }}
                      >
                        <label>
                          核对数量
                          <input
                            aria-label={i.name + ' ' + i.spec + '核对数量'}
                            type="number"
                            min="0"
                            max="200"
                            step="1"
                            required
                            disabled={
                              busy ||
                              !enabled ||
                              !!op ||
                              (detail?.shortages.some((s) => s.state === 'OPEN') ?? false)
                            }
                            value={quantities[i.id] ?? ''}
                            onChange={(e) =>
                              setQuantities({ ...quantities, [i.id]: e.target.value })
                            }
                          />
                        </label>
                        <button
                          className="primary-button"
                          disabled={
                            busy ||
                            !enabled ||
                            !!op ||
                            (detail?.shortages.some((s) => s.state === 'OPEN') ?? false)
                          }
                          type="submit"
                        >
                          确认{i.spec}核对
                        </button>
                      </form>
                    ) : (
                      <p>未核对 · 仅本人领取后可操作</p>
                    )}
                  </article>
                ))}
                <PickingPackingPanel
                  key={detail.id}
                  task={detail}
                  profile={profile}
                  disabled={busy || !enabled || !!op}
                  onExecute={execute}
                />
                <h3>演练操作历史</h3>
                <ol>
                  {detail.events.map((e, i) => (
                    <li key={i}>
                      {e.action === 'CREATE'
                        ? '创建合成任务'
                        : e.action === 'CLAIM'
                          ? '领取合成任务'
                          : '核对合成明细'}{' '}
                      · {e.actorName}
                      {e.lineId
                        ? ' · ' +
                          detail.lines.find((l) => l.id === e.lineId)?.spec +
                          ' ' +
                          e.quantity
                        : ''}{' '}
                      ·{' '}
                      {new Date(e.createdAt).toLocaleString('zh-CN', {
                        timeZone: 'Asia/Shanghai',
                        hour12: false,
                      })}
                    </li>
                  ))}
                </ol>
              </>
            )
          )}
        </section>
      )}
    </>
  );
}
