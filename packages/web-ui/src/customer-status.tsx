import { useEffect, useRef, useState } from 'react';
import type { CustomerStatusHistory, StaffProfile } from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
import { Modal } from './modal.js';
type Customer = { id: string; displayName: string; enabled: boolean; stateVersion: number };
type Intent = {
  key: string;
  action: 'disable' | 'enable';
  body: { version: number; reason: string; confirmed: true };
};
const labels = { CUSTOMER_DISABLED: '停用账号', CUSTOMER_ENABLED: '恢复账号' };
export function CustomerStatusPanel({
  customer,
  profile,
  locked,
  onPendingChange,
  onChanged,
}: {
  customer: Customer;
  profile: StaffProfile;
  locked: boolean;
  onPendingChange: (v: boolean) => void;
  onChanged: () => void;
}) {
  const storage = 'yumi.customer-status.v1:' + profile.id + ':' + customer.id;
  const [history, setHistory] = useState<CustomerStatusHistory | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [form, setForm] = useState<'disable' | 'enable' | null>(null),
    [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [unknown, setUnknown] = useState(false),
    [done, setDone] = useState(false),
    [conflict, setConflict] = useState(false);
  const seq = useRef(0),
    pending = useRef<Intent | null>(null),
    writing = useRef(false);
  const canChange =
    profile.roles.includes('SUPER_ADMIN') && profile.permissions.includes('points.write');
  function restore() {
    const raw = sessionStorage.getItem(storage);
    if (!raw) return;
    const intent = JSON.parse(raw) as Intent;
    if (
      !intent ||
      !['disable', 'enable'].includes(intent.action) ||
      !/^[a-f0-9-]{36}$/i.test(intent.key) ||
      !Number.isInteger(intent.body?.version) ||
      typeof intent.body.reason !== 'string' ||
      intent.body.confirmed !== true
    )
      throw Error('原账号操作请求无法读取，请先保留记录核实');
    pending.current = intent;
    if (canChange) setForm(intent.action);
    else setError('当前账号无权核实原操作，请由负责人核对操作记录。');
    setReason(intent.body.reason);
    setConfirmed(true);
    setUnknown(true);
  }
  async function load(cursor?: string) {
    const n = ++seq.current;
    setLoading(true);
    setError('');
    if (!cursor) setHistory(null);
    try {
      const next = await staffRequest<CustomerStatusHistory>(
        '/admin/customers/' + customer.id + '/status-history' + (cursor ? '?cursor=' + cursor : ''),
      );
      if (n === seq.current)
        setHistory((old) => ({
          ...next,
          items: cursor && old ? [...old.items, ...next.items] : next.items,
        }));
    } catch (e) {
      if (n === seq.current) {
        setHistory(null);
        setError(e instanceof Error ? e.message : '账号操作记录读取失败');
      }
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    try {
      restore();
    } catch (e) {
      setError(e instanceof Error ? e.message : '原请求读取失败');
      setUnknown(true);
    }
    return () => {
      seq.current++;
    };
  }, []);
  useEffect(() => {
    onPendingChange(busy || (unknown && canChange) || form !== null);
    return () => onPendingChange(false);
  }, [busy, unknown, form, onPendingChange, canChange]);
  async function submit() {
    if (writing.current || !form || !canChange) return;
    writing.current = true;
    setBusy(true);
    setError('');
    setDone(false);
    let attempted = false;
    try {
      const intent = pending.current ?? {
        key: crypto.randomUUID(),
        action: form,
        body: { version: customer.stateVersion, reason: reason.trim(), confirmed: true as const },
      };
      sessionStorage.setItem(storage, JSON.stringify(intent));
      pending.current = intent;
      attempted = true;
      await staffRequest('/admin/customers/' + customer.id + '/status/' + intent.action, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': profile.csrfToken,
          'Idempotency-Key': intent.key,
        },
        body: JSON.stringify(intent.body),
      });
      // A response replay describes the original operation, so always reload current state.
      setDone(true);
      setUnknown(false);
      sessionStorage.removeItem(storage);
      pending.current = null;
      setForm(null);
      setReason('');
      setConfirmed(false);
      await load();
      onChanged();
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
          /* retain visible form */
        }
      }
      setError(
        (e instanceof Error ? e.message : '账号操作未完成') +
          (unresolved ? '；结果尚未确认，请使用原请求核实，不要重新提交相反操作。' : ''),
      );
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  function close() {
    if (busy || unknown) return;
    setForm(null);
    setReason('');
    setConfirmed(false);
    setError('');
    setConflict(false);
    onChanged();
  }
  return (
    <section className="surface customer-status-panel" aria-label="账号状态与操作记录">
      <div className="readiness-heading">
        <h2>账号状态与操作记录</h2>
        {canChange ? (
          <button
            className="secondary-button"
            disabled={locked || busy || unknown || loading}
            onClick={() => {
              setDone(false);
              setConflict(false);
              setForm(customer.enabled ? 'disable' : 'enable');
              setReason('');
              setConfirmed(false);
              setError('');
            }}
          >
            {customer.enabled ? '停用账号' : '恢复账号'}
          </button>
        ) : (
          <span className="muted">账号状态由负责人维护</span>
        )}
      </div>
      <p>
        停用会使旧登录失效，顾客无法使用个人订单和售后入口。积分与历史订单保留，后台继续处理已有业务；恢复后需重新登录。
      </p>
      {done && (
        <p className="notice" role="status">
          原请求已确认，请核对最新资料与操作记录。
        </p>
      )}
      {!form && error && (
        <div className="notice task-error" role="alert">
          {error}
          <button disabled={loading} onClick={() => void load()}>
            重试操作记录
          </button>
        </div>
      )}
      {loading && <p role="status">正在读取账号操作记录…</p>}
      {history && (
        <>
          {history.items.length === 0 ? (
            <div className="points-empty">暂无停用或恢复记录</div>
          ) : (
            <ol className="customer-status-history">
              {history.items.map((h) => (
                <li key={h.id}>
                  <div>
                    <strong>{labels[h.action]}</strong>
                    <span>
                      {new Date(h.createdAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
                    </span>
                  </div>
                  <p>
                    {h.actorName} · {h.fromEnabled ? '正常' : '已停用'} →{' '}
                    {h.toEnabled ? '正常' : '已停用'}
                  </p>
                  <p className="customer-status-reason">原因：{h.reason}</p>
                </li>
              ))}
            </ol>
          )}
          {history.nextCursor && (
            <button
              className="secondary-button"
              disabled={loading || busy || unknown}
              onClick={() => void load(history.nextCursor!)}
            >
              加载更多账号记录
            </button>
          )}
          <button
            className="secondary-button"
            disabled={loading || busy || unknown}
            onClick={() => void load()}
          >
            刷新操作记录
          </button>
        </>
      )}
      {unknown && !form && (
        <p className="notice task-error" role="alert">
          存在未确认的账号操作，请保留原请求，并由有权限的负责人核对记录。
        </p>
      )}
      {form && (
        <Modal
          title={form === 'disable' ? '停用顾客账号' : '恢复顾客账号'}
          busy={busy || unknown}
          onClose={close}
        >
          <h3>{customer.displayName}</h3>
          <p>
            {form === 'disable'
              ? '确认后立即停用该顾客账号，旧登录失效；不会取消订单或清除积分。'
              : '确认后恢复该顾客登录资格，旧登录不会恢复，顾客需重新登录。'}
          </p>
          <form
            className="customer-status-form"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <label>
              操作原因
              <textarea
                required
                maxLength={200}
                value={reason}
                disabled={busy || unknown}
                onChange={(e) => setReason(e.target.value)}
              />
            </label>
            <label className="customer-status-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy || unknown}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              我已核实顾客及操作影响
            </label>
            {error && (
              <p className="notice task-error" role="alert">
                {error}
              </p>
            )}
            <button
              className="primary-button"
              disabled={busy || conflict || !confirmed || !reason.trim() || !canChange}
            >
              {busy
                ? '正在核实…'
                : unknown
                  ? '使用原请求核实结果'
                  : form === 'disable'
                    ? '确认停用'
                    : '确认恢复'}
            </button>
          </form>
        </Modal>
      )}
    </section>
  );
}
