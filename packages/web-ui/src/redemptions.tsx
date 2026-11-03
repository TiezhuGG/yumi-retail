import { useEffect, useRef, useState } from 'react';
import type { RedemptionOrderView, RedemptionOrderPage } from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
export function RedemptionsWorkbench() {
  const [items, setItems] = useState<RedemptionOrderView[]>([]),
    [detail, setDetail] = useState<RedemptionOrderView | null>(null),
    [keyword, setKeyword] = useState(''),
    [status, setStatus] = useState(''),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const seq = useRef(0),
    applied = useRef({ keyword: '', status: '' }),
    pending = useRef<{ cursor?: string; id?: string }>({});
  async function load(intent: { cursor?: string; id?: string } = {}) {
    const n = ++seq.current;
    pending.current = intent;
    setLoading(true);
    setError('');
    try {
      if (intent.id) {
        const d = await staffRequest<RedemptionOrderView>('/admin/redemptions/' + intent.id);
        if (n === seq.current) setDetail(d);
      } else {
        const q = new URLSearchParams();
        if (applied.current.keyword) q.set('keyword', applied.current.keyword);
        if (applied.current.status) q.set('status', applied.current.status);
        if (intent.cursor) q.set('cursor', intent.cursor);
        const p = await staffRequest<RedemptionOrderPage>('/admin/redemptions?' + q);
        if (n !== seq.current) return;
        setItems((old) => (intent.cursor ? [...old, ...p.items] : p.items));
        setCursor(p.nextCursor);
        setDetail(null);
      }
    } catch (e) {
      if (n === seq.current) {
        setError(e instanceof Error ? e.message : '读取失败');
        if (e instanceof StaffRequestError && [401, 403].includes(e.status)) {
          setItems([]);
          setDetail(null);
          setCursor(null);
        }
      }
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
    <section aria-label="积分兑换订单">
      <div className="notice">
        本机开发兑换订单：积分扣账、预占与取消可追溯。核对、打包与出库可追溯，骑手分配及接货可追溯，开始配送及骑手确认送达可追溯；积分兑换不计现金销售额。
      </div>
      {detail ? (
        <div className="reward-detail">
          <button className="secondary-button" disabled={loading} onClick={() => void load()}>
            返回兑换订单列表
          </button>
          <h2>{detail.title}</h2>
          <p>
            {detail.spec} · {detail.quantity} 件
          </p>
          <p className="reward-price">{detail.totalPoints} 积分</p>
          <p>
            {detail.status === 'CANCELED'
              ? '已取消 · 已退积分'
              : detail.fulfillmentState === 'DELIVERED'
                ? '骑手已确认送达。'
                : detail.fulfillmentState === 'DELIVERING'
                  ? '骑手配送中。'
                  : detail.fulfillmentState === 'RIDER_RECEIVED_WAIT_START'
                    ? '骑手已核对接货，等待开始配送。'
                    : detail.fulfillmentState === 'ASSIGNED_WAIT_HANDOFF'
                      ? '已分配骑手，等待骑手核对接货；尚未开始配送。'
                      : detail.fulfillmentState === 'SHIPPED_WAIT_HANDOFF'
                        ? '已出库，等待骑手接货；尚未开始配送。'
                        : detail.fulfillmentState === 'PACKED_WAIT_SHIP'
                          ? '已打包，等待仓库出库；尚未配送。'
                          : detail.fulfillmentState === 'PICKED_WAIT_PACK'
                            ? '拣货已核对完成，等待打包；尚未出库或配送。'
                            : detail.fulfillmentState === 'PICKING'
                              ? '仓库已领取'
                              : detail.fulfillmentState === 'READY_TO_PICK'
                                ? '待仓库领取'
                                : detail.fulfillmentState === 'REVIEW_REQUIRED'
                                  ? '待核查'
                                  : '待创建拣货任务'}
          </p>
          <p className="redemption-order-no">兑换单号：{detail.orderNo}</p>
          <h3>实物预占凭据</h3>
          {detail.allocations?.map((a, i) => (
            <p key={i}>
              {a.batchNo} · {a.locationName}（{a.locationCode}） · {a.quantity} 件 ·{' '}
              {a.consumed ? '已出库消耗预占' : a.released ? '已释放' : '预占中'}
            </p>
          ))}
          <h3>业务动作记录</h3>
          {detail.events?.map((e, i) => (
            <p key={i}>
              {e.type === 'REDEMPTION_CREATED' ? '扣积分并创建兑换单' : '取消并退还积分'} ·{' '}
              {new Date(e.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
              （北京时间）
            </p>
          ))}
          <button
            className="secondary-button"
            disabled={loading}
            onClick={() => void load({ id: detail.id })}
          >
            刷新订单详情
          </button>
        </div>
      ) : (
        <>
          <form
            className="points-toolbar"
            onSubmit={(e) => {
              e.preventDefault();
              applied.current = { keyword: keyword.trim(), status };
              void load();
            }}
          >
            <label>
              兑换单号或商品
              <input value={keyword} maxLength={80} onChange={(e) => setKeyword(e.target.value)} />
            </label>
            <label>
              兑换单状态
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">全部状态</option>
                <option value="ACTIVE">有效兑换</option>
                <option value="CANCELED">已取消</option>
              </select>
            </label>
            <button className="primary-button" disabled={loading}>
              查询兑换单
            </button>
          </form>
          {items.length > 0 && (
            <div className="points-table-wrap">
              <table className="points-table">
                <thead>
                  <tr>
                    <th>兑换商品</th>
                    <th>数量 / 积分</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((o) => (
                    <tr key={o.id}>
                      <td>
                        {o.title}
                        <p>{o.spec}</p>
                      </td>
                      <td>
                        {o.quantity} 件 / {o.totalPoints} 积分
                      </td>
                      <td>
                        {o.status === 'CANCELED'
                          ? '已取消'
                          : o.fulfillmentState === 'DELIVERED'
                            ? '骑手已确认送达。'
                            : o.fulfillmentState === 'DELIVERING'
                              ? '骑手配送中。'
                              : o.fulfillmentState === 'RIDER_RECEIVED_WAIT_START'
                                ? '骑手已核对接货，等待开始配送。'
                                : o.fulfillmentState === 'ASSIGNED_WAIT_HANDOFF'
                                  ? '已分配骑手，等待骑手核对接货；尚未开始配送。'
                                  : o.fulfillmentState === 'SHIPPED_WAIT_HANDOFF'
                                    ? '已出库，等待骑手接货；尚未开始配送。'
                                    : o.fulfillmentState === 'PACKED_WAIT_SHIP'
                                      ? '已打包，等待仓库出库；尚未配送。'
                                      : o.fulfillmentState === 'PICKED_WAIT_PACK'
                                        ? '拣货已核对完成，等待打包；尚未出库或配送。'
                                        : o.fulfillmentState === 'PICKING'
                                          ? '仓库已领取'
                                          : o.fulfillmentState === 'READY_TO_PICK'
                                            ? '待仓库领取'
                                            : '待建任务/核查'}
                      </td>
                      <td>
                        <button
                          className="secondary-button"
                          disabled={loading}
                          onClick={() => void load({ id: o.id })}
                        >
                          查看兑换凭据
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!loading && !error && !items.length && (
            <div className="points-empty">暂无匹配兑换订单</div>
          )}
          {cursor && !error && (
            <button
              className="secondary-button"
              disabled={loading}
              onClick={() => void load({ cursor })}
            >
              加载更多
            </button>
          )}
        </>
      )}
      {loading && <p role="status">正在读取兑换订单…</p>}
      {error && (
        <div className="notice task-error" role="alert">
          {error}
          <button
            className="secondary-button"
            disabled={loading}
            onClick={() => void load(pending.current)}
          >
            重试读取
          </button>
          <button className="secondary-button" disabled={loading} onClick={() => void load()}>
            重新查询
          </button>
        </div>
      )}
    </section>
  );
}
