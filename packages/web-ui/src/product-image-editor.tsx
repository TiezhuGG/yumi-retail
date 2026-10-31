import { useEffect, useRef, useState } from 'react';
import type { ProductGallery, StaffProfile } from '@yumi/contracts';
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
  const [gallery, setGallery] = useState<ProductGallery | null>(null),
    [order, setOrder] = useState<string[]>([]),
    [selected, setSelected] = useState<ImageFile | null>(null),
    [preview, setPreview] = useState('');
  const [loading, setLoading] = useState(true),
    [reading, setReading] = useState(false),
    [busy, setBusy] = useState(false),
    [unknown, setUnknown] = useState(false),
    [conflict, setConflict] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const intent = useRef<{ key: string; route: string; body: unknown } | null>(null),
    sequence = useRef(0),
    fileSequence = useRef(0),
    fileInput = useRef<HTMLInputElement>(null);
  const dirty =
    !!gallery && JSON.stringify(order) !== JSON.stringify(gallery.images.map((i) => i.id));
  const locked = busy || unknown || conflict || reading || loading;
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
    setMessage('');
    try {
      const current = await staffRequest<ProductGallery>(`/admin/products/${id}/images`);
      if (token !== sequence.current) return;
      setGallery(current);
      setOrder(current.images.map((i) => i.id));
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
    setMessage('');
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
  async function save(kind: 'add-image' | 'set-images') {
    if (!gallery || busy || reading) return;
    const attempt = intent.current ?? {
      key: crypto.randomUUID(),
      route: kind,
      body:
        kind === 'add-image'
          ? { version: gallery.product.version, image: selected }
          : { version: gallery.product.version, imageIds: order },
    };
    intent.current = attempt;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await staffRequest(`/admin/products/${id}/${attempt.route}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': profile.csrfToken,
          'Idempotency-Key': attempt.key,
        },
        body: JSON.stringify(attempt.body),
      });
      // Idempotent replay can be historical: always reload the authoritative gallery.
      intent.current = null;
      setUnknown(false);
      setConflict(true);
      try {
        const current = await staffRequest<ProductGallery>(`/admin/products/${id}/images`);
        setGallery(current);
        setOrder(current.images.map((i) => i.id));
        clear();
        setConflict(false);
        setMessage('图片操作已确认，已读取当前图片集。');
      } catch {
        setError('图片操作已确认，但当前资料读取失败，请载入最新资料后继续。');
      }
    } catch (e) {
      if (e instanceof StaffRequestError && e.status < 500) {
        intent.current = null;
        setUnknown(false);
        setConflict(e.code === 'VERSION_CONFLICT');
        setError(e.message);
      } else {
        setUnknown(true);
        setError('保存响应未能确认，原图片操作已保留，请使用原操作重试确认。');
      }
    } finally {
      setBusy(false);
    }
  }
  function move(index: number, target: number) {
    const next = [...order];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    setOrder(next);
    setMessage('');
    setError('');
  }
  return (
    <Modal title="商品图片" busy={busy} onClose={() => (gallery ? void onSaved() : onClose())}>
      {loading ? (
        <p className="empty-state" role="status">
          正在读取商品图片…
        </p>
      ) : !gallery ? (
        <div className="notice error" role="alert">
          {error}
          <button className="secondary-button" onClick={() => void load()}>
            重新读取图片资料
          </button>
        </div>
      ) : (
        <div className="product-image-editor gallery-editor">
          <strong className="gallery-product-name">{gallery.product.name}</strong>
          <p className="notice">
            最多6张，第一张为主图。调整顺序或移除后需保存；添加一次上传一张并立即保存。PNG/JPEG、2MB以内、边长16–4096像素且不超过900万像素。
          </p>
          <p role="status">
            {order.length} / 6 张{dirty ? ' · 顺序或移除尚未保存' : ''}
          </p>
          {!order.length && <p className="empty-state">暂无商品图片，顾客将看到包装示意。</p>}
          <ol className="gallery-grid">
            {order.map((imageId, index) => (
              <li className="gallery-tile" key={imageId}>
                <span className="gallery-badge">{index === 0 ? '主图' : `图片 ${index + 1}`}</span>
                <GalleryPreview
                  src={gallery.images.find((i) => i.id === imageId)!.url}
                  label={`商品图片 ${index + 1}`}
                />
                <div className="gallery-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={locked || index === 0 || !!selected}
                    onClick={() => move(index, 0)}
                  >
                    设为主图
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    aria-label={`图片${index + 1}前移`}
                    disabled={locked || index === 0 || !!selected}
                    onClick={() => move(index, index - 1)}
                  >
                    前移
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    aria-label={`图片${index + 1}后移`}
                    disabled={locked || index === order.length - 1 || !!selected}
                    onClick={() => move(index, index + 1)}
                  >
                    后移
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    aria-label={`移除图片${index + 1}`}
                    disabled={locked || !!selected}
                    onClick={() => {
                      setOrder(order.filter((i) => i !== imageId));
                      setMessage('');
                    }}
                  >
                    移除
                  </button>
                </div>
              </li>
            ))}
          </ol>
          {dirty && (
            <div className="gallery-actions">
              <button
                type="button"
                className="secondary-button"
                disabled={locked}
                onClick={() => setOrder(gallery.images.map((i) => i.id))}
              >
                撤销顺序和移除
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={locked}
                onClick={() => void save('set-images')}
              >
                保存顺序和移除
              </button>
            </div>
          )}
          <div className="gallery-upload">
            <label>
              添加商品图片
              <input
                ref={fileInput}
                type="file"
                accept="image/png,image/jpeg,.png,.jpg,.jpeg"
                disabled={locked || dirty || order.length >= 6}
                onChange={(e) => void choose(e.target.files?.[0])}
              />
            </label>
            {order.length >= 6 && <p className="notice">已达6张上限，保存移除后可继续添加。</p>}
            {dirty && <p className="notice">请先保存或撤销顺序和移除，再添加图片。</p>}
            {reading && <p role="status">正在读取所选文件…</p>}
            {preview && (
              <div className="product-image-preview">
                <img src={preview} alt="待添加图片预览" />
              </div>
            )}
            {selected && (
              <div className="gallery-actions">
                <button
                  type="button"
                  className="secondary-button"
                  disabled={locked}
                  onClick={() => clear()}
                >
                  取消选择
                </button>
                <button
                  type="button"
                  className="primary-button"
                  disabled={locked}
                  onClick={() => void save('add-image')}
                >
                  上传并添加图片
                </button>
              </div>
            )}
          </div>
          {error && (
            <p className="notice error" role="alert">
              {error}
            </p>
          )}
          {message && (
            <p className="notice" role="status">
              {message}
            </p>
          )}
          {conflict && (
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void load()}
            >
              载入最新资料（替换当前选择）
            </button>
          )}
          {unknown && (
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => void save('add-image')}
            >
              使用原操作重试确认
            </button>
          )}
          <footer>
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => void onSaved()}
            >
              关闭并刷新列表
            </button>
            {dirty && <small>未保存的顺序和移除将在关闭后丢弃</small>}
          </footer>
        </div>
      )}
    </Modal>
  );
}
function GalleryPreview({ src, label }: { src: string; label: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="gallery-thumb">
      {failed ? (
        <span role="status">图片读取失败</span>
      ) : (
        <img src={src} alt={label} onError={() => setFailed(true)} />
      )}
      {failed && (
        <button type="button" className="secondary-button" onClick={() => setFailed(false)}>
          重试图片
        </button>
      )}
    </div>
  );
}
