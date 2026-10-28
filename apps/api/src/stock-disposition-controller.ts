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
import { StockDispositionService } from './stock-disposition-service.js';
const int = { type: 'integer' as const, minimum: 0 },
  nullableText = { type: 'string' as const, nullable: true },
  quantity = { type: 'integer' as const, minimum: 1, maximum: 100000 };
const isolationSchema = object({
  id: text,
  warehouseId: text,
  skuId: text,
  lotId: text,
  positionId: text,
  quantity,
  remaining: int,
  version: int,
  reason: text,
  createdBy: text,
  createdAt: text,
  stockLedgerId: text,
});
const dispositionSchema = object({
  id: text,
  warehouseId: text,
  skuId: text,
  lotId: text,
  positionId: text,
  isolationId: text,
  kind: { type: 'string', enum: ['RELEASE', 'DAMAGE'] },
  quantity,
  positionVersion: int,
  isolationVersion: int,
  status: { type: 'string', enum: ['DRAFT', 'APPROVED', 'POSTED', 'CANCELLED'] },
  version: int,
  reason: text,
  reviewReason: nullableText,
  cancelReason: nullableText,
  physicalEvidence: nullableText,
  createdBy: text,
  reviewedBy: nullableText,
  createdAt: text,
  reviewedAt: nullableText,
  postedAt: nullableText,
  cancelledAt: nullableText,
  stockLedgerId: nullableText,
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
const paging = () =>
  applyDecorators(
    ApiQuery({ name: 'skuId', required: false }),
    ApiQuery({ name: 'cursor', required: false }),
    ApiQuery({ name: 'limit', required: false }),
  );
const reasonBody = object({ version: int, reason: text });
function resultPage<T extends { id: string }>(rows: T[], limit: number) {
  const items = rows.slice(0, limit);
  return {
    items,
    hasMore: rows.length > limit,
    nextCursor: rows.length > limit ? items.at(-1)!.id : null,
  };
}
const paged = (item: typeof isolationSchema) =>
  object({
    items: { type: 'array', items: item },
    hasMore: { type: 'boolean' },
    nextCursor: nullableText,
  });
@ApiTags('库存隔离与报损')
@ApiCookieAuth('staffSession')
@Controller('warehouse/warehouses/:warehouseId')
export class StockDispositionController {
  constructor(@Inject(StockDispositionService) readonly service: StockDispositionService) {}
  async scope(request: ApiRequest, id: string) {
    const w = uuid(id);
    await this.service.catalog.warehouse(this.service.db, request, w);
    return w;
  }
  @Get('stock-isolations')
  @Permissions('stock.read')
  @paging()
  @ApiResult(paged(isolationSchema), errors)
  async isolations(
    @Param('warehouseId') w: string,
    @Req() request: ApiRequest,
    @Query() q: Record<string, unknown>,
  ) {
    w = await this.scope(request, w);
    fields(q, ['skuId', 'cursor', 'limit']);
    const { limit, cursor } = page(q);
    const rows = await this.service.db.stockIsolation.findMany({
      where: {
        warehouseId: w,
        ...(q.skuId === undefined ? {} : { skuId: uuid(q.skuId) }),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      take: limit + 1,
      orderBy: { id: 'asc' },
    });
    return success(request, resultPage(rows, limit));
  }
  @Get('stock-isolations/:isolationId')
  @Permissions('stock.read')
  @ApiResult(isolationSchema, errors)
  async isolation(
    @Param('warehouseId') w: string,
    @Param('isolationId') id: string,
    @Req() request: ApiRequest,
  ) {
    w = await this.scope(request, w);
    const row = await this.service.db.stockIsolation.findFirst({
      where: { warehouseId: w, id: uuid(id) },
    });
    if (!row) throw failure(404, 'RESOURCE_NOT_FOUND', '隔离记录不存在');
    return success(request, row);
  }
  @Post('stock-isolations')
  @HttpCode(200)
  @Permissions('stock.isolate')
  @headers()
  @ApiBody({ schema: object({ positionId: text, quantity, version: int, reason: text }) })
  @ApiResult(isolationSchema, errors)
  async isolate(
    @Param('warehouseId') w: string,
    @Req() request: ApiRequest,
    @Body() body: unknown,
  ) {
    w = await this.scope(request, w);
    const b = fields(body, ['positionId', 'quantity', 'version', 'reason']);
    return success(
      request,
      await this.service.isolate(request, key(request), w, {
        positionId: uuid(b.positionId),
        quantity: integer(b.quantity, 1, 100000),
        version: integer(b.version, 0, 2147483646),
        reason: str(b.reason, 200),
      }),
    );
  }
  @Get('stock-dispositions')
  @Permissions('stock.read')
  @paging()
  @ApiQuery({ name: 'isolationId', required: false })
  @ApiResult(paged(dispositionSchema), errors)
  async dispositions(
    @Param('warehouseId') w: string,
    @Req() request: ApiRequest,
    @Query() q: Record<string, unknown>,
  ) {
    w = await this.scope(request, w);
    fields(q, ['skuId', 'isolationId', 'cursor', 'limit']);
    const { limit, cursor } = page(q);
    const rows = await this.service.db.stockDisposition.findMany({
      where: {
        warehouseId: w,
        ...(q.skuId === undefined ? {} : { skuId: uuid(q.skuId) }),
        ...(q.isolationId === undefined ? {} : { isolationId: uuid(q.isolationId) }),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      take: limit + 1,
      orderBy: { id: 'asc' },
    });
    return success(request, resultPage(rows, limit));
  }
  @Get('stock-dispositions/:dispositionId')
  @Permissions('stock.read')
  @ApiResult(dispositionSchema, errors)
  async detail(
    @Param('warehouseId') w: string,
    @Param('dispositionId') id: string,
    @Req() request: ApiRequest,
  ) {
    w = await this.scope(request, w);
    const row = await this.service.db.stockDisposition.findFirst({
      where: { warehouseId: w, id: uuid(id) },
    });
    if (!row) throw failure(404, 'RESOURCE_NOT_FOUND', '处置单不存在');
    return success(request, row);
  }
  @Post('stock-dispositions')
  @HttpCode(200)
  @Permissions('disposition.write')
  @headers()
  @ApiBody({
    schema: object({
      isolationId: text,
      kind: { type: 'string', enum: ['RELEASE', 'DAMAGE'] },
      quantity,
      positionVersion: int,
      isolationVersion: int,
      reason: text,
    }),
  })
  @ApiResult(dispositionSchema, errors)
  async create(@Param('warehouseId') w: string, @Req() request: ApiRequest, @Body() body: unknown) {
    w = await this.scope(request, w);
    const b = fields(body, [
      'isolationId',
      'kind',
      'quantity',
      'positionVersion',
      'isolationVersion',
      'reason',
    ]);
    if (b.kind !== 'RELEASE' && b.kind !== 'DAMAGE')
      throw failure(400, 'VALIDATION_ERROR', '处置类型无效');
    return success(
      request,
      await this.service.create(request, key(request), w, {
        isolationId: uuid(b.isolationId),
        kind: b.kind,
        quantity: integer(b.quantity, 1, 100000),
        positionVersion: integer(b.positionVersion, 0, 2147483646),
        isolationVersion: integer(b.isolationVersion, 0, 2147483646),
        reason: str(b.reason, 200),
      }),
    );
  }
  @Post('stock-dispositions/:dispositionId/approve')
  @HttpCode(200)
  @Permissions('disposition.approve')
  @headers()
  @ApiBody({ schema: reasonBody })
  @ApiResult(dispositionSchema, errors)
  async approve(
    @Param('warehouseId') w: string,
    @Param('dispositionId') id: string,
    @Req() request: ApiRequest,
    @Body() body: unknown,
  ) {
    return this.reasonAction(request, w, id, 'approve', body);
  }
  @Post('stock-dispositions/:dispositionId/cancel')
  @HttpCode(200)
  @Permissions('disposition.write')
  @headers()
  @ApiBody({ schema: reasonBody })
  @ApiResult(dispositionSchema, errors)
  async cancel(
    @Param('warehouseId') w: string,
    @Param('dispositionId') id: string,
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
  @Post('stock-dispositions/:dispositionId/post')
  @HttpCode(200)
  @Permissions('disposition.post')
  @headers()
  @ApiBody({
    schema: object(
      { version: int, physicalConfirmed: { type: 'boolean' }, physicalEvidence: text },
      ['version'],
    ),
  })
  @ApiResult(dispositionSchema, errors)
  async post(
    @Param('warehouseId') w: string,
    @Param('dispositionId') id: string,
    @Req() request: ApiRequest,
    @Body() body: unknown,
  ) {
    w = await this.scope(request, w);
    const b = fields(body, ['version', 'physicalConfirmed', 'physicalEvidence']);
    if (b.physicalConfirmed !== undefined && typeof b.physicalConfirmed !== 'boolean')
      throw failure(400, 'VALIDATION_ERROR', '实物确认须为布尔值');
    return success(
      request,
      await this.service.action(request, key(request), w, uuid(id), 'post', {
        version: integer(b.version, 0, 2147483646),
        ...(b.physicalConfirmed === undefined ? {} : { physicalConfirmed: b.physicalConfirmed }),
        ...(b.physicalEvidence === undefined
          ? {}
          : { physicalEvidence: str(b.physicalEvidence, 200) }),
      }),
    );
  }
}
