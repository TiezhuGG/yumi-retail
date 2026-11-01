import { useEffect, useRef, useState } from 'react';
import type { AdminOrderDetail, AdminOrderSummary, WarehouseSummary } from '@yumi/contracts';
import { staffRequest } from './index.js';
import { usePage } from './use-page.js';
const money = (v: number) => '¥' + (v / 100).toFixed(2);
const time = (v: string | null) =>
  v ? new Date(v).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未记录';
const state = (row: AdminOrderSummary) =>
  row.status === 'CANCELED'
    ? row.cancelReason === 'PAYMENT_TIMEOUT'
      ? '超时取消'
      : '顾客取消'
    : '待支付';
const reason = (e: unknown) => (e instanceof Error ? e.message : '读取失败，请稍后重试');
export function OrderWorkbench() {
  const [warehouses, setWarehouses] = useState<WarehouseSummary[]>([]),
    [warehouseId, setWarehouseId] = useState(''),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const [q, setQ] = useState(''),
    [status, setStatus] = useState(''),
    [applied, setApplied] = useState({ q: '', status: '' }),
    [detail, setDetail] = useState<string | null>(null);
  const seq = useRef(0);
  async function load() {
    const n = ++seq.current;
    setLoading(true);
    setError('');
    try {
      const r = await staffRequest<{ items: WarehouseSummary[] }>('/warehouse/warehouses');
      if (n !== seq.current) return;
      setWarehouses(r.items);
      setWarehouseId((old) => (r.items.some((w) => w.id === old) ? old : (r.items[0]?.id ?? '')));
    } catch (e) {
      if (n === seq.current) setError(reason(e));
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
  const url =
    '/admin/orders?' +
    new URLSearchParams({
      warehouseId,
      ...(applied.q ? { q: applied.q } : {}),
      ...(applied.status ? { status: applied.status } : {}),
    });
  if (detail)
    return (
      <OrderDetail
        key={warehouseId + detail}
        id={detail}
        warehouseId={warehouseId}
        warehouseName={warehouses.find((w) => w.id === warehouseId)?.name ?? '当前仓库'}
        onBack={() => setDetail(null)}
      />
    );
  return (
    <div className="order-workbench">
      <div className="notice">
        当前仅提供订单与库存预占查询。支付、拣货和配送尚未开放；本页不展示顾客联系资料。
      </div>
      {loading ? (
        <div className="surface empty-state" role="status">
          正在加载授权仓库…
        </div>
      ) : error ? (
        <div className="surface empty-state" role="alert">
          {error}
          <button className="secondary-button" onClick={() => void load()}>
            重新加载仓库
          </button>
        </div>
      ) : !warehouses.length ? (
        <div className="surface empty-state">暂无授权仓库，请联系负责人。</div>
      ) : (
        <>
          <form
            className="toolbar order-filters"
            onSubmit={(e) => {
              e.preventDefault();
              setApplied({ q: q.trim(), status });
            }}
          >
            <label>
              查询仓库
              <select
                aria-label="查询仓库"
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
            <label>
              订单号
              <input
                aria-label="订单号前缀"
                placeholder="输入订单号或开头部分"
                maxLength={40}
                pattern="[A-Za-z0-9]*"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </label>
            <label>
              订单状态
              <select
                aria-label="订单状态"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                <option value="">全部状态</option>
                <option value="AWAITING_PAYMENT">待支付</option>
                <option value="CANCELED">已取消</option>
              </select>
            </label>
            <button className="primary-button" type="submit">
              查询订单
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                setQ('');
                setStatus('');
                setApplied({ q: '', status: '' });
              }}
            >
              重置筛选
            </button>
          </form>
          <OrderList key={url} url={url} onOpen={setDetail} />
        </>
      )}
    </div>
  );
}
function OrderList({ url, onOpen }: { url: string; onOpen: (id: string) => void }) {
  const rows = usePage<AdminOrderSummary>(url);
  const lastRead = useRef<'reload' | 'next'>('reload');
  function read(action: 'reload' | 'next') {
    lastRead.current = action;
    void (action === 'next' ? rows.next() : rows.reload()).catch(() => {});
  }
  const refresh = () => read('reload');
  return (
    <section className="surface">
      <div className="service-area-list-heading">
        <div>
          <h2>订单记录</h2>
          <p>按创建时间倒序，每次读取20笔。已载入 {rows.items.length} 笔，不代表全部订单。</p>
        </div>
        <button className="secondary-button" disabled={rows.loading} onClick={refresh}>
          刷新订单
        </button>
      </div>
      {rows.error && (
        <div className="notice task-error" role="alert">
          {rows.error}
          <button
            className="text-button"
            onClick={() => read(lastRead.current)}
            disabled={rows.loading}
          >
            重试读取
          </button>
        </div>
      )}
      {rows.loading && !rows.items.length ? (
        <div className="empty-state" role="status">
          正在读取订单…
        </div>
      ) : !rows.items.length ? (
        <div className="empty-state">
          <h3>{rows.error ? '订单暂时无法读取' : '没有符合条件的订单'}</h3>
          <p>可调整筛选或稍后刷新；未配置经营规则时不会产生新订单。</p>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="data-table order-table">
            <thead>
              <tr>
                <th>订单 / 创建时间</th>
                <th>商品摘要</th>
                <th>状态</th>
                <th>订单金额</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {rows.items.map((row) => (
                <tr key={row.id}>
                  <td data-label="订单">
                    <strong className="order-code">{row.orderNo}</strong>
                    <small>{time(row.createdAt)}</small>
                  </td>
                  <td data-label="商品">
                    {row.items.slice(0, 2).map((i) => (
                      <div key={i.skuId}>
                        {i.name} · {i.spec} × {i.quantity}
                        {i.unit}
                      </div>
                    ))}
                    {row.items.length > 2 && <small>另有{row.items.length - 2}种规格</small>}
                  </td>
                  <td data-label="状态">
                    <span className={'badge ' + (row.status === 'CANCELED' ? '' : 'amber')}>
                      {state(row)}
                    </span>
                    <small>尚未开始支付</small>
                  </td>
                  <td data-label="金额">
                    <strong>{money(row.payableCents)}</strong>
                    <small>含配送费 {money(row.deliveryFeeCents)}</small>
                  </td>
                  <td data-label="操作">
                    <button className="text-button" onClick={() => onOpen(row.id)}>
                      查看详情
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {rows.cursor && (
        <div className="table-footer">
          <span>还有更多订单</span>
          <button className="secondary-button" disabled={rows.loading} onClick={() => read('next')}>
            {rows.loading ? '正在读取…' : '加载更多订单'}
          </button>
        </div>
      )}
    </section>
  );
}
function OrderDetail({
  id,
  warehouseId,
  warehouseName,
  onBack,
}: {
  id: string;
  warehouseId: string;
  warehouseName: string;
  onBack: () => void;
}) {
  const [row, setRow] = useState<AdminOrderDetail | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const seq = useRef(0);
  async function load() {
    const n = ++seq.current;
    setLoading(true);
    setError('');
    setRow(null);
    try {
      const r = await staffRequest<AdminOrderDetail>(
        '/admin/orders/' + id + '?warehouseId=' + warehouseId,
      );
      if (n === seq.current) setRow(r);
    } catch (e) {
      if (n === seq.current) setError(reason(e));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      seq.current++;
    };
  }, [id, warehouseId]);
  return (
    <div className="order-workbench">
      <div className="order-detail-toolbar">
        <button className="secondary-button" onClick={onBack}>
          返回订单列表
        </button>
        <button className="secondary-button" disabled={loading} onClick={() => void load()}>
          刷新订单详情
        </button>
      </div>
      {error && (
        <div className="notice task-error" role="alert">
          {error}
          <button className="text-button" onClick={() => void load()}>
            重试详情
          </button>
        </div>
      )}
      {loading ? (
        <div className="surface empty-state" role="status">
          正在读取订单详情…
        </div>
      ) : row ? (
        <>
          <section className="surface order-summary">
            <div>
              <span className="eyebrow">ORDER DETAIL · {warehouseName}</span>
              <h2 className="order-code">{row.orderNo}</h2>
              <span className={'badge ' + (row.status === 'CANCELED' ? '' : 'amber')}>
                {state(row)}
              </span>
              <p>
                {row.status === 'CANCELED'
                  ? '原预占已释放，实物数量未扣减。'
                  : '库存已预占，尚未开始支付；当前不能进入拣货或配送。'}
              </p>
            </div>
            <div>
              <small>订单金额</small>
              <strong className="order-payable">{money(row.payableCents)}</strong>
              <small>创建：{time(row.createdAt)}</small>
              <small>预占截止：{time(row.paymentDeadline)}</small>
            </div>
          </section>
          <section className="surface">
            <div className="service-area-list-heading">
              <h2>商品与费用快照</h2>
            </div>
            <div className="order-items">
              {row.items.map((i) => (
                <div className="order-item" key={i.skuId}>
                  <div>
                    <strong>{i.name}</strong>
                    <small>
                      {i.spec} · {money(i.priceCents)}/{i.unit} × {i.quantity}
                    </small>
                  </div>
                  <strong>{money(i.lineCents)}</strong>
                </div>
              ))}
              <div className="order-totals">
                <span>商品金额 {money(row.goodsCents)}</span>
                <span>配送费 {money(row.deliveryFeeCents)}</span>
                <strong>合计 {money(row.payableCents)}</strong>
              </div>
            </div>
          </section>
          <section className="surface">
            <div className="service-area-list-heading">
              <div>
                <h2>批次与库位预占</h2>
                <p>显示本单原分配及释放记录；不代表当前库位全部库存。库位名称以当前资料为准。</p>
              </div>
            </div>
            <div className="order-allocations">
              {row.allocations.map((a) => {
                const item = row.items.find((i) => i.skuId === a.skuId);
                return (
                  <article className="order-allocation" key={a.id}>
                    <div>
                      <strong>
                        {item?.name} · {item?.spec}
                      </strong>
                      <span className={'badge ' + (a.releasedAt ? '' : 'green')}>
                        {a.releasedAt ? '已释放' : '预占中'} {a.quantity}
                        {item?.unit}
                      </span>
                    </div>
                    <dl>
                      <div>
                        <dt>批次</dt>
                        <dd>{a.batchNo}</dd>
                      </div>
                      <div>
                        <dt>库位</dt>
                        <dd>
                          {a.locationCode} · {a.locationName}
                        </dd>
                      </div>
                      <div>
                        <dt>效期</dt>
                        <dd>{a.expiresAt ? time(a.expiresAt) : '未设置效期'}</dd>
                      </div>
                      <div>
                        <dt>预占时间</dt>
                        <dd>{time(a.reservedAt)}</dd>
                      </div>
                      {a.releasedAt && (
                        <div>
                          <dt>释放时间</dt>
                          <dd>{time(a.releasedAt)}</dd>
                        </div>
                      )}
                    </dl>
                  </article>
                );
              })}
            </div>
          </section>
          <section className="surface">
            <div className="service-area-list-heading">
              <h2>订单记录</h2>
            </div>
            <ol className="order-history">
              {row.events.map((e) => (
                <li key={e.type}>
                  <strong>
                    {e.type === 'ORDER_CREATED'
                      ? '订单创建'
                      : row.cancelReason === 'PAYMENT_TIMEOUT'
                        ? '超时取消并释放'
                        : '顾客取消并释放'}
                  </strong>
                  <span>{e.actorKind === 'SYSTEM' ? '后台任务' : '顾客操作'}</span>
                  <time>{time(e.createdAt)}</time>
                </li>
              ))}
            </ol>
          </section>
          <p className="notice">
            顾客联系资料与备注受保护，本页不读取。订单查询不会改变支付、库存或履约状态。
          </p>
        </>
      ) : !error ? (
        <div className="surface empty-state">未找到订单</div>
      ) : null}
    </div>
  );
}
