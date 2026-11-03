import { useEffect, useRef, useState } from 'react';
import type {
  RedemptionAfterSalesPage,
  RedemptionAfterSalesView,
  StaffProfile,
} from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
const statuses: Record<string, string> = {
  OPEN: '待处理',
  PROCESSING: '处理中',
  CLOSED: '本次反馈已结束',
};
const categories: Record<string, string> = {
  NOT_RECEIVED: '未收到商品',
  DAMAGED: '商品破损',
  WRONG_ITEM: '商品不符',
  OTHER: '其他问题',
};
type Intent = {
  key: string;
  action: 'reply' | 'close';
  body: { version: number; message: string };
};
export function RedemptionAfterSalesWorkbench({ profile }: { profile: StaffProfile }) {
  const [page, setPage] = useState<RedemptionAfterSalesPage>({ items: [], nextCursor: null }),
    [view, setView] = useState<RedemptionAfterSalesView | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [keyword, setKeyword] = useState(''),
    [status, setStatus] = useState(''),
    [message, setMessage] = useState(''),
    [action, setAction] = useState<'reply' | 'close'>('reply'),
    [confirmed, setConfirmed] = useState(false),
    [pending, setPending] = useState(false);
  const seq = useRef(0),
    writing = useRef(false),
    current = useRef<{ id?: string; cursor?: string }>({}),
    applied = useRef({ keyword: '', status: '' });
  const storage = (id: string) => 'yumi.redemption-aftersales.staff.v1:' + profile.id + ':' + id;
  function stored(id: string): Intent | null {
    const raw = sessionStorage.getItem(storage(id));
    if (!raw) return null;
    const v = JSON.parse(raw) as Intent;
    if (
      !/^[a-f0-9-]{36}$/i.test(v.key) ||
      !['reply', 'close'].includes(v.action) ||
      !v.body ||
      typeof v.body.message !== 'string'
    )
      throw Error('原处理请求无法读取，请保留并核实');
    return v;
  }
  async function load(intent: { id?: string; cursor?: string } = {}) {
    const n = ++seq.current;
    current.current = intent;
    setLoading(true);
    setError('');
    setView(null);
    setPage({ items: [], nextCursor: null });
    setMessage('');
    setConfirmed(false);
    setAction('reply');
    setPending(false);
    try {
      if (intent.id) {
        setPending(!!stored(intent.id));
        const v = await staffRequest<RedemptionAfterSalesView>(
          '/admin/redemption-after-sales/' + intent.id,
        );
        if (n === seq.current) setView(v);
      } else {
        const q = new URLSearchParams();
        if (applied.current.keyword) q.set('keyword', applied.current.keyword);
        if (applied.current.status) q.set('status', applied.current.status);
        if (intent.cursor) q.set('cursor', intent.cursor);
        const p = await staffRequest<RedemptionAfterSalesPage>(
          '/admin/redemption-after-sales?' + q,
        );
        if (n === seq.current) setPage(p);
      }
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '售后反馈读取失败');
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
  async function submit() {
    if (writing.current || !view?.ticket) return;
    writing.current = true;
    setBusy(true);
    setError('');
    const n = seq.current,
      id = view.orderId;
    try {
      const intent = stored(id) ?? {
        key: crypto.randomUUID(),
        action,
        body: { version: view.ticket.version, message: message.trim() },
      };
      sessionStorage.setItem(storage(id), JSON.stringify(intent));
      setPending(true);
      await staffRequest('/admin/redemption-after-sales/' + id + '/' + intent.action, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': profile.csrfToken,
          'Idempotency-Key': intent.key,
        },
        body: JSON.stringify(intent.body),
      });
      sessionStorage.removeItem(storage(id));
      if (n === seq.current) {
        setBusy(false);
        await load({ id });
      }
    } catch (e) {
      if (n === seq.current) {
        if (e instanceof StaffRequestError && e.status < 500) {
          sessionStorage.removeItem(storage(id));
          setPending(false);
          setView(null);
          setMessage('');
        }
        setError(e instanceof Error ? e.message : '处理结果尚未确认，请使用原请求核实');
      }
    } finally {
      writing.current = false;
      if (n === seq.current) setBusy(false);
    }
  }
  return (
    <section aria-label="兑换售后反馈">
      <p className="notice">
        用户反馈与门店回复会按时间保留。结束本次反馈后，用户仍可说明原因重新反馈。
      </p>
      {loading && <p role="status">正在读取售后反馈…</p>}
      {error && (
        <p className="notice task-error" role="alert">
          {error}
        </p>
      )}
      {current.current.id ? (
        <>
          <button
            className="secondary-button"
            disabled={loading || busy}
            onClick={() => void load()}
          >
            返回售后反馈列表
          </button>
          {view?.ticket && (
            <>
              <h2>{view.title}</h2>
              <p>
                {view.spec} · {view.quantity} 件
              </p>
              <p className="redemption-order-no">兑换单号：{view.orderNo}</p>
              <p className="notice">
                {statuses[view.ticket.status]} · {categories[view.ticket.category]}
              </p>
              <div className="after-sales-timeline">
                {view.ticket.events.map((e) => (
                  <article key={e.version} className="picking-pack-proof">
                    <h3>
                      {e.actor === 'CUSTOMER'
                        ? e.kind === 'SUBMITTED'
                          ? '用户反馈'
                          : e.kind === 'REOPENED'
                            ? '用户重新反馈'
                            : '用户补充说明'
                        : e.kind === 'CLOSED'
                          ? '门店处理说明'
                          : '门店回复'}
                    </h3>
                    <p className="after-sales-message">{e.message}</p>
                    <p className="muted">
                      {e.staffName ? e.staffName + ' · ' : ''}
                      {new Date(e.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                      （北京时间）
                    </p>
                  </article>
                ))}
              </div>
              {pending ? (
                <div className="notice">
                  <p>有一笔处理请求待核实，请使用原请求确认结果。</p>
                  <button
                    className="primary-button"
                    disabled={busy || loading}
                    onClick={() => void submit()}
                  >
                    核实原处理请求
                  </button>
                </div>
              ) : view.ticket.status === 'CLOSED' ? (
                <p>本次反馈已结束，用户需要帮助时可重新反馈。</p>
              ) : (
                <form
                  className="business-form after-sales-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (message.trim() && confirmed) void submit();
                  }}
                >
                  <h3>回复与处理</h3>
                  <label>
                    处理方式
                    <select
                      aria-label="处理方式"
                      disabled={busy || !view.enabled}
                      value={action}
                      onChange={(e) => {
                        setAction(e.target.value as 'reply' | 'close');
                        setConfirmed(false);
                      }}
                    >
                      <option value="reply">回复用户并继续处理</option>
                      <option value="close">回复并结束本次反馈</option>
                    </select>
                  </label>
                  <label>
                    回复内容
                    <textarea
                      aria-label="回复内容"
                      disabled={busy || !view.enabled}
                      maxLength={500}
                      value={message}
                      onChange={(e) => setMessage(e.target.value)}
                      placeholder="填写实际沟通或处理说明，最多500字"
                    />
                  </label>
                  <label className="express-dispatch-confirm">
                    <input
                      type="checkbox"
                      disabled={busy || !view.enabled}
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    确认将此回复展示给用户{action === 'close' ? '，并结束本次反馈' : ''}
                  </label>
                  <p>
                    此处只登记沟通结果，不会执行退积分、退货入库或补寄；请准确描述已完成的处理。
                  </p>
                  {!view.enabled && <p className="notice">售后反馈操作暂未开放</p>}
                  <button
                    className="primary-button"
                    disabled={busy || !view.enabled || !message.trim() || !confirmed}
                  >
                    {busy ? '正在提交…' : action === 'close' ? '回复并结束本次反馈' : '发送回复'}
                  </button>
                </form>
              )}
            </>
          )}
        </>
      ) : (
        <>
          <form
            className="business-form"
            onSubmit={(e) => {
              e.preventDefault();
              applied.current = { keyword: keyword.trim(), status };
              void load();
            }}
          >
            <label>
              订单或商品
              <input
                aria-label="订单或商品"
                maxLength={80}
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
              />
            </label>
            <label>
              反馈状态
              <select
                aria-label="反馈状态"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="">全部状态</option>
                {Object.entries(statuses).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary-button" disabled={loading}>
              查询反馈
            </button>
          </form>
          {!loading && !error && page.items.length === 0 && <p>暂无匹配售后反馈</p>}
          {page.items.length > 0 && (
            <div className="points-table-wrap">
              <table className="points-table">
                <thead>
                  <tr>
                    <th>订单 / 商品</th>
                    <th>问题类型</th>
                    <th>状态</th>
                    <th>最近更新</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {page.items.map((c) => (
                    <tr key={c.orderId}>
                      <td>
                        {c.title}
                        <br />
                        {c.orderNo}
                      </td>
                      <td>{categories[c.category]}</td>
                      <td>{statuses[c.status]}</td>
                      <td>
                        {new Date(c.updatedAt).toLocaleString('zh-CN', {
                          timeZone: 'Asia/Shanghai',
                        })}
                      </td>
                      <td>
                        <button
                          className="secondary-button"
                          disabled={loading}
                          onClick={() => void load({ id: c.orderId })}
                        >
                          查看反馈详情
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {page.nextCursor && (
            <button
              className="secondary-button"
              disabled={loading}
              onClick={() => void load({ cursor: page.nextCursor! })}
            >
              下一页反馈
            </button>
          )}
        </>
      )}
      <button
        className="secondary-button"
        disabled={loading || busy}
        onClick={() => void load(current.current)}
      >
        刷新售后反馈
      </button>
    </section>
  );
}
