import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import type {
  InventoryCheck,
  Page,
  PositionLedgerEntry,
  StaffProfile,
  StockPosition,
  WarehouseLocation,
} from '@yumi/contracts';
import { staffRequest } from './index.js';
import { TaskDialog } from './task-dialog.js';
import { usePage } from './use-page.js';

type Pane = 'positions' | 'locations' | 'transfers' | 'checks';
interface Transfer {
  id: string;
  sourcePositionId: string;
  targetPositionId: string;
  quantity: number;
  reason: string;
  createdAt: string;
}
interface Balance {
  version: number;
  onHand: number;
  inventoryHold: boolean;
}
const kinds: Record<string, string> = {
  BALANCE_LOTS: '汇总与批次',
  BALANCE_LEDGER: '汇总与库存流水',
  LOT_POSITIONS: '批次与库位',
  LOT_LEDGER: '批次与库存流水',
  POSITION_LEDGER: '位置与位置流水',
  EVENT_POSITIONS: '主流水与成对位置流水',
};
const date = (v: string) => new Date(v).toLocaleString('zh-CN');
const positionName = (p?: StockPosition) =>
  p ? `${p.name} · ${p.spec} · ${p.batchNo} · ${p.locationCode}` : '位置资料未载入';
function form(e: FormEvent<HTMLFormElement>) {
  e.preventDefault();
  return new FormData(e.currentTarget);
}
function PageState({
  page,
  empty,
  children,
}: {
  page: { loading: boolean; error: string; items: unknown[]; reload: () => Promise<void> };
  empty: string;
  children: ReactNode;
}) {
  if (page.loading)
    return (
      <div className="empty-state" role="status">
        正在加载资料…
      </div>
    );
  if (page.error)
    return (
      <div className="empty-state" role="alert">
        <p>{page.error}</p>
        <button className="secondary-button" onClick={() => void page.reload().catch(() => {})}>
          重新加载资料
        </button>
      </div>
    );
  if (!page.items.length) return <div className="empty-state">{empty}</div>;
  return <>{children}</>;
}
export function LocationWorkbench({
  profile,
  warehouseId,
  onStockChanged,
}: {
  profile: StaffProfile;
  warehouseId: string;
  onStockChanged: () => Promise<void>;
}) {
  const root = `/warehouse/warehouses/${warehouseId}`;
  const can = (p: string) => profile.permissions.includes(p);
  const [pane, setPane] = useState<Pane>('positions');
  const [filter, setFilter] = useState('');
  const [skuOptions, setSkuOptions] = useState<StockPosition[]>([]);
  const positionFilter = pane === 'positions' || pane === 'checks' ? filter : '';
  const positions = usePage<StockPosition>(
    `${root}/positions?limit=50${positionFilter ? `&skuId=${encodeURIComponent(positionFilter)}` : ''}`,
  );
  const locations = usePage<WarehouseLocation>(`${root}/locations?limit=50`);
  const transfers = usePage<Transfer>(
    pane === 'transfers' ? `${root}/stock-transfers?limit=20` : null,
  );
  const checks = usePage<InventoryCheck>(
    pane === 'checks'
      ? `${root}/inventory-checks?limit=20${filter ? `&skuId=${encodeURIComponent(filter)}` : ''}`
      : null,
  );
  const [dialog, setDialog] = useState<'location' | 'transfer' | 'check' | null>(null);
  const [location, setLocation] = useState<WarehouseLocation | null>(null);
  const [position, setPosition] = useState<StockPosition | null>(null);
  const [transfer, setTransfer] = useState<Transfer | null>(null);
  const [report, setReport] = useState<InventoryCheck | null>(null);
  const [sourceId, setSourceId] = useState('');
  const [checkSku, setCheckSku] = useState('');
  const [balance, setBalance] = useState<Balance | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [balanceError, setBalanceError] = useState('');
  const [balanceRetry, setBalanceRetry] = useState(0);
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState(''),
    [failed, setFailed] = useState(false);
  const intentions = useRef(new Map<string, string>());
  useEffect(() => {
    setSkuOptions((old) => [
      ...new Map([...old, ...positions.items].map((p) => [p.skuId, p])).values(),
    ]);
  }, [positions.items]);
  useEffect(() => {
    let active = true;
    setBalance(null);
    setBalanceError('');
    setBalanceLoading(!!checkSku);
    if (checkSku)
      void staffRequest<Page<Balance>>(
        `${root}/stock?limit=1&skuId=${encodeURIComponent(checkSku)}`,
      )
        .then((p) => {
          if (active) setBalance(p.items[0] ?? null);
        })
        .catch((e) => {
          if (active) setBalanceError(e instanceof Error ? e.message : '账面加载失败');
        })
        .finally(() => {
          if (active) setBalanceLoading(false);
        });
    return () => {
      active = false;
    };
  }, [root, checkSku, balanceRetry]);
  const source = positions.items.find((p) => p.id === sourceId);
  const current = { positions, locations, transfers, checks }[pane];
  function clear() {
    setMessage('');
    setFailed(false);
  }
  async function action<T>(suffix: string, body: unknown): Promise<T> {
    const signature = suffix + JSON.stringify(body);
    const key = intentions.current.get(signature) ?? crypto.randomUUID();
    intentions.current.set(signature, key);
    const result = await staffRequest<T>(`${root}/${suffix}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': profile.csrfToken,
        'Idempotency-Key': key,
      },
      body: JSON.stringify(body),
    });
    intentions.current.delete(signature);
    return result;
  }
  async function work(run: () => Promise<void>) {
    setBusy(true);
    clear();
    try {
      await run();
      setMessage('操作完成，数据已刷新');
    } catch (e) {
      setFailed(true);
      setMessage(e instanceof Error ? e.message : '操作未完成，请重试');
    } finally {
      setBusy(false);
    }
  }
  async function refreshSaved() {
    try {
      await Promise.all([
        positions.reload(),
        locations.reload(),
        transfers.reload(),
        checks.reload(),
        onStockChanged(),
      ]);
    } catch {
      throw new Error('操作已保存，但资料刷新失败。请刷新列表核对结果，请勿重复新建。');
    }
  }
  function startTransfer(id = '') {
    clear();
    setPosition(null);
    setSourceId(id);
    setDialog('transfer');
  }
  return (
    <section className="task-workbench location-workbench">
      <div className="surface-head">
        <div>
          <h3>库位与库存核对</h3>
          <p>
            {can('stock.transfer')
              ? '按批次找到货品，按记录核对每一笔变化。'
              : '只读查看库位、批次、移位与核对记录。'}
          </p>
        </div>
        <div className="surface-head-actions">
          {pane === 'locations' && can('location.write') && (
            <button
              className="primary-button"
              onClick={() => {
                clear();
                setDialog('location');
              }}
            >
              ＋ 新增库位
            </button>
          )}
          {pane === 'transfers' && can('stock.transfer') && (
            <button className="primary-button" onClick={() => startTransfer()}>
              ＋ 新建移位
            </button>
          )}
          {pane === 'checks' && can('stock.check') && (
            <button
              className="primary-button"
              onClick={() => {
                clear();
                setCheckSku(filter);
                setBalance(null);
                setBalanceRetry((v) => v + 1);
                setDialog('check');
              }}
            >
              执行库存核对
            </button>
          )}
        </div>
      </div>
      <div className="subnav" role="group" aria-label="库位任务导航">
        {(
          [
            { id: 'positions', name: '批次位置' },
            { id: 'locations', name: '存储库位' },
            { id: 'transfers', name: '移位记录' },
            { id: 'checks', name: '核对报告' },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            aria-pressed={pane === t.id}
            className={pane === t.id ? 'active' : ''}
            onClick={() => {
              setPane(t.id);
              clear();
            }}
          >
            {t.name}
          </button>
        ))}
      </div>
      {message && (
        <p role={failed ? 'alert' : 'status'} className={failed ? 'task-error' : 'notice'}>
          {message}
        </p>
      )}
      <fieldset disabled={busy} className="task-detail">
        <div className="toolbar">
          {(pane === 'positions' || pane === 'checks') && (
            <label>
              商品规格{' '}
              <select
                aria-label="筛选商品规格"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="">全部商品规格</option>
                {skuOptions.map((p) => (
                  <option key={p.skuId} value={p.skuId}>
                    {p.name} · {p.spec} · {p.skuCode}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            className="secondary-button"
            disabled={current.loading}
            onClick={() => void current.reload().catch(() => {})}
          >
            刷新当前列表
          </button>
          <span>已载入 {current.items.length} 条记录</span>
        </div>
        {pane === 'checks' && (
          <p>账本核对不修改数量。发现差异会暂停销售；复核一致后仍需明确解除暂停。</p>
        )}
        <PageState
          page={current}
          empty={
            {
              positions: '暂无符合条件的批次位置，请调整筛选或先收货入库。',
              locations: '暂无存储库位。',
              transfers: '尚无移位记录。',
              checks: '尚无符合条件的核对报告。',
            }[pane]
          }
        >
          {pane === 'positions' &&
            positions.items.map((p) => (
              <article className="task-card" key={p.id}>
                <strong>
                  {p.name} · {p.spec}
                </strong>
                <p>
                  {p.locationCode} · 批次 {p.batchNo}
                </p>
                <p>
                  实物 {p.onHand} / 预占 {p.reserved} / 不可售 {p.blocked} ·{' '}
                  {p.expired ? '已过期，不可售' : p.locationEnabled ? '库位启用' : '库位停用'}
                </p>
                <div className="location-row-actions">
                  <button
                    className="secondary-button"
                    onClick={() => {
                      clear();
                      setPosition(p);
                    }}
                  >
                    查看位置与流水
                  </button>
                  {can('stock.transfer') && (
                    <button
                      className="secondary-button"
                      disabled={p.reserved > 0 || p.onHand <= p.blocked}
                      onClick={() => startTransfer(p.id)}
                    >
                      移位
                    </button>
                  )}
                </div>
              </article>
            ))}
          {pane === 'locations' &&
            locations.items.map((l) => (
              <article className="task-card" key={l.id}>
                <strong>
                  {l.code} · {l.name}
                </strong>
                <p>
                  {l.enabled ? '启用' : '停用'}
                  {l.code === 'DEFAULT' ? ' · 默认收货位' : ''}
                </p>
                <button
                  className="secondary-button"
                  onClick={() => {
                    clear();
                    setLocation(l);
                  }}
                >
                  查看库位详情
                </button>
              </article>
            ))}
          {pane === 'transfers' &&
            transfers.items.map((t) => (
              <article className="task-card" key={t.id}>
                <strong>已移位 {t.quantity} 件</strong>
                <p>{positionName(positions.items.find((p) => p.id === t.sourcePositionId))}</p>
                <p>
                  {date(t.createdAt)} · {t.reason}
                </p>
                <button
                  className="secondary-button"
                  onClick={() => {
                    clear();
                    setTransfer(t);
                  }}
                >
                  查看移位详情
                </button>
              </article>
            ))}
          {pane === 'checks' &&
            checks.items.map((r) => (
              <article className="task-card" key={r.id}>
                <strong>
                  <span
                    className={`count-state ${r.status === 'CONSISTENT' ? 'count-state-POSTED' : ''}`}
                  >
                    {r.status === 'CONSISTENT' ? '账本一致' : '发现差异'}
                  </span>
                </strong>
                <p>
                  {skuOptions.find((p) => p.skuId === r.skuId)?.name ?? '商品资料未载入'} ·{' '}
                  {r.issueCount} 项差异
                </p>
                <p>{date(r.createdAt)}</p>
                <button
                  className="secondary-button"
                  onClick={() => {
                    clear();
                    setReport(r);
                  }}
                >
                  查看核对报告
                </button>
              </article>
            ))}
        </PageState>
        {current.cursor && (
          <button
            className="secondary-button"
            disabled={current.loading}
            onClick={() => void current.next().catch(() => {})}
          >
            加载更多当前记录
          </button>
        )}
      </fieldset>
      {dialog === 'location' && (
        <TaskDialog
          title="新增存储库位"
          busy={busy}
          message={message}
          error={failed}
          onClose={() => setDialog(null)}
        >
          <form
            onSubmit={(e) => {
              const d = form(e);
              void work(async () => {
                await action('locations', { code: d.get('code'), name: d.get('name') });
                setDialog(null);
                await refreshSaved();
              });
            }}
          >
            <label>
              库位编码
              <input
                name="code"
                required
                maxLength={32}
                pattern="[A-Za-z0-9][A-Za-z0-9_-]*"
                placeholder="例如 A-01"
              />
            </label>
            <label>
              库位名称
              <input name="name" required maxLength={80} />
            </label>
            <p>DEFAULT是保留的默认收货位。新建普通库位不会改变库存数量。</p>
            <button className="primary-button">保存库位</button>
          </form>
        </TaskDialog>
      )}
      {location && (
        <TaskDialog
          title={`库位详情 · ${location.code}`}
          busy={busy}
          message={message}
          error={failed}
          onClose={() => setLocation(null)}
        >
          <h3>{location.name}</h3>
          <p>
            {location.enabled ? '当前启用' : '当前停用'} · {location.code}
          </p>
          <p>有实物、预占或不可售数量时不能停用。DEFAULT默认收货位不能停用。</p>
          {can('location.write') && location.code !== 'DEFAULT' && (
            <button
              className="primary-button"
              onClick={() =>
                void work(async () => {
                  const latest = await action<WarehouseLocation>(
                    `locations/${location.id}/${location.enabled ? 'disable' : 'enable'}`,
                    { version: location.version },
                  );
                  setLocation(latest);
                  await refreshSaved();
                })
              }
            >
              {location.enabled ? '确认停用此库位' : '启用此库位'}
            </button>
          )}
        </TaskDialog>
      )}
      {dialog === 'transfer' && (
        <TaskDialog
          title="新建同仓移位"
          busy={busy}
          message={message}
          error={failed}
          onClose={() => setDialog(null)}
        >
          <form
            onSubmit={(e) => {
              const d = form(e);
              if (!source) return;
              void work(async () => {
                await action('stock-transfers', {
                  sourcePositionId: source.id,
                  targetLocationId: d.get('targetLocationId'),
                  quantity: Number(d.get('quantity')),
                  version: source.version,
                  reason: d.get('reason'),
                });
                setDialog(null);
                await refreshSaved();
              });
            }}
          >
            <label>
              源库存位置
              <select required value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
                <option value="">请选择商品、批次与库位</option>
                {positions.items
                  .filter((p) => p.onHand > 0)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {positionName(p)}
                    </option>
                  ))}
              </select>
            </label>
            {source && (
              <div className="task-summary">
                <p>
                  实物 {source.onHand} / 预占 {source.reserved} / 不可售 {source.blocked}
                </p>
                <p>
                  {source.reserved
                    ? '源位置有预占，整位置暂不允许移动。'
                    : `可移动 ${source.onHand - source.blocked} 件`}
                </p>
                {source.expired && <p>过期库存允许实物移位，但不会恢复可售。</p>}
              </div>
            )}
            <label>
              目标库位
              <select name="targetLocationId" required key={sourceId}>
                <option value="">请选择启用库位</option>
                {locations.items
                  .filter((l) => l.enabled && l.id !== source?.locationId)
                  .map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.code} · {l.name}
                    </option>
                  ))}
              </select>
            </label>
            <SelectorSupport positions={positions} locations={locations} />
            <label>
              移位数量（件）
              <input
                name="quantity"
                type="number"
                min={1}
                max={source ? Math.min(100000, source.onHand - source.blocked) : 100000}
                step={1}
                required
              />
            </label>
            <label>
              移位原因
              <input name="reason" required maxLength={200} />
            </label>
            <p>确认后立即过账，仓库与批次总量不变，仅改变存放位置。</p>
            <button
              className="primary-button"
              disabled={
                !source ||
                source.reserved > 0 ||
                source.onHand <= source.blocked ||
                positions.loading ||
                locations.loading ||
                !!positions.error ||
                !!locations.error
              }
            >
              确认同仓移位
            </button>
          </form>
        </TaskDialog>
      )}
      {position && (
        <TaskDialog
          title="批次位置与流水"
          busy={false}
          message=""
          onClose={() => setPosition(null)}
        >
          <h3>{positionName(position)}</h3>
          <p>
            实物 {position.onHand} / 预占 {position.reserved} / 不可售 {position.blocked}
          </p>
          <p>
            {position.expiresAt
              ? `到期 ${date(position.expiresAt)}${position.expired ? ' · 已过期' : ''}`
              : '无到期时间'}
          </p>
          <PositionLedger root={root} positionId={position.id} />
          {can('stock.transfer') && (
            <button
              className="primary-button"
              disabled={position.reserved > 0 || position.onHand <= position.blocked}
              onClick={() => startTransfer(position.id)}
            >
              从此位置移位
            </button>
          )}
        </TaskDialog>
      )}
      {transfer && (
        <TaskDialog title="移位记录详情" busy={false} message="" onClose={() => setTransfer(null)}>
          <h3>已过账 · {transfer.quantity} 件</h3>
          <p>
            来源：{positionName(positions.items.find((p) => p.id === transfer.sourcePositionId))}
          </p>
          <p>
            目标：{positionName(positions.items.find((p) => p.id === transfer.targetPositionId))}
          </p>
          <p>
            {date(transfer.createdAt)} · {transfer.reason}
          </p>
          <p>移位记录不可修改；如需调整实物位置，请新建移位。</p>
          <SelectorSupport positions={positions} locations={locations} />
          <details>
            <summary>查看内部追溯编号</summary>
            <p>移位 {transfer.id}</p>
            <p>来源 {transfer.sourcePositionId}</p>
            <p>目标 {transfer.targetPositionId}</p>
          </details>
        </TaskDialog>
      )}
      {dialog === 'check' && (
        <TaskDialog
          title="核对账本与销售暂停"
          busy={busy}
          message={message}
          error={failed}
          onClose={() => setDialog(null)}
        >
          <label>
            核对商品规格
            <select
              value={checkSku}
              onChange={(e) => {
                setCheckSku(e.target.value);
                setBalance(null);
              }}
            >
              <option value="">请选择商品与规格</option>
              {skuOptions.map((p) => (
                <option key={p.skuId} value={p.skuId}>
                  {p.name} · {p.spec} · {p.skuCode}
                </option>
              ))}
            </select>
          </label>
          <SelectorSupport positions={positions} locations={locations} />
          {balanceLoading && <p role="status">正在加载账面…</p>}
          {balanceError && (
            <div className="task-error" role="alert">
              {balanceError}
              <button className="secondary-button" onClick={() => setBalanceRetry((v) => v + 1)}>
                重新加载账面
              </button>
            </div>
          )}
          {checkSku && !balanceLoading && !balanceError && !balance && (
            <p>该仓库尚无此规格账面。</p>
          )}
          {balance && (
            <p>
              当前账面 {balance.onHand} 件 · {balance.inventoryHold ? '核对暂停销售' : '无核对暂停'}
            </p>
          )}
          <p>核对只保存报告；发现差异时暂停销售，不自动修正数量。</p>
          <button
            className="primary-button"
            disabled={!balance || balanceLoading || !!balanceError}
            onClick={() =>
              void work(async () => {
                const saved = await action<InventoryCheck>('inventory-checks', { skuId: checkSku });
                setDialog(null);
                setReport(saved);
                await refreshSaved();
              })
            }
          >
            确认执行账本核对
          </button>
          {balance?.inventoryHold && can('stock.release-hold') && (
            <form
              onSubmit={(e) => {
                const d = form(e);
                void work(async () => {
                  await action(`stock/${checkSku}/release-check-hold`, {
                    version: balance.version,
                    reason: d.get('reason'),
                  });
                  setDialog(null);
                  await refreshSaved();
                });
              }}
            >
              <p>复核一致仍不会自动恢复销售。解除前将由服务端重新完整核对。</p>
              <label>
                解除暂停原因
                <input name="reason" required maxLength={200} />
              </label>
              <button className="primary-button" disabled={balanceLoading || !!balanceError}>
                复核并解除核对暂停
              </button>
            </form>
          )}
        </TaskDialog>
      )}
      {report && (
        <TaskDialog
          title="库存核对报告"
          busy={false}
          message={message}
          error={failed}
          onClose={() => setReport(null)}
        >
          <h3>{report.status === 'CONSISTENT' ? '账本一致' : '发现差异，已记录核对结果'}</h3>
          <p>
            {skuOptions.find((p) => p.skuId === report.skuId)?.name ?? '商品资料未载入'} ·{' '}
            {date(report.createdAt)} · {report.issueCount} 项差异
          </p>
          <p>这是核对时的账本快照，不代表实物盘点或当前销售暂停状态。</p>
          {report.issues.map((i, n) => (
            <div className="task-summary" key={n}>
              <strong>{kinds[i.kind] ?? '其他账本差异'}</strong>
              <p>
                账面：实物 {i.expected.onHand} / 预占 {i.expected.reserved} / 不可售{' '}
                {i.expected.blocked}
              </p>
              <p>
                核对值：实物 {i.actual.onHand} / 预占 {i.actual.reserved} / 不可售{' '}
                {i.actual.blocked}
              </p>
              <details>
                <summary>查看差异对象编号</summary>
                <p>{i.resourceId}</p>
              </details>
            </div>
          ))}
          {report.issueCount > report.issues.length && (
            <p>仅展示前100项差异，请继续按该规格调查。</p>
          )}
          <details>
            <summary>查看报告追溯编号</summary>
            <p>{report.id}</p>
            <p>规格 {report.skuId}</p>
          </details>
        </TaskDialog>
      )}
    </section>
  );
}
function SelectorSupport({
  positions,
  locations,
}: {
  positions: ReturnType<typeof usePage<StockPosition>>;
  locations: ReturnType<typeof usePage<WarehouseLocation>>;
}) {
  return (
    <div className="selector-support">
      {positions.error && (
        <p className="task-error">
          批次位置加载失败：{positions.error}
          <button
            type="button"
            className="secondary-button"
            onClick={() => void positions.reload().catch(() => {})}
          >
            重试批次位置
          </button>
        </p>
      )}
      {locations.error && (
        <p className="task-error">
          库位加载失败：{locations.error}
          <button
            type="button"
            className="secondary-button"
            onClick={() => void locations.reload().catch(() => {})}
          >
            重试库位
          </button>
        </p>
      )}
      {positions.cursor && (
        <button
          type="button"
          className="secondary-button"
          disabled={positions.loading}
          onClick={() => void positions.next().catch(() => {})}
        >
          加载更多批次位置
        </button>
      )}
      {locations.cursor && (
        <button
          type="button"
          className="secondary-button"
          disabled={locations.loading}
          onClick={() => void locations.next().catch(() => {})}
        >
          加载更多存储库位
        </button>
      )}
    </div>
  );
}
function PositionLedger({ root, positionId }: { root: string; positionId: string }) {
  const entries = usePage<PositionLedgerEntry>(`${root}/positions/${positionId}/ledger?limit=20`);
  const actionName = (key: string) =>
    key.startsWith('TRANSFER:')
      ? '移位'
      : key.startsWith('RECEIPT:')
        ? '收货入库'
        : key.startsWith('ISOLATE:')
          ? '库存隔离'
          : key.startsWith('DISPOSITION:')
            ? '库存处置'
            : key.startsWith('RECEIPT_REVERSE:')
              ? '收货纠错'
              : key.startsWith('COUNT:')
                ? '实物盘点'
                : '库存变动';
  return (
    <section aria-label="位置流水">
      <h4>位置流水</h4>
      <button
        className="secondary-button"
        disabled={entries.loading}
        onClick={() => void entries.reload().catch(() => {})}
      >
        刷新位置流水
      </button>
      <PageState page={entries} empty="此位置暂无流水。">
        {entries.items.map((e) => (
          <div className="task-summary" key={e.id}>
            <strong>{actionName(e.actionKey)}</strong>
            <p>
              实物 {e.deltaOnHand > 0 ? '+' : ''}
              {e.deltaOnHand} / 预占 {e.deltaReserved > 0 ? '+' : ''}
              {e.deltaReserved} / 不可售 {e.deltaBlocked > 0 ? '+' : ''}
              {e.deltaBlocked}
            </p>
            <p>
              {date(e.createdAt)} · {e.reason ?? '未填写变动说明'}
            </p>
            <details>
              <summary>查看流水追溯编号</summary>
              <p>{e.id}</p>
              <p>{e.actionKey}</p>
            </details>
          </div>
        ))}
      </PageState>
      {entries.cursor && (
        <button
          className="secondary-button"
          disabled={entries.loading}
          onClick={() => void entries.next().catch(() => {})}
        >
          加载更多位置流水
        </button>
      )}
    </section>
  );
}
