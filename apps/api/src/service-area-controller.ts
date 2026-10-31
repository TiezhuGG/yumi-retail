import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ServiceAreaService } from './service-area.js';
import { Permissions, Public } from './staff-guard.js';
import { fields, key, uuid } from './catalog-input.js';
import { success } from './http.js';
import type { ApiRequest } from './http.js';
import { ApiResult, object, text } from './api-result.js';
const version = { type: 'integer' as const, minimum: 0, maximum: 2147483646 },
  flag = { type: 'boolean' as const };
const publicArea = object({ id: text, name: text, version });
const building = object({ id: text, name: text });
const detail = object({
  id: text,
  name: text,
  enabled: flag,
  version,
  warehouse: object({ id: text, name: text }),
  buildings: {
    type: 'array',
    maxItems: 200,
    items: object({ id: text, name: text, enabled: flag }),
  },
});
const result = object({ area: { ...detail, nullable: true } });
@ApiTags('服务范围维护')
@ApiCookieAuth('staffSession')
@Controller('admin/service-area')
export class ServiceAreaAdminController {
  constructor(@Inject(ServiceAreaService) private readonly service: ServiceAreaService) {}
  @Get()
  @Permissions('service-area.read')
  @ApiResult(result)
  async read(@Req() r: ApiRequest, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.read(r));
  }
  @Post()
  @HttpCode(200)
  @Permissions('service-area.write')
  @ApiOperation({ summary: '创建唯一服务小区，默认停用' })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: object({ name: { type: 'string', maxLength: 100 } }) })
  @ApiResult(result, [400, 401, 403, 409, 503, 500])
  async create(@Req() r: ApiRequest, @Body() b: unknown, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.write(r, key(r), 'CREATE', b));
  }
  @Post('update')
  @HttpCode(200)
  @Permissions('service-area.write')
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: object({ version, name: { type: 'string', maxLength: 100 }, enabled: flag }) })
  @ApiResult(result, [400, 401, 403, 404, 409, 503, 500])
  async update(@Req() r: ApiRequest, @Body() b: unknown, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.write(r, key(r), 'UPDATE', b));
  }
  @Post('buildings')
  @HttpCode(200)
  @Permissions('service-area.write')
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: object({ version, name: { type: 'string', maxLength: 80 } }) })
  @ApiResult(result, [400, 401, 403, 404, 409, 503, 500])
  async add(@Req() r: ApiRequest, @Body() b: unknown, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.write(r, key(r), 'BUILDING_CREATE', b));
  }
  @Post('buildings/:id/update')
  @HttpCode(200)
  @Permissions('service-area.write')
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ schema: object({ version, name: { type: 'string', maxLength: 80 }, enabled: flag }) })
  @ApiResult(result, [400, 401, 403, 404, 409, 503, 500])
  async edit(
    @Req() r: ApiRequest,
    @Param('id') id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.write(r, key(r), 'BUILDING_UPDATE', b, uuid(id)));
  }
}
@ApiTags('公开配送范围')
@Controller('service-areas')
export class PublicServiceAreaController {
  constructor(@Inject(ServiceAreaService) private readonly service: ServiceAreaService) {}
  @Get()
  @Public()
  @ApiResult(object({ items: { type: 'array', maxItems: 1, items: publicArea } }), [400, 500])
  async list(@Req() r: ApiRequest, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.publicList());
  }
  @Get(':id/buildings')
  @Public()
  @ApiResult(
    object({ area: publicArea, items: { type: 'array', maxItems: 200, items: building } }),
    [400, 404, 500],
  )
  async buildings(@Req() r: ApiRequest, @Param('id') id: string, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.buildings(uuid(id)));
  }
  @Get(':id/buildings/:buildingId')
  @Public()
  @ApiResult(object({ area: publicArea, building }), [400, 404, 500])
  async check(
    @Req() r: ApiRequest,
    @Param('id') id: string,
    @Param('buildingId') bid: string,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.building(uuid(id), uuid(bid)));
  }
}
