import { createHash } from 'node:crypto';
import {
  Body,
  Controller,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiTags } from '@nestjs/swagger';
import { RedemptionAfterSalesService } from './redemption-after-sales.js';
import { Consumer } from './staff-guard.js';
import { fields, key, uuid } from './catalog-input.js';
import { failure, success, type ApiRequest } from './http.js';
import { ApiResult, object, text } from './api-result.js';
export class ExpressReceiptService {
  constructor(readonly base: RedemptionAfterSalesService) {}
  async confirm(r: ApiRequest, id: string, k: string, body: unknown) {
    const b = fields(body, ['received']);
    if (b.received !== true)
      throw failure(400, 'RECEIPT_CONFIRMATION_REQUIRED', '请确认已收到本订单全部商品');
    return this.base.catalog.db.$transaction(
      async (tx) => {
        const user = await this.base.consumer(tx, r),
          scope = user + ':EXPRESS_RECEIPT:' + id,
          keyHash = createHash('sha256').update(k).digest('hex'),
          requestHash = createHash('sha256').update('received:true').digest('hex');
        await tx.$queryRaw`SELECT id FROM redemption_orders WHERE id=${id}::uuid AND user_id=${user}::uuid FOR UPDATE`;
        const order = await this.base.source(tx, id, user);
        if (
          order.status !== 'ACTIVE' ||
          !order.expressShipment ||
          order.outbox?.state !== 'EXPRESS_SHIPPED'
        )
          throw failure(409, 'SHIPPED_ORDER_REQUIRED', '仅已发货订单可以确认收货');
        const prior = await tx.idempotencyRecord.findUnique({
          where: { scope_keyHash: { scope, keyHash } },
        });
        if (prior) {
          await this.base.consumer(tx, r);
          return prior.result;
        }
        let receipt = await tx.redemptionExpressReceipt.findUnique({
          where: { shipmentId: order.expressShipment.id },
        });
        if (!receipt) {
          this.base.gate(order.executionMode);
          receipt = await tx.redemptionExpressReceipt.create({
            data: { shipmentId: order.expressShipment.id, userId: user, requestId: r.requestId },
          });
        }
        const result = { receivedAt: receipt.confirmedAt.toISOString() };
        await this.base.consumer(tx, r);
        await tx.idempotencyRecord.create({ data: { scope, keyHash, requestHash, result } });
        return result;
      },
      { timeout: 15000 },
    );
  }
}
@ApiTags('积分快递收货确认')
@ApiBearerAuth('consumerSession')
@Consumer()
@Controller('consumer/redemptions/:id/confirm-receipt')
export class ExpressReceiptController {
  constructor(@Inject(ExpressReceiptService) readonly service: ExpressReceiptService) {}
  @Post()
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiBody({ schema: object({ received: { type: 'boolean', enum: [true] } }) })
  @ApiResult(object({ receivedAt: text }), [400, 401, 404, 409, 500, 503])
  async confirm(
    @Req() r: ApiRequest,
    @Param('id') id: string,
    @Query() q: unknown,
    @Body() b: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.confirm(r, uuid(id), key(r), b));
  }
}
