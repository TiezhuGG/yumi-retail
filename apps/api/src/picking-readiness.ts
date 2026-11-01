import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@yumi/database';
import type { PickingReadinessDetail, PickingReadinessSummary } from '@yumi/contracts';
import { CatalogService } from './catalog-service.js';
import { fields, str, uuid } from './catalog-input.js';
import { Permissions } from './staff-guard.js';
import { failure, success, type ApiRequest } from './http.js';
import { ApiResult, object, text } from './api-result.js';
const select = {
  id: true,
  orderNo: true,
  status: true,
  paymentState: true,
  fulfillmentState: true,
  createdAt: true,
  items: {
    select: { skuId: true, name: true, spec: true, unit: true, quantity: true },
    orderBy: { skuId: 'asc' as const },
  },
} as const;
type Row = Prisma.ConsumerOrderGetPayload<{ select: typeof select }>;
const dto = (row: Row): PickingReadinessSummary => ({
  id: row.id,
  orderNo: row.orderNo,
  status: row.status,
  paymentState: row.paymentState,
  fulfillmentState: row.fulfillmentState,
  createdAt: row.createdAt.toISOString(),
  itemCount: row.items.length,
  totalQuantity: row.items.reduce((n, i) => n + i.quantity, 0),
});
export class PickingReadinessService {
  constructor(readonly catalog: CatalogService) {}
  async list(r: ApiRequest, w: string, q?: string, cursor?: string) {
    return this.catalog.db.$transaction(
      async (tx) => {
        await this.catalog.warehouse(tx, r, w);
        const where = { warehouseId: w, ...(q ? { orderNo: { startsWith: q } } : {}) };
        const anchor = cursor
          ? await tx.consumerOrder.findFirst({
              where: { ...where, id: cursor },
              select: { createdAt: true, id: true },
            })
          : null;
        if (cursor && !anchor)
          throw failure(404, 'PICKING_CURSOR_INVALID', '分页位置已失效，请重新读取');
        const rows = await tx.consumerOrder.findMany({
          where: {
            ...where,
            ...(anchor
              ? {
                  OR: [
                    { createdAt: { lt: anchor.createdAt } },
                    { createdAt: anchor.createdAt, id: { lt: anchor.id } },
                  ],
                }
              : {}),
          },
          select,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 21,
        });
        return {
          items: rows.slice(0, 20).map(dto),
          hasMore: rows.length > 20,
          nextCursor: rows.length > 20 ? rows[19]!.id : null,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async detail(r: ApiRequest, w: string, id: string): Promise<PickingReadinessDetail> {
    return this.catalog.db.$transaction(
      async (tx) => {
        await this.catalog.warehouse(tx, r, w);
        const clocks = await tx.$queryRaw<{ at: Date }[]>`SELECT statement_timestamp() AS at`;
        const at = clocks[0]!.at;
        const row = await tx.consumerOrder.findFirst({
          where: { id, warehouseId: w },
          select: {
            ...select,
            allocations: {
              select: {
                id: true,
                skuId: true,
                quantity: true,
                releaseLedgerId: true,
                position: {
                  select: {
                    id: true,
                    lotId: true,
                    onHand: true,
                    reserved: true,
                    blocked: true,
                    location: { select: { code: true, name: true, enabled: true } },
                    lot: {
                      select: {
                        batchNo: true,
                        expiresAt: true,
                        onHand: true,
                        reserved: true,
                        blocked: true,
                      },
                    },
                  },
                },
              },
              orderBy: [{ skuId: 'asc' }, { lotId: 'asc' }, { positionId: 'asc' }],
            },
          },
        });
        if (!row) throw failure(404, 'ORDER_NOT_FOUND', '未找到该仓库订单');
        const balances = await tx.stockBalance.findMany({
          where: { warehouseId: w, skuId: { in: row.items.map((i) => i.skuId) } },
          select: { skuId: true, reserved: true, inventoryHold: true },
        });
        const blockers: string[] = ['READ_ONLY_PHASE'];
        if (row.status === 'CANCELED') blockers.push('ORDER_CANCELED');
        else if (row.status !== 'ACTIVE') blockers.push('ORDER_NOT_ACTIVE');
        if (row.paymentState !== 'SUCCESS') blockers.push('PAYMENT_UNCONFIRMED');
        if (row.fulfillmentState !== 'READY_TO_PICK') blockers.push('FULFILLMENT_NOT_READY');
        const lotTotals = new Map<string, number>();
        for (const a of row.allocations)
          if (!a.releaseLedgerId)
            lotTotals.set(a.position.lotId, (lotTotals.get(a.position.lotId) ?? 0) + a.quantity);
        const items = row.items.map((i) => {
          const balance = balances.find((b) => b.skuId === i.skuId);
          const allocations = row.allocations
            .filter((a) => a.skuId === i.skuId)
            .map((a) => {
              const p = a.position,
                issues: string[] = [];
              if (a.releaseLedgerId) issues.push('RESERVATION_RELEASED');
              else {
                if (!p.location.enabled) issues.push('LOCATION_DISABLED');
                if (p.lot.expiresAt && p.lot.expiresAt <= at) issues.push('LOT_EXPIRED');
                if (balance?.inventoryHold) issues.push('STOCK_FROZEN');
                if (
                  p.reserved < a.quantity ||
                  p.onHand - p.blocked < p.reserved ||
                  p.lot.reserved < (lotTotals.get(p.lotId) ?? 0) ||
                  p.lot.onHand - p.lot.blocked < p.lot.reserved
                )
                  issues.push('RESERVATION_MISMATCH');
              }
              return {
                id: a.id,
                quantity: a.quantity,
                batchNo: p.lot.batchNo,
                expiresAt: p.lot.expiresAt?.toISOString() ?? null,
                locationCode: p.location.code,
                locationName: p.location.name,
                released: !!a.releaseLedgerId,
                issues,
              };
            });
          const activeReserved = allocations
            .filter((a) => !a.released)
            .reduce((n, a) => n + a.quantity, 0);
          if (activeReserved !== i.quantity || !balance || balance.reserved < activeReserved)
            blockers.push('RESERVATION_MISMATCH');
          for (const a of allocations) blockers.push(...a.issues);
          return { ...i, activeReserved, allocations };
        });
        return {
          ...dto(row),
          checkedAt: at.toISOString(),
          claimEnabled: false,
          blockers: [...new Set(blockers)],
          items,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
const summary = object({
  id: text,
  orderNo: text,
  status: text,
  paymentState: text,
  fulfillmentState: text,
  createdAt: text,
  itemCount: { type: 'integer' },
  totalQuantity: { type: 'integer' },
});
@ApiTags('拣货资格只读核验')
@ApiCookieAuth('staffSession')
@Permissions('picking.read')
@Controller('warehouse/picking-readiness')
export class PickingReadinessController {
  constructor(@Inject(PickingReadinessService) readonly service: PickingReadinessService) {}
  @Get()
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiQuery({
    name: 'q',
    required: false,
    type: String,
    description: '订单号前缀，1–40位英文字母或数字',
  })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiResult(
    object({
      items: { type: 'array', maxItems: 20, items: summary },
      hasMore: { type: 'boolean' },
      nextCursor: { ...text, nullable: true },
    }),
    [400, 401, 403, 404, 500],
  )
  async list(@Req() r: ApiRequest, @Query() q: unknown) {
    const b = fields(q, ['warehouseId', 'q', 'cursor']),
      search = b.q === undefined ? undefined : str(b.q, 40).toUpperCase();
    if (search && !/^[A-Z0-9]+$/.test(search))
      throw failure(400, 'VALIDATION_ERROR', '请输入订单号前缀');
    return success(
      r,
      await this.service.list(
        r,
        uuid(b.warehouseId),
        search,
        b.cursor === undefined ? undefined : uuid(b.cursor),
      ),
    );
  }
  @Get(':id')
  @ApiParam({ name: 'id', type: String })
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiResult(
    object({
      ...summary.properties,
      checkedAt: text,
      claimEnabled: { type: 'boolean', enum: [false] },
      blockers: { type: 'array', items: text },
      items: {
        type: 'array',
        maxItems: 50,
        items: object({
          skuId: text,
          name: text,
          spec: text,
          unit: text,
          quantity: { type: 'integer' },
          activeReserved: { type: 'integer' },
          allocations: {
            type: 'array',
            items: object({
              id: text,
              quantity: { type: 'integer' },
              batchNo: text,
              expiresAt: { ...text, nullable: true },
              locationCode: text,
              locationName: text,
              released: { type: 'boolean' },
              issues: { type: 'array', items: text },
            }),
          },
        }),
      },
    }),
    [400, 401, 403, 404, 500],
  )
  async detail(@Req() r: ApiRequest, @Query() q: unknown, @Param('id') id: string) {
    const b = fields(q, ['warehouseId']);
    return success(r, await this.service.detail(r, uuid(b.warehouseId), uuid(id)));
  }
}
