import { useEffect, useRef, useState } from 'react';
import type {
  NotificationLabInfo,
  NotificationLabResult,
  StaffProfile,
  WarehouseSummary,
} from '@yumi/contracts';
import { staffRequest } from './index.js';
export function NotificationLabWorkbench({ profile }: { profile: StaffProfile }) {
  const [warehouses, setWarehouses] = useState<WarehouseSummary[]>([]),
    [warehouseId, setWarehouseId] = useState(''),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const seq = useRef(0);
  async function load() {
    const n = ++seq.current;
    setLoading(true);
    setError('');
    try {
      const r = await staffRequest<{ items: WarehouseSummary[] }>('/warehouse/warehouses');
      if (n === seq.current) {
        setWarehouses(r.items);
        setWarehouseId((old) => (r.items.some((w) => w.id === old) ? old : (r.items[0]?.id ?? '')));
      }
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '仓库读取失败');
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
    <div className="payment-readiness-workbench">
      <div className="notice">
        仅用临时生成的合成材料验证密码学流程。不会接收微信通知、扣款或修改订单；测试通过不代表真实支付验收。
      </div>
      {loading ? (
        <div className="surface empty-state" role="status">
          正在读取授权仓库…
        </div>
      ) : error ? (
        <div className="notice task-error" role="alert">
          {error}
          <button onClick={() => void load()}>重试读取仓库</button>
        </div>
      ) : !warehouses.length ? (
        <div className="surface empty-state">暂无授权仓库，请联系负责人。</div>
      ) : (
        <>
          <div className="toolbar">
            <label className="readiness-warehouse">
              验证仓库
              <select
                aria-label="验证仓库"
                value={warehouseId}
                onChange={(e) => setWarehouseId(e.target.value)}
              >
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <LabPanel key={warehouseId} warehouseId={warehouseId} profile={profile} />
        </>
      )}
    </div>
  );
}
function LabPanel({ warehouseId, profile }: { warehouseId: string; profile: StaffProfile }) {
  const [info, setInfo] = useState<NotificationLabInfo | null>(null),
    [result, setResult] = useState<NotificationLabResult | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const seq = useRef(0),
    active = useRef(false);
  const url = '/admin/payment-notification-lab?warehouseId=' + warehouseId;
  async function load() {
    const n = ++seq.current;
    setLoading(true);
    setError('');
    setInfo(null);
    setResult(null);
    try {
      const r = await staffRequest<NotificationLabInfo>(url);
      if (n === seq.current) setInfo(r);
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '验证说明读取失败');
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      seq.current++;
    };
  }, [warehouseId]);
  async function run() {
    if (active.current || !info?.enabled) return;
    active.current = true;
    setBusy(true);
    setError('');
    setResult(null);
    const n = ++seq.current;
    try {
      const r = await staffRequest<NotificationLabResult>(
        '/admin/payment-notification-lab/run?warehouseId=' + warehouseId,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
          body: '{}',
        },
      );
      if (n === seq.current) setResult(r);
    } catch (e) {
      if (n === seq.current)
        setError(e instanceof Error ? e.message : '隔离验证未完成，请重新运行');
    } finally {
      active.current = false;
      if (n === seq.current) setBusy(false);
    }
  }
  return (
    <>
      <div className="readiness-heading">
        <div>
          <h2>通知隔离验证</h2>
          <p>先验证原文签名，再解密与核对绑定信息。</p>
        </div>
        <button className="secondary-button" disabled={loading || busy} onClick={() => void load()}>
          刷新验证说明
        </button>
      </div>
      {error && (
        <div className="notice task-error" role="alert">
          {error}
          <button
            className="text-button"
            disabled={busy}
            onClick={() => void (info ? run() : load())}
          >
            重试验证
          </button>
        </div>
      )}
      {loading ? (
        <div className="surface empty-state" role="status">
          正在读取验证说明…
        </div>
      ) : info ? (
        <>
          <section className="surface readiness-summary">
            <span className="badge amber">合成材料 · 非真实支付</span>
            <h2>{info.enabled ? '可运行本机隔离验证' : '本机隔离验证尚未开启'}</h2>
            <p>
              临时RSA公钥/私钥与对称密钥只在服务端内存生成，不上传、不保存、不返回。此页没有填写真实密钥或报文的表单。
            </p>
            <p>
              {info.enabled
                ? '每次独立运行以下场景，结果不改变订单、库存或支付准备记录。'
                : '默认关闭。由本机部署显式开启后才可运行；生产和非本机数据库拒绝开启。'}
            </p>
            <button
              className="primary-button"
              disabled={!info.enabled || busy}
              onClick={() => void run()}
            >
              {busy ? '正在运行合成验证…' : '运行合成验证'}
            </button>
          </section>
          {result && (
            <section className="surface readiness-summary notification-lab-result" role="status">
              <h2>
                {result.results.every((r) => r.status === 'PASSED')
                  ? '合成验证全部通过'
                  : '合成验证存在失败'}
              </h2>
              <p>
                仅验证本次合成材料，真实回调入口仍关闭。密码学检查不等同通知去重、业务入账或支付成功。
              </p>
              <small>
                运行时间{' '}
                {new Date(result.completedAt).toLocaleString('zh-CN', {
                  timeZone: 'Asia/Shanghai',
                  hour12: false,
                })}
              </small>
            </section>
          )}
          <section className="surface">
            <div className="service-area-list-heading">
              <div>
                <h2>验证场景</h2>
                <p>失败用例应被拒绝，才算该场景通过。</p>
              </div>
            </div>
            <div className="readiness-checks">
              {info.cases.map((c) => {
                const row = result?.results.find((r) => r.code === c.code);
                return (
                  <article className="readiness-check" key={c.code}>
                    <div>
                      <h3>{c.title}</h3>
                      <span
                        className={
                          'badge ' +
                          (row?.status === 'PASSED'
                            ? 'green'
                            : row?.status === 'FAILED'
                              ? 'red'
                              : '')
                        }
                      >
                        {row ? (row.status === 'PASSED' ? '验证通过' : '验证失败') : '尚未运行'}
                      </span>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
          <section className="surface readiness-help">
            <h2>仍需后续交付</h2>
            <p>
              真实可信公钥管理、原始请求体接收、通知持久化去重、订单/支付单匹配、金额核验与补偿尚未组成可用回调流程。本页不开放支付或推进履约。
            </p>
            <a
              href="https://pay.wechatpay.cn/doc/v3/merchant/4013053249"
              target="_blank"
              rel="noreferrer"
            >
              查看微信支付官方验签说明 ↗
            </a>
          </section>
        </>
      ) : null}
    </>
  );
}
