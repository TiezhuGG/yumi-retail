import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import {
  ApiBody,
  ApiCookieAuth,
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { applyDecorators } from '@nestjs/common';
import type { SchemaObject } from '@nestjs/swagger';
import { CatalogService, jsonValue } from './catalog-service.js';
import {
  fields,
  key,
  page,
  productInput,
  receiptInput,
  str,
  uuid,
  version,
} from './catalog-input.js';
import { Permissions, Public } from './staff-guard.js';
import { failure, success } from './http.js';
import type { ApiRequest } from './http.js';
import { ApiResult, object, text } from './api-result.js';

const int: SchemaObject = { type: 'integer', minimum: 0 };
const bool: SchemaObject = { type: 'boolean' };
const nullableDate: SchemaObject = { type: 'string', format: 'date-time', nullable: true };
const skuSchema = object({
  id: text,
  productId: text,
  code: text,
  spec: text,
  unit: text,
  priceCents: int,
  expiryManaged: bool,
  enabled: bool,
});
const productSchema = object({
  id: text,
  categoryId: text,
  name: text,
  description: text,
  status: text,
  version: int,
  createdAt: text,
  skus: { type: 'array', items: skuSchema },
});
const categorySchema = object({
  id: text,
  name: text,
  parentId: { type: 'string', nullable: true },
  enabled: bool,
});
const lineSchema = object({
  id: text,
  receiptId: text,
  warehouseId: text,
  skuId: text,
  batchNo: text,
  quantity: int,
  unitCostCents: int,
  producedAt: nullableDate,
  expiresAt: nullableDate,
});
const receiptSchema = object({
  id: text,
  warehouseId: text,
  sourceRef: text,
  status: text,
  version: int,
  createdBy: text,
  reviewedBy: { type: 'string', nullable: true },
  createdAt: text,
  reviewedAt: nullableDate,
  postedAt: nullableDate,
  lines: { type: 'array', items: lineSchema },
});
const saleSchema = object({
  id: text,
  productId: text,
  name: text,
  description: text,
  categoryId: text,
  spec: text,
  unit: text,
  priceCents: int,
  available: int,
});
const paged = (schema: SchemaObject) =>
  object({
    items: { type: 'array', items: schema },
    hasMore: bool,
    nextCursor: { type: 'string', nullable: true },
  });
const versionSchema = object({ version: int });
const actionHeaders = () =>
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
function resultPage<T extends { id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const visible = rows.slice(0, limit);
  return { items: jsonValue(visible), hasMore, nextCursor: hasMore ? visible.at(-1)!.id : null };
}

@ApiTags('商品管理')
@ApiCookieAuth('staffSession')
@Controller('admin')
export class CatalogAdminController {
  constructor(@Inject(CatalogService) private readonly service: CatalogService) {}
  @Get('categories')
  @Permissions('catalog.read')
  @ApiResult(paged(categorySchema))
  @paging()
  async categories(@Req() request: ApiRequest, @Query() query: Record<string, unknown>) {
    const { limit, cursor } = page(query);
    return success(
      request,
      resultPage(
        await this.service.db.category.findMany({
          where: cursor ? { id: { gt: cursor } } : {},
          orderBy: { id: 'asc' },
          take: limit + 1,
        }),
        limit,
      ),
    );
  }
  @Post('categories')
  @HttpCode(200)
  @Permissions('catalog.write')
  @actionHeaders()
  @ApiBody({
    schema: {
      ...object({ name: text, parentId: { type: 'string', nullable: true } }),
      required: ['name'],
    },
  })
  @ApiResult(categorySchema, [400, 401, 403, 409, 500])
  async createCategory(@Req() request: ApiRequest, @Body() body: unknown) {
    const b = fields(body, ['name', 'parentId']);
    return success(
      request,
      await this.service.createCategory(request, key(request), {
        name: str(b.name, 80),
        parentId: b.parentId == null ? null : uuid(b.parentId),
      }),
    );
  }
  @Get('products')
  @Permissions('catalog.read')
  @paging()
  @ApiResult(paged(productSchema))
  async products(@Req() request: ApiRequest, @Query() query: Record<string, unknown>) {
    const { limit, cursor } = page(query);
    return success(
      request,
      resultPage(
        await this.service.db.product.findMany({
          where: cursor ? { id: { gt: cursor } } : {},
          orderBy: { id: 'asc' },
          take: limit + 1,
          include: { skus: true },
        }),
        limit,
      ),
    );
  }
  @Post('products')
  @HttpCode(200)
  @Permissions('catalog.write')
  @actionHeaders()
  @ApiBody({
    schema: object(
      {
        categoryId: text,
        name: text,
        description: text,
        skus: {
          type: 'array',
          minItems: 1,
          maxItems: 20,
          items: object({
            code: text,
            spec: text,
            unit: text,
            priceCents: { type: 'integer', minimum: 1, maximum: 100000000 },
            expiryManaged: bool,
          }),
        },
      },
      ['categoryId', 'name', 'skus'],
    ),
  })
  @ApiResult(productSchema, [400, 401, 403, 409, 500])
  async createProduct(@Req() request: ApiRequest, @Body() body: unknown) {
    return success(
      request,
      await this.service.createProduct(request, key(request), productInput(body)),
    );
  }
  @Post('products/:id/publish')
  @HttpCode(200)
  @Permissions('catalog.write')
  @actionHeaders()
  @ApiBody({ schema: versionSchema })
  @ApiResult(productSchema, [400, 401, 403, 404, 409, 500])
  async publish(@Param('id') id: string, @Req() request: ApiRequest, @Body() body: unknown) {
    return success(
      request,
      await this.service.productAction(request, key(request), uuid(id), version(body), true),
    );
  }
  @Post('products/:id/unpublish')
  @HttpCode(200)
  @Permissions('catalog.write')
  @actionHeaders()
  @ApiBody({ schema: versionSchema })
  @ApiResult(productSchema, [400, 401, 403, 404, 409, 500])
  async unpublish(@Param('id') id: string, @Req() request: ApiRequest, @Body() body: unknown) {
    return success(
      request,
      await this.service.productAction(request, key(request), uuid(id), version(body), false),
    );
  }
}

@ApiTags('收货入库')
@ApiCookieAuth('staffSession')
@Controller('warehouse/warehouses/:warehouseId')
export class InboundController {
  constructor(@Inject(CatalogService) private readonly service: CatalogService) {}
  @Get('receipts')
  @Permissions('receipt.read')
  @paging()
  @ApiResult(paged(receiptSchema))
  async receipts(
    @Param('warehouseId') warehouseId: string,
    @Req() request: ApiRequest,
    @Query() query: Record<string, unknown>,
  ) {
    warehouseId = uuid(warehouseId);
    await this.service.warehouse(this.service.db, request, warehouseId);
    const { limit, cursor } = page(query);
    return success(
      request,
      resultPage(
        await this.service.db.inboundReceipt.findMany({
          where: { warehouseId, ...(cursor ? { id: { gt: cursor } } : {}) },
          orderBy: { id: 'asc' },
          take: limit + 1,
          include: { lines: true },
        }),
        limit,
      ),
    );
  }
  @Post('receipts')
  @HttpCode(200)
  @Permissions('receipt.write')
  @actionHeaders()
  @ApiResult(receiptSchema, [400, 401, 403, 409, 500])
  @ApiBody({
    schema: object({
      sourceRef: text,
      lines: {
        type: 'array',
        minItems: 1,
        maxItems: 50,
        items: {
          ...object({
            skuId: text,
            batchNo: text,
            quantity: { type: 'integer', minimum: 1, maximum: 100000 },
            unitCostCents: { type: 'integer', minimum: 0, maximum: 100000000 },
            producedAt: nullableDate,
            expiresAt: nullableDate,
          }),
          required: ['skuId', 'batchNo', 'quantity', 'unitCostCents'],
        },
      },
    }),
  })
  async create(
    @Param('warehouseId') warehouseId: string,
    @Req() request: ApiRequest,
    @Body() body: unknown,
  ) {
    return success(
      request,
      await this.service.createReceipt(
        request,
        key(request),
        uuid(warehouseId),
        receiptInput(body),
      ),
    );
  }
  @Post('receipts/:id/approve')
  @HttpCode(200)
  @Permissions('receipt.approve')
  @actionHeaders()
  @ApiBody({ schema: versionSchema })
  @ApiResult(receiptSchema, [400, 401, 403, 404, 409, 500])
  async approve(
    @Param('warehouseId') warehouseId: string,
    @Param('id') id: string,
    @Req() request: ApiRequest,
    @Body() body: unknown,
  ) {
    return success(
      request,
      await this.service.receiptAction(
        request,
        key(request),
        uuid(warehouseId),
        uuid(id),
        version(body),
        false,
      ),
    );
  }
  @Post('receipts/:id/post')
  @HttpCode(200)
  @Permissions('receipt.post')
  @actionHeaders()
  @ApiBody({ schema: versionSchema })
  @ApiResult(receiptSchema, [400, 401, 403, 404, 409, 503, 500])
  async post(
    @Param('warehouseId') warehouseId: string,
    @Param('id') id: string,
    @Req() request: ApiRequest,
    @Body() body: unknown,
  ) {
    return success(
      request,
      await this.service.receiptAction(
        request,
        key(request),
        uuid(warehouseId),
        uuid(id),
        version(body),
        true,
      ),
    );
  }
  @Get('stock')
  @Permissions('stock.read')
  @paging()
  @ApiQuery({ name: 'skuId', required: false, type: String })
  @ApiResult(
    paged(
      object({
        id: text,
        warehouseId: text,
        skuId: text,
        onHand: int,
        reserved: int,
        blocked: int,
        safety: int,
        inventoryHold: bool,
        version: int,
      }),
    ),
  )
  async stock(
    @Param('warehouseId') warehouseId: string,
    @Req() request: ApiRequest,
    @Query() query: Record<string, unknown>,
  ) {
    warehouseId = uuid(warehouseId);
    await this.service.warehouse(this.service.db, request, warehouseId);
    const { limit, cursor } = page(query);
    const skuId = query.skuId === undefined ? undefined : uuid(query.skuId);
    const rows = await this.service.db.stockBalance.findMany({
      where: {
        warehouseId,
        ...(skuId ? { skuId } : {}),
        ...(cursor ? { AND: [{ skuId: { gt: cursor } }] } : {}),
      },
      orderBy: { skuId: 'asc' },
      take: limit + 1,
    });
    return success(
      request,
      resultPage(
        rows.map((row) => ({ ...row, id: row.skuId })),
        limit,
      ),
    );
  }
}

@ApiTags('公开商品')
@Controller('products')
export class PublicCatalogController {
  constructor(@Inject(CatalogService) private readonly service: CatalogService) {}
  @Get()
  @Public()
  @paging()
  @ApiQuery({ name: 'keyword', required: false, type: String })
  @ApiQuery({ name: 'categoryId', required: false, type: String })
  @ApiResult(paged(saleSchema), [400, 503, 500])
  async list(@Req() request: ApiRequest, @Query() query: Record<string, unknown>) {
    fields(query, ['limit', 'cursor', 'keyword', 'categoryId']);
    const p = page(query);
    const keyword = query.keyword === undefined ? '' : str(query.keyword, 80, true);
    return success(
      request,
      await this.service.catalog({
        ...p,
        keyword,
        categoryId: query.categoryId === undefined ? null : uuid(query.categoryId),
      }),
    );
  }
  @Get(':id')
  @Public()
  @ApiOperation({ summary: '可展示SKU详情；id为SKU ID' })
  @ApiResult(saleSchema, [400, 404, 503, 500])
  async detail(@Param('id') id: string, @Req() request: ApiRequest) {
    const result = await this.service.catalog({
      limit: 1,
      keyword: '',
      categoryId: null,
      skuId: uuid(id),
    });
    if (!result.items[0]) throw failure(404, 'RESOURCE_NOT_FOUND', '商品不可用');
    return success(request, result.items[0]);
  }
}
