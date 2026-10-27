import { useEffect, useRef, useState } from 'react';
import type { FormEvent, CSSProperties } from 'react';
import type {
  Category,
  Page,
  Product,
  Receipt,
  StaffProfile,
  WarehouseSummary,
} from '@yumi/contracts';
import { staffRequest } from './index.js';

const panel: CSSProperties = {
  background: '#fff',
  padding: 20,
  border: '1px solid #e4e7ec',
  borderRadius: 12,
  marginTop: 20,
};
const control: CSSProperties = {
  padding: 10,
  border: '1px solid #d0d5dd',
  borderRadius: 6,
  width: '100%',
  boxSizing: 'border-box',
  minHeight: 44,
};
const button: CSSProperties = {
  padding: '10px 16px',
  background: '#008a42',
  color: '#fff',
  border: 0,
  borderRadius: 6,
  minHeight: 44,
  cursor: 'pointer',
  margin: '8px 8px 0 0',
};
const label: CSSProperties = { display: 'block', marginTop: 12 };
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
}
export function CatalogWorkbench({ profile }: { profile: StaffProfile }) {
  const [categories, setCategories] = useState<Category[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [warehouses, setWarehouses] = useState<WarehouseSummary[]>([]);
  const [warehouseId, setWarehouseId] = useState('');
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [stock, setStock] = useState<StockRow[]>([]);
  const [stockCursor, setStockCursor] = useState<string | null>(null);
  const [selectedSku, setSelectedSku] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [categoryCursor, setCategoryCursor] = useState<string | null>(null);
  const [productCursor, setProductCursor] = useState<string | null>(null);
  const [receiptCursor, setReceiptCursor] = useState<string | null>(null);
  const intentions = useRef(new Map<string, string>());
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
    if (!id || !can('stock.read')) return;
    if (can('receipt.read')) {
      const p = await staffRequest<Page<Receipt>>(
        `/warehouse/warehouses/${id}/receipts?limit=50${cursor ? `&cursor=${cursor}` : ''}`,
      );
      setReceipts((old) => (cursor ? [...old, ...p.items] : p.items));
      setReceiptCursor(p.nextCursor);
    }
    if (!cursor) await stockPage(id);
  }
  async function stockPage(id: string, cursor?: string) {
    if (!id) return;
    const p = await staffRequest<Page<StockRow>>(
      `/warehouse/warehouses/${id}/stock?limit=50${cursor ? `&cursor=${cursor}` : ''}`,
    );
    setStock((old) => (cursor ? [...old, ...p.items] : p.items));
    setStockCursor(p.nextCursor);
  }
  useEffect(() => {
    let active = true;
    if (can('catalog.read'))
      Promise.all([categoriesPage(), productsPage()]).catch((err: Error) => {
        if (active) setMessage(err.message);
      });
    if (can('stock.read'))
      staffRequest<{ items: WarehouseSummary[] }>('/warehouse/warehouses')
        .then(({ items }) => {
          if (active) {
            setWarehouses(items);
            setWarehouseId(items[0]?.id ?? '');
          }
        })
        .catch((err: Error) => {
          if (active) setMessage(err.message);
        });
    return () => {
      active = false;
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
  if (!can('catalog.read') && !can('stock.read')) return null;
  return (
    <section>
      <h2>商品与收货工作台</h2>
      <p>金额填写整数分；收货先审核再入库。当前库存记在仓库默认货位。</p>
      {message && (
        <p role="status" style={{ padding: 12, background: '#f0fdf4' }}>
          {message}
        </p>
      )}
      <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
        {can('catalog.write') && (
          <>
            <form
              style={panel}
              onSubmit={(event) => {
                const { data, element } = form(event);
                void work(async () => {
                  await action('/admin/categories', {
                    name: data.get('name'),
                    parentId: data.get('parentId') || null,
                  });
                  element.reset();
                  await categoriesPage();
                });
              }}
            >
              <h3>新增分类</h3>
              <label style={label}>
                分类名称
                <input style={control} name="name" required maxLength={80} />
              </label>
              <label style={label}>
                父分类
                <select style={control} name="parentId">
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
              <button style={button}>保存分类</button>
            </form>
            <form
              style={panel}
              onSubmit={(event) => {
                const { data, element } = form(event);
                void work(async () => {
                  await action('/admin/products', {
                    categoryId: data.get('categoryId'),
                    name: data.get('name'),
                    description: data.get('description') || undefined,
                    skus: [
                      {
                        code: data.get('code'),
                        spec: data.get('spec'),
                        unit: data.get('unit'),
                        priceCents: Number(data.get('priceCents')),
                        expiryManaged: data.get('expiryManaged') === 'on',
                      },
                    ],
                  });
                  element.reset();
                  await productsPage();
                });
              }}
            >
              <h3>新增商品与规格</h3>
              <label style={label}>
                分类
                <select style={control} name="categoryId" required>
                  <option value="">请选择</option>
                  {categories
                    .filter((c) => c.enabled)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                </select>
              </label>
              <label style={label}>
                商品名称
                <input style={control} name="name" required maxLength={120} />
              </label>
              <label style={label}>
                商品说明
                <textarea style={control} name="description" maxLength={2000} />
              </label>
              <label style={label}>
                SKU编码
                <input
                  style={control}
                  name="code"
                  pattern="[A-Za-z0-9][A-Za-z0-9_-]*"
                  required
                  maxLength={64}
                />
              </label>
              <label style={label}>
                规格
                <input
                  style={control}
                  name="spec"
                  placeholder="例如 10只装"
                  required
                  maxLength={100}
                />
              </label>
              <label style={label}>
                单位
                <input style={control} name="unit" placeholder="例如 包" required maxLength={16} />
              </label>
              <label style={label}>
                售价（分）
                <input
                  style={control}
                  name="priceCents"
                  type="number"
                  min={1}
                  max={100000000}
                  step={1}
                  required
                />
              </label>
              <label style={label}>
                <input name="expiryManaged" type="checkbox" /> 管理生产与到期时间
              </label>
              <button style={button}>保存商品草稿</button>
            </form>
          </>
        )}
        {categoryCursor && (
          <button style={button} onClick={() => void work(() => categoriesPage(categoryCursor))}>
            加载更多分类
          </button>
        )}
        {can('catalog.read') && (
          <section style={panel}>
            <h3>商品目录</h3>
            <button style={button} onClick={() => void work(() => productsPage())}>
              刷新商品
            </button>
            {!products.length && <p>暂无商品，请先由运营创建。</p>}
            {products.map((p) => (
              <article key={p.id} style={{ borderTop: '1px solid #e4e7ec', padding: '12px 0' }}>
                <strong>{p.name}</strong> · {status[p.status] ?? p.status}
                {p.skus.map((s) => (
                  <p key={s.id}>
                    {s.code} · {s.spec} · ¥{(s.priceCents / 100).toFixed(2)}/{s.unit}
                    {s.expiryManaged ? ' · 管理效期' : ''}
                  </p>
                ))}
                {can('catalog.write') && (
                  <button
                    style={button}
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
                    {p.status === 'PUBLISHED' ? '下架商品' : '上架商品'}
                  </button>
                )}
              </article>
            ))}
            {productCursor && (
              <button style={button} onClick={() => void work(() => productsPage(productCursor))}>
                加载更多商品
              </button>
            )}
          </section>
        )}
        {can('stock.read') && (
          <section style={panel}>
            <h3>收货入库</h3>
            <label style={label}>
              作业仓库
              <select
                style={control}
                value={warehouseId}
                onChange={(event) => setWarehouseId(event.target.value)}
              >
                {warehouses.map((w) => (
                  <option value={w.id} key={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            {!warehouseId && <p>没有已授权仓库，请联系管理员。</p>}
            {can('receipt.write') && warehouseId && (
              <form
                onSubmit={(event) => {
                  const { data, element } = form(event);
                  void work(async () => {
                    const date = (name: string) =>
                      data.get(name) ? new Date(String(data.get(name))).toISOString() : null;
                    await action(`/warehouse/warehouses/${warehouseId}/receipts`, {
                      sourceRef: data.get('sourceRef'),
                      lines: [
                        {
                          skuId: data.get('skuId'),
                          batchNo: data.get('batchNo'),
                          quantity: Number(data.get('quantity')),
                          unitCostCents: Number(data.get('unitCostCents')),
                          producedAt: date('producedAt'),
                          expiresAt: date('expiresAt'),
                        },
                      ],
                    });
                    element.reset();
                    setSelectedSku('');
                    await receiptsPage(warehouseId);
                  });
                }}
              >
                <label style={label}>
                  来源单号/说明
                  <input style={control} name="sourceRef" required maxLength={100} />
                </label>
                <label style={label}>
                  收货规格
                  <select
                    style={control}
                    name="skuId"
                    required
                    value={selectedSku}
                    onChange={(event) => setSelectedSku(event.target.value)}
                  >
                    <option value="">请选择规格</option>
                    {skus
                      .filter((s) => s.enabled)
                      .map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} · {s.spec} · {s.code}
                        </option>
                      ))}
                  </select>
                </label>
                <label style={label}>
                  供应批次
                  <input style={control} name="batchNo" required maxLength={64} />
                </label>
                <label style={label}>
                  收货数量（件）
                  <input
                    style={control}
                    name="quantity"
                    type="number"
                    min={1}
                    max={100000}
                    step={1}
                    required
                  />
                </label>
                <label style={label}>
                  单件成本（分）
                  <input
                    style={control}
                    name="unitCostCents"
                    type="number"
                    min={0}
                    max={100000000}
                    step={1}
                    required
                  />
                </label>
                <label style={label}>
                  生产时间（本机时区）
                  <input
                    style={control}
                    name="producedAt"
                    type="datetime-local"
                    required={skus.find((s) => s.id === selectedSku)?.expiryManaged}
                  />
                </label>
                <label style={label}>
                  到期截止时间（本机时区）
                  <input
                    style={control}
                    name="expiresAt"
                    type="datetime-local"
                    required={skus.find((s) => s.id === selectedSku)?.expiryManaged}
                  />
                </label>
                <button style={button}>保存收货草稿</button>
              </form>
            )}
            <button style={button} onClick={() => void work(() => receiptsPage(warehouseId))}>
              刷新收货单
            </button>
            {!receipts.length && <p>暂无收货单。</p>}
            {receipts.map((r) => (
              <article key={r.id} style={{ borderTop: '1px solid #e4e7ec', padding: '12px 0' }}>
                <strong>{r.sourceRef}</strong> · {status[r.status] ?? r.status}
                <p style={{ overflowWrap: 'anywhere' }}>单号 {r.id}</p>
                {r.lines.map((line) => (
                  <p key={line.id}>
                    {skus.find((s) => s.id === line.skuId)?.name ?? line.skuId} · {line.batchNo} ·{' '}
                    {line.quantity}件 · 成本 ¥{(line.unitCostCents / 100).toFixed(2)}/件
                  </p>
                ))}
                {((r.status === 'DRAFT' && can('receipt.approve')) ||
                  (r.status === 'APPROVED' && can('receipt.post'))) && (
                  <button
                    style={button}
                    onClick={() =>
                      void work(async () => {
                        await action(
                          `/warehouse/warehouses/${warehouseId}/receipts/${r.id}/${r.status === 'DRAFT' ? 'approve' : 'post'}`,
                          { version: r.version },
                        );
                        await receiptsPage(warehouseId);
                      })
                    }
                  >
                    {r.status === 'DRAFT' ? '审核收货单' : '确认入库'}
                  </button>
                )}
              </article>
            ))}
            {receiptCursor && (
              <button
                style={button}
                onClick={() => void work(() => receiptsPage(warehouseId, receiptCursor))}
              >
                加载更多收货单
              </button>
            )}
            <h3>账面库存</h3>
            <p>实物包含占用及不可售数量，实际可售还须检查批次效期。</p>
            {!stock.length && <p>暂无入库库存。</p>}
            {stock.map((row) => (
              <article
                key={row.id}
                style={{
                  borderTop: '1px solid #e4e7ec',
                  padding: '12px 0',
                  overflowWrap: 'anywhere',
                }}
              >
                <strong>{skus.find((s) => s.id === row.skuId)?.name ?? row.skuId}</strong>
                <p>
                  实物 {row.onHand} 件 · 预占 {row.reserved} · 不可售 {row.blocked} · 安全库存{' '}
                  {row.safety}
                </p>
              </article>
            ))}
            {stockCursor && (
              <button
                style={button}
                onClick={() => void work(() => stockPage(warehouseId, stockCursor))}
              >
                加载更多库存
              </button>
            )}
          </section>
        )}
      </fieldset>
    </section>
  );
}
