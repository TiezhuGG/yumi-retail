import { randomUUID, createHash } from 'node:crypto';
import { Prisma } from '@yumi/database';
import type { CheckoutPolicy, CheckoutPreview, CheckoutQuote } from '@yumi/contracts';
import { CatalogService } from './catalog-service.js';
import { fields, integer, uuid } from './catalog-input.js';
import { failure } from './http.js';
import type { ApiRequest } from './http.js';
export class CheckoutService {
  constructor(
    readonly catalog: CatalogService,
    readonly orderDevSubmit = false,
  ) {}
  private warehouseId() {
    const id = this.catalog.publicWarehouseId;
    if (!id) throw failure(503, 'STORE_UNAVAILABLE', '尚未配置经营仓库');
    return id;
  }
  private policy(row: CheckoutPolicy) {
    return {
      version: row.version,
      deliveryFeeCents: row.deliveryFeeCents,
      minGoodsCents: row.minGoodsCents,
      freeDeliveryThresholdCents: row.freeDeliveryThresholdCents,
      open: row.open,
    };
  }
  async store() {
    const id = this.catalog.publicWarehouseId;
    if (!id)
      return { status: 'UNCONFIGURED', policy: null, orderSubmissionEnabled: this.orderDevSubmit };
    const w = await this.catalog.db.warehouse.findUnique({ where: { id } });
    const row = await this.catalog.db.checkoutPolicy.findUnique({ where: { warehouseId: id } });
    return {
      orderSubmissionEnabled: this.orderDevSubmit,
      status: !row ? 'UNCONFIGURED' : !w?.enabled || !row.open ? 'PAUSED' : 'OPEN',
      policy: row ? this.policy(row) : null,
    };
  }
  async adminRead(request: ApiRequest) {
    const id = this.warehouseId();
    await this.catalog.warehouse(this.catalog.db, request, id);
    const row = await this.catalog.db.checkoutPolicy.findUnique({ where: { warehouseId: id } });
    return { policy: row ? this.policy(row) : null };
  }
  async adminWrite(request: ApiRequest, key: string, body: unknown) {
    const r = fields(body, [
      'version',
      'deliveryFeeCents',
      'minGoodsCents',
      'freeDeliveryThresholdCents',
      'open',
    ]);
    const version = r.version === null ? null : integer(r.version, 0, 2147483646);
    const deliveryFeeCents = integer(r.deliveryFeeCents, 0, 100000000),
      minGoodsCents = integer(r.minGoodsCents, 0, 100000000),
      freeDeliveryThresholdCents =
        r.freeDeliveryThresholdCents === null
          ? null
          : integer(r.freeDeliveryThresholdCents, 0, 100000000);
    if (typeof r.open !== 'boolean') throw failure(400, 'VALIDATION_ERROR', '报价状态需为布尔值');
    const open = r.open;
    const id = this.warehouseId();
    await this.catalog.warehouse(this.catalog.db, request, id);
    return this.catalog.write(
      request,
      'CHECKOUT_POLICY',
      id,
      key,
      { version, deliveryFeeCents, minGoodsCents, freeDeliveryThresholdCents, open },
      async (tx) => {
        await this.catalog.warehouse(tx, request, id);
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id + ':checkout-policy'},0))::text`;
        const old = await tx.checkoutPolicy.findUnique({ where: { warehouseId: id } });
        if ((old?.version ?? null) !== version || (old && old.version >= 2147483646))
          throw failure(409, 'POLICY_VERSION_CONFLICT', '报价规则已变化，请重新读取');
        if (!old && open)
          throw failure(400, 'POLICY_START_PAUSED', '新建规则必须保持暂停，核对后再开启报价');
        const data = {
          deliveryFeeCents,
          minGoodsCents,
          freeDeliveryThresholdCents,
          open,
          version: old ? old.version + 1 : 0,
        };
        const row = await tx.checkoutPolicy.upsert({
          where: { warehouseId: id },
          create: { warehouseId: id, ...data },
          update: data,
        });
        await this.catalog.audit(tx, request, 'CHECKOUT_POLICY', id, id, null, data);
        return { policy: this.policy(row) };
      },
    );
  }
  async session(tx: Prisma.TransactionClient, request: ApiRequest) {
    const c = request.consumerContext!;
    const rows = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT u.id FROM consumer_users u JOIN consumer_sessions s ON s.user_id=u.id WHERE u.id=${c.userId}::uuid AND s.id=${c.sessionId}::uuid AND u.enabled AND s.revoked_at IS NULL AND s.expires_at>CURRENT_TIMESTAMP AND s.auth_version=u.auth_version FOR SHARE OF u,s`;
    if (!rows.length) throw failure(401, 'SESSION_EXPIRED', '登录已失效，请重新登录');
    return c.userId;
  }
  private input(body: unknown) {
    const r = fields(body, ['addressId', 'addressVersion', 'cartVersion']);
    return {
      addressId: uuid(r.addressId),
      addressVersion: integer(r.addressVersion, 0, 2147483646),
      cartVersion: integer(r.cartVersion, 0, 2147483646),
    };
  }
  async preview(
    tx: Prisma.TransactionClient,
    userId: string,
    input: ReturnType<CheckoutService['input']>,
  ): Promise<CheckoutPreview> {
    const book = await tx.$queryRaw<
      Array<{ version: number }>
    >`SELECT version FROM consumer_address_books WHERE user_id=${userId}::uuid FOR SHARE`;
    const address = await tx.consumerAddress.findFirst({
      where: { id: input.addressId, userId, deleted: false },
    });
    if (!address) throw failure(404, 'ADDRESS_NOT_FOUND', '未找到本人该收货地址');
    if (book[0]?.version !== input.addressVersion)
      throw failure(409, 'ADDRESS_VERSION_CONFLICT', '地址已变化，请重新选择');
    const cart = await tx.$queryRaw<
      Array<{ version: number }>
    >`SELECT version FROM consumer_carts WHERE user_id=${userId}::uuid FOR SHARE`;
    if (cart[0]?.version !== input.cartVersion)
      throw failure(409, 'CART_VERSION_CONFLICT', '购物车已变化，请返回购物车重新读取');
    const selected = await tx.consumerCartItem.findMany({
      where: { userId, selected: true },
      orderBy: { skuId: 'asc' },
    });
    const issues: Array<{ code: string; message: string }> = [];
    const add = (code: string, message: string) => issues.push({ code, message });
    if (selected.length > 50 || selected.reduce((n, i) => n + i.quantity, 0) > 200)
      add('CART_LIMIT_EXCEEDED', '单次核验最多50种规格、合计200件');
    if (!selected.length) add('EMPTY_SELECTION', '请先在账号购物车勾选商品');
    const warehouseId = this.catalog.publicWarehouseId;
    const area = warehouseId
      ? await tx.$queryRaw<
          Array<{ version: number }>
        >`SELECT a.version FROM service_areas a JOIN warehouses w ON w.id=a.warehouse_id JOIN service_buildings b ON b.area_id=a.id WHERE a.id=${address.areaId}::uuid AND b.id=${address.buildingId}::uuid AND a.warehouse_id=${warehouseId}::uuid AND a.enabled AND b.enabled AND w.enabled FOR SHARE OF a,b,w`
      : [];
    if (!area.length) add('ADDRESS_OUT_OF_RANGE', '所选地址暂不在有效配送范围');
    if (warehouseId)
      await tx.$queryRaw`SELECT warehouse_id FROM checkout_policies WHERE warehouse_id=${warehouseId}::uuid FOR SHARE`;
    const row = warehouseId ? await tx.checkoutPolicy.findUnique({ where: { warehouseId } }) : null;
    const policy = row ? this.policy(row) : null;
    if (!policy) add('POLICY_UNCONFIGURED', '运费、起送和报价状态尚未配置');
    else if (!policy.open) add('STORE_PAUSED', '当前暂停生成报价');
    const skus =
      selected.length && warehouseId
        ? await this.catalog.checkoutSkus(
            tx,
            warehouseId,
            selected.map((i) => i.skuId),
          )
        : [];
    const lines = selected.map((i) => {
      const sku = skus.find((s) => s.id === i.skuId);
      return {
        skuId: i.skuId,
        name: sku?.name ?? i.name,
        spec: sku?.spec ?? i.spec,
        unit: sku?.unit ?? i.unit,
        quantity: i.quantity,
        priceCents: sku ? Number(sku.priceCents) : null,
        lineCents: sku ? Number(sku.priceCents) * i.quantity : null,
        available: sku?.available ?? 0,
        status: !sku
          ? ('UNAVAILABLE' as const)
          : sku.available < i.quantity
            ? ('EXCESS' as const)
            : ('AVAILABLE' as const),
      };
    });
    if (lines.some((i) => i.status !== 'AVAILABLE'))
      add('ITEMS_UNAVAILABLE', '部分商品已失效或库存不足，请返回购物车调整');
    const goodsCents =
      lines.length && lines.every((i) => i.status === 'AVAILABLE')
        ? lines.reduce((s, i) => s + i.lineCents!, 0)
        : null;
    if (goodsCents !== null && policy && goodsCents < policy.minGoodsCents)
      add('BELOW_MINIMUM', '商品金额未达到当前起送金额');
    const ready = issues.length === 0;
    const deliveryFeeCents =
      ready && policy && goodsCents !== null
        ? policy.freeDeliveryThresholdCents !== null &&
          goodsCents >= policy.freeDeliveryThresholdCents
          ? 0
          : policy.deliveryFeeCents
        : null;
    return {
      ...input,
      policy,
      areaVersion: area[0]?.version ?? null,
      ready,
      issues,
      lines,
      goodsCents,
      deliveryFeeCents,
      payableCents:
        deliveryFeeCents === null || goodsCents === null ? null : goodsCents + deliveryFeeCents,
    };
  }
  private quote(row: {
    id: string;
    createdAt: Date;
    expiresAt: Date;
    snapshot: Prisma.JsonValue;
  }): CheckoutQuote {
    return {
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      expired: row.expiresAt.getTime() <= Date.now(),
      preview: row.snapshot as unknown as CheckoutPreview,
    };
  }
  async check(request: ApiRequest, body: unknown, key?: string) {
    const input = this.input(body);
    try {
      return await this.catalog.db.$transaction(
        async (tx) => {
          const userId = await this.session(tx, request);
          if (key) {
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId + ':quotes'},0))::text`;
            const digest = createHash('sha256').update(JSON.stringify(input)).digest('hex');
            const old = await tx.checkoutQuote.findUnique({
              where: { userId_key: { userId, key } },
            });
            if (old) {
              if (old.digest !== digest)
                throw failure(409, 'IDEMPOTENCY_CONFLICT', '原报价操作内容已改变，请重新核验');
              return this.quote(old);
            }
            const preview = await this.preview(tx, userId, input);
            if (!preview.ready)
              throw failure(
                409,
                'CHECKOUT_BLOCKED',
                '当前无法生成报价，请先重新核验商品、地址和经营规则',
              );
            if (
              (await tx.checkoutQuote.count({
                where: { userId, expiresAt: { gt: new Date() } },
              })) >= 20
            )
              throw failure(429, 'QUOTE_LIMIT', '报价刷新过于频繁，请稍后重试');
            const createdAt = new Date(),
              expiresAt = new Date(createdAt.getTime() + 120000);
            const row = await tx.checkoutQuote.create({
              data: {
                id: randomUUID(),
                userId,
                key,
                digest,
                requestId: request.requestId,
                snapshot: preview as unknown as Prisma.InputJsonValue,
                createdAt,
                expiresAt,
              },
            });
            return this.quote(row);
          }
          return this.preview(tx, userId, input);
        },
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          timeout: 15000,
          maxWait: 10000,
        },
      );
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2034')
        throw failure(503, 'RETRYABLE_CONFLICT', '资料并发变化，请用原操作重试');
      throw e;
    }
  }
  async readQuote(request: ApiRequest, id: string) {
    return this.catalog.db.$transaction(async (tx) => {
      const userId = await this.session(tx, request);
      const row = await tx.checkoutQuote.findFirst({ where: { id, userId } });
      if (!row) throw failure(404, 'QUOTE_NOT_FOUND', '未找到本人该报价');
      return this.quote(row);
    });
  }
}
