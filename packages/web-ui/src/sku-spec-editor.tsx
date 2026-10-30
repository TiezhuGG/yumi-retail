import { useEffect, useRef, useState } from 'react';
import type { Product, SkuSpecUpdate, StaffProfile } from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
import { Modal } from './modal.js';

export function SkuSpecEditor({
  id,
  skuId,
  profile,
  onClose,
  onSaved,
}: {
  id: string;
  skuId: string;
  profile: StaffProfile;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [product, setProduct] = useState<Product | null>(null),
    [spec, setSpec] = useState('');
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [unknown, setUnknown] = useState(false),
    [conflict, setConflict] = useState(false);
  const sequence = useRef(0),
    intent = useRef<{ body: SkuSpecUpdate; key: string } | null>(null);
  async function load() {
    const token = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      const current = await staffRequest<Product>(`/admin/products/${id}`);
      if (token !== sequence.current) return;
      const sku = current.skus.find((s) => s.id === skuId);
      if (!sku) throw Error('该规格不存在，请关闭并刷新商品列表');
      setProduct(current);
      setSpec(sku.spec);
      intent.current = null;
      setUnknown(false);
      setConflict(false);
    } catch (e) {
      if (token === sequence.current) setError(e instanceof Error ? e.message : '规格加载失败');
    } finally {
      if (token === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, [id, skuId]);
  const sku = product?.skus.find((s) => s.id === skuId);
  async function save() {
    if (!product || busy || (!unknown && !spec.trim())) return;
    const attempt = intent.current ?? {
      body: { version: product.version, spec: spec.trim() },
      key: crypto.randomUUID(),
    };
    intent.current = attempt;
    setBusy(true);
    setError('');
    try {
      await staffRequest(`/admin/products/${id}/skus/${skuId}/update-spec`, {
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
        setError('保存响应未能确认。原内容已冻结，请使用原内容重试确认。');
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="编辑规格说明" busy={busy} onClose={onClose}>
      {loading ? (
        <p role="status" className="empty-state">
          正在读取最新规格说明…
        </p>
      ) : !product || !sku ? (
        <div className="notice error" role="alert">
          {error}
          <button className="secondary-button" onClick={() => void load()}>
            重新读取规格
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
          <div className="full" style={{ overflowWrap: 'anywhere', minWidth: 0 }}>
            <strong>{product.name}</strong>
            <p>
              {sku.code} · 计量单位：{sku.unit}
            </p>
            <span className={`badge ${sku.enabled ? 'green' : 'amber'}`}>
              {sku.enabled ? '规格已启用' : '规格已停用'}
            </span>
          </div>
          <p className="notice full">
            仅更正同一件商品的展示文字，不改变包装数量或实物规格；包装变化请新建SKU。保存后顾客和仓储页面读取新说明，编码、单位、售价、库存及历史成本保持原值。
          </p>
          <label className="full">
            规格说明
            <input
              required
              maxLength={100}
              value={spec}
              disabled={busy || unknown || conflict}
              onChange={(e) => {
                setSpec(e.target.value);
                intent.current = null;
              }}
              placeholder="例如 3包装（原包装）"
            />
          </label>
          <p className="full">
            售价 ¥{(sku.priceCents / 100).toFixed(2)} ·{' '}
            {sku.expiryManaged ? '管理效期' : '不管理效期'}（本窗口只读）
          </p>
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
              disabled={
                busy || conflict || (!unknown && (!spec.trim() || spec.trim() === sku.spec))
              }
            >
              {busy ? '正在保存…' : unknown ? '使用原内容重试确认' : '保存规格说明'}
            </button>
          </footer>
        </form>
      )}
    </Modal>
  );
}
