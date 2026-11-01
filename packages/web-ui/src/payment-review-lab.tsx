import { PaymentEvidenceTimelinePanel } from './payment-evidence-timeline.js';
import { useEffect, useRef, useState } from 'react';
import type {
  PaymentReviewList,
  PaymentReviewDetail,
  PaymentReviewNote,
  StaffProfile,
  WarehouseSummary,
} from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
export function PaymentReviewLabWorkbench({ profile }: { profile: StaffProfile }) {
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
        仅核查合成未知、冲突或查询耗尽记录。备注只保留核查过程，不改变证据、任务或真实支付状态。
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
          <ReviewsPanel key={warehouseId} warehouseId={warehouseId} profile={profile} />
        </>
      )}
    </div>
  );
}
const evidenceLabel: Record<string, string> = {
  NONE: '尚无结果',
  UNKNOWN: '结果未知',
  CONFLICT: '结果冲突',
  CLOSED: '合成关闭待核对',
  SUCCEEDED: '合成成功待核对',
};
const taskLabel: Record<string, string> = {
  RETRY: '等待重试',
  LEASED: '租约已领取',
  DONE: '自动查询已停止',
  EXHAUSTED: '查询已耗尽',
  REVIEW: '分类要求人工核查',
};
function ReviewsPanel({ warehouseId, profile }: { warehouseId: string; profile: StaffProfile }) {
  const [data, setData] = useState<PaymentReviewList | null>(null),
    [filter, setFilter] = useState('ALL'),
    [detail, setDetail] = useState<PaymentReviewDetail | null>(null),
    [draft, setDraft] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [stale, setStale] = useState(false);
  const seq = useRef(0),
    active = useRef(false),
    pending = useRef<{
      id: string;
      key: string;
      note: string;
      attemptVersion: number;
      jobVersion: number | null;
    } | null>(null);
  const base = '/admin/payment-review-lab',
    query = '?warehouseId=' + warehouseId;
  async function load(cursor?: string) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError('');
    const n = ++seq.current;
    try {
      const r = await staffRequest<PaymentReviewList>(
        base + query + '&filter=' + filter + (cursor ? '&cursor=' + cursor : ''),
      );
      if (n === seq.current)
        setData((old) => (cursor && old ? { ...r, items: [...old.items, ...r.items] } : r));
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '待核查列表读取失败');
    } finally {
      if (n === seq.current) {
        active.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    setData(null);
    setDetail(null);
    setDraft('');
    pending.current = null;
    setMessage('');
    setStale(false);
    void load();
    return () => {
      seq.current++;
      active.current = false;
    };
  }, [warehouseId, filter]);
  async function open(id: string, cursor?: string) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    const n = ++seq.current;
    const same = detail?.item.id === id;
    if (!same) {
      setDetail(null);
      setDraft('');
      pending.current = null;
    }
    try {
      const r = await staffRequest<PaymentReviewDetail>(
        base + '/' + id + query + (cursor ? '&notesCursor=' + cursor : ''),
      );
      if (n === seq.current) {
        setDetail((old) =>
          cursor && old?.item.id === id ? { ...r, notes: [...old.notes, ...r.notes] } : r,
        );
        setStale(false);
      }
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '核查详情读取失败');
    } finally {
      if (n === seq.current) {
        active.current = false;
        setBusy(false);
      }
    }
  }
  async function save() {
    if (active.current || !data?.enabled || !detail?.item.needsReview || !draft.trim() || stale)
      return;
    active.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    const n = ++seq.current;
    const text = draft.replace(/\r\n?/g, '\n').trim();
    if (pending.current?.id !== detail.item.id || pending.current.note !== text)
      pending.current = {
        id: detail.item.id,
        key: crypto.randomUUID(),
        note: text,
        attemptVersion: detail.item.attemptVersion,
        jobVersion: detail.item.jobVersion,
      };
    const op = pending.current;
    try {
      const r = await staffRequest<{ note: PaymentReviewNote; duplicate: boolean }>(
        base + '/' + op.id + '/notes' + query,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
          body: JSON.stringify({
            key: op.key,
            note: op.note,
            attemptVersion: op.attemptVersion,
            jobVersion: op.jobVersion,
          }),
        },
      );
      pending.current = null;
      if (n !== seq.current) return;
      setDraft('');
      setMessage(
        r.duplicate
          ? '原备注已保存，未重复追加；证据及任务未改变。'
          : '核查备注已保存；没有标记支付成功或关闭异常。',
      );
      const fresh = await staffRequest<PaymentReviewDetail>(base + '/' + op.id + query);
      if (n === seq.current) setDetail(fresh);
      const list = await staffRequest<PaymentReviewList>(base + query + '&filter=' + filter);
      if (n === seq.current) setData(list);
    } catch (e) {
      if (n === seq.current) {
        if (e instanceof StaffRequestError && e.status === 409) {
          pending.current = null;
          setStale(true);
        }
        setError(
          e instanceof StaffRequestError && e.status === 409
            ? e.message
            : (e instanceof Error ? e.message : '保存结果未确认') +
                '；请刷新核查历史，或按原内容重试。',
        );
      }
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
          <h2>补偿异常核查</h2>
          <p>保留待核查记录与原始证据，备注不消除未知或冲突。</p>
        </div>
        <button className="secondary-button" disabled={busy} onClick={() => void load()}>
          刷新待核查列表
        </button>
      </div>
      <div className="toolbar">
        <label className="review-filter-field">
          核查筛选
          <select
            aria-label="核查筛选"
            value={filter}
            disabled={busy}
            onChange={(e) => setFilter(e.target.value)}
          >
            {[
              ['ALL', '全部待核查'],
              ['UNKNOWN', '结果未知'],
              ['CONFLICT', '结果冲突'],
              ['EXHAUSTED', '查询耗尽'],
              ['REVIEW', '分类待核查'],
            ].map(([value, title]) => (
              <option key={value} value={value}>
                {title}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <div className="notice task-error" role="alert">
          {error}
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void (detail ? open(detail.item.id) : load())}
          >
            刷新核查记录
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
          {busy ? '正在读取待核查记录…' : '列表暂不可用，请重试。'}
        </div>
      ) : (
        <>
          {!data.enabled && (
            <div className="notice">本机合成核查写入尚未开启，可只读查看；不能保存备注。</div>
          )}
          <section className="surface">
            <div className="service-area-list-heading">
              <h2>待核查列表</h2>
              <small>合成材料 · 非真实支付</small>
            </div>
            {data.items.length ? (
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
                      {row.taskState ? taskLabel[row.taskState] : '暂无查询任务'} · 核查备注{' '}
                      {row.noteCount} 条
                    </p>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => void open(row.id)}
                    >
                      查看核查详情
                    </button>
                  </article>
                ))}
              </div>
            ) : (
              <div className="empty-state">当前筛选下暂无待核查记录</div>
            )}
            {data.nextCursor && (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => void load(data.nextCursor!)}
              >
                加载更多待核查记录
              </button>
            )}
          </section>
          {detail && (
            <section className="surface readiness-summary payment-review-detail">
              <div className="readiness-heading">
                <div>
                  <h2>合成核查详情</h2>
                  <span className="badge amber">
                    {evidenceLabel[detail.item.evidence]} ·{' '}
                    {detail.item.taskState ? taskLabel[detail.item.taskState] : '暂无查询任务'}
                  </span>
                </div>
                <button
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => void open(detail.item.id)}
                >
                  刷新核查详情
                </button>
              </div>
              <p>
                {detail.item.needsReview
                  ? '当前仍需核查。保存备注不会停止查询、恢复订单、记账或退款。'
                  : '当前已离开待核查范围，保留既有备注，只读查看。'}
              </p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <label className="review-note-field">
                  合成核查备注
                  <textarea
                    aria-label="合成核查备注"
                    rows={4}
                    maxLength={500}
                    value={draft}
                    disabled={busy || !data.enabled || !detail.item.needsReview}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="记录合成核查过程；不要填写密钥、商户凭据或顾客联系资料"
                  />
                </label>
                <p>{draft.length} / 500 字；备注保存后不可修改，补充说明请新增备注。</p>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={
                    busy || !data.enabled || !detail.item.needsReview || !draft.trim() || stale
                  }
                >
                  {busy ? '正在处理…' : '保存核查备注'}
                </button>
              </form>
              <PaymentEvidenceTimelinePanel
                key={
                  detail.item.id +
                  ':' +
                  detail.item.attemptVersion +
                  ':' +
                  detail.item.jobVersion +
                  ':' +
                  detail.item.noteCount
                }
                warehouseId={warehouseId}
                snapshot={detail.item}
                refresh={() => void open(detail.item.id)}
                disabled={busy}
              />
            </section>
          )}
        </>
      )}
    </>
  );
}
