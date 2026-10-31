import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiCookieAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { CheckoutService } from './checkout.js';
import { Consumer, Permissions, Public } from './staff-guard.js';
import { fields, key, uuid } from './catalog-input.js';
import { success } from './http.js';
import type { ApiRequest } from './http.js';
import { ApiResult, object, text } from './api-result.js';
const version = { type: 'integer' as const, minimum: 0, maximum: 2147483646 },
  cents = { type: 'integer' as const, minimum: 0, maximum: 100000000 },
  flag = { type: 'boolean' as const },
  id = { type: 'string' as const, format: 'uuid' };
const policy = object({
  version,
  deliveryFeeCents: cents,
  minGoodsCents: cents,
  freeDeliveryThresholdCents: { ...cents, nullable: true },
  open: flag,
});
const input = object({ addressId: id, addressVersion: version, cartVersion: version });
const preview = object({
  addressId: id,
  addressVersion: version,
  cartVersion: version,
  policy: { ...policy, nullable: true },
  areaVersion: { ...version, nullable: true },
  ready: flag,
  issues: { type: 'array', items: object({ code: text, message: text }) },
  lines: {
    type: 'array',
    maxItems: 50,
    items: object({
      skuId: id,
      name: text,
      spec: text,
      unit: text,
      quantity: { type: 'integer', minimum: 1, maximum: 200 },
      priceCents: { ...cents, nullable: true },
      lineCents: { type: 'integer', minimum: 0, nullable: true },
      available: { type: 'integer', minimum: 0 },
      status: { type: 'string', enum: ['AVAILABLE', 'UNAVAILABLE', 'EXCESS'] },
    }),
  },
  goodsCents: { type: 'integer', minimum: 0, nullable: true },
  deliveryFeeCents: { ...cents, nullable: true },
  payableCents: { type: 'integer', minimum: 0, nullable: true },
});
const quote = object({
  id,
  createdAt: { type: 'string', format: 'date-time' },
  expiresAt: { type: 'string', format: 'date-time' },
  expired: flag,
  preview,
});
@ApiTags('报价规则')
@ApiCookieAuth('staffSession')
@Controller('admin/checkout-policy')
export class CheckoutPolicyController {
  constructor(@Inject(CheckoutService) private readonly service: CheckoutService) {}
  @Get()
  @Permissions('checkout-policy.read')
  @ApiResult(object({ policy: { ...policy, nullable: true } }), [400, 401, 403, 503, 500])
  async read(@Req() r: ApiRequest, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.adminRead(r));
  }
  @Post()
  @HttpCode(200)
  @Permissions('checkout-policy.write')
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: object({ ...policy.properties, version: { ...version, nullable: true } }) })
  @ApiResult(object({ policy }), [400, 401, 403, 409, 503, 500])
  async write(@Req() r: ApiRequest, @Body() b: unknown, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.adminWrite(r, key(r), b));
  }
}
@ApiTags('公开经营规则')
@Controller('store')
export class StoreController {
  constructor(@Inject(CheckoutService) private readonly service: CheckoutService) {}
  @Get()
  @Public()
  @ApiResult(
    object({
      status: { type: 'string', enum: ['UNCONFIGURED', 'PAUSED', 'OPEN'] },
      policy: { ...policy, nullable: true },
    }),
    [400, 500],
  )
  async read(@Req() r: ApiRequest, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.store());
  }
}
@ApiTags('本人结算核验与报价')
@ApiBearerAuth('consumerSession')
@Consumer()
@Controller('consumer/checkout')
export class CheckoutController {
  constructor(@Inject(CheckoutService) private readonly service: CheckoutService) {}
  @Post('preview')
  @HttpCode(200)
  @ApiBody({ schema: input })
  @ApiResult(preview, [400, 401, 404, 409, 503, 500])
  async preview(@Req() r: ApiRequest, @Body() b: unknown, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.check(r, b));
  }
  @Post('quotes')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: input })
  @ApiResult(quote, [400, 401, 404, 409, 429, 503, 500])
  async quote(@Req() r: ApiRequest, @Body() b: unknown, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.check(r, b, key(r)));
  }
  @Get('quotes/:id')
  @ApiResult(quote, [400, 401, 404, 500])
  async read(@Req() r: ApiRequest, @Param('id') id: string, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.readQuote(r, uuid(id)));
  }
}
