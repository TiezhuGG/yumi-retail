import { randomUUID } from 'node:crypto';
import type { Prisma } from '@yumi/database';
import { InventoryService } from './inventory-service.js';
import { failure } from './http.js';
import type { ApiRequest } from './http.js';
type Tx = Prisma.TransactionClient;
export class ReceiptReversalService {
  constructor(readonly inventory: InventoryService) {}
  get db(): InventoryService['db'] {
    return this.inventory.db;
  }
  get catalog() {
    return this.inventory.catalog;
  }
  async position(tx: Tx, w: string, id: string) {
    const p = await tx.stockPosition.findFirst({ where: { id, warehouseId: w } });
    if (!p) throw failure(404, 'RESOURCE_NOT_FOUND', '库存位置不存在');
    return p;
  }
  async ready(tx: Tx, w: string, sku: string) {
    const b = await this.inventory.balance(tx, w, sku);
    if (b.activeCountId) throw failure(409, 'COUNT_FROZEN', '该规格正在盘点');
    if (b.inventoryHold) throw failure(409, 'INVENTORY_HOLD', '请先处理核对暂停');
    if ((await this.inventory.issues(tx, w, sku)).issueCount)
      throw failure(409, 'INVENTORY_MISMATCH', '账本不一致，不能使用逆向单修数');
  }
  async source(tx: Tx, w: string, lotId: string) {
    const lot = await tx.stockLot.findFirst({
      where: { id: lotId, warehouseId: w },
      include: {
        receiptLine: {
          include: { receipt: { select: { id: true, status: true, sourceRef: true } } },
        },
      },
    });
    if (!lot) throw failure(404, 'RESOURCE_NOT_FOUND', '原收货批次不存在');
    if (lot.receiptLine.receipt.status !== 'POSTED')
      throw failure(409, 'RECEIPT_NOT_POSTED', '仅可纠正已过账收货');
    const total = await tx.receiptReversal.aggregate({
      where: { lotId, status: 'POSTED' },
      _sum: { quantity: true },
    });
    return {
      receiptId: lot.receiptLine.receiptId,
      receiptLineId: lot.receiptLineId,
      sourceRef: lot.receiptLine.receipt.sourceRef,
      batchNo: lot.batchNo,
      originalQuantity: lot.receiptLine.quantity,
      reversedQuantity: total._sum.quantity ?? 0,
      remaining: lot.receiptLine.quantity - (total._sum.quantity ?? 0),
    };
  }
  async eligible(tx: Tx, w: string, positionId: string, version: number, quantity: number) {
    const p = await this.position(tx, w, positionId);
    if (p.version !== version)
      throw failure(409, 'VERSION_CONFLICT', '位置已更新，请取消旧申请并重建');
    const source = await this.source(tx, w, p.lotId);
    if (quantity > source.remaining)
      throw failure(409, 'REVERSAL_LIMIT', '累计逆向数量不能超过原收货数量');
    if (quantity > p.onHand - p.reserved - p.blocked)
      throw failure(409, 'INSUFFICIENT_STOCK', '原位置自由库存不足，不能扣除预占或隔离数量');
    return p;
  }
  async create(
    request: ApiRequest,
    key: string,
    w: string,
    input: { positionId: string; quantity: number; positionVersion: number; reason: string },
  ) {
    await this.catalog.warehouse(this.db, request, w);
    return this.catalog.write(request, 'REVERSAL_CREATE', w, key, input, async (tx) => {
      await this.catalog.warehouse(tx, request, w);
      const hint = await this.position(tx, w, input.positionId);
      await this.ready(tx, w, hint.skuId);
      const p = await this.eligible(tx, w, input.positionId, input.positionVersion, input.quantity);
      const row = await tx.receiptReversal.create({
        data: {
          id: randomUUID(),
          warehouseId: w,
          skuId: p.skuId,
          lotId: p.lotId,
          ...input,
          createdBy: request.staffContext!.staffId,
        },
      });
      await this.catalog.audit(tx, request, 'REVERSAL_CREATE', row.id, w, input.reason);
      return row;
    });
  }
  async action(
    request: ApiRequest,
    key: string,
    w: string,
    id: string,
    action: 'approve' | 'post' | 'cancel',
    input: {
      version: number;
      reason?: string;
      physicalConfirmed?: boolean;
      physicalEvidence?: string;
    },
  ) {
    await this.catalog.warehouse(this.db, request, w);
    return this.catalog.write(
      request,
      `REVERSAL_${action.toUpperCase()}`,
      id,
      key,
      { warehouseId: w, ...input },
      async (tx) => {
        await this.catalog.warehouse(tx, request, w);
        const hint = await tx.receiptReversal.findFirst({ where: { id, warehouseId: w } });
        if (!hint) throw failure(404, 'RESOURCE_NOT_FOUND', '逆向单不存在');
        await this.inventory.balance(tx, w, hint.skuId);
        const row = await tx.receiptReversal.findUniqueOrThrow({ where: { id } });
        if (row.version !== input.version) throw failure(409, 'VERSION_CONFLICT', '单据版本已变更');
        if (['POSTED', 'CANCELLED'].includes(row.status))
          throw failure(409, 'INVALID_TRANSITION', '单据已结束');
        const data: Prisma.ReceiptReversalUpdateInput = { version: { increment: 1 } };
        if (action === 'cancel')
          Object.assign(data, {
            status: 'CANCELLED',
            cancelReason: input.reason,
            cancelledAt: new Date(),
          });
        else {
          await this.ready(tx, w, row.skuId);
          const p = await this.eligible(tx, w, row.positionId, row.positionVersion, row.quantity);
          if (action === 'approve') {
            if (row.status !== 'DRAFT')
              throw failure(409, 'INVALID_TRANSITION', '仅待审批单据可审核');
            if (row.createdBy === request.staffContext!.staffId)
              throw failure(403, 'INDEPENDENT_REVIEW_REQUIRED', '须由另一员工审批');
            Object.assign(data, {
              status: 'APPROVED',
              reviewedBy: request.staffContext!.staffId,
              reviewedAt: new Date(),
              reviewReason: input.reason,
            });
          } else {
            if (row.status !== 'APPROVED')
              throw failure(409, 'INVALID_TRANSITION', '请先审批逆向单');
            if (input.physicalConfirmed !== true || !input.physicalEvidence)
              throw failure(
                400,
                'PHYSICAL_CONFIRMATION_REQUIRED',
                '须核验原收货记录与实物，并填写误录核验说明',
              );
            await tx.stockPosition.update({
              where: { id: p.id },
              data: { onHand: { decrement: row.quantity }, version: { increment: 1 } },
            });
            await tx.stockLot.update({
              where: { id: p.lotId },
              data: { onHand: { decrement: row.quantity } },
            });
            await tx.stockBalance.update({
              where: { warehouseId_skuId: { warehouseId: w, skuId: p.skuId } },
              data: { onHand: { decrement: row.quantity }, version: { increment: 1 } },
            });
            const ledgerId = randomUUID();
            await tx.stockLedger.create({
              data: {
                id: ledgerId,
                warehouseId: w,
                skuId: p.skuId,
                lotId: p.lotId,
                actionKey: `RECEIPT_REVERSE:${id}`,
                deltaOnHand: -row.quantity,
                actorId: request.staffContext!.staffId,
                requestId: request.requestId,
              },
            });
            await tx.positionLedger.create({
              data: {
                id: randomUUID(),
                warehouseId: w,
                skuId: p.skuId,
                lotId: p.lotId,
                positionId: p.id,
                stockLedgerId: ledgerId,
                deltaOnHand: -row.quantity,
                deltaReserved: 0,
                deltaBlocked: 0,
              },
            });
            Object.assign(data, {
              status: 'POSTED',
              postedAt: new Date(),
              stockLedgerId: ledgerId,
              physicalEvidence: input.physicalEvidence,
            });
          }
        }
        const result = await tx.receiptReversal.update({ where: { id }, data });
        if (action === 'post' && (await this.inventory.issues(tx, w, row.skuId)).issueCount)
          throw failure(409, 'INVENTORY_MISMATCH', '逆向后账本核对失败，全部回滚');
        await this.catalog.audit(
          tx,
          request,
          `REVERSAL_${action.toUpperCase()}`,
          id,
          w,
          input.reason ?? input.physicalEvidence ?? row.reason,
        );
        return result;
      },
    );
  }
}
