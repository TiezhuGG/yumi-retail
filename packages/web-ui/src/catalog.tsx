import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  Category,
  Page,
  Product,
  Receipt,
  StaffProfile,
  WarehouseSummary,
} from '@yumi/contracts';
import { staffRequest } from './index.js';
import { InventoryWorkbench } from './inventory.js';
import { ReceiptWorkbench } from './receipts.js';
import { Modal } from './modal.js';
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
}: {
  profile: StaffProfile;
  view?: WorkspaceView;
  onNavigate?: (view: WorkspaceView) => void;
}) {
  const [modal, setModal] = useState<'product' | 'category' | null>(null),
    [search, setSearch] = useState(''),
    [categoryFilter, setCategoryFilter] = useState(''),
    [statusFilter, setStatusFilter] = useState('');
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseSummary[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [warehouseLoading, setWarehouseLoading] = useState(true),
    [warehouseError, setWarehouseError] = useState('');
  const warehouseRequest = useRef(0);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [stock, setStock] = useState<StockRow[]>([]);
  const [stockCursor, setStockCursor] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [categoryCursor, setCategoryCursor] = useState<string | null>(null);
  const [productCursor, setProductCursor] = useState<string | null>(null);
  const [receiptCursor, setReceiptCursor] = useState<string | null>(null);
  const intentions = useRef(new Map<string, string>());
  const currentWarehouse = useRef(warehouseId);
  currentWarehouse.current = warehouseId;
  const can = (permission: string) => profile.permissions.includes(permission);
  const skus = products.flatMap((p) => p.skus.map((s) => ({ ...s, name: p.name })));
  async function categoriesPage(cursor?: string) {
    const p = await staffRequest<Page<Category>>(
      `/admin/categories?limit=50${cursor ? `&cursor=${cursor}` : ''}`,
    );
    setCategories((old) => (cursor ? [...old, ...p.items] : p.items));
    setCategoryCursor(p.nextCursor);
  }
  async function productsPage(cursor?: string) {
    const p = await staffRequest<Page<Product>>(
      `/admin/products?limit=50${cursor ? `&cursor=${cursor}` : ''}`,
    );
    setProducts((old) => (cursor ? [...old, ...p.items] : p.items));
    setProductCursor(p.nextCursor);
  }
  async function receiptsPage(id: string, cursor?: string) {
    if (!id) return;
    if (can('receipt.read')) {
      const p = await staffRequest<Page<Receipt>>(
        `/warehouse/warehouses/${id}/receipts?limit=50${cursor ? `&cursor=${cursor}` : ''}`,
      );
      if (id !== currentWarehouse.current) return;
      setReceipts((old) => (cursor ? [...old, ...p.items] : p.items));
      setReceiptCursor(p.nextCursor);
    }
    if (!cursor && can('stock.read')) await stockPage(id);
  }
  async function stockPage(id: string, cursor?: string) {
    if (!id) return;
    const p = await staffRequest<Page<StockRow>>(
      `/warehouse/warehouses/${id}/stock?limit=50${cursor ? `&cursor=${cursor}` : ''}`,
    );
    if (id !== currentWarehouse.current) return;
    setStock((old) => (cursor ? [...old, ...p.items] : p.items));
    setStockCursor(p.nextCursor);
  }
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
    let active = true;
    if (can('catalog.read'))
      Promise.all([categoriesPage(), productsPage()])
        .catch((err: Error) => {
          if (active) setMessage(err.message);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    else setLoading(false);
    if (can('stock.read') || can('receipt.read')) void warehousesPage();
    else setWarehouseLoading(false);
    return () => {
      active = false;
      warehouseRequest.current++;
    };
  }, [profile]);
  useEffect(() => {
    setReceipts([]);
    setStock([]);
    setStockCursor(null);
    setReceiptCursor(null);
    receiptsPage(warehouseId).catch((err: Error) => setMessage(err.message));
  }, [warehouseId]);
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
    try {
      await run();
      setMessage('操作成功，数据已刷新');
    } catch (err) {
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
  if (loading)
    return (
      <div className="surface empty-state" role="status">
        正在准备你的工作资料…
      </div>
    );
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
      !search || [sku?.name, sku?.code].some((v) => v?.toLowerCase().includes(search.toLowerCase()))
    );
  });
  const pending = receipts.filter((r) => r.status !== 'POSTED');
  const refresh = () =>
    work(async () => {
      await Promise.all([productsPage(), categoriesPage(), receiptsPage(warehouseId)]);
    });
  const warehouseControl = (
    <select
      className="warehouse-select"
      aria-label="作业仓库"
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
  );
  function closeModal() {
    setModal(null);
  }
  return (
    <>
      {message && (
        <div role="status" className="notice">
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
                value: products.length,
                hint: productCursor ? '当前已载入，仍有更多' : '当前商品目录',
                icon: '▣',
                to: 'products',
              },
              {
                title: '已上架商品',
                value: products.filter((p) => p.status === 'PUBLISHED').length,
                hint: productCursor ? '当前已载入商品中' : '面向顾客展示',
                icon: '↗',
                to: 'products',
              },
              {
                title: '待处理收货',
                value: pending.length,
                hint: receiptCursor ? '当前已载入，仍有更多' : '待审核或待入库',
                icon: '↓',
                to: 'receipts',
              },
              {
                title: '需关注库存',
                value: stock.filter(
                  (s) =>
                    s.inventoryHold ||
                    s.activeCountId ||
                    s.onHand - s.reserved - s.blocked <= s.safety,
                ).length,
                hint: stockCursor ? '当前库存页' : '缺货、盘点或核对暂停',
                icon: '◇',
                to: 'stock',
              },
            ]
              .filter((s) =>
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
                  .filter((r) => can(r.permission))
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
            <section className="surface" hidden={!can('receipt.read')}>
              <div className="surface-head">
                <h2>收货待办</h2>
                <button className="text-button" onClick={() => onNavigate('receipts')}>
                  查看收货 →
                </button>
              </div>
              {pending.length ? (
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
                  ✓ 暂无收货待办
                  <br />
                  <small>新收货单将显示在这里</small>
                </div>
              )}
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
              <button className="secondary-button" disabled={busy} onClick={() => void refresh()}>
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
          {!filteredProducts.length && <div className="empty-state">没有找到符合条件的商品</div>}
          <div className="table-footer">
            <span>
              已载入 {products.length} 个商品 · 当前匹配 {filteredProducts.length} 个
              {productCursor ? ' · 可继续加载更多' : ''}
            </span>
            {productCursor && (
              <button
                className="secondary-button"
                disabled={busy}
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
                    <td>{categories.find((k) => k.id === c.parentId)?.name ?? '—'}</td>
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
          {!categories.length && (
            <div className="empty-state">还没有商品分类，先为好物建立分类吧。</div>
          )}
          {categoryCursor && (
            <button
              className="secondary-button"
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
              <button className="primary-button" onClick={() => onNavigate('receipts')}>
                ＋ 收货入库
              </button>
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
              disabled={busy}
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
                          {s.inventoryHold ? '核对暂停' : s.activeCountId ? '盘点冻结' : '正常'}
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
          {!filteredStock.length && (
            <div className="empty-state">暂无匹配库存，请收货入库或调整搜索条件。</div>
          )}
          <div className="table-footer">
            <span>已载入 {stock.length} 条库存</span>
            {stockCursor && (
              <button
                className="secondary-button"
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
          <div className="business-area">
            <InventoryWorkbench
              key={`${warehouseId}-${view}`}
              profile={profile}
              warehouseId={warehouseId}
              mode={view as 'locations' | 'counts' | 'dispositions' | 'reversals'}
              onStockChanged={() => stockPage(warehouseId)}
            />
          </div>
        </>
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
                  await categoriesPage();
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
                  await productsPage();
                }
                closeModal();
              });
            }}
          >
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
            {message && (
              <p role="status" className="notice full">
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
