import { randomUUID } from 'node:crypto';
import type { Prisma } from '@yumi/database';
import { InventoryService } from './inventory-service.js';
import type { ApiRequest } from './http.js';
import { failure } from './http.js';
type Tx = Prisma.TransactionClient;
export class StockCountService {
  constructor(readonly inventory: InventoryService) {}
  get catalog() {
    return this.inventory.catalog;
  }
  get db(): InventoryService['db'] {
    return this.inventory.db;
  }
  async start(
    request: ApiRequest,
    key: string,
    warehouseId: string,
    input: { skuId: string; version: number; reason: string },
  ) {
    await this.catalog.warehouse(this.db, request, warehouseId);
    return this.catalog.write(request, 'COUNT_START', warehouseId, key, input, async (tx) => {
      await this.catalog.warehouse(tx, request, warehouseId);
      const b = await this.inventory.balance(tx, warehouseId, input.skuId);
      if (b.version !== input.version) throw failure(409, 'VERSION_CONFLICT', '库存已更新，请刷新');
      if (b.activeCountId) throw failure(409, 'COUNT_FROZEN', '该规格已有进行中的盘点');
      if (b.inventoryHold) throw failure(409, 'INVENTORY_HOLD', '先处理账本核对暂停');
      if ((await this.inventory.issues(tx, warehouseId, input.skuId)).issueCount)
        throw failure(409, 'INVENTORY_MISMATCH', '账本不一致，不能开始实物盘点');
      const positions = await tx.stockPosition.findMany({
        where: { warehouseId, skuId: input.skuId },
        orderBy: { id: 'asc' },
        take: 201,
      });
      if (!positions.length || positions.length > 200)
        throw failure(409, 'COUNT_SIZE_LIMIT', '单次盘点须有1至200个位置');
      if (b.reserved || positions.some((p) => p.reserved))
        throw failure(409, 'STOCK_RESERVED', '存在预占，不能冻结盘点');
      const id = randomUUID();
      await tx.stockCount.create({
        data: {
          id,
          warehouseId,
          skuId: input.skuId,
          reason: input.reason,
          createdBy: request.staffContext!.staffId,
        },
      });
      await tx.stockCountLine.createMany({
        data: positions.map((p) => ({
          id: randomUUID(),
          countId: id,
          warehouseId,
          skuId: p.skuId,
          lotId: p.lotId,
          positionId: p.id,
          snapshotOnHand: p.onHand,
          snapshotReserved: p.reserved,
          snapshotBlocked: p.blocked,
          positionVersion: p.version,
        })),
      });
      const row = await tx.stockCount.findUniqueOrThrow({
        where: { id },
        include: { lines: { orderBy: { id: 'asc' } } },
      });
      await tx.stockBalance.update({
        where: { warehouseId_skuId: { warehouseId, skuId: input.skuId } },
        data: { activeCountId: id, version: { increment: 1 } },
      });
      await this.catalog.audit(tx, request, 'COUNT_START', id, warehouseId, input.reason);
      return row;
    });
  }
  async snapshot(
    tx: Tx,
    warehouseId: string,
    skuId: string,
    lines: Array<{
      positionId: string;
      snapshotOnHand: number;
      snapshotReserved: number;
      snapshotBlocked: number;
      positionVersion: number;
    }>,
  ) {
    const positions = await tx.stockPosition.findMany({ where: { warehouseId, skuId } });
    if (
      positions.length !== lines.length ||
      lines.some((l) => {
        const p = positions.find((p) => p.id === l.positionId);
        return (
          !p ||
          p.version !== l.positionVersion ||
          p.onHand !== l.snapshotOnHand ||
          p.reserved !== l.snapshotReserved ||
          p.blocked !== l.snapshotBlocked
        );
      })
    )
      throw failure(409, 'COUNT_SNAPSHOT_CONFLICT', '盘点快照已改变，请终止并排查');
    if ((await this.inventory.issues(tx, warehouseId, skuId)).issueCount)
      throw failure(409, 'INVENTORY_MISMATCH', '账本不一致，不能推进盘点');
  }
  async action(
    request: ApiRequest,
    key: string,
    warehouseId: string,
    id: string,
    action: 'submit' | 'approve' | 'post' | 'cancel',
    input: {
      version: number;
      reason?: string;
      lines?: Array<{ positionId: string; counted: number }>;
    },
  ) {
    await this.catalog.warehouse(this.db, request, warehouseId);
    return this.catalog.write(
      request,
      `COUNT_${action.toUpperCase()}`,
      id,
      key,
      { warehouseId, ...input },
      async (tx) => {
        await this.catalog.warehouse(tx, request, warehouseId);
        const hint = await tx.stockCount.findFirst({ where: { id, warehouseId } });
        if (!hint) throw failure(404, 'RESOURCE_NOT_FOUND', '盘点单不存在');
        const b = await this.inventory.balance(tx, warehouseId, hint.skuId);
        const row = await tx.stockCount.findUniqueOrThrow({
          where: { id },
          include: { lines: { orderBy: { id: 'asc' } } },
        });
        if (row.version !== input.version)
          throw failure(409, 'VERSION_CONFLICT', '盘点单已更新，请刷新');
        if (b.activeCountId !== id || ['POSTED', 'CANCELLED'].includes(row.status))
          throw failure(409, 'INVALID_TRANSITION', '盘点单已结束');
        const next: Prisma.StockCountUpdateInput = { version: { increment: 1 } };
        if (action === 'cancel') {
          const evidence = await this.inventory.issues(tx, warehouseId, row.skuId);
          if (evidence.issueCount) {
            await tx.stockBalance.update({
              where: { warehouseId_skuId: { warehouseId, skuId: row.skuId } },
              data: { inventoryHold: true },
            });
            await this.inventory.report(tx, request, warehouseId, row.skuId, evidence);
          }
          Object.assign(next, {
            status: 'CANCELLED',
            cancelReason: input.reason,
            cancelledAt: new Date(),
          });
        } else {
          if (b.inventoryHold)
            throw failure(409, 'INVENTORY_HOLD', '核对暂停中，请先排查或终止盘点');
          await this.snapshot(tx, warehouseId, row.skuId, row.lines);
          if (action === 'submit') {
            if (row.createdBy !== request.staffContext!.staffId)
              throw failure(403, 'COUNT_OWNER_REQUIRED', '仅发起人可录入并提交实盘结果');
            if (row.status !== 'FROZEN')
              throw failure(409, 'INVALID_TRANSITION', '仅冻结中的盘点可提交');
            if (
              row.lines.length !== input.lines!.length ||
              row.lines.some((l) => !input.lines!.some((v) => v.positionId === l.positionId))
            )
              throw failure(400, 'VALIDATION_ERROR', '必须一次提交所有快照位置');
            for (const l of row.lines) {
              const counted = input.lines!.find((v) => v.positionId === l.positionId)!.counted;
              if (counted < l.snapshotReserved + l.snapshotBlocked)
                throw failure(409, 'PROTECTED_STOCK', '实盘数不能低于预占与不可售数之和');
              await tx.stockCountLine.update({ where: { id: l.id }, data: { counted } });
            }
            Object.assign(next, { status: 'SUBMITTED', submittedAt: new Date() });
          } else if (action === 'approve') {
            if (row.status !== 'SUBMITTED')
              throw failure(409, 'INVALID_TRANSITION', '先提交实盘结果');
            if (row.createdBy === request.staffContext!.staffId)
              throw failure(403, 'INDEPENDENT_REVIEW_REQUIRED', '须由另一位员工审批盘点');
            Object.assign(next, {
              status: 'APPROVED',
              reviewedBy: request.staffContext!.staffId,
              reviewReason: input.reason,
              reviewedAt: new Date(),
            });
          } else {
            if (row.status !== 'APPROVED') throw failure(409, 'INVALID_TRANSITION', '先审批再过账');
            const deltas = row.lines
              .map((l) => {
                if (l.counted === null) throw failure(409, 'INVALID_TRANSITION', '缺少实盘数');
                return { ...l, delta: l.counted - l.snapshotOnHand };
              })
              .sort((a, b) => a.delta - b.delta);
            const totalDelta = deltas.reduce((n, l) => n + l.delta, 0);
            const lotDeltas = new Map<string, number>();
            for (const l of deltas) lotDeltas.set(l.lotId, (lotDeltas.get(l.lotId) ?? 0) + l.delta);
            const lots = await tx.stockLot.findMany({ where: { warehouseId, skuId: row.skuId } });
            if (
              b.onHand + totalDelta > 1000000000 ||
              lots.some((l) => l.onHand + (lotDeltas.get(l.id) ?? 0) > 1000000000)
            )
              throw failure(409, 'STOCK_LIMIT', '盘点后汇总或批次数量超出范围');
            await tx.$queryRaw`SELECT set_config('yumi.count_post',${id},true)`;
            for (const l of deltas) {
              const delta = l.delta;
              if (!delta) continue;
              await tx.stockPosition.update({
                where: { id: l.positionId },
                data: { onHand: { increment: delta }, version: { increment: 1 } },
              });
              await tx.stockLot.update({
                where: { id: l.lotId },
                data: { onHand: { increment: delta } },
              });
              const ledgerId = randomUUID();
              await tx.stockLedger.create({
                data: {
                  id: ledgerId,
                  warehouseId,
                  skuId: row.skuId,
                  lotId: l.lotId,
                  actionKey: `COUNT:${id}:${l.id}`,
                  deltaOnHand: delta,
                  actorId: request.staffContext!.staffId,
                  requestId: request.requestId,
                },
              });
              await tx.positionLedger.create({
                data: {
                  id: randomUUID(),
                  warehouseId,
                  skuId: row.skuId,
                  lotId: l.lotId,
                  positionId: l.positionId,
                  stockLedgerId: ledgerId,
                  deltaOnHand: delta,
                  deltaReserved: 0,
                  deltaBlocked: 0,
                },
              });
            }
            await tx.stockBalance.update({
              where: { warehouseId_skuId: { warehouseId, skuId: row.skuId } },
              data: { onHand: { increment: totalDelta } },
            });
            Object.assign(next, { status: 'POSTED', postedAt: new Date() });
          }
        }
        const result = await tx.stockCount.update({
          where: { id },
          data: next,
          include: { lines: { orderBy: { id: 'asc' } } },
        });
        if (action === 'post' || action === 'cancel')
          await tx.stockBalance.update({
            where: { warehouseId_skuId: { warehouseId, skuId: row.skuId } },
            data: { activeCountId: null, version: { increment: 1 } },
          });
        if (
          action === 'post' &&
          (await this.inventory.issues(tx, warehouseId, row.skuId)).issueCount
        )
          throw failure(409, 'INVENTORY_MISMATCH', '过账复核失败，未提交任何数量变化');
        await this.catalog.audit(
          tx,
          request,
          `COUNT_${action.toUpperCase()}`,
          id,
          warehouseId,
          input.reason ?? row.reason,
        );
        return result;
      },
    );
  }
}
