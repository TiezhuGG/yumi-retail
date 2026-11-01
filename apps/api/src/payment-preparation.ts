import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@yumi/database';
import type { PaymentPreparation } from '@yumi/contracts';
import { CheckoutService } from './checkout.js';
import { fields, key, uuid } from './catalog-input.js';
import { Consumer } from './staff-guard.js';
import { failure, success } from './http.js';
import type { ApiRequest } from './http.js';
import { ApiResult, object, text } from './api-result.js';
export const preparationSelect = {
  id: true,
  state: true,
  channel: true,
  amountCents: true,
  currency: true,
  preparedAt: true,
  closedAt: true,
  closeReason: true,
} as const;
export function preparationDto(
  p: Prisma.PaymentPreparationGetPayload<{ select: typeof preparationSelect }>,
): PaymentPreparation {
  return {
    id: p.id,
    state: p.state as PaymentPreparation['state'],
    channel: p.channel as 'DISABLED',
    amountCents: Number(p.amountCents),
    currency: p.currency as 'CNY',
    preparedAt: p.preparedAt.toISOString(),
    closedAt: p.closedAt?.toISOString() ?? null,
    closeReason: p.closeReason as PaymentPreparation['closeReason'],
  };
}
export class PaymentPreparationService {
  constructor(readonly checkout: CheckoutService) {}
  async read(r: ApiRequest, orderId: string) {
    return this.checkout.catalog.db.$transaction(async (tx) => {
      const userId = await this.checkout.session(tx, r);
      const order = await tx.consumerOrder.findFirst({
        where: { id: orderId, userId },
        select: { paymentPreparation: { select: preparationSelect } },
      });
      if (!order) throw failure(404, 'ORDER_NOT_FOUND', '未找到本人该订单');
      return {
        enabled: this.checkout.orderDevSubmit,
        intent: order.paymentPreparation ? preparationDto(order.paymentPreparation) : null,
      };
    });
  }
  async prepare(r: ApiRequest, orderId: string, key: string) {
    if (!this.checkout.orderDevSubmit)
      throw failure(503, 'PAYMENT_PREPARATION_DISABLED', '支付准备仅供本机开发，当前未开放');
    try {
      return await this.checkout.catalog.db.$transaction(
        async (tx) => {
          const userId = await this.checkout.session(tx, r);
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${userId + ':payment-preparation:' + key},0))::text`;
          await tx.$queryRaw`SELECT id FROM consumer_orders WHERE id=${orderId}::uuid AND user_id=${userId}::uuid FOR UPDATE`;
          const order = await tx.consumerOrder.findFirst({ where: { id: orderId, userId } });
          if (!order) throw failure(404, 'ORDER_NOT_FOUND', '未找到本人该订单');
          const old = await tx.paymentPreparation.findUnique({
            where: { userId_key: { userId, key } },
          });
          if (old) {
            if (old.orderId !== orderId)
              throw failure(409, 'IDEMPOTENCY_CONFLICT', '原支付准备操作属于另一笔订单');
            return { id: old.id };
          }
          const clock = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
          if (
            order.status !== 'AWAITING_PAYMENT' ||
            order.paymentState !== 'NOT_STARTED' ||
            order.paymentDeadline <= clock[0]!.now
          )
            throw failure(409, 'ORDER_NOT_PREPARABLE', '订单已取消或预占到期，不能建立支付准备');
          if (await tx.paymentPreparation.findUnique({ where: { orderId } }))
            throw failure(409, 'PAYMENT_PREPARATION_EXISTS', '已有支付准备记录，请刷新核实');
          const id = randomUUID();
          await tx.paymentPreparation.create({
            data: {
              id,
              orderId,
              userId,
              warehouseId: order.warehouseId,
              key,
              amountCents: order.payableCents,
              preparedAt: clock[0]!.now,
            },
          });
          await tx.paymentPreparationEvent.create({
            data: {
              id: randomUUID(),
              preparationId: id,
              type: 'PREPARED',
              actorKind: 'CONSUMER',
              requestId: r.requestId,
            },
          });
          return { id };
        },
        { timeout: 15000, maxWait: 10000 },
      );
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && ['P2034', 'P2002'].includes(e.code))
        throw failure(503, 'RETRYABLE_CONFLICT', '并发变化，请保留原操作并刷新核实');
      throw e;
    }
  }
}
const date = { type: 'string' as const, format: 'date-time' };
export const preparationSchema = object({
  id: { type: 'string', format: 'uuid' },
  state: { type: 'string', enum: ['PREPARED', 'CLOSED'] },
  channel: { type: 'string', enum: ['DISABLED'] },
  amountCents: { type: 'integer', minimum: 0 },
  currency: { type: 'string', enum: ['CNY'] },
  preparedAt: date,
  closedAt: { ...date, nullable: true },
  closeReason: { ...text, nullable: true },
});
@ApiTags('支付准备（无渠道调用）')
@ApiBearerAuth('consumerSession')
@Consumer()
@Controller('consumer/orders/:id/payment-preparation')
export class PaymentPreparationController {
  constructor(
    @Inject(PaymentPreparationService) private readonly service: PaymentPreparationService,
  ) {}
  @Get()
  @ApiResult(
    object({ enabled: { type: 'boolean' }, intent: { ...preparationSchema, nullable: true } }),
    [400, 401, 404, 500],
  )
  async read(@Req() r: ApiRequest, @Param('id') id: string, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.read(r, uuid(id)));
  }
  @Post()
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: object({}) })
  @ApiResult(object({ id: { type: 'string', format: 'uuid' } }), [400, 401, 404, 409, 503, 500])
  async prepare(
    @Req() r: ApiRequest,
    @Param('id') id: string,
    @Query() q: unknown,
    @Body() b: unknown,
  ) {
    fields(q, []);
    fields(b, []);
    return success(r, await this.service.prepare(r, uuid(id), key(r)));
  }
}
