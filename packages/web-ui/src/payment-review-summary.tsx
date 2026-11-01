import { useEffect, useRef, useState } from 'react';
import type { PaymentReviewFilter, PaymentReviewSummary } from '@yumi/contracts';
import { staffRequest } from './index.js';
export const reviewFilters: Array<[PaymentReviewFilter, string]> = [
  ['ALL', '全部待核查'],
  ['UNKNOWN', '结果未知'],
  ['CONFLICT', '结果冲突'],
  ['EXHAUSTED', '查询耗尽'],
  ['REVIEW', '分类待核查'],
];
export function PaymentReviewSummaryPanel({
  warehouseId,
  filter,
  disabled,
  onSelect,
}: {
  warehouseId: string;
  filter: PaymentReviewFilter;
  disabled: boolean;
  onSelect: (filter: PaymentReviewFilter) => void;
}) {
  const [summary, setSummary] = useState<PaymentReviewSummary | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const seq = useRef(0),
    running = useRef(false);
  async function load() {
    if (running.current) return;
    running.current = true;
    const n = ++seq.current;
    setLoading(true);
    setSummary(null);
    setError('');
    try {
      const data = await staffRequest<PaymentReviewSummary>(
        '/admin/payment-review-lab/summary?warehouseId=' + warehouseId,
      );
      if (seq.current === n) setSummary(data);
    } catch (e) {
      if (seq.current === n) setError(e instanceof Error ? e.message : '核查概览读取失败');
    } finally {
      if (seq.current === n) {
        setLoading(false);
        running.current = false;
      }
    }
  }
  useEffect(() => {
    void load();
    return () => {
      seq.current++;
      running.current = false;
    };
  }, [warehouseId]);
  return (
    <section className="surface review-overview" aria-label="合成核查概览" aria-busy={loading}>
      <div className="readiness-heading">
        <div>
          <h2>合成核查概览</h2>
          <p>当前仓库 · 仅合成尝试，不代表真实收款或订单</p>
        </div>
        <button className="secondary-button" disabled={loading} onClick={() => void load()}>
          刷新概览
        </button>
      </div>
      {loading ? (
        <p role="status">正在读取核查概览…</p>
      ) : error ? (
        <div className="notice task-error" role="alert">
          {error}
          <button className="text-button" onClick={() => void load()}>
            重试核查概览
          </button>
        </div>
      ) : (
        summary && (
          <>
            <div className="review-overview-grid">
              {reviewFilters.map(([value, label]) => (
                <button
                  key={value}
                  className={'review-overview-card ' + (value === filter ? 'is-selected' : '')}
                  aria-pressed={value === filter}
                  aria-controls="payment-review-list"
                  disabled={disabled}
                  onClick={() => onSelect(value)}
                >
                  <span>{label}</span>
                  <strong>
                    {summary.counts[value].toLocaleString('zh-CN')}
                    <small> 条</small>
                  </strong>
                  <span className="review-overview-action">查看记录 →</span>
                </button>
              ))}
            </div>
            {summary.counts.ALL === 0 && <p className="notice">当前仓库暂无待核查合成尝试。</p>}
            <p className="review-overview-caption">
              总数按尝试去重；四类原因可能重叠，不可相加。保存备注不会减少待核查数。
            </p>
            <p className="review-overview-caption">
              统计读取时间：
              <time dateTime={summary.generatedAt}>
                {new Date(summary.generatedAt).toLocaleString('zh-CN', {
                  timeZone: 'Asia/Shanghai',
                  hour12: false,
                })}
                （北京时间）
              </time>
              。统计为读取时快照，可刷新查看变化。
            </p>
          </>
        )
      )}
    </section>
  );
}
