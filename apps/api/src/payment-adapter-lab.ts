import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CatalogService } from './catalog-service.js';
import { fields, uuid } from './catalog-input.js';
import { Permissions } from './staff-guard.js';
import { failure, success } from './http.js';
import type { ApiRequest } from './http.js';
import { object, ApiResult, text } from './api-result.js';
import { paymentAdapterCases, runPaymentAdapterSelfTest } from './payment-adapter-fixtures.js';
export class PaymentAdapterLabService {
  constructor(
    readonly catalog: CatalogService,
    readonly enabled = false,
  ) {}
  async info(r: ApiRequest, id: string) {
    await this.catalog.warehouse(this.catalog.db, r, id);
    return {
      enabled: this.enabled,
      syntheticOnly: true as const,
      callbackEnabled: false as const,
      cases: paymentAdapterCases.map(({ code, title }) => ({ code, title })),
    };
  }
  async run(r: ApiRequest, id: string) {
    await this.catalog.warehouse(this.catalog.db, r, id);
    if (!this.enabled)
      throw failure(503, 'PAYMENT_ADAPTER_LAB_DISABLED', '渠道契约验证尚未在本机显式开启');
    return await runPaymentAdapterSelfTest();
  }
}
const flags = {
  syntheticOnly: { type: 'boolean' as const, enum: [true] },
  callbackEnabled: { type: 'boolean' as const, enum: [false] },
};
@ApiTags('渠道契约判定验证（仅合成材料）')
@ApiCookieAuth('staffSession')
@Permissions('payment-readiness.read')
@Controller('admin/payment-adapter-lab')
export class PaymentAdapterLabController {
  constructor(
    @Inject(PaymentAdapterLabService) private readonly service: PaymentAdapterLabService,
  ) {}
  @Get()
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiResult(
    object({
      ...flags,
      enabled: { type: 'boolean' },
      cases: { type: 'array', maxItems: 20, items: object({ code: text, title: text }) },
    }),
    [400, 401, 403, 500],
  )
  async info(@Req() r: ApiRequest, @Query() q: unknown) {
    const b = fields(q, ['warehouseId']);
    return success(r, await this.service.info(r, uuid(b.warehouseId)));
  }
  @Post('run')
  @HttpCode(200)
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({ schema: object({}) })
  @ApiResult(
    object({
      ...flags,
      completedAt: { type: 'string', format: 'date-time' },
      results: {
        type: 'array',
        maxItems: 20,
        items: object({
          code: text,
          title: text,
          classification: text,
          evidence: { type: 'string', enum: ['UNKNOWN', 'SUCCEEDED', 'CLOSED'] },
          next: { type: 'string', enum: ['RETRY', 'REVIEW', 'RECONCILE'] },
          releaseAllowed: { type: 'boolean', enum: [false] },
          status: { type: 'string', enum: ['PASSED', 'FAILED'] },
        }),
      },
    }),
    [400, 401, 403, 503, 500],
  )
  async run(@Req() r: ApiRequest, @Query() q: unknown, @Body() body: unknown) {
    const b = fields(q, ['warehouseId']);
    fields(body, []);
    return success(r, await this.service.run(r, uuid(b.warehouseId)));
  }
}
