import { useEffect, useRef, useState } from 'react';
import type { RedemptionOrderView, RedemptionOrderPage, StaffProfile } from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
import { ExpressShippingPanel } from './express-shipping.js';
import { ExpressPolicyWorkbench } from './express-policy.js';
import { RedemptionPrintDialog } from './redemption-print.js';

const fulfillmentTabs = [
  { value: '', label: '全部兑换订单' },
  { value: 'EXPRESS_WAIT_SHIP', label: '待发货' },
  { value: 'EXPRESS_WAIT_RECEIPT', label: '待收货' },
  { value: 'EXPRESS_RECEIVED', label: '已完成' },
];
export function RedemptionsWorkbench({
  profile,
  initialFulfillment = '',
}: {
  profile: StaffProfile;
  initialFulfillment?: string;
}) {
  const [selected, setSelected] = useState<string[]>([]),
    [printIds, setPrintIds] = useState<string[] | null>(null);
  const [items, setItems] = useState<RedemptionOrderView[]>([]),
    [detail, setDetail] = useState<RedemptionOrderView | null>(null),
    [keyword, setKeyword] = useState(''),
    [status, setStatus] = useState(''),
    [fulfillment, setFulfillment] = useState(initialFulfillment),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const seq = useRef(0),
    applied = useRef({ keyword: '', status: '', fulfillment: initialFulfillment }),
    pending = useRef<{ cursor?: string; id?: string }>({});
  async function load(intent: { cursor?: string; id?: string } = {}) {
    const n = ++seq.current;
    pending.current = intent;
    setLoading(true);
    setError('');
    setPrintIds(null);
    setSelected([]);
    try {
      if (intent.id) {
        const d = await staffRequest<RedemptionOrderView>('/admin/redemptions/' + intent.id);
        if (n === seq.current) setDetail(d);
      } else {
        const q = new URLSearchParams();
        if (applied.current.keyword) q.set('keyword', applied.current.keyword);
        if (applied.current.status) q.set('status', applied.current.status);
        if (applied.current.fulfillment) q.set('fulfillment', applied.current.fulfillment);
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
        if (e instanceof StaffRequestError && [401, 403, 404].includes(e.status)) {
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
        兑换订单支持单张或批量打印配货单，用于备货核对。打印不改变发货状态，配送方式以订单记录为准；积分兑换不计现金销售额。
      </div>
      <details className="express-policy-disclosure">
        <summary>快递范围与运费配置</summary>
        <ExpressPolicyWorkbench profile={profile} />
      </details>
      {detail ? (
        <div className="reward-detail">
          <button className="secondary-button" disabled={loading} onClick={() => void load()}>
            返回兑换订单列表
          </button>
          <div className="redemption-detail-summary">
            <div>
              <small>兑换商品</small>
              <h2>{detail.title}</h2>
              <p>
                {detail.spec} · {detail.quantity} 件
              </p>
            </div>
            <p className="reward-price">{detail.totalPoints} 积分</p>
          </div>
          <p>
            {detail.executionMode === 'CONTROLLED'
              ? '受控测试订单'
              : detail.executionMode === 'PRODUCTION'
                ? '积分快递订单'
                : '本地开发订单'}
          </p>
          <p>
            {detail.status === 'CANCELED'
              ? '已取消 · 已退积分'
              : detail.deliveryMode === 'EXPRESS'
                ? detail.expressShipment
                  ? detail.expressShipment.receivedAt
                    ? '已完成 · 用户确认收货'
                    : '已快递发货 · 待收货'
                  : '待快递发货 · 商家承担运费'
                : detail.deliveryExceptionReported
                  ? '配送异常待处理'
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
          <button
            className="primary-button"
            disabled={loading || detail.status === 'CANCELED'}
            onClick={() => setPrintIds([detail.id])}
          >
            打印本单
          </button>
          {detail.deliveryMode === 'EXPRESS' && (
            <ExpressShippingPanel
              key={detail.id}
              id={detail.id}
              profile={profile}
              onShipped={() => void load({ id: detail.id })}
            />
          )}
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
        <div className="atlas-table-panel">
          <div className="express-queue-tabs" aria-label="快递订单阶段">
            {fulfillmentTabs.map(({ value, label }) => (
              <button
                key={label}
                type="button"
                aria-pressed={applied.current.fulfillment === value}
                disabled={loading}
                onClick={() => {
                  setFulfillment(value);
                  applied.current = { keyword: keyword.trim(), status, fulfillment: value };
                  setItems([]);
                  setCursor(null);
                  void load();
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <form
            className="points-toolbar"
            onSubmit={(e) => {
              e.preventDefault();
              applied.current = { keyword: keyword.trim(), status, fulfillment };
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
            <label>
              履约阶段
              <select
                aria-label="履约阶段"
                value={fulfillment}
                onChange={(e) => setFulfillment(e.target.value)}
              >
                <option value="">全部方式与阶段</option>
                <option value="EXPRESS_WAIT_SHIP">待快递发货</option>
                <option value="EXPRESS_SHIPPED">全部已发货</option>
                <option value="EXPRESS_WAIT_RECEIPT">待收货</option>
                <option value="EXPRESS_RECEIVED">已完成（用户确认）</option>
                <option value="LOCAL">原小区配送</option>
              </select>
            </label>
            <button className="primary-button" disabled={loading}>
              查询兑换单
            </button>
          </form>
          <div className="points-toolbar">
            <label>
              <input
                type="checkbox"
                aria-label="选择本页有效订单"
                disabled={loading || !items.some((o) => o.status === 'ACTIVE')}
                checked={
                  items.some((o) => o.status === 'ACTIVE') &&
                  items
                    .filter((o) => o.status === 'ACTIVE')
                    .slice(0, 20)
                    .every((o) => selected.includes(o.id))
                }
                onChange={(e) =>
                  setSelected(
                    e.target.checked
                      ? items
                          .filter((o) => o.status === 'ACTIVE')
                          .slice(0, 20)
                          .map((o) => o.id)
                      : [],
                  )
                }
              />
              选择当前列表有效订单（最多20单）
            </label>
            <span>已选 {selected.length} 单</span>
            <button
              className="primary-button"
              disabled={loading || !selected.length}
              onClick={() => setPrintIds([...selected])}
            >
              批量打印订单
            </button>
          </div>
          {items.length > 0 && (
            <div className="points-table-wrap">
              <table className="points-table">
                <thead>
                  <tr>
                    <th>选择</th>
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
                        <input
                          type="checkbox"
                          aria-label={'选择订单 ' + o.orderNo}
                          disabled={
                            loading ||
                            o.status === 'CANCELED' ||
                            (!selected.includes(o.id) && selected.length >= 20)
                          }
                          checked={selected.includes(o.id)}
                          onChange={(e) =>
                            setSelected((old) =>
                              e.target.checked ? [...old, o.id] : old.filter((id) => id !== o.id),
                            )
                          }
                        />
                      </td>
                      <td>
                        {o.title}
                        <p>{o.spec}</p>
                        <p className="redemption-order-no">{o.orderNo}</p>
                      </td>
                      <td>
                        {o.quantity} 件 / {o.totalPoints} 积分
                      </td>
                      <td>
                        <span
                          className={
                            o.status === 'CANCELED' || o.expressShipment ? 'badge' : 'badge amber'
                          }
                        >
                          {o.status === 'CANCELED'
                            ? '已取消'
                            : o.deliveryMode === 'EXPRESS'
                              ? o.expressShipment
                                ? o.expressShipment.receivedAt
                                  ? '已完成 · 用户确认收货'
                                  : '已快递发货 · 待收货'
                                : '待快递发货'
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
                        </span>
                      </td>
                      <td>
                        <button
                          className="secondary-button"
                          disabled={loading}
                          onClick={() => void load({ id: o.id })}
                        >
                          查看订单详情
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
        </div>
      )}
      {printIds && (
        <RedemptionPrintDialog
          key={printIds.join(':')}
          ids={printIds}
          profile={profile}
          onClose={() => setPrintIds(null)}
        />
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
