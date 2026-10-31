import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiTags } from '@nestjs/swagger';
import { ConsumerAddressService } from './consumer-address.js';
import { Consumer } from './staff-guard.js';
import { fields, key, uuid } from './catalog-input.js';
import { success } from './http.js';
import type { ApiRequest } from './http.js';
import { ApiResult, object, text } from './api-result.js';
const version = { type: 'integer' as const, minimum: 0, maximum: 2147483646 },
  flag = { type: 'boolean' as const },
  id = { type: 'string' as const, format: 'uuid' };
const properties = {
  areaId: id,
  buildingId: id,
  unit: { ...text, maxLength: 20 },
  room: { ...text, maxLength: 30 },
  contactName: { ...text, maxLength: 40 },
  phone: { ...text, pattern: '^\\+?[0-9]{6,20}$' },
  note: { ...text, maxLength: 200 },
  isDefault: flag,
};
const receipt = object({ id, version });
@ApiTags('本人收货地址')
@ApiBearerAuth('consumerSession')
@Consumer()
@Controller('consumer/addresses')
export class ConsumerAddressController {
  constructor(@Inject(ConsumerAddressService) private readonly service: ConsumerAddressService) {}
  @Get()
  @ApiResult(
    object({
      version,
      items: {
        type: 'array',
        maxItems: 20,
        items: object({ id, ...properties, areaName: text, buildingName: text, available: flag }),
      },
    }),
    [400, 401, 503, 500],
  )
  async read(@Req() r: ApiRequest, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.read(r));
  }
  @Post()
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: object({ version, ...properties }) })
  @ApiResult(receipt, [400, 401, 409, 503, 500])
  async create(@Req() r: ApiRequest, @Body() b: unknown, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.write(r, key(r), 'CREATE', b));
  }
  @Post(':id/update')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: object({ version, ...properties }) })
  @ApiResult(receipt, [400, 401, 404, 409, 503, 500])
  async update(
    @Req() r: ApiRequest,
    @Param('id') id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.write(r, key(r), 'UPDATE', b, uuid(id)));
  }
  @Post(':id/default')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: object({ version }) })
  @ApiResult(receipt, [400, 401, 404, 409, 503, 500])
  async makeDefault(
    @Req() r: ApiRequest,
    @Param('id') id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.write(r, key(r), 'DEFAULT', b, uuid(id)));
  }
  @Post(':id/delete')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: object({ version }) })
  @ApiResult(receipt, [400, 401, 404, 409, 503, 500])
  async remove(
    @Req() r: ApiRequest,
    @Param('id') id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.write(r, key(r), 'DELETE', b, uuid(id)));
  }
}
