import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  applyDecorators,
} from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import { ApiResult, object, text } from './api-result.js';
import { fields, integer, key, page, str, uuid } from './catalog-input.js';
import { Permissions } from './staff-guard.js';
import { failure, success } from './http.js';
import type { ApiRequest } from './http.js';
import { ReceiptReversalService } from './receipt-reversal-service.js';
const int = { type: 'integer' as const, minimum: 0 },
  nullable = { type: 'string' as const, nullable: true };
const schema = object({
  id: text,
  warehouseId: text,
  skuId: text,
  lotId: text,
  positionId: text,
  quantity: int,
  positionVersion: int,
  status: { type: 'string', enum: ['DRAFT', 'APPROVED', 'POSTED', 'CANCELLED'] },
  version: int,
  reason: text,
  reviewReason: nullable,
  cancelReason: nullable,
  physicalEvidence: nullable,
  createdBy: text,
  reviewedBy: nullable,
  createdAt: text,
  reviewedAt: nullable,
  postedAt: nullable,
  cancelledAt: nullable,
  stockLedgerId: nullable,
});
const errors = [400, 401, 403, 404, 409, 503, 500];
const headers = () =>
  applyDecorators(
    ApiHeader({
      name: 'Idempotency-Key',
      required: true,
      schema: { type: 'string', format: 'uuid' },
    }),
    ApiHeader({ name: 'Origin', required: true }),
    ApiHeader({ name: 'X-CSRF-Token', required: true }),
  );
@ApiTags('收货逆向纠错')
@ApiCookieAuth('staffSession')
@Controller('warehouse/warehouses/:warehouseId')
export class ReceiptReversalController {
  constructor(@Inject(ReceiptReversalService) readonly service: ReceiptReversalService) {}
  async scope(request: ApiRequest, w: string) {
    w = uuid(w);
    await this.service.catalog.warehouse(this.service.db, request, w);
    return w;
  }
  @Get('receipt-reversal-sources/:positionId')
  @Permissions('stock.read')
  @ApiResult(
    object({
      receiptId: text,
      receiptLineId: text,
      sourceRef: text,
      batchNo: text,
      originalQuantity: int,
      reversedQuantity: int,
      remaining: int,
      positionId: text,
      positionVersion: int,
      freeQuantity: int,
    }),
    errors,
  )
  async source(
    @Req() request: ApiRequest,
    @Param('warehouseId') w: string,
    @Param('positionId') id: string,
  ) {
    w = await this.scope(request, w);
    id = uuid(id);
    const result = await this.service.db.$transaction(
      async (tx) => {
        const p = await this.service.position(tx, w, id);
        return {
          ...(await this.service.source(tx, w, p.lotId)),
          positionId: p.id,
          positionVersion: p.version,
          freeQuantity: p.onHand - p.reserved - p.blocked,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
    return success(request, result);
  }
  @Get('receipt-reversals')
  @Permissions('stock.read')
  @ApiQuery({ name: 'skuId', required: false })
  @ApiQuery({ name: 'lotId', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiResult(
    object({
      items: { type: 'array', items: schema },
      hasMore: { type: 'boolean' },
      nextCursor: nullable,
    }),
    errors,
  )
  async list(
    @Req() request: ApiRequest,
    @Param('warehouseId') w: string,
    @Query() query: Record<string, unknown>,
  ) {
    w = await this.scope(request, w);
    fields(query, ['skuId', 'lotId', 'cursor', 'limit']);
    const { limit, cursor } = page(query);
    const rows = await this.service.db.receiptReversal.findMany({
      where: {
        warehouseId: w,
        ...(query.skuId === undefined ? {} : { skuId: uuid(query.skuId) }),
        ...(query.lotId === undefined ? {} : { lotId: uuid(query.lotId) }),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      take: limit + 1,
      orderBy: { id: 'asc' },
    });
    const items = rows.slice(0, limit);
    return success(request, {
      items,
      hasMore: rows.length > limit,
      nextCursor: rows.length > limit ? items.at(-1)!.id : null,
    });
  }
  @Get('receipt-reversals/:id')
  @Permissions('stock.read')
  @ApiResult(schema, errors)
  async detail(
    @Req() request: ApiRequest,
    @Param('warehouseId') w: string,
    @Param('id') id: string,
  ) {
    w = await this.scope(request, w);
    const row = await this.service.db.receiptReversal.findFirst({
      where: { warehouseId: w, id: uuid(id) },
    });
    if (!row) throw failure(404, 'RESOURCE_NOT_FOUND', '逆向单不存在');
    return success(request, row);
  }
  @Post('receipt-reversals')
  @HttpCode(200)
  @Permissions('reversal.write')
  @headers()
  @ApiBody({
    schema: object({
      positionId: text,
      quantity: { type: 'integer', minimum: 1, maximum: 100000 },
      positionVersion: int,
      reason: text,
    }),
  })
  @ApiResult(schema, errors)
  async create(@Req() request: ApiRequest, @Param('warehouseId') w: string, @Body() body: unknown) {
    w = await this.scope(request, w);
    const b = fields(body, ['positionId', 'quantity', 'positionVersion', 'reason']);
    return success(
      request,
      await this.service.create(request, key(request), w, {
        positionId: uuid(b.positionId),
        quantity: integer(b.quantity, 1, 100000),
        positionVersion: integer(b.positionVersion, 0, 2147483646),
        reason: str(b.reason, 200),
      }),
    );
  }
  @Post('receipt-reversals/:id/approve')
  @HttpCode(200)
  @Permissions('reversal.approve')
  @headers()
  @ApiBody({ schema: object({ version: int, reason: text }) })
  @ApiResult(schema, errors)
  async approve(
    @Req() request: ApiRequest,
    @Param('warehouseId') w: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.reasonAction(request, w, id, 'approve', body);
  }
  @Post('receipt-reversals/:id/cancel')
  @HttpCode(200)
  @Permissions('reversal.write')
  @headers()
  @ApiBody({ schema: object({ version: int, reason: text }) })
  @ApiResult(schema, errors)
  async cancel(
    @Req() request: ApiRequest,
    @Param('warehouseId') w: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.reasonAction(request, w, id, 'cancel', body);
  }
  async reasonAction(
    request: ApiRequest,
    w: string,
    id: string,
    action: 'approve' | 'cancel',
    body: unknown,
  ) {
    w = await this.scope(request, w);
    const b = fields(body, ['version', 'reason']);
    return success(
      request,
      await this.service.action(request, key(request), w, uuid(id), action, {
        version: integer(b.version, 0, 2147483646),
        reason: str(b.reason, 200),
      }),
    );
  }
  @Post('receipt-reversals/:id/post')
  @HttpCode(200)
  @Permissions('reversal.post')
  @headers()
  @ApiBody({
    schema: object({
      version: int,
      physicalConfirmed: { type: 'boolean' },
      physicalEvidence: text,
    }),
  })
  @ApiResult(schema, errors)
  async post(
    @Req() request: ApiRequest,
    @Param('warehouseId') w: string,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    w = await this.scope(request, w);
    const b = fields(body, ['version', 'physicalConfirmed', 'physicalEvidence']);
    if (b.physicalConfirmed !== true)
      throw failure(400, 'PHYSICAL_CONFIRMATION_REQUIRED', '须明确确认原记录和实物核验');
    return success(
      request,
      await this.service.action(request, key(request), w, uuid(id), 'post', {
        version: integer(b.version, 0, 2147483646),
        physicalConfirmed: true,
        physicalEvidence: str(b.physicalEvidence, 200),
      }),
    );
  }
}
