import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@yumi/database';
import type { createDatabase } from '@yumi/database';
import { failure } from './http.js';
import type { ApiRequest } from './http.js';
import type { ProductInput, ReceiptInput } from './catalog-input.js';

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
  ) {
    await tx.businessAudit.create({
      data: {
        id: randomUUID(),
        actorId: request.staffContext!.staffId,
        action,
        resourceId,
        warehouseId,
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
  createCategory(
    request: ApiRequest,
    key: string,
    input: { name: string; parentId: string | null },
  ) {
    return this.write(request, 'CATEGORY_CREATE', 'catalog', key, input, async (tx) => {
      if (input.parentId) {
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
      const category = await tx.category.findUnique({
        where: { id: input.categoryId },
        include: { parent: true },
      });
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
        if (row.version !== version) throw failure(409, 'VERSION_CONFLICT', '商品已更新，请刷新');
        if (
          publish &&
          (!row.category.enabled ||
            row.category.parent?.enabled === false ||
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
              await tx.$executeRaw`UPDATE stock_balances SET on_hand=on_hand+${line.quantity},version=version+1 WHERE warehouse_id=${warehouseId}::uuid AND sku_id=${line.skuId}::uuid AND on_hand<=1000000000-${line.quantity}`;
            if (changed !== 1) throw failure(409, 'STOCK_LIMIT', '库存超出允许范围');
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
            await tx.stockLedger.create({
              data: {
                id: randomUUID(),
                lotId,
                warehouseId,
                skuId: line.skuId,
                actionKey: `RECEIPT:${id}:${line.id}`,
                deltaOnHand: line.quantity,
                actorId: request.staffContext!.staffId,
                requestId: request.requestId,
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
  async catalog(query: {
    limit: number;
    cursor?: string;
    keyword: string;
    categoryId: string | null;
    skuId?: string;
  }) {
    const warehouseId = this.publicWarehouseId;
    if (
      !warehouseId ||
      !(await this.db.warehouse.findFirst({ where: { id: warehouseId, enabled: true } }))
    )
      throw failure(503, 'STORE_UNAVAILABLE', '经营仓库尚未配置或已暂停');
    const rows = await this.db.$queryRaw<
      Array<{
        id: string;
        productId: string;
        name: string;
        description: string;
        categoryId: string;
        spec: string;
        unit: string;
        priceCents: bigint;
        available: number;
      }>
    >`
      SELECT s.id,p.id AS "productId",p.name,p.description,p.category_id AS "categoryId",s.spec,s.unit,s.price_cents AS "priceCents",
        LEAST(GREATEST(0,COALESCE(b.on_hand-b.reserved-b.blocked-b.safety,0)),COALESCE(SUM(GREATEST(0,l.on_hand-l.reserved-l.blocked)) FILTER(WHERE l.expires_at IS NULL OR l.expires_at>CURRENT_TIMESTAMP),0))::int AS available
      FROM skus s JOIN products p ON p.id=s.product_id JOIN categories c ON c.id=p.category_id LEFT JOIN categories parent ON parent.id=c.parent_id
      JOIN warehouses w ON w.id=${warehouseId}::uuid AND w.enabled
      LEFT JOIN stock_balances b ON b.sku_id=s.id AND b.warehouse_id=${warehouseId}::uuid
      LEFT JOIN stock_lots l ON l.sku_id=s.id AND l.warehouse_id=${warehouseId}::uuid
      WHERE s.enabled AND p.status='PUBLISHED' AND c.enabled AND (parent.id IS NULL OR parent.enabled)
        AND (${query.cursor ?? null}::uuid IS NULL OR s.id>${query.cursor ?? null}::uuid)
        AND (${query.skuId ?? null}::uuid IS NULL OR s.id=${query.skuId ?? null}::uuid)
        AND (${query.categoryId}::uuid IS NULL OR c.id=${query.categoryId}::uuid OR c.parent_id=${query.categoryId}::uuid)
        AND position(lower(${query.keyword}) IN lower(p.name||' '||s.spec))>0
      GROUP BY s.id,p.id,c.id,b.warehouse_id,b.sku_id ORDER BY s.id LIMIT ${query.limit + 1}`;
    const hasMore = rows.length > query.limit;
    const visible = rows.slice(0, query.limit);
    return { items: jsonValue(visible), hasMore, nextCursor: hasMore ? visible.at(-1)!.id : null };
  }
}
