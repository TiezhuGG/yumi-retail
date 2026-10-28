import { randomUUID } from 'node:crypto';
import type { Prisma } from '@yumi/database';
import { InventoryService } from './inventory-service.js';
import { failure } from './http.js';
import type { ApiRequest } from './http.js';
type Tx = Prisma.TransactionClient;
export type DispositionKind = 'RELEASE' | 'DAMAGE';
export class StockDispositionService {
  constructor(readonly inventory: InventoryService) {}
  get db(): InventoryService['db'] {
    return this.inventory.db;
  }
  get catalog() {
    return this.inventory.catalog;
  }
  async ready(tx: Tx, warehouseId: string, skuId: string) {
    const b = await this.inventory.balance(tx, warehouseId, skuId);
    if (b.activeCountId) throw failure(409, 'COUNT_FROZEN', '该规格正在实物盘点');
    if (b.inventoryHold) throw failure(409, 'INVENTORY_HOLD', '请先处理库存核对暂停');
    if ((await this.inventory.issues(tx, warehouseId, skuId)).issueCount)
      throw failure(409, 'INVENTORY_MISMATCH', '账本不一致，不能用隔离或报损修数');
  }
  async position(tx: Tx, warehouseId: string, id: string) {
    const row = await tx.stockPosition.findFirst({
      where: { id, warehouseId },
      include: { lot: { select: { expiresAt: true } }, location: { select: { enabled: true } } },
    });
    if (!row) throw failure(404, 'RESOURCE_NOT_FOUND', '库存位置不存在');
    return row;
  }
  async entries(
    tx: Tx,
    request: ApiRequest,
    position: { id: string; warehouseId: string; skuId: string; lotId: string },
    actionKey: string,
    deltaOnHand: number,
    deltaBlocked: number,
  ) {
    const id = randomUUID();
    await tx.stockLedger.create({
      data: {
        id,
        warehouseId: position.warehouseId,
        skuId: position.skuId,
        lotId: position.lotId,
        actionKey,
        deltaOnHand,
        deltaBlocked,
        actorId: request.staffContext!.staffId,
        requestId: request.requestId,
      },
    });
    await tx.positionLedger.create({
      data: {
        id: randomUUID(),
        positionId: position.id,
        warehouseId: position.warehouseId,
        skuId: position.skuId,
        lotId: position.lotId,
        stockLedgerId: id,
        deltaOnHand,
        deltaBlocked,
        deltaReserved: 0,
      },
    });
    return id;
  }
  async quantities(
    tx: Tx,
    p: { id: string; warehouseId: string; skuId: string; lotId: string },
    deltaOnHand: number,
    deltaBlocked: number,
  ) {
    await tx.stockPosition.update({
      where: { id: p.id },
      data: {
        onHand: { increment: deltaOnHand },
        blocked: { increment: deltaBlocked },
        version: { increment: 1 },
      },
    });
    await tx.stockLot.update({
      where: { id: p.lotId },
      data: { onHand: { increment: deltaOnHand }, blocked: { increment: deltaBlocked } },
    });
    await tx.stockBalance.update({
      where: { warehouseId_skuId: { warehouseId: p.warehouseId, skuId: p.skuId } },
      data: {
        onHand: { increment: deltaOnHand },
        blocked: { increment: deltaBlocked },
        version: { increment: 1 },
      },
    });
  }
  async isolate(
    request: ApiRequest,
    key: string,
    warehouseId: string,
    input: { positionId: string; quantity: number; version: number; reason: string },
  ) {
    await this.catalog.warehouse(this.db, request, warehouseId);
    return this.catalog.write(request, 'STOCK_ISOLATE', warehouseId, key, input, async (tx) => {
      await this.catalog.warehouse(tx, request, warehouseId);
      const hint = await this.position(tx, warehouseId, input.positionId);
      await this.ready(tx, warehouseId, hint.skuId);
      const p = await this.position(tx, warehouseId, hint.id);
      if (p.version !== input.version)
        throw failure(409, 'VERSION_CONFLICT', '库存位置已更新，请刷新');
      if (input.quantity > p.onHand - p.reserved - p.blocked)
        throw failure(409, 'INSUFFICIENT_STOCK', '自由库存不足，不能隔离预占或已隔离数量');
      const id = randomUUID();
      await this.quantities(tx, p, 0, input.quantity);
      const stockLedgerId = await this.entries(tx, request, p, `ISOLATE:${id}`, 0, input.quantity);
      const row = await tx.stockIsolation.create({
        data: {
          id,
          warehouseId,
          skuId: p.skuId,
          lotId: p.lotId,
          positionId: p.id,
          quantity: input.quantity,
          remaining: input.quantity,
          reason: input.reason,
          createdBy: request.staffContext!.staffId,
          stockLedgerId,
        },
      });
      await this.catalog.audit(tx, request, 'STOCK_ISOLATE', id, warehouseId, input.reason);
      return row;
    });
  }
  async eligible(
    tx: Tx,
    warehouseId: string,
    isolationId: string,
    positionVersion: number,
    isolationVersion: number,
    quantity: number,
    kind: DispositionKind,
  ) {
    const isolation = await tx.stockIsolation.findFirst({
      where: { id: isolationId, warehouseId },
    });
    if (!isolation) throw failure(404, 'RESOURCE_NOT_FOUND', '隔离记录不存在');
    const p = await this.position(tx, warehouseId, isolation.positionId);
    if (isolation.version !== isolationVersion || p.version !== positionVersion)
      throw failure(409, 'VERSION_CONFLICT', '隔离或位置已更新，请取消旧申请并重建');
    if (quantity > isolation.remaining || quantity > p.blocked)
      throw failure(409, 'ISOLATION_EXHAUSTED', '本条隔离剩余数量不足');
    if (kind === 'RELEASE') {
      // Hold location state until commit; disabling uses an exclusive location lock.
      await tx.$queryRaw`SELECT id FROM warehouse_locations WHERE id=${p.locationId}::uuid FOR SHARE`;
      const loc = await tx.warehouseLocation.findUniqueOrThrow({ where: { id: p.locationId } });
      const clock = await tx.$queryRaw<
        Array<{ expired: boolean }>
      >`SELECT (expires_at IS NOT NULL AND expires_at<=clock_timestamp()) expired FROM stock_lots WHERE id=${p.lotId}::uuid`;
      if (clock[0]!.expired) throw failure(409, 'EXPIRED_STOCK', '过期批次不能解除隔离');
      if (!loc.enabled) throw failure(409, 'LOCATION_UNAVAILABLE', '停用库位不能解除隔离');
    }
    return { isolation, p };
  }
  async create(
    request: ApiRequest,
    key: string,
    warehouseId: string,
    input: {
      isolationId: string;
      kind: DispositionKind;
      quantity: number;
      positionVersion: number;
      isolationVersion: number;
      reason: string;
    },
  ) {
    await this.catalog.warehouse(this.db, request, warehouseId);
    return this.catalog.write(
      request,
      'DISPOSITION_CREATE',
      warehouseId,
      key,
      input,
      async (tx) => {
        await this.catalog.warehouse(tx, request, warehouseId);
        const hint = await tx.stockIsolation.findFirst({
          where: { id: input.isolationId, warehouseId },
        });
        if (!hint) throw failure(404, 'RESOURCE_NOT_FOUND', '隔离记录不存在');
        await this.ready(tx, warehouseId, hint.skuId);
        await this.eligible(
          tx,
          warehouseId,
          hint.id,
          input.positionVersion,
          input.isolationVersion,
          input.quantity,
          input.kind,
        );
        const row = await tx.stockDisposition.create({
          data: {
            id: randomUUID(),
            warehouseId,
            skuId: hint.skuId,
            lotId: hint.lotId,
            positionId: hint.positionId,
            ...input,
            createdBy: request.staffContext!.staffId,
          },
        });
        await this.catalog.audit(
          tx,
          request,
          'DISPOSITION_CREATE',
          row.id,
          warehouseId,
          input.reason,
        );
        return row;
      },
    );
  }
  async action(
    request: ApiRequest,
    key: string,
    warehouseId: string,
    id: string,
    action: 'approve' | 'post' | 'cancel',
    input: {
      version: number;
      reason?: string;
      physicalConfirmed?: boolean;
      physicalEvidence?: string;
    },
  ) {
    await this.catalog.warehouse(this.db, request, warehouseId);
    return this.catalog.write(
      request,
      `DISPOSITION_${action.toUpperCase()}`,
      id,
      key,
      { warehouseId, ...input },
      async (tx) => {
        await this.catalog.warehouse(tx, request, warehouseId);
        const hint = await tx.stockDisposition.findFirst({ where: { id, warehouseId } });
        if (!hint) throw failure(404, 'RESOURCE_NOT_FOUND', '处置单不存在');
        await this.inventory.balance(tx, warehouseId, hint.skuId);
        const row = await tx.stockDisposition.findUniqueOrThrow({ where: { id } });
        if (row.version !== input.version)
          throw failure(409, 'VERSION_CONFLICT', '处置单已更新，请刷新');
        if (['POSTED', 'CANCELLED'].includes(row.status))
          throw failure(409, 'INVALID_TRANSITION', '处置单已结束');
        const data: Prisma.StockDispositionUpdateInput = { version: { increment: 1 } };
        if (action === 'cancel')
          Object.assign(data, {
            status: 'CANCELLED',
            cancelReason: input.reason,
            cancelledAt: new Date(),
          });
        else {
          await this.ready(tx, warehouseId, row.skuId);
          const { isolation, p } = await this.eligible(
            tx,
            warehouseId,
            row.isolationId,
            row.positionVersion,
            row.isolationVersion,
            row.quantity,
            row.kind as DispositionKind,
          );
          if (action === 'approve') {
            if (row.status !== 'DRAFT')
              throw failure(409, 'INVALID_TRANSITION', '仅待审批单据可审批');
            if (row.createdBy === request.staffContext!.staffId)
              throw failure(403, 'INDEPENDENT_REVIEW_REQUIRED', '须由另一位员工审批');
            Object.assign(data, {
              status: 'APPROVED',
              reviewedBy: request.staffContext!.staffId,
              reviewReason: input.reason,
              reviewedAt: new Date(),
            });
          } else {
            if (row.status !== 'APPROVED')
              throw failure(409, 'INVALID_TRANSITION', '请先审批处置单');
            if (
              row.kind === 'DAMAGE' &&
              (input.physicalConfirmed !== true || !input.physicalEvidence)
            )
              throw failure(
                400,
                'PHYSICAL_CONFIRMATION_REQUIRED',
                '报损过账须明确核验实物并填写说明',
              );
            if (
              row.kind === 'RELEASE' &&
              (input.physicalConfirmed !== undefined || input.physicalEvidence !== undefined)
            )
              throw failure(400, 'VALIDATION_ERROR', '解除隔离无需报损实物字段');
            const delta = row.kind === 'DAMAGE' ? -row.quantity : 0;
            await this.quantities(tx, p, delta, -row.quantity);
            await tx.stockIsolation.update({
              where: { id: isolation.id },
              data: { remaining: { decrement: row.quantity }, version: { increment: 1 } },
            });
            const stockLedgerId = await this.entries(
              tx,
              request,
              p,
              `DISPOSITION:${row.id}`,
              delta,
              -row.quantity,
            );
            Object.assign(data, {
              status: 'POSTED',
              postedAt: new Date(),
              stockLedgerId,
              physicalEvidence: input.physicalEvidence ?? null,
            });
          }
        }
        const result = await tx.stockDisposition.update({ where: { id }, data });
        if (
          action === 'post' &&
          (await this.inventory.issues(tx, warehouseId, row.skuId)).issueCount
        )
          throw failure(409, 'INVENTORY_MISMATCH', '处置后核对失败，全部回滚');
        await this.catalog.audit(
          tx,
          request,
          `DISPOSITION_${action.toUpperCase()}`,
          id,
          warehouseId,
          input.reason ?? input.physicalEvidence ?? row.reason,
        );
        return result;
      },
    );
  }
}
