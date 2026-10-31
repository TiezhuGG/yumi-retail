import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiTags } from '@nestjs/swagger';
import { OrderService } from './orders.js';
import { Consumer } from './staff-guard.js';
import { fields, key, uuid } from './catalog-input.js';
import { success } from './http.js';
import type { ApiRequest } from './http.js';
import { ApiResult, object, text } from './api-result.js';
const id = { type: 'string' as const, format: 'uuid' },
  date = { type: 'string' as const, format: 'date-time' },
  money = { type: 'integer' as const, minimum: 0 };
const order = object({
  id,
  orderNo: text,
  status: { type: 'string', enum: ['AWAITING_PAYMENT', 'CANCELED'] },
  paymentState: { type: 'string', enum: ['NOT_STARTED'] },
  fulfillmentState: { type: 'string', enum: ['NOT_READY'] },
  goodsCents: money,
  deliveryFeeCents: money,
  payableCents: money,
  createdAt: date,
  paymentDeadline: date,
  cancelReason: { ...text, nullable: true },
  version: { type: 'integer', minimum: 0 },
  address: object({
    areaName: text,
    buildingName: text,
    unit: text,
    room: text,
    contactName: text,
    phone: text,
    note: text,
    orderNote: text,
  }),
  items: {
    type: 'array',
    maxItems: 50,
    items: object({
      skuId: id,
      name: text,
      spec: text,
      unit: text,
      quantity: { type: 'integer', minimum: 1, maximum: 200 },
      priceCents: money,
      lineCents: money,
    }),
  },
});
@ApiTags('本人订单（本机开发基础）')
@ApiBearerAuth('consumerSession')
@Consumer()
@Controller('consumer/orders')
export class OrderController {
  constructor(@Inject(OrderService) private readonly service: OrderService) {}
  @Post()
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({
    schema: object({ quoteId: id, note: { type: 'string', maxLength: 200 } }, ['quoteId']),
  })
  @ApiResult(object({ id }), [400, 401, 404, 409, 503, 500])
  async create(@Req() r: ApiRequest, @Body() b: unknown, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.create(r, key(r), b));
  }
  @Get()
  @ApiResult(
    object({
      items: { type: 'array', maxItems: 20, items: order },
      hasMore: { type: 'boolean' },
      nextCursor: { ...id, nullable: true },
    }),
    [400, 401, 404, 500],
  )
  async list(@Req() r: ApiRequest, @Query() q: unknown) {
    const row = fields(q, ['cursor']);
    return success(
      r,
      await this.service.list(r, row.cursor === undefined ? undefined : uuid(row.cursor)),
    );
  }
  @Get(':id')
  @ApiResult(order, [400, 401, 404, 500])
  async read(@Req() r: ApiRequest, @Param('id') id: string, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.read(r, uuid(id)));
  }
  @Post(':id/cancel')
  @HttpCode(200)
  @ApiBody({ schema: object({}) })
  @ApiResult(object({ id }), [400, 401, 404, 409, 500])
  async cancel(
    @Req() r: ApiRequest,
    @Param('id') id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    fields(b, []);
    return success(r, await this.service.cancel(r, uuid(id)));
  }
}
