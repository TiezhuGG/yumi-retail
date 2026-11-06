import { useRef, useState } from 'react';
import type { Category, StaffProfile } from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
import { Modal } from './modal.js';
import { usePage } from './use-page.js';

export function ProductCreator({
  profile,
  onClose,
  onSaved,
}: {
  profile: StaffProfile;
  onClose: () => void;
  onSaved: () => void;
}) {
  const categories = usePage<Category>('/admin/categories?limit=50');
  const [points, setPoints] = useState(true),
    [busy, setBusy] = useState(false),
    [unknown, setUnknown] = useState(false),
    [error, setError] = useState('');
  const writing = useRef(false),
    intent = useRef<{ body: unknown; key: string } | null>(null);
  async function submit(form?: HTMLFormElement) {
    if (writing.current) return;
    if (!intent.current) {
      if (!form) return;
      const data = new FormData(form),
        price = String(data.get('price'));
      if (!/^\d{1,7}(\.\d{1,2})?$/.test(price)) {
        setError('售价最多保留两位小数');
        return;
      }
      const [whole, fraction = ''] = price.split('.'),
        priceCents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
      if (priceCents < 1 || priceCents > 100000000) {
        setError('售价须在0.01至100万元之间');
        return;
      }
      const pointsPrice = points ? String(data.get('pointsPrice')) : null;
      if (
        pointsPrice !== null &&
        (!/^\d{1,10}$/.test(pointsPrice) ||
          Number(pointsPrice) < 1 ||
          Number(pointsPrice) > 1000000000)
      ) {
        setError('兑换积分须为1至10亿的整数');
        return;
      }
      intent.current = {
        key: crypto.randomUUID(),
        body: {
          categoryId: data.get('categoryId'),
          name: data.get('name'),
          description: String(data.get('description') ?? '').trim() || undefined,
          skus: [
            {
              code: data.get('code'),
              spec: data.get('spec'),
              unit: data.get('unit'),
              priceCents,
              expiryManaged: data.get('expiryManaged') === 'on',
            },
          ],
          pointsPrice,
          reason: data.get('reason'),
        },
      };
    }
    writing.current = true;
    setBusy(true);
    setError('');
    try {
      await staffRequest('/admin/mall-products', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': profile.csrfToken,
          'Idempotency-Key': intent.current.key,
        },
        body: JSON.stringify(intent.current.body),
      });
    } catch (e) {
      const uncertain = !(e instanceof StaffRequestError) || e.status >= 500;
      setUnknown(uncertain);
      if (!uncertain) intent.current = null;
      setError(
        uncertain
          ? '保存结果未确认，请使用原请求重试。'
          : e instanceof Error
            ? e.message
            : '保存失败',
      );
      writing.current = false;
      setBusy(false);
      return;
    }
    writing.current = false;
    setBusy(false);
    onSaved();
  }
  return (
    <Modal title="新增商品" busy={busy || unknown} onClose={onClose}>
      <form
        className="business-form"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(e.currentTarget);
        }}
      >
        {categories.loading && <p role="status">正在读取分类…</p>}
        {categories.error && (
          <div role="alert">
            {categories.error}
            <button type="button" onClick={() => void categories.reload().catch(() => {})}>
              重试分类
            </button>
          </div>
        )}
        {categories.cursor && (
          <button
            type="button"
            className="secondary-button"
            disabled={categories.loading}
            onClick={() => void categories.next().catch(() => {})}
          >
            加载更多分类
          </button>
        )}
        <fieldset disabled={busy || unknown} style={{ display: 'contents' }}>
          <label className="full">
            商品名称
            <input name="name" maxLength={120} required />
          </label>
          <label>
            商品分类
            <select name="categoryId" aria-label="商品分类" required>
              <option value="">请选择分类</option>
              {categories.items.map((c) => (
                <option
                  key={c.id}
                  value={c.id}
                  disabled={
                    !c.enabled ||
                    !!(
                      c.parentId && !categories.items.some((p) => p.id === c.parentId && p.enabled)
                    )
                  }
                >
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            SKU编码
            <input name="code" maxLength={64} pattern="[A-Za-z0-9][A-Za-z0-9_-]*" required />
          </label>
          <label>
            规格
            <input name="spec" maxLength={100} required />
          </label>
          <label>
            单位
            <input name="unit" maxLength={16} required />
          </label>
          <label>
            售价（元）
            <input name="price" inputMode="decimal" placeholder="0.00" required />
          </label>
          <label>
            <span>积分商城</span>
            <span>
              <input
                type="checkbox"
                checked={points}
                onChange={(e) => setPoints(e.target.checked)}
              />{' '}
              同时创建兑换商品
            </span>
          </label>
          {points && (
            <label>
              兑换所需积分
              <input name="pointsPrice" inputMode="numeric" required />
            </label>
          )}
          <label>
            <span>效期管理</span>
            <span>
              <input name="expiryManaged" type="checkbox" /> 管理生产与到期时间
            </span>
          </label>
          <label className="full">
            商品说明
            <textarea name="description" maxLength={2000} />
          </label>
          <label className="full">
            操作原因
            <textarea name="reason" maxLength={300} required />
          </label>
        </fieldset>
        <p className="muted full">
          售价与兑换积分分别设置，兑换只扣积分。保存后为草稿，完善图片与库存后再上架。
        </p>
        {error && (
          <div role="alert" className="notice task-error full">
            {error}
          </div>
        )}
        <footer>
          {unknown ? (
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => void submit()}
            >
              使用原请求重试
            </button>
          ) : (
            <>
              <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
                取消
              </button>
              <button
                className="primary-button"
                disabled={busy || categories.loading || !!categories.error}
              >
                {busy ? '正在保存…' : '保存商品草稿'}
              </button>
            </>
          )}
        </footer>
      </form>
    </Modal>
  );
}
