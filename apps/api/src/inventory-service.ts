import { randomUUID } from 'node:crypto';
import type { Prisma } from '@yumi/database';
import type { ApiRequest } from './http.js';
import { failure } from './http.js';
import { CatalogService, jsonValue } from './catalog-service.js';

type Tx = Prisma.TransactionClient;
export interface TransferInput {
  sourcePositionId: string;
  targetLocationId: string;
  quantity: number;
  version: number;
  reason: string;
}
export class InventoryService {
  constructor(readonly catalog: CatalogService) {}
  get db(): CatalogService['db'] {
    return this.catalog.db;
  }
  async balance(tx: Tx, warehouseId: string, skuId: string) {
    await tx.$queryRaw`SELECT sku_id FROM stock_balances WHERE warehouse_id=${warehouseId}::uuid AND sku_id=${skuId}::uuid FOR UPDATE`;
    const row = await tx.stockBalance.findUnique({
      where: { warehouseId_skuId: { warehouseId, skuId } },
    });
    if (!row) throw failure(404, 'RESOURCE_NOT_FOUND', '该仓库尚无该规格库存');
    return row;
  }
  async createLocation(
    request: ApiRequest,
    key: string,
    warehouseId: string,
    input: { code: string; name: string },
  ) {
    await this.catalog.warehouse(this.db, request, warehouseId);
    return this.catalog.write(request, 'LOCATION_CREATE', warehouseId, key, input, async (tx) => {
      await this.catalog.warehouse(tx, request, warehouseId);
      const row = await tx.warehouseLocation.create({
        data: { id: randomUUID(), warehouseId, ...input },
      });
      await this.catalog.audit(tx, request, 'LOCATION_CREATE', row.id, warehouseId);
      return row;
    });
  }
  async locationAction(
    request: ApiRequest,
    key: string,
    warehouseId: string,
    id: string,
    version: number,
    enabled: boolean,
  ) {
    await this.catalog.warehouse(this.db, request, warehouseId);
    return this.catalog.write(
      request,
      enabled ? 'LOCATION_ENABLE' : 'LOCATION_DISABLE',
      id,
      key,
      { warehouseId, version },
      async (tx) => {
        await this.catalog.warehouse(tx, request, warehouseId);
        await tx.$queryRaw`SELECT id FROM warehouse_locations WHERE id=${id}::uuid AND warehouse_id=${warehouseId}::uuid FOR UPDATE`;
        const row = await tx.warehouseLocation.findFirst({ where: { id, warehouseId } });
        if (!row) throw failure(404, 'RESOURCE_NOT_FOUND', '库位不存在');
        if (row.version !== version) throw failure(409, 'VERSION_CONFLICT', '库位已更新，请刷新');
        if (row.enabled === enabled || (!enabled && row.code === 'DEFAULT'))
          throw failure(409, 'INVALID_TRANSITION', '默认收货位不能停用，或当前状态不允许该动作');
        if (
          !enabled &&
          (await tx.stockPosition.count({
            where: {
              locationId: id,
              OR: [{ onHand: { gt: 0 } }, { reserved: { gt: 0 } }, { blocked: { gt: 0 } }],
            },
          }))
        )
          throw failure(409, 'LOCATION_NOT_EMPTY', '有库存的库位不能停用');
        const result = await tx.warehouseLocation.update({
          where: { id },
          data: { enabled, version: { increment: 1 } },
        });
        await this.catalog.audit(
          tx,
          request,
          enabled ? 'LOCATION_ENABLE' : 'LOCATION_DISABLE',
          id,
          warehouseId,
        );
        return result;
      },
    );
  }
  async transfer(request: ApiRequest, key: string, warehouseId: string, input: TransferInput) {
    await this.catalog.warehouse(this.db, request, warehouseId);
    return this.catalog.write(request, 'STOCK_TRANSFER', warehouseId, key, input, async (tx) => {
      await this.catalog.warehouse(tx, request, warehouseId);
      const sourceHint = await tx.stockPosition.findFirst({
        where: { id: input.sourcePositionId, warehouseId },
      });
      if (!sourceHint) throw failure(404, 'RESOURCE_NOT_FOUND', '源库存位置不存在');
      const balance = await this.balance(tx, warehouseId, sourceHint.skuId);
      if (balance.activeCountId)
        throw failure(409, 'COUNT_FROZEN', '该规格正在盘点，请等待过账或终止');
      if (balance.inventoryHold)
        throw failure(409, 'INVENTORY_HOLD', '该规格有库存核对暂停，请先处理');
      const source = await tx.stockPosition.findUniqueOrThrow({ where: { id: sourceHint.id } });
      if (source.version !== input.version)
        throw failure(409, 'VERSION_CONFLICT', '源库存位置已更新，请刷新');
      if (source.reserved > 0) throw failure(409, 'STOCK_RESERVED', '源位置存在预占，暂不允许移位');
      if (source.onHand - source.blocked < input.quantity)
        throw failure(409, 'INSUFFICIENT_STOCK', '可移动数量不足');
      if (source.locationId === input.targetLocationId)
        throw failure(400, 'VALIDATION_ERROR', '目标必须是不同库位');
      await tx.$queryRaw`SELECT id FROM warehouse_locations WHERE id IN (${source.locationId}::uuid,${input.targetLocationId}::uuid) AND warehouse_id=${warehouseId}::uuid ORDER BY id FOR SHARE`;
      const locations = await tx.warehouseLocation.findMany({
        where: {
          id: { in: [source.locationId, input.targetLocationId] },
          warehouseId,
          enabled: true,
        },
      });
      if (locations.length !== 2)
        throw failure(403, 'LOCATION_UNAVAILABLE', '库位不属于本仓或已停用');
      const targetId = randomUUID();
      await tx.$executeRaw`INSERT INTO stock_positions(id,warehouse_id,sku_id,lot_id,location_id,on_hand) VALUES(${targetId}::uuid,${warehouseId}::uuid,${source.skuId}::uuid,${source.lotId}::uuid,${input.targetLocationId}::uuid,0) ON CONFLICT(lot_id,location_id) DO NOTHING`;
      const target = await tx.stockPosition.findUniqueOrThrow({
        where: { lotId_locationId: { lotId: source.lotId, locationId: input.targetLocationId } },
      });
      await tx.stockPosition.update({
        where: { id: source.id },
        data: { onHand: { decrement: input.quantity }, version: { increment: 1 } },
      });
      const updated =
        await tx.$executeRaw`UPDATE stock_positions SET on_hand=on_hand+${input.quantity},version=version+1 WHERE id=${target.id}::uuid AND on_hand<=1000000000-${input.quantity}`;
      if (updated !== 1) throw failure(409, 'STOCK_LIMIT', '目标库位库存超出范围');
      await tx.stockBalance.update({
        where: { warehouseId_skuId: { warehouseId, skuId: source.skuId } },
        data: { version: { increment: 1 } },
      });
      const id = randomUUID(),
        stockLedgerId = randomUUID();
      await tx.stockLedger.create({
        data: {
          id: stockLedgerId,
          warehouseId,
          skuId: source.skuId,
          lotId: source.lotId,
          actionKey: `TRANSFER:${id}`,
          deltaOnHand: 0,
          actorId: request.staffContext!.staffId,
          requestId: request.requestId,
        },
      });
      await tx.positionLedger.createMany({
        data: [
          {
            id: randomUUID(),
            positionId: source.id,
            warehouseId,
            skuId: source.skuId,
            lotId: source.lotId,
            stockLedgerId,
            deltaOnHand: -input.quantity,
            deltaReserved: 0,
            deltaBlocked: 0,
          },
          {
            id: randomUUID(),
            positionId: target.id,
            warehouseId,
            skuId: source.skuId,
            lotId: source.lotId,
            stockLedgerId,
            deltaOnHand: input.quantity,
            deltaReserved: 0,
            deltaBlocked: 0,
          },
        ],
      });
      const result = await tx.stockTransfer.create({
        data: {
          id,
          warehouseId,
          skuId: source.skuId,
          lotId: source.lotId,
          sourcePositionId: source.id,
          targetPositionId: target.id,
          quantity: input.quantity,
          reason: input.reason,
          stockLedgerId,
        },
      });
      await this.catalog.audit(tx, request, 'STOCK_TRANSFER', id, warehouseId, input.reason);
      return result;
    });
  }
  async issues(tx: Tx, warehouseId: string, skuId: string) {
    // Each comparison uses a single statement snapshot under the shared balance writer lock.
    const rows = await tx.$queryRaw<
      Array<{
        kind: string;
        resourceId: string;
        expected: Prisma.JsonValue;
        actual: Prisma.JsonValue;
        total: bigint;
      }>
    >`
      WITH lots AS (SELECT * FROM stock_lots WHERE warehouse_id=${warehouseId}::uuid AND sku_id=${skuId}::uuid),
      positions AS (SELECT * FROM stock_positions WHERE warehouse_id=${warehouseId}::uuid AND sku_id=${skuId}::uuid),
      ledger AS (SELECT * FROM stock_ledger WHERE warehouse_id=${warehouseId}::uuid AND sku_id=${skuId}::uuid),
      entries AS (SELECT * FROM position_ledger WHERE warehouse_id=${warehouseId}::uuid AND sku_id=${skuId}::uuid),
      comparisons AS (
        SELECT 'BALANCE_LOTS' kind,${skuId}::uuid id,b.on_hand::bigint eh,b.reserved::bigint er,b.blocked::bigint eb,COALESCE(SUM(l.on_hand),0) ah,COALESCE(SUM(l.reserved),0) ar,COALESCE(SUM(l.blocked),0) ab FROM stock_balances b LEFT JOIN lots l ON true WHERE b.warehouse_id=${warehouseId}::uuid AND b.sku_id=${skuId}::uuid GROUP BY b.warehouse_id,b.sku_id
        UNION ALL SELECT 'BALANCE_LEDGER',${skuId}::uuid,b.on_hand,b.reserved,b.blocked,COALESCE(SUM(e.delta_on_hand),0),COALESCE(SUM(e.delta_reserved),0),COALESCE(SUM(e.delta_blocked),0) FROM stock_balances b LEFT JOIN ledger e ON true WHERE b.warehouse_id=${warehouseId}::uuid AND b.sku_id=${skuId}::uuid GROUP BY b.warehouse_id,b.sku_id
        UNION ALL SELECT 'LOT_POSITIONS',l.id,l.on_hand,l.reserved,l.blocked,COALESCE(SUM(p.on_hand),0),COALESCE(SUM(p.reserved),0),COALESCE(SUM(p.blocked),0) FROM lots l LEFT JOIN positions p ON p.lot_id=l.id GROUP BY l.id,l.on_hand,l.reserved,l.blocked
        UNION ALL SELECT 'LOT_LEDGER',l.id,l.on_hand,l.reserved,l.blocked,COALESCE(SUM(e.delta_on_hand),0),COALESCE(SUM(e.delta_reserved),0),COALESCE(SUM(e.delta_blocked),0) FROM lots l LEFT JOIN ledger e ON e.lot_id=l.id GROUP BY l.id,l.on_hand,l.reserved,l.blocked
        UNION ALL SELECT 'POSITION_LEDGER',p.id,p.on_hand,p.reserved,p.blocked,COALESCE(SUM(e.delta_on_hand),0),COALESCE(SUM(e.delta_reserved),0),COALESCE(SUM(e.delta_blocked),0) FROM positions p LEFT JOIN entries e ON e.position_id=p.id GROUP BY p.id,p.on_hand,p.reserved,p.blocked
        UNION ALL SELECT 'EVENT_POSITIONS',l.id,l.delta_on_hand,l.delta_reserved,l.delta_blocked,COALESCE(SUM(e.delta_on_hand),0),COALESCE(SUM(e.delta_reserved),0),COALESCE(SUM(e.delta_blocked),0) FROM ledger l LEFT JOIN entries e ON e.stock_ledger_id=l.id GROUP BY l.id,l.delta_on_hand,l.delta_reserved,l.delta_blocked
      ) SELECT kind,id AS "resourceId",jsonb_build_object('onHand',eh::text,'reserved',er::text,'blocked',eb::text) expected,jsonb_build_object('onHand',ah::text,'reserved',ar::text,'blocked',ab::text) actual,COUNT(*) OVER() total FROM comparisons WHERE ROW(eh,er,eb) IS DISTINCT FROM ROW(ah,ar,ab) ORDER BY kind,id LIMIT 100`;
    return {
      issueCount: Number(rows[0]?.total ?? 0),
      issues: rows.map(({ kind, resourceId, expected, actual }) => ({
        kind,
        resourceId,
        expected,
        actual,
      })),
    };
  }
  async report(
    tx: Tx,
    request: ApiRequest,
    warehouseId: string,
    skuId: string,
    result: Awaited<ReturnType<InventoryService['issues']>>,
  ) {
    const row = await tx.inventoryCheck.create({
      data: {
        id: randomUUID(),
        warehouseId,
        skuId,
        actorId: request.staffContext!.staffId,
        status: result.issueCount ? 'DIFFERENCES' : 'CONSISTENT',
        ...result,
        issues: result.issues as Prisma.InputJsonValue,
      },
    });
    await this.catalog.audit(tx, request, 'INVENTORY_CHECK', row.id, warehouseId);
    return row;
  }
  async check(request: ApiRequest, key: string, warehouseId: string, skuId: string) {
    await this.catalog.warehouse(this.db, request, warehouseId);
    return this.catalog.write(
      request,
      'INVENTORY_CHECK',
      skuId,
      key,
      { warehouseId },
      async (tx) => {
        await this.catalog.warehouse(tx, request, warehouseId);
        const balance = await this.balance(tx, warehouseId, skuId);
        const result = await this.issues(tx, warehouseId, skuId);
        if (result.issueCount && !balance.inventoryHold)
          await tx.stockBalance.update({
            where: { warehouseId_skuId: { warehouseId, skuId } },
            data: { inventoryHold: true, version: { increment: 1 } },
          });
        return this.report(tx, request, warehouseId, skuId, result);
      },
    );
  }
  async release(
    request: ApiRequest,
    key: string,
    warehouseId: string,
    skuId: string,
    input: { version: number; reason: string },
  ) {
    await this.catalog.warehouse(this.db, request, warehouseId);
    return this.catalog.write(
      request,
      'INVENTORY_HOLD_RELEASE',
      skuId,
      key,
      { warehouseId, ...input },
      async (tx) => {
        await this.catalog.warehouse(tx, request, warehouseId);
        const balance = await this.balance(tx, warehouseId, skuId);
        if (balance.version !== input.version)
          throw failure(409, 'VERSION_CONFLICT', '库存已更新，请刷新');
        if (!balance.inventoryHold) throw failure(409, 'INVALID_TRANSITION', '当前未因核对暂停');
        const result = await this.issues(tx, warehouseId, skuId);
        if (result.issueCount)
          throw failure(409, 'INVENTORY_MISMATCH', '库存仍有差异，不能解除暂停');
        const report = await this.report(tx, request, warehouseId, skuId, result);
        const row = await tx.stockBalance.update({
          where: { warehouseId_skuId: { warehouseId, skuId } },
          data: { inventoryHold: false, version: { increment: 1 } },
        });
        await this.catalog.audit(
          tx,
          request,
          'INVENTORY_HOLD_RELEASE',
          report.id,
          warehouseId,
          input.reason,
        );
        return jsonValue({ ...row, checkId: report.id, reason: input.reason });
      },
    );
  }
}
