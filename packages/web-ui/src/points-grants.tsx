import { useEffect, useRef, useState } from 'react';
import type { StaffProfile } from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
import { Modal } from './modal.js';
type Grant = {
  id: string;
  userId: string;
  displayName: string;
  amount: string;
  reason: string;
  reference: string;
  creatorId: string;
  status: string;
  version: number;
  decisionReason: string | null;
};
type Policy = { enabled: boolean; singleLimit: string; dailyLimit: string; version: number };
type Data = { policy: Policy | null; items: Grant[]; nextCursor: string | null };
type Intent = { path: string; body: unknown; key: string };
const labels: Record<string, string> = {
  SUBMITTED: '待审批',
  APPROVED: '已入账',
  REJECTED: '已驳回',
  CANCELED: '已撤销',
};
export function PointsGrants({ profile }: { profile: StaffProfile }) {
  const [data, setData] = useState<Data>({ policy: null, items: [], nextCursor: null }),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<'create' | 'policy' | null>(null),
    [selected, setSelected] = useState<Grant | null>(null),
    [busy, setBusy] = useState(false),
    [unknown, setUnknown] = useState(false);
  const [users, setUsers] = useState<Array<{ id: string; displayName: string }>>([]),
    [keyword, setKeyword] = useState(''),
    [userId, setUserId] = useState(''),
    [amount, setAmount] = useState(''),
    [reference, setReference] = useState(''),
    [reason, setReason] = useState('');
  const [single, setSingle] = useState(''),
    [daily, setDaily] = useState(''),
    [enabled, setEnabled] = useState(false);
  const pending = useRef<Intent | null>(null),
    sequence = useRef(0),
    writing = useRef(false);
  const admin = profile.roles.includes('SUPER_ADMIN');
  async function load(cursor?: string) {
    const n = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      const d = await staffRequest<Data>(
        '/admin/points/grants' + (cursor ? '?cursor=' + cursor : ''),
      );
      if (n === sequence.current)
        setData((old) => ({ ...d, items: cursor ? [...old.items, ...d.items] : d.items }));
    } catch (e) {
      if (n === sequence.current) setError(e instanceof Error ? e.message : '读取失败');
    } finally {
      if (n === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    return () => {
      sequence.current++;
    };
  }, []);
  async function write(action: string) {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    setError('');
    const attempt = pending.current ?? {
      path: '/admin/points/grants/' + (selected ? selected.id : 'store') + '/' + action,
      key: crypto.randomUUID(),
      body:
        action === 'create'
          ? { userId, amount, reference, reason }
          : action === 'policy'
            ? {
                version: data.policy?.version ?? 0,
                enabled,
                singleLimit: single,
                dailyLimit: daily,
                reason,
              }
            : { version: selected!.version, reason },
    };
    pending.current = attempt;
    try {
      await staffRequest(attempt.path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': profile.csrfToken,
          'Idempotency-Key': attempt.key,
        },
        body: JSON.stringify(attempt.body),
      });
      pending.current = null;
      setUnknown(false);
      setEditor(null);
      setSelected(null);
      setReason('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : '提交失败');
      if (e instanceof StaffRequestError && e.status < 500) {
        pending.current = null;
        setUnknown(false);
      } else setUnknown(true);
    } finally {
      writing.current = false;
      setBusy(false);
    }
  }
  async function search() {
    setError('');
    try {
      const r = await staffRequest<{ items: Array<{ id: string; displayName: string }> }>(
        '/admin/points/accounts?keyword=' + encodeURIComponent(keyword),
      );
      setUsers(r.items);
      setUserId('');
    } catch (e) {
      setError(e instanceof Error ? e.message : '用户查询失败');
    }
  }
  function close() {
    if (busy || unknown) return;
    setEditor(null);
    setSelected(null);
    setError('');
    setReason('');
  }
  return (
    <section className="points-workbench" aria-label="积分发放审批">
      <div className="notice">
        {data.policy?.enabled
          ? `发放已启用 · 单笔上限 ${data.policy.singleLimit} 积分 · 每日预算 ${data.policy.dailyLimit} 积分`
          : '发放暂停或尚未配置预算。可提交申请，审批入账前须配置规则。'}{' '}
        · 按北京时间核算每日预算。
      </div>
      <div className="points-toolbar">
        <button
          className="primary-button"
          onClick={() => {
            setEditor('create');
            setUsers([]);
            setUserId('');
            setAmount('');
            setReference('');
            setReason('');
          }}
        >
          申请发放积分
        </button>
        {admin && (
          <button
            className="secondary-button"
            onClick={() => {
              setEditor('policy');
              setSingle(data.policy?.singleLimit ?? '');
              setDaily(data.policy?.dailyLimit ?? '');
              setEnabled(data.policy?.enabled ?? false);
              setReason('');
            }}
          >
            配置发放预算
          </button>
        )}
        <button className="secondary-button" disabled={loading} onClick={() => void load()}>
          刷新申请
        </button>
      </div>
      {loading && <p role="status">正在读取发放申请…</p>}
      {error && !editor && !selected && (
        <div role="alert" className="notice task-error">
          {error}
          <button onClick={() => void load()}>重试读取</button>
        </div>
      )}
      {!loading && data.items.length === 0 && <div className="points-empty">暂无发放申请</div>}
      <div className="points-ledger">
        {data.items.map((g) => (
          <article className="points-entry" key={g.id}>
            <strong>
              {g.displayName} · {g.amount} 积分
            </strong>
            <p>{labels[g.status]}</p>
            <p>{g.reason}</p>
            <button
              className="secondary-button"
              onClick={() => {
                setSelected(g);
                setReason('');
                setError('');
              }}
            >
              查看申请
            </button>
          </article>
        ))}
      </div>
      {data.nextCursor && (
        <button
          className="secondary-button"
          disabled={loading}
          onClick={() => void load(data.nextCursor!)}
        >
          加载更多申请
        </button>
      )}
      {(editor || selected) && (
        <Modal
          title={
            editor === 'create'
              ? '申请发放积分'
              : editor === 'policy'
                ? '发放预算规则'
                : '积分发放申请详情'
          }
          busy={busy || unknown}
          onClose={close}
        >
          <div className="points-toolbar" style={{ display: 'grid' }}>
            {selected && (
              <>
                <strong>
                  {selected.displayName} · {selected.amount} 积分 · {labels[selected.status]}
                </strong>
                <p>申请原因：{selected.reason}</p>
                <p>业务凭据：{selected.reference}</p>
                {selected.decisionReason && <p>处理说明：{selected.decisionReason}</p>}
              </>
            )}
            {editor === 'create' && (
              <>
                <label>
                  搜索用户
                  <input
                    value={keyword}
                    onChange={(e) => setKeyword(e.target.value)}
                    disabled={busy || unknown}
                  />
                </label>
                <button
                  className="secondary-button"
                  disabled={busy || unknown || !keyword.trim()}
                  onClick={() => void search()}
                >
                  查询用户
                </button>
                <label>
                  发放对象
                  <select
                    value={userId}
                    disabled={busy || unknown}
                    onChange={(e) => setUserId(e.target.value)}
                  >
                    <option value="">请选择用户</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  发放积分
                  <input
                    inputMode="numeric"
                    value={amount}
                    disabled={busy || unknown}
                    onChange={(e) => setAmount(e.target.value)}
                  />
                </label>
                <label>
                  业务凭据编号
                  <input
                    maxLength={120}
                    value={reference}
                    disabled={busy || unknown}
                    onChange={(e) => setReference(e.target.value)}
                  />
                </label>
              </>
            )}
            {editor === 'policy' && (
              <>
                <label>
                  单笔积分上限
                  <input
                    value={single}
                    disabled={busy || unknown}
                    onChange={(e) => setSingle(e.target.value)}
                  />
                </label>
                <label>
                  每日发放预算
                  <input
                    value={daily}
                    disabled={busy || unknown}
                    onChange={(e) => setDaily(e.target.value)}
                  />
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={enabled}
                    disabled={busy || unknown}
                    onChange={(e) => setEnabled(e.target.checked)}
                  />
                  启用积分发放
                </label>
              </>
            )}
            {(editor || selected?.status === 'SUBMITTED') && (
              <label>
                {editor === 'create' ? '发放原因' : '处理说明'}
                <textarea
                  maxLength={300}
                  value={reason}
                  disabled={busy || unknown}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
            )}
            {error && (
              <div role="alert" className="notice task-error">
                {error}
              </div>
            )}
            {unknown ? (
              <>
                <p>提交结果待确认，请保留当前申请并使用原操作重试。</p>
                <button
                  className="primary-button"
                  disabled={busy}
                  onClick={() => void write('retry')}
                >
                  使用原操作重试
                </button>
              </>
            ) : (
              <>
                {editor && (
                  <button
                    className="primary-button"
                    disabled={busy || !reason.trim() || (editor === 'create' && !userId)}
                    onClick={() => void write(editor!)}
                  >
                    {editor === 'create' ? '提交发放申请' : '保存预算规则'}
                  </button>
                )}
                {selected?.status === 'SUBMITTED' &&
                  (selected.creatorId === profile.id ? (
                    <button
                      className="secondary-button"
                      disabled={busy || !reason.trim()}
                      onClick={() => void write('cancel')}
                    >
                      撤销本人申请
                    </button>
                  ) : (
                    admin && (
                      <>
                        <button
                          className="primary-button"
                          disabled={busy || !reason.trim()}
                          onClick={() => void write('approve')}
                        >
                          批准并入账
                        </button>
                        <button
                          className="secondary-button"
                          disabled={busy || !reason.trim()}
                          onClick={() => void write('reject')}
                        >
                          驳回申请
                        </button>
                      </>
                    )
                  ))}
              </>
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}
