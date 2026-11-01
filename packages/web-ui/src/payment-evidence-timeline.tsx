import { useEffect, useRef, useState } from 'react';
import type {
  PaymentEvidenceTimeline,
  PaymentEvidenceSource,
  PaymentEvidenceTimelineItem,
  PaymentReviewCase,
} from '@yumi/contracts';
import { staffRequest } from './index.js';
const sources: Record<PaymentEvidenceSource, string> = {
  ATTEMPT: '尝试证据',
  QUERY: '查询记录',
  NOTIFICATION: '通知记录',
  NOTE: '核查备注',
};
export function PaymentEvidenceTimelinePanel({
  warehouseId,
  snapshot,
  refresh,
  disabled,
}: {
  warehouseId: string;
  snapshot: PaymentReviewCase;
  refresh: () => void;
  disabled: boolean;
}) {
  const [page, setPage] = useState<PaymentEvidenceTimeline | null>(null),
    [filter, setFilter] = useState<PaymentEvidenceTimeline['filter']>('ALL'),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [target, setTarget] = useState<string | null>(null);
  const seq = useRef(0),
    active = useRef(false),
    container = useRef<HTMLElement | null>(null),
    last = useRef<{ filter: PaymentEvidenceTimeline['filter']; cursor?: string; focus?: string }>({
      filter: 'ALL',
    });
  const base = '/admin/payment-review-lab/' + snapshot.id + '/timeline?warehouseId=' + warehouseId;
  async function load(
    nextFilter: PaymentEvidenceTimeline['filter'],
    cursor?: string,
    focus?: string,
  ) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError('');
    const n = ++seq.current;
    last.current = { filter: nextFilter, cursor, focus };
    if (!cursor) {
      setFilter(nextFilter);
      setPage(null);
      setLoading(true);
      setTarget(focus ?? null);
    }
    try {
      const r = await staffRequest<PaymentEvidenceTimeline>(
        base +
          '&filter=' +
          nextFilter +
          (cursor ? '&cursor=' + encodeURIComponent(cursor) : '') +
          (focus ? '&focus=' + encodeURIComponent(focus) : ''),
      );
      if (n === seq.current) {
        setPage((old) =>
          cursor && old
            ? {
                ...r,
                focusedRef: old.focusedRef,
                items: [
                  ...old.items,
                  ...r.items.filter((x) => !old.items.some((y) => y.ref === x.ref)),
                ],
              }
            : r,
        );
        setFilter(nextFilter);
        if (!cursor) setTarget(r.focusedRef);
      }
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '证据时间线读取失败');
    } finally {
      if (n === seq.current) {
        setLoading(false);
        setBusy(false);
        active.current = false;
      }
    }
  }
  useEffect(() => {
    void load('ALL');
    return () => {
      seq.current++;
      active.current = false;
    };
  }, [warehouseId, snapshot.id]);
  useEffect(() => {
    if (!page?.focusedRef) return;
    const row = container.current?.querySelector<HTMLElement>('[aria-current="true"]');
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: 'start' });
  }, [page?.focusedRef]);
  function locate(ref: string) {
    void load('ALL', undefined, ref);
  }
  const changed =
    page &&
    (page.item.attemptVersion !== snapshot.attemptVersion ||
      page.item.jobVersion !== snapshot.jobVersion ||
      page.item.noteCount !== snapshot.noteCount);
  return (
    <section ref={container} className="evidence-timeline" aria-label="统一证据时间线">
      <div className="readiness-heading">
        <div>
          <h3>统一证据时间线</h3>
          <p>按本机记录时间从新到旧；同刻顺序只用于分页，不表示渠道因果。仅含本次合成尝试。</p>
        </div>
        <button className="secondary-button" disabled={busy} onClick={() => void load(filter)}>
          查看最新证据
        </button>
      </div>
      <label className="query-scenario">
        证据来源
        <select
          aria-label="证据来源"
          value={filter}
          disabled={busy}
          onChange={(e) => void load(e.target.value as PaymentEvidenceTimeline['filter'])}
        >
          <option value="ALL">全部来源</option>
          {Object.entries(sources).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </label>
      {changed && (
        <div className="notice">
          当前证据或备注已有更新，请刷新核查详情后保存备注。
          <button className="text-button" disabled={disabled || busy} onClick={refresh}>
            同步核查快照
          </button>
        </div>
      )}
      {error && (
        <div className="notice task-error" role="alert">
          {error}
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void load(last.current.filter, last.current.cursor, last.current.focus)}
          >
            重试时间线
          </button>
        </div>
      )}
      {loading ? (
        <div className="empty-state" role="status">
          正在读取证据时间线…
        </div>
      ) : page ? (
        <>
          {target && (
            <div className="notice" role="status">
              已定位到关联记录；下方从该记录继续向前查看。
              <button className="text-button" disabled={busy} onClick={() => void load('ALL')}>
                返回最新时间线
              </button>
            </div>
          )}
          {!page.items.length ? (
            <div className="empty-state">当前来源暂无证据记录</div>
          ) : (
            <ol className="evidence-timeline-list">
              {page.items.map((row) => (
                <EvidenceRow
                  key={row.ref}
                  row={row}
                  focused={row.ref === target}
                  busy={busy}
                  locate={locate}
                />
              ))}
            </ol>
          )}
          {page.nextCursor && (
            <button
              className="secondary-button"
              disabled={busy}
              onClick={() => void load(filter, page.nextCursor!)}
            >
              {busy ? '正在读取更多证据…' : '加载更早证据'}
            </button>
          )}
        </>
      ) : !error ? (
        <div className="empty-state">证据时间线暂不可用</div>
      ) : null}
    </section>
  );
}
function EvidenceRow({
  row,
  focused,
  busy,
  locate,
}: {
  row: PaymentEvidenceTimelineItem;
  focused: boolean;
  busy: boolean;
  locate: (ref: string) => void;
}) {
  const value = (label: string) => row.entries.find((e) => e.label === label)?.value;
  const preview =
    row.source === 'NOTE'
      ? value('核查备注')
      : row.source === 'ATTEMPT'
        ? value('合并后证据')
        : row.source === 'QUERY'
          ? [value('任务状态'), value('查询分类') !== '未记录' ? value('查询分类') : null]
              .filter(Boolean)
              .join(' · ')
          : '通知 · ' + (value('通知标识')?.slice(-8) ?? '') + ' · ' + value('固定测试金额');
  return (
    <li
      className={'evidence-timeline-row' + (focused ? ' is-focused' : '')}
      tabIndex={-1}
      data-evidence-ref={row.ref}
      aria-current={focused ? 'true' : undefined}
    >
      <div className="evidence-row-heading">
        <span className="badge">{sources[row.source]}</span>
        <time dateTime={row.createdAt}>
          {new Date(row.createdAt).toLocaleString('zh-CN', {
            timeZone: 'Asia/Shanghai',
            hour12: false,
          })}
        </time>
      </div>
      <h4>{row.title}</h4>
      {focused && <span className="badge green">当前定位</span>}
      <p className="evidence-row-preview">{preview}</p>
      <details open={focused} className="evidence-row-details">
        <summary>查看记录详情</summary>
        <dl>
          {row.entries
            .filter((entry) => !(row.source === 'NOTE' && entry.label === '核查备注'))
            .map((entry, i) => (
              <div key={i}>
                <dt>{entry.label}</dt>
                <dd>{entry.value}</dd>
              </div>
            ))}
        </dl>
      </details>
      {!!row.related.length && (
        <div className="evidence-related">
          {row.related.map((r) => (
            <button
              className="text-button"
              key={r.ref}
              disabled={busy}
              onClick={() => locate(r.ref)}
            >
              {r.label}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}
