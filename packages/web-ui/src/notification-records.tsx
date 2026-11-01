import { useEffect, useRef, useState } from 'react';
import type {
  NotificationRecords,
  NotificationRecord,
  NotificationRecorded,
  StaffProfile,
  WarehouseSummary,
} from '@yumi/contracts';
import { staffRequest } from './index.js';
export function NotificationRecordsWorkbench({ profile }: { profile: StaffProfile }) {
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
        独立保存合成通知的最小事实，支持重复接收验证。不会接收真实微信通知、记账或修改订单；记录不代表支付成功。
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
          <RecordsPanel key={warehouseId} warehouseId={warehouseId} profile={profile} />
        </>
      )}
    </div>
  );
}
function RecordsPanel({ warehouseId, profile }: { warehouseId: string; profile: StaffProfile }) {
  const [data, setData] = useState<NotificationRecords | null>(null),
    [selected, setSelected] = useState<NotificationRecord | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const seq = useRef(0),
    active = useRef(false),
    pendingKey = useRef<string | null>(null);
  const base = '/admin/payment-notification-records',
    query = '?warehouseId=' + warehouseId;
  async function load(cursor?: string) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError('');
    const n = ++seq.current;
    try {
      const r = await staffRequest<NotificationRecords>(
        base + query + (cursor ? '&cursor=' + cursor : ''),
      );
      if (n === seq.current) {
        setData((old) => (cursor && old ? { ...r, items: [...old.items, ...r.items] } : r));
      }
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '记录读取失败');
    } finally {
      if (n === seq.current) {
        active.current = false;
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    void load();
    return () => {
      seq.current++;
      active.current = false;
    };
  }, [warehouseId]);
  async function write(replay?: NotificationRecord) {
    if (active.current || !data?.enabled) return;
    active.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    const n = ++seq.current;
    if (!replay) pendingKey.current ??= crypto.randomUUID();
    try {
      const result = await staffRequest<NotificationRecorded>(
        base + (replay ? '/' + replay.id + '/replay' : '') + query,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
          body: JSON.stringify(replay ? {} : { key: pendingKey.current }),
        },
      );
      if (n !== seq.current) return;
      if (!replay) pendingKey.current = null;
      setSelected(result.record);
      setMessage(
        result.duplicate
          ? '重复通知已识别，返回原记录，未新增记录或业务操作。'
          : '合成通知已验签并保存，仅记录事实，未处理支付。',
      );
      const fresh = await staffRequest<NotificationRecords>(base + query);
      if (n === seq.current) setData(fresh);
    } catch (e) {
      if (n === seq.current)
        setError(e instanceof Error ? e.message : '接收结果未确认，请使用原操作重试');
    } finally {
      if (n === seq.current) {
        active.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <>
      <div className="readiness-heading">
        <div>
          <h2>合成通知记录</h2>
          <p>同一通知仅保存一次；已验证事实冲突时拒绝覆盖。</p>
        </div>
        <button className="secondary-button" disabled={busy} onClick={() => void load()}>
          刷新记录
        </button>
      </div>
      {error && (
        <div className="notice task-error" role="alert">
          {error}
          <button className="text-button" disabled={busy} onClick={() => void load()}>
            重试读取记录
          </button>
        </div>
      )}
      {message && (
        <div className="notice" role="status">
          {message}
        </div>
      )}
      {!data ? (
        <div className="surface empty-state" role="status">
          {busy ? '正在读取通知记录…' : '记录暂不可用，请重试。'}
        </div>
      ) : (
        <>
          <section className="surface readiness-summary">
            <span className="badge amber">合成材料 · 非真实支付</span>
            <h2>{data.enabled ? '可接收本机合成通知' : '本机合成接收尚未开启'}</h2>
            <p>原始报文、付款人信息和密钥不落库。合成记录独立保存，真实回调入口保持关闭。</p>
            <button
              className="primary-button"
              disabled={busy || !data.enabled}
              onClick={() => void write()}
            >
              {busy ? '正在处理…' : pendingKey.current ? '重试创建合成记录' : '创建合成记录'}
            </button>
          </section>
          <section className="surface">
            <div className="service-area-list-heading">
              <h2>接收历史</h2>
              <small>仅记录，未入账</small>
            </div>
            {!data.items.length ? (
              <div className="empty-state">暂无合成通知记录</div>
            ) : (
              <div className="readiness-checks">
                {data.items.map((row) => (
                  <article className="readiness-check" key={row.id}>
                    <div>
                      <h3>合成通知 · {row.notificationId.slice(-8)}</h3>
                      <span className="badge amber">仅记录</span>
                    </div>
                    <p>
                      {new Date(row.createdAt).toLocaleString('zh-CN', {
                        timeZone: 'Asia/Shanghai',
                        hour12: false,
                      })}{' '}
                      · ¥{(row.amountCents / 100).toFixed(2)}
                    </p>
                    <button
                      className="text-button"
                      disabled={busy}
                      onClick={() => setSelected(row)}
                    >
                      查看记录
                    </button>
                  </article>
                ))}
              </div>
            )}
            {data.nextCursor && (
              <button
                className="secondary-button"
                disabled={busy}
                onClick={() => void load(data.nextCursor!)}
              >
                加载更多记录
              </button>
            )}
          </section>
          {selected && (
            <section className="surface readiness-summary notification-record-detail">
              <h2>合成通知详情</h2>
              <p>已验签并解密 · 仅记录 · 未入账</p>
              <dl>
                <dt>通知标识</dt>
                <dd style={{ overflowWrap: 'anywhere' }}>{selected.notificationId}</dd>
                <dt>合成商户单号</dt>
                <dd style={{ overflowWrap: 'anywhere' }}>{selected.outTradeNo}</dd>
                <dt>合成交易标识</dt>
                <dd style={{ overflowWrap: 'anywhere' }}>{selected.transactionId}</dd>
                <dt>核验金额</dt>
                <dd>
                  ¥{(selected.amountCents / 100).toFixed(2)} {selected.currency}
                </dd>
              </dl>
              <p>重放会重新生成签名与密文，以已验证事实识别重复，不推进支付或履约。</p>
              <button
                className="secondary-button"
                disabled={busy || !data.enabled}
                onClick={() => void write(selected)}
              >
                重放此合成通知
              </button>
            </section>
          )}
        </>
      )}
    </>
  );
}
