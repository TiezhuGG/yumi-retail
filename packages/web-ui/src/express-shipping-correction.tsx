import { useEffect, useRef, useState } from 'react';
import {
  EXPRESS_CARRIERS,
  type RedemptionExpressShippingView,
  type StaffProfile,
} from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
type Intent = { key: string; body: Record<string, unknown> };
export function ExpressShippingCorrection({
  view,
  profile,
  onDone,
  onRejected,
}: {
  view: RedemptionExpressShippingView;
  profile: StaffProfile;
  onDone: () => void;
  onRejected: (message: string) => void;
}) {
  const storage = 'yumi.express-correction.v1:' + profile.id + ':' + view.id;
  const [open, setOpen] = useState(false),
    [pending, setPending] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [code, setCode] = useState(view.shipment!.carrierCode),
    [name, setName] = useState(view.shipment!.carrierName),
    [tracking, setTracking] = useState(view.shipment!.trackingNo),
    [reason, setReason] = useState(''),
    [verified, setVerified] = useState(false);
  const active = useRef(true),
    working = useRef(false);
  function stored(): Intent | null {
    const raw = sessionStorage.getItem(storage);
    if (!raw) return null;
    const v = JSON.parse(raw) as Intent;
    if (!/^[a-f0-9-]{36}$/i.test(v.key) || !v.body || typeof v.body !== 'object')
      throw Error('原更正请求无法读取，请保留并核实');
    return v;
  }
  useEffect(() => {
    active.current = true;
    try {
      setPending(!!stored());
    } catch (e) {
      setError(e instanceof Error ? e.message : '原请求读取失败');
    }
    return () => {
      active.current = false;
    };
  }, []);
  async function submit() {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const intent = stored() ?? {
        key: crypto.randomUUID(),
        body: {
          version: view.shipment!.correctionVersion,
          carrierCode: code,
          carrierName:
            code === 'OTHER'
              ? name.trim()
              : EXPRESS_CARRIERS[code as keyof typeof EXPRESS_CARRIERS],
          trackingNo: tracking.trim(),
          reason: reason.trim(),
          verified,
        },
      };
      sessionStorage.setItem(storage, JSON.stringify(intent));
      setPending(true);
      await staffRequest('/admin/redemptions/' + view.id + '/shipping-corrections', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': profile.csrfToken,
          'Idempotency-Key': intent.key,
        },
        body: JSON.stringify(intent.body),
      });
      sessionStorage.removeItem(storage);
      if (active.current) {
        setPending(false);
        setOpen(false);
        setReason('');
        setVerified(false);
        onDone();
      }
    } catch (e) {
      if (active.current) {
        const message = e instanceof Error ? e.message : '更正结果尚未确认，请使用原请求核实';
        if (e instanceof StaffRequestError && e.status < 500) {
          sessionStorage.removeItem(storage);
          setPending(false);
          onRejected(message);
        } else {
          setPending(true);
          setError(message);
        }
      }
    } finally {
      working.current = false;
      if (active.current) setBusy(false);
    }
  }
  const changed =
    code !== view.shipment!.carrierCode ||
    (code === 'OTHER' && name.trim() !== view.shipment!.carrierName) ||
    tracking.trim().toUpperCase() !== view.shipment!.trackingNo;
  const valid =
    changed &&
    Object.hasOwn(EXPRESS_CARRIERS, code) &&
    /^[A-Z0-9][A-Z0-9-]{5,39}$/i.test(tracking.trim()) &&
    (code !== 'OTHER' || !!name.trim()) &&
    !!reason.trim() &&
    verified;
  return (
    <section aria-label="运单资料更正" className="picking-pack-proof">
      <h4>运单资料更正</h4>
      <p>用于纠正已寄出包裹的录入错误。不会重新发货、改变收件地址或调整积分库存。</p>
      {error && (
        <p className="notice task-error" role="alert">
          {error}
        </p>
      )}
      {pending ? (
        <div className="notice">
          <p>有一笔更正请求待核实，请使用原请求确认结果。</p>
          <button className="primary-button" disabled={busy} onClick={() => void submit()}>
            核实原更正请求
          </button>
        </div>
      ) : open ? (
        <form
          className="business-form express-shipping-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (valid) void submit();
          }}
        >
          <p>
            当前：{view.shipment!.carrierName} · {view.shipment!.trackingNo}
          </p>
          <label>
            更正后的快递公司
            <select
              aria-label="更正后的快递公司"
              disabled={busy}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            >
              {Object.entries(EXPRESS_CARRIERS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </label>
          {code === 'OTHER' && (
            <label>
              更正后的快递名称
              <input
                aria-label="更正后的快递名称"
                disabled={busy}
                maxLength={40}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
          )}
          <label>
            更正后的运单号
            <input
              aria-label="更正后的运单号"
              disabled={busy}
              maxLength={40}
              value={tracking}
              onChange={(e) => setTracking(e.target.value)}
            />
          </label>
          <label>
            更正原因
            <textarea
              aria-label="更正原因"
              disabled={busy}
              maxLength={200}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="说明录入错误，勿填写姓名、电话或地址"
            />
          </label>
          <label className="express-dispatch-confirm">
            <input
              type="checkbox"
              disabled={busy}
              checked={verified}
              onChange={(e) => setVerified(e.target.checked)}
            />
            已核对原包裹真实运单，本次仅更正录入资料
          </label>
          <p>原发货凭据和每次更正都会保留，用户端将显示最新资料。</p>
          <button className="primary-button" disabled={busy || !valid || !view.canCorrect}>
            {busy ? '正在保存…' : '保存运单更正'}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busy}
            onClick={() => {
              setOpen(false);
              setReason('');
              setVerified(false);
            }}
          >
            暂不更正
          </button>
        </form>
      ) : (
        <button
          className="secondary-button"
          disabled={!view.canCorrect || busy || !!error}
          onClick={() => setOpen(true)}
        >
          更正运单资料
        </button>
      )}
      {!view.canCorrect && !pending && <p className="notice">快递资料更正暂未开放</p>}
      <details>
        <summary>发货及更正记录（{view.shipmentHistory.length}）</summary>
        {view.shipmentHistory.map((h) => (
          <div key={h.version} className="notice">
            <strong>{h.version === 0 ? '原发货资料' : '运单资料更正'}</strong>
            <p>
              {h.carrierName} · {h.trackingNo}
            </p>
            {h.reason && <p>原因：{h.reason}</p>}
            <p>
              {h.actorName} ·{' '}
              {new Date(h.recordedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
              （北京时间）
            </p>
          </div>
        ))}
      </details>
    </section>
  );
}
