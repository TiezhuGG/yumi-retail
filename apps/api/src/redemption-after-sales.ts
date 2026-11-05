import type { PointsExpressGate } from './points-express-gate.js';
import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@yumi/database';
import type { RedemptionAfterSalesView, RedemptionAfterSalesPage } from '@yumi/contracts';
import { CatalogService } from './catalog-service.js';
import { CheckoutService } from './checkout.js';
import { PointsGrantService } from './points-grants.js';
import { OrderPrivateData } from './order-private.js';
import { fields, integer, str, uuid } from './catalog-input.js';
import { failure, type ApiRequest } from './http.js';
type Tx = Prisma.TransactionClient;
const include = { events: { orderBy: { version: 'asc' as const } } } as const;
type Ticket = Prisma.RedemptionAfterSalesGetPayload<{ include: typeof include }>;
const categories = ['NOT_RECEIVED', 'DAMAGED', 'WRONG_ITEM', 'OTHER'];
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export class RedemptionAfterSalesService {
  readonly checkout: CheckoutService;
  readonly staff: PointsGrantService;
  readonly privateData: OrderPrivateData;
  constructor(
    readonly catalog: CatalogService,
    readonly enabled = false,
    key?: string,
    readonly formalGate?: PointsExpressGate,
  ) {
    this.checkout = new CheckoutService(catalog);
    this.staff = new PointsGrantService(catalog);
    this.privateData = new OrderPrivateData(key);
  }
  async consumer(tx: Tx, r: ApiRequest) {
    const user = await this.checkout.session(tx, r);
    const rows = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT s.id FROM consumer_sessions s JOIN consumer_users u ON u.id=s.user_id WHERE s.id=${r.consumerContext!.sessionId}::uuid AND u.id=${user}::uuid AND u.enabled AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND s.auth_version=u.auth_version`;
    if (!rows.length) throw failure(401, 'SESSION_EXPIRED', '登录在处理期间已失效，请重新登录核实');
    return user;
  }
  async source(tx: Tx, id: string, user?: string, warehouse?: string) {
    const o = await tx.redemptionOrder.findFirst({
      where: {
        id,
        ...(user ? { userId: user } : {}),
        ...(warehouse ? { warehouseId: warehouse } : {}),
      },
      include: { expressShipment: true, outbox: true },
    });
    if (!o) throw failure(404, 'REDEMPTION_NOT_FOUND', '未找到授权范围内的兑换单');
    if (o.deliveryMode !== 'EXPRESS')
      throw failure(409, 'EXPRESS_ORDER_REQUIRED', '此反馈入口仅支持快递兑换订单');
    return o;
  }
  gate(mode: string) {
    if (this.formalGate) {
      this.formalGate.assertOperate(mode, this.enabled);
      return;
    }
    if (!this.enabled) throw failure(503, 'AFTER_SALES_DISABLED', '售后反馈操作暂未开放');
  }
  text(v: unknown) {
    const s = str(v, 500);
    if (Array.from(s).some((c) => (c.charCodeAt(0) < 32 && c !== '\n') || c.charCodeAt(0) === 127))
      throw failure(400, 'VALIDATION_ERROR', '说明包含无效字符');
    return s;
  }
  async view(
    tx: Tx,
    id: string,
    user?: string,
    warehouse?: string,
  ): Promise<RedemptionAfterSalesView> {
    const o = await this.source(tx, id, user, warehouse);
    // Keep status/version and its separately loaded event history from straddling a write.
    await tx.$queryRaw`SELECT id FROM redemption_after_sales WHERE order_id=${id}::uuid FOR SHARE`;
    const c = await tx.redemptionAfterSales.findUnique({ where: { orderId: id }, include });
    return {
      orderId: o.id,
      orderNo: o.orderNo,
      title: o.title,
      spec: o.spec,
      quantity: o.quantity,
      enabled: this.formalGate
        ? this.formalGate.canOperate(o.executionMode, this.enabled)
        : this.enabled,
      canSubmit:
        (this.formalGate
          ? this.formalGate.canOperate(o.executionMode, this.enabled)
          : this.enabled) &&
        !c &&
        o.status === 'ACTIVE' &&
        o.outbox?.state === 'EXPRESS_SHIPPED' &&
        !!o.expressShipment,
      ticket: c
        ? {
            id: c.id,
            category: c.category as NonNullable<RedemptionAfterSalesView['ticket']>['category'],
            status: c.status as NonNullable<RedemptionAfterSalesView['ticket']>['status'],
            version: c.version,
            createdAt: c.createdAt.toISOString(),
            updatedAt: c.updatedAt.toISOString(),
            events: c.events.map((e) => ({
              version: e.version,
              kind: e.kind,
              status: e.status,
              message: this.privateData.decrypt<{ text: string }>(
                o.userId,
                'after-sales:' + e.id,
                e.messagePayload,
              ).text,
              actor: e.staffId ? 'STORE' : 'CUSTOMER',
              ...(!user && e.staffName ? { staffName: e.staffName } : {}),
              createdAt: e.createdAt.toISOString(),
            })),
          }
        : null,
    };
  }
  async readConsumer(r: ApiRequest, id: string) {
    return this.catalog.db.$transaction(async (tx) => {
      const u = await this.consumer(tx, r),
        v = await this.view(tx, id, u);
      await this.consumer(tx, r);
      return v;
    });
  }
  async listConsumer(r: ApiRequest, input: unknown): Promise<RedemptionAfterSalesPage> {
    const b = fields(input, ['status', 'keyword', 'cursor']),
      status = b.status === undefined ? '' : str(b.status, 20),
      keyword =
        b.keyword === undefined || (typeof b.keyword === 'string' && !b.keyword.trim())
          ? ''
          : str(b.keyword, 80),
      cursor = b.cursor === undefined ? undefined : uuid(b.cursor);
    if (status && !['OPEN', 'PROCESSING', 'CLOSED'].includes(status))
      throw failure(400, 'VALIDATION_ERROR', '反馈状态无效');
    const escape = String.fromCharCode(92),
      term = keyword
        .replaceAll(escape, escape + escape)
        .replaceAll('%', escape + '%')
        .replaceAll('_', escape + '_');
    return this.catalog.db.$transaction(
      async (tx) => {
        const user = await this.consumer(tx, r),
          where: Prisma.RedemptionAfterSalesWhereInput = {
            userId: user,
            order: {
              userId: user,
              deliveryMode: 'EXPRESS',
              ...(term
                ? {
                    OR: [
                      { title: { contains: term, mode: 'insensitive' } },
                      { orderNo: { contains: term, mode: 'insensitive' } },
                    ],
                  }
                : {}),
            },
            ...(status ? { status } : {}),
          };
        if (
          cursor &&
          !(await tx.redemptionAfterSales.findFirst({ where: { ...where, id: cursor } }))
        )
          throw failure(409, 'CURSOR_INVALID', '售后反馈已变化，请重新读取');
        const rows = await tx.redemptionAfterSales.findMany({
          where: { ...where, ...(cursor ? { id: { gt: cursor } } : {}) },
          include: { order: { select: { orderNo: true, title: true } } },
          orderBy: { id: 'asc' },
          take: 21,
        });
        await this.consumer(tx, r);
        return {
          items: rows.slice(0, 20).map((c) => ({
            orderId: c.orderId,
            orderNo: c.order.orderNo,
            title: c.order.title,
            category: c.category,
            status: c.status,
            createdAt: c.createdAt.toISOString(),
            updatedAt: c.updatedAt.toISOString(),
          })),
          nextCursor: rows.length > 20 ? rows[19]!.id : null,
        };
      },
      { isolationLevel: 'RepeatableRead', timeout: 15000 },
    );
  }
  async readStaff(r: ApiRequest, id: string) {
    return this.catalog.db.$transaction(async (tx) => {
      const w = await this.staff.authorize(r, tx),
        v = await this.view(tx, id, undefined, w);
      await this.staff.authorize(r, tx);
      return v;
    });
  }
  async list(r: ApiRequest, input: unknown): Promise<RedemptionAfterSalesPage> {
    const b = fields(input, ['status', 'keyword', 'cursor']),
      status = b.status === undefined ? undefined : str(b.status, 20),
      keyword = b.keyword === undefined ? '' : str(b.keyword, 80),
      cursor = b.cursor === undefined ? undefined : uuid(b.cursor);
    if (status && !['OPEN', 'PROCESSING', 'CLOSED'].includes(status))
      throw failure(400, 'VALIDATION_ERROR', '反馈状态无效');
    return this.catalog.db.$transaction(async (tx) => {
      const w = await this.staff.authorize(r, tx),
        rows = await tx.redemptionAfterSales.findMany({
          where: {
            warehouseId: w,
            ...(status ? { status } : {}),
            ...(cursor ? { id: { gt: cursor } } : {}),
            ...(keyword
              ? {
                  order: {
                    OR: [
                      { orderNo: { contains: keyword, mode: 'insensitive' } },
                      { title: { contains: keyword, mode: 'insensitive' } },
                    ],
                  },
                }
              : {}),
          },
          include: { order: true },
          orderBy: { id: 'asc' },
          take: 21,
        });
      await this.staff.authorize(r, tx);
      return {
        items: rows.slice(0, 20).map((c) => ({
          orderId: c.orderId,
          orderNo: c.order.orderNo,
          title: c.order.title,
          category: c.category,
          status: c.status,
          createdAt: c.createdAt.toISOString(),
          updatedAt: c.updatedAt.toISOString(),
        })),
        nextCursor: rows.length > 20 ? rows[19]!.id : null,
      };
    });
  }
  async event(
    tx: Tx,
    r: ApiRequest,
    c: Ticket | { id: string; userId: string; createdAt: Date },
    kind: string,
    status: string,
    version: number,
    message: string,
    staff: boolean,
  ) {
    const id = randomUUID(),
      now =
        version === 0
          ? c.createdAt
          : (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]!.now;
    const actor = staff
      ? await tx.staff.findUniqueOrThrow({ where: { id: r.staffContext!.staffId } })
      : null;
    await tx.redemptionAfterSalesEvent.create({
      data: {
        id,
        caseId: c.id,
        version,
        kind,
        status,
        messagePayload: this.privateData.encrypt(c.userId, 'after-sales:' + id, { text: message }),
        consumerId: staff ? null : c.userId,
        staffId: actor?.id ?? null,
        staffName: actor?.displayName ?? null,
        requestId: r.requestId,
        createdAt: now,
      },
    });
    // Source fields are immutable; this is a projection of the complete event chain.
    if (version > 0)
      await tx.redemptionAfterSales.update({
        where: { id: c.id },
        data: { status, version, updatedAt: now },
      });
  }
  async consumerAction(
    r: ApiRequest,
    id: string,
    key: string,
    kind: 'SUBMITTED' | 'SUPPLEMENTED' | 'REOPENED',
    input: unknown,
  ) {
    const b = fields(
        input,
        kind === 'SUBMITTED' ? ['category', 'message'] : ['version', 'message'],
      ),
      message = this.text(b.message),
      version = kind === 'SUBMITTED' ? 0 : integer(b.version, 0, 2147483646),
      category = kind === 'SUBMITTED' ? str(b.category, 24) : undefined;
    if (category && !categories.includes(category))
      throw failure(400, 'VALIDATION_ERROR', '请选择有效问题类型');
    try {
      return await this.catalog.db.$transaction(
        async (tx) => {
          const u = await this.consumer(tx, r),
            scope = u + ':REDEMPTION_AFTER_SALES:' + kind + ':' + id,
            keyHash = hash(key),
            requestHash = hash({ message, version, category });
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope + ':' + keyHash},0))::text`;
          await this.source(tx, id, u);
          const previous = await tx.idempotencyRecord.findUnique({
            where: { scope_keyHash: { scope, keyHash } },
          });
          if (previous) {
            if (previous.requestHash !== requestHash)
              throw failure(409, 'IDEMPOTENCY_CONFLICT', '原反馈请求内容已变化');
            await this.consumer(tx, r);
            return previous.result;
          }
          this.gate((await this.source(tx, id, u)).executionMode);
          await tx.$queryRaw`SELECT id FROM redemption_orders WHERE id=${id}::uuid FOR UPDATE`;
          const o = await this.source(tx, id, u),
            c = await tx.redemptionAfterSales.findUnique({ where: { orderId: id }, include });
          if (o.status !== 'ACTIVE' || o.outbox?.state !== 'EXPRESS_SHIPPED' || !o.expressShipment)
            throw failure(409, 'EXPRESS_SHIPMENT_REQUIRED', '仅已快递发货订单可提交售后反馈');
          if (kind === 'SUBMITTED') {
            if (c) throw failure(409, 'AFTER_SALES_EXISTS', '本单已有反馈，请刷新查看并补充说明');
            const caseId = randomUUID();
            const now = (
              await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
            )[0]!.now;
            const created = await tx.redemptionAfterSales.create({
              data: {
                id: caseId,
                orderId: id,
                userId: u,
                warehouseId: o.warehouseId,
                category: category!,
                createdAt: now,
                updatedAt: now,
              },
            });
            await this.event(tx, r, created, kind, 'OPEN', 0, message, false);
          } else {
            if (!c) throw failure(409, 'AFTER_SALES_REQUIRED', '请先提交问题反馈');
            if (c.version !== version)
              throw failure(409, 'VERSION_CONFLICT', '反馈进度已变化，请刷新后再操作');
            if ((kind === 'REOPENED') !== (c.status === 'CLOSED'))
              throw failure(409, 'INVALID_TRANSITION', '反馈状态已变化，请刷新核实');
            await this.event(
              tx,
              r,
              c,
              kind,
              kind === 'REOPENED' ? 'OPEN' : c.status,
              version + 1,
              message,
              false,
            );
          }
          await this.consumer(tx, r);
          const result = { orderId: id };
          await tx.idempotencyRecord.create({ data: { scope, keyHash, requestHash, result } });
          return result;
        },
        { timeout: 15000, maxWait: 10000 },
      );
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(e.code))
        throw failure(503, 'RETRYABLE_CONFLICT', '并发变化，请使用原请求核实');
      throw e;
    }
  }
  async staffAction(
    r: ApiRequest,
    id: string,
    key: string,
    kind: 'REPLIED' | 'CLOSED',
    input: unknown,
  ) {
    const b = fields(input, ['version', 'message']),
      version = integer(b.version, 0, 2147483646),
      message = this.text(b.message),
      w = await this.staff.authorize(r);
    await this.source(this.catalog.db, id, undefined, w);
    return this.catalog.write(
      r,
      'REDEMPTION_AFTER_SALES_' + kind,
      w + ':' + id,
      key,
      { version, message },
      async (tx) => {
        await this.staff.authorize(r, tx);
        this.gate((await this.source(tx, id, undefined, w)).executionMode);
        await tx.$queryRaw`SELECT id FROM redemption_orders WHERE id=${id}::uuid FOR UPDATE`;
        await this.source(tx, id, undefined, w);
        const c = await tx.redemptionAfterSales.findUnique({ where: { orderId: id }, include });
        if (!c) throw failure(404, 'AFTER_SALES_NOT_FOUND', '未找到本单反馈');
        if (c.version !== version)
          throw failure(409, 'VERSION_CONFLICT', '反馈进度已变化，请刷新后再操作');
        if (c.status === 'CLOSED')
          throw failure(409, 'INVALID_TRANSITION', '本次反馈已结束，等待用户需要时重新反馈');
        await this.event(
          tx,
          r,
          c,
          kind,
          kind === 'CLOSED' ? 'CLOSED' : 'PROCESSING',
          version + 1,
          message,
          true,
        );
        await this.catalog.audit(tx, r, 'REDEMPTION_AFTER_SALES_' + kind, id, w);
        await this.staff.authorize(r, tx);
        return { orderId: id };
      },
    );
  }
}
