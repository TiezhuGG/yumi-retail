import { useEffect, useRef, useState } from 'react';
import type { Category, Product, ProductDetailsUpdate, StaffProfile } from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
import { Modal } from './modal.js';
import { usePage } from './use-page.js';

export function ProductEditor({
  id,
  profile,
  onClose,
  onSaved,
}: {
  id: string;
  profile: StaffProfile;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [product, setProduct] = useState<Product | null>(null);
  const [name, setName] = useState(''),
    [categoryId, setCategoryId] = useState(''),
    [description, setDescription] = useState('');
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [unknown, setUnknown] = useState(false),
    [conflict, setConflict] = useState(false);
  const categories = usePage<Category>('/admin/categories?limit=50');
  const sequence = useRef(0);
  const intent = useRef<{ body: ProductDetailsUpdate; key: string } | null>(null);
  async function load() {
    const token = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      const current = await staffRequest<Product>(`/admin/products/${id}`);
      if (token !== sequence.current) return;
      setProduct(current);
      setName(current.name);
      setCategoryId(current.categoryId);
      setDescription(current.description);
      intent.current = null;
      setUnknown(false);
      setConflict(false);
    } catch (e) {
      if (token === sequence.current) setError(e instanceof Error ? e.message : '商品加载失败');
    } finally {
      if (token === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [id]);
  const enabledCategory = (category: Category) =>
    category.enabled &&
    (!category.parentId || categories.items.some((p) => p.id === category.parentId && p.enabled));
  const usable = categories.items.some((c) => c.id === categoryId && enabledCategory(c));
  const changed =
    !!product &&
    (name.trim() !== product.name ||
      categoryId !== product.categoryId ||
      description.trim() !== product.description);
  async function save() {
    if (!product || busy) return;
    const attempt = intent.current ?? {
      body: {
        version: product.version,
        categoryId,
        name: name.trim(),
        description: description.trim(),
      },
      key: crypto.randomUUID(),
    };
    intent.current = attempt;
    setBusy(true);
    setError('');
    try {
      await staffRequest(`/admin/products/${id}/update-details`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': profile.csrfToken,
          'Idempotency-Key': attempt.key,
        },
        body: JSON.stringify(attempt.body),
      });
      await onSaved();
    } catch (e) {
      if (e instanceof StaffRequestError && e.status < 500) {
        intent.current = null;
        setUnknown(false);
        setConflict(e.code === 'VERSION_CONFLICT');
        setError(e.message);
      } else {
        setUnknown(true);
        setError('保存响应未能确认，原内容已保留。请使用原内容重试确认；此时不能改写提交。');
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="编辑商品资料" busy={busy} onClose={onClose}>
      {loading ? (
        <p role="status" className="empty-state">
          正在读取最新商品资料…
        </p>
      ) : !product ? (
        <div className="notice error" role="alert">
          {error}
          <button className="secondary-button" onClick={() => void load()}>
            重新读取商品
          </button>
        </div>
      ) : (
        <form
          className="business-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <p className="full notice">
            修改名称、分类和说明。已上架商品保存后会更新顾客浏览资料；规格、售价及库存保持原值。
          </p>
          <fieldset disabled={busy || unknown || conflict} style={{ display: 'contents' }}>
            <label className="full">
              商品名称
              <input
                required
                maxLength={120}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  intent.current = null;
                }}
              />
            </label>
            <label className="full">
              商品分类
              <select
                required
                value={categoryId}
                onChange={(e) => {
                  setCategoryId(e.target.value);
                  intent.current = null;
                }}
              >
                {!categories.items.some((c) => c.id === categoryId) && (
                  <option value={categoryId}>当前分类未载入，请继续加载资料</option>
                )}
                {categories.items.map((c) => (
                  <option key={c.id} value={c.id} disabled={!enabledCategory(c)}>
                    {c.parentId ? '↳ ' : ''}
                    {c.name}
                    {!enabledCategory(c) ? '（未启用或父分类未载入）' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="full">
              商品说明
              <textarea
                rows={4}
                maxLength={2000}
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  intent.current = null;
                }}
                placeholder="可留空，保存后清除原说明"
              />
            </label>
          </fieldset>
          {categories.loading && (
            <p className="full" role="status">
              正在加载可选分类…
            </p>
          )}
          {categories.error && (
            <div className="full notice error" role="alert">
              分类加载失败：{categories.error}
              <button
                type="button"
                className="secondary-button"
                disabled={busy}
                onClick={() => void categories.reload().catch(() => {})}
              >
                重试分类
              </button>
            </div>
          )}
          {categories.cursor && (
            <button
              type="button"
              className="secondary-button full"
              disabled={busy || categories.loading}
              onClick={() => void categories.next().catch(() => {})}
            >
              继续加载分类
            </button>
          )}
          <details className="full">
            <summary>规格与价格（本窗口只读）</summary>
            {product.skus.map((s) => (
              <p key={s.id}>
                {s.code} · {s.spec} / {s.unit} · ¥{(s.priceCents / 100).toFixed(2)}
              </p>
            ))}
          </details>
          {error && (
            <p className="notice error full" role="alert">
              {error}
            </p>
          )}
          {conflict && (
            <button
              type="button"
              className="secondary-button full"
              disabled={busy}
              onClick={() => void load()}
            >
              载入最新资料（替换当前填写）
            </button>
          )}
          <footer>
            <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
              关闭
            </button>
            <button
              className="primary-button"
              disabled={busy || conflict || (!unknown && (!changed || !usable || !name.trim()))}
            >
              {busy ? '正在保存…' : unknown ? '使用原内容重试确认' : '保存商品资料'}
            </button>
          </footer>
        </form>
      )}
    </Modal>
  );
}
