import { useEffect, useRef, useState } from 'react';
import type { Product, SkuBarcodeUpdate, StaffProfile } from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
import { Modal } from './modal.js';

export function SkuBarcodeEditor({
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
    [barcode, setBarcode] = useState('');
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [unknown, setUnknown] = useState(false),
    [conflict, setConflict] = useState(false);
  const sequence = useRef(0),
    intent = useRef<{ body: SkuBarcodeUpdate; key: string } | null>(null);
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
      setBarcode(sku.barcode ?? '');
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
    if (!product || busy || (!unknown && !/^[0-9]{0,64}$/.test(barcode.trim()))) return;
    const attempt = intent.current ?? {
      body: { version: product.version, barcode: barcode.trim() || null },
      key: crypto.randomUUID(),
    };
    intent.current = attempt;
    setBusy(true);
    setError('');
    try {
      await staffRequest(`/admin/products/${id}/skus/${skuId}/set-barcode`, {
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
    <Modal title="维护商品条码" busy={busy} onClose={onClose}>
      {loading ? (
        <p role="status" className="empty-state">
          正在读取最新商品条码…
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
            一个SKU绑定一条数字条码，1–64位，保留前导零。全目录不能重复，停用规格仍保留绑定；留空并保存可清空。只维护标识，不改变商品、库存及成本。本轮未接入扫码设备或校验位校验。
          </p>
          <label className="full">
            商品条码
            <input
              inputMode="numeric"
              aria-invalid={!/^[0-9]{0,64}$/.test(barcode.trim())}
              value={barcode}
              disabled={busy || unknown || conflict}
              onChange={(e) => {
                setBarcode(e.target.value);
                setError('');
                intent.current = null;
              }}
              placeholder="未设置，留空保存可清空"
            />
          </label>
          {!/^[0-9]{0,64}$/.test(barcode.trim()) && (
            <p className="notice error full" role="alert">
              条码仅支持1–64位数字，请核对输入。
            </p>
          )}
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
                busy ||
                conflict ||
                (!unknown &&
                  (!/^[0-9]{0,64}$/.test(barcode.trim()) ||
                    (barcode.trim() || null) === (sku.barcode ?? null)))
              }
            >
              {busy ? '正在保存…' : unknown ? '使用原内容重试确认' : '保存条码'}
            </button>
          </footer>
        </form>
      )}
    </Modal>
  );
}
