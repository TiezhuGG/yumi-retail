import { useEffect, useRef, useState } from 'react';
import type {
  DeliveryLabList,
  DeliveryLabTask,
  StaffProfile,
  WarehouseSummary,
} from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
type Pending = { key: string; riderId: string; riderName: string };
const reasons: Record<string, string> = {
  LAB_DISABLED: '本机演练写入未开启',
  UNASSIGNED: '尚未分配骑手',
  RIDER_DISABLED: '骑手账号已停用',
  RIDER_ROLE_REMOVED: '骑手角色已移除',
  RIDER_WAREHOUSE_REMOVED: '骑手已无本仓权限',
  PICKING_NOT_READY: '拣货或出库快照不再满足条件',
};
const date = (v: string) =>
  new Date(v).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
export function DeliveryLabWorkbench({ profile }: { profile: StaffProfile }) {
  const [warehouses, setWarehouses] = useState<WarehouseSummary[] | null>(null),
    [w, setW] = useState(''),
    [error, setError] = useState('');
  const seq = useRef(0),
    pending = useRef(new Map<string, Pending>());
  async function load() {
    const n = ++seq.current;
    setError('');
    setWarehouses(null);
    try {
      const r = await staffRequest<{ items: WarehouseSummary[] }>('/delivery-lab/warehouses');
      if (n === seq.current) {
        setWarehouses(r.items);
        setW((old) => (r.items.some((i) => i.id === old) ? old : (r.items[0]?.id ?? '')));
      }
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '演练仓库读取失败');
    }
  }
  useEffect(() => {
    void load();
    return () => {
      seq.current++;
    };
  }, []);
  return (
    <div className="picking-workbench delivery-workbench">
      <div className="notice">
        配送隔离演练 ·
        记录合成任务分配、接货、配送开始及送达凭据，不关联真实订单、顾客地址或库存，不代表实物交接或送达。
      </div>
      {error ? (
        <div className="notice task-error" role="alert">
          {error}
          <button onClick={() => void load()}>重试配送仓库</button>
        </div>
      ) : !warehouses ? (
        <div className="surface empty-state" role="status">
          正在读取配送仓库…
        </div>
      ) : !warehouses.length ? (
        <div className="surface empty-state">暂无授权配送仓库</div>
      ) : (
        <>
          <div className="toolbar">
            <label className="readiness-warehouse">
              配送演练仓库
              <select aria-label="配送演练仓库" value={w} onChange={(e) => setW(e.target.value)}>
                {warehouses.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <DeliveryPanel key={w} w={w} profile={profile} pending={pending.current} />
        </>
      )}
    </div>
  );
}
function DeliveryPanel({
  w,
  profile,
  pending,
}: {
  w: string;
  profile: StaffProfile;
  pending: Map<string, Pending>;
}) {
  const [list, setList] = useState<DeliveryLabList | null>(null),
    [task, setTask] = useState<DeliveryLabTask | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [riders, setRiders] = useState<{ id: string; displayName: string }[]>([]),
    [rider, setRider] = useState(''),
    [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [filter, setFilter] = useState('ALL');
  const seq = useRef(0),
    running = useRef(false);
  const manage = profile.permissions.includes('delivery-lab.assign'),
    base = '/delivery-lab',
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
  async function load(cursor?: string, state = filter) {
    const n = start();
    if (n === null) return;
    if (state !== filter) {
      setFilter(state);
      setList(null);
    }
    try {
      const r = await staffRequest<DeliveryLabList>(
        base + query + '&exceptionState=' + state + (cursor ? '&cursor=' + cursor : ''),
      );
      if (n === seq.current) {
        setList((old) => (cursor && old ? { ...r, items: [...old.items, ...r.items] } : r));
        setEnabled(r.enabled);
      }
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '配送列表读取失败');
    } finally {
      finish(n);
    }
  }
  async function open(id: string) {
    const n = start();
    if (n === null) return;
    setSelected(id);
    setTask(null);
    setRiders([]);
    setRider('');
    try {
      const [r, people] = await Promise.all([
        staffRequest<{ enabled: boolean; task: DeliveryLabTask }>(base + '/' + id + query),
        manage
          ? staffRequest<{ items: { id: string; displayName: string }[] }>(base + '/riders' + query)
          : Promise.resolve({ items: [] }),
      ]);
      if (n === seq.current) {
        setTask(r.task);
        setEnabled(r.enabled);
        setRiders(people.items);
      }
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '配送详情读取失败');
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
  async function assign(op: Pending) {
    if (!selected) return;
    const n = start();
    if (n === null) return;
    const scope = w + ':' + selected;
    pending.set(scope, op);
    try {
      const r = await staffRequest<{ task: DeliveryLabTask; duplicate: boolean }>(
        base + '/' + selected + '/assign' + query,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
          body: JSON.stringify({ key: op.key, riderId: op.riderId }),
        },
      );
      if (n === seq.current) {
        pending.delete(scope);
        setTask(r.task);
        setMessage(r.duplicate ? '原分配已恢复，未重复生成凭据。' : '合成分配已记录，尚未交接。');
      }
    } catch (e) {
      if (n === seq.current) {
        if (e instanceof StaffRequestError && [400, 401, 403, 404, 409].includes(e.status))
          pending.delete(scope);
        setError(e instanceof Error ? e.message : '分配结果未确认');
      }
    } finally {
      finish(n);
    }
  }
  const op = selected ? pending.get(w + ':' + selected) : undefined;
  return (
    <>
      {(list || task) && !enabled && (
        <div className="notice">本机配送演练写入尚未开启，已有任务可只读查看。</div>
      )}
      {error && (
        <div className="notice task-error" role="alert">
          {error}
          <button disabled={busy} onClick={() => void (selected ? open(selected) : load())}>
            重试配送读取
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
          分配给{op.riderName}的结果未确认；刷新不能代替原请求确认。
          <button className="secondary-button" disabled={!enabled} onClick={() => void assign(op)}>
            按原分配重试
          </button>
        </div>
      )}
      {!selected ? (
        <section className="surface" aria-label="合成配送任务列表">
          <div className="service-area-list-heading">
            <div>
              <h2>{manage ? '合成配送分配' : '我的合成配送任务'}</h2>
              <p>
                {manage
                  ? '仅列出已完成合成出库的任务。'
                  : '仅显示分配给本人的任务，不含真实顾客资料。'}
              </p>
            </div>
            <button className="secondary-button" disabled={busy} onClick={() => void load()}>
              刷新配送列表
            </button>
          </div>
          <div className="toolbar" aria-label="异常清单筛选">
            {(
              [
                ['ALL', '全部任务'],
                ['OPEN', '待处置异常'],
                ['RESOLVED', '已处置异常'],
                ['NONE', '无异常'],
              ] as const
            ).map(([v, label]) => (
              <button
                key={v}
                className={filter === v ? 'primary-button' : 'secondary-button'}
                aria-pressed={filter === v}
                disabled={busy}
                onClick={() => void load(undefined, v)}
              >
                {label}
                {list
                  ? ' · ' +
                    list.summary[
                      ({ ALL: 'all', OPEN: 'open', RESOLVED: 'resolved', NONE: 'none' } as const)[v]
                    ]
                  : ''}
              </button>
            ))}
          </div>
          {list && (
            <p>
              读取时间 {date(list.summary.readAt)} · 当前{list.selfOnly ? '本人' : '授权仓库'}
              全部合成出库任务的异常概览，各类互斥；统计不受分页或筛选影响。
            </p>
          )}
          {!list && busy ? (
            <div className="empty-state" role="status">
              正在读取配送任务…
            </div>
          ) : !list ? (
            <div className="empty-state">尚未读取配送任务，请重试。</div>
          ) : !list.items.length ? (
            <div className="empty-state">
              {filter !== 'ALL'
                ? '当前筛选无匹配任务'
                : manage
                  ? '暂无已出库的合成任务'
                  : '暂无分配给你的合成任务'}
            </div>
          ) : (
            <div className="picking-order-grid">
              {list.items.map((t) => (
                <article className="readiness-check picking-order-card" key={t.id}>
                  <h3>{t.label}</h3>
                  <span className={'badge ' + (t.assignment ? 'green' : 'amber')}>
                    {t.journey.completion
                      ? '合成送达已记录'
                      : t.journey.start
                        ? '合成配送中'
                        : t.handoff
                          ? '合成接货已记录'
                          : t.assignment
                            ? '已分配 · 尚未交接'
                            : '待分配骑手'}
                  </span>
                  {t.exception && (
                    <p className="badge amber">
                      {t.exception.resolution ? '已处置异常' : '待处置异常'} ·{' '}
                      {exceptionNames[t.exception.reason]}
                    </p>
                  )}
                  <p>
                    {t.packageCount} 个合成包裹 · {t.assignment?.riderName ?? '尚无骑手'}
                  </p>
                  <button className="text-button" disabled={busy} onClick={() => void open(t.id)}>
                    查看合成配送
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
              加载更多配送任务
            </button>
          )}
        </section>
      ) : (
        <section className="surface" aria-label="合成配送详情">
          <div className="service-area-list-heading">
            <h2>合成配送详情</h2>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => {
                setSelected(null);
                setTask(null);
                void load();
              }}
            >
              返回配送列表
            </button>
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => void open(selected)}
            >
              刷新配送详情
            </button>
          </div>
          {!task && busy ? (
            <div className="empty-state" role="status">
              正在读取配送详情…
            </div>
          ) : (
            task && (
              <>
                <h3 id={task.id + '--dispatch'} tabIndex={-1}>
                  {task.label}
                </h3>
                <DeliveryTimeline key={task.id} task={task} />
                <p>
                  {task.packageCount} 个合成包裹 · 合成出库时间 {date(task.dispatchedAt)}
                </p>
                <div className="readiness-check">
                  <h3>交接资格核验</h3>
                  <span className={'badge ' + (task.handoffReadiness.ready ? 'green' : 'amber')}>
                    {task.handoff
                      ? '合成接货已记录'
                      : task.handoffReadiness.ready
                        ? '资格满足 · 尚未接货'
                        : '交接资格未满足'}
                  </span>
                  <ul>
                    {task.handoffReadiness.blockers.map((b) => (
                      <li key={b}>{reasons[b] ?? '需要刷新核验'}</li>
                    ))}
                  </ul>
                  <p>
                    合成接货须由被分配骑手本人核对数量。资格随账号、角色和仓库权限变化，提交时重新校验；只记录合成配送与送达，不代表实物履约。
                  </p>
                </div>
                {task.handoff ? (
                  <div
                    className="picking-line"
                    role="status"
                    id={task.id + '--handoff'}
                    tabIndex={-1}
                  >
                    <h3>不可变合成接货凭据</h3>
                    <p>
                      已核对 {task.handoff.packageCount} 个合成包裹 · {date(task.handoff.createdAt)}
                    </p>
                    <p>不代表实物交接或送达。</p>
                  </div>
                ) : null}
                {profile.permissions.includes('delivery-lab.accept') && (
                  <AcceptForm
                    key={task.id}
                    task={task}
                    w={w}
                    profile={profile}
                    enabled={enabled}
                    onResult={(result) =>
                      setTask((current) => (current?.id === result.id ? result : current))
                    }
                  />
                )}
                <ExceptionPanel
                  task={task}
                  w={w}
                  profile={profile}
                  enabled={enabled}
                  onResult={(result) =>
                    setTask((current) => (current?.id === result.id ? result : current))
                  }
                />
                <JourneyPanel
                  task={task}
                  w={w}
                  profile={profile}
                  enabled={enabled}
                  onResult={(result) =>
                    setTask((current) => (current?.id === result.id ? result : current))
                  }
                />
                {task.assignment ? (
                  <div className="picking-line">
                    <h3 id={task.id + '--assignment'} tabIndex={-1}>
                      不可变分配凭据
                    </h3>
                    <p>骑手：{task.assignment.riderName}</p>
                    <p>
                      分配人：{task.assignment.actorName} · {date(task.assignment.createdAt)}
                    </p>
                    <p>分配凭据保留；不支持改派或撤销。</p>
                  </div>
                ) : manage ? (
                  <form
                    className="picking-line picking-check-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const person = riders.find((p) => p.id === rider);
                      if (person)
                        void assign({
                          key: crypto.randomUUID(),
                          riderId: rider,
                          riderName: person.displayName,
                        });
                    }}
                  >
                    <label>
                      接收骑手
                      <select
                        aria-label="接收骑手"
                        required
                        value={rider}
                        disabled={busy || !enabled || !!op}
                        onChange={(e) => setRider(e.target.value)}
                      >
                        <option value="">请选择本仓启用的骑手</option>
                        {riders.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.displayName}
                          </option>
                        ))}
                      </select>
                    </label>
                    {!riders.length && <p>本仓暂无可分配骑手，请先维护员工角色与仓库权限。</p>}
                    <button
                      className="primary-button"
                      disabled={busy || !enabled || !!op || !rider}
                    >
                      确认合成分配
                    </button>
                  </form>
                ) : null}
              </>
            )
          )}
        </section>
      )}
    </>
  );
}

// Kept above the detail lifecycle so a read refresh cannot silently replace an unknown request.
const acceptPending = new Map<string, { key: string; packageCount: number }>();
function AcceptForm({
  task,
  w,
  profile,
  enabled,
  onResult,
}: {
  task: DeliveryLabTask;
  w: string;
  profile: StaffProfile;
  enabled: boolean;
  onResult: (task: DeliveryLabTask) => void;
}) {
  const scope = profile.id + ':' + profile.csrfToken + ':' + w + ':' + task.id;
  const [quantity, setQuantity] = useState('');
  const [pending, setPending] = useState(acceptPending.get(scope));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const running = useRef(false);
  async function submit() {
    if (running.current) return;
    const op = pending ?? { key: crypto.randomUUID(), packageCount: Number(quantity) };
    if (!Number.isSafeInteger(op.packageCount) || op.packageCount < 1) return;
    running.current = true;
    setBusy(true);
    acceptPending.set(scope, op);
    setPending(op);
    setMessage('');
    try {
      const r = await staffRequest<{ task: DeliveryLabTask; duplicate: boolean }>(
        '/delivery-lab/' + task.id + '/accept?warehouseId=' + w,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
          body: JSON.stringify(op),
        },
      );
      acceptPending.delete(scope);
      setPending(undefined);
      onResult(r.task);
      setMessage(r.duplicate ? '原接货凭据已恢复，未重复交接。' : '合成接货已记录。');
    } catch (e) {
      if (e instanceof StaffRequestError && [400, 401, 403, 404, 409].includes(e.status)) {
        acceptPending.delete(scope);
        setPending(undefined);
      }
      setMessage(e instanceof Error ? e.message : '接货结果未确认，请按原请求重试');
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  if (task.handoff && !pending && !message) return null;
  return (
    <form
      className="picking-line picking-check-form"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3>本人合成接货核对</h3>
      {message && <p role="status">{message}</p>}
      {pending ? (
        <p>接货结果未确认，请按原请求恢复。原核对数量：{pending.packageCount}。</p>
      ) : (
        !task.handoff && (
          <label>
            实际核对合成包裹数
            <input
              aria-label="实际核对合成包裹数"
              type="number"
              min="1"
              max="100"
              step="1"
              required
              value={quantity}
              disabled={busy || !enabled}
              onChange={(e) => setQuantity(e.target.value)}
            />
          </label>
        )
      )}
      {(!task.handoff || pending) && (
        <button
          className="primary-button"
          disabled={busy || !enabled || (!pending && !task.handoffReadiness.ready)}
        >
          {busy ? '正在确认…' : pending ? '按原接货请求重试' : '确认本人合成接货'}
        </button>
      )}
    </form>
  );
}

const journeyPending = new Map<string, { key: string; action: 'start' | 'complete' }>();
function JourneyPanel({
  task,
  w,
  profile,
  enabled,
  onResult,
}: {
  task: DeliveryLabTask;
  w: string;
  profile: StaffProfile;
  enabled: boolean;
  onResult: (t: DeliveryLabTask) => void;
}) {
  const scope = profile.id + ':' + profile.csrfToken + ':' + w + ':' + task.id;
  const [pending, setPending] = useState(journeyPending.get(scope));
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const running = useRef(false);
  const canWork = profile.permissions.includes('delivery-lab.work');
  const action = task.journey.start ? 'complete' : 'start';
  async function submit() {
    if (running.current) return;
    const op = pending ?? { key: crypto.randomUUID(), action };
    running.current = true;
    setBusy(true);
    setMessage('');
    journeyPending.set(scope, op);
    setPending(op);
    try {
      const r = await staffRequest<{ task: DeliveryLabTask; duplicate: boolean }>(
        '/delivery-lab/' + task.id + '/' + op.action + '?warehouseId=' + w,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
          body: JSON.stringify({ key: op.key }),
        },
      );
      journeyPending.delete(scope);
      setPending(undefined);
      setConfirmed(false);
      onResult(r.task);
      setMessage(r.duplicate ? '原阶段凭据已恢复，未重复记录。' : '合成阶段凭据已记录。');
    } catch (e) {
      if (e instanceof StaffRequestError && [400, 401, 403, 404, 409].includes(e.status)) {
        journeyPending.delete(scope);
        setPending(undefined);
      }
      setMessage(e instanceof Error ? e.message : '阶段结果未确认，请按原请求重试');
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="picking-line">
      <h3 id={task.id + '--journey'} tabIndex={-1}>
        合成配送进度
      </h3>
      <p>
        {task.journey.completion
          ? '合成送达已记录'
          : task.journey.start
            ? '合成配送中'
            : task.handoff
              ? '已合成接货，待开始'
              : '请先完成本人合成接货'}
      </p>
      {task.journey.start && <p>开始凭据 · {date(task.journey.start.createdAt)}</p>}
      {task.journey.completion && <p>送达凭据 · {date(task.journey.completion.createdAt)}</p>}
      <p>仅验证隔离流程，不代表顾客签收或真实送达。</p>
      {message && <p role="status">{message}</p>}
      {canWork && pending && <p>阶段结果未确认；请恢复原请求，不能用下一阶段替代。</p>}
      {canWork && (!task.journey.completion || pending) && (
        <form
          className="picking-check-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {!pending && task.handoff && (
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                disabled={busy || !enabled}
              />
              {action === 'start' ? '确认开始本次合成配送' : '确认本次合成送达演练完成'}
            </label>
          )}
          <button
            className="primary-button"
            disabled={
              busy ||
              !enabled ||
              (!pending &&
                (!task.handoff ||
                  (!!task.exception && !task.exception.resolution) ||
                  !confirmed ||
                  !task.handoffReadiness.ready))
            }
          >
            {busy
              ? '正在记录…'
              : pending
                ? '按原阶段请求重试'
                : action === 'start'
                  ? '记录合成配送开始'
                  : '记录合成送达'}
          </button>
        </form>
      )}
    </div>
  );
}

const exceptionPending = new Map<string, { key: string; reason: string }>();
const exceptionNames: Record<string, string> = {
  UNREACHABLE: '无法联系（合成）',
  REFUSED: '拒收（合成）',
  DAMAGED: '包裹破损（合成）',
};
function ExceptionPanel({
  task,
  w,
  profile,
  enabled,
  onResult,
}: {
  task: DeliveryLabTask;
  w: string;
  profile: StaffProfile;
  enabled: boolean;
  onResult: (t: DeliveryLabTask) => void;
}) {
  const scope = profile.id + ':' + profile.csrfToken + ':' + w + ':' + task.id;
  const [pending, setPending] = useState(exceptionPending.get(scope)),
    [reason, setReason] = useState('UNREACHABLE'),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const running = useRef(false);
  async function submit() {
    if (running.current) return;
    const op = pending ?? { key: crypto.randomUUID(), reason };
    running.current = true;
    setBusy(true);
    exceptionPending.set(scope, op);
    setPending(op);
    try {
      const r = await staffRequest<{ task: DeliveryLabTask; duplicate: boolean }>(
        '/delivery-lab/' + task.id + '/report-exception?warehouseId=' + w,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
          body: JSON.stringify(op),
        },
      );
      exceptionPending.delete(scope);
      setPending(undefined);
      onResult(r.task);
      setMessage(r.duplicate ? '原异常凭据已恢复。' : '合成异常已记录，后续阶段已阻断。');
    } catch (e) {
      if (e instanceof StaffRequestError && [400, 401, 403, 404, 409].includes(e.status)) {
        exceptionPending.delete(scope);
        setPending(undefined);
      }
      setMessage(e instanceof Error ? e.message : '结果未确认');
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  if (!task.exception && (!task.handoff || task.journey.completion)) return null;
  return (
    <div className="picking-line">
      <h3 id={task.id + '--exception'} tabIndex={-1}>
        合成配送异常
      </h3>
      {task.exception && (
        <p role="status">
          {task.exception.resolution ? '已处置异常：' : '未决异常：'}
          {exceptionNames[task.exception.reason]} · {date(task.exception.createdAt)}
          {task.exception.resolution
            ? '。原异常保留，可由本人继续合成配送。'
            : '。禁止继续配送阶段，请本仓负责人或仓管处置。'}
        </p>
      )}
      <ResolvePanel task={task} w={w} profile={profile} enabled={enabled} onResult={onResult} />
      {message && <p role="status">{message}</p>}
      {profile.permissions.includes('delivery-lab.work') && (!task.exception || pending) && (
        <form
          className="picking-check-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {pending ? (
            <p>异常结果未确认，请按原请求恢复。</p>
          ) : (
            <label>
              合成异常类型
              <select
                aria-label="合成异常类型"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                disabled={busy || !enabled}
              >
                {Object.entries(exceptionNames).map(([v, n]) => (
                  <option key={v} value={v}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button className="primary-button" disabled={busy || !enabled}>
            {pending ? '按原异常请求重试' : '上报合成配送异常'}
          </button>
        </form>
      )}
    </div>
  );
}

const resolvePending = new Map<string, { key: string; exceptionId: string }>();
function ResolvePanel({
  task,
  w,
  profile,
  enabled,
  onResult,
}: {
  task: DeliveryLabTask;
  w: string;
  profile: StaffProfile;
  enabled: boolean;
  onResult: (t: DeliveryLabTask) => void;
}) {
  const scope = profile.id + ':' + profile.csrfToken + ':' + w + ':' + task.id;
  const [pending, setPending] = useState(resolvePending.get(scope)),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const running = useRef(false);
  async function submit() {
    if (running.current || !task.exception) return;
    const op = pending ?? { key: crypto.randomUUID(), exceptionId: task.exception.id };
    running.current = true;
    setBusy(true);
    resolvePending.set(scope, op);
    setPending(op);
    try {
      const v = await staffRequest<{ task: DeliveryLabTask; duplicate: boolean }>(
        '/delivery-lab/' + task.id + '/resolve-exception?warehouseId=' + w,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
          body: JSON.stringify(op),
        },
      );
      resolvePending.delete(scope);
      setPending(undefined);
      onResult(v.task);
      setMessage(v.duplicate ? '原处置凭据已恢复。' : '合成处置已记录，未自动推进配送。');
    } catch (e) {
      if (e instanceof StaffRequestError && [400, 401, 403, 404, 409].includes(e.status)) {
        resolvePending.delete(scope);
        setPending(undefined);
      }
      setMessage(e instanceof Error ? e.message : '处置结果未确认');
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  if (!task.exception) return null;
  const resolution = task.exception.resolution;
  return (
    <div>
      {resolution && (
        <p>
          不可变合成处置凭据 · {resolution.actorName} · {date(resolution.createdAt)}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {profile.permissions.includes('delivery-lab.assign') && (!resolution || pending) && (
        <form
          className="picking-check-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          {pending ? (
            <p>处置结果未确认，请恢复原请求。</p>
          ) : (
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                disabled={busy || !enabled}
              />
              确认本次合成异常已处理并允许继续
            </label>
          )}
          <p>只解除隔离演练阻断，不代表已退款、退货、换货或实物处理。</p>
          <button
            className="primary-button"
            disabled={busy || !enabled || (!pending && !confirmed)}
          >
            {pending ? '按原处置请求重试' : '确认合成异常处置'}
          </button>
        </form>
      )}
    </div>
  );
}

function DeliveryTimeline({ task }: { task: DeliveryLabTask }) {
  const [filter, setFilter] = useState('ALL');
  const names: Record<string, string> = {
    DISPATCH: '合成出库',
    ASSIGN: '骑手分配',
    HANDOFF: '本人接货',
    START: '配送开始',
    EXCEPTION: '异常上报',
    RESOLVE: '异常处置',
    COMPLETE: '合成送达',
  };
  const target: Record<string, string> = {
    DISPATCH: 'dispatch',
    ASSIGN: 'assignment',
    HANDOFF: 'handoff',
    START: 'journey',
    EXCEPTION: 'exception',
    RESOLVE: 'exception',
    COMPLETE: 'journey',
  };
  const rows = task.timeline.filter(
    (e) => filter === 'ALL' || e.kind === 'EXCEPTION' || e.kind === 'RESOLVE',
  );
  return (
    <section className="picking-line" aria-label="合成配送凭据时间线">
      <h3>合成配送凭据时间线</h3>
      <p>仅显示已保存凭据，按记录时间升序；同毫秒按阶段固定排序。当前资格与历史事实分别查看。</p>
      <div className="toolbar">
        <button
          className="secondary-button"
          aria-pressed={filter === 'ALL'}
          onClick={() => setFilter('ALL')}
        >
          全部凭据
        </button>
        <button
          className="secondary-button"
          aria-pressed={filter === 'EXCEPTION'}
          onClick={() => setFilter('EXCEPTION')}
        >
          异常相关凭据
        </button>
      </div>
      {!rows.length ? (
        <p role="status">暂无异常相关凭据</p>
      ) : (
        <ol>
          {rows.map((e) => (
            <li key={e.id}>
              <strong>{names[e.kind]}</strong>
              <p>
                {date(e.createdAt)} · {e.actorName}
              </p>
              {e.reason && <p>{exceptionNames[e.reason] ?? e.reason}</p>}
              <button
                className="text-button"
                onClick={() => {
                  const el = document.getElementById(task.id + '--' + target[e.kind]);
                  el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
                  el?.focus({ preventScroll: true });
                }}
              >
                定位{nameSuffix(e.kind)}
              </button>
              {e.kind === 'RESOLVE' && <p>关联原异常上报，原记录保留。</p>}
            </li>
          ))}
        </ol>
      )}
      <p>全部为隔离合成记录，不代表实物交接、顾客签收或真实支付。</p>
    </section>
  );
  function nameSuffix(kind: string) {
    return names[kind] + '凭据';
  }
}
