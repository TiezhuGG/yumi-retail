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
import {
  ApiBody,
  ApiCookieAuth,
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger';
import { ApiResult, object, text } from './api-result.js';
import { InventoryService } from './inventory-service.js';
import { fields, integer, key, page, str, uuid, version } from './catalog-input.js';
import { Permissions } from './staff-guard.js';
import { failure, success } from './http.js';
import type { ApiRequest } from './http.js';
const int: SchemaObject = { type: 'integer', minimum: 0 };
const bool: SchemaObject = { type: 'boolean' };
const date: SchemaObject = { type: 'string', format: 'date-time' };
const nullableDate: SchemaObject = { ...date, nullable: true };
const locationSchema = object({
  id: text,
  warehouseId: text,
  code: text,
  name: text,
  enabled: bool,
  version: int,
});
const positionSchema = object({
  id: text,
  warehouseId: text,
  skuId: text,
  lotId: text,
  locationId: text,
  onHand: int,
  reserved: int,
  blocked: int,
  version: int,
  locationCode: text,
  locationName: text,
  locationEnabled: bool,
  batchNo: text,
  producedAt: nullableDate,
  expiresAt: nullableDate,
  receivedAt: date,
  expired: bool,
  name: text,
  spec: text,
  skuCode: text,
});
const transferSchema = object({
  id: text,
  warehouseId: text,
  skuId: text,
  lotId: text,
  sourcePositionId: text,
  targetPositionId: text,
  quantity: int,
  reason: text,
  stockLedgerId: text,
  createdAt: date,
});
const qty = object({ onHand: text, reserved: text, blocked: text });
const checkSchema = object({
  id: text,
  warehouseId: text,
  skuId: text,
  actorId: text,
  status: text,
  issueCount: int,
  issues: {
    type: 'array',
    items: object({ kind: text, resourceId: text, expected: qty, actual: qty }),
  },
  createdAt: date,
});
const paged = (schema: SchemaObject) =>
  object({
    items: { type: 'array', items: schema },
    hasMore: bool,
    nextCursor: { type: 'string', nullable: true },
  });
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
    ApiQuery({ name: 'cursor', required: false, type: String }),
    ApiQuery({ name: 'limit', required: false, type: Number }),
  );
const errors = [400, 401, 403, 404, 409, 503, 500];
function asPage<T extends { id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const items = rows.slice(0, limit);
  return { items, hasMore, nextCursor: hasMore ? items.at(-1)!.id : null };
}
@ApiTags('库位与库存核对')
@ApiCookieAuth('staffSession')
@Controller('warehouse/warehouses/:warehouseId')
export class InventoryController {
  constructor(@Inject(InventoryService) private readonly service: InventoryService) {}
  async scope(request: ApiRequest, id: string) {
    const warehouseId = uuid(id);
    await this.service.catalog.warehouse(this.service.db, request, warehouseId);
    return warehouseId;
  }
  @Get('locations')
  @Permissions('stock.read')
  @paging()
  @ApiResult(paged(locationSchema), errors)
  async locations(
    @Param('warehouseId') id: string,
    @Req() request: ApiRequest,
    @Query() query: Record<string, unknown>,
  ) {
    const warehouseId = await this.scope(request, id);
    fields(query, ['cursor', 'limit']);
    const { limit, cursor } = page(query);
    return success(
      request,
      asPage(
        await this.service.db.warehouseLocation.findMany({
          where: { warehouseId, ...(cursor ? { id: { gt: cursor } } : {}) },
          orderBy: { id: 'asc' },
          take: limit + 1,
        }),
        limit,
      ),
    );
  }
  @Post('locations')
  @HttpCode(200)
  @Permissions('location.write')
  @headers()
  @ApiBody({ schema: object({ code: text, name: text }) })
  @ApiResult(locationSchema, errors)
  async createLocation(
    @Param('warehouseId') id: string,
    @Req() request: ApiRequest,
    @Body() body: unknown,
  ) {
    const warehouseId = await this.scope(request, id);
    const b = fields(body, ['code', 'name']);
    const code = str(b.code, 32).toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{0,31}$/.test(code) || code === 'DEFAULT')
      throw failure(400, 'VALIDATION_ERROR', '请使用字母数字编码，DEFAULT为保留收货位');
    return success(
      request,
      await this.service.createLocation(request, key(request), warehouseId, {
        code,
        name: str(b.name, 80),
      }),
    );
  }
  @Post('locations/:locationId/disable')
  @HttpCode(200)
  @Permissions('location.write')
  @headers()
  @ApiBody({ schema: object({ version: int }) })
  @ApiResult(locationSchema, errors)
  async disable(
    @Param('warehouseId') id: string,
    @Param('locationId') locationId: string,
    @Req() request: ApiRequest,
    @Body() body: unknown,
  ) {
    return success(
      request,
      await this.service.locationAction(
        request,
        key(request),
        await this.scope(request, id),
        uuid(locationId),
        version(body),
        false,
      ),
    );
  }
  @Post('locations/:locationId/enable')
  @HttpCode(200)
  @Permissions('location.write')
  @headers()
  @ApiBody({ schema: object({ version: int }) })
  @ApiResult(locationSchema, errors)
  async enable(
    @Param('warehouseId') id: string,
    @Param('locationId') locationId: string,
    @Req() request: ApiRequest,
    @Body() body: unknown,
  ) {
    return success(
      request,
      await this.service.locationAction(
        request,
        key(request),
        await this.scope(request, id),
        uuid(locationId),
        version(body),
        true,
      ),
    );
  }
  @Get('positions')
  @Permissions('stock.read')
  @paging()
  @ApiQuery({ name: 'skuId', required: false, type: String })
  @ApiResult(paged(positionSchema), errors)
  async positions(
    @Param('warehouseId') id: string,
    @Req() request: ApiRequest,
    @Query() query: Record<string, unknown>,
  ) {
    const warehouseId = await this.scope(request, id);
    fields(query, ['cursor', 'limit', 'skuId']);
    const { limit, cursor } = page(query);
    const skuId = query.skuId === undefined ? undefined : uuid(query.skuId);
    const rows = await this.service.db.stockPosition.findMany({
      where: {
        warehouseId,
        ...(skuId ? { skuId } : {}),
        ...(cursor ? { id: { gt: cursor } } : {}),
      },
      take: limit + 1,
      orderBy: { id: 'asc' },
      include: {
        location: true,
        lot: {
          select: {
            batchNo: true,
            producedAt: true,
            expiresAt: true,
            receivedAt: true,
            receiptLine: {
              select: {
                sku: { select: { code: true, spec: true, product: { select: { name: true } } } },
              },
            },
          },
        },
      },
    });
    return success(
      request,
      asPage(
        rows.map(({ location, lot, ...row }) => ({
          ...row,
          locationCode: location.code,
          locationName: location.name,
          locationEnabled: location.enabled,
          batchNo: lot.batchNo,
          producedAt: lot.producedAt,
          expiresAt: lot.expiresAt,
          receivedAt: lot.receivedAt,
          expired: !!lot.expiresAt && lot.expiresAt.getTime() <= Date.now(),
          name: lot.receiptLine.sku.product.name,
          spec: lot.receiptLine.sku.spec,
          skuCode: lot.receiptLine.sku.code,
        })),
        limit,
      ),
    );
  }
  @Get('positions/:positionId/ledger')
  @Permissions('stock.read')
  @paging()
  @ApiResult(
    paged(
      object({
        id: text,
        positionId: text,
        stockLedgerId: text,
        deltaOnHand: { type: 'integer' },
        deltaReserved: { type: 'integer' },
        deltaBlocked: { type: 'integer' },
        createdAt: date,
        actionKey: text,
        requestId: text,
        reason: { type: 'string', nullable: true },
      }),
    ),
    errors,
  )
  async ledger(
    @Param('warehouseId') id: string,
    @Param('positionId') positionId: string,
    @Req() request: ApiRequest,
    @Query() query: Record<string, unknown>,
  ) {
    const warehouseId = await this.scope(request, id);
    positionId = uuid(positionId);
    fields(query, ['cursor', 'limit']);
    const { limit, cursor } = page(query);
    if (
      !(await this.service.db.stockPosition.findFirst({ where: { id: positionId, warehouseId } }))
    )
      throw failure(404, 'RESOURCE_NOT_FOUND', '库存位置不存在');
    const rows = await this.service.db.positionLedger.findMany({
      where: { positionId, warehouseId, ...(cursor ? { id: { gt: cursor } } : {}) },
      take: limit + 1,
      orderBy: { id: 'asc' },
      select: {
        id: true,
        positionId: true,
        stockLedgerId: true,
        deltaOnHand: true,
        deltaReserved: true,
        deltaBlocked: true,
        createdAt: true,
        stockLedger: {
          select: { actionKey: true, requestId: true, transfer: { select: { reason: true } } },
        },
      },
    });
    return success(
      request,
      asPage(
        rows.map(({ stockLedger, ...row }) => ({
          ...row,
          actionKey: stockLedger.actionKey,
          requestId: stockLedger.requestId,
          reason: stockLedger.transfer?.reason ?? null,
        })),
        limit,
      ),
    );
  }
  @Post('stock-transfers')
  @HttpCode(200)
  @Permissions('stock.transfer')
  @headers()
  @ApiBody({
    schema: object({
      sourcePositionId: text,
      targetLocationId: text,
      quantity: { type: 'integer', minimum: 1, maximum: 100000 },
      version: int,
      reason: text,
    }),
  })
  @ApiResult(transferSchema, errors)
  async transfer(
    @Param('warehouseId') id: string,
    @Req() request: ApiRequest,
    @Body() body: unknown,
  ) {
    const warehouseId = await this.scope(request, id);
    const b = fields(body, [
      'sourcePositionId',
      'targetLocationId',
      'quantity',
      'version',
      'reason',
    ]);
    return success(
      request,
      await this.service.transfer(request, key(request), warehouseId, {
        sourcePositionId: uuid(b.sourcePositionId),
        targetLocationId: uuid(b.targetLocationId),
        quantity: integer(b.quantity, 1, 100000),
        version: integer(b.version, 0, 2147483646),
        reason: str(b.reason, 200),
      }),
    );
  }
  @Get('stock-transfers')
  @Permissions('stock.read')
  @paging()
  @ApiResult(paged(transferSchema), errors)
  async transfers(
    @Param('warehouseId') id: string,
    @Req() request: ApiRequest,
    @Query() query: Record<string, unknown>,
  ) {
    const warehouseId = await this.scope(request, id);
    fields(query, ['limit', 'cursor']);
    const { limit, cursor } = page(query);
    return success(
      request,
      asPage(
        await this.service.db.stockTransfer.findMany({
          where: { warehouseId, ...(cursor ? { id: { gt: cursor } } : {}) },
          orderBy: { id: 'asc' },
          take: limit + 1,
        }),
        limit,
      ),
    );
  }
  @Post('inventory-checks')
  @HttpCode(200)
  @Permissions('stock.check')
  @headers()
  @ApiOperation({ summary: '核对单SKU，保存报告；发现差异暂停该SKU销售，不修数' })
  @ApiBody({ schema: object({ skuId: text }) })
  @ApiResult(checkSchema, errors)
  async check(@Param('warehouseId') id: string, @Req() request: ApiRequest, @Body() body: unknown) {
    const warehouseId = await this.scope(request, id);
    const b = fields(body, ['skuId']);
    return success(
      request,
      await this.service.check(request, key(request), warehouseId, uuid(b.skuId)),
    );
  }
  @Get('inventory-checks')
  @Permissions('stock.read')
  @paging()
  @ApiQuery({ name: 'skuId', required: false, type: String })
  @ApiResult(paged(checkSchema), errors)
  async checks(
    @Param('warehouseId') id: string,
    @Req() request: ApiRequest,
    @Query() query: Record<string, unknown>,
  ) {
    const warehouseId = await this.scope(request, id);
    fields(query, ['limit', 'cursor', 'skuId']);
    const { limit, cursor } = page(query);
    const skuId = query.skuId === undefined ? undefined : uuid(query.skuId);
    return success(
      request,
      asPage(
        await this.service.db.inventoryCheck.findMany({
          where: {
            warehouseId,
            ...(skuId ? { skuId } : {}),
            ...(cursor ? { id: { gt: cursor } } : {}),
          },
          orderBy: { id: 'asc' },
          take: limit + 1,
        }),
        limit,
      ),
    );
  }
  @Post('stock/:skuId/release-check-hold')
  @HttpCode(200)
  @Permissions('stock.release-hold')
  @headers()
  @ApiBody({ schema: object({ version: int, reason: text }) })
  @ApiResult(
    object({
      warehouseId: text,
      skuId: text,
      onHand: int,
      reserved: int,
      blocked: int,
      safety: int,
      version: int,
      inventoryHold: bool,
      checkId: text,
      reason: text,
      activeCountId: { type: 'string', nullable: true },
    }),
    errors,
  )
  async release(
    @Param('warehouseId') id: string,
    @Param('skuId') skuId: string,
    @Req() request: ApiRequest,
    @Body() body: unknown,
  ) {
    const warehouseId = await this.scope(request, id);
    const b = fields(body, ['version', 'reason']);
    return success(
      request,
      await this.service.release(request, key(request), warehouseId, uuid(skuId), {
        version: integer(b.version, 0, 2147483646),
        reason: str(b.reason, 200),
      }),
    );
  }
}
