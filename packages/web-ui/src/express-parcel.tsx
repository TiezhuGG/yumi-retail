import { useEffect, useRef, useState } from 'react';
import {
  EXPRESS_CARRIERS,
  formatRedemptionAddress,
  type ExpressParcelPreview,
  type StaffProfile,
} from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
import { Modal } from './modal.js';
type Intent = {
  key: string;
  body: {
    orders: Array<{ id: string; version: number }>;
    carrierCode: string;
    carrierName: string;
    trackingNo: string;
    dispatchConfirmed: true;
  };
};
export const parcelStorage = (p: StaffProfile) =>
  'yumi.express-parcel.v1:' + p.id + ':' + [...p.warehouseIds].sort().join(',');
export function pendingParcelIds(p: StaffProfile): string[] | null {
  const raw = sessionStorage.getItem(parcelStorage(p));
  if (!raw) return null;
  try {
    const intent = JSON.parse(raw) as Intent;
    return intent.body.orders.map((x) => x.id);
  } catch {
    return [];
  }
}
export function ExpressParcelDialog({
  ids,
  profile,
  onClose,
  onDone,
}: {
  ids: string[];
  profile: StaffProfile;
  onClose: () => void;
  onDone: () => void;
}) {
  const [view, setView] = useState<ExpressParcelPreview | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [pending, setPending] = useState(!!sessionStorage.getItem(parcelStorage(profile))),
    [done, setDone] = useState(false),
    [code, setCode] = useState(''),
    [name, setName] = useState(''),
    [tracking, setTracking] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const seq = useRef(0),
    working = useRef(false);
  async function load() {
    const n = ++seq.current;
    setLoading(true);
    setError('');
    setView(null);
    setConfirmed(false);
    try {
      const data = await staffRequest<ExpressParcelPreview>('/admin/redemptions/parcel-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
        body: JSON.stringify({ ids }),
      });
      if (n === seq.current) setView(data);
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '合包资料读取失败');
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      seq.current++;
    };
  }, []);
  const valid =
    Object.hasOwn(EXPRESS_CARRIERS, code) &&
    /^[A-Z0-9][A-Z0-9-]{5,39}$/i.test(tracking.trim()) &&
    (code !== 'OTHER' || !!name.trim()) &&
    confirmed;
  async function ship() {
    if (working.current || (!pending && (!view?.canShip || !valid))) return;
    working.current = true;
    setBusy(true);
    setError('');
    const n = seq.current;
    try {
      const raw = sessionStorage.getItem(parcelStorage(profile));
      const intent: Intent = raw
        ? JSON.parse(raw)
        : {
            key: crypto.randomUUID(),
            body: {
              orders: view!.items.map((o) => ({ id: o.id, version: o.version })),
              carrierCode: code,
              carrierName:
                code === 'OTHER'
                  ? name.trim()
                  : EXPRESS_CARRIERS[code as keyof typeof EXPRESS_CARRIERS],
              trackingNo: tracking.trim(),
              dispatchConfirmed: true,
            },
          };
      if (!intent?.key || !Array.isArray(intent.body?.orders))
        throw Error('原合包请求无法读取，请保留并核查');
      sessionStorage.setItem(parcelStorage(profile), JSON.stringify(intent));
      setPending(true);
      await staffRequest('/admin/redemptions/ship-parcel', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': profile.csrfToken,
          'Idempotency-Key': intent.key,
        },
        body: JSON.stringify(intent.body),
      });
      sessionStorage.removeItem(parcelStorage(profile));
      if (n === seq.current) {
        setPending(false);
        setDone(true);
        setView(null);
      }
    } catch (e) {
      if (n === seq.current) {
        if (e instanceof StaffRequestError && e.status < 500 && ![401, 403].includes(e.status)) {
          sessionStorage.removeItem(parcelStorage(profile));
          setPending(false);
          setView(null);
          setConfirmed(false);
        }
        setError(e instanceof Error ? e.message : '合包结果待核实，请使用原请求重试');
      }
    } finally {
      working.current = false;
      if (n === seq.current) setBusy(false);
    }
  }
  return (
    <Modal title="合包确认与发货" busy={busy} onClose={() => (done ? onDone() : onClose())}>
      {done ? (
        <div role="status" className="notice">
          <h3>合包发货已登记</h3>
          <p>本包全部订单已使用同一运单出库，可返回订单核对。</p>
          <button className="primary-button" onClick={onDone}>
            完成并返回订单
          </button>
        </div>
      ) : (
        <>
          {loading && <p role="status">正在核验合包订单…</p>}
          {error && (
            <p role="alert" className="notice task-error">
              {error}
            </p>
          )}
          {pending ? (
            <div className="notice">
              <p>有一笔合包发货请求待核实。请保留原请求，避免重复出库。</p>
              <button className="primary-button" disabled={busy} onClick={() => void ship()}>
                核实原合包请求
              </button>
            </div>
          ) : (
            <>
              <p>
                仅支持同一顾客、相同原收件信息的待发货快递订单。请逐单核对批次、库位和实物后装入同一包裹。
              </p>
              <button
                className="secondary-button"
                disabled={loading || busy}
                onClick={() => void load()}
              >
                重新核验合包资料
              </button>
              {view && (
                <>
                  <div className="notice">
                    <p>
                      {view.executionMode === 'PRODUCTION'
                        ? '生产订单'
                        : view.executionMode === 'CONTROLLED'
                          ? '受控测试订单'
                          : '本地开发订单'}
                    </p>
                    <strong>
                      {view.address.contactName} · {view.address.phone}
                    </strong>
                    <p>{formatRedemptionAddress(view.address)}</p>
                    {view.address.note && <p>地址备注：{view.address.note}</p>}
                  </div>
                  <ul className="parcel-order-list">
                    {view.items.map((o) => (
                      <li key={o.id}>
                        <h3>
                          {o.title} · {o.spec} × {o.quantity}
                          {o.unit}
                        </h3>
                        <p className="muted">订单：{o.orderNo}</p>
                        {o.orderNote && <p>订单备注：{o.orderNote}</p>}
                        {o.allocations.map((a, i) => (
                          <p key={i}>
                            批次 {a.batchNo} · 库位 {a.locationName} · {a.quantity}
                            {o.unit}
                          </p>
                        ))}
                      </li>
                    ))}
                  </ul>
                  {view.blockers.length > 0 && (
                    <div role="alert" className="notice">
                      {view.blockers.map((b) => (
                        <p key={b}>{b}</p>
                      ))}
                    </div>
                  )}
                  <form
                    className="business-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (valid) void ship();
                    }}
                  >
                    <label>
                      快递公司
                      <select
                        aria-label="合包快递公司"
                        value={code}
                        disabled={busy || !view.canShip}
                        onChange={(e) => setCode(e.target.value)}
                      >
                        <option value="">请选择快递公司</option>
                        {Object.entries(EXPRESS_CARRIERS).map(([v, l]) => (
                          <option key={v} value={v}>
                            {l}
                          </option>
                        ))}
                      </select>
                    </label>
                    {code === 'OTHER' && (
                      <label>
                        快递名称
                        <input
                          aria-label="合包快递名称"
                          value={name}
                          maxLength={40}
                          disabled={busy}
                          onChange={(e) => setName(e.target.value)}
                        />
                      </label>
                    )}
                    <label>
                      运单号
                      <input
                        aria-label="合包运单号"
                        value={tracking}
                        maxLength={40}
                        disabled={busy || !view.canShip}
                        onChange={(e) => setTracking(e.target.value)}
                      />
                    </label>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={confirmed}
                        disabled={busy || !view.canShip}
                        onChange={(e) => setConfirmed(e.target.checked)}
                      />
                      已逐单核对原预占实物、收件信息和真实运单，确认装入同一包裹并交给快递
                    </label>
                    <button className="primary-button" disabled={!valid || busy || !view.canShip}>
                      {busy ? '正在登记…' : `确认合包并发货（${view.items.length}单）`}
                    </button>
                  </form>
                </>
              )}
            </>
          )}
        </>
      )}
    </Modal>
  );
}
