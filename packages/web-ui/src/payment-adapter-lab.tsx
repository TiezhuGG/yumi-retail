import { useEffect, useRef, useState } from 'react';
import type {
  NotificationLabInfo,
  PaymentAdapterLabResult,
  StaffProfile,
  WarehouseSummary,
} from '@yumi/contracts';
import { staffRequest } from './index.js';
export function PaymentAdapterLabWorkbench({ profile }: { profile: StaffProfile }) {
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
        仅验证内存合成查询响应的分类契约。不会创建订单、调用渠道、释放库存或执行退款；测试通过不代表真实支付验收。
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
    [result, setResult] = useState<PaymentAdapterLabResult | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const seq = useRef(0),
    active = useRef(false);
  const url = '/admin/payment-adapter-lab?warehouseId=' + warehouseId;
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
      const r = await staffRequest<PaymentAdapterLabResult>(
        '/admin/payment-adapter-lab/run?warehouseId=' + warehouseId,
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
          <h2>渠道契约验证</h2>
          <p>核对超时、限流及异常响应的保护性分类，不发起网络请求。</p>
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
              场景覆盖可信成功/关闭、支付中、超时、限流、系统错误、订单不存在、未验签及订单/金额不匹配。
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
                以下分类来自本次实际运行的共享适配器核心。继续查单需外层重新安排，人工核查不改变支付状态，核对入账不代表已入账。
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
                <p>实际判定符合保护规则，才算该场景通过。</p>
              </div>
            </div>
            <div className="readiness-checks">
              {info.cases.map((c) => {
                const row = result?.results.find((r) => r.code === c.code);
                return (
                  <article className="readiness-check adapter-check" key={c.code}>
                    <div>
                      <h3>{c.title}</h3>
                      {row && (
                        <p>
                          分类：{row.classification} · 证据：
                          {row.evidence === 'UNKNOWN'
                            ? '结果未知'
                            : row.evidence === 'CLOSED'
                              ? '合成关闭'
                              : '合成成功'}{' '}
                          · 建议：
                          {row.next === 'RETRY'
                            ? '继续查单'
                            : row.next === 'REVIEW'
                              ? '人工核查'
                              : '事务核对'}
                        </p>
                      )}
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
              此契约不包含真实HTTP适配器、响应密码学验签、凭据管理或数据库写入，合成 authenticated
              标志不等同验签。现有查询Worker仍只生成合成未知结果；下一步接入分类持久化与任务处理，不自动退款或推进履约。
            </p>
          </section>
        </>
      ) : null}
    </>
  );
}
