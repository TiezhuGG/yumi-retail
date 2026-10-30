import { useEffect, useRef, useState } from 'react';
import type { Product, StaffProfile } from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
import { Modal } from './modal.js';

// Parse decimal text without floating point rounding (e.g. 0.29 -> 29).
function cents(value: string): number | null {
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return amount >= 1 && amount <= 100000000 ? amount : null;
}
type Action = 'set-price' | 'enable' | 'disable';
export function SkuEditor({
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
  const [product, setProduct] = useState<Product | null>(null);
  const [price, setPrice] = useState('');
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [unknown, setUnknown] = useState(false),
    [conflict, setConflict] = useState(false);
  const intent = useRef<{
    action: Action;
    key: string;
    body: { version: number; priceCents?: number };
  } | null>(null);
  const sequence = useRef(0);
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
      setPrice((sku.priceCents / 100).toFixed(2));
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
  const amount = cents(price);
  const lastEnabled =
    sku?.enabled &&
    product?.status === 'PUBLISHED' &&
    product.skus.filter((s) => s.enabled).length === 1;
  const priceChanged = !!sku && amount !== sku.priceCents;
  async function save(action: Action) {
    if (!product || busy || (action === 'set-price' && amount === null && !unknown)) return;
    const attempt = intent.current ?? {
      action,
      key: crypto.randomUUID(),
      body: {
        version: product.version,
        ...(action === 'set-price' ? { priceCents: amount! } : {}),
      },
    };
    intent.current = attempt;
    setBusy(true);
    setError('');
    try {
      await staffRequest(`/admin/products/${id}/skus/${skuId}/${attempt.action}`, {
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
        setConflict(
          e.code === 'VERSION_CONFLICT' ||
            e.code === 'INVALID_TRANSITION' ||
            e.code === 'LAST_ENABLED_SKU',
        );
        setError(e.message);
      } else {
        setUnknown(true);
        setError('操作响应未能确认。内容已冻结，请使用原操作重试确认。');
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="规格售价与启停" busy={busy} onClose={onClose}>
      {loading ? (
        <p role="status" className="empty-state">
          正在读取最新规格…
        </p>
      ) : !sku || !product ? (
        <div role="alert" className="notice error">
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
            void save('set-price');
          }}
        >
          <div className="full" style={{ overflowWrap: 'anywhere', minWidth: 0 }}>
            <strong>{product.name}</strong>
            <p>
              {sku.spec} / {sku.unit} · {sku.code}
            </p>
            <span className={`badge ${sku.enabled ? 'green' : 'amber'}`}>
              {sku.enabled ? '规格已启用' : '规格已停用'}
            </span>
          </div>
          <p className="notice full">
            保存售价后，顾客下次读取商品使用新售价。停用会隐藏顾客目录并阻止该规格收货；库存数量和历史成本保留。启用规格不会自动上架商品。
          </p>
          <label className="full">
            售价（元）
            <input
              required
              inputMode="decimal"
              value={price}
              disabled={busy || unknown || conflict}
              onChange={(e) => {
                setPrice(e.target.value);
                intent.current = null;
              }}
              aria-describedby="sku-price-hint"
            />
          </label>
          <p id="sku-price-hint" className="full">
            范围 ¥0.01–1,000,000.00，最多两位小数。{amount === null ? '请输入有效售价。' : ''}
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
          {lastEnabled && (
            <p className="notice full">
              这是已上架商品的最后一个启用规格，如需停用，请先关闭窗口并下架商品。
            </p>
          )}
          {priceChanged && <p className="full">请先保存售价或恢复原价，再进行启停操作。</p>}
          <footer>
            <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
              关闭
            </button>
            {unknown ? (
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => void save(intent.current!.action)}
              >
                {busy ? '正在确认…' : '使用原操作重试确认'}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || conflict || priceChanged || !!lastEnabled}
                  onClick={() => void save(sku.enabled ? 'disable' : 'enable')}
                >
                  {sku.enabled ? '停用规格' : '启用规格'}
                </button>
                <button
                  className="primary-button"
                  disabled={busy || conflict || amount === null || !priceChanged}
                >
                  {busy ? '正在提交…' : '保存售价'}
                </button>
              </>
            )}
          </footer>
        </form>
      )}
    </Modal>
  );
}
