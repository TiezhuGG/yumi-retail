import { createHash, randomUUID } from 'node:crypto';
import { Prisma, orderReservationDelta, redemptionJobChange } from '@yumi/database';
import type { ConsumerOrderAddress } from '@yumi/contracts';
import { CatalogService } from './catalog-service.js';
import { CheckoutService } from './checkout.js';
import { ConsumerAddressService } from './consumer-address.js';
import { OrderPrivateData } from './order-private.js';
import { inventoryLocks, metadataLocks } from './reservation-locks.js';
import { fields, integer, str, uuid } from './catalog-input.js';
import { failure } from './http.js';
import type { ApiRequest } from './http.js';
import { PointsGrantService } from './points-grants.js';
type Tx = Prisma.TransactionClient;
type QuoteInput = {
  rewardId: string;
  rewardVersion: number;
  quantity: number;
  addressId: string;
  addressVersion: number;
};
export type RedemptionSnapshot = QuoteInput & {
  skuId: string;
  title: string;
  name: string;
  spec: string;
  unit: string;
  pointsPrice: string;
  totalPoints: string;
  areaVersion: number;
  productVersion: number;
  balance: string;
  remainingBalance: string;
  deliveryMode: 'LOCAL_NO_CASH';
};
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export class RedemptionService {
  readonly checkout: CheckoutService;
  readonly privateData: OrderPrivateData;
  readonly staff: PointsGrantService;
  constructor(
    readonly catalog: CatalogService,
    readonly addresses: ConsumerAddressService,
    key?: string,
    readonly enabled = false,
  ) {
    this.checkout = new CheckoutService(catalog);
    this.privateData = new OrderPrivateData(key);
    this.staff = new PointsGrantService(catalog);
  }
  private warehouse() {
    if (!this.catalog.publicWarehouseId)
      throw failure(503, 'STORE_UNAVAILABLE', '经营仓库尚未配置');
    return this.catalog.publicWarehouseId;
  }
  private gate() {
    if (!this.enabled)
      throw failure(
        503,
        'REDEMPTION_SUBMISSION_DISABLED',
        '兑换提交尚未开放，仅支持已受理订单查询与取消',
      );
  }
  private async clock(tx: Tx) {
    return (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]!.now;
  }
  private async run<T extends Prisma.InputJsonValue>(
    r: ApiRequest,
    key: string,
    action: string,
    input: unknown,
    work: (tx: Tx, userId: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.catalog.db.$transaction(
        async (tx) => {
          const userId = await this.checkout.session(tx, r),
            scope = userId + ':REDEMPTION_' + action,
            keyHash = hash(key),
            requestHash = hash(input);
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId + ':redemptions'},0))::text`;
          const replay = await tx.idempotencyRecord.findUnique({
            where: { scope_keyHash: { scope, keyHash } },
          });
          if (replay) {
            if (replay.requestHash !== requestHash)
              throw failure(409, 'IDEMPOTENCY_CONFLICT', '原操作内容已变化，请保留原请求核实');
            return replay.result as T;
          }
          const result = await work(tx, userId);
          const valid = await tx.$queryRaw<
            Array<{ id: string }>
          >`SELECT s.id FROM consumer_sessions s JOIN consumer_users u ON u.id=s.user_id WHERE s.id=${r.consumerContext!.sessionId}::uuid AND u.id=${userId}::uuid AND u.enabled AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.auth_version=u.auth_version`;
          if (!valid.length)
            throw failure(
              401,
              'SESSION_EXPIRED',
              '登录在处理期间已过期，本次操作已回滚，请核实后重新登录',
            );
          await tx.idempotencyRecord.create({ data: { scope, keyHash, requestHash, result } });
          return result;
        },
        { timeout: 15000, maxWait: 10000 },
      );
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && ['P2034', 'P2002'].includes(e.code))
        throw failure(503, 'RETRYABLE_CONFLICT', '并发变化，请使用原请求重试');
      throw e;
    }
  }
  private async account(tx: Tx, userId: string) {
    await tx.$queryRaw`SELECT user_id FROM points_accounts WHERE user_id=${userId}::uuid FOR UPDATE`;
    const row = await tx.pointsAccount.findUnique({ where: { userId } });
    return row?.balance ?? 0n;
  }
  private async reward(tx: Tx, id: string) {
    const warehouse = this.warehouse();
    await tx.$queryRaw`SELECT id FROM reward_products WHERE id=${id}::uuid AND warehouse_id=${warehouse}::uuid FOR UPDATE`;
    const p = await tx.rewardProduct.findFirst({ where: { id, warehouseId: warehouse } });
    if (!p) throw failure(404, 'REWARD_UNAVAILABLE', '兑换商品暂不可用');
    return p;
  }
  private async address(tx: Tx, userId: string, input: QuoteInput) {
    const books = await tx.$queryRaw<
      Array<{ version: number }>
    >`SELECT version FROM consumer_address_books WHERE user_id=${userId}::uuid FOR SHARE`;
    if (books[0]?.version !== input.addressVersion)
      throw failure(409, 'ADDRESS_VERSION_CONFLICT', '地址已变化，请重新选择');
    const address = await tx.consumerAddress.findFirst({
      where: { id: input.addressId, userId, deleted: false },
    });
    if (!address) throw failure(404, 'ADDRESS_NOT_FOUND', '未找到本人该地址');
    const area = await tx.$queryRaw<
      Array<{ version: number }>
    >`SELECT a.version FROM service_areas a JOIN service_buildings b ON b.area_id=a.id JOIN warehouses w ON w.id=a.warehouse_id WHERE a.id=${address.areaId}::uuid AND b.id=${address.buildingId}::uuid AND a.warehouse_id=${this.warehouse()}::uuid AND a.enabled AND b.enabled AND w.enabled FOR SHARE OF a,b,w`;
    if (!area.length) throw failure(409, 'ADDRESS_OUT_OF_RANGE', '地址不在当前有效配送范围');
    return { address, areaVersion: area[0]!.version };
  }
  private async snapshot(
    tx: Tx,
    userId: string,
    input: QuoteInput,
    balance: bigint,
    p: Awaited<ReturnType<RedemptionService['reward']>>,
  ): Promise<RedemptionSnapshot> {
    const now = await this.clock(tx);
    if (p.version !== input.rewardVersion)
      throw failure(409, 'QUOTE_CHANGED', '兑换商品规则已变化，请重新读取并确认');
    if (
      p.status !== 'PUBLISHED' ||
      (p.startsAt && p.startsAt > now) ||
      (p.endsAt && p.endsAt <= now)
    )
      throw failure(409, 'REWARD_UNAVAILABLE', '兑换商品当前不在开放时间');
    const { areaVersion } = await this.address(tx, userId, input);
    const skus = await this.catalog.checkoutSkus(tx, this.warehouse(), [p.skuId]),
      sku = skus[0];
    if (!sku) throw failure(409, 'REWARD_UNAVAILABLE', '商品、规格或分类已暂停');
    const usage = await tx.$queryRaw<
      Array<{ total: bigint; personal: bigint }>
    >`SELECT COALESCE(SUM(quantity),0)::bigint AS total,COALESCE(SUM(quantity) FILTER(WHERE user_id=${userId}::uuid),0)::bigint AS personal FROM redemption_orders WHERE reward_id=${p.id}::uuid AND status='ACTIVE'`;
    if (
      BigInt(input.quantity) + usage[0]!.total > BigInt(p.totalQuota) ||
      BigInt(input.quantity) + usage[0]!.personal > BigInt(p.perUserLimit)
    )
      throw failure(409, 'QUOTA_EXCEEDED', '已超过剩余总配额或本人累计限兑数量');
    if (sku.available < input.quantity)
      throw failure(409, 'STOCK_UNAVAILABLE', '当前可售库存不足，请调整数量');
    const total = p.pointsPrice * BigInt(input.quantity);
    if (balance < total)
      throw failure(
        409,
        'POINTS_INSUFFICIENT',
        '积分不足，还差' + (total - balance).toString() + '积分',
      );
    const product = await tx.sku.findUniqueOrThrow({
      where: { id: p.skuId },
      include: { product: true },
    });
    return {
      ...input,
      skuId: p.skuId,
      title: p.title,
      name: sku.name,
      spec: sku.spec,
      unit: sku.unit,
      pointsPrice: p.pointsPrice.toString(),
      totalPoints: total.toString(),
      areaVersion,
      productVersion: product.product.version,
      balance: balance.toString(),
      remainingBalance: (balance - total).toString(),
      deliveryMode: 'LOCAL_NO_CASH',
    };
  }
  async quote(r: ApiRequest, key: string, body: unknown) {
    const b = fields(body, [
      'rewardId',
      'rewardVersion',
      'quantity',
      'addressId',
      'addressVersion',
    ]);
    const input: QuoteInput = {
      rewardId: uuid(b.rewardId),
      rewardVersion: integer(b.rewardVersion, 0, 2147483646),
      quantity: integer(b.quantity, 1, 100000),
      addressId: uuid(b.addressId),
      addressVersion: integer(b.addressVersion, 0, 2147483646),
    };
    const result = await this.run(r, key, 'QUOTE', input, async (tx, userId) => {
      this.gate();
      const balance = await this.account(tx, userId),
        p = await this.reward(tx, input.rewardId);
      await metadataLocks(tx, [p.skuId]);
      const snapshot = await this.snapshot(tx, userId, input, balance, p),
        now = await this.clock(tx);
      if ((await tx.redemptionQuote.count({ where: { userId, expiresAt: { gt: now } } })) >= 20)
        throw failure(429, 'QUOTE_LIMIT', '报价刷新过于频繁，请稍后再试');
      const id = randomUUID();
      await tx.redemptionQuote.create({
        data: {
          id,
          userId,
          rewardId: p.id,
          snapshot: snapshot as unknown as Prisma.InputJsonValue,
          createdAt: now,
          expiresAt: new Date(now.getTime() + 120000),
        },
      });
      return { id };
    });
    return this.readQuote(r, result.id);
  }
  async readQuote(r: ApiRequest, id: string) {
    return this.catalog.db.$transaction(async (tx) => {
      const userId = await this.checkout.session(tx, r),
        row = await tx.redemptionQuote.findFirst({ where: { id, userId } });
      if (!row) throw failure(404, 'QUOTE_NOT_FOUND', '未找到本人兑换报价');
      return {
        id: row.id,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        expired: row.expiresAt <= (await this.clock(tx)),
        snapshot: row.snapshot as unknown as RedemptionSnapshot,
      };
    });
  }
  async create(r: ApiRequest, key: string, body: unknown) {
    const b = fields(body, ['quoteId']),
      quoteId = uuid(b.quoteId);
    return this.run(r, key, 'CREATE', { quoteId }, async (tx, userId) => {
      this.gate();
      const balance = await this.account(tx, userId);
      const quote = await tx.redemptionQuote.findFirst({ where: { id: quoteId, userId } });
      if (!quote) throw failure(404, 'QUOTE_NOT_FOUND', '未找到本人兑换报价');
      if (await tx.redemptionOrder.findUnique({ where: { quoteId } }))
        throw failure(409, 'QUOTE_ALREADY_USED', '该报价已有兑换单，请核实原订单');
      if (quote.expiresAt <= (await this.clock(tx)))
        throw failure(409, 'QUOTE_EXPIRED', '兑换报价已过期，请重新确认');
      const old = quote.snapshot as unknown as RedemptionSnapshot,
        p = await this.reward(tx, quote.rewardId);
      // Before stock locks, hold address/range/catalogue shared locks in the cash-order order.
      await this.address(tx, userId, old);
      await metadataLocks(tx, [p.skuId]);
      await inventoryLocks(tx, this.warehouse(), [p.skuId]);
      const fresh = await this.snapshot(tx, userId, old, balance, p);
      const compare = (s: RedemptionSnapshot) =>
        JSON.stringify([
          s.rewardId,
          s.rewardVersion,
          s.skuId,
          s.quantity,
          s.pointsPrice,
          s.totalPoints,
          s.title,
          s.name,
          s.spec,
          s.unit,
          s.addressId,
          s.addressVersion,
          s.areaVersion,
          s.productVersion,
        ]);
      if (compare(old) !== compare(fresh))
        throw failure(409, 'QUOTE_CHANGED', '商品或地址规则已变化，请重新报价并确认');
      const { address } = await this.address(tx, userId, old),
        area = await tx.serviceArea.findUniqueOrThrow({ where: { id: address.areaId } }),
        building = await tx.serviceBuilding.findUniqueOrThrow({
          where: { id: address.buildingId },
        });
      const now = await this.clock(tx),
        id = randomUUID();
      const addressPayload = this.privateData.encrypt(userId, id, {
        areaName: area.name,
        buildingName: building.name,
        ...this.addresses.decryptSnapshot(userId, address.id, address.payload!),
        orderNote: '',
      });
      await tx.redemptionOrder.create({
        data: {
          id,
          userId,
          quoteId,
          rewardId: p.id,
          warehouseId: p.warehouseId,
          skuId: p.skuId,
          orderNo: 'R' + id.replaceAll('-', '').toUpperCase(),
          title: fresh.title,
          name: fresh.name,
          spec: fresh.spec,
          unit: fresh.unit,
          quantity: fresh.quantity,
          pointsPrice: p.pointsPrice,
          totalPoints: BigInt(fresh.totalPoints),
          rewardVersion: p.version,
          addressPayload,
          createdAt: now,
        },
      });
      await tx.pointsAccount.update({
        where: { userId },
        data: { balance: { decrement: BigInt(fresh.totalPoints) }, version: { increment: 1 } },
      });
      await tx.pointsEntry.create({
        data: {
          id: randomUUID(),
          userId,
          delta: -BigInt(fresh.totalPoints),
          actionKey: 'REDEMPTION:' + id,
          reason: '积分兑换商品',
          consumerActorId: userId,
          redemptionId: id,
          redemptionAction: 'REDEEM',
        },
      });
      const positions = await tx.stockPosition.findMany({
        where: {
          warehouseId: p.warehouseId,
          skuId: p.skuId,
          location: { enabled: true },
          lot: { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        },
        include: { lot: true },
        orderBy: [
          { lot: { expiresAt: { sort: 'asc', nulls: 'last' } } },
          { lot: { receivedAt: 'asc' } },
          { lotId: 'asc' },
          { id: 'asc' },
        ],
      });
      let remaining = fresh.quantity;
      const lotFree = new Map<string, number>();
      for (const pos of positions) {
        if (!remaining) break;
        const free = lotFree.get(pos.lotId) ?? pos.lot.onHand - pos.lot.reserved - pos.lot.blocked;
        const quantity = Math.min(remaining, pos.onHand - pos.reserved - pos.blocked, free);
        if (quantity <= 0) continue;
        const allocation = {
          id: randomUUID(),
          orderId: id,
          warehouseId: p.warehouseId,
          skuId: p.skuId,
          lotId: pos.lotId,
          positionId: pos.id,
          quantity,
        };
        const reserveLedgerId = await orderReservationDelta(
          tx,
          allocation,
          false,
          r.requestId,
          userId,
          'REDEMPTION',
        );
        await tx.redemptionAllocation.create({ data: { ...allocation, reserveLedgerId } });
        remaining -= quantity;
        lotFree.set(pos.lotId, free - quantity);
      }
      if (remaining) throw failure(409, 'STOCK_UNAVAILABLE', '批次可售库存变化，未创建兑换单');
      await tx.redemptionOutbox.create({ data: { orderId: id } });
      await tx.redemptionEvent.create({
        data: {
          id: randomUUID(),
          orderId: id,
          type: 'REDEMPTION_CREATED',
          consumerActorId: userId,
          requestId: r.requestId,
        },
      });
      const final = await this.clock(tx);
      const lots = await tx.redemptionAllocation.findMany({
        where: { orderId: id },
        select: { lotId: true },
      });
      if (
        quote.expiresAt <= final ||
        (p.endsAt && p.endsAt <= final) ||
        (await tx.stockLot.count({
          where: { id: { in: lots.map((a) => a.lotId) }, expiresAt: { lte: final } },
        }))
      )
        throw failure(409, 'QUOTE_EXPIRED', '报价或批次已过期，本次兑换已回滚');
      return { id };
    });
  }
  async cancel(r: ApiRequest, key: string, id: string, body: unknown) {
    const b = fields(body, ['version']),
      version = integer(b.version, 0, 2147483646);
    return this.run(r, key, 'CANCEL:' + id, { version }, async (tx, userId) => {
      await this.account(tx, userId);
      const initial = await tx.redemptionOrder.findFirst({ where: { id, userId } });
      if (!initial) throw failure(404, 'REDEMPTION_NOT_FOUND', '未找到本人兑换单');
      await this.reward(tx, initial.rewardId);
      await inventoryLocks(tx, initial.warehouseId, [initial.skuId]);
      await tx.$queryRaw`SELECT id FROM redemption_orders WHERE id=${id}::uuid AND user_id=${userId}::uuid FOR UPDATE`;
      const order = await tx.redemptionOrder.findUniqueOrThrow({ where: { id } });
      if (order.status === 'CANCELED') return { id };
      if (order.version !== version) throw failure(409, 'VERSION_CONFLICT', '兑换单已变化，请刷新');
      await tx.$queryRaw`SELECT order_id FROM redemption_outbox WHERE order_id=${id}::uuid FOR UPDATE`;
      const job = await tx.redemptionOutbox.findUnique({ where: { orderId: id } });
      await tx.$queryRaw`SELECT id FROM redemption_picking_tasks WHERE order_id=${id}::uuid FOR UPDATE`;
      const task = await tx.redemptionPickingTask.findUnique({ where: { orderId: id } });
      if (
        !job ||
        job.state === 'CANCELED' ||
        task?.state === 'CLAIMED' ||
        task?.state === 'CHECKED'
      )
        throw failure(409, 'CANCELLATION_REVIEW_REQUIRED', '履约已开始或待办异常，需人工核实');
      for (const a of await tx.redemptionAllocation.findMany({
        where: { orderId: id },
        orderBy: [{ lotId: 'asc' }, { positionId: 'asc' }],
      })) {
        if (a.releaseLedgerId)
          throw failure(409, 'RESERVATION_RECONCILIATION_REQUIRED', '库存释放凭据需核查');
        const releaseLedgerId = await orderReservationDelta(
          tx,
          a,
          true,
          r.requestId,
          userId,
          'REDEMPTION',
        );
        await tx.redemptionAllocation.update({ where: { id: a.id }, data: { releaseLedgerId } });
      }
      await tx.pointsAccount.update({
        where: { userId },
        data: { balance: { increment: order.totalPoints }, version: { increment: 1 } },
      });
      await tx.pointsEntry.create({
        data: {
          id: randomUUID(),
          userId,
          delta: order.totalPoints,
          actionKey: 'REDEMPTION_CANCEL:' + id,
          reason: '兑换取消退还积分',
          consumerActorId: userId,
          redemptionId: id,
          redemptionAction: 'CANCEL',
        },
      });
      if (task) {
        if (task.state !== 'READY')
          throw failure(409, 'CANCELLATION_REVIEW_REQUIRED', '拣货状态需人工核实');
        await tx.redemptionPickingTask.update({
          where: { id: task.id },
          data: { state: 'CANCELED', version: { increment: 1 } },
        });
        await tx.redemptionPickingEvent.create({
          data: {
            id: randomUUID(),
            taskId: task.id,
            orderId: id,
            action: 'CANCELED',
            consumerActorId: userId,
            requestId: r.requestId,
          },
        });
      }
      await redemptionJobChange(
        tx,
        job,
        { state: 'CANCELED', leaseToken: null, leaseUntil: null, lastErrorCode: null },
        'CANCELED',
        r.requestId,
      );
      await tx.redemptionOrder.update({
        where: { id },
        data: { status: 'CANCELED', canceledAt: await this.clock(tx), version: { increment: 1 } },
      });
      await tx.redemptionEvent.create({
        data: {
          id: randomUUID(),
          orderId: id,
          type: 'REDEMPTION_CANCELED',
          consumerActorId: userId,
          requestId: r.requestId,
        },
      });
      return { id };
    });
  }
  private dto(
    row: Prisma.RedemptionOrderGetPayload<{
      include: {
        outbox: true;
        pickingTask: {
          include: {
            pack: {
              include: {
                shipment: {
                  include: {
                    assignments: {
                      include: {
                        handoff: {
                          include: { journey: true; exceptions: { include: { resolution: true } } };
                        };
                      };
                    };
                  };
                };
              };
            };
          };
        };
      };
    }>,
    consumer: boolean,
  ) {
    return {
      id: row.id,
      orderNo: row.orderNo,
      status: row.status,
      title: row.title,
      name: row.name,
      spec: row.spec,
      unit: row.unit,
      quantity: row.quantity,
      pointsPrice: row.pointsPrice.toString(),
      totalPoints: row.totalPoints.toString(),
      createdAt: row.createdAt.toISOString(),
      canceledAt: row.canceledAt?.toISOString() ?? null,
      version: row.version,
      deliveryExceptionReported:
        !!row.pickingTask?.pack?.shipment?.assignments[0]?.handoff?.exceptions.some(
          (e) => !e.resolution,
        ),
      fulfillmentState:
        row.status === 'CANCELED'
          ? 'CANCELED'
          : row.pickingTask?.pack?.shipment?.assignments[0]?.handoff?.journey.some(
                (f) => f.kind === 'COMPLETE',
              )
            ? 'DELIVERED'
            : row.pickingTask?.pack?.shipment?.assignments[0]?.handoff?.journey.some(
                  (f) => f.kind === 'START',
                )
              ? 'DELIVERING'
              : row.pickingTask?.pack?.shipment?.assignments[0]?.handoff
                ? 'RIDER_RECEIVED_WAIT_START'
                : row.pickingTask?.pack?.shipment?.assignments[0]
                  ? 'ASSIGNED_WAIT_HANDOFF'
                  : row.pickingTask?.pack?.shipment
                    ? 'SHIPPED_WAIT_HANDOFF'
                    : row.pickingTask?.pack
                      ? 'PACKED_WAIT_SHIP'
                      : row.pickingTask?.state === 'CHECKED'
                        ? 'PICKED_WAIT_PACK'
                        : row.pickingTask?.state === 'CLAIMED'
                          ? 'PICKING'
                          : row.pickingTask?.state === 'READY'
                            ? 'READY_TO_PICK'
                            : row.outbox?.state === 'FAILED'
                              ? 'REVIEW_REQUIRED'
                              : row.outbox
                                ? 'PENDING'
                                : 'MISSING',
      ...(consumer
        ? {
            address: this.privateData.decrypt<ConsumerOrderAddress>(
              row.userId,
              row.id,
              row.addressPayload,
            ),
          }
        : {}),
    };
  }
  async list(r: ApiRequest, q: unknown, admin = false, id?: string) {
    const b = fields(q, admin ? ['cursor', 'status', 'keyword'] : ['cursor', 'status']);
    const cursor = b.cursor === undefined ? null : uuid(b.cursor),
      status = b.status === undefined ? null : str(b.status, 16);
    if (status && !['ACTIVE', 'CANCELED'].includes(status))
      throw failure(400, 'VALIDATION_ERROR', '兑换单状态无效');
    const keyword = b.keyword === undefined ? '' : str(b.keyword, 80);
    if (keyword.length > 80) throw failure(400, 'VALIDATION_ERROR', '搜索词过长');
    return this.catalog.db.$transaction(async (tx) => {
      const userId = admin ? undefined : await this.checkout.session(tx, r),
        warehouseId = admin ? await this.staff.authorize(r, tx) : undefined;
      const where: Prisma.RedemptionOrderWhereInput = {
        ...(userId ? { userId } : {}),
        ...(warehouseId ? { warehouseId } : {}),
        ...(status ? { status } : {}),
        ...(id ? { id } : {}),
        ...(keyword
          ? { OR: [{ orderNo: { contains: keyword } }, { title: { contains: keyword } }] }
          : {}),
      };
      if (cursor && !(await tx.redemptionOrder.findFirst({ where: { ...where, id: cursor } })))
        throw failure(409, 'CURSOR_INVALID', '分页位置已变化，请重新读取');
      const rows = await tx.redemptionOrder.findMany({
        where: { ...where, ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: 'asc' },
        take: 21,
        include: {
          outbox: true,
          pickingTask: {
            include: {
              pack: {
                include: {
                  shipment: {
                    include: {
                      assignments: {
                        where: { withdrawal: null },
                        include: {
                          handoff: {
                            include: {
                              journey: true,
                              exceptions: { include: { resolution: true } },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });
      if (id && !rows.length) throw failure(404, 'REDEMPTION_NOT_FOUND', '未找到可访问的兑换单');
      const items = rows.slice(0, 20).map((row) => this.dto(row, !admin));
      return { items, nextCursor: rows.length > 20 ? items.at(-1)!.id : null };
    });
  }
  async detail(r: ApiRequest, id: string, admin = false) {
    if (!admin) return (await this.list(r, {}, false, id)).items[0]!;
    return this.catalog.db.$transaction(async (tx) => {
      const warehouseId = await this.staff.authorize(r, tx);
      const row = await tx.redemptionOrder.findFirst({
        where: { id, warehouseId },
        include: {
          outbox: true,
          pickingTask: {
            include: {
              pack: {
                include: {
                  shipment: {
                    include: {
                      assignments: {
                        where: { withdrawal: null },
                        include: {
                          handoff: {
                            include: {
                              journey: true,
                              exceptions: { include: { resolution: true } },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      });
      if (!row) throw failure(404, 'REDEMPTION_NOT_FOUND', '未找到可访问的兑换单');
      const allocations = await tx.redemptionAllocation.findMany({
        where: { orderId: id },
        orderBy: { id: 'asc' },
        select: {
          quantity: true,
          releaseLedgerId: true,
          consumeLedgerId: true,
          position: {
            select: {
              location: { select: { code: true, name: true } },
              lot: { select: { batchNo: true } },
            },
          },
        },
      });
      const events = await tx.redemptionEvent.findMany({
        where: { orderId: id },
        orderBy: { createdAt: 'asc' },
        select: { type: true, createdAt: true },
      });
      return {
        ...this.dto(row, false),
        allocations: allocations.map((a) => ({
          quantity: a.quantity,
          batchNo: a.position.lot.batchNo,
          locationName: a.position.location.name,
          locationCode: a.position.location.code,
          reserved: true,
          released: !!a.releaseLedgerId,
          consumed: !!a.consumeLedgerId,
        })),
        events: events.map((e) => ({ type: e.type, createdAt: e.createdAt.toISOString() })),
      };
    });
  }
}
