import { useEffect, useRef, useState } from 'react';
import type { ExpressReadiness } from '@yumi/contracts';
import { staffRequest } from './index.js';
const labels = { CONFIGURED: '已配置 / 本次核对通过', BLOCKED: '阻断', UNVERIFIED: '未验收' };
export function ExpressReadinessWorkbench() {
  const [view, setView] = useState<ExpressReadiness | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const seq = useRef(0);
  async function load() {
    const n = ++seq.current;
    setLoading(true);
    setError('');
    setView(null);
    try {
      const v = await staffRequest<ExpressReadiness>('/admin/redemption-express-readiness');
      if (n === seq.current) setView(v);
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '首发检查暂不可用');
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
    <section aria-label="积分快递首发检查">
      <div className="notice">
        <strong>当前未具备上线条件</strong>
        <p>
          本页只读取当前配置与本仓待办。已配置不代表经营验收完成，刷新不会开放交易或发布小程序。
        </p>
      </div>
      {loading && <p role="status">正在核对首发条件…</p>}
      {error && (
        <p className="notice task-error" role="alert">
          {error}
        </p>
      )}
      {view && (
        <>
          <p>
            {view.warehouseName} · 检查时间：
            {new Date(view.checkedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
            （北京时间）
          </p>
          <div className="express-readiness-metrics">
            <article>
              <span>待快递发货</span>
              <strong>{view.metrics.waiting}</strong>
            </article>
            <article>
              <span>已快递发货</span>
              <strong>{view.metrics.shipped}</strong>
            </article>
            <article>
              <span>未结束反馈</span>
              <strong>{view.metrics.openFeedback}</strong>
            </article>
            <article>
              <span>本次核对差异</span>
              <strong>
                {view.metrics.inconsistentOrders +
                  view.metrics.inconsistentFeedback +
                  view.metrics.inconsistentWaybills}
              </strong>
            </article>
          </div>
          <p>
            {view.metrics.oldestWaitingAt
              ? '最早待发订单创建于：' +
                new Date(view.metrics.oldestWaitingAt).toLocaleString('zh-CN', {
                  timeZone: 'Asia/Shanghai',
                }) +
                '（北京时间）'
              : '当前没有待快递发货订单'}
          </p>
          <p>
            订单/预占差异 {view.metrics.inconsistentOrders} · 反馈历史差异{' '}
            {view.metrics.inconsistentFeedback} · 运单归属差异 {view.metrics.inconsistentWaybills}
            。数字来自本次快照，未接外部告警。
          </p>
          <div className="express-readiness-checks">
            {view.checks.map((c) => (
              <article key={c.code} className="picking-pack-proof">
                <h3>{c.title}</h3>
                <p className={c.status === 'BLOCKED' ? 'notice task-error' : 'notice'}>
                  {labels[c.status]}
                </p>
                <p>{c.detail}</p>
              </article>
            ))}
          </div>
          <p>
            首发仅积分兑换及人工快递发货；现金支付、电子面单和骑手配送不属于本次必经流程。原配送方案保留。
          </p>
        </>
      )}
      <button className="primary-button" disabled={loading} onClick={() => void load()}>
        刷新首发检查
      </button>
    </section>
  );
}
