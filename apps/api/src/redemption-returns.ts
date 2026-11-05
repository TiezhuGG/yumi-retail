import { createHash, randomUUID } from 'node:crypto';
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
  Header,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCookieAuth,
  ApiHeader,
  ApiTags,
  ApiQuery,
} from '@nestjs/swagger';
import type { Prisma } from '@yumi/database';
import type { RedemptionReturnPage, RedemptionReturnView } from '@yumi/contracts';
import { RedemptionAfterSalesService } from './redemption-after-sales.js';
import { Consumer, Permissions } from './staff-guard.js';
import { fields, integer, key, str, uuid } from './catalog-input.js';
import { success, failure, type ApiRequest } from './http.js';
import { ApiResult, object, text } from './api-result.js';
type Tx = Prisma.TransactionClient;
const include = {
  events: {
    orderBy: { createdAt: 'asc' as const },
    include: { actor: { select: { displayName: true } } },
  },
  order: true,
};
export class RedemptionReturnsService {
  constructor(readonly base: RedemptionAfterSalesService) {}
  get catalog() {
    return this.base.catalog;
  }
  async source(tx: Tx, orderId: string, user?: string, w?: string) {
    const o = await this.base.source(tx, orderId, user, w);
    if (o.status !== 'ACTIVE' || !o.expressShipment || o.outbox?.state !== 'EXPRESS_SHIPPED')
      throw failure(409, 'SHIPPED_ORDER_REQUIRED', '仅已发货的有效快递订单可申请此售后');
    return o;
  }
  async page(tx: Tx, orderId: string, user?: string, w?: string): Promise<RedemptionReturnPage> {
    const o = await this.source(tx, orderId, user, w);
    const rows = await tx.redemptionReturn.findMany({
      where: { orderId },
      include,
      orderBy: { createdAt: 'asc' },
    });
    const used = rows
      .filter((x) => !x.events.some((e) => ['REJECT', 'CANCEL'].includes(e.kind)))
      .reduce((sum, x) => sum + x.quantity, 0);
    const items: RedemptionReturnView[] = rows.map((x) => {
      const approved = x.events.find((e) => e.kind === 'APPROVE');
      const state = x.events.some((e) => e.kind === 'REFUND')
        ? 'REFUNDED'
        : x.events.some((e) => e.kind === 'REJECT')
          ? 'REJECTED'
          : x.events.some((e) => e.kind === 'CANCEL')
            ? 'CANCELED'
            : x.events.some((e) => e.kind === 'RECEIVE')
              ? 'READY_TO_REFUND'
              : approved
                ? approved.requiresReturn
                  ? 'WAIT_RETURN'
                  : 'READY_TO_REFUND'
                : 'REQUESTED';
      return {
        id: x.id,
        orderId,
        orderNo: o.orderNo,
        title: o.title,
        quantity: x.quantity,
        points: (BigInt(x.quantity) * o.pointsPrice).toString(),
        state,
        reason: this.base.privateData.decrypt<string>(o.userId, x.id, x.reasonPayload),
        createdAt: x.createdAt.toISOString(),
        requiresReturn: approved?.requiresReturn ?? null,
        events: x.events.map((e) => ({
          kind: e.kind,
          createdAt: e.createdAt.toISOString(),
          reason: this.base.privateData.decrypt<string>(o.userId, x.id, e.reasonPayload),
          quantity: e.quantity,
          condition: e.condition,
          location: e.location,
          staffName: user ? null : (e.actor?.displayName ?? null),
        })),
      };
    });
    return {
      orderId,
      remainingQuantity: o.quantity - used,
      unitPoints: o.pointsPrice.toString(),
      enabled: this.base.formalGate
        ? this.base.formalGate.canOperate(o.executionMode, this.base.enabled)
        : this.base.enabled,
      items,
    };
  }
  async consumerRead(r: ApiRequest, id: string) {
    return this.catalog.db.$transaction(async (tx) => {
      const u = await this.base.consumer(tx, r);
      const p = await this.page(tx, id, u);
      await this.base.consumer(tx, r);
      return p;
    });
  }
  async consumerWrite(r: ApiRequest, id: string, k: string, input: unknown, cancelId?: string) {
    const b = fields(input, cancelId ? [] : ['quantity', 'reason']);
    const quantity = cancelId ? null : integer(b.quantity, 1, 100000),
      reason = cancelId ? '用户撤销申请' : this.base.text(b.reason);
    return this.catalog.db.$transaction(
      async (tx) => {
        const u = await this.base.consumer(tx, r),
          scope = u + ':RETURN:' + id + (cancelId ? ':' + cancelId : ''),
          keyHash = createHash('sha256').update(k).digest('hex'),
          requestHash = createHash('sha256')
            .update(JSON.stringify({ quantity, reason, cancelId }))
            .digest('hex');
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope + ':' + keyHash},0))::text`;
        const o = await this.source(tx, id, u);
        const previous = await tx.idempotencyRecord.findUnique({
          where: { scope_keyHash: { scope, keyHash } },
        });
        if (previous) {
          if (previous.requestHash !== requestHash)
            throw failure(409, 'IDEMPOTENCY_CONFLICT', '原申请内容已变化');
          await this.base.consumer(tx, r);
          return previous.result;
        }
        this.base.gate(o.executionMode);
        await tx.$queryRaw`SELECT user_id FROM points_accounts WHERE user_id=${u}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM redemption_orders WHERE id=${id}::uuid FOR UPDATE`;
        const p = await this.page(tx, id, u);
        let resultId = cancelId;
        if (cancelId) {
          const v = p.items.find((x) => x.id === cancelId);
          if (!v) throw failure(404, 'RETURN_NOT_FOUND', '未找到本人申请');
          if (v.state !== 'REQUESTED')
            throw failure(409, 'RETURN_STATE_CHANGED', '已审核申请不能直接撤销');
          await tx.redemptionReturnEvent.create({
            data: {
              id: randomUUID(),
              returnId: cancelId,
              kind: 'CANCEL',
              reasonPayload: this.base.privateData.encrypt(u, cancelId, reason),
              requestId: r.requestId,
            },
          });
        } else {
          if (quantity! > p.remainingQuantity)
            throw failure(409, 'RETURN_QUANTITY_EXCEEDED', '申请中及已退数量不能超过原兑换件数');
          resultId = randomUUID();
          await tx.redemptionReturn.create({
            data: {
              id: resultId,
              orderId: id,
              userId: u,
              quantity: quantity!,
              reasonPayload: this.base.privateData.encrypt(u, resultId, reason),
              requestId: r.requestId,
            },
          });
        }
        await this.base.consumer(tx, r);
        const result = { id: resultId! };
        await tx.idempotencyRecord.create({ data: { scope, keyHash, requestHash, result } });
        return result;
      },
      { timeout: 15000, maxWait: 10000 },
    );
  }
  async adminRead(r: ApiRequest, input: unknown, id?: string) {
    const b = fields(input, ['cursor', 'keyword', 'status']),
      cursor = b.cursor === undefined ? undefined : uuid(b.cursor),
      keyword = b.keyword === undefined ? '' : str(b.keyword, 80),
      status = b.status === undefined ? '' : str(b.status, 24);
    if (
      status &&
      !['REQUESTED', 'WAIT_RETURN', 'READY_TO_REFUND', 'REFUNDED', 'REJECTED', 'CANCELED'].includes(
        status,
      )
    )
      throw failure(400, 'VALIDATION_ERROR', '售后筛选状态无效');
    return this.catalog.db.$transaction(async (tx) => {
      const w = await this.base.staff.authorize(r, tx);
      if (id) {
        const req = await tx.redemptionReturn.findFirst({
          where: { id, order: { warehouseId: w } },
        });
        if (!req) throw failure(404, 'RETURN_NOT_FOUND', '未找到本仓申请');
        const p = await this.page(tx, req.orderId, undefined, w);
        await this.base.staff.authorize(r, tx);
        return p;
      }
      const stateWhere: Prisma.RedemptionReturnWhereInput =
        status === 'REQUESTED'
          ? { events: { none: { kind: { in: ['APPROVE', 'REJECT', 'CANCEL'] } } } }
          : status === 'WAIT_RETURN'
            ? {
                AND: [
                  { events: { some: { kind: 'APPROVE', requiresReturn: true } } },
                  { events: { none: { kind: { in: ['RECEIVE', 'REFUND'] } } } },
                ],
              }
            : status === 'READY_TO_REFUND'
              ? {
                  AND: [
                    { events: { some: { kind: 'APPROVE' } } },
                    { events: { none: { kind: 'REFUND' } } },
                    {
                      OR: [
                        { events: { some: { kind: 'APPROVE', requiresReturn: false } } },
                        { events: { some: { kind: 'RECEIVE' } } },
                      ],
                    },
                  ],
                }
              : status
                ? {
                    events: {
                      some: {
                        kind:
                          status === 'REFUNDED'
                            ? 'REFUND'
                            : status === 'REJECTED'
                              ? 'REJECT'
                              : 'CANCEL',
                      },
                    },
                  }
                : {};
      const where: Prisma.RedemptionReturnWhereInput = {
        AND: [
          {
            order: {
              warehouseId: w,
              OR: [
                { title: { contains: keyword, mode: 'insensitive' } },
                { orderNo: { contains: keyword, mode: 'insensitive' } },
              ],
            },
          },
          stateWhere,
        ],
      };
      if (cursor && !(await tx.redemptionReturn.findFirst({ where: { ...where, id: cursor } })))
        throw failure(409, 'CURSOR_INVALID', '分页位置无效');
      const rows = await tx.redemptionReturn.findMany({
        where: { ...where, ...(cursor ? { id: { gt: cursor } } : {}) },
        select: { id: true, orderId: true },
        orderBy: { id: 'asc' },
        take: 21,
      });
      const items: RedemptionReturnView[] = [];
      for (const row of rows.slice(0, 20)) {
        const page = await this.page(tx, row.orderId, undefined, w);
        items.push(page.items.find((x) => x.id === row.id)!);
      }
      await this.base.staff.authorize(r, tx);
      return { items, nextCursor: rows.length > 20 ? items.at(-1)!.id : null };
    });
  }
  async action(r: ApiRequest, id: string, action: string, k: string, input: unknown) {
    if (!['approve', 'reject', 'receive', 'refund'].includes(action))
      throw failure(400, 'VALIDATION_ERROR', '售后动作无效');
    const b = fields(
      input,
      action === 'approve'
        ? ['requiresReturn', 'reason']
        : action === 'receive'
          ? ['quantity', 'condition', 'location', 'physicalConfirmed', 'reason']
          : action === 'refund'
            ? ['confirmed', 'reason']
            : ['reason'],
    );
    const reason = this.base.text(b.reason),
      requiresReturn = action === 'approve' ? b.requiresReturn : null;
    if (action === 'approve' && typeof requiresReturn !== 'boolean')
      throw failure(400, 'VALIDATION_ERROR', '须明确是否需要退货');
    const quantity = action === 'receive' ? integer(b.quantity, 1, 100000) : null,
      condition = action === 'receive' ? str(b.condition, 24) : null,
      location = action === 'receive' ? str(b.location, 100) : null;
    if (
      action === 'receive' &&
      (!['UNOPENED', 'DAMAGED', 'WRONG_ITEM'].includes(condition!) || b.physicalConfirmed !== true)
    )
      throw failure(400, 'PHYSICAL_CONFIRMATION_REQUIRED', '须核验全部退回实物并登记隔离位置');
    if (action === 'refund' && b.confirmed !== true)
      throw failure(400, 'REFUND_CONFIRMATION_REQUIRED', '须明确确认按原积分价退还');
    const w = await this.base.staff.authorize(r, undefined, true);
    const initial = await this.catalog.db.redemptionReturn.findFirst({
      where: { id, order: { warehouseId: w } },
      include: { order: true },
    });
    if (!initial) throw failure(404, 'RETURN_NOT_FOUND', '未找到本仓申请');
    return this.catalog.write(
      r,
      'RETURN_' + action,
      id,
      k,
      { reason, requiresReturn, quantity, condition, location },
      async (tx) => {
        await this.base.staff.authorize(r, tx, true);
        this.base.gate(initial.order.executionMode);
        await tx.$queryRaw`SELECT user_id FROM points_accounts WHERE user_id=${initial.userId}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM redemption_orders WHERE id=${initial.orderId}::uuid FOR UPDATE`;
        const p = await this.page(tx, initial.orderId, undefined, w),
          v = p.items.find((x) => x.id === id)!;
        if (
          (['approve', 'reject'].includes(action) && v.state !== 'REQUESTED') ||
          (action === 'receive' && (v.state !== 'WAIT_RETURN' || quantity !== v.quantity)) ||
          (action === 'refund' && v.state !== 'READY_TO_REFUND')
        )
          throw failure(409, 'RETURN_STATE_CHANGED', '阶段或完整退货件数不符，请刷新核实');
        let ledgerId: string | undefined;
        if (action === 'refund') {
          const value = BigInt(v.points);
          const account = await tx.pointsAccount.findUniqueOrThrow({
            where: { userId: initial.userId },
          });
          if (account.balance + value > 1000000000000000n)
            throw failure(409, 'POINTS_LIMIT_EXCEEDED', '积分余额超出保护上限，请人工核查');
          ledgerId = randomUUID();
          await tx.pointsAccount.update({
            where: { userId: initial.userId },
            data: { balance: { increment: value }, version: { increment: 1 } },
          });
          await tx.pointsEntry.create({
            data: {
              id: ledgerId,
              userId: initial.userId,
              delta: value,
              actorId: r.staffContext!.staffId,
              actionKey: 'RETURN_REFUND:' + id,
              reason: '售后退还积分',
            },
          });
        }
        await tx.redemptionReturnEvent.create({
          data: {
            id: randomUUID(),
            returnId: id,
            kind: action.toUpperCase(),
            actorId: r.staffContext!.staffId,
            requiresReturn: requiresReturn as boolean | null,
            quantity,
            condition,
            location,
            ledgerId,
            reasonPayload: this.base.privateData.encrypt(initial.userId, id, reason),
            requestId: r.requestId,
          },
        });
        await this.catalog.audit(tx, r, 'RETURN_' + action.toUpperCase(), initial.orderId, w);
        await this.base.staff.authorize(r, tx, true);
        return { id };
      },
    );
  }
}
const event = object({
  kind: text,
  createdAt: text,
  reason: text,
  quantity: { type: 'integer', nullable: true },
  condition: { ...text, nullable: true },
  location: { ...text, nullable: true },
  staffName: { ...text, nullable: true },
});
const view = object({
  id: text,
  orderId: text,
  orderNo: text,
  title: text,
  quantity: { type: 'integer' },
  points: text,
  state: text,
  reason: text,
  createdAt: text,
  requiresReturn: { type: 'boolean', nullable: true },
  events: { type: 'array', items: event },
});
const page = object({
  orderId: text,
  remainingQuantity: { type: 'integer' },
  unitPoints: text,
  enabled: { type: 'boolean' },
  items: { type: 'array', items: view },
});
const errors = [400, 401, 403, 404, 409, 500, 503];
@ApiTags('兑换退货与退积分')
@ApiBearerAuth('consumerSession')
@Consumer()
@Controller('consumer/redemptions/:id/returns')
export class ConsumerReturnsController {
  constructor(@Inject(RedemptionReturnsService) readonly service: RedemptionReturnsService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiResult(page, errors)
  async read(@Req() r: ApiRequest, @Param('id') id: string, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.consumerRead(r, uuid(id)));
  }
  @Post()
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: object({ quantity: { type: 'integer', minimum: 1 }, reason: text }) })
  @ApiResult(object({ id: text }), errors)
  async create(
    @Req() r: ApiRequest,
    @Param('id') id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.consumerWrite(r, uuid(id), key(r), b));
  }
  @Post(':returnId/cancel')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: object({}) })
  @ApiResult(object({ id: text }), errors)
  async cancel(
    @Req() r: ApiRequest,
    @Param('id') id: string,
    @Param('returnId') rid: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.consumerWrite(r, uuid(id), key(r), b, uuid(rid)));
  }
}
@ApiTags('兑换退货与退积分')
@ApiCookieAuth('staffSession')
@Controller('admin/redemption-returns')
export class AdminReturnsController {
  constructor(@Inject(RedemptionReturnsService) readonly service: RedemptionReturnsService) {}
  @Get()
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({ name: 'keyword', required: false })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['REQUESTED', 'WAIT_RETURN', 'READY_TO_REFUND', 'REFUNDED', 'REJECTED', 'CANCELED'],
  })
  @Permissions('points.read')
  @Header('Cache-Control', 'no-store')
  @ApiResult(
    object({ items: { type: 'array', items: view }, nextCursor: { ...text, nullable: true } }),
    errors,
  )
  async list(@Req() r: ApiRequest, @Query() q: unknown) {
    return success(r, await this.service.adminRead(r, q));
  }
  @Get(':id')
  @Permissions('points.read')
  @Header('Cache-Control', 'no-store')
  @ApiResult(page, errors)
  async read(@Req() r: ApiRequest, @Param('id') id: string, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.adminRead(r, {}, uuid(id)));
  }
  @Post(':id/:action')
  @HttpCode(200)
  @Permissions('returns.manage')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({
    schema: {
      oneOf: [
        object({ requiresReturn: { type: 'boolean' }, reason: text }),
        object({ reason: text }),
        object({
          quantity: { type: 'integer', minimum: 1 },
          condition: { type: 'string', enum: ['UNOPENED', 'DAMAGED', 'WRONG_ITEM'] },
          location: text,
          physicalConfirmed: { type: 'boolean', enum: [true] },
          reason: text,
        }),
        object({ confirmed: { type: 'boolean', enum: [true] }, reason: text }),
      ],
    },
  })
  @ApiResult(object({ id: text }), errors)
  async action(
    @Req() r: ApiRequest,
    @Param('id') id: string,
    @Param('action') a: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.action(r, uuid(id), str(a, 20), key(r), b));
  }
}
