import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import type {
  InventoryCheck,
  Page,
  PositionLedgerEntry,
  StaffProfile,
  StockPosition,
  WarehouseLocation,
} from '@yumi/contracts';
import { staffRequest } from './index.js';
import { StockCountWorkbench } from './stock-count.js';
const box: CSSProperties = {
  borderTop: '1px solid #d0d5dd',
  marginTop: 24,
  paddingTop: 12,
  overflowWrap: 'anywhere',
};
const control: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: 10,
  minHeight: 44,
  border: '1px solid #d0d5dd',
  borderRadius: 6,
  marginTop: 6,
};
const label: CSSProperties = { display: 'block', marginTop: 12 };
const button: CSSProperties = {
  padding: '10px 14px',
  minHeight: 44,
  border: 0,
  borderRadius: 6,
  background: '#008a42',
  color: 'white',
  margin: '8px 8px 0 0',
  cursor: 'pointer',
};
const kinds: Record<string, string> = {
  BALANCE_LOTS: '汇总与批次',
  BALANCE_LEDGER: '汇总与库存流水',
  LOT_POSITIONS: '批次与库位',
  LOT_LEDGER: '批次与库存流水',
  POSITION_LEDGER: '位置与位置流水',
  EVENT_POSITIONS: '主流水与成对位置流水',
};
interface Balance {
  skuId: string;
  version: number;
  inventoryHold: boolean;
  onHand: number;
}
export function InventoryWorkbench({
  profile,
  warehouseId,
  onStockChanged,
}: {
  profile: StaffProfile;
  warehouseId: string;
  onStockChanged: () => Promise<void>;
}) {
  const [locations, setLocations] = useState<WarehouseLocation[]>([]),
    [locationCursor, setLocationCursor] = useState<string | null>(null);
  const [positions, setPositions] = useState<StockPosition[]>([]),
    [positionCursor, setPositionCursor] = useState<string | null>(null);
  const [reports, setReports] = useState<InventoryCheck[]>([]),
    [reportCursor, setReportCursor] = useState<string | null>(null);
  const [ledger, setLedger] = useState<PositionLedgerEntry[]>([]),
    [ledgerCursor, setLedgerCursor] = useState<string | null>(null),
    [ledgerPosition, setLedgerPosition] = useState('');
  const [sourceId, setSourceId] = useState(''),
    [skuId, setSkuId] = useState(''),
    [filter, setFilter] = useState(''),
    [skuFilter, setSkuFilter] = useState('');
  const [balance, setBalance] = useState<Balance | null>(null),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const intentions = useRef(new Map<string, string>());
  const selectedSku = useRef(skuId);
  selectedSku.current = skuId;
  const positionsRequest = useRef(0),
    reportsRequest = useRef(0),
    ledgerRequest = useRef(0);
  const can = (permission: string) => profile.permissions.includes(permission);
  const root = `/warehouse/warehouses/${warehouseId}`;
  const source = positions.find((p) => p.id === sourceId);
  const skus = [
    ...new Map(
      positions.map((p) => [p.skuId, { id: p.skuId, name: p.name, code: p.skuCode }]),
    ).values(),
  ];
  async function loadLocations(cursor?: string) {
    const page = await staffRequest<Page<WarehouseLocation>>(
      `${root}/locations?limit=50${cursor ? `&cursor=${cursor}` : ''}`,
    );
    setLocations((old) => (cursor ? [...old, ...page.items] : page.items));
    setLocationCursor(page.nextCursor);
  }
  async function loadPositions(cursor?: string, filterValue = skuFilter) {
    const request = ++positionsRequest.current;
    const page = await staffRequest<Page<StockPosition>>(
      `${root}/positions?limit=50${cursor ? `&cursor=${cursor}` : ''}${filterValue ? `&skuId=${filterValue}` : ''}`,
    );
    if (request !== positionsRequest.current) return;
    setPositions((old) => (cursor ? [...old, ...page.items] : page.items));
    setPositionCursor(page.nextCursor);
  }
  async function loadReports(cursor?: string, selected = skuId) {
    const request = ++reportsRequest.current;
    const page = await staffRequest<Page<InventoryCheck>>(
      `${root}/inventory-checks?limit=20${cursor ? `&cursor=${cursor}` : ''}${selected ? `&skuId=${selected}` : ''}`,
    );
    if (request !== reportsRequest.current || selected !== selectedSku.current) return;
    setReports((old) => (cursor ? [...old, ...page.items] : page.items));
    setReportCursor(page.nextCursor);
  }
  async function loadBalance(selected = skuId) {
    if (!selected) {
      setBalance(null);
      return;
    }
    const page = await staffRequest<Page<Balance>>(`${root}/stock?limit=1&skuId=${selected}`);
    if (selected !== selectedSku.current) return;
    setBalance(page.items[0] ?? null);
  }
  async function loadLedger(id: string, cursor?: string) {
    const request = ++ledgerRequest.current;
    const page = await staffRequest<Page<PositionLedgerEntry>>(
      `${root}/positions/${id}/ledger?limit=20${cursor ? `&cursor=${cursor}` : ''}`,
    );
    if (request !== ledgerRequest.current) return;
    setLedger((old) => (cursor ? [...old, ...page.items] : page.items));
    setLedgerPosition(id);
    setLedgerCursor(page.nextCursor);
  }
  async function refresh() {
    await Promise.all([loadLocations(), loadPositions(), loadReports(), loadBalance()]);
  }
  useEffect(() => {
    void Promise.all([loadLocations(), loadPositions(), loadReports()]).catch((err: Error) =>
      setMessage(err.message),
    );
  }, [warehouseId]);
  useEffect(() => {
    setBalance(null);
    void Promise.all([loadBalance(), loadReports()]).catch((err: Error) => setMessage(err.message));
  }, [skuId]);
  async function action(path: string, body: unknown) {
    const signature = path + JSON.stringify(body);
    const key = intentions.current.get(signature) ?? crypto.randomUUID();
    intentions.current.set(signature, key);
    const result = await staffRequest(`${root}/${path}`, {
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
    setMessage('');
    try {
      await run();
      setMessage('操作完成，数据已刷新');
    } catch (err) {
      setMessage(err instanceof Error ? err.message : '操作未完成，请刷新后重试');
    } finally {
      setBusy(false);
    }
  }
  function form(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    return { element: event.currentTarget, data: new FormData(event.currentTarget) };
  }
  if (!warehouseId || !can('stock.read')) return null;
  return (
    <section style={box}>
      <h3>库位、批次与账本核对</h3>
      <p>核对不会修改数量。差异暂停销售后，须复核一致并填写原因才能解除。</p>
      {message && (
        <p role="status" style={{ background: '#f0fdf4', padding: 12 }}>
          {message}
        </p>
      )}
      <fieldset disabled={busy} style={{ border: 0, padding: 0, minWidth: 0 }}>
        <button style={button} onClick={() => void work(refresh)}>
          刷新库位与批次
        </button>
        {can('location.write') && (
          <form
            style={box}
            onSubmit={(event) => {
              const { data, element } = form(event);
              void work(async () => {
                await action('locations', { code: data.get('code'), name: data.get('name') });
                element.reset();
                await loadLocations();
              });
            }}
          >
            <h4>新增存储库位</h4>
            <label style={label}>
              库位编码
              <input
                name="code"
                style={control}
                required
                maxLength={32}
                pattern="[A-Za-z0-9][A-Za-z0-9_-]*"
                placeholder="例如 A-01"
              />
            </label>
            <label style={label}>
              库位名称
              <input name="name" style={control} required maxLength={80} />
            </label>
            <button style={button}>保存库位</button>
          </form>
        )}
        <section style={box}>
          <h4>库位列表</h4>
          {locations.map((loc) => (
            <article key={loc.id}>
              <p>
                <strong>{loc.code}</strong> · {loc.name} · {loc.enabled ? '启用' : '停用'}
              </p>
              {can('location.write') && loc.code !== 'DEFAULT' && (
                <button
                  style={button}
                  onClick={() =>
                    void work(async () => {
                      await action(`locations/${loc.id}/${loc.enabled ? 'disable' : 'enable'}`, {
                        version: loc.version,
                      });
                      await loadLocations();
                    })
                  }
                >
                  {loc.enabled ? '停用' : '启用'} {loc.code}
                </button>
              )}
            </article>
          ))}
          {locationCursor && (
            <button style={button} onClick={() => void work(() => loadLocations(locationCursor))}>
              加载更多库位
            </button>
          )}
        </section>
        <section style={box}>
          <h4>批次位置</h4>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void work(async () => {
                const selected = filter.trim();
                await loadPositions(undefined, selected);
                setSkuFilter(selected);
                setSourceId('');
              });
            }}
          >
            <label style={label}>
              按规格ID筛选（留空查看全部）
              <input
                style={control}
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                maxLength={36}
              />
            </label>
            <button style={button}>筛选库存位置</button>
          </form>
          {!positions.length && <p>暂无符合条件的库存位置，请先收货入库。</p>}
          {positions.map((p) => (
            <article style={box} key={p.id}>
              <strong>
                {p.name} · {p.spec}
              </strong>
              <p>
                {p.locationCode} · 批次 {p.batchNo} · 实物 {p.onHand} · 预占 {p.reserved} · 不可售{' '}
                {p.blocked}
              </p>
              <p>规格ID {p.skuId}</p>
              <p>
                {p.expiresAt
                  ? `到期 ${new Date(p.expiresAt).toLocaleString('zh-CN')}${p.expired ? ' · 已过期，不可售' : ''}`
                  : '无到期时间'}
              </p>
              <button style={button} onClick={() => void work(() => loadLedger(p.id))}>
                查看 {p.locationCode} 位置流水
              </button>
            </article>
          ))}
          {positionCursor && (
            <button style={button} onClick={() => void work(() => loadPositions(positionCursor))}>
              加载更多库存位置
            </button>
          )}
        </section>
        {can('stock.transfer') && (
          <form
            style={box}
            onSubmit={(event) => {
              const { data, element } = form(event);
              if (!source) return;
              void work(async () => {
                await action('stock-transfers', {
                  sourcePositionId: source.id,
                  targetLocationId: data.get('targetLocationId'),
                  quantity: Number(data.get('quantity')),
                  version: source.version,
                  reason: data.get('reason'),
                });
                element.reset();
                setSourceId('');
                await refresh();
                if (ledgerPosition) await loadLedger(ledgerPosition);
              });
            }}
          >
            <h4>同仓移位</h4>
            <label style={label}>
              源库存位置
              <select
                style={control}
                value={sourceId}
                onChange={(event) => setSourceId(event.target.value)}
                required
              >
                <option value="">请选择</option>
                {positions
                  .filter((p) => p.onHand > 0)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · {p.batchNo} · {p.locationCode} · {p.onHand}件
                    </option>
                  ))}
              </select>
            </label>
            {source?.reserved ? <p>源位置有预占，暂不允许移动。</p> : null}
            {source?.expired && <p>过期库存只做实物移位，不会恢复可售。</p>}
            <label style={label}>
              目标库位
              <select name="targetLocationId" style={control} required>
                <option value="">请选择目标库位</option>
                {locations
                  .filter((loc) => loc.enabled && loc.id !== source?.locationId)
                  .map((loc) => (
                    <option key={loc.id} value={loc.id}>
                      {loc.code} · {loc.name}
                    </option>
                  ))}
              </select>
            </label>
            <label style={label}>
              移位数量（件）
              <input
                style={control}
                name="quantity"
                type="number"
                step={1}
                min={1}
                max={source ? Math.min(100000, source.onHand - source.blocked) : 100000}
                required
              />
            </label>
            <label style={label}>
              移位原因
              <input style={control} name="reason" maxLength={200} required />
            </label>
            <button style={button} disabled={!source || source.reserved > 0}>
              确认同仓移位
            </button>
          </form>
        )}
        {ledgerPosition && (
          <section style={box}>
            <h4>位置流水</h4>
            {ledger.map((entry) => (
              <article key={entry.id}>
                <p>
                  {entry.actionKey.startsWith('TRANSFER:')
                    ? '移位'
                    : entry.actionKey.startsWith('RECEIPT:')
                      ? '收货'
                      : '历史记录'}{' '}
                  · 实物 {entry.deltaOnHand > 0 ? '+' : ''}
                  {entry.deltaOnHand} · 预占 {entry.deltaReserved} · 不可售 {entry.deltaBlocked}
                </p>
                <p>
                  {new Date(entry.createdAt).toLocaleString('zh-CN')} {entry.reason ?? ''}
                </p>
              </article>
            ))}
            {ledgerCursor && (
              <button
                style={button}
                onClick={() => void work(() => loadLedger(ledgerPosition, ledgerCursor))}
              >
                加载更多位置流水
              </button>
            )}
          </section>
        )}
        <section style={box}>
          <h4>库存核对</h4>
          <label style={label}>
            核对规格
            <select
              style={control}
              value={skuId}
              onChange={(event) => setSkuId(event.target.value)}
            >
              <option value="">请选择规格</option>
              {skus.map((sku) => (
                <option value={sku.id} key={sku.id}>
                  {sku.name} · {sku.code}
                </option>
              ))}
            </select>
          </label>
          {balance && (
            <p>
              当前账面 {balance.onHand} 件 · {balance.inventoryHold ? '核对暂停销售' : '无核对暂停'}
            </p>
          )}
          {can('stock.check') && (
            <button
              style={button}
              disabled={!skuId}
              onClick={() =>
                void work(async () => {
                  await action('inventory-checks', { skuId });
                  await Promise.all([loadReports(), loadBalance()]);
                })
              }
            >
              执行账本核对
            </button>
          )}
          {balance?.inventoryHold && can('stock.release-hold') && (
            <form
              onSubmit={(event) => {
                const { data, element } = form(event);
                void work(async () => {
                  await action(`stock/${skuId}/release-check-hold`, {
                    version: balance.version,
                    reason: data.get('reason'),
                  });
                  element.reset();
                  await refresh();
                });
              }}
            >
              <label style={label}>
                解除暂停原因
                <input name="reason" style={control} maxLength={200} required />
              </label>
              <button style={button}>复核并解除核对暂停</button>
            </form>
          )}
          {!reports.length && <p>尚无核对报告。</p>}
          {reports.map((report) => (
            <article style={box} key={report.id}>
              <strong>{report.status === 'CONSISTENT' ? '账本一致' : '发现差异'}</strong>
              <p>
                {new Date(report.createdAt).toLocaleString('zh-CN')} · {report.issueCount}项差异
              </p>
              <p>规格ID {report.skuId}</p>
              {report.issues.map((issue, i) => (
                <div key={i}>
                  <p>
                    {kinds[issue.kind] ?? issue.kind} · {issue.resourceId}
                  </p>
                  <p>
                    账面：实物 {issue.expected.onHand} / 预占 {issue.expected.reserved} / 不可售{' '}
                    {issue.expected.blocked}
                  </p>
                  <p>
                    核对值：实物 {issue.actual.onHand} / 预占 {issue.actual.reserved} / 不可售{' '}
                    {issue.actual.blocked}
                  </p>
                </div>
              ))}
              {report.issueCount > report.issues.length && (
                <p>只展示前100项，请按该规格继续排查。</p>
              )}
            </article>
          ))}
          {reportCursor && (
            <button style={button} onClick={() => void work(() => loadReports(reportCursor))}>
              加载更多核对报告
            </button>
          )}
        </section>
      </fieldset>
      <StockCountWorkbench
        key={warehouseId}
        profile={profile}
        warehouseId={warehouseId}
        onChanged={async () => {
          await refresh();
          await onStockChanged();
        }}
      />
    </section>
  );
}
