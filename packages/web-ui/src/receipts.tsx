import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type {
  Product,
  Receipt,
  ReceiptDetail,
  ReceiptSkuLookup,
  StaffProfile,
} from '@yumi/contracts';
import { staffRequest } from './index.js';
import { ReceiptBarcodePicker } from './receipt-barcode-picker.js';
import { TaskDialog } from './task-dialog.js';
import { usePage } from './use-page.js';

const states: Record<string, string> = { DRAFT: '待审核', APPROVED: '待入库', POSTED: '已入库' };
const money = (v: number) => (v / 100).toFixed(2);
const time = (v: string | null) =>
  v ? new Date(v).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '未记录';
const totals = (r: Receipt) => ({
  quantity: r.lines.reduce((n, l) => n + l.quantity, 0),
  cost: r.lines.reduce((n, l) => n + l.quantity * l.unitCostCents, 0),
});
export function ReceiptWorkbench({
  profile,
  warehouseId,
  warehouseControl,
  warehouseLoading,
  warehouseError,
  retryWarehouses,
  onChanged,
}: {
  profile: StaffProfile;
  warehouseId: string;
  warehouseControl: ReactNode;
  warehouseLoading: boolean;
  warehouseError: string;
  retryWarehouses: () => void;
  onChanged: () => Promise<void>;
}) {
  const can = (p: string) => profile.permissions.includes(p);
  const root = `/warehouse/warehouses/${warehouseId}`;
  const rows = usePage<Receipt>(
    warehouseId && can('receipt.read') ? `${root}/receipts?limit=50` : null,
  );
  const [search, setSearch] = useState(''),
    [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false),
    [detailId, setDetailId] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const filtered = rows.items.filter(
    (r) =>
      (!filter || r.status === filter) &&
      (!search.trim() ||
        r.sourceRef.toLowerCase().includes(search.trim().toLowerCase()) ||
        r.lines.some((l) => l.batchNo.toLowerCase().includes(search.trim().toLowerCase()))),
  );
  async function refreshList() {
    setMessage('');
    await rows.reload();
  }
  async function changed() {
    const results = await Promise.allSettled([rows.reload(), onChanged()]);
    if (results.some((r) => r.status === 'rejected'))
      throw Error('单据操作已确认成功，但列表或库存刷新失败，请刷新资料核对，勿重复新建。');
  }
  if (!can('receipt.read'))
    return <div className="surface empty-state">当前账号没有收货单及采购成本读取权限。</div>;
  return (
    <section className="surface receipt-workbench">
      <div className="surface-head">
        <div>
          <h2>收货入库</h2>
          <p>一张单据一次核验，先审核，再确认入库。</p>
        </div>
        <div className="surface-head-actions">
          {warehouseControl}
          {can('receipt.write') && (
            <button
              className="primary-button"
              disabled={!warehouseId || warehouseLoading}
              onClick={() => {
                setMessage('');
                setCreating(true);
              }}
            >
              ＋ 新建收货单
            </button>
          )}
        </div>
      </div>
      {warehouseLoading ? (
        <div className="empty-state" role="status">
          正在加载授权仓库…
        </div>
      ) : warehouseError ? (
        <div className="empty-state" role="alert">
          <p>{warehouseError}</p>
          <button className="secondary-button" onClick={retryWarehouses}>
            重新加载仓库
          </button>
        </div>
      ) : !warehouseId ? (
        <div className="empty-state">暂无授权仓库，请联系负责人。</div>
      ) : (
        <>
          {message && (
            <p className="task-error" role="alert">
              {message}
            </p>
          )}
          <div className="toolbar">
            <input
              aria-label="搜索收货单"
              placeholder="搜索已载入来源说明、批次…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select
              aria-label="筛选收货状态"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="">全部状态</option>
              {Object.entries(states).map(([v, n]) => (
                <option key={v} value={v}>
                  {n}
                </option>
              ))}
            </select>
            <button
              className="secondary-button"
              disabled={rows.loading}
              onClick={() => void refreshList().catch(() => {})}
            >
              刷新收货列表
            </button>
          </div>
          <p className="receipt-scope">
            搜索和状态筛选仅针对已载入单据。按编号游标分页，不代表时间倒序。
          </p>
          {rows.loading ? (
            <div className="empty-state" role="status">
              正在加载收货单…
            </div>
          ) : rows.error ? (
            <div className="empty-state" role="alert">
              <p>{rows.error}</p>
              <button
                className="secondary-button"
                onClick={() => void refreshList().catch(() => {})}
              >
                重新加载收货单
              </button>
            </div>
          ) : !filtered.length ? (
            <div className="empty-state">
              <h3>{rows.items.length ? '没有匹配的收货单' : '尚无收货单'}</h3>
              <p>调整筛选或新建收货草稿，保存草稿不会增加库存。</p>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="data-table receipt-table">
                <thead>
                  <tr>
                    <th>来源说明 / 单号</th>
                    <th>明细 / 批次</th>
                    <th>总件数</th>
                    <th>成本合计</th>
                    <th>状态</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => (
                    <tr key={r.id}>
                      <td data-label="来源说明">
                        <strong>{r.sourceRef}</strong>
                        <small>单号尾号 {r.id.slice(-8)}</small>
                      </td>
                      <td data-label="明细 / 批次">
                        {r.lines.length} 行<small>{r.lines.map((l) => l.batchNo).join('、')}</small>
                      </td>
                      <td data-label="总件数">{totals(r).quantity} 件</td>
                      <td data-label="成本合计">¥{money(totals(r).cost)}</td>
                      <td data-label="状态">
                        <span className={`badge ${r.status === 'POSTED' ? 'green' : 'amber'}`}>
                          {states[r.status] ?? r.status}
                        </span>
                      </td>
                      <td>
                        <button className="secondary-button" onClick={() => setDetailId(r.id)}>
                          查看收货详情
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="table-footer">
            <span>
              已载入 {rows.items.length} 张 · 匹配 {filtered.length} 张
            </span>
            {rows.cursor && (
              <button
                className="secondary-button"
                disabled={rows.loading}
                onClick={() => void rows.next().catch(() => {})}
              >
                加载更多收货单
              </button>
            )}
          </div>
          {creating && (
            <ReceiptCreate
              profile={profile}
              root={root}
              onClose={() => setCreating(false)}
              onSaved={async (id) => {
                setCreating(false);
                setDetailId(id);
                try {
                  await changed();
                } catch (e) {
                  setMessage(e instanceof Error ? e.message : '列表刷新失败');
                }
              }}
            />
          )}
          {detailId && (
            <ReceiptDetails
              key={detailId}
              profile={profile}
              root={root}
              id={detailId}
              onClose={() => setDetailId(null)}
              onChanged={changed}
            />
          )}
        </>
      )}
    </section>
  );
}
interface DraftLine {
  key: string;
  skuId: string;
  batchNo: string;
  quantity: string;
  cost: string;
  producedAt: string;
  expiresAt: string;
}
const blank = (): DraftLine => ({
  key: crypto.randomUUID(),
  skuId: '',
  batchNo: '',
  quantity: '',
  cost: '',
  producedAt: '',
  expiresAt: '',
});
function cents(value: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw Error('成本请填写最多两位小数的非负金额');
  const [whole, part = ''] = value.split('.');
  const result = Number(whole) * 100 + Number(part.padEnd(2, '0'));
  if (!Number.isSafeInteger(result) || result > 100000000)
    throw Error('单件成本须在0至1000000元之间');
  return result;
}
function linePreview(l: DraftLine) {
  try {
    const q = Number(l.quantity);
    return Number.isInteger(q) && q > 0 && q <= 100000
      ? `行成本 ¥${money(q * cents(l.cost))}`
      : '填写件数与单件成本后计算行成本';
  } catch {
    return '填写有效件数与单件成本后计算行成本';
  }
}
const instant = (v: string) => (v ? new Date(`${v}+08:00`).toISOString() : null);
function ReceiptCreate({
  profile,
  root,
  onClose,
  onSaved,
}: {
  profile: StaffProfile;
  root: string;
  onClose: () => void;
  onSaved: (id: string) => Promise<void>;
}) {
  const products = usePage<Product>(
    profile.permissions.includes('catalog.read') ? '/admin/products?limit=50' : null,
  );
  const [queriedSkus, setQueriedSkus] = useState<ReceiptSkuLookup[]>([]);
  const skus = [
    ...products.items
      .flatMap((p) => p.skus.map((s) => ({ ...s, name: p.name })))
      .filter((s) => !queriedSkus.some((q) => q.id === s.id)),
    ...queriedSkus,
  ];
  const [sourceRef, setSourceRef] = useState(''),
    [lines, setLines] = useState<DraftLine[]>(() => [blank()]);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [uncertain, setUncertain] = useState(false);
  const intents = useRef(new Map<string, string>());
  function patch(key: string, field: keyof DraftLine, value: string) {
    setLines((old) => old.map((l) => (l.key === key ? { ...l, [field]: value } : l)));
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage('');
    try {
      const seen = new Set<string>();
      const body = {
        sourceRef: sourceRef.trim(),
        lines: lines.map((l) => {
          if (!l.skuId || seen.has(l.skuId))
            throw Error('每行选择不同SKU；同一SKU的多个批次请分别建单。');
          seen.add(l.skuId);
          const sku = skus.find((s) => s.id === l.skuId);
          if (!sku || !sku.enabled) throw Error('商品规格尚未载入或已停用，请刷新目录核对。');
          if (
            !l.batchNo.trim() ||
            !Number.isInteger(Number(l.quantity)) ||
            Number(l.quantity) < 1 ||
            Number(l.quantity) > 100000
          )
            throw Error('请核对批次和1至100000的整数件数。');
          if ((sku.expiryManaged || l.producedAt || l.expiresAt) && (!l.producedAt || !l.expiresAt))
            throw Error('生产与到期时间须成对填写，管理效期的商品必填。');
          return {
            skuId: l.skuId,
            batchNo: l.batchNo.trim(),
            quantity: Number(l.quantity),
            unitCostCents: cents(l.cost),
            producedAt: instant(l.producedAt),
            expiresAt: instant(l.expiresAt),
          };
        }),
      };
      const signature = JSON.stringify(body),
        key = intents.current.get(signature) ?? crypto.randomUUID();
      intents.current.set(signature, key);
      const saved = await staffRequest<Receipt>(`${root}/receipts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': profile.csrfToken,
          'Idempotency-Key': key,
        },
        body: signature,
      });
      intents.current.delete(signature);
      setUncertain(false);
      await onSaved(saved.id);
    } catch (e) {
      const unknown = e instanceof TypeError || e instanceof SyntaxError;
      setUncertain(unknown || uncertain);
      setMessage(
        unknown
          ? '暂未确认保存结果。请保持原内容，使用原意图重试查询，避免重新建单。'
          : e instanceof Error
            ? e.message
            : '保存失败，输入已保留',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <TaskDialog title="新建收货草稿" busy={busy} message="" onClose={onClose}>
      <form onSubmit={(e) => void save(e)}>
        <fieldset disabled={busy || uncertain} className="task-detail">
          <label>
            来源单号 / 说明
            <input
              required
              maxLength={100}
              value={sourceRef}
              onChange={(e) => setSourceRef(e.target.value)}
              placeholder="采购单号或合成验收说明"
            />
          </label>
          <p>
            保存仅创建草稿，不增加库存。每单最多50行，每个SKU仅一个批次；效期统一按北京时间填写。
          </p>
          {products.loading && <p role="status">正在加载收货商品…</p>}
          {products.error && (
            <div className="task-error" role="alert">
              {products.error}
              <button
                type="button"
                className="secondary-button"
                onClick={() => void products.reload().catch(() => {})}
              >
                重新加载商品
              </button>
            </div>
          )}
          {!profile.permissions.includes('catalog.read') && (
            <p>当前账号没有商品目录读取权限，请联系负责人。</p>
          )}
          {lines.map((l, index) => {
            const sku = skus.find((s) => s.id === l.skuId);
            return (
              <section
                className="receipt-draft-line"
                key={l.key}
                aria-label={`收货明细${index + 1}`}
              >
                <div className="receipt-line-head">
                  <h3>收货明细 {index + 1}</h3>
                  {lines.length > 1 && (
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setLines((old) => old.filter((row) => row.key !== l.key))}
                    >
                      移除此行
                    </button>
                  )}
                </div>
                <ReceiptBarcodePicker
                  root={root}
                  duplicateIds={lines
                    .filter((other) => other.key !== l.key)
                    .map((other) => other.skuId)}
                  onPick={(selected) => {
                    setQueriedSkus((old) => [...old.filter((s) => s.id !== selected.id), selected]);
                    patch(l.key, 'skuId', selected.id);
                  }}
                />
                <div className="business-form">
                  <label className="full">
                    收货商品
                    <select
                      required
                      value={l.skuId}
                      onChange={(e) => patch(l.key, 'skuId', e.target.value)}
                    >
                      <option value="">请选择商品与规格</option>
                      {skus.map((s) => (
                        <option
                          key={s.id}
                          value={s.id}
                          disabled={
                            !s.enabled ||
                            lines.some((other) => other.key !== l.key && other.skuId === s.id)
                          }
                        >
                          {s.name} · {s.spec} · {s.code}
                          {!s.enabled ? '（已停用）' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    供应批次
                    <input
                      required
                      maxLength={64}
                      value={l.batchNo}
                      onChange={(e) => patch(l.key, 'batchNo', e.target.value)}
                    />
                  </label>
                  <label>
                    收货数量（件）
                    <input
                      required
                      type="number"
                      min={1}
                      max={100000}
                      step={1}
                      value={l.quantity}
                      onChange={(e) => patch(l.key, 'quantity', e.target.value)}
                    />
                  </label>
                  <label>
                    单件成本（元）
                    <input
                      required
                      type="text"
                      inputMode="decimal"
                      maxLength={10}
                      pattern="[0-9]+(\.[0-9]{1,2})?"
                      value={l.cost}
                      onChange={(e) => patch(l.key, 'cost', e.target.value)}
                    />
                  </label>
                  <p className="receipt-line-cost">{linePreview(l)}</p>
                  <label>
                    生产时间（北京时间）
                    <input
                      type="datetime-local"
                      value={l.producedAt}
                      required={!!sku?.expiryManaged || !!l.expiresAt}
                      onChange={(e) => patch(l.key, 'producedAt', e.target.value)}
                    />
                  </label>
                  <label>
                    到期时间（北京时间）
                    <input
                      type="datetime-local"
                      value={l.expiresAt}
                      required={!!sku?.expiryManaged || !!l.producedAt}
                      onChange={(e) => patch(l.key, 'expiresAt', e.target.value)}
                    />
                  </label>
                </div>
                {sku?.expiryManaged && (
                  <p>此规格管理效期，生产和到期时间必填，服务端会拒绝过期批次。</p>
                )}
              </section>
            );
          })}
          {products.cursor && (
            <button
              type="button"
              className="secondary-button"
              disabled={products.loading}
              onClick={() => void products.next().catch(() => {})}
            >
              加载更多收货商品
            </button>
          )}
          <button
            type="button"
            className="secondary-button"
            disabled={lines.length >= 50}
            onClick={() => setLines((old) => [...old, blank()])}
          >
            ＋ 添加收货明细
          </button>
        </fieldset>
        <footer className="receipt-submit">
          {message && (
            <p className="task-error" role="alert">
              {message}
            </p>
          )}
          <button
            className="primary-button"
            disabled={busy || lines.some((l) => !skus.some((s) => s.id === l.skuId && s.enabled))}
          >
            {busy ? '正在保存…' : uncertain ? '使用原意图重试查询' : '保存收货草稿'}
          </button>
        </footer>
      </form>
    </TaskDialog>
  );
}
function ReceiptDetails({
  profile,
  root,
  id,
  onClose,
  onChanged,
}: {
  profile: StaffProfile;
  root: string;
  id: string;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [detail, setDetail] = useState<ReceiptDetail | null>(null),
    [loading, setLoading] = useState(true),
    [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [failed, setFailed] = useState(false),
    [verified, setVerified] = useState(false);
  const feedback = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (failed && message) feedback.current?.scrollIntoView({ block: 'nearest' });
  }, [failed, message]);
  const sequence = useRef(0),
    intents = useRef(new Map<string, string>());
  async function read() {
    const token = ++sequence.current;
    setLoading(true);
    setLoadError('');
    setVerified(false);
    try {
      const latest = await staffRequest<ReceiptDetail>(`${root}/receipts/${id}`);
      if (token === sequence.current) {
        setDetail(latest);
        setMessage('');
        setFailed(false);
      }
      return latest;
    } catch (e) {
      if (token === sequence.current) setLoadError(e instanceof Error ? e.message : '详情加载失败');
      throw e;
    } finally {
      if (token === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    void read().catch(() => {});
    return () => {
      sequence.current++;
    };
  }, [root, id]);
  async function act() {
    if (!detail || !verified) return;
    setBusy(true);
    setMessage('');
    setFailed(false);
    try {
      const suffix = detail.status === 'DRAFT' ? 'approve' : 'post';
      const signature = `${suffix}:${detail.version}`,
        key = intents.current.get(signature) ?? crypto.randomUUID();
      intents.current.set(signature, key);
      await staffRequest<Receipt>(`${root}/receipts/${id}/${suffix}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': profile.csrfToken,
          'Idempotency-Key': key,
        },
        body: JSON.stringify({ version: detail.version }),
      });
      intents.current.delete(signature);
      setVerified(false);
      try {
        const latest = await read();
        await onChanged();
        setMessage(
          latest.status === 'POSTED'
            ? '单据当前已入库，请以位置流水与库存核对结果为准。'
            : latest.status === 'APPROVED'
              ? '单据当前已审核待入库；审核动作本身不增加库存。'
              : '已查询当前单据，请按最新状态继续核验。',
        );
      } catch {
        setFailed(true);
        setMessage('单据操作已确认成功，但资料刷新失败，请刷新当前单据核对，勿重复新建。');
      }
    } catch (e) {
      setFailed(true);
      setMessage(
        e instanceof TypeError || e instanceof SyntaxError
          ? '结果暂未确认，请刷新当前单据查询；保留原操作重试会复用幂等键。'
          : e instanceof Error
            ? e.message
            : '操作失败',
      );
    } finally {
      setBusy(false);
    }
  }
  const permitted =
    detail?.status === 'DRAFT'
      ? profile.permissions.includes('receipt.approve')
      : detail?.status === 'APPROVED' && profile.permissions.includes('receipt.post');
  return (
    <TaskDialog title="收货单详情与核验" busy={busy} message="" onClose={onClose}>
      {message && (
        <p
          ref={feedback}
          className={failed ? 'task-error' : 'notice'}
          role={failed ? 'alert' : 'status'}
        >
          {message}
        </p>
      )}
      <button
        className="secondary-button"
        disabled={loading}
        onClick={() => void read().catch(() => {})}
      >
        刷新当前收货单
      </button>
      {loading ? (
        <div className="empty-state" role="status">
          正在加载收货详情…
        </div>
      ) : loadError ? (
        <div className="empty-state" role="alert">
          <p>{loadError}</p>
          <button className="secondary-button" onClick={() => void read().catch(() => {})}>
            重新加载收货详情
          </button>
        </div>
      ) : (
        detail && (
          <>
            <div className="task-summary">
              <h3>{detail.sourceRef}</h3>
              <span className={`badge ${detail.status === 'POSTED' ? 'green' : 'amber'}`}>
                {states[detail.status] ?? detail.status}
              </span>
              <p>
                {detail.lines.length} 行 · {totals(detail).quantity} 件 · 成本合计 ¥
                {money(totals(detail).cost)}
              </p>
              <p>
                创建 {time(detail.createdAt)} · 审核 {time(detail.reviewedAt)} · 入库{' '}
                {time(detail.postedAt)}
              </p>
            </div>
            <p>商品名称/规格取当前目录；批次、数量、成本和效期取本收货单。时间为北京时间。</p>
            {detail.lines.map((l, i) => (
              <section className="receipt-detail-line" key={l.id}>
                <h3>
                  {i + 1}. {l.sku.name} · {l.sku.spec}
                </h3>
                <p>
                  {l.sku.code} · 单位 {l.sku.unit}
                  {!l.sku.enabled ? ' · 当前规格已停用' : ''}
                </p>
                <dl>
                  <div>
                    <dt>供应批次</dt>
                    <dd>{l.batchNo}</dd>
                  </div>
                  <div>
                    <dt>实收数量</dt>
                    <dd>{l.quantity} 件</dd>
                  </div>
                  <div>
                    <dt>单件成本</dt>
                    <dd>¥{money(l.unitCostCents)}</dd>
                  </div>
                  <div>
                    <dt>行成本</dt>
                    <dd>¥{money(l.quantity * l.unitCostCents)}</dd>
                  </div>
                  <div>
                    <dt>生产时间</dt>
                    <dd>{time(l.producedAt)}</dd>
                  </div>
                  <div>
                    <dt>到期时间</dt>
                    <dd>{time(l.expiresAt)}</dd>
                  </div>
                </dl>
              </section>
            ))}
            {detail.status === 'POSTED' ? (
              <p className="notice">
                此单已入库，原单与流水保留；误录请使用收货纠错，不能修改或重复入库。
              </p>
            ) : (
              <p className="receipt-impact">
                {detail.status === 'DRAFT'
                  ? '审核只确认单据，不增加库存。'
                  : `确认入库将按本单 ${totals(detail).quantity} 件生成批次并进入DEFAULT默认收货位，同时记录库存与位置流水；过账后本单不可修改。`}
              </p>
            )}
            {permitted && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void act();
                }}
              >
                <label className="receipt-verification">
                  <input
                    type="checkbox"
                    required
                    checked={verified}
                    onChange={(e) => setVerified(e.target.checked)}
                  />
                  {detail.status === 'DRAFT'
                    ? '已逐行核对商品、批次、数量、成本和效期'
                    : '已核验实收货品与上述批次、数量、成本和效期'}
                </label>
                <button className="primary-button" disabled={!verified}>
                  {detail.status === 'DRAFT' ? '确认审核收货单' : '确认入库并记录库存'}
                </button>
              </form>
            )}
            {!permitted && detail.status !== 'POSTED' && (
              <p>当前账号没有此状态的审核或入库权限。</p>
            )}
            <details>
              <summary>查看内部追溯编号</summary>
              <p>收货单 {detail.id}</p>
              {detail.lines.map((l) => (
                <p key={l.id}>
                  收货行 {l.id} · 规格 {l.skuId}
                </p>
              ))}
            </details>
          </>
        )
      )}
    </TaskDialog>
  );
}
