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
  skuBarcodeInput,
  integer,
  key,
  page,
  productInput,
  productDetailsInput,
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
  barcode: { type: 'string', nullable: true },
  id: text,
  productId: text,
  code: text,
  spec: text,
  unit: text,
  priceCents: int,
  expiryManaged: bool,
  enabled: bool,
});
export const productSchema = object({
  imageId: { type: 'string', nullable: true },
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
  version: int,
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
  imageUrl: { type: 'string', nullable: true },
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
  @Get('categories/:id')
  @Permissions('catalog.read')
  @ApiOperation({ summary: '读取当前分类、版本和父分类状态' })
  @ApiResult(
    object({ ...categorySchema.properties, parent: { ...categorySchema, nullable: true } }),
    [400, 401, 403, 404, 500],
  )
  async category(@Param('id') id: string, @Req() request: ApiRequest) {
    const row = await this.service.db.category.findUnique({
      where: { id: uuid(id) },
      include: { parent: true },
    });
    if (!row) throw failure(404, 'RESOURCE_NOT_FOUND', '分类不存在');
    return success(request, row);
  }
  @Post('categories/:id/rename')
  @HttpCode(200)
  @Permissions('catalog.write')
  @actionHeaders()
  @ApiOperation({ summary: '修改分类名称，保持层级及启用状态' })
  @ApiBody({ schema: object({ version: int, name: text }) })
  @ApiResult(categorySchema, [400, 401, 403, 404, 409, 503, 500])
  async renameCategory(@Param('id') id: string, @Req() request: ApiRequest, @Body() body: unknown) {
    const b = fields(body, ['version', 'name']);
    return success(
      request,
      await this.service.categoryAction(
        request,
        key(request),
        uuid(id),
        integer(b.version, 0, 2147483646),
        'RENAME',
        str(b.name, 80),
      ),
    );
  }
  @Post('categories/:id/enable')
  @HttpCode(200)
  @Permissions('catalog.write')
  @actionHeaders()
  @ApiOperation({ summary: '启用分类，父分类须已启用' })
  @ApiBody({ schema: versionSchema })
  @ApiResult(categorySchema, [400, 401, 403, 404, 409, 503, 500])
  async enableCategory(@Param('id') id: string, @Req() request: ApiRequest, @Body() body: unknown) {
    return success(
      request,
      await this.service.categoryAction(request, key(request), uuid(id), version(body), 'ENABLE'),
    );
  }
  @Post('categories/:id/disable')
  @HttpCode(200)
  @Permissions('catalog.write')
  @actionHeaders()
  @ApiOperation({ summary: '停用分类，保留子分类自身状态、商品及库存' })
  @ApiBody({ schema: versionSchema })
  @ApiResult(categorySchema, [400, 401, 403, 404, 409, 503, 500])
  async disableCategory(
    @Param('id') id: string,
    @Req() request: ApiRequest,
    @Body() body: unknown,
  ) {
    return success(
      request,
      await this.service.categoryAction(request, key(request), uuid(id), version(body), 'DISABLE'),
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
  @Get('products/:id')
  @Permissions('catalog.read')
  @ApiOperation({ summary: '读取当前商品资料和版本，供编辑与刷新使用' })
  @ApiResult(productSchema, [400, 401, 403, 404, 500])
  async product(@Param('id') id: string, @Req() request: ApiRequest) {
    const row = await this.service.db.product.findUnique({
      where: { id: uuid(id) },
      include: { skus: true },
    });
    if (!row) throw failure(404, 'RESOURCE_NOT_FOUND', '商品不存在');
    return success(request, jsonValue(row));
  }
  @Post('products/:id/update-details')
  @HttpCode(200)
  @Permissions('catalog.write')
  @actionHeaders()
  @ApiOperation({ summary: '编辑商品名称、分类和说明；保留状态与全部SKU/库存字段' })
  @ApiBody({ schema: object({ version: int, categoryId: text, name: text, description: text }) })
  @ApiResult(productSchema, [400, 401, 403, 404, 409, 503, 500])
  async updateDetails(@Param('id') id: string, @Req() request: ApiRequest, @Body() body: unknown) {
    return success(
      request,
      await this.service.updateProductDetails(
        request,
        key(request),
        uuid(id),
        productDetailsInput(body),
      ),
    );
  }
  @Post('products/:id/skus/:skuId/set-barcode')
  @HttpCode(200)
  @Permissions('catalog.write')
  @actionHeaders()
  @ApiOperation({ summary: '设置或清空SKU条码；全目录唯一，保留库存' })
  @ApiBody({
    schema: object({
      version: int,
      barcode: {
        type: 'string',
        nullable: true,
        maxLength: 64,
        description: '1–64位数字文本，空白或null清空；保留前导零',
      },
    }),
  })
  @ApiResult(productSchema, [400, 401, 403, 404, 409, 503, 500])
  async setSkuBarcode(
    @Param('id') id: string,
    @Param('skuId') skuId: string,
    @Req() request: ApiRequest,
    @Body() body: unknown,
  ) {
    return success(
      request,
      await this.service.setSkuBarcode(
        request,
        key(request),
        uuid(id),
        uuid(skuId),
        skuBarcodeInput(body),
      ),
    );
  }
  @Post('products/:id/skus/:skuId/update-spec')
  @HttpCode(200)
  @Permissions('catalog.write')
  @actionHeaders()
  @ApiOperation({ summary: '更正规格展示文字，保留编码、单位、价格和库存' })
  @ApiBody({
    schema: object({ version: int, spec: { type: 'string', minLength: 1, maxLength: 100 } }),
  })
  @ApiResult(productSchema, [400, 401, 403, 404, 409, 503, 500])
  async updateSkuSpec(
    @Param('id') id: string,
    @Param('skuId') skuId: string,
    @Req() request: ApiRequest,
    @Body() body: unknown,
  ) {
    const b = fields(body, ['version', 'spec']);
    return success(
      request,
      await this.service.updateSkuSpec(request, key(request), uuid(id), uuid(skuId), {
        version: integer(b.version, 0, 2147483646),
        spec: str(b.spec, 100),
      }),
    );
  }
  @Post('products/:id/skus/:skuId/set-price')
  @HttpCode(200)
  @Permissions('catalog.write')
  @actionHeaders()
  @ApiOperation({ summary: '设置规格售价（整数分），使用商品聚合版本' })
  @ApiBody({
    schema: object({
      version: int,
      priceCents: { type: 'integer', minimum: 1, maximum: 100000000 },
    }),
  })
  @ApiResult(productSchema, [400, 401, 403, 404, 409, 503, 500])
  async setSkuPrice(
    @Param('id') id: string,
    @Param('skuId') skuId: string,
    @Req() request: ApiRequest,
    @Body() body: unknown,
  ) {
    const b = fields(body, ['version', 'priceCents']);
    return success(
      request,
      await this.service.skuAction(
        request,
        key(request),
        uuid(id),
        uuid(skuId),
        integer(b.version, 0, 2147483646),
        'SET_PRICE',
        integer(b.priceCents, 1, 100000000),
      ),
    );
  }
  @Post('products/:id/skus/:skuId/enable')
  @ApiOperation({ summary: '启用规格，保持商品上架状态不变' })
  @HttpCode(200)
  @Permissions('catalog.write')
  @actionHeaders()
  @ApiBody({ schema: versionSchema })
  @ApiResult(productSchema, [400, 401, 403, 404, 409, 503, 500])
  async enableSku(
    @Param('id') id: string,
    @Param('skuId') skuId: string,
    @Req() request: ApiRequest,
    @Body() body: unknown,
  ) {
    return success(
      request,
      await this.service.skuAction(
        request,
        key(request),
        uuid(id),
        uuid(skuId),
        version(body),
        'ENABLE',
      ),
    );
  }
  @Post('products/:id/skus/:skuId/disable')
  @ApiOperation({ summary: '停用规格；已上架商品须保留至少一个启用规格' })
  @HttpCode(200)
  @Permissions('catalog.write')
  @actionHeaders()
  @ApiBody({ schema: versionSchema })
  @ApiResult(productSchema, [400, 401, 403, 404, 409, 503, 500])
  async disableSku(
    @Param('id') id: string,
    @Param('skuId') skuId: string,
    @Req() request: ApiRequest,
    @Body() body: unknown,
  ) {
    return success(
      request,
      await this.service.skuAction(
        request,
        key(request),
        uuid(id),
        uuid(skuId),
        version(body),
        'DISABLE',
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
  @Get('skus/by-barcode')
  @Permissions('receipt.write', 'catalog.read')
  @ApiOperation({ summary: '在授权仓库按完整条码读取收货候选规格，不改变库存或单据' })
  @ApiQuery({ name: 'barcode', required: true, type: String })
  @ApiResult(object({ ...skuSchema.properties, name: text }), [400, 401, 403, 404, 500])
  async skuByBarcode(
    @Param('warehouseId') warehouseId: string,
    @Req() request: ApiRequest,
    @Query() query: Record<string, unknown>,
  ) {
    await this.service.warehouse(this.service.db, request, uuid(warehouseId));
    const q = fields(query, ['barcode']);
    const barcode = skuBarcodeInput({ version: 0, barcode: q.barcode }).barcode;
    if (!barcode) throw failure(400, 'VALIDATION_ERROR', '查询需填写完整条码');
    const row = await this.service.db.sku.findUnique({
      where: { barcode },
      include: { product: { select: { name: true } } },
    });
    if (!row)
      throw failure(404, 'BARCODE_NOT_FOUND', '未找到已绑定此条码的商品，请核对或联系运营维护');
    const { product, ...sku } = row;
    return success(request, jsonValue({ ...sku, name: product.name }));
  }
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
  @Get('receipts/:id')
  @Permissions('receipt.read')
  @ApiOperation({ summary: '本仓收货详情，附当前商品目录资料；成本仅收货授权人员可读' })
  @ApiResult(
    object({
      ...receiptSchema.properties,
      lines: {
        type: 'array',
        items: object({
          ...lineSchema.properties,
          sku: object({
            name: text,
            code: text,
            spec: text,
            unit: text,
            expiryManaged: bool,
            enabled: bool,
          }),
        }),
      },
    }),
    [400, 401, 403, 404, 500],
  )
  async receiptDetail(
    @Param('warehouseId') warehouseId: string,
    @Param('id') id: string,
    @Req() request: ApiRequest,
  ) {
    warehouseId = uuid(warehouseId);
    await this.service.warehouse(this.service.db, request, warehouseId);
    const row = await this.service.db.inboundReceipt.findFirst({
      where: { id: uuid(id), warehouseId },
      include: {
        lines: {
          orderBy: { skuId: 'asc' },
          include: {
            sku: {
              select: {
                code: true,
                spec: true,
                unit: true,
                expiryManaged: true,
                enabled: true,
                product: { select: { name: true } },
              },
            },
          },
        },
      },
    });
    if (!row) throw failure(404, 'RESOURCE_NOT_FOUND', '收货单不存在');
    return success(
      request,
      jsonValue({
        ...row,
        lines: row.lines.map(({ sku, ...line }) => ({
          ...line,
          sku: {
            name: sku.product.name,
            code: sku.code,
            spec: sku.spec,
            unit: sku.unit,
            expiryManaged: sku.expiryManaged,
            enabled: sku.enabled,
          },
        })),
      }),
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
        activeCountId: { type: 'string', nullable: true },
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
