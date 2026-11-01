import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@yumi/database';
import type { AdminOrderSummary, AdminOrderDetail } from '@yumi/contracts';
import { CatalogService } from './catalog-service.js';
import { fields, str, uuid } from './catalog-input.js';
import { Permissions } from './staff-guard.js';
import { failure, success } from './http.js';
import type { ApiRequest } from './http.js';
import { ApiResult, object, text } from './api-result.js';
const itemSelect = {
  skuId: true,
  name: true,
  spec: true,
  unit: true,
  quantity: true,
  priceCents: true,
  lineCents: true,
} as const;
// Contact ciphertext, user identifiers, intent keys and request payloads are deliberately never selected.
const summarySelect = {
  id: true,
  orderNo: true,
  status: true,
  paymentState: true,
  fulfillmentState: true,
  goodsCents: true,
  deliveryFeeCents: true,
  payableCents: true,
  createdAt: true,
  paymentDeadline: true,
  cancelReason: true,
  items: { select: itemSelect, orderBy: { skuId: 'asc' } },
} as const;
type Summary = Prisma.ConsumerOrderGetPayload<{ select: typeof summarySelect }>;
function dto(row: Summary): AdminOrderSummary {
  return {
    id: row.id,
    orderNo: row.orderNo,
    cancelReason: row.cancelReason,
    status: row.status as AdminOrderSummary['status'],
    paymentState: row.paymentState as AdminOrderSummary['paymentState'],
    fulfillmentState: row.fulfillmentState as AdminOrderSummary['fulfillmentState'],
    goodsCents: Number(row.goodsCents),
    deliveryFeeCents: Number(row.deliveryFeeCents),
    payableCents: Number(row.payableCents),
    createdAt: row.createdAt.toISOString(),
    paymentDeadline: row.paymentDeadline.toISOString(),
    items: row.items.map((i) => ({
      ...i,
      priceCents: Number(i.priceCents),
      lineCents: Number(i.lineCents),
    })),
  };
}
export class AdminOrderService {
  constructor(readonly catalog: CatalogService) {}
  async list(
    request: ApiRequest,
    warehouseId: string,
    status?: string,
    q?: string,
    cursor?: string,
  ) {
    return this.catalog.db.$transaction(
      async (tx) => {
        await this.catalog.warehouse(tx, request, warehouseId);
        const where: Prisma.ConsumerOrderWhereInput = {
          warehouseId,
          ...(status ? { status } : {}),
          ...(q ? { orderNo: { startsWith: q } } : {}),
        };
        const anchor = cursor
          ? await tx.consumerOrder.findFirst({
              where: { ...where, id: cursor },
              select: { id: true, createdAt: true },
            })
          : null;
        if (cursor && !anchor)
          throw failure(404, 'ORDER_CURSOR_INVALID', '分页位置已失效，请重新查询');
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
          select: summarySelect,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 21,
        });
        const hasMore = rows.length > 20,
          visible = rows.slice(0, 20);
        return {
          items: visible.map(dto),
          hasMore,
          nextCursor: hasMore ? visible.at(-1)!.id : null,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async read(request: ApiRequest, warehouseId: string, id: string): Promise<AdminOrderDetail> {
    return this.catalog.db.$transaction(
      async (tx) => {
        await this.catalog.warehouse(tx, request, warehouseId);
        const row = await tx.consumerOrder.findFirst({
          where: { id, warehouseId },
          select: {
            ...summarySelect,
            allocations: {
              orderBy: [{ skuId: 'asc' }, { lotId: 'asc' }, { positionId: 'asc' }],
              select: {
                id: true,
                skuId: true,
                quantity: true,
                position: {
                  select: {
                    lot: { select: { batchNo: true, expiresAt: true } },
                    location: { select: { code: true, name: true } },
                  },
                },
                reserveLedger: { select: { createdAt: true } },
                releaseLedger: { select: { createdAt: true } },
              },
            },
            events: {
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              select: { type: true, actorKind: true, createdAt: true },
            },
          },
        });
        if (!row) throw failure(404, 'ORDER_NOT_FOUND', '未找到该仓库订单');
        return {
          ...dto(row),
          allocations: row.allocations.map((a) => ({
            id: a.id,
            skuId: a.skuId,
            quantity: a.quantity,
            batchNo: a.position.lot.batchNo,
            expiresAt: a.position.lot.expiresAt?.toISOString() ?? null,
            locationCode: a.position.location.code,
            locationName: a.position.location.name,
            reservedAt: a.reserveLedger.createdAt.toISOString(),
            releasedAt: a.releaseLedger?.createdAt.toISOString() ?? null,
          })),
          events: row.events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
const idSchema = { type: 'string' as const, format: 'uuid' },
  date = { type: 'string' as const, format: 'date-time' },
  money = { type: 'integer' as const, minimum: 0 };
const summary = object({
  id: idSchema,
  orderNo: text,
  status: { type: 'string', enum: ['AWAITING_PAYMENT', 'CANCELED'] },
  paymentState: { type: 'string', enum: ['NOT_STARTED'] },
  fulfillmentState: { type: 'string', enum: ['NOT_READY'] },
  goodsCents: money,
  deliveryFeeCents: money,
  payableCents: money,
  createdAt: date,
  paymentDeadline: date,
  cancelReason: { ...text, nullable: true },
  items: {
    type: 'array',
    maxItems: 50,
    items: object({
      skuId: idSchema,
      name: text,
      spec: text,
      unit: text,
      quantity: { type: 'integer', minimum: 1, maximum: 200 },
      priceCents: money,
      lineCents: money,
    }),
  },
});
@ApiTags('后台订单只读查询')
@ApiCookieAuth('staffSession')
@Permissions('order.read')
@Controller('admin/orders')
export class AdminOrderController {
  constructor(@Inject(AdminOrderService) private readonly service: AdminOrderService) {}
  @Get()
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiQuery({ name: 'status', required: false, enum: ['AWAITING_PAYMENT', 'CANCELED'] })
  @ApiQuery({
    name: 'q',
    required: false,
    type: String,
    description: '订单号前缀，1–40个英文字母或数字',
  })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiResult(
    object({
      items: { type: 'array', maxItems: 20, items: summary },
      hasMore: { type: 'boolean' },
      nextCursor: { ...idSchema, nullable: true },
    }),
    [400, 401, 403, 404, 500],
  )
  async list(@Req() r: ApiRequest, @Query() query: unknown) {
    const b = fields(query, ['warehouseId', 'status', 'q', 'cursor']),
      warehouseId = uuid(b.warehouseId);
    const status = b.status === undefined ? undefined : str(b.status, 24);
    if (status && !['AWAITING_PAYMENT', 'CANCELED'].includes(status))
      throw failure(400, 'VALIDATION_ERROR', '订单状态无效');
    const q = b.q === undefined ? undefined : str(b.q, 40).toUpperCase();
    if (q && !/^[A-Z0-9]+$/.test(q)) throw failure(400, 'VALIDATION_ERROR', '请输入订单号前缀');
    return success(
      r,
      await this.service.list(
        r,
        warehouseId,
        status,
        q,
        b.cursor === undefined ? undefined : uuid(b.cursor),
      ),
    );
  }
  @Get(':id')
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiResult(
    object({
      ...summary.properties,
      allocations: {
        type: 'array',
        maxItems: 200,
        items: object({
          id: idSchema,
          skuId: idSchema,
          quantity: { type: 'integer', minimum: 1 },
          batchNo: text,
          expiresAt: { ...date, nullable: true },
          locationCode: text,
          locationName: text,
          reservedAt: date,
          releasedAt: { ...date, nullable: true },
        }),
      },
      events: {
        type: 'array',
        maxItems: 2,
        items: object({
          type: { type: 'string', enum: ['ORDER_CREATED', 'ORDER_CANCELED'] },
          actorKind: { type: 'string', enum: ['CONSUMER', 'SYSTEM'] },
          createdAt: date,
        }),
      },
    }),
    [400, 401, 403, 404, 500],
  )
  async read(@Req() r: ApiRequest, @Param('id') id: string, @Query() query: unknown) {
    const b = fields(query, ['warehouseId']);
    return success(r, await this.service.read(r, uuid(b.warehouseId), uuid(id)));
  }
}
