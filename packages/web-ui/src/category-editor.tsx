import { useEffect, useRef, useState } from 'react';
import type { CategoryDetail, StaffProfile } from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
import { Modal } from './modal.js';

type Action = 'rename' | 'enable' | 'disable';
export function CategoryEditor({
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
  const [category, setCategory] = useState<CategoryDetail | null>(null);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [unknown, setUnknown] = useState(false),
    [conflict, setConflict] = useState(false);
  const sequence = useRef(0);
  const intent = useRef<{
    action: Action;
    key: string;
    body: { version: number; name?: string };
  } | null>(null);
  async function load() {
    const token = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      const current = await staffRequest<CategoryDetail>(`/admin/categories/${id}`);
      if (token !== sequence.current) return;
      setCategory(current);
      setName(current.name);
      intent.current = null;
      setUnknown(false);
      setConflict(false);
    } catch (e) {
      if (token === sequence.current) setError(e instanceof Error ? e.message : '分类加载失败');
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
  const changed = !!category && name.trim() !== category.name;
  const parentDisabled = category?.parent?.enabled === false;
  async function save(action: Action) {
    if (!category || busy || (action === 'rename' && !name.trim() && !unknown)) return;
    const attempt = intent.current ?? {
      action,
      key: crypto.randomUUID(),
      body: { version: category.version, ...(action === 'rename' ? { name: name.trim() } : {}) },
    };
    intent.current = attempt;
    setBusy(true);
    setError('');
    try {
      await staffRequest(`/admin/categories/${id}/${attempt.action}`, {
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
          ['VERSION_CONFLICT', 'INVALID_TRANSITION', 'PARENT_DISABLED'].includes(e.code ?? ''),
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
    <Modal title="分类名称与启停" busy={busy} onClose={onClose}>
      {loading ? (
        <p role="status" className="empty-state">
          正在读取最新分类…
        </p>
      ) : !category ? (
        <div role="alert" className="notice error">
          {error}
          <button className="secondary-button" onClick={() => void load()}>
            重新读取分类
          </button>
        </div>
      ) : (
        <form
          className="business-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save('rename');
          }}
        >
          <div className="full" style={{ overflowWrap: 'anywhere', minWidth: 0 }}>
            <strong>{category.parent ? `二级分类 · ${category.parent.name}` : '一级分类'}</strong>
            <p>
              <span className={`badge ${category.enabled ? 'green' : 'amber'}`}>
                {category.enabled ? '分类自身已启用' : '分类自身已停用'}
              </span>
            </p>
            {parentDisabled && (
              <p className="notice">
                父分类已停用，此分类下商品暂不对顾客展示。启用此分类前，请先启用父分类。
              </p>
            )}
          </div>
          <p className="notice full">
            停用会隐藏此分类及下属分类的顾客目录商品，保留子分类自身状态、商品上架状态和库存。重新启用后，满足原有条件的商品会恢复展示。收货作业仍按规格启用状态校验。
          </p>
          <label className="full">
            分类名称
            <input
              required
              maxLength={80}
              value={name}
              disabled={busy || unknown || conflict}
              onChange={(e) => {
                setName(e.target.value);
                intent.current = null;
              }}
            />
          </label>
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
          {changed && <p className="full">请先保存名称或恢复原名，再进行启停操作。</p>}
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
                  disabled={busy || conflict || changed || (!category.enabled && parentDisabled)}
                  onClick={() => void save(category.enabled ? 'disable' : 'enable')}
                >
                  {category.enabled ? '停用分类' : '启用分类'}
                </button>
                <button
                  className="primary-button"
                  disabled={busy || conflict || !name.trim() || !changed}
                >
                  {busy ? '正在提交…' : '保存名称'}
                </button>
              </>
            )}
          </footer>
        </form>
      )}
    </Modal>
  );
}
