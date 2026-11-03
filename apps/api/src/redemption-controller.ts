import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCookieAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { RedemptionService } from './redemptions.js';
import { Consumer, Permissions } from './staff-guard.js';
import { fields, key, uuid } from './catalog-input.js';
import { success } from './http.js';
import type { ApiRequest } from './http.js';
import { ApiResult, object, text } from './api-result.js';
const integer = { type: 'integer' as const, minimum: 0 },
  nullable = { type: 'string' as const, nullable: true };
const quoteInput = object({
  rewardId: text,
  rewardVersion: integer,
  quantity: { type: 'integer', minimum: 1, maximum: 100000 },
  addressId: text,
  addressVersion: integer,
});
const snapshot = object({
  ...quoteInput.properties,
  skuId: text,
  title: text,
  name: text,
  spec: text,
  unit: text,
  pointsPrice: text,
  totalPoints: text,
  areaVersion: integer,
  productVersion: integer,
  balance: text,
  remainingBalance: text,
  deliveryMode: { type: 'string', enum: ['LOCAL_NO_CASH'] },
});
const quote = object({
  id: text,
  createdAt: text,
  expiresAt: text,
  expired: { type: 'boolean' },
  snapshot,
});
const orderProperties = {
  deliveryExceptionReported: { type: 'boolean' as const },
  id: text,
  orderNo: text,
  status: { type: 'string' as const, enum: ['ACTIVE', 'CANCELED'] },
  title: text,
  name: text,
  spec: text,
  unit: text,
  quantity: integer,
  pointsPrice: text,
  totalPoints: text,
  createdAt: text,
  canceledAt: nullable,
  version: integer,
  fulfillmentState: {
    type: 'string' as const,
    enum: [
      'PENDING',
      'CANCELED',
      'MISSING',
      'READY_TO_PICK',
      'PICKING',
      'PICKED_WAIT_PACK',
      'PACKED_WAIT_SHIP',
      'SHIPPED_WAIT_HANDOFF',
      'ASSIGNED_WAIT_HANDOFF',
      'RIDER_RECEIVED_WAIT_START',
      'DELIVERING',
      'DELIVERED',
      'REVIEW_REQUIRED',
    ],
  },
};
const address = object({
  areaName: text,
  buildingName: text,
  unit: text,
  room: text,
  contactName: text,
  phone: text,
  note: text,
  orderNote: text,
});
const consumerOrder = object({ ...orderProperties, address }),
  adminOrder = object(orderProperties);
const paged = (schema: ReturnType<typeof object>) =>
  object({ items: { type: 'array' as const, maxItems: 20, items: schema }, nextCursor: nullable });
const errors = [400, 401, 403, 404, 409, 429, 500, 503];
@ApiTags('本人积分兑换（本机开发基础）')
@ApiBearerAuth('consumerSession')
@Consumer()
@Controller('consumer')
export class RedemptionController {
  constructor(@Inject(RedemptionService) readonly service: RedemptionService) {}
  @Post('redemption-quotes')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: quoteInput })
  @ApiResult(quote, errors)
  async quote(@Req() r: ApiRequest, @Body() b: unknown, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.quote(r, key(r), b));
  }
  @Get('redemption-quotes/:id')
  @ApiResult(quote, errors)
  async quoteDetail(@Req() r: ApiRequest, @Param('id') id: string, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.readQuote(r, uuid(id)));
  }
  @Post('redemptions')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: object({ quoteId: text }) })
  @ApiResult(object({ id: text }), errors)
  async create(@Req() r: ApiRequest, @Body() b: unknown, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.create(r, key(r), b));
  }
  @Get('redemptions')
  @ApiResult(paged(consumerOrder), errors)
  async list(@Req() r: ApiRequest, @Query() q: unknown) {
    return success(r, await this.service.list(r, q));
  }
  @Get('redemptions/:id')
  @ApiResult(consumerOrder, errors)
  async detail(@Req() r: ApiRequest, @Param('id') id: string, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.detail(r, uuid(id)));
  }
  @Post('redemptions/:id/cancel')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: object({ version: integer }) })
  @ApiResult(object({ id: text }), errors)
  async cancel(
    @Req() r: ApiRequest,
    @Param('id') id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.cancel(r, key(r), uuid(id), b));
  }
}
@ApiTags('积分兑换订单查询')
@ApiCookieAuth('staffSession')
@Permissions('points.read')
@Controller('admin/redemptions')
export class AdminRedemptionController {
  constructor(@Inject(RedemptionService) readonly service: RedemptionService) {}
  @Get()
  @ApiResult(paged(adminOrder), errors)
  async list(@Req() r: ApiRequest, @Query() q: unknown) {
    return success(r, await this.service.list(r, q, true));
  }
  @Get(':id')
  @ApiResult(
    object({
      ...orderProperties,
      allocations: {
        type: 'array',
        items: object({
          quantity: integer,
          batchNo: text,
          locationName: text,
          locationCode: text,
          reserved: { type: 'boolean' },
          released: { type: 'boolean' },
          consumed: { type: 'boolean' },
        }),
      },
      events: { type: 'array', items: object({ type: text, createdAt: text }) },
    }),
    errors,
  )
  async detail(@Req() r: ApiRequest, @Param('id') id: string, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.detail(r, uuid(id), true));
  }
}
