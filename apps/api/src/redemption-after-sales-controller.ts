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
import { ApiBearerAuth, ApiBody, ApiCookieAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Consumer, Permissions } from './staff-guard.js';
import { ApiResult, object, text } from './api-result.js';
import { fields, key, uuid } from './catalog-input.js';
import { success, type ApiRequest } from './http.js';
import { RedemptionAfterSalesService } from './redemption-after-sales.js';
const integer = { type: 'integer' as const, minimum: 0 },
  nullable = { type: 'string' as const, nullable: true },
  errors = [400, 401, 403, 404, 409, 429, 500, 503];
const input = object({
  version: integer,
  message: { type: 'string', minLength: 1, maxLength: 500 },
});
const event = object({
  version: integer,
  kind: text,
  status: text,
  message: text,
  actor: { type: 'string', enum: ['CUSTOMER', 'STORE'] },
  createdAt: text,
});
const ticket = object({
  id: text,
  category: { type: 'string', enum: ['NOT_RECEIVED', 'DAMAGED', 'WRONG_ITEM', 'OTHER'] },
  status: { type: 'string', enum: ['OPEN', 'PROCESSING', 'CLOSED'] },
  version: integer,
  createdAt: text,
  updatedAt: text,
  events: { type: 'array', items: event },
});
const view = object({
  orderId: text,
  orderNo: text,
  title: text,
  spec: text,
  quantity: integer,
  enabled: { type: 'boolean' },
  canSubmit: { type: 'boolean' },
  ticket: { ...ticket, nullable: true },
});
const adminView = object({
  ...view.properties,
  ticket: {
    ...ticket,
    nullable: true,
    properties: {
      ...ticket.properties,
      events: {
        type: 'array',
        items: object({ ...event.properties, staffName: text }, Object.keys(event.properties!)),
      },
    },
  },
});
@ApiTags('快递兑换售后反馈')
@ApiBearerAuth('consumerSession')
@Consumer()
@Controller('consumer/redemptions/:id/after-sales')
export class ConsumerAfterSalesController {
  constructor(@Inject(RedemptionAfterSalesService) readonly service: RedemptionAfterSalesService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiResult(view, errors)
  async read(@Req() r: ApiRequest, @Param('id') id: string, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.readConsumer(r, uuid(id)));
  }
  @Post()
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({
    schema: object({
      category: { type: 'string', enum: ['NOT_RECEIVED', 'DAMAGED', 'WRONG_ITEM', 'OTHER'] },
      message: { type: 'string', minLength: 1, maxLength: 500 },
    }),
  })
  @ApiResult(object({ orderId: text }), errors)
  async create(
    @Req() r: ApiRequest,
    @Param('id') id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.consumerAction(r, uuid(id), key(r), 'SUBMITTED', b));
  }
  @Post('supplement')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: input })
  @ApiResult(object({ orderId: text }), errors)
  async supplement(
    @Req() r: ApiRequest,
    @Param('id') id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.consumerAction(r, uuid(id), key(r), 'SUPPLEMENTED', b));
  }
  @Post('reopen')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: input })
  @ApiResult(object({ orderId: text }), errors)
  async reopen(
    @Req() r: ApiRequest,
    @Param('id') id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.consumerAction(r, uuid(id), key(r), 'REOPENED', b));
  }
}
@ApiTags('后台快递兑换售后反馈')
@ApiCookieAuth('staffSession')
@Permissions('points.read')
@Controller('admin/redemption-after-sales')
export class AdminAfterSalesController {
  constructor(@Inject(RedemptionAfterSalesService) readonly service: RedemptionAfterSalesService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiResult(
    object({
      items: {
        type: 'array',
        maxItems: 20,
        items: object({
          orderId: text,
          orderNo: text,
          title: text,
          category: text,
          status: text,
          createdAt: text,
          updatedAt: text,
        }),
      },
      nextCursor: nullable,
    }),
    errors,
  )
  async list(@Req() r: ApiRequest, @Query() q: unknown) {
    return success(r, await this.service.list(r, q));
  }
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @ApiResult(adminView, errors)
  async read(@Req() r: ApiRequest, @Param('id') id: string, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.readStaff(r, uuid(id)));
  }
  @Post(':id/reply')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({ schema: input })
  @ApiResult(object({ orderId: text }), errors)
  async reply(
    @Req() r: ApiRequest,
    @Param('id') id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.staffAction(r, uuid(id), key(r), 'REPLIED', b));
  }
  @Post(':id/close')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({ schema: input })
  @ApiResult(object({ orderId: text }), errors)
  async close(
    @Req() r: ApiRequest,
    @Param('id') id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.staffAction(r, uuid(id), key(r), 'CLOSED', b));
  }
}
