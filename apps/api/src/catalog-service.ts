import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@yumi/database';
import type { createDatabase } from '@yumi/database';
import { failure } from './http.js';
import type { ApiRequest } from './http.js';
import type { ProductInput, ProductDetailsInput, ReceiptInput } from './catalog-input.js';

type Database = ReturnType<typeof createDatabase>;
type Tx = Prisma.TransactionClient;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const jsonValue = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? Number(v) : v))) as T;
export class CatalogService {
  constructor(
    readonly db: Database,
    readonly publicWarehouseId?: string,
  ) {}
  async warehouse(tx: Tx, request: ApiRequest, id: string) {
    if (!request.staffContext!.warehouseIds.includes(id))
      throw failure(403, 'FORBIDDEN', '无权访问该仓库');
    const rows = await tx.$queryRaw<
      { enabled: boolean }[]
    >`SELECT enabled FROM warehouses WHERE id=${id}::uuid FOR SHARE`;
    if (!rows[0]?.enabled) throw failure(403, 'FORBIDDEN', '仓库已停用');
  }
  async audit(
    tx: Tx,
    request: ApiRequest,
    action: string,
    resourceId: string,
    warehouseId: string | null = null,
    reason: string | null = null,
    details?: Prisma.InputJsonValue,
  ) {
    await tx.businessAudit.create({
      data: {
        id: randomUUID(),
        actorId: request.staffContext!.staffId,
        action,
        resourceId,
        warehouseId,
        reason,
        ...(details === undefined ? {} : { details }),
        requestId: request.requestId,
      },
    });
  }
  async write(
    request: ApiRequest,
    action: string,
    resourceId: string,
    key: string,
    input: unknown,
    run: (tx: Tx) => Promise<unknown>,
  ) {
    const scope = `${request.staffContext!.staffId}:${action}:${resourceId}`;
    const keyHash = hash(key);
    const requestHash = hash(JSON.stringify(input));
    try {
      return await this.db.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope + ':' + keyHash},0))::text`;
          const previous = await tx.idempotencyRecord.findUnique({
            where: { scope_keyHash: { scope, keyHash } },
          });
          if (previous) {
            if (previous.requestHash !== requestHash)
              throw failure(409, 'IDEMPOTENCY_CONFLICT', '相同操作键的内容已改变');
            return previous.result;
          }
          const result = jsonValue(await run(tx)) as Prisma.InputJsonValue;
          await tx.idempotencyRecord.create({ data: { scope, keyHash, requestHash, result } });
          return result;
        },
        { timeout: 15000, maxWait: 10000 },
      );
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
        throw failure(409, 'DUPLICATE_RESOURCE', '编码已存在');
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034')
        throw failure(503, 'RETRYABLE_CONFLICT', '并发冲突，请使用原操作键重试');
      throw error;
    }
  }
  async lockCategoryTree(tx: Tx, id: string) {
    const category = await tx.category.findUnique({ where: { id } });
    if (category) {
      const ids = [id, ...(category.parentId ? [category.parentId] : [])].sort();
      await tx.$queryRaw(
        Prisma.sql`SELECT id FROM categories WHERE id IN (${Prisma.join(ids.map((value) => Prisma.sql`${value}::uuid`))}) ORDER BY id FOR SHARE`,
      );
    }
    return tx.category.findUnique({ where: { id }, include: { parent: true } });
  }
  categoryAction(
    request: ApiRequest,
    key: string,
    id: string,
    version: number,
    action: 'RENAME' | 'ENABLE' | 'DISABLE',
    name?: string,
  ) {
    return this.write(
      request,
      `CATEGORY_${action}`,
      id,
      key,
      { version, ...(name === undefined ? {} : { name }) },
      async (tx) => {
        // Parent links are immutable in this slice. Stable lock order also matches
        // product create/edit/publish, which hold shared category locks.
        const initial = await tx.category.findUnique({ where: { id } });
        if (!initial) throw failure(404, 'RESOURCE_NOT_FOUND', '分类不存在');
        const ids = [id, ...(initial.parentId ? [initial.parentId] : [])].sort();
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM categories WHERE id IN (${Prisma.join(ids.map((value) => Prisma.sql`${value}::uuid`))}) ORDER BY id FOR UPDATE`,
        );
        const current = await tx.category.findUniqueOrThrow({
          where: { id },
          include: { parent: true },
        });
        if (current.version !== version)
          throw failure(409, 'VERSION_CONFLICT', '分类已更新，请载入最新资料后重试');
        if (action !== 'RENAME' && current.enabled === (action === 'ENABLE'))
          throw failure(409, 'INVALID_TRANSITION', '分类已处于目标状态，请刷新核对');
        if (action === 'ENABLE' && current.parent?.enabled === false)
          throw failure(409, 'PARENT_DISABLED', '请先启用父分类');
        const result = await tx.category.update({
          where: { id },
          data: {
            ...(action === 'RENAME' ? { name } : { enabled: action === 'ENABLE' }),
            version: { increment: 1 },
          },
        });
        await this.audit(
          tx,
          request,
          `CATEGORY_${action}`,
          id,
          null,
          `version ${version}->${result.version}; ${action === 'RENAME' ? 'fields name' : `enabled ${current.enabled}->${result.enabled}`}`,
        );
        return result;
      },
    );
  }
  createCategory(
    request: ApiRequest,
    key: string,
    input: { name: string; parentId: string | null },
  ) {
    return this.write(request, 'CATEGORY_CREATE', 'catalog', key, input, async (tx) => {
      if (input.parentId) {
        await tx.$queryRaw`SELECT id FROM categories WHERE id=${input.parentId}::uuid FOR SHARE`;
        const parent = await tx.category.findUnique({ where: { id: input.parentId } });
        if (!parent?.enabled || parent.parentId)
          throw failure(400, 'VALIDATION_ERROR', '分类最多两级且父分类须启用');
      }
      const row = await tx.category.create({ data: { id: randomUUID(), ...input } });
      await this.audit(tx, request, 'CATEGORY_CREATE', row.id);
      return row;
    });
  }
  createProduct(request: ApiRequest, key: string, input: ProductInput) {
    return this.write(request, 'PRODUCT_CREATE', 'catalog', key, input, async (tx) => {
      const category = await this.lockCategoryTree(tx, input.categoryId);
      if (!category?.enabled || category.parent?.enabled === false)
        throw failure(400, 'VALIDATION_ERROR', '分类不可用');
      const row = await tx.product.create({
        data: {
          id: randomUUID(),
          categoryId: input.categoryId,
          name: input.name,
          description: input.description,
          skus: { create: input.skus.map((sku) => ({ id: randomUUID(), ...sku })) },
        },
        include: { skus: true },
      });
      await this.audit(tx, request, 'PRODUCT_CREATE', row.id);
      return row;
    });
  }
  updateProductDetails(request: ApiRequest, key: string, id: string, input: ProductDetailsInput) {
    return this.write(request, 'PRODUCT_UPDATE_DETAILS', id, key, input, async (tx) => {
      // The same product lock serializes edits with publish/unpublish.
      await tx.$queryRaw`SELECT id FROM products WHERE id=${id}::uuid FOR UPDATE`;
      const current = await tx.product.findUnique({ where: { id } });
      if (!current) throw failure(404, 'RESOURCE_NOT_FOUND', '商品不存在');
      if (current.version !== input.version)
        throw failure(409, 'VERSION_CONFLICT', '商品已被更新，请重新载入最新资料后编辑');
      const target = await this.lockCategoryTree(tx, input.categoryId);
      if (!target?.enabled || target.parent?.enabled === false)
        throw failure(400, 'VALIDATION_ERROR', '所选分类或父分类不可用，请选择启用的分类');
      const result = await tx.product.update({
        where: { id },
        data: {
          categoryId: input.categoryId,
          name: input.name,
          description: input.description,
          version: { increment: 1 },
        },
        include: { skus: true },
      });
      const changed = ['name', 'categoryId', 'description'].filter(
        (field) =>
          current[field as 'name' | 'categoryId' | 'description'] !==
          input[field as 'name' | 'categoryId' | 'description'],
      );
      await this.audit(
        tx,
        request,
        'PRODUCT_UPDATE_DETAILS',
        id,
        null,
        `version ${current.version}->${result.version}; fields ${changed.join(',') || 'none'}`,
      );
      return result;
    });
  }
  setSkuBarcode(
    request: ApiRequest,
    key: string,
    id: string,
    skuId: string,
    input: { version: number; barcode: string | null },
  ) {
    return this.write(
      request,
      'SKU_SET_BARCODE',
      skuId,
      key,
      { productId: id, ...input },
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM products WHERE id=${id}::uuid FOR UPDATE`;
        const product = await tx.product.findUnique({ where: { id }, include: { skus: true } });
        if (!product || !product.skus.some((s) => s.id === skuId))
          throw failure(404, 'RESOURCE_NOT_FOUND', '商品或规格不存在');
        if (product.version !== input.version)
          throw failure(409, 'VERSION_CONFLICT', '商品已更新，请载入最新资料后重试');
        await tx.$queryRaw`SELECT id FROM skus WHERE id=${skuId}::uuid FOR UPDATE`;
        const old = product.skus.find((s) => s.id === skuId)!.barcode;
        try {
          await tx.sku.update({ where: { id: skuId }, data: { barcode: input.barcode } });
        } catch (e) {
          // The unique index resolves races across different product locks.
          if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')
            throw failure(409, 'BARCODE_IN_USE', '条码已绑定其他规格，请核对；停用规格也保留绑定');
          throw e;
        }
        const result = await tx.product.update({
          where: { id },
          data: { version: { increment: 1 } },
          include: { skus: true },
        });
        await this.audit(
          tx,
          request,
          'SKU_SET_BARCODE',
          skuId,
          null,
          `version ${input.version}->${result.version}; barcode ${old ?? 'null'}->${input.barcode ?? 'null'}`,
        );
        return result;
      },
    );
  }
  updateSkuSpec(
    request: ApiRequest,
    key: string,
    id: string,
    skuId: string,
    input: { version: number; spec: string },
  ) {
    return this.write(
      request,
      'SKU_UPDATE_SPEC',
      skuId,
      key,
      { productId: id, ...input },
      async (tx) => {
        // Same aggregate lock as other catalog mutations; no inventory writes.
        await tx.$queryRaw`SELECT id FROM products WHERE id=${id}::uuid FOR UPDATE`;
        const product = await tx.product.findUnique({ where: { id }, include: { skus: true } });
        if (!product || !product.skus.some((s) => s.id === skuId))
          throw failure(404, 'RESOURCE_NOT_FOUND', '商品或规格不存在');
        if (product.version !== input.version)
          throw failure(409, 'VERSION_CONFLICT', '商品已更新，请载入最新资料后重试');
        await tx.$queryRaw`SELECT id FROM skus WHERE id=${skuId}::uuid FOR UPDATE`;
        await tx.sku.update({ where: { id: skuId }, data: { spec: input.spec } });
        const result = await tx.product.update({
          where: { id },
          data: { version: { increment: 1 } },
          include: { skus: true },
        });
        await this.audit(
          tx,
          request,
          'SKU_UPDATE_SPEC',
          skuId,
          null,
          `product ${id}; version ${input.version}->${result.version}; fields spec`,
        );
        return result;
      },
    );
  }
  skuAction(
    request: ApiRequest,
    key: string,
    id: string,
    skuId: string,
    version: number,
    action: 'SET_PRICE' | 'ENABLE' | 'DISABLE',
    priceCents?: number,
  ) {
    const auditAction = `SKU_${action}`;
    return this.write(
      request,
      auditAction,
      skuId,
      key,
      { productId: id, version, ...(priceCents === undefined ? {} : { priceCents }) },
      async (tx) => {
        // Catalog mutations share the product lock/version. Receipt posting takes
        // a SKU share lock so its enabled check serializes with disabling.
        await tx.$queryRaw`SELECT id FROM products WHERE id=${id}::uuid FOR UPDATE`;
        const product = await tx.product.findUnique({ where: { id }, include: { skus: true } });
        if (!product || !product.skus.some((s) => s.id === skuId))
          throw failure(404, 'RESOURCE_NOT_FOUND', '商品或规格不存在');
        if (product.version !== version)
          throw failure(409, 'VERSION_CONFLICT', '商品已更新，请载入最新资料后重试');
        await tx.$queryRaw`SELECT id FROM skus WHERE id=${skuId}::uuid FOR UPDATE`;
        const sku = product.skus.find((s) => s.id === skuId)!;
        if (action !== 'SET_PRICE' && sku.enabled === (action === 'ENABLE'))
          throw failure(409, 'INVALID_TRANSITION', '规格已处于目标状态，请刷新核对');
        if (
          action === 'DISABLE' &&
          product.status === 'PUBLISHED' &&
          product.skus.filter((s) => s.enabled).length === 1
        )
          throw failure(409, 'LAST_ENABLED_SKU', '这是已上架商品的最后一个启用规格，请先下架商品');
        await tx.sku.update({
          where: { id: skuId },
          data: action === 'SET_PRICE' ? { priceCents } : { enabled: action === 'ENABLE' },
        });
        const result = await tx.product.update({
          where: { id },
          data: { version: { increment: 1 } },
          include: { skus: true },
        });
        await this.audit(
          tx,
          request,
          auditAction,
          skuId,
          null,
          `product ${id}; version ${version}->${result.version}; ${action === 'SET_PRICE' ? `priceCents ${sku.priceCents}->${priceCents}` : `enabled ${sku.enabled}->${action === 'ENABLE'}`}`,
        );
        return result;
      },
    );
  }
  productAction(request: ApiRequest, key: string, id: string, version: number, publish: boolean) {
    return this.write(
      request,
      publish ? 'PRODUCT_PUBLISH' : 'PRODUCT_UNPUBLISH',
      id,
      key,
      { version },
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM products WHERE id=${id}::uuid FOR UPDATE`;
        const row = await tx.product.findUnique({
          where: { id },
          include: { category: { include: { parent: true } }, skus: true },
        });
        if (!row) throw failure(404, 'RESOURCE_NOT_FOUND', '商品不存在');
        const category = publish ? await this.lockCategoryTree(tx, row.categoryId) : row.category;
        if (row.version !== version) throw failure(409, 'VERSION_CONFLICT', '商品已更新，请刷新');
        if (
          publish &&
          (!category?.enabled ||
            category.parent?.enabled === false ||
            !row.skus.some((s) => s.enabled))
        )
          throw failure(409, 'INVALID_TRANSITION', '分类或规格不可用');
        if ((!publish && row.status !== 'PUBLISHED') || (publish && row.status === 'PUBLISHED'))
          throw failure(409, 'INVALID_TRANSITION', '当前状态不能执行该动作');
        const result = await tx.product.update({
          where: { id },
          data: { status: publish ? 'PUBLISHED' : 'UNPUBLISHED', version: { increment: 1 } },
          include: { skus: true },
        });
        await this.audit(tx, request, publish ? 'PRODUCT_PUBLISH' : 'PRODUCT_UNPUBLISH', id);
        return result;
      },
    );
  }
  validateDates(
    sku: { enabled: boolean; expiryManaged: boolean },
    line: { producedAt: string | null; expiresAt: string | null },
    now = Date.now(),
  ) {
    if (!sku.enabled) throw failure(409, 'SKU_DISABLED', '规格已停用');
    if (
      (sku.expiryManaged && (!line.producedAt || !line.expiresAt)) ||
      !!line.producedAt !== !!line.expiresAt ||
      (line.producedAt &&
        (Date.parse(line.producedAt) > now ||
          Date.parse(line.expiresAt!) <= now ||
          Date.parse(line.expiresAt!) <= Date.parse(line.producedAt)))
    )
      throw failure(409, 'INVALID_EXPIRY', '请核对生产与到期时间，过期批次不可收货');
  }
  async createReceipt(request: ApiRequest, key: string, warehouseId: string, input: ReceiptInput) {
    await this.warehouse(this.db, request, warehouseId);
    return this.write(request, 'RECEIPT_CREATE', warehouseId, key, input, async (tx) => {
      await this.warehouse(tx, request, warehouseId);
      for (const line of input.lines) {
        await tx.$queryRaw`SELECT id FROM skus WHERE id=${line.skuId}::uuid FOR SHARE`;
        const sku = await tx.sku.findUnique({ where: { id: line.skuId } });
        if (!sku) throw failure(400, 'VALIDATION_ERROR', '规格不存在');
        this.validateDates(sku, line);
      }
      const row = await tx.inboundReceipt.create({
        data: {
          id: randomUUID(),
          warehouseId,
          sourceRef: input.sourceRef,
          createdBy: request.staffContext!.staffId,
          lines: {
            create: input.lines.map((line) => ({ ...line, id: randomUUID() })),
          },
        },
        include: { lines: true },
      });
      await this.audit(tx, request, 'RECEIPT_CREATE', row.id, warehouseId);
      return row;
    });
  }
  async receiptAction(
    request: ApiRequest,
    key: string,
    warehouseId: string,
    id: string,
    version: number,
    post: boolean,
  ) {
    await this.warehouse(this.db, request, warehouseId);
    return this.write(
      request,
      post ? 'RECEIPT_POST' : 'RECEIPT_APPROVE',
      id,
      key,
      { warehouseId, version },
      async (tx) => {
        await this.warehouse(tx, request, warehouseId);
        await tx.$queryRaw`SELECT id FROM inbound_receipts WHERE id=${id}::uuid AND warehouse_id=${warehouseId}::uuid FOR UPDATE`;
        const receipt = await tx.inboundReceipt.findFirst({
          where: { id, warehouseId },
          include: { lines: { orderBy: { skuId: 'asc' } } },
        });
        if (!receipt) throw failure(404, 'RESOURCE_NOT_FOUND', '收货单不存在');
        if (receipt.version !== version)
          throw failure(409, 'VERSION_CONFLICT', '单据已更新，请刷新');
        if (receipt.status !== (post ? 'APPROVED' : 'DRAFT'))
          throw failure(409, 'INVALID_TRANSITION', '单据状态不允许该动作');
        if (post)
          for (const line of receipt.lines) {
            await tx.$queryRaw`SELECT id FROM skus WHERE id=${line.skuId}::uuid FOR SHARE`;
            const sku = await tx.sku.findUniqueOrThrow({ where: { id: line.skuId } });
            this.validateDates(sku, {
              producedAt: line.producedAt?.toISOString() ?? null,
              expiresAt: line.expiresAt?.toISOString() ?? null,
            });
            await tx.$executeRaw`INSERT INTO stock_balances(warehouse_id,sku_id) VALUES(${warehouseId}::uuid,${line.skuId}::uuid) ON CONFLICT(warehouse_id,sku_id) DO NOTHING`;
            const changed =
              await tx.$executeRaw`UPDATE stock_balances SET on_hand=on_hand+${line.quantity},version=version+1 WHERE warehouse_id=${warehouseId}::uuid AND sku_id=${line.skuId}::uuid AND NOT inventory_hold AND active_count_id IS NULL AND on_hand<=1000000000-${line.quantity}`;
            if (changed !== 1)
              throw failure(409, 'STOCK_UNAVAILABLE', '库存已暂停或超出允许范围，请先核对');
            const lotId = randomUUID();
            await tx.stockLot.create({
              data: {
                id: lotId,
                warehouseId,
                skuId: line.skuId,
                receiptLineId: line.id,
                batchNo: line.batchNo,
                onHand: line.quantity,
                unitCostCents: line.unitCostCents,
                producedAt: line.producedAt,
                expiresAt: line.expiresAt,
              },
            });
            const location = await tx.warehouseLocation.findUniqueOrThrow({
              where: { warehouseId_code: { warehouseId, code: 'DEFAULT' } },
            });
            if (!location.enabled) throw failure(409, 'LOCATION_DISABLED', '默认收货位已停用');
            const positionId = randomUUID();
            await tx.stockPosition.create({
              data: {
                id: positionId,
                warehouseId,
                skuId: line.skuId,
                lotId,
                locationId: location.id,
                onHand: line.quantity,
              },
            });
            const ledgerId = randomUUID();
            await tx.stockLedger.create({
              data: {
                id: ledgerId,
                lotId,
                warehouseId,
                skuId: line.skuId,
                actionKey: `RECEIPT:${id}:${line.id}`,
                deltaOnHand: line.quantity,
                actorId: request.staffContext!.staffId,
                requestId: request.requestId,
              },
            });
            await tx.positionLedger.create({
              data: {
                id: randomUUID(),
                positionId,
                warehouseId,
                skuId: line.skuId,
                lotId,
                stockLedgerId: ledgerId,
                deltaOnHand: line.quantity,
                deltaReserved: 0,
                deltaBlocked: 0,
              },
            });
          }
        const row = await tx.inboundReceipt.update({
          where: { id },
          data: post
            ? { status: 'POSTED', postedAt: new Date(), version: { increment: 1 } }
            : {
                status: 'APPROVED',
                reviewedBy: request.staffContext!.staffId,
                reviewedAt: new Date(),
                version: { increment: 1 },
              },
          include: { lines: true },
        });
        await this.audit(tx, request, post ? 'RECEIPT_POST' : 'RECEIPT_APPROVE', id, warehouseId);
        return row;
      },
    );
  }
  async publicStore() {
    const warehouseId = this.publicWarehouseId;
    if (
      !warehouseId ||
      !(await this.db.warehouse.findFirst({ where: { id: warehouseId, enabled: true } }))
    )
      throw failure(503, 'STORE_UNAVAILABLE', '经营仓库尚未配置或已暂停');
    return warehouseId;
  }
  async catalog(query: {
    limit: number;
    cursor?: string;
    keyword: string;
    categoryId: string | null;
    skuId?: string;
    relatedToSkuId?: string;
  }) {
    const warehouseId = await this.publicStore();
    const rows = await this.db.$queryRaw<
      Array<{
        id: string;
        productId: string;
        name: string;
        description: string;
        categoryId: string;
        imageUrl: string | null;
        imageUrls: string[];
        spec: string;
        unit: string;
        priceCents: bigint;
        available: number;
      }>
    >(Prisma.sql`
      SELECT * FROM (${this.visibleSkus(warehouseId, query)}) matched
      WHERE (${query.cursor ?? null}::uuid IS NULL OR id>${query.cursor ?? null}::uuid)
      ORDER BY id LIMIT ${query.limit + 1}`);
    const hasMore = rows.length > query.limit;
    const visible = rows.slice(0, query.limit);
    return { items: jsonValue(visible), hasMore, nextCursor: hasMore ? visible.at(-1)!.id : null };
  }
  private visibleSkus(
    warehouseId: string,
    query: { keyword: string; categoryId: string | null; skuId?: string; relatedToSkuId?: string },
  ) {
    return Prisma.sql`
      SELECT s.id,p.id AS "productId",p.name,p.description,p.category_id AS "categoryId",CASE WHEN p.image_id IS NULL THEN NULL ELSE '/api/v1/product-images/'||p.id::text||'/'||p.image_id::text END AS "imageUrl",COALESCE((SELECT jsonb_agg('/api/v1/product-images/'||p.id::text||'/'||i.id::text ORDER BY i.sort_order) FROM product_images i WHERE i.product_id=p.id AND i.sort_order IS NOT NULL),'[]'::jsonb) AS "imageUrls",s.spec,s.unit,s.price_cents AS "priceCents",
        CASE WHEN COALESCE(b.inventory_hold,false) OR b.active_count_id IS NOT NULL THEN 0 ELSE LEAST(GREATEST(0,COALESCE(b.on_hand-b.reserved-b.blocked-b.safety,0)),COALESCE(SUM(GREATEST(0,sp.on_hand-sp.reserved-sp.blocked)) FILTER(WHERE loc.enabled AND (l.expires_at IS NULL OR l.expires_at>CURRENT_TIMESTAMP)),0))::int END AS available
      FROM skus s JOIN products p ON p.id=s.product_id JOIN categories c ON c.id=p.category_id LEFT JOIN categories parent ON parent.id=c.parent_id
      JOIN warehouses w ON w.id=${warehouseId}::uuid AND w.enabled
      LEFT JOIN stock_balances b ON b.sku_id=s.id AND b.warehouse_id=${warehouseId}::uuid
      LEFT JOIN stock_lots l ON l.sku_id=s.id AND l.warehouse_id=${warehouseId}::uuid
      LEFT JOIN stock_positions sp ON sp.lot_id=l.id
      LEFT JOIN warehouse_locations loc ON loc.id=sp.location_id
      WHERE s.enabled AND p.status='PUBLISHED' AND c.enabled AND (parent.id IS NULL OR parent.enabled)
        AND (${query.skuId ?? null}::uuid IS NULL OR s.id=${query.skuId ?? null}::uuid)
        AND (${query.relatedToSkuId ?? null}::uuid IS NULL OR p.id=(SELECT anchor.product_id FROM skus anchor WHERE anchor.id=${query.relatedToSkuId ?? null}::uuid AND anchor.enabled))
        AND (${query.categoryId}::uuid IS NULL OR c.id=${query.categoryId}::uuid OR c.parent_id=${query.categoryId}::uuid)
        AND position(lower(${query.keyword}) IN lower(p.name||' '||s.spec))>0
      GROUP BY s.id,p.id,c.id,b.warehouse_id,b.sku_id`;
  }
  async productCards(query: {
    limit: number;
    cursor?: string;
    keyword: string;
    categoryId: string | null;
  }) {
    const warehouseId = await this.publicStore();
    const rows = await this.db.$queryRaw<
      Array<{
        id: string;
        entrySkuId: string;
        name: string;
        categoryId: string;
        imageUrl: string | null;
        spec: string;
        unit: string;
        priceCents: bigint;
        variantCount: number;
        hasStock: boolean;
      }>
    >(Prisma.sql`
      WITH matched AS (${this.visibleSkus(warehouseId, query)}), ranked AS (
        SELECT *,COUNT(*) OVER (PARTITION BY "productId")::int AS "variantCount",
          BOOL_OR(available>0) OVER (PARTITION BY "productId") AS "hasStock",
          ROW_NUMBER() OVER (PARTITION BY "productId" ORDER BY (available>0) DESC,"priceCents",id) AS rank
        FROM matched
      )
      SELECT "productId" AS id,id AS "entrySkuId",name,"categoryId","imageUrl",spec,unit,"priceCents","variantCount","hasStock"
      FROM ranked WHERE rank=1 AND (${query.cursor ?? null}::uuid IS NULL OR "productId">${query.cursor ?? null}::uuid)
      ORDER BY "productId" LIMIT ${query.limit + 1}`);
    const hasMore = rows.length > query.limit,
      items = rows.slice(0, query.limit);
    return { items: jsonValue(items), hasMore, nextCursor: hasMore ? items.at(-1)!.id : null };
  }
}
