import { useEffect, useRef, useState } from 'react';
import type { StaffProfile } from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
import { Modal } from './modal.js';
type Grant = {
  id: string;
  userId: string;
  grantId?: string;
  sourceAmount?: string;
  sourceReference?: string;
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
export function PointsGrants({
  profile,
  correction = false,
  targetCustomer,
  onPendingChange,
}: {
  profile: StaffProfile;
  correction?: boolean;
  targetCustomer?: { id: string; displayName: string };
  onPendingChange?: (pending: boolean) => void;
}) {
  const base = correction ? '/admin/points/corrections' : '/admin/points/grants';
  const statusLabel = (status: string) =>
    correction && status === 'APPROVED' ? '已扣减' : labels[status];
  const [data, setData] = useState<Data>({ policy: null, items: [], nextCursor: null }),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<'create' | 'policy' | null>(null),
    [selected, setSelected] = useState<Grant | null>(null),
    [busy, setBusy] = useState(false),
    [unknown, setUnknown] = useState(false);
  const [users, setUsers] = useState<
      Array<{
        id: string;
        displayName: string;
        amount?: string;
        remainingAmount?: string;
        reference?: string;
      }>
    >([]),
    [keyword, setKeyword] = useState(''),
    [userId, setUserId] = useState(''),
    [amount, setAmount] = useState(''),
    [reference, setReference] = useState(''),
    [reason, setReason] = useState('');
  const [single, setSingle] = useState(''),
    [daily, setDaily] = useState(''),
    [enabled, setEnabled] = useState(false);
  const [sourceCursor, setSourceCursor] = useState<string | null>(null),
    [searching, setSearching] = useState(false);
  const searchSequence = useRef(0),
    appliedSearch = useRef('');
  const pending = useRef<Intent | null>(null),
    sequence = useRef(0),
    writing = useRef(false);
  const admin = profile.roles.includes('SUPER_ADMIN');
  useEffect(() => {
    onPendingChange?.(busy || unknown);
    return () => onPendingChange?.(false);
  }, [busy, unknown, onPendingChange]);
  async function load(cursor?: string) {
    const n = ++sequence.current;
    setLoading(true);
    setError('');
    try {
      const q = new URLSearchParams();
      if (cursor) q.set('cursor', cursor);
      if (targetCustomer) q.set('userId', targetCustomer.id);
      const d = await staffRequest<Data>(base + '?' + q);
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
      searchSequence.current++;
    };
  }, []);
  async function write(action: string) {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    setError('');
    const attempt = pending.current ?? {
      path: base + '/' + (selected ? selected.id : 'store') + '/' + action,
      key: crypto.randomUUID(),
      body:
        action === 'create'
          ? correction
            ? { grantId: userId, amount, reference, reason }
            : { userId, amount, reference, reason }
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
  async function search(cursor?: string) {
    const n = ++searchSequence.current;
    setSearching(true);
    if (!cursor) appliedSearch.current = keyword.trim();
    setError('');
    try {
      const r = await staffRequest<{
        items: Array<{ id: string; displayName: string }>;
        nextCursor: string | null;
      }>(
        (correction
          ? '/admin/points/corrections/sources?keyword='
          : '/admin/points/accounts?keyword=') +
          encodeURIComponent(appliedSearch.current) +
          (cursor ? '&cursor=' + cursor : '') +
          (targetCustomer && correction ? '&userId=' + targetCustomer.id : ''),
      );
      if (n !== searchSequence.current) return;
      setUsers((old) => (cursor ? [...old, ...r.items] : r.items));
      setSourceCursor(r.nextCursor);
      if (!cursor) setUserId('');
    } catch (e) {
      if (n === searchSequence.current) setError(e instanceof Error ? e.message : '用户查询失败');
    } finally {
      if (n === searchSequence.current) setSearching(false);
    }
  }
  function close() {
    if (busy || unknown) return;
    searchSequence.current++;
    setSearching(false);
    setEditor(null);
    setSelected(null);
    setError('');
    setReason('');
  }
  return (
    <section className="points-workbench" aria-label="积分发放审批">
      <div className="notice">
        {correction
          ? '误发冲正仅关联已入账发放；待审批占用来源额度，余额不足不扣成负数。'
          : data.policy?.enabled
            ? `发放已启用 · 单笔上限 ${data.policy.singleLimit} 积分 · 每日预算 ${data.policy.dailyLimit} 积分`
            : '发放暂停或尚未配置预算。可提交申请，审批入账前须配置规则。'}{' '}
        {!correction && '· 按北京时间核算每日预算。'}
      </div>
      <div className="points-toolbar">
        <h2 className="points-queue-heading">{correction ? '冲正申请队列' : '积分审批队列'}</h2>
        <button
          className="primary-button"
          onClick={() => {
            setEditor('create');
            setUsers(targetCustomer && !correction ? [targetCustomer] : []);
            setSourceCursor(null);
            setUserId(targetCustomer && !correction ? targetCustomer.id : '');
            setAmount('');
            setReference('');
            setReason('');
          }}
        >
          {correction ? '申请误发冲正' : '申请发放积分'}
        </button>
        {admin && !correction && (
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
      {loading && <p role="status">{correction ? '正在读取冲正申请…' : '正在读取发放申请…'}</p>}
      {error && !editor && !selected && (
        <div role="alert" className="notice task-error">
          {error}
          <button onClick={() => void load()}>重试读取</button>
        </div>
      )}
      {!loading && data.items.length === 0 && (
        <div className="points-empty">{correction ? '暂无冲正申请' : '暂无发放申请'}</div>
      )}
      {data.items.length > 0 && (
        <div className="points-table-wrap">
          <table className="points-table">
            <thead>
              <tr>
                <th>用户</th>
                <th>积分</th>
                <th>申请原因</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((g) => (
                <tr key={g.id}>
                  <td>
                    <strong>{g.displayName}</strong>
                  </td>
                  <td>
                    {correction ? '−' : '+'}
                    {g.amount} 积分
                  </td>
                  <td>{g.reason}</td>
                  <td>
                    <span className="badge">{statusLabel(g.status)}</span>
                  </td>
                  <td>
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
              ? correction
                ? '申请误发冲正'
                : '申请发放积分'
              : editor === 'policy'
                ? '发放预算规则'
                : correction
                  ? '积分冲正申请详情'
                  : '积分发放申请详情'
          }
          busy={busy || unknown}
          onClose={close}
        >
          <div className="points-toolbar" style={{ display: 'grid' }}>
            {selected && (
              <>
                <strong>
                  {selected.displayName} · {selected.amount} 积分 · {statusLabel(selected.status)}
                </strong>
                <p>申请原因：{selected.reason}</p>
                <p>业务凭据：{selected.reference}</p>
                {correction && (
                  <p>
                    原发放 {selected.sourceAmount} 积分 · 原发放凭据：{selected.sourceReference}
                  </p>
                )}
                {selected.decisionReason && <p>处理说明：{selected.decisionReason}</p>}
              </>
            )}
            {editor === 'create' && (
              <>
                {targetCustomer && <strong>当前顾客：{targetCustomer.displayName}</strong>}
                {(!targetCustomer || correction) && (
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
                      disabled={
                        busy || unknown || searching || (!keyword.trim() && !targetCustomer)
                      }
                      onClick={() => void search()}
                    >
                      {searching ? '正在查询…' : '查询用户'}
                    </button>
                    {sourceCursor && (
                      <button
                        className="secondary-button"
                        disabled={busy || unknown || searching}
                        onClick={() => void search(sourceCursor)}
                      >
                        {correction ? '更多原发放记录' : '更多用户'}
                      </button>
                    )}
                  </>
                )}
                <label>
                  {correction ? '原发放记录' : '发放对象'}
                  <select
                    aria-label={correction ? '原发放记录' : '发放对象'}
                    value={userId}
                    disabled={busy || unknown || (!!targetCustomer && !correction)}
                    onChange={(e) => setUserId(e.target.value)}
                  >
                    <option value="">{correction ? '请选择原发放记录' : '请选择用户'}</option>
                    {users.map((u) => (
                      <option
                        key={u.id}
                        value={u.id}
                        disabled={correction && u.remainingAmount === '0'}
                      >
                        {u.displayName}
                        {correction
                          ? ' · 原发放 ' +
                            u.amount +
                            ' 积分 · 可冲正 ' +
                            u.remainingAmount +
                            ' · ' +
                            u.reference
                          : ''}
                      </option>
                    ))}
                  </select>
                </label>
                {correction && users.find((u) => u.id === userId) && (
                  <p className="notice">
                    已选原发放：{users.find((u) => u.id === userId)?.amount} 积分 · 剩余可冲正{' '}
                    {users.find((u) => u.id === userId)?.remainingAmount} 积分 · 凭据{' '}
                    {users.find((u) => u.id === userId)?.reference}
                  </p>
                )}
                <label>
                  {correction ? '冲正积分' : '发放积分'}
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
                {editor === 'create' ? (correction ? '冲正原因' : '发放原因') : '处理说明'}
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
                    disabled={
                      busy || searching || !reason.trim() || (editor === 'create' && !userId)
                    }
                    onClick={() => void write(editor!)}
                  >
                    {editor === 'create'
                      ? correction
                        ? '提交冲正申请'
                        : '提交发放申请'
                      : '保存预算规则'}
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
                          {correction ? '批准并扣减' : '批准并入账'}
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
