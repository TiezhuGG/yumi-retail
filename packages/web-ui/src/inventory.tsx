import type { StaffProfile, StockPosition } from '@yumi/contracts';
import { StockCountWorkbench } from './stock-count.js';
import { StockDispositionWorkbench } from './stock-disposition.js';
import { ReceiptReversalWorkbench } from './receipt-reversal.js';
import { LocationWorkbench } from './location-workbench.js';
import { usePage } from './use-page.js';

export function InventoryWorkbench({
  profile,
  warehouseId,
  onStockChanged,
  mode = 'locations',
}: {
  profile: StaffProfile;
  warehouseId: string;
  onStockChanged: () => Promise<void>;
  mode?: 'locations' | 'counts' | 'dispositions' | 'reversals';
}) {
  if (!warehouseId || !profile.permissions.includes('stock.read')) return null;
  if (mode === 'locations')
    return (
      <LocationWorkbench
        profile={profile}
        warehouseId={warehouseId}
        onStockChanged={onStockChanged}
      />
    );
  return (
    <PositionTasks
      profile={profile}
      warehouseId={warehouseId}
      onStockChanged={onStockChanged}
      mode={mode}
    />
  );
}
function PositionTasks({
  profile,
  warehouseId,
  onStockChanged,
  mode,
}: {
  profile: StaffProfile;
  warehouseId: string;
  onStockChanged: () => Promise<void>;
  mode: 'counts' | 'dispositions' | 'reversals';
}) {
  const positions = usePage<StockPosition>(
    `/warehouse/warehouses/${warehouseId}/positions?limit=50`,
  );
  async function changed() {
    await Promise.all([positions.reload(), onStockChanged()]);
  }
  return (
    <section>
      {positions.loading && <p role="status">正在加载可选批次位置…</p>}
      {positions.error && (
        <div className="task-error" role="alert">
          {positions.error}{' '}
          <button
            className="secondary-button"
            onClick={() => void positions.reload().catch(() => {})}
          >
            重试批次位置
          </button>
        </div>
      )}
      {positions.cursor && (
        <button
          className="secondary-button"
          disabled={positions.loading}
          onClick={() => void positions.next().catch(() => {})}
        >
          加载更多可选批次位置
        </button>
      )}
      {mode === 'counts' && (
        <StockCountWorkbench
          profile={profile}
          warehouseId={warehouseId}
          positions={positions.items}
          onChanged={changed}
        />
      )}
      {mode === 'dispositions' && (
        <StockDispositionWorkbench
          profile={profile}
          warehouseId={warehouseId}
          positions={positions.items}
          onChanged={changed}
        />
      )}
      {mode === 'reversals' && (
        <ReceiptReversalWorkbench
          profile={profile}
          warehouseId={warehouseId}
          positions={positions.items}
          onChanged={changed}
        />
      )}
    </section>
  );
}
