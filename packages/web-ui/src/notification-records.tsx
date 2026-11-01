import { useEffect, useRef, useState } from 'react';
import type {
  NotificationRecords,
  NotificationAttemptOptions,
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
    [message, setMessage] = useState(''),
    [attemptId, setAttemptId] = useState(''),
    [options, setOptions] = useState<NotificationAttemptOptions>({ items: [], nextCursor: null });
  const seq = useRef(0),
    active = useRef(false),
    pendingKeys = useRef<Record<string, string>>({});
  const base = '/admin/payment-notification-records',
    query = '?warehouseId=' + warehouseId;
  async function load(cursor?: string) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError('');
    const n = ++seq.current;
    try {
      const [r, bindings] = await Promise.all([
        staffRequest<NotificationRecords>(base + query + (cursor ? '&cursor=' + cursor : '')),
        staffRequest<NotificationAttemptOptions>(base + '/attempts' + query),
      ]);
      if (n === seq.current)
        setOptions((old) => ({
          ...bindings,
          items: [
            ...bindings.items,
            ...old.items.filter(
              (x) => x.id === attemptId && !bindings.items.some((b) => b.id === x.id),
            ),
          ],
        }));
      if (n === seq.current) {
        setData((old) =>
          cursor && old
            ? {
                ...r,
                items: [
                  ...old.items,
                  ...r.items.filter((x) => !old.items.some((b) => b.id === x.id)),
                ],
              }
            : r,
        );
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
  async function moreOptions() {
    if (active.current || !options.nextCursor) return;
    active.current = true;
    setBusy(true);
    setError('');
    const n = ++seq.current;
    try {
      const r = await staffRequest<NotificationAttemptOptions>(
        base + '/attempts' + query + '&cursor=' + options.nextCursor,
      );
      if (n === seq.current)
        setOptions((old) => ({
          ...r,
          items: [...old.items, ...r.items.filter((x) => !old.items.some((b) => b.id === x.id))],
        }));
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '绑定读取失败');
    } finally {
      if (n === seq.current) {
        active.current = false;
        setBusy(false);
      }
    }
  }
  async function write(replay?: NotificationRecord) {
    if (active.current || !data?.enabled) return;
    active.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    const n = ++seq.current;
    const target = attemptId || 'standalone';
    if (!replay) pendingKeys.current[target] ??= crypto.randomUUID();
    try {
      const result = await staffRequest<NotificationRecorded>(
        base + (replay ? '/' + replay.id + '/replay' : '') + query,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': profile.csrfToken },
          body: JSON.stringify(
            replay ? {} : { key: pendingKeys.current[target], ...(attemptId ? { attemptId } : {}) },
          ),
        },
      );
      if (n !== seq.current) return;
      if (!replay) delete pendingKeys.current[target];
      setSelected(result.record);
      setMessage(
        result.duplicate
          ? '重复通知已识别，返回原记录，未新增记录或业务操作。'
          : result.record.application
            ? result.applied
              ? '合成通知已关联尝试并追加证据；未入账或处理真实支付。'
              : '通知已保存，交易证据已存在，未重复追加。'
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
            <label className="query-scenario">
              关联合成尝试
              <select
                aria-label="关联合成尝试"
                value={attemptId}
                disabled={busy || !data.enabled}
                onChange={(e) => setAttemptId(e.target.value)}
              >
                <option value="">独立保存，不关联尝试</option>
                {options.items.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.label} · ¥{(b.amountCents / 100).toFixed(2)}（固定测试金额）
                  </option>
                ))}
              </select>
            </label>
            {options.nextCursor && (
              <button className="text-button" disabled={busy} onClick={() => void moreOptions()}>
                更多可关联尝试
              </button>
            )}
            <p>
              旧记录不自动关联；选择尝试后将按固定测试绑定核验。多条通知可关联同一交易，但只追加一次成功证据。
            </p>
            <button
              className="primary-button"
              disabled={busy || !data.enabled}
              onClick={() => void write()}
            >
              {busy
                ? '正在处理…'
                : pendingKeys.current[attemptId || 'standalone']
                  ? '重试创建合成记录'
                  : '创建合成记录'}
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
                      <span className="badge amber">
                        {row.application ? '已关联合成证据' : '仅记录'}
                      </span>
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
              <p>已验签并解密 · {selected.application ? '已关联合成证据' : '仅记录'} · 未入账</p>
              {selected.application && (
                <div className="notice">
                  关联合成尝试 · {selected.application.attemptId.slice(-8)}
                  。当前证据请在“支付尝试”详情查看；通知成功不代表真实收款，冲突仍需核查。
                </div>
              )}
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
