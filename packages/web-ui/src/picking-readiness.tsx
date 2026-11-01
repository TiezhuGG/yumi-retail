import { useEffect, useRef, useState } from 'react';
import type {
  PickingReadinessDetail,
  PickingReadinessSummary,
  WarehouseSummary,
} from '@yumi/contracts';
import { staffRequest } from './index.js';
import { usePage } from './use-page.js';
const labels: Record<string, string> = {
  READ_ONLY_PHASE: '当前为只读核验阶段，任务领取尚未开放',
  ORDER_CANCELED: '订单已取消，不可拣货',
  ORDER_NOT_ACTIVE: '订单尚未进入有效履约状态',
  PAYMENT_UNCONFIRMED: '未确认真实支付成功',
  FULFILLMENT_NOT_READY: '尚未进入待拣货状态',
  RESERVATION_RELEASED: '该分配的预占已释放',
  LOCATION_DISABLED: '分配库位已停用',
  LOT_EXPIRED: '分配批次已到期',
  STOCK_FROZEN: '该商品库存处于冻结核对中',
  RESERVATION_MISMATCH: '当前预占与订单需求不一致，需负责人核查',
};
const time = (v: string) =>
  new Date(v).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
export function PickingReadinessWorkbench() {
  const [warehouses, setWarehouses] = useState<WarehouseSummary[]>([]),
    [warehouseId, setWarehouseId] = useState(''),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const [search, setSearch] = useState(''),
    [q, setQ] = useState(''),
    [selected, setSelected] = useState<string | null>(null);
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
  const url =
    '/warehouse/picking-readiness?' + new URLSearchParams({ warehouseId, ...(q ? { q } : {}) });
  return (
    <div className="picking-workbench">
      <div className="notice">
        拣货准备 ·
        只读核验。仅查看订单资格与已分配批次库位，不代表已领取任务。合成支付及支付准备单不能作为付款证明；本页不扣库存、不展示顾客联系资料。
      </div>
      {loading ? (
        <div className="surface empty-state" role="status">
          正在读取作业仓库…
        </div>
      ) : error ? (
        <div className="notice task-error" role="alert">
          {error}
          <button onClick={() => void load()}>重试作业仓库</button>
        </div>
      ) : !warehouses.length ? (
        <div className="surface empty-state">暂无授权仓库，请联系负责人。</div>
      ) : (
        <>
          <form
            className="toolbar order-filters"
            onSubmit={(e) => {
              e.preventDefault();
              setSelected(null);
              setQ(search.trim());
            }}
          >
            <label>
              作业仓库
              <select
                aria-label="作业仓库"
                value={warehouseId}
                onChange={(e) => {
                  setSelected(null);
                  setWarehouseId(e.target.value);
                }}
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
                aria-label="备货订单号前缀"
                placeholder="输入订单号或开头部分"
                maxLength={40}
                pattern="[A-Za-z0-9]*"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
            <button className="primary-button" type="submit">
              查询备货记录
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={() => {
                setSelected(null);
                setSearch('');
                setQ('');
              }}
            >
              重置查询
            </button>
          </form>
          <div hidden={!!selected}>
            <PickingList key={url} url={url} onOpen={setSelected} />
          </div>
          {selected && (
            <PickingDetail
              key={warehouseId + selected}
              id={selected}
              warehouseId={warehouseId}
              onBack={() => setSelected(null)}
            />
          )}
        </>
      )}
    </div>
  );
}
function PickingList({ url, onOpen }: { url: string; onOpen: (id: string) => void }) {
  const page = usePage<PickingReadinessSummary>(url),
    last = useRef<'reload' | 'next'>('reload');
  function read(action: 'reload' | 'next') {
    last.current = action;
    void (action === 'reload' ? page.reload() : page.next()).catch(() => {});
  }
  return (
    <section className="surface" aria-label="备货核验记录">
      <div className="service-area-list-heading">
        <div>
          <h2>备货核验记录</h2>
          <p>已载入 {page.items.length} 笔订单；包含待付款与已取消记录，不是可领取任务数。</p>
        </div>
        <button className="secondary-button" disabled={page.loading} onClick={() => read('reload')}>
          刷新备货记录
        </button>
      </div>
      {page.error && (
        <div className="notice task-error" role="alert">
          {page.error}
          <button disabled={page.loading} onClick={() => read(last.current)}>
            重试备货记录
          </button>
        </div>
      )}
      {page.loading && !page.items.length ? (
        <div className="empty-state" role="status">
          正在读取备货记录…
        </div>
      ) : !page.items.length ? (
        <div className="empty-state">
          <h3>暂无符合条件的订单</h3>
          <p>可调整查询或稍后刷新；本页不会生成示例订单。</p>
        </div>
      ) : (
        <div className="picking-order-grid">
          {page.items.map((row) => (
            <article className="readiness-check picking-order-card" key={row.id}>
              <div>
                <h3>{row.orderNo}</h3>
                <span className="badge amber">
                  {row.status === 'CANCELED' ? '已取消' : '待付款'}
                </span>
              </div>
              <p>
                {row.itemCount} 种规格 · 合计 {row.totalQuantity} 件
              </p>
              <p>{time(row.createdAt)}</p>
              <button
                className="text-button"
                disabled={page.loading}
                onClick={() => onOpen(row.id)}
              >
                查看资格与备货清单
              </button>
            </article>
          ))}
        </div>
      )}
      {page.cursor && (
        <button className="secondary-button" disabled={page.loading} onClick={() => read('next')}>
          加载更多备货记录
        </button>
      )}
    </section>
  );
}
function PickingDetail({
  warehouseId,
  id,
  onBack,
}: {
  warehouseId: string;
  id: string;
  onBack: () => void;
}) {
  const [data, setData] = useState<PickingReadinessDetail | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const seq = useRef(0);
  async function load() {
    const n = ++seq.current;
    setLoading(true);
    setError('');
    setData(null);
    try {
      const r = await staffRequest<PickingReadinessDetail>(
        '/warehouse/picking-readiness/' + id + '?warehouseId=' + warehouseId,
      );
      if (n === seq.current) setData(r);
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '备货详情读取失败');
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      seq.current++;
    };
  }, [warehouseId, id]);
  return (
    <section className="surface" aria-label="资格与备货清单">
      <div className="service-area-list-heading">
        <div>
          <h2>资格与备货清单</h2>
          <p>刷新时重新读取资格与库存快照；本次结果不锁定库存。</p>
        </div>
        <button className="secondary-button" onClick={onBack}>
          返回备货记录
        </button>
        <button className="secondary-button" disabled={loading} onClick={() => void load()}>
          重新核验
        </button>
      </div>
      {loading ? (
        <div className="empty-state" role="status">
          正在核验订单与预占…
        </div>
      ) : error ? (
        <div className="notice task-error" role="alert">
          {error}
          <button onClick={() => void load()}>重试备货详情</button>
        </div>
      ) : (
        data && (
          <>
            <div className="picking-result">
              <h3>{data.orderNo}</h3>
              <span className="badge amber">尚不可领取</span>
              <p>核验时间：{time(data.checkedAt)}（北京时间）</p>
              <ul>
                {data.blockers.map((code) => (
                  <li key={code}>{labels[code] ?? '存在待核查问题，请联系负责人'}</li>
                ))}
              </ul>
            </div>
            <h3>按原分配查看批次与库位</h3>
            <p>
              需求使用下单时商品名称与规格；预占完整不代表已付款或允许出库。实拣、缺货处理和出库后续开放。
            </p>
            {data.items.map((item) => (
              <article className="picking-line" key={item.skuId}>
                <div className="service-area-list-heading">
                  <h3>
                    {item.name} · {item.spec}
                  </h3>
                  <span>
                    需求 {item.quantity} {item.unit} · 未释放预占 {item.activeReserved} {item.unit}
                  </span>
                </div>
                {!item.allocations.length ? (
                  <p>暂无批次分配，需核查预占。</p>
                ) : (
                  item.allocations.map((a) => (
                    <div className="picking-allocation" key={a.id}>
                      <div>
                        <strong>
                          {a.locationName} · {a.locationCode}
                        </strong>
                        <p>
                          批次 {a.batchNo} · {a.quantity} {item.unit}
                        </p>
                        <p>到期：{a.expiresAt ? time(a.expiresAt) : '未记录到期日'}</p>
                      </div>
                      <div>
                        <span className={'badge ' + (a.released ? 'amber' : 'green')}>
                          {a.released ? '预占已释放' : '预占未释放'}
                        </span>
                        {a.issues.map((code) => (
                          <p className="task-error" key={code}>
                            {labels[code] ?? '分配需核查'}
                          </p>
                        ))}
                      </div>
                    </div>
                  ))
                )}
              </article>
            ))}
          </>
        )
      )}
    </section>
  );
}
