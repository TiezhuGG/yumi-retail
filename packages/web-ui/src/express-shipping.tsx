import { useEffect, useRef, useState } from 'react';
import { ExpressShippingCorrection } from './express-shipping-correction.js';
import {
  EXPRESS_CARRIERS,
  formatRedemptionAddress,
  type RedemptionExpressShippingView,
  type StaffProfile,
} from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
const reasons: Record<string, string> = {
  ORDER_CANCELED: '订单已取消',
  WAREHOUSE_PAUSED: '仓库已暂停',
  SOURCE_UNAVAILABLE: '原商品或规格已暂停',
  INVENTORY_HELD: '库存冻结或盘点中',
  ALLOCATION_INCOMPLETE: '原预占不完整',
  ALLOCATION_RELEASED: '原预占已释放',
  CONSUMPTION_UNVERIFIED: '出库凭据需核查',
  LOCATION_DISABLED: '原库位已停用',
  LOT_EXPIRED: '原批次已过期',
  RESERVATION_UNAVAILABLE: '原库存或预占需核查',
  POINTS_EVIDENCE_MISSING: '扣积分凭据需核查',
  EXPRESS_STATE_CHANGED: '发货状态已变化，请核查',
};
type Intent = { key: string; body: Record<string, unknown> };
export function ExpressShippingPanel({
  id,
  profile,
  onShipped,
}: {
  id: string;
  profile: StaffProfile;
  onShipped: () => void;
}) {
  const [view, setView] = useState<RedemptionExpressShippingView | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [pending, setPending] = useState(false),
    [code, setCode] = useState(''),
    [name, setName] = useState(''),
    [tracking, setTracking] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const seq = useRef(0),
    working = useRef(false);
  const storage = 'yumi.express-ship.v1:' + profile.id + ':' + id;
  function stored(): Intent | null {
    const raw = sessionStorage.getItem(storage);
    if (!raw) return null;
    const value = JSON.parse(raw) as Intent;
    if (!/^[a-f0-9-]{36}$/i.test(value.key) || !value.body || typeof value.body !== 'object')
      throw Error('原发货请求无法读取，请保留并核实');
    return value;
  }
  async function load() {
    const n = ++seq.current;
    setLoading(true);
    setError('');
    setView(null);
    try {
      setPending(!!stored());
      const v = await staffRequest<RedemptionExpressShippingView>(
        '/admin/redemptions/' + id + '/shipping',
      );
      if (n === seq.current) setView(v);
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '发货资料读取失败');
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
  async function ship() {
    if (working.current || !view) return;
    working.current = true;
    setBusy(true);
    setError('');
    const n = seq.current;
    try {
      const intent = stored() ?? {
        key: crypto.randomUUID(),
        body: {
          version: view.version,
          carrierCode: code,
          carrierName:
            code === 'OTHER'
              ? name.trim()
              : EXPRESS_CARRIERS[code as keyof typeof EXPRESS_CARRIERS],
          trackingNo: tracking.trim(),
          dispatchConfirmed: confirmed,
        },
      };
      sessionStorage.setItem(storage, JSON.stringify(intent));
      setPending(true);
      await staffRequest('/admin/redemptions/' + id + '/ship', {
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
      setConfirmed(false);
      setBusy(false);
      await load();
      onShipped();
    } catch (e) {
      if (n === seq.current) {
        if (e instanceof StaffRequestError && e.status < 500) {
          sessionStorage.removeItem(storage);
          setPending(false);
          setView(null);
        }
        setError(e instanceof Error ? e.message : '发货结果尚未确认，请使用原请求核实');
      }
    } finally {
      working.current = false;
      if (n === seq.current) setBusy(false);
    }
  }
  const valid =
    Object.hasOwn(EXPRESS_CARRIERS, code) &&
    /^[A-Z0-9][A-Z0-9-]{5,39}$/i.test(tracking.trim()) &&
    (code !== 'OTHER' || !!name.trim()) &&
    confirmed;
  return (
    <section className="express-shipping-panel picking-pack-proof" aria-label="快递发货">
      <h3>快递发货</h3>
      {loading && <p role="status">正在读取发货资料…</p>}
      {error && (
        <p className="notice task-error" role="alert">
          {error}
        </p>
      )}
      {view && (
        <>
          <div className="notice">
            <strong>原订单收件信息</strong>
            <p>
              {view.address.contactName} · {view.address.phone}
            </p>
            <p>{formatRedemptionAddress(view.address)}</p>
            {view.address.note && <p>备注：{view.address.note}</p>}
          </div>
          {view.shipment && (
            <div className="picking-pack-proof">
              {view.shipment.parcel && (
                <p className="notice">
                  同包发货 · 共{view.shipment.parcel.orderCount}笔订单。运单更正会同步整个包裹。
                </p>
              )}
              <h4>{view.shipment.receivedAt ? '已完成 · 用户确认收货' : '已快递发货'}</h4>
              {view.shipment.receivedAt && (
                <p>
                  用户确认收货时间：
                  {new Date(view.shipment.receivedAt).toLocaleString('zh-CN', {
                    timeZone: 'Asia/Shanghai',
                  })}
                  （北京时间）
                </p>
              )}
              <p>
                {view.shipment.carrierName} · 运单号：{view.shipment.trackingNo}
              </p>
              <p>
                记录时间：
                {new Date(view.shipment.shippedAt).toLocaleString('zh-CN', {
                  timeZone: 'Asia/Shanghai',
                })}
                （北京时间）
              </p>
              <p>此记录为门店发货确认，运输进度请凭运单号向快递公司查询。</p>
              {view.shipment.correctedAt && <p>运单资料已更正，原发货时间不变。更正记录见下方。</p>}
            </div>
          )}
          {view.shipment && !pending && (
            <ExpressShippingCorrection
              view={view}
              profile={profile}
              onDone={() => {
                void load();
                onShipped();
              }}
              onRejected={(message) => {
                setView(null);
                setError(message);
              }}
            />
          )}
          {pending ? (
            <div className="notice">
              <p>有一笔发货请求待核实，请保留原请求，避免重复出库。</p>
              <button
                className="primary-button"
                disabled={busy || loading}
                onClick={() => void ship()}
              >
                核实原发货请求
              </button>
            </div>
          ) : (
            !view.shipment && (
              <>
                <p>
                  整单一次发货。请核对下方实物预占凭据中的批次、库位及件数，并核对原收件信息和运单；交给快递后确认。
                </p>
                {!view.enabled && <p className="notice">快递发货暂未开放</p>}
                {view.blockers.length > 0 && (
                  <div className="notice" role="alert">
                    {view.blockers.map((x) => (
                      <p key={x}>{reasons[x] ?? '当前资料需核查'}</p>
                    ))}
                  </div>
                )}
                <form
                  className="business-form express-shipping-form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (valid) void ship();
                  }}
                >
                  <label>
                    快递公司
                    <select
                      aria-label="快递公司"
                      value={code}
                      disabled={busy || loading || !view.canShip}
                      onChange={(e) => setCode(e.target.value)}
                    >
                      <option value="">请选择快递公司</option>
                      {Object.entries(EXPRESS_CARRIERS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  {code === 'OTHER' && (
                    <label>
                      其他快递名称
                      <input
                        aria-label="其他快递名称"
                        maxLength={40}
                        value={name}
                        disabled={busy || !view.canShip}
                        onChange={(e) => setName(e.target.value)}
                      />
                    </label>
                  )}
                  <label>
                    快递运单号
                    <input
                      aria-label="快递运单号"
                      maxLength={40}
                      value={tracking}
                      disabled={busy || loading || !view.canShip}
                      onChange={(e) => setTracking(e.target.value)}
                      placeholder="填写实际快递单号"
                    />
                  </label>
                  <label className="express-dispatch-confirm">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      disabled={busy || loading || !view.canShip}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    已核对全部实物、原收件信息和运单，确认整单已交给快递
                  </label>
                  <p>确认将扣减原预占实物库存，不会再次扣积分。已发货不能直接取消。</p>
                  <button
                    className="primary-button"
                    disabled={busy || loading || !view.canShip || !valid}
                  >
                    {busy ? '正在确认…' : '确认快递发货'}
                  </button>
                </form>
              </>
            )
          )}
        </>
      )}
      <button className="secondary-button" disabled={busy || loading} onClick={() => void load()}>
        刷新发货资料
      </button>
    </section>
  );
}
