import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiCookieAuth,
  ApiHeader,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { ExpressShippingService } from './express-shipping.js';
import { RedemptionService } from './redemptions.js';
import { Consumer, Permissions } from './staff-guard.js';
import { fields, key, uuid } from './catalog-input.js';
import { success } from './http.js';
import type { ApiRequest } from './http.js';
import { ApiResult, object, text } from './api-result.js';
const integer = { type: 'integer' as const, minimum: 0 },
  nullable = { type: 'string' as const, nullable: true };
const quoteInput = object(
  {
    rewardId: text,
    rewardVersion: integer,
    quantity: { type: 'integer', minimum: 1, maximum: 100000 },
    addressId: text,
    addressVersion: integer,
    deliveryMode: { type: 'string', enum: ['LOCAL_NO_CASH', 'EXPRESS'] },
  },
  ['rewardId', 'rewardVersion', 'quantity', 'addressId', 'addressVersion'],
);
const snapshot = object(
  {
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
    deliveryMode: { type: 'string', enum: ['LOCAL_NO_CASH', 'EXPRESS'] },
    shippingFeeMode: { type: 'string', enum: ['SENDER_PAID'] },
    shippingFeeCents: { type: 'integer', enum: [0] },
    executionMode: { type: 'string', enum: ['DEVELOPMENT', 'CONTROLLED', 'PRODUCTION'] },
  },
  [
    'rewardId',
    'rewardVersion',
    'quantity',
    'addressId',
    'addressVersion',
    'skuId',
    'title',
    'name',
    'spec',
    'unit',
    'pointsPrice',
    'totalPoints',
    'areaVersion',
    'productVersion',
    'balance',
    'remainingBalance',
    'deliveryMode',
  ],
);
const quote = object({
  id: text,
  createdAt: text,
  expiresAt: text,
  expired: { type: 'boolean' },
  snapshot,
});
const expressShipment = {
  ...object({
    carrierCode: text,
    carrierName: text,
    trackingNo: text,
    shippedAt: text,
    receivedAt: nullable,
    correctionVersion: integer,
    correctedAt: nullable,
  }),
  nullable: true,
};
const orderProperties = {
  executionMode: { type: 'string' as const, enum: ['DEVELOPMENT', 'CONTROLLED', 'PRODUCTION'] },
  expressShipment,
  deliveryMode: { type: 'string' as const, enum: ['LOCAL_NO_CASH', 'EXPRESS'] },
  deliveryReturnRecorded: { type: 'boolean' as const },
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
      'EXPRESS_WAIT_SHIP',
      'EXPRESS_SHIPPED',
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
const localAddress = object({
  areaName: text,
  buildingName: text,
  unit: text,
  room: text,
  contactName: text,
  phone: text,
  note: text,
  orderNote: text,
});
const address = {
  oneOf: [
    localAddress,
    object({
      province: text,
      city: text,
      district: text,
      detailAddress: text,
      contactName: text,
      phone: text,
      note: text,
      orderNote: text,
    }),
  ],
};
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
  @Post('redemption-cart-quotes')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({
    schema: object({
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 20,
        items: object({
          rewardId: text,
          rewardVersion: integer,
          quantity: { type: 'integer', minimum: 1, maximum: 100000 },
        }),
      },
      addressId: text,
      addressVersion: integer,
    }),
  })
  @ApiResult(
    object({
      quotes: { type: 'array', items: quote },
      totalPoints: text,
      balance: text,
      remainingBalance: text,
      expiresAt: text,
    }),
    errors,
  )
  async cartQuote(@Req() r: ApiRequest, @Body() b: unknown, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.quoteCart(r, key(r), b));
  }
  @Post('redemption-cart-orders')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({
    schema: object(
      {
        quoteIds: { type: 'array', minItems: 1, maxItems: 20, items: text },
        consumeCart: {
          type: 'boolean',
          description: '可选；购物车结算时在同一事务扣减已购数量，默认false',
        },
      },
      ['quoteIds'],
    ),
  })
  @ApiResult(
    object({ id: text, orderIds: { type: 'array', items: text }, totalPoints: text }),
    errors,
  )
  async cartCreate(@Req() r: ApiRequest, @Body() b: unknown, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.createCart(r, key(r), b));
  }
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
  @Header('Cache-Control', 'no-store')
  @ApiQuery({
    name: 'keyword',
    required: false,
    schema: { type: 'string', maxLength: 80 },
    description: '按本人订单商品标题或订单号搜索，不区分大小写；特殊字符按字面匹配',
  })
  @ApiQuery({
    name: 'fulfillment',
    required: false,
    enum: ['EXPRESS_WAIT_SHIP', 'EXPRESS_SHIPPED', 'EXPRESS_WAIT_RECEIPT', 'EXPRESS_RECEIVED'],
  })
  @ApiResult(paged(consumerOrder), errors)
  async list(@Req() r: ApiRequest, @Query() q: unknown) {
    return success(r, await this.service.list(r, q));
  }
  @Get('redemptions/:id')
  @Header('Cache-Control', 'no-store')
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
@ApiTags('积分兑换订单查询与打印')
@ApiCookieAuth('staffSession')
@Permissions('points.read')
@Controller('admin/redemptions')
export class AdminRedemptionController {
  constructor(
    @Inject(RedemptionService) readonly service: RedemptionService,
    @Inject(ExpressShippingService) readonly shipping: ExpressShippingService,
  ) {}
  @Get(':id/shipping')
  @Header('Cache-Control', 'no-store')
  @ApiResult(
    object({
      id: text,
      orderNo: text,
      version: integer,
      title: text,
      spec: text,
      quantity: integer,
      address,
      shipment: expressShipment,
      canCorrect: { type: 'boolean' },
      shipmentHistory: {
        type: 'array',
        items: object({
          version: integer,
          carrierCode: text,
          carrierName: text,
          trackingNo: text,
          reason: nullable,
          actorName: text,
          recordedAt: text,
        }),
      },
      enabled: { type: 'boolean' },
      canShip: { type: 'boolean' },
      blockers: { type: 'array', items: text },
    }),
    errors,
  )
  async shippingRead(@Req() r: ApiRequest, @Param('id') id: string, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.shipping.read(r, uuid(id)));
  }
  @Post(':id/shipping-corrections')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({
    schema: object(
      {
        version: integer,
        carrierCode: {
          type: 'string',
          enum: ['SF', 'ZTO', 'YTO', 'STO', 'YUNDA', 'JD', 'EMS', 'POST', 'DEPPON', 'OTHER'],
        },
        carrierName: { type: 'string', maxLength: 40 },
        trackingNo: { type: 'string', minLength: 6, maxLength: 40 },
        reason: { type: 'string', minLength: 1, maxLength: 200 },
        verified: { type: 'boolean', enum: [true] },
      },
      ['version', 'carrierCode', 'trackingNo', 'reason', 'verified'],
    ),
  })
  @ApiResult(object({ id: text, correctionVersion: integer }), errors)
  async correct(
    @Req() r: ApiRequest,
    @Param('id') id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.shipping.correct(r, uuid(id), key(r), b));
  }
  @Post(':id/ship')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({
    schema: object(
      {
        version: integer,
        carrierCode: {
          type: 'string',
          enum: ['SF', 'ZTO', 'YTO', 'STO', 'YUNDA', 'JD', 'EMS', 'POST', 'DEPPON', 'OTHER'],
        },
        carrierName: { type: 'string', maxLength: 40 },
        trackingNo: { type: 'string', minLength: 6, maxLength: 40 },
        dispatchConfirmed: { type: 'boolean', enum: [true] },
      },
      ['version', 'carrierCode', 'trackingNo', 'dispatchConfirmed'],
    ),
  })
  @ApiResult(object({ id: text }), errors)
  async ship(
    @Req() r: ApiRequest,
    @Param('id') id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.shipping.ship(r, uuid(id), key(r), b));
  }
  @Post('print-preview')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({
    schema: object({
      ids: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: text },
    }),
  })
  @ApiResult(
    object({
      generatedAt: text,
      items: {
        type: 'array',
        maxItems: 20,
        items: object({
          id: text,
          orderNo: text,
          createdAt: text,
          title: text,
          spec: text,
          unit: text,
          quantity: integer,
          pointsPrice: text,
          totalPoints: text,
          expressShipment,
          executionMode: { type: 'string', enum: ['DEVELOPMENT', 'CONTROLLED', 'PRODUCTION'] },
          deliveryMode: { type: 'string', enum: ['LOCAL_NO_CASH', 'EXPRESS'] },
          address,
        }),
      },
    }),
    errors,
  )
  async printPreview(@Req() r: ApiRequest, @Body() b: unknown, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.printPreview(r, b));
  }

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
