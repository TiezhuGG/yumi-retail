import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Category, Product, Receipt, StaffProfile, WarehouseSummary } from '@yumi/contracts';
import { staffRequest } from './index.js';
import { InventoryWorkbench } from './inventory.js';
import { ReceiptWorkbench } from './receipts.js';
import { usePage } from './use-page.js';
import { Modal } from './modal.js';
import { ProductEditor } from './product-editor.js';
import { ProductArt } from './brand.js';
import type { WorkspaceView } from './workspace.js';

const status: Record<string, string> = {
  DRAFT: '草稿',
  APPROVED: '已审核',
  POSTED: '已入库',
  PUBLISHED: '已上架',
  UNPUBLISHED: '已下架',
};
interface StockRow {
  id: string;
  skuId: string;
  onHand: number;
  reserved: number;
  blocked: number;
  safety: number;
  activeCountId: string | null;
  inventoryHold: boolean;
}
export function CatalogWorkbench({
  profile,
  view = 'overview',
  onNavigate = () => {},
  allowedViews,
}: {
  profile: StaffProfile;
  view?: WorkspaceView;
  allowedViews?: WorkspaceView[];
  onNavigate?: (view: WorkspaceView) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [modal, setModal] = useState<'product' | 'category' | null>(null),
    [search, setSearch] = useState(''),
    [categoryFilter, setCategoryFilter] = useState(''),
    [statusFilter, setStatusFilter] = useState('');
  const [warehouses, setWarehouses] = useState<WarehouseSummary[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [warehouseLoading, setWarehouseLoading] = useState(true),
    [warehouseError, setWarehouseError] = useState('');
  const warehouseRequest = useRef(0);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const intentions = useRef(new Map<string, string>());
  const can = (permission: string) => profile.permissions.includes(permission);
  const reachable = (destination: string) =>
    !allowedViews || allowedViews.includes(destination as WorkspaceView);
  const categoryData = usePage<Category>(can('catalog.read') ? '/admin/categories?limit=50' : null);
  const productData = usePage<Product>(can('catalog.read') ? '/admin/products?limit=50' : null);
  const receiptData = usePage<Receipt>(
    warehouseId && can('receipt.read')
      ? `/warehouse/warehouses/${warehouseId}/receipts?limit=50`
      : null,
  );
  const stockData = usePage<StockRow>(
    warehouseId && can('stock.read') ? `/warehouse/warehouses/${warehouseId}/stock?limit=50` : null,
  );
  const { items: categories, cursor: categoryCursor } = categoryData;
  const { items: products, cursor: productCursor } = productData;
  const { items: receipts, cursor: receiptCursor } = receiptData;
  const { items: stock, cursor: stockCursor } = stockData;
  const categoriesPage = (cursor?: string) =>
    cursor ? categoryData.next() : categoryData.reload();
  const productsPage = (cursor?: string) => (cursor ? productData.next() : productData.reload());
  const stockPage = (_id: string, cursor?: string) =>
    cursor ? stockData.next() : stockData.reload();
  const receiptsPage = (_id: string) =>
    Promise.all([receiptData.reload(), stockData.reload()]).then(() => {});
  const skus = products.flatMap((p) => p.skus.map((s) => ({ ...s, name: p.name })));
  async function warehousesPage() {
    const token = ++warehouseRequest.current;
    setWarehouseLoading(true);
    setWarehouseError('');
    try {
      const { items } = await staffRequest<{ items: WarehouseSummary[] }>('/warehouse/warehouses');
      if (token !== warehouseRequest.current) return;
      setWarehouses(items);
      setWarehouseId((old) => (items.some((w) => w.id === old) ? old : (items[0]?.id ?? '')));
    } catch (e) {
      if (token === warehouseRequest.current)
        setWarehouseError(e instanceof Error ? e.message : '仓库加载失败');
    } finally {
      if (token === warehouseRequest.current) setWarehouseLoading(false);
    }
  }
  useEffect(() => {
    if (can('stock.read') || can('receipt.read')) void warehousesPage();
    else setWarehouseLoading(false);
    return () => {
      warehouseRequest.current++;
    };
  }, [profile]);
  useLayoutEffect(() => {
    setSearch('');
    setCategoryFilter('');
    setStatusFilter('');
    setMessage('');
    setModal(null);
    setEditingId(null);
  }, [view]);
  async function action(path: string, body: unknown) {
    const signature = path + JSON.stringify(body);
    const key = intentions.current.get(signature) ?? crypto.randomUUID();
    intentions.current.set(signature, key);
    const result = await staffRequest(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': profile.csrfToken,
        'Idempotency-Key': key,
      },
      body: JSON.stringify(body),
    });
    intentions.current.delete(signature);
    return result;
  }
  async function work(run: () => Promise<void>) {
    setBusy(true);
    setMessage('');
    setFailed(false);
    try {
      await run();
      setMessage('操作成功，数据已刷新');
    } catch (err) {
      setFailed(true);
      setMessage(err instanceof Error ? err.message : '操作失败，请刷新后重试');
    } finally {
      setBusy(false);
    }
  }
  function form(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    return { element: event.currentTarget, data: new FormData(event.currentTarget) };
  }
  if (view === 'receipts')
    return (
      <ReceiptWorkbench
        key={warehouseId}
        profile={profile}
        warehouseId={warehouseId}
        warehouseLoading={warehouseLoading}
        warehouseError={warehouseError}
        retryWarehouses={() => void warehousesPage()}
        warehouseControl={
          <select
            className="warehouse-select"
            aria-label="作业仓库"
            disabled={warehouseLoading}
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
          >
            {!warehouses.length && <option value="">暂无授权仓库</option>}
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        }
        onChanged={() => receiptsPage(warehouseId)}
      />
    );
  if (!can('catalog.read') && !can('stock.read')) return null;
  const currency = (v: number) => (v / 100).toFixed(2);
  const filteredProducts = products.filter(
    (p) =>
      (!search ||
        [p.name, ...p.skus.map((s) => s.code)].some((s) =>
          s.toLowerCase().includes(search.toLowerCase()),
        )) &&
      (!categoryFilter || p.categoryId === categoryFilter) &&
      (!statusFilter || p.status === statusFilter),
  );
  const filteredStock = stock.filter((s) => {
    const sku = skus.find((k) => k.id === s.skuId);
    return (
      !search ||
      !sku ||
      [sku?.name, sku?.code].some((v) => v?.toLowerCase().includes(search.toLowerCase()))
    );
  });
  const pending = receipts.filter((r) => r.status !== 'POSTED');
  const refresh = () =>
    work(async () => {
      await Promise.all([productsPage(), categoriesPage()]);
    });
  const warehouseControl = (
    <select
      className="warehouse-select"
      aria-label="作业仓库"
      value={warehouseId}
      disabled={warehouseLoading || !!warehouseError}
      onChange={(e) => setWarehouseId(e.target.value)}
    >
      {!warehouses.length && <option value="">暂无授权仓库</option>}
      {warehouses.map((w) => (
        <option key={w.id} value={w.id}>
          {w.name}
        </option>
      ))}
    </select>
  );
  const warehouseState = warehouseLoading
    ? '正在加载授权仓库…'
    : warehouseError || (!warehouseId ? '暂无授权仓库，请联系管理员分配。' : '');
  const warehouseNotice = warehouseState ? (
    <div className="empty-state" role={warehouseError ? 'alert' : 'status'}>
      {warehouseState}
      {warehouseError && (
        <button className="secondary-button" onClick={() => void warehousesPage()}>
          重试仓库
        </button>
      )}
    </div>
  ) : null;
  const metric = (data: { loading: boolean; error: string }, count: number, warehouse = false) =>
    warehouse && warehouseState
      ? warehouseLoading
        ? '加载中'
        : '暂不可用'
      : data.loading
        ? '加载中'
        : data.error
          ? '暂不可用'
          : count;
  function closeModal() {
    setModal(null);
  }
  return (
    <>
      {message && (
        <div role={failed ? 'alert' : 'status'} className={failed ? 'notice error' : 'notice'}>
          {message}
        </div>
      )}
      {view === 'overview' && (
        <>
          <section className="welcome-banner">
            <h2>你好，{profile.displayName}。今天也一起用心经营。</h2>
            <p>从整理商品到核对每一份收货，让邻里需要的好物都准备妥当。</p>
          </section>
          <div className="stat-grid">
            {[
              {
                title: '商品档案',
                value: metric(productData, products.length),
                hint: productCursor ? '当前已载入，仍有更多' : '已载入商品目录',
                icon: '▣',
                to: 'products',
              },
              {
                title: '已上架商品',
                value: metric(productData, products.filter((p) => p.status === 'PUBLISHED').length),
                hint: '当前已载入商品中',
                icon: '↗',
                to: 'products',
              },
              {
                title: '待处理收货',
                value: metric(receiptData, pending.length, true),
                hint: receiptCursor ? '当前已载入，仍有更多' : '已载入单据中待审核或入库',
                icon: '↓',
                to: 'receipts',
              },
              {
                title: '需关注库存',
                value: metric(
                  stockData,
                  stock.filter(
                    (s) =>
                      s.inventoryHold ||
                      s.activeCountId ||
                      s.onHand - s.reserved - s.blocked <= s.safety,
                  ).length,
                  true,
                ),
                hint: stockCursor ? '当前库存页' : '缺货、盘点或核对暂停',
                icon: '◇',
                to: 'stock',
              },
            ]
              .filter(
                (s) =>
                  reachable(s.to) &&
                  can(
                    s.to === 'receipts'
                      ? 'receipt.read'
                      : s.to === 'stock'
                        ? 'stock.read'
                        : 'catalog.read',
                  ),
              )
              .map((s) => (
                <button
                  className="stat-card"
                  style={{ textAlign: 'left', cursor: 'pointer' }}
                  key={s.title}
                  onClick={() => onNavigate(s.to as WorkspaceView)}
                >
                  <p>{s.title}</p>
                  <strong>{s.value}</strong>
                  <i>{s.icon}</i>
                  <small>{s.hint}</small>
                </button>
              ))}
          </div>
          <div className="overview-columns">
            <section className="surface">
              <div className="surface-head">
                <h2>常用功能</h2>
                <small>轻松完成日常作业</small>
              </div>
              <div className="shortcut-grid">
                {[
                  { to: 'products', title: '整理商品', icon: '▣', permission: 'catalog.read' },
                  { to: 'receipts', title: '收货入库', icon: '↓', permission: 'receipt.read' },
                  { to: 'stock', title: '查看库存', icon: '▦', permission: 'stock.read' },
                  { to: 'counts', title: '实物盘点', icon: '☑', permission: 'stock.read' },
                  { to: 'dispositions', title: '隔离报损', icon: '◇', permission: 'stock.read' },
                  { to: 'reversals', title: '收货纠错', icon: '↶', permission: 'stock.read' },
                ]
                  .filter((r) => can(r.permission) && reachable(r.to))
                  .map((r) => (
                    <button
                      key={r.to}
                      className="shortcut"
                      onClick={() => onNavigate(r.to as WorkspaceView)}
                    >
                      <span>{r.icon}</span>
                      {r.title}
                    </button>
                  ))}
              </div>
            </section>
            <section className="surface" hidden={!can('receipt.read') || !reachable('receipts')}>
              <div className="surface-head">
                <h2>收货待办</h2>
                <button className="text-button" onClick={() => onNavigate('receipts')}>
                  查看收货 →
                </button>
              </div>
              {warehouseNotice || <ListStatus data={receiptData} name="收货待办" />}
              {!warehouseState &&
                !receiptData.loading &&
                !receiptData.error &&
                (pending.length ? (
                  pending.slice(0, 5).map((r) => (
                    <div className="task-row" key={r.id}>
                      <span>{r.sourceRef}</span>
                      <span className={`badge ${r.status === 'DRAFT' ? 'amber' : 'green'}`}>
                        {status[r.status]}
                      </span>
                    </div>
                  ))
                ) : (
                  <div className="empty-state" style={{ padding: '45px 10px' }}>
                    {receiptCursor ? '当前已载入单据中暂无待办' : '✓ 暂无收货待办'}
                    <br />
                    <small>完整待办请查看收货列表</small>
                  </div>
                ))}
            </section>
          </div>
        </>
      )}
      {view === 'products' && (
        <section className="surface">
          <div className="surface-head">
            <div>
              <h2>商品列表</h2>
              <p>分类清晰，好物一目了然</p>
            </div>
            <div className="surface-head-actions">
              <button
                className="secondary-button"
                disabled={busy || productData.loading || categoryData.loading}
                onClick={() => void refresh()}
              >
                ↻ 刷新
              </button>
              {can('catalog.write') && (
                <button
                  className="primary-button"
                  onClick={() => {
                    setMessage('');
                    setModal('product');
                  }}
                >
                  ＋ 新增商品
                </button>
              )}
            </div>
          </div>
          <div className="toolbar">
            <input
              aria-label="搜索商品"
              placeholder="搜索已载入商品名称、SKU编码…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              aria-label="筛选分类"
              value={categoryFilter}
              onChange={(e) => setCategoryFilter(e.target.value)}
            >
              <option value="">全部分类</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
            <select
              aria-label="筛选状态"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
            >
              <option value="">全部状态</option>
              <option value="PUBLISHED">已上架</option>
              <option value="DRAFT">草稿</option>
              <option value="UNPUBLISHED">已下架</option>
            </select>
            <button
              className="secondary-button"
              onClick={() => {
                setSearch('');
                setCategoryFilter('');
                setStatusFilter('');
              }}
            >
              重置
            </button>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>商品信息</th>
                  <th>分类</th>
                  <th>规格 / SKU</th>
                  <th>售价</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredProducts.flatMap((p) =>
                  p.skus.map((s, i) => (
                    <tr key={s.id}>
                      <td>
                        <div className="product-cell">
                          <ProductArt name={p.name} />
                          <div>
                            <strong>{p.name}</strong>
                            <small>
                              {s.unit} · {s.expiryManaged ? '管理效期' : '常规商品'}
                            </small>
                          </div>
                        </div>
                      </td>
                      <td>{categories.find((c) => c.id === p.categoryId)?.name ?? '未载入分类'}</td>
                      <td>
                        {s.spec}
                        <small>{s.code}</small>
                      </td>
                      <td className="money">¥{currency(s.priceCents)}</td>
                      <td>
                        <span className={`badge ${p.status === 'PUBLISHED' ? 'green' : 'amber'}`}>
                          {status[p.status]}
                        </span>
                      </td>
                      <td>
                        {i === 0 && can('catalog.write') ? (
                          <div className="surface-head-actions">
                            <button
                              className="text-button"
                              disabled={busy}
                              onClick={() => {
                                setMessage('');
                                setEditingId(p.id);
                              }}
                            >
                              编辑资料
                            </button>
                            <button
                              className="text-button"
                              disabled={busy}
                              onClick={() =>
                                void work(async () => {
                                  await action(
                                    `/admin/products/${p.id}/${p.status === 'PUBLISHED' ? 'unpublish' : 'publish'}`,
                                    { version: p.version },
                                  );
                                  await productsPage();
                                })
                              }
                            >
                              {p.status === 'PUBLISHED' ? '下架' : '上架'}
                            </button>
                          </div>
                        ) : (
                          <span>—</span>
                        )}
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
          <ListStatus data={productData} name="商品" />
          <ListStatus data={categoryData} name="分类资料" />
          {!productData.loading && !productData.error && !filteredProducts.length && (
            <div className="empty-state">没有找到符合条件的商品</div>
          )}
          <div className="table-footer">
            <span>
              已载入 {products.length} 个商品 · 当前匹配 {filteredProducts.length} 个
              {productCursor ? ' · 可继续加载更多' : ''}
            </span>
            {productCursor && (
              <button
                className="secondary-button"
                disabled={busy || productData.loading}
                onClick={() => void work(() => productsPage(productCursor))}
              >
                加载更多商品
              </button>
            )}
            <small>商品图为包装示意</small>
          </div>
        </section>
      )}
      {view === 'categories' && (
        <section className="surface">
          <div className="surface-head">
            <div>
              <h2>商品分类</h2>
              <p>最多两级分类，组织清晰的商品目录</p>
            </div>
            <div className="surface-head-actions">
              <button
                className="secondary-button"
                disabled={categoryData.loading}
                onClick={() => void categoryData.reload().catch(() => {})}
              >
                ↻ 刷新分类
              </button>
              {can('catalog.write') && (
                <button
                  className="primary-button"
                  onClick={() => {
                    setMessage('');
                    setModal('category');
                  }}
                >
                  ＋ 新增分类
                </button>
              )}
            </div>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>分类名称</th>
                  <th>所属分类</th>
                  <th>层级</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <strong>
                        {c.parentId ? '↳　' : '▤　'}
                        {c.name}
                      </strong>
                    </td>
                    <td>
                      {c.parentId
                        ? (categories.find((k) => k.id === c.parentId)?.name ?? '未载入父分类')
                        : '—'}
                    </td>
                    <td>{c.parentId ? '二级分类' : '一级分类'}</td>
                    <td>
                      <span className={`badge ${c.enabled ? 'green' : ''}`}>
                        {c.enabled ? '启用' : '停用'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ListStatus data={categoryData} name="分类" />
          {!categoryData.loading && !categoryData.error && !categories.length && (
            <div className="empty-state">还没有商品分类，先为好物建立分类吧。</div>
          )}
          {categoryCursor && (
            <button
              className="secondary-button"
              disabled={busy || categoryData.loading}
              onClick={() => void work(() => categoriesPage(categoryCursor))}
            >
              加载更多分类
            </button>
          )}
        </section>
      )}
      {view === 'stock' && (
        <section className="surface">
          <div className="surface-head">
            <div>
              <h2>库存明细</h2>
              <p>实物、预占与不可售分开查看；可售还受效期和安全库存限制</p>
            </div>
            <div className="surface-head-actions">
              {warehouseControl}
              {can('receipt.read') && reachable('receipts') && (
                <button className="primary-button" onClick={() => onNavigate('receipts')}>
                  ＋ 收货入库
                </button>
              )}
            </div>
          </div>
          <div className="toolbar">
            <input
              aria-label="搜索库存"
              placeholder="搜索已载入商品名称、SKU编码…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <button
              className="secondary-button"
              disabled={busy || stockData.loading || !!warehouseState}
              onClick={() => void work(() => stockPage(warehouseId))}
            >
              ↻ 刷新库存
            </button>
          </div>
          <div className="table-wrap">
            <table className="data-table stock-table">
              <thead>
                <tr>
                  <th>商品信息</th>
                  <th>SKU编码</th>
                  <th>实物库存</th>
                  <th>预占</th>
                  <th>不可售</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {filteredStock.map((s) => {
                  const sku = skus.find((k) => k.id === s.skuId);
                  return (
                    <tr key={s.id}>
                      <td>
                        <div className="product-cell">
                          <ProductArt name={sku?.name ?? ''} />
                          <div>
                            <strong>{sku?.name ?? '未载入商品'}</strong>
                            <small>{sku?.spec}</small>
                          </div>
                        </div>
                      </td>
                      <td data-label="SKU编码">{sku?.code ?? '—'}</td>
                      <td className="money" data-label="实物库存">
                        {s.onHand}
                      </td>
                      <td data-label="预占">{s.reserved}</td>
                      <td data-label="不可售">{s.blocked}</td>
                      <td>
                        <span
                          className={`badge ${s.inventoryHold ? 'red' : s.activeCountId ? 'amber' : 'green'}`}
                        >
                          {s.inventoryHold
                            ? '核对暂停'
                            : s.activeCountId
                              ? '盘点冻结'
                              : '无盘点/核对暂停'}
                        </span>
                      </td>
                      <td>
                        <button className="text-button" onClick={() => onNavigate('locations')}>
                          查看库位
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {warehouseNotice}
          {!warehouseState && <ListStatus data={stockData} name="库存" />}
          <ListStatus data={productData} name="商品资料" />
          {productCursor && (
            <button
              className="secondary-button"
              disabled={productData.loading}
              onClick={() => void productData.next().catch(() => {})}
            >
              加载更多商品资料
            </button>
          )}
          {stock.some((s) => !skus.some((k) => k.id === s.skuId)) && (
            <p className="notice">部分商品资料尚未载入；搜索时保留这些库存，避免遗漏。</p>
          )}
          {!warehouseState && !stockData.loading && !stockData.error && !filteredStock.length && (
            <div className="empty-state">暂无匹配库存，可调整搜索条件或刷新。</div>
          )}
          <div className="table-footer">
            <span>已载入 {stock.length} 条库存</span>
            {stockCursor && (
              <button
                className="secondary-button"
                disabled={busy || stockData.loading}
                onClick={() => void work(() => stockPage(warehouseId, stockCursor))}
              >
                加载更多库存
              </button>
            )}
          </div>
        </section>
      )}
      {['locations', 'counts', 'dispositions', 'reversals'].includes(view) && (
        <>
          <div className="surface-head">
            {warehouseControl}
            <small>当前仓库的授权作业</small>
          </div>
          {warehouseNotice}
          {!warehouseState && (
            <div className="business-area">
              <InventoryWorkbench
                key={`${warehouseId}-${view}`}
                profile={profile}
                warehouseId={warehouseId}
                mode={view as 'locations' | 'counts' | 'dispositions' | 'reversals'}
                onStockChanged={() => stockPage(warehouseId)}
              />
            </div>
          )}
        </>
      )}
      {editingId && (
        <ProductEditor
          key={editingId}
          id={editingId}
          profile={profile}
          onClose={() => setEditingId(null)}
          onSaved={async () => {
            setEditingId(null);
            setFailed(false);
            setMessage('该次商品修改已确认，正在读取当前列表…');
            try {
              await productsPage();
              setMessage(
                '该次商品修改已确认，列表已读取当前资料；当前筛选可能不包含改名后的商品。',
              );
            } catch {
              setFailed(true);
              setMessage('商品修改已确认，但列表刷新失败，请刷新列表核对当前资料。');
            }
          }}
        />
      )}
      {modal && (
        <Modal
          busy={busy}
          title={modal === 'product' ? '新增商品' : '新增分类'}
          onClose={closeModal}
        >
          <form
            className="business-form"
            onSubmit={(event) => {
              const { data } = form(event);
              void work(async () => {
                if (modal === 'category') {
                  await action('/admin/categories', {
                    name: data.get('name'),
                    parentId: data.get('parentId') || null,
                  });
                  closeModal();
                  await categoriesPage().catch(() => {
                    throw new Error('分类已保存，列表刷新失败，请重试刷新。');
                  });
                } else if (modal === 'product') {
                  await action('/admin/products', {
                    categoryId: data.get('categoryId'),
                    name: data.get('name'),
                    description: data.get('description') || undefined,
                    skus: [
                      {
                        code: data.get('code'),
                        spec: data.get('spec'),
                        unit: data.get('unit'),
                        priceCents: Math.round(Number(data.get('price')) * 100),
                        expiryManaged: data.get('expiryManaged') === 'on',
                      },
                    ],
                  });
                  closeModal();
                  await productsPage().catch(() => {
                    throw new Error('商品已保存，列表刷新失败，请重试刷新。');
                  });
                }
              });
            }}
          >
            <ListStatus data={categoryData} name="可选分类" />
            {categoryCursor && (
              <button
                type="button"
                className="secondary-button"
                disabled={categoryData.loading || busy}
                onClick={() => void categoryData.next().catch(() => {})}
              >
                加载更多分类
              </button>
            )}
            <fieldset disabled={busy} style={{ display: 'contents' }}>
              {modal === 'category' ? (
                <>
                  <label className="full">
                    分类名称
                    <input name="name" required maxLength={80} />
                  </label>
                  <label className="full">
                    父分类
                    <select name="parentId">
                      <option value="">一级分类</option>
                      {categories
                        .filter((c) => !c.parentId && c.enabled)
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </select>
                  </label>
                </>
              ) : (
                <>
                  <label className="full">
                    商品名称
                    <input name="name" required maxLength={120} placeholder="例如 柔软抽纸" />
                  </label>
                  <label>
                    商品分类
                    <select name="categoryId" required>
                      <option value="">请选择分类</option>
                      {categories
                        .filter((c) => c.enabled)
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label>
                    SKU编码
                    <input
                      name="code"
                      pattern="[A-Za-z0-9][A-Za-z0-9_-]*"
                      maxLength={64}
                      required
                      placeholder="例如 PAPER-001"
                    />
                  </label>
                  <label>
                    规格
                    <input name="spec" required maxLength={100} placeholder="例如 3包装" />
                  </label>
                  <label>
                    单位
                    <input name="unit" required maxLength={16} placeholder="例如 包" />
                  </label>
                  <label>
                    售价（元）
                    <input
                      name="price"
                      type="number"
                      required
                      min="0.01"
                      max="1000000"
                      step="0.01"
                      placeholder="0.00"
                    />
                  </label>
                  <label style={{ alignSelf: 'center' }}>
                    <input name="expiryManaged" type="checkbox" /> 管理生产与到期时间
                  </label>
                  <label className="full">
                    商品说明
                    <textarea
                      name="description"
                      maxLength={2000}
                      rows={3}
                      placeholder="介绍商品的材质、用途与特点"
                    />
                  </label>
                </>
              )}
            </fieldset>
            {message && (
              <p
                role={failed ? 'alert' : 'status'}
                className={failed ? 'notice error full' : 'notice full'}
              >
                {message}
              </p>
            )}
            <footer>
              <button
                type="button"
                className="secondary-button"
                onClick={closeModal}
                disabled={busy}
              >
                取消
              </button>
              <button className="primary-button" disabled={busy}>
                {busy ? '正在保存…' : modal === 'product' ? '保存商品草稿' : '保存分类'}
              </button>
            </footer>
          </form>
        </Modal>
      )}
    </>
  );
}

function ListStatus({
  data,
  name,
}: {
  data: { loading: boolean; error: string; reload: () => Promise<void> };
  name: string;
}) {
  if (data.loading)
    return (
      <div className="empty-state" role="status">
        正在加载{name}…
      </div>
    );
  if (data.error)
    return (
      <div className="notice error" role="alert">
        {name}加载失败：{data.error}{' '}
        <button
          type="button"
          className="secondary-button"
          onClick={() => void data.reload().catch(() => {})}
        >
          重试{name}
        </button>
      </div>
    );
  return null;
}
