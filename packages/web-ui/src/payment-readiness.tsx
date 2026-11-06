import { useEffect, useRef, useState } from 'react';
import type { PaymentReadiness, PaymentReadinessCheck, WarehouseSummary } from '@yumi/contracts';
import { staffRequest } from './index.js';
const labels: Record<PaymentReadinessCheck['status'], string> = {
  MISSING: '未配置',
  INVALID: '格式不符',
  FORMAT_OK: '格式通过 · 未联通',
  CONFIGURED: '已有配置 · 待验收',
  UNVERIFIED: '待验证',
  BLOCKED: '尚未就绪',
};
const groups: Record<PaymentReadinessCheck['group'], string> = {
  CONFIGURATION: '非敏感配置',
  OPERATIONS: '经营准备',
  IMPLEMENTATION: '渠道能力',
  ACCEPTANCE: '账号与环境验收',
};
export function PaymentReadinessWorkbench() {
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
        仅检查接入准备，不发起支付或联网探测。不接收密钥；配置格式通过也不会开启真实渠道。
      </div>
      {loading ? (
        <div className="surface empty-state" role="status">
          正在读取授权仓库…
        </div>
      ) : error ? (
        <div className="surface empty-state" role="alert">
          {error}
          <button className="secondary-button" onClick={() => void load()}>
            重试仓库读取
          </button>
        </div>
      ) : !warehouses.length ? (
        <div className="surface empty-state">暂无授权仓库，请联系负责人。</div>
      ) : (
        <>
          <div className="toolbar">
            <label className="readiness-warehouse">
              检查仓库
              <select
                aria-label="检查仓库"
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
          <ReadinessReport key={warehouseId} warehouseId={warehouseId} />
        </>
      )}
    </div>
  );
}
function ReadinessReport({ warehouseId }: { warehouseId: string }) {
  const [report, setReport] = useState<PaymentReadiness | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const seq = useRef(0);
  async function load() {
    const n = ++seq.current;
    setLoading(true);
    setError('');
    setReport(null);
    try {
      const r = await staffRequest<PaymentReadiness>(
        '/admin/payment-readiness?warehouseId=' + warehouseId,
      );
      if (n === seq.current) setReport(r);
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '接入检查读取失败');
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
  return (
    <>
      <div className="readiness-heading">
        <div>
          <h2>支付接入准备</h2>
          <p>按配置、经营和实际能力分别检查。</p>
        </div>
        <button className="secondary-button" disabled={loading} onClick={() => void load()}>
          刷新接入检查
        </button>
      </div>
      {error && (
        <div className="notice task-error" role="alert">
          {error}
          <button className="text-button" onClick={() => void load()}>
            重新检查
          </button>
        </div>
      )}
      {loading ? (
        <div className="surface empty-state" role="status">
          正在读取接入检查…
        </div>
      ) : report ? (
        <>
          <section className="surface readiness-summary">
            <span className="badge amber">真实支付未开放</span>
            <h2>当前不能发起支付</h2>
            <p>本机支付准备记录只保存金额与状态，不代表渠道下单或扣款。</p>
            <small>
              {report.warehouse.name} · 检查时间{' '}
              {new Date(report.checkedAt).toLocaleString('zh-CN', {
                timeZone: 'Asia/Shanghai',
                hour12: false,
              })}
            </small>
          </section>
          {(Object.keys(groups) as Array<PaymentReadinessCheck['group']>).map((group) => (
            <section className="surface" key={group}>
              <div className="service-area-list-heading">
                <div>
                  <h2>{groups[group]}</h2>
                  <p>
                    {group === 'CONFIGURATION'
                      ? '仅返回检查状态，不显示AppID、商户号、通知地址或加密密钥的原值。'
                      : group === 'IMPLEMENTATION'
                        ? '离线协议验证与真实渠道联通分别验收，签名参数不代表支付成功。'
                        : group === 'ACCEPTANCE'
                          ? '未经实际联通与验收的项目始终保持待验证。'
                          : '配置存在与业务能力可用分别记录。'}
                  </p>
                </div>
              </div>
              <div className="readiness-checks">
                {report.checks
                  .filter((c) => c.group === group)
                  .map((c) => (
                    <article className="readiness-check" key={c.code}>
                      <div>
                        <h3>{c.title}</h3>
                        <span
                          className={
                            'badge ' +
                            (c.status === 'INVALID' ? 'red' : c.status === 'BLOCKED' ? 'amber' : '')
                          }
                        >
                          {labels[c.status]}
                        </span>
                      </div>
                      <p>{c.detail}</p>
                    </article>
                  ))}
              </div>
            </section>
          ))}
          <section className="surface readiness-help">
            <h2>下一步准备</h2>
            <p>
              先核实真实经营资料、商户与小程序绑定，再通过受控部署提供凭据。请勿在聊天、此页面或代码仓库填写私钥和APIv3密钥。
            </p>
            <p>
              本页没有启用渠道或修改经营规则的操作。渠道实现、通知处理和实际验收完成前保持禁用。
            </p>
            <a
              href="https://pay.wechatpay.cn/doc/v3/merchant/4013070756"
              target="_blank"
              rel="noreferrer"
            >
              查看微信支付官方参数说明 ↗
            </a>
          </section>
        </>
      ) : null}
    </>
  );
}
