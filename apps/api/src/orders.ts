import { inventoryLocks, metadataLocks } from './reservation-locks.js';
import { randomUUID, createHmac } from 'node:crypto';
import { Prisma, orderReservationDelta, releaseUnpaidOrder } from '@yumi/database';
import type { CheckoutPreview, ConsumerOrder, ConsumerOrderAddress } from '@yumi/contracts';
import { CheckoutService } from './checkout.js';
import { ConsumerAddressService } from './consumer-address.js';
import { OrderPrivateData } from './order-private.js';
import { fields, str, uuid } from './catalog-input.js';
import { failure } from './http.js';
import type { ApiRequest } from './http.js';
export class OrderService {
  private readonly privateData: OrderPrivateData;
  constructor(
    readonly checkout: CheckoutService,
    readonly addresses: ConsumerAddressService,
    key?: string,
    readonly holdSeconds = 900,
  ) {
    this.privateData = new OrderPrivateData(key);
  }
  private get db() {
    return this.checkout.catalog.db;
  }
  private async clock(tx: Prisma.TransactionClient) {
    const rows = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    return rows[0]!.now;
  }
  private sameQuote(old: CheckoutPreview, fresh: CheckoutPreview) {
    return (
      fresh.ready &&
      old.addressVersion === fresh.addressVersion &&
      old.cartVersion === fresh.cartVersion &&
      old.areaVersion === fresh.areaVersion &&
      old.policy?.version === fresh.policy?.version &&
      old.goodsCents === fresh.goodsCents &&
      old.deliveryFeeCents === fresh.deliveryFeeCents &&
      old.payableCents === fresh.payableCents &&
      JSON.stringify(
        old.lines.map((i) => ({
          id: i.skuId,
          q: i.quantity,
          p: i.priceCents,
          name: i.name,
          spec: i.spec,
          unit: i.unit,
        })),
      ) ===
        JSON.stringify(
          fresh.lines.map((i) => ({
            id: i.skuId,
            q: i.quantity,
            p: i.priceCents,
            name: i.name,
            spec: i.spec,
            unit: i.unit,
          })),
        )
    );
  }
  async create(request: ApiRequest, key: string, body: unknown) {
    const input = fields(body, ['quoteId', 'note']);
    const quoteId = uuid(input.quoteId),
      note = input.note === undefined || input.note === '' ? '' : str(input.note, 200);
    if (Array.from(note).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127))
      throw failure(400, 'VALIDATION_ERROR', '备注不能含控制字符');
    if (!this.checkout.orderDevSubmit)
      throw failure(503, 'ORDER_SUBMISSION_DISABLED', '订单提交基础尚未开放');
    const digest = createHmac('sha256', this.privateData.key())
      .update(JSON.stringify({ quoteId, note }))
      .digest('hex');
    try {
      return await this.db.$transaction(
        async (tx) => {
          const userId = await this.checkout.session(tx, request);
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId + ':orders'},0))::text`;
          const replay = await tx.consumerOrder.findUnique({
            where: { userId_key: { userId, key } },
          });
          if (replay) {
            if (replay.digest !== digest)
              throw failure(409, 'IDEMPOTENCY_CONFLICT', '原下单操作内容已改变，请先核实订单');
            return { id: replay.id };
          }
          await tx.$queryRaw`SELECT id FROM checkout_quotes WHERE id=${quoteId}::uuid FOR UPDATE`;
          const quote = await tx.checkoutQuote.findFirst({ where: { id: quoteId, userId } });
          if (!quote) throw failure(404, 'QUOTE_NOT_FOUND', '未找到本人该报价');
          if (await tx.consumerOrder.findUnique({ where: { quoteId } }))
            throw failure(409, 'QUOTE_ALREADY_USED', '此报价已生成订单，请先查看订单');
          if (quote.expiresAt <= (await this.clock(tx)))
            throw failure(409, 'QUOTE_EXPIRED', '报价已过期，请重新核验');
          if (
            (await tx.consumerOrder.count({ where: { userId, status: 'AWAITING_PAYMENT' } })) >= 5
          )
            throw failure(409, 'UNPAID_ORDER_LIMIT', '最多保留5个待处理订单，请先处理已有订单');
          const snapshot = quote.snapshot as unknown as CheckoutPreview;
          await this.checkout.preview(tx, userId, {
            addressId: snapshot.addressId,
            addressVersion: snapshot.addressVersion,
            cartVersion: snapshot.cartVersion,
          });
          const ids = snapshot.lines.map((i) => i.skuId).sort();
          await metadataLocks(tx, ids);
          const warehouseId = this.checkout.catalog.publicWarehouseId!;
          await inventoryLocks(tx, warehouseId, ids);
          const fresh = await this.checkout.preview(tx, userId, {
            addressId: snapshot.addressId,
            addressVersion: snapshot.addressVersion,
            cartVersion: snapshot.cartVersion,
          });
          if (!this.sameQuote(snapshot, fresh))
            throw failure(409, 'QUOTE_CHANGED', '商品、价格、地址或规则已变化，请重新核验报价');
          const address = await tx.consumerAddress.findFirstOrThrow({
              where: { id: snapshot.addressId, userId, deleted: false },
            }),
            area = await tx.serviceArea.findUniqueOrThrow({ where: { id: address.areaId } }),
            building = await tx.serviceBuilding.findUniqueOrThrow({
              where: { id: address.buildingId },
            });
          const now = await this.clock(tx);
          if (quote.expiresAt <= now) throw failure(409, 'QUOTE_EXPIRED', '报价已过期，请重新核验');
          const id = randomUUID(),
            orderNo =
              'Y' +
              now.toISOString().replace(/[-:TZ.]/g, '') +
              id.replaceAll('-', '').slice(0, 12).toUpperCase();
          const addressPayload = this.privateData.encrypt(userId, id, {
            areaName: area.name,
            buildingName: building.name,
            ...this.addresses.decryptSnapshot(userId, address.id, address.payload!),
            orderNote: note,
          });
          await tx.consumerOrder.create({
            data: {
              id,
              userId,
              warehouseId,
              quoteId,
              key,
              digest,
              orderNo,
              goodsCents: fresh.goodsCents!,
              deliveryFeeCents: fresh.deliveryFeeCents!,
              payableCents: fresh.payableCents!,
              addressPayload,
              createdAt: now,
              paymentDeadline: new Date(now.getTime() + this.holdSeconds * 1000),
            },
          });
          for (const line of fresh.lines) {
            await tx.orderItem.create({
              data: {
                id: randomUUID(),
                orderId: id,
                skuId: line.skuId,
                name: line.name,
                spec: line.spec,
                unit: line.unit,
                quantity: line.quantity,
                priceCents: line.priceCents!,
                lineCents: line.lineCents!,
              },
            });
            const positions = await tx.stockPosition.findMany({
              where: {
                warehouseId,
                skuId: line.skuId,
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
            let remaining = line.quantity;
            const lotFree = new Map<string, number>();
            for (const p of positions) {
              if (!remaining) break;
              const free = lotFree.get(p.lotId) ?? p.lot.onHand - p.lot.reserved - p.lot.blocked;
              const q = Math.min(remaining, p.onHand - p.reserved - p.blocked, free);
              if (q <= 0) continue;
              const allocation = {
                id: randomUUID(),
                orderId: id,
                warehouseId,
                skuId: line.skuId,
                lotId: p.lotId,
                positionId: p.id,
                quantity: q,
              };
              const reserveLedgerId = await orderReservationDelta(
                tx,
                allocation,
                false,
                request.requestId,
                userId,
              );
              await tx.orderAllocation.create({ data: { ...allocation, reserveLedgerId } });
              remaining -= q;
              lotFree.set(p.lotId, free - q);
            }
            if (remaining)
              throw failure(
                409,
                'INSUFFICIENT_STOCK',
                '批次可售库存已变化，本单未创建，请重新核验',
              );
          }
          const finalClock = await this.clock(tx);
          if (
            quote.expiresAt <= finalClock ||
            (await tx.stockLot.count({
              where: {
                id: {
                  in: (
                    await tx.orderAllocation.findMany({
                      where: { orderId: id },
                      select: { lotId: true },
                    })
                  ).map((a) => a.lotId),
                },
                expiresAt: { lte: finalClock },
              },
            }))
          )
            throw failure(409, 'QUOTE_CHANGED', '报价或批次已过期，本单未创建，请重新核验');
          await tx.orderEvent.create({
            data: {
              id: randomUUID(),
              orderId: id,
              type: 'ORDER_CREATED',
              actorKind: 'CONSUMER',
              requestId: request.requestId,
              payload: {},
              state: 'PENDING',
            },
          });
          return { id };
        },
        { timeout: 15000, maxWait: 10000 },
      );
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && ['P2034', 'P2002'].includes(e.code))
        throw failure(503, 'RETRYABLE_CONFLICT', '并发变化，请使用原下单操作重试');
      throw e;
    }
  }
  private dto(row: {
    id: string;
    userId: string;
    orderNo: string;
    status: string;
    paymentState: string;
    fulfillmentState: string;
    goodsCents: bigint;
    deliveryFeeCents: bigint;
    payableCents: bigint;
    addressPayload: string;
    createdAt: Date;
    paymentDeadline: Date;
    cancelReason: string | null;
    version: number;
    items: Array<{
      skuId: string;
      name: string;
      spec: string;
      unit: string;
      quantity: number;
      priceCents: bigint;
      lineCents: bigint;
    }>;
  }): ConsumerOrder {
    return {
      id: row.id,
      orderNo: row.orderNo,
      status: row.status as ConsumerOrder['status'],
      paymentState: row.paymentState as ConsumerOrder['paymentState'],
      fulfillmentState: row.fulfillmentState as ConsumerOrder['fulfillmentState'],
      goodsCents: Number(row.goodsCents),
      deliveryFeeCents: Number(row.deliveryFeeCents),
      payableCents: Number(row.payableCents),
      createdAt: row.createdAt.toISOString(),
      paymentDeadline: row.paymentDeadline.toISOString(),
      cancelReason: row.cancelReason,
      version: row.version,
      address: this.privateData.decrypt<ConsumerOrderAddress>(
        row.userId,
        row.id,
        row.addressPayload,
      ),
      items: row.items.map((i) => ({
        skuId: i.skuId,
        name: i.name,
        spec: i.spec,
        unit: i.unit,
        quantity: i.quantity,
        priceCents: Number(i.priceCents),
        lineCents: Number(i.lineCents),
      })),
    };
  }
  async read(request: ApiRequest, id: string) {
    return this.db.$transaction(async (tx) => {
      const userId = await this.checkout.session(tx, request);
      const row = await tx.consumerOrder.findFirst({
        where: { id, userId },
        include: { items: { orderBy: { skuId: 'asc' } } },
      });
      if (!row) throw failure(404, 'ORDER_NOT_FOUND', '未找到本人该订单');
      return this.dto(row);
    });
  }
  async list(request: ApiRequest, cursor?: string) {
    return this.db.$transaction(async (tx) => {
      const userId = await this.checkout.session(tx, request);
      const anchor = cursor
        ? await tx.consumerOrder.findFirst({
            where: { id: cursor, userId },
            select: { createdAt: true, id: true },
          })
        : null;
      if (cursor && !anchor) throw failure(404, 'ORDER_NOT_FOUND', '订单分页位置已无效，请刷新');
      const rows = await tx.consumerOrder.findMany({
        where: {
          userId,
          ...(anchor
            ? {
                OR: [
                  { createdAt: { lt: anchor.createdAt } },
                  { createdAt: anchor.createdAt, id: { lt: anchor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 21,
        include: { items: { orderBy: { skuId: 'asc' } } },
      });
      const hasMore = rows.length > 20,
        visible = rows.slice(0, 20);
      return {
        items: visible.map((row) => this.dto(row)),
        hasMore,
        nextCursor: hasMore ? visible.at(-1)!.id : null,
      };
    });
  }
  async cancel(request: ApiRequest, id: string) {
    return this.db.$transaction(async (tx) => {
      const userId = await this.checkout.session(tx, request);
      await tx.$queryRaw`SELECT id FROM consumer_orders WHERE id=${id}::uuid AND user_id=${userId}::uuid FOR UPDATE`;
      const row = await tx.consumerOrder.findFirst({ where: { id, userId } });
      if (!row) throw failure(404, 'ORDER_NOT_FOUND', '未找到本人该订单');
      if (row.status === 'CANCELED') return { id };
      if (row.paymentState !== 'NOT_STARTED' || row.status !== 'AWAITING_PAYMENT')
        throw failure(409, 'PAYMENT_RECONCILIATION_REQUIRED', '支付状态需核实，不能直接释放库存');
      await releaseUnpaidOrder(tx, row, 'CONSUMER_CANCEL', request.requestId);
      return { id };
    });
  }
}
