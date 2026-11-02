import { useEffect, useRef, useState } from 'react';
import type { StaffProfile } from '@yumi/contracts';
import { staffRequest, StaffRequestError } from './index.js';
import { Modal } from './modal.js';
type Reward = {
  id: string;
  skuId: string;
  title: string;
  name: string;
  spec: string;
  unit: string;
  pointsPrice: string;
  status: string;
  version: number;
  sortOrder: number;
  perUserLimit: number;
  totalQuota: number;
  available: number;
  startsAt: string | null;
  endsAt: string | null;
};
type Sku = { id: string; name: string; spec: string; unit: string; enabled: boolean };
type Page<T> = { items: T[]; nextCursor: string | null };
const statuses: Record<string, string> = {
  DRAFT: '草稿',
  PUBLISHED: '已上架',
  UNPUBLISHED: '已下架',
};
const beijing = (s: string | null) =>
  s ? new Date(Date.parse(s) + 8 * 3600000).toISOString().slice(0, 16) : '';
export function RewardsWorkbench({ profile }: { profile: StaffProfile }) {
  const [items, setItems] = useState<Reward[]>([]),
    [selected, setSelected] = useState<Reward | null>(null),
    [editing, setEditing] = useState<Reward | null | undefined>(undefined);
  const [keyword, setKeyword] = useState(''),
    [status, setStatus] = useState(''),
    [cursor, setCursor] = useState<string | null>(null),
    [loading, setLoading] = useState(true),
    [error, setError] = useState('');
  const seq = useRef(0),
    applied = useRef({ keyword: '', status: '' }),
    pending = useRef<string | undefined>(undefined);
  async function load(next?: string) {
    const n = ++seq.current;
    pending.current = next;
    setLoading(true);
    setError('');
    const q = new URLSearchParams();
    if (applied.current.keyword) q.set('keyword', applied.current.keyword);
    if (applied.current.status) q.set('status', applied.current.status);
    if (next) q.set('cursor', next);
    try {
      const p = await staffRequest<Page<Reward>>('/admin/rewards?' + q);
      if (n !== seq.current) return;
      setItems((old) => (next ? [...old, ...p.items] : p.items));
      setCursor(p.nextCursor);
    } catch (e) {
      if (n === seq.current) {
        setError(e instanceof Error ? e.message : '读取失败');
        if (e instanceof StaffRequestError && [401, 403].includes(e.status)) {
          setItems([]);
          setSelected(null);
          setEditing(undefined);
          setCursor(null);
        }
      }
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
    <section aria-label="兑换商品管理" className="rewards-workbench">
      <div className="notice">
        维护兑换商品和展示规则。商城目前仅供浏览，兑换下单尚未开放；配额不代表实物库存。
      </div>
      {selected ? (
        <div className="account-card reward-detail">
          <button className="secondary-button" onClick={() => setSelected(null)}>
            返回兑换商品列表
          </button>
          <h2>{selected.title}</h2>
          <p>
            {selected.name} · {selected.spec} / {selected.unit}
          </p>
          <p className="reward-price">{selected.pointsPrice} 积分 / 件</p>
          <p>
            {statuses[selected.status]} · 当前最多可选 {selected.available} 件
          </p>
          <p>
            每人累计限兑 {selected.perUserLimit} 件 · 总配额 {selected.totalQuota} 件
          </p>
          <p>
            开放时间（北京时间）：{beijing(selected.startsAt).replace('T', ' ') || '不限开始'} 至{' '}
            {beijing(selected.endsAt).replace('T', ' ') || '不限结束'}
          </p>
          <button className="primary-button" onClick={() => setEditing(selected)}>
            编辑与上下架
          </button>
        </div>
      ) : (
        <>
          <form
            className="points-toolbar"
            onSubmit={(e) => {
              e.preventDefault();
              applied.current = { keyword: keyword.trim(), status };
              void load();
            }}
          >
            <label>
              兑换商品名称
              <input value={keyword} maxLength={80} onChange={(e) => setKeyword(e.target.value)} />
            </label>
            <label>
              上架状态
              <select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">全部状态</option>
                {Object.entries(statuses).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <button className="secondary-button" disabled={loading}>
              查询商品
            </button>
            <button type="button" className="primary-button" onClick={() => setEditing(null)}>
              新增兑换商品
            </button>
          </form>
          {items.length > 0 && (
            <div className="points-table-wrap">
              <table className="points-table">
                <thead>
                  <tr>
                    <th>商品 / 规格</th>
                    <th>所需积分</th>
                    <th>状态 / 可选数量</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <strong>{r.title}</strong>
                        <p>
                          {r.name} · {r.spec}
                        </p>
                      </td>
                      <td>{r.pointsPrice}</td>
                      <td>
                        {statuses[r.status]}
                        <p>最多 {r.available} 件</p>
                      </td>
                      <td>
                        <button className="secondary-button" onClick={() => setSelected(r)}>
                          查看商品
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {!loading && !error && !items.length && (
            <div className="points-empty">暂无匹配兑换商品</div>
          )}
        </>
      )}
      {loading && <p role="status">正在读取兑换商品…</p>}
      {error && (
        <div className="notice task-error" role="alert">
          {error}
          <button
            className="secondary-button"
            disabled={loading}
            onClick={() => void load(pending.current)}
          >
            重试读取
          </button>
          <button className="secondary-button" disabled={loading} onClick={() => void load()}>
            重新查询
          </button>
        </div>
      )}
      {!selected && cursor && !error && (
        <button className="secondary-button" disabled={loading} onClick={() => void load(cursor)}>
          加载更多
        </button>
      )}
      {editing !== undefined && (
        <RewardEditor
          key={editing?.id ?? 'new'}
          reward={editing}
          profile={profile}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            setSelected(null);
            void load();
          }}
        />
      )}
    </section>
  );
}
function RewardEditor({
  reward,
  profile,
  onClose,
  onSaved,
}: {
  reward: Reward | null;
  profile: StaffProfile;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState(reward?.title ?? ''),
    [price, setPrice] = useState(reward?.pointsPrice ?? ''),
    [sort, setSort] = useState(String(reward?.sortOrder ?? 0)),
    [limit, setLimit] = useState(String(reward?.perUserLimit ?? '')),
    [quota, setQuota] = useState(String(reward?.totalQuota ?? '')),
    [start, setStart] = useState(beijing(reward?.startsAt ?? null)),
    [end, setEnd] = useState(beijing(reward?.endsAt ?? null)),
    [reason, setReason] = useState('');
  const [keyword, setKeyword] = useState(''),
    [skus, setSkus] = useState<Sku[]>([]),
    [sku, setSku] = useState<Sku | null>(null),
    [cursor, setCursor] = useState<string | null>(null),
    [searched, setSearched] = useState(false),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [unknown, setUnknown] = useState(false),
    [conflict, setConflict] = useState(false);
  const applied = useRef(''),
    seq = useRef(0),
    intent = useRef<{ path: string; body: unknown; key: string } | null>(null);
  useEffect(
    () => () => {
      seq.current++;
    },
    [],
  );
  async function search(next?: string) {
    const n = ++seq.current;
    setSearched(true);
    setLoading(true);
    setError('');
    try {
      const q = new URLSearchParams();
      if (applied.current) q.set('keyword', applied.current);
      if (next) q.set('cursor', next);
      const p = await staffRequest<Page<Sku>>('/admin/rewards/skus?' + q);
      if (n !== seq.current) return;
      setSkus((old) => (next ? [...old, ...p.items] : p.items));
      setCursor(p.nextCursor);
    } catch (e) {
      if (n === seq.current) setError(e instanceof Error ? e.message : '规格读取失败');
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }
  async function save(action: string) {
    if (busy || loading || conflict) return;
    if (!intent.current) {
      if (!reason.trim()) {
        setError('请填写操作原因');
        return;
      }
      const details = action === 'create' || action === 'update';
      if (
        details &&
        (!title.trim() ||
          !/^\d{1,10}$/.test(price) ||
          Number(price) < 1 ||
          Number(price) > 1000000000 ||
          ![sort, limit, quota].every((v) => /^\d+$/.test(v)) ||
          Number(limit) < 1 ||
          Number(limit) > 100000 ||
          Number(quota) < Number(limit) ||
          Number(quota) > 100000000 ||
          Number(sort) > 1000000 ||
          (!reward && !sku))
      ) {
        setError('请选择规格并填写有效积分价、排序和限兑数量');
        return;
      }
      const dates = {
        startsAt: start ? new Date(start + ':00+08:00').toISOString() : null,
        endsAt: end ? new Date(end + ':00+08:00').toISOString() : null,
      };
      const body = {
        reason: reason.trim(),
        ...(reward ? { version: reward.version } : {}),
        ...(details
          ? {
              ...(!reward ? { skuId: sku!.id } : {}),
              title: title.trim(),
              pointsPrice: price,
              sortOrder: Number(sort),
              perUserLimit: Number(limit),
              totalQuota: Number(quota),
              ...dates,
            }
          : {}),
      };
      intent.current = {
        path: '/admin/rewards/' + (reward?.id ?? 'store') + '/' + action,
        body,
        key: crypto.randomUUID(),
      };
    }
    setBusy(true);
    setError('');
    const attempt = intent.current;
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
      onSaved();
    } catch (e) {
      const uncertain = !(e instanceof StaffRequestError) || e.status >= 500;
      setUnknown(uncertain);
      if (!uncertain) intent.current = null;
      if (e instanceof StaffRequestError && e.code === 'VERSION_CONFLICT') setConflict(true);
      setError(
        uncertain
          ? '操作结果尚未确认，请保留当前页面并使用原请求重试。'
          : e instanceof Error
            ? e.message
            : '保存失败',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={reward ? '编辑兑换商品' : '新增兑换商品'}
      busy={busy || unknown}
      onClose={onClose}
    >
      <form
        className="reward-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save(reward ? 'update' : 'create');
        }}
      >
        <fieldset disabled={busy || unknown || conflict}>
          {!reward && (
            <div className="reward-picker">
              <label>
                搜索商品规格
                <input
                  value={keyword}
                  onChange={(e) => setKeyword(e.target.value)}
                  maxLength={80}
                />
              </label>
              <button
                type="button"
                className="secondary-button"
                disabled={loading}
                onClick={() => {
                  applied.current = keyword.trim();
                  void search();
                }}
              >
                查找规格
              </button>
              {loading && <p>正在查询规格…</p>}
              {searched && !loading && !skus.length && <p>暂无匹配商品规格</p>}
              {skus.map((s) => (
                <button
                  type="button"
                  className="reward-sku"
                  aria-pressed={sku?.id === s.id}
                  key={s.id}
                  disabled={loading}
                  onClick={() => {
                    setSku(s);
                    if (!title) setTitle(s.name);
                  }}
                >
                  {s.name} · {s.spec} / {s.unit}
                  {!s.enabled ? '（已停用）' : ''}
                </button>
              ))}
              {cursor && (
                <button type="button" disabled={loading} onClick={() => void search(cursor)}>
                  更多规格
                </button>
              )}
              {sku && (
                <p>
                  已选：{sku.name} · {sku.spec}
                </p>
              )}
            </div>
          )}
          {reward && (
            <p>
              固定规格：{reward.name} · {reward.spec}（保存不更换SKU）
            </p>
          )}
          <label>
            兑换标题
            <input
              value={title}
              maxLength={120}
              onChange={(e) => setTitle(e.target.value)}
              required
            />
          </label>
          <div className="reward-form-grid">
            <label>
              积分单价
              <input
                inputMode="numeric"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                required
              />
            </label>
            <label>
              展示排序
              <input
                inputMode="numeric"
                value={sort}
                onChange={(e) => setSort(e.target.value)}
                required
              />
            </label>
            <label>
              每人累计限兑件数
              <input
                inputMode="numeric"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
                required
              />
            </label>
            <label>
              总兑换配额
              <input
                inputMode="numeric"
                value={quota}
                onChange={(e) => setQuota(e.target.value)}
                required
              />
            </label>
            <label>
              开始时间（北京时间）
              <input
                type="datetime-local"
                value={start}
                onChange={(e) => setStart(e.target.value)}
              />
            </label>
            <label>
              结束时间（北京时间）
              <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} />
            </label>
          </div>
          <label>
            操作原因
            <textarea
              value={reason}
              maxLength={300}
              onChange={(e) => setReason(e.target.value)}
              required
            />
          </label>
        </fieldset>
        {error && (
          <div role="alert" className="notice task-error">
            {error}
          </div>
        )}
        {unknown ? (
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => void save('retry')}
          >
            使用原请求重试
          </button>
        ) : (
          <div className="points-toolbar">
            <button className="primary-button" disabled={busy || loading || conflict}>
              {reward ? '保存商品规则' : '保存为草稿'}
            </button>
            {reward && (
              <button
                type="button"
                className="secondary-button"
                disabled={busy || conflict}
                onClick={() => void save(reward.status === 'PUBLISHED' ? 'unpublish' : 'publish')}
              >
                {reward.status === 'PUBLISHED' ? '下架商品' : '上架商品'}
              </button>
            )}
            <button type="button" className="secondary-button" disabled={busy} onClick={onClose}>
              关闭
            </button>
          </div>
        )}
        <p className="muted">
          上架或下架使用当前已保存规则；修改后请先保存。当前仅展示，兑换下单待开放。
        </p>
      </form>
    </Modal>
  );
}
