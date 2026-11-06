import { useEffect, useRef, useState } from 'react';
import type { CustomerNotesPage, StaffProfile } from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
import { Modal } from './modal.js';
type Intent = { key: string; body: { message: string; scopeId: string } };
export function CustomerNotesPanel({
  id,
  profile,
  locked,
  onPendingChange,
}: {
  id: string;
  profile: StaffProfile;
  locked: boolean;
  onPendingChange: (v: boolean) => void;
}) {
  const storage =
    'yumi.customer-notes.v1:' +
    profile.id +
    ':' +
    [...profile.warehouseIds].sort().join(',') +
    ':' +
    id;
  const [page, setPage] = useState<CustomerNotesPage | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [form, setForm] = useState(false),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [unknown, setUnknown] = useState(false),
    [conflict, setConflict] = useState(false),
    [saved, setSaved] = useState(false);
  const seq = useRef(0),
    pending = useRef<Intent | null>(null),
    writing = useRef(false);
  const canWrite =
    profile.permissions.includes('points.write') &&
    profile.roles.some((r) => ['SUPER_ADMIN', 'OPERATIONS'].includes(r));
  async function load(cursor?: string) {
    const n = ++seq.current;
    setLoading(true);
    setError('');
    if (!cursor) setPage(null);
    try {
      const next = await staffRequest<CustomerNotesPage>(
        '/admin/customers/' + id + '/notes' + (cursor ? '?cursor=' + cursor : ''),
      );
      if (n === seq.current)
        setPage((old) => ({
          ...next,
          items: cursor && old ? [...old.items, ...next.items] : next.items,
        }));
    } catch (e) {
      if (n === seq.current) {
        setPage(null);
        setError(e instanceof Error ? e.message : '内部备注读取失败');
      }
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    try {
      const raw = sessionStorage.getItem(storage);
      if (raw) {
        const intent = JSON.parse(raw) as Intent;
        if (
          !intent ||
          !/^[a-f0-9-]{36}$/i.test(intent.key) ||
          typeof intent.body?.message !== 'string' ||
          !/^[a-f0-9-]{36}$/i.test(intent.body.scopeId)
        )
          throw Error('原备注请求无法读取，请保留并核实');
        pending.current = intent;
        setMessage(intent.body.message);
        setUnknown(true);
        if (canWrite) setForm(true);
        else setError('存在未确认的原备注，请由有权限的人员核对记录。');
      }
    } catch (e) {
      setUnknown(true);
      setError(e instanceof Error ? e.message : '原备注读取失败');
    }
    return () => {
      seq.current++;
    };
  }, []);
  useEffect(() => {
    onPendingChange(busy || form || (unknown && canWrite));
    return () => onPendingChange(false);
  }, [busy, form, unknown, canWrite, onPendingChange]);
  async function submit() {
    if (writing.current || !canWrite || (!pending.current && !page)) return;
    writing.current = true;
    setBusy(true);
    setError('');
    setSaved(false);
    let attempted = false;
    try {
      const intent = pending.current ?? {
        key: crypto.randomUUID(),
        body: { message: message.trim(), scopeId: page!.scopeId },
      };
      sessionStorage.setItem(storage, JSON.stringify(intent));
      pending.current = intent;
      attempted = true;
      await staffRequest('/admin/customers/' + id + '/notes', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': profile.csrfToken,
          'Idempotency-Key': intent.key,
        },
        body: JSON.stringify(intent.body),
      });
      sessionStorage.removeItem(storage);
      pending.current = null;
      setUnknown(false);
      setForm(false);
      setMessage('');
      setSaved(true);
      await load();
    } catch (e) {
      const unresolved = attempted && (!(e instanceof StaffRequestError) || e.status >= 500);
      setUnknown(unresolved);
      setConflict(
        !unresolved && e instanceof StaffRequestError && [401, 403, 404, 409].includes(e.status),
      );
      if (!unresolved) {
        pending.current = null;
        try {
          sessionStorage.removeItem(storage);
        } catch {
          /* original input remains visible */
        }
      }
      setError(
        (e instanceof Error ? e.message : '备注未保存') +
          (unresolved ? '；结果尚未确认，请使用原请求核实。' : ''),
      );
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  function close() {
    if (busy || unknown) return;
    setForm(false);
    setMessage('');
    setError('');
    setConflict(false);
  }
  return (
    <section className="surface customer-notes-panel" aria-label="顾客内部备注">
      <div className="readiness-heading">
        <h2>内部备注与跟进</h2>
        {canWrite && (
          <button
            className="secondary-button"
            disabled={locked || busy || unknown || loading || !page}
            onClick={() => {
              setForm(true);
              setConflict(false);
              setSaved(false);
              setError('');
              setMessage('');
            }}
          >
            新增备注
          </button>
        )}
      </div>
      <p className="muted">仅当前经营仓的授权后台人员可见。补充或更正请新增记录，原记录保留。</p>
      {saved && (
        <p className="notice" role="status">
          原备注请求已确认。
        </p>
      )}
      {loading && <p role="status">正在读取内部备注…</p>}
      {!form && error && (
        <div className="notice task-error" role="alert">
          {error}
          <button disabled={loading} onClick={() => void load()}>
            重试内部备注
          </button>
        </div>
      )}
      {page && (
        <>
          {page.items.length === 0 ? (
            <div className="points-empty">暂无内部备注</div>
          ) : (
            <ol className="customer-notes-list">
              {page.items.map((n) => (
                <li key={n.id}>
                  <div>
                    <strong>{n.actorName}</strong>
                    <time>
                      {new Date(n.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                    </time>
                  </div>
                  <p>{n.message}</p>
                </li>
              ))}
            </ol>
          )}
          {page.nextCursor && (
            <button
              className="secondary-button"
              disabled={loading || busy || unknown}
              onClick={() => void load(page.nextCursor!)}
            >
              加载更多内部备注
            </button>
          )}
          <button
            className="secondary-button"
            disabled={loading || busy || unknown}
            onClick={() => void load()}
          >
            刷新内部备注
          </button>
        </>
      )}
      {form && (
        <Modal title="新增顾客内部备注" busy={busy || unknown} onClose={close}>
          <form
            className="customer-notes-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label>
              备注内容
              <textarea
                required
                maxLength={500}
                value={message}
                disabled={busy || unknown}
                onChange={(e) => setMessage(e.target.value)}
              />
            </label>
            <small>{message.length}/500</small>
            {error && (
              <p className="notice task-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="primary-button"
              disabled={
                busy || conflict || !canWrite || !message.trim() || (!page && !pending.current)
              }
            >
              {busy ? '正在核实…' : unknown ? '使用原请求核实备注' : '保存内部备注'}
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}
