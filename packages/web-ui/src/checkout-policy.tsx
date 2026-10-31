import { useEffect, useRef, useState } from 'react';
import type { CheckoutPolicy, StaffProfile } from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
import { Modal } from './modal.js';
const money = (n: number) => '¥' + (n / 100).toFixed(2);
function cents(value: string) {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const [whole, part = ''] = value.split('.');
  const n = Number(whole) * 100 + Number(part.padEnd(2, '0'));
  return Number.isSafeInteger(n) && n <= 100000000 ? n : null;
}
export function CheckoutPolicyWorkbench({ profile }: { profile: StaffProfile }) {
  const [policy, setPolicy] = useState<CheckoutPolicy | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [editing, setEditing] = useState(false);
  const seq = useRef(0);
  async function load() {
    const n = ++seq.current;
    setLoading(true);
    setError('');
    try {
      const result = await staffRequest<{ policy: CheckoutPolicy | null }>(
        '/admin/checkout-policy',
      );
      if (n === seq.current) setPolicy(result.policy);
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '规则加载失败');
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
  return (
    <div className="service-area-workbench">
      <div className="notice">
        请先核实真实经营规则。新建默认暂停，金额不会自动填入开发样例；当前仅控制结算核验与报价，订单尚未开放。营业状态手动控制，尚未实现按时段自动营业。
      </div>
      <div className="service-area-toolbar">
        <button className="secondary-button" disabled={loading} onClick={() => void load()}>
          刷新规则
        </button>
      </div>
      {error && (
        <div role="alert" className="notice task-error">
          {error}
          <button onClick={() => void load()}>重试</button>
        </div>
      )}
      {loading ? (
        <div className="surface empty-state">正在读取报价规则…</div>
      ) : (
        <section className="surface">
          <div className="service-area-list-heading">
            <div>
              <h2>
                {policy ? (policy.open ? '已允许生成报价' : '报价已暂停') : '报价规则尚未配置'}
              </h2>
              <p>
                {policy
                  ? '修改规则后顾客需要重新核验；已生成的报价不会锁价或锁库存。'
                  : '未配置前，顾客可以核验商品和地址，但不会获得应付金额。'}
              </p>
            </div>
            {profile.permissions.includes('checkout-policy.write') && (
              <button
                className="primary-button"
                disabled={!!error}
                onClick={() => setEditing(true)}
              >
                {policy ? '编辑报价规则' : '配置真实规则'}
              </button>
            )}
          </div>
          <div className="checkout-policy-values">
            {[
              ['配送费', policy ? money(policy.deliveryFeeCents) : '待配置'],
              ['起送商品金额', policy ? money(policy.minGoodsCents) : '待配置'],
              [
                '免运门槛',
                policy
                  ? policy.freeDeliveryThresholdCents === null
                    ? '不设免运'
                    : money(policy.freeDeliveryThresholdCents)
                  : '待配置',
              ],
            ].map(([label, value]) => (
              <div key={label}>
                <p>{label}</p>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
        </section>
      )}
      {editing && (
        <PolicyEditor
          policy={policy}
          profile={profile}
          close={() => {
            setEditing(false);
            void load();
          }}
        />
      )}
    </div>
  );
}
function PolicyEditor({
  policy,
  profile,
  close,
}: {
  policy: CheckoutPolicy | null;
  profile: StaffProfile;
  close: () => void;
}) {
  const [fee, setFee] = useState(policy ? (policy.deliveryFeeCents / 100).toFixed(2) : ''),
    [minimum, setMinimum] = useState(policy ? (policy.minGoodsCents / 100).toFixed(2) : ''),
    [free, setFree] = useState(
      policy?.freeDeliveryThresholdCents === null || !policy
        ? ''
        : (policy.freeDeliveryThresholdCents / 100).toFixed(2),
    ),
    [open, setOpen] = useState(policy?.open ?? false);
  const [busy, setBusy] = useState(false),
    [unknown, setUnknown] = useState(false),
    [conflict, setConflict] = useState(false),
    [error, setError] = useState('');
  const intent = useRef<{ body: unknown; key: string } | null>(null),
    writing = useRef(false);
  const valid = cents(fee) !== null && cents(minimum) !== null && (!free || cents(free) !== null);
  async function save() {
    if (writing.current || conflict || !valid) return;
    writing.current = true;
    setBusy(true);
    setError('');
    const attempt = intent.current ?? {
      key: crypto.randomUUID(),
      body: {
        version: policy?.version ?? null,
        deliveryFeeCents: cents(fee),
        minGoodsCents: cents(minimum),
        freeDeliveryThresholdCents: free ? cents(free) : null,
        open,
      },
    };
    intent.current = attempt;
    try {
      await staffRequest('/admin/checkout-policy', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': profile.csrfToken,
          'Idempotency-Key': attempt.key,
        },
        body: JSON.stringify(attempt.body),
      });
      close();
    } catch (e) {
      if (
        e instanceof StaffRequestError &&
        e.status < 500 &&
        !(unknown && [401, 403, 429].includes(e.status))
      ) {
        intent.current = null;
        setUnknown(false);
        setConflict(e.code === 'POLICY_VERSION_CONFLICT');
        setError(e.message);
      } else {
        setUnknown(true);
        setError('保存结果尚未确认，请保留原内容并使用原操作重试。');
      }
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  const disabled = busy || unknown || conflict;
  return (
    <Modal title={policy ? '编辑报价规则' : '配置报价规则'} busy={busy || unknown} onClose={close}>
      <form
        className="service-area-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p className="notice">
          单位为元，最多两位小数。新建规则保存后保持暂停，请核对后再开启报价。
        </p>
        {error && (
          <p role="alert" className="notice task-error">
            {error}
          </p>
        )}
        <label>
          配送费（元）
          <input
            inputMode="decimal"
            required
            value={fee}
            disabled={disabled}
            onChange={(e) => setFee(e.target.value)}
            placeholder="填写实际配送费"
          />
        </label>
        <label>
          起送商品金额（元）
          <input
            inputMode="decimal"
            required
            value={minimum}
            disabled={disabled}
            onChange={(e) => setMinimum(e.target.value)}
            placeholder="填写实际起送金额，0 表示不设起送"
          />
        </label>
        <label>
          免运商品金额（元，留空表示不设免运）
          <input
            inputMode="decimal"
            value={free}
            disabled={disabled}
            onChange={(e) => setFree(e.target.value)}
            placeholder="可留空"
          />
        </label>
        {policy && (
          <label className="service-area-check">
            <input
              type="checkbox"
              checked={open}
              disabled={disabled}
              onChange={(e) => setOpen(e.target.checked)}
            />
            允许生成报价（手动控制）
          </label>
        )}
        <div className="modal-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busy || unknown}
            onClick={close}
          >
            {conflict ? '关闭并刷新' : '取消'}
          </button>
          <button className="primary-button" disabled={busy || conflict || !valid}>
            {busy ? '正在保存…' : unknown ? '原操作重试确认' : '保存规则'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
