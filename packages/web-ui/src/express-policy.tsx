import { useEffect, useRef, useState } from 'react';
import type { StaffProfile, RedemptionExpressPolicy } from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
export function ExpressPolicyWorkbench({ profile }: { profile: StaffProfile }) {
  const [policy, setPolicy] = useState<RedemptionExpressPolicy | null>(null),
    [enabled, setEnabled] = useState(false),
    [provinces, setProvinces] = useState(''),
    [reason, setReason] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState(false);
  const seq = useRef(0),
    working = useRef(false);
  const storage = 'yumi.express-policy.v1:' + profile.id;
  async function load() {
    const n = ++seq.current;
    try {
      const p = await staffRequest<RedemptionExpressPolicy>('/admin/redemption-express-policy');
      if (n !== seq.current) return;
      setPolicy(p);
      setEnabled(p.enabled);
      setProvinces(p.provinces.join('，'));
      setPending(!!sessionStorage.getItem(storage));
      setError('');
    } catch (e) {
      if (n === seq.current) {
        setPolicy(null);
        setError(e instanceof Error ? e.message : '规则读取失败');
      }
    }
  }
  useEffect(() => {
    void load();
    return () => {
      seq.current++;
    };
  }, []);
  async function save() {
    if (working.current || !policy) return;
    working.current = true;
    setBusy(true);
    setError('');
    const n = seq.current;
    try {
      const raw = sessionStorage.getItem(storage);
      const intent = raw
        ? (JSON.parse(raw) as { key: string; body: unknown })
        : {
            key: crypto.randomUUID(),
            body: {
              version: policy.version,
              enabled,
              provinces: provinces
                .split(/[，,\n]/)
                .map((x) => x.trim())
                .filter(Boolean),
              shippingFeeMode: 'SENDER_PAID',
              reason: reason.trim(),
            },
          };
      if (!/^[a-f0-9-]{36}$/i.test(intent.key) || !intent.body)
        throw Error('原规则请求无法读取，请保留并核查');
      sessionStorage.setItem(storage, JSON.stringify(intent));
      setPending(true);
      await staffRequest('/admin/redemption-express-policy/update', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': profile.csrfToken,
          'Idempotency-Key': intent.key,
        },
        body: JSON.stringify(intent.body),
      });
      sessionStorage.removeItem(storage);
      if (n !== seq.current) return;
      setPending(false);
      setReason('');
      await load();
    } catch (e) {
      if (n === seq.current) {
        if (e instanceof StaffRequestError && e.status < 500) {
          sessionStorage.removeItem(storage);
          setPending(false);
        }
        setError(e instanceof Error ? e.message : '规则结果尚未确认，请使用原请求核实');
      }
    } finally {
      working.current = false;
      setBusy(false);
    }
  }
  return (
    <details className="reward-detail express-policy">
      <summary>快递寄送规则</summary>
      <p>
        未配置或暂停时不受理快递兑换。运费由商家承担，顾客不另付现金；范围仅按下列完整省名校验，寄出前仍需核实详细地址和承运条件。
      </p>
      {!policy ? (
        <p>尚未读取规则</p>
      ) : (
        <form
          className="business-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label>
            <input
              type="checkbox"
              checked={enabled}
              disabled={busy || pending}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            开放快递兑换（仅配置范围）
          </label>
          <label>
            可寄送省份
            <textarea
              aria-label="可寄送省份"
              maxLength={1400}
              disabled={busy || pending}
              value={provinces}
              onChange={(e) => setProvinces(e.target.value)}
              placeholder="完整省名，以逗号分隔，例如：浙江省，江苏省"
            />
          </label>
          <p>运费承担：商家承担</p>
          <label>
            调整原因
            <input
              aria-label="快递规则调整原因"
              maxLength={300}
              value={reason}
              disabled={busy || pending}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <button className="primary-button" disabled={busy || (!pending && !reason.trim())}>
            {busy ? '正在核实…' : pending ? '使用原请求核实规则' : '保存快递规则'}
          </button>
        </form>
      )}
      {error && <p role="alert">{error}</p>}
      <button className="secondary-button" disabled={busy || pending} onClick={() => void load()}>
        刷新快递规则
      </button>
    </details>
  );
}
