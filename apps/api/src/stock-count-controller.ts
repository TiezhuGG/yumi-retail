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
import { StockCountService } from './stock-count-service.js';
const int = { type: 'integer' as const, minimum: 0 };
const nullableText = { type: 'string' as const, nullable: true };
const lineSchema = object({
  id: text,
  countId: text,
  warehouseId: text,
  skuId: text,
  lotId: text,
  positionId: text,
  snapshotOnHand: int,
  snapshotReserved: int,
  snapshotBlocked: int,
  positionVersion: int,
  counted: { ...int, nullable: true },
});
const countSchema = object({
  id: text,
  warehouseId: text,
  skuId: text,
  status: text,
  version: int,
  reason: text,
  createdBy: text,
  reviewedBy: nullableText,
  reviewReason: nullableText,
  cancelReason: nullableText,
  createdAt: text,
  submittedAt: nullableText,
  reviewedAt: nullableText,
  postedAt: nullableText,
  cancelledAt: nullableText,
  lines: { type: 'array', items: lineSchema },
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
const reasonBody = object({ version: int, reason: text });
@ApiTags('实物盘点')
@ApiCookieAuth('staffSession')
@Controller('warehouse/warehouses/:warehouseId/stock-counts')
export class StockCountController {
  constructor(@Inject(StockCountService) readonly service: StockCountService) {}
  async scope(request: ApiRequest, id: string) {
    const w = uuid(id);
    await this.service.catalog.warehouse(this.service.db, request, w);
    return w;
  }
  @Get()
  @Permissions('stock.read')
  @ApiQuery({ name: 'skuId', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'limit', required: false })
  @ApiResult(
    object({
      items: { type: 'array', items: countSchema },
      hasMore: { type: 'boolean' },
      nextCursor: nullableText,
    }),
    errors,
  )
  async list(
    @Param('warehouseId') w: string,
    @Req() request: ApiRequest,
    @Query() q: Record<string, unknown>,
  ) {
    w = await this.scope(request, w);
    fields(q, ['skuId', 'cursor', 'limit']);
    const { limit, cursor } = page(q);
    const rows = await this.service.db.stockCount.findMany({
      where: {
        warehouseId: w,
        ...(q.skuId === undefined ? {} : { skuId: uuid(q.skuId) }),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      orderBy: { id: 'asc' },
      take: limit + 1,
      include: { lines: { orderBy: { id: 'asc' } } },
    });
    const items = rows.slice(0, limit);
    return success(request, {
      items,
      hasMore: rows.length > limit,
      nextCursor: rows.length > limit ? items.at(-1)!.id : null,
    });
  }
  @Get(':countId')
  @Permissions('stock.read')
  @ApiResult(countSchema, errors)
  async detail(
    @Param('warehouseId') w: string,
    @Param('countId') id: string,
    @Req() request: ApiRequest,
  ) {
    w = await this.scope(request, w);
    const row = await this.service.db.stockCount.findFirst({
      where: { id: uuid(id), warehouseId: w },
      include: { lines: { orderBy: { id: 'asc' } } },
    });
    if (!row) throw failure(404, 'RESOURCE_NOT_FOUND', '盘点单不存在');
    return success(request, row);
  }
  @Post()
  @HttpCode(200)
  @Permissions('count.write')
  @headers()
  @ApiBody({ schema: object({ skuId: text, version: int, reason: text }) })
  @ApiResult(countSchema, errors)
  async start(@Param('warehouseId') w: string, @Req() request: ApiRequest, @Body() body: unknown) {
    w = await this.scope(request, w);
    const b = fields(body, ['skuId', 'version', 'reason']);
    return success(
      request,
      await this.service.start(request, key(request), w, {
        skuId: uuid(b.skuId),
        version: integer(b.version, 0, 2147483646),
        reason: str(b.reason, 200),
      }),
    );
  }
  @Post(':countId/submit')
  @HttpCode(200)
  @Permissions('count.write')
  @headers()
  @ApiBody({
    schema: object({
      version: int,
      lines: {
        type: 'array',
        minItems: 1,
        maxItems: 200,
        items: object({ positionId: text, counted: { ...int, maximum: 1000000000 } }),
      },
    }),
  })
  @ApiResult(countSchema, errors)
  async submit(
    @Param('warehouseId') w: string,
    @Param('countId') id: string,
    @Req() request: ApiRequest,
    @Body() body: unknown,
  ) {
    w = await this.scope(request, w);
    const b = fields(body, ['version', 'lines']);
    if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 200)
      throw failure(400, 'VALIDATION_ERROR', '须提交1至200个位置');
    const lines = b.lines
      .map((v) => {
        const l = fields(v, ['positionId', 'counted']);
        return { positionId: uuid(l.positionId), counted: integer(l.counted, 0, 1000000000) };
      })
      .sort((a, b) => a.positionId.localeCompare(b.positionId));
    if (new Set(lines.map((l) => l.positionId)).size !== lines.length)
      throw failure(400, 'VALIDATION_ERROR', '位置重复');
    return success(
      request,
      await this.service.action(request, key(request), w, uuid(id), 'submit', {
        version: integer(b.version, 0, 2147483646),
        lines,
      }),
    );
  }
  @Post(':countId/approve')
  @HttpCode(200)
  @Permissions('count.approve')
  @headers()
  @ApiBody({ schema: reasonBody })
  @ApiResult(countSchema, errors)
  async approve(
    @Param('warehouseId') w: string,
    @Param('countId') id: string,
    @Req() request: ApiRequest,
    @Body() body: unknown,
  ) {
    return this.reasonAction(request, w, id, 'approve', body);
  }
  @Post(':countId/post')
  @HttpCode(200)
  @Permissions('count.post')
  @headers()
  @ApiBody({ schema: object({ version: int }) })
  @ApiResult(countSchema, errors)
  async post(
    @Param('warehouseId') w: string,
    @Param('countId') id: string,
    @Req() request: ApiRequest,
    @Body() body: unknown,
  ) {
    w = await this.scope(request, w);
    const b = fields(body, ['version']);
    return success(
      request,
      await this.service.action(request, key(request), w, uuid(id), 'post', {
        version: integer(b.version, 0, 2147483646),
      }),
    );
  }
  @Post(':countId/cancel')
  @HttpCode(200)
  @Permissions('count.write')
  @headers()
  @ApiBody({ schema: reasonBody })
  @ApiResult(countSchema, errors)
  async cancel(
    @Param('warehouseId') w: string,
    @Param('countId') id: string,
    @Req() request: ApiRequest,
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
}
