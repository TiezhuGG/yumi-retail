import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ConsumerCartService } from './consumer-cart.js';
import { Consumer } from './staff-guard.js';
import { fields, key } from './catalog-input.js';
import { success } from './http.js';
import type { ApiRequest } from './http.js';
import { ApiResult, object, text } from './api-result.js';
const number = { type: 'integer' as const, minimum: 0, maximum: 2147483646 };
const item = object({
  skuId: { type: 'string', format: 'uuid' },
  quantity: { type: 'integer', minimum: 1, maximum: 200 },
  selected: { type: 'boolean' },
  name: { type: 'string', maxLength: 120 },
  spec: { type: 'string', maxLength: 100 },
  unit: { type: 'string', maxLength: 16 },
});
const cart = object({ version: number, items: { type: 'array', maxItems: 50, items: item } });
@ApiTags('消费者购物车')
@ApiBearerAuth('consumerSession')
@Consumer()
@Controller('consumer/cart')
export class ConsumerCartController {
  constructor(@Inject(ConsumerCartService) private readonly service: ConsumerCartService) {}
  @Get()
  @ApiOperation({ summary: '本人账号购物车，价格与库存需另行实时核验' })
  @ApiResult(cart, [400, 401, 500])
  async read(@Req() req: ApiRequest, @Query() query: unknown) {
    fields(query, []);
    return success(req, await this.service.read(req));
  }
  @Post('items')
  @HttpCode(200)
  @ApiOperation({ summary: '加入一件当前公开且有货SKU；版本冲突需刷新，未知结果先读取' })
  @ApiBody({ schema: object({ version: number, skuId: { type: 'string', format: 'uuid' } }) })
  @ApiResult(cart, [400, 401, 409, 500])
  async add(@Req() req: ApiRequest, @Body() body: unknown, @Query() query: unknown) {
    fields(query, []);
    return success(req, await this.service.mutate(req, 'ADD', body));
  }
  @Put('items/:skuId')
  @ApiBody({
    schema: object({
      version: number,
      quantity: { type: 'integer', minimum: 1, maximum: 200 },
      selected: { type: 'boolean' },
    }),
  })
  @ApiResult(cart, [400, 401, 404, 409, 500])
  async update(
    @Req() req: ApiRequest,
    @Param('skuId') id: string,
    @Body() body: unknown,
    @Query() query: unknown,
  ) {
    fields(query, []);
    return success(req, await this.service.mutate(req, 'UPDATE', body, id));
  }
  @Delete('items/:skuId')
  @ApiBody({ schema: object({ version: number }) })
  @ApiResult(cart, [400, 401, 404, 409, 500])
  async remove(
    @Req() req: ApiRequest,
    @Param('skuId') id: string,
    @Body() body: unknown,
    @Query() query: unknown,
  ) {
    fields(query, []);
    return success(req, await this.service.mutate(req, 'REMOVE', body, id));
  }
  @Post('selection')
  @HttpCode(200)
  @ApiBody({
    schema: object({
      version: number,
      skuIds: { type: 'array', maxItems: 50, items: { type: 'string', format: 'uuid' } },
      selected: { type: 'boolean' },
    }),
  })
  @ApiResult(cart, [400, 401, 409, 500])
  async select(@Req() req: ApiRequest, @Body() body: unknown, @Query() query: unknown) {
    fields(query, []);
    return success(req, await this.service.mutate(req, 'SELECT', body));
  }
  @Post('merge')
  @HttpCode(200)
  @ApiOperation({ summary: '本人游客草稿幂等合并；异常条目保留，超技术总量原子拒绝' })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiBody({ schema: object({ items: { type: 'array', maxItems: 50, items: item } }) })
  @ApiResult(
    object({
      cart,
      checks: {
        type: 'array',
        items: object({
          skuId: text,
          status: { type: 'string', enum: ['available', 'unavailable', 'excess', 'unknown'] },
        }),
      },
    }),
    [400, 401, 409, 500],
  )
  async merge(@Req() req: ApiRequest, @Body() body: unknown, @Query() query: unknown) {
    fields(query, []);
    return success(req, await this.service.merge(req, body, key(req)));
  }
}
