import { useEffect, useRef, useState } from 'react';
import type { Product, StaffProfile } from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
import { Modal } from './modal.js';
interface ImageFile {
  fileName: string;
  mime: string;
  base64: string;
}
export function ProductImageEditor({
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
  const [product, setProduct] = useState<Product | null>(null),
    [selected, setSelected] = useState<ImageFile | null>(null),
    [preview, setPreview] = useState('');
  const [loading, setLoading] = useState(true),
    [reading, setReading] = useState(false),
    [busy, setBusy] = useState(false),
    [unknown, setUnknown] = useState(false),
    [conflict, setConflict] = useState(false),
    [error, setError] = useState('');
  const intent = useRef<{ key: string; body: { version: number; image: ImageFile | null } } | null>(
      null,
    ),
    sequence = useRef(0),
    fileSequence = useRef(0),
    fileInput = useRef<HTMLInputElement>(null);
  function clear(resetInput = true) {
    fileSequence.current++;
    setSelected(null);
    setPreview('');
    setReading(false);
    if (resetInput && fileInput.current) fileInput.current.value = '';
  }
  async function load() {
    const token = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      const current = await staffRequest<Product>(`/admin/products/${id}`);
      if (token !== sequence.current) return;
      setProduct(current);
      clear();
      intent.current = null;
      setUnknown(false);
      setConflict(false);
    } catch (e) {
      if (token === sequence.current) setError(e instanceof Error ? e.message : '图片资料加载失败');
    } finally {
      if (token === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
      fileSequence.current++;
    };
  }, [id]);
  async function choose(file?: File) {
    clear(false);
    setError('');
    intent.current = null;
    if (!file) return;
    if (!['image/png', 'image/jpeg'].includes(file.type) || !file.size || file.size > 2097152) {
      setError('请选择2MB以内的PNG/JPEG文件');
      return;
    }
    const token = ++fileSequence.current;
    setReading(true);
    try {
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(Error('文件读取失败，请重新选择'));
        reader.readAsDataURL(file);
      });
      if (token !== fileSequence.current) return;
      setSelected({
        fileName: file.name,
        mime: file.type,
        base64: data.slice(data.indexOf(',') + 1),
      });
      setPreview(data);
    } catch (e) {
      if (token === fileSequence.current) setError(e instanceof Error ? e.message : '读取失败');
    } finally {
      if (token === fileSequence.current) setReading(false);
    }
  }
  async function save(image: ImageFile | null) {
    if (!product || busy || reading) return;
    const attempt = intent.current ?? {
      key: crypto.randomUUID(),
      body: { version: product.version, image },
    };
    intent.current = attempt;
    setBusy(true);
    setError('');
    try {
      await staffRequest(`/admin/products/${id}/set-image`, {
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
        setError('保存响应未能确认，原图片操作已保留。请使用原操作重试确认。');
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal title="商品主图" busy={busy} onClose={onClose}>
      {loading ? (
        <p className="empty-state" role="status">
          正在读取商品主图…
        </p>
      ) : !product ? (
        <div className="notice error" role="alert">
          {error}
          <button className="secondary-button" onClick={() => void load()}>
            重新读取图片资料
          </button>
        </div>
      ) : (
        <form
          className="business-form product-image-editor"
          onSubmit={(e) => {
            e.preventDefault();
            if (selected || unknown) void save(intent.current?.body.image ?? selected);
          }}
        >
          <strong className="full" style={{ overflowWrap: 'anywhere' }}>
            {product.name}
          </strong>
          <p className="notice full">
            上传商品实物或包装照片，PNG/JPEG、2MB以内、边长16–4096像素且不超过900万像素。保存后替换主图；移除后恢复包装示意。商品状态、售价和库存保持原值。
          </p>
          <div className="full product-image-preview">
            {preview || product.imageId ? (
              <img
                src={preview || `/api/v1/admin/products/${id}/image/${product.imageId}`}
                alt={preview ? '待保存主图预览' : '当前商品主图'}
                onError={() => setError('图片加载失败，可重新选图或关闭后重试')}
              />
            ) : (
              <p>尚未设置主图，顾客将看到明确标注的包装示意。</p>
            )}
          </div>
          <label className="full">
            选择主图
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,.png,.jpg,.jpeg"
              disabled={busy || unknown || conflict || reading}
              onChange={(e) => void choose(e.target.files?.[0])}
            />
          </label>
          {reading && (
            <p className="full" role="status">
              正在读取所选文件…
            </p>
          )}
          {selected && (
            <button
              type="button"
              className="secondary-button full"
              disabled={busy || unknown || conflict}
              onClick={() => clear()}
            >
              取消选择（保留当前主图）
            </button>
          )}
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
              载入最新资料（替换当前选择）
            </button>
          )}
          <footer>
            <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
              关闭
            </button>
            {unknown ? (
              <button
                type="button"
                className="primary-button"
                disabled={busy}
                onClick={() => void save(intent.current!.body.image)}
              >
                使用原操作重试确认
              </button>
            ) : (
              <>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy || reading || conflict || !!selected || !product.imageId}
                  onClick={() => void save(null)}
                >
                  移除主图
                </button>
                <button
                  className="primary-button"
                  disabled={busy || reading || conflict || !selected}
                >
                  {busy ? '正在保存…' : '上传并保存主图'}
                </button>
              </>
            )}
          </footer>
        </form>
      )}
    </Modal>
  );
}
