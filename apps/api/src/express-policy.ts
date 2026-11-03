import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@yumi/database';
import type { RedemptionExpressPolicy } from '@yumi/contracts';
import { CatalogService } from './catalog-service.js';
import { PointsGrantService } from './points-grants.js';
import { fields, integer, key, str } from './catalog-input.js';
import { Permissions, Public } from './staff-guard.js';
import { failure, success, type ApiRequest } from './http.js';
import { ApiResult, object, text } from './api-result.js';
export class ExpressPolicyService {
  readonly staff: PointsGrantService;
  constructor(readonly catalog: CatalogService) {
    this.staff = new PointsGrantService(catalog);
  }
  async read(tx: Prisma.TransactionClient = this.catalog.db): Promise<RedemptionExpressPolicy> {
    const p = this.catalog.publicWarehouseId
      ? await tx.redemptionExpressPolicy.findUnique({
          where: { warehouseId: this.catalog.publicWarehouseId },
        })
      : null;
    return {
      enabled: p?.enabled ?? false,
      provinces: p?.provinces ?? [],
      shippingFeeMode: 'SENDER_PAID',
      version: p?.version ?? 0,
    };
  }
  async admin(r: ApiRequest) {
    return this.catalog.db.$transaction(async (tx) => {
      await this.staff.authorize(r, tx);
      return this.read(tx);
    });
  }
  async write(r: ApiRequest, k: string, input: unknown) {
    const b = fields(input, ['version', 'enabled', 'provinces', 'shippingFeeMode', 'reason']);
    const version = integer(b.version, 0, 2147483646),
      reason = str(b.reason, 300);
    if (
      typeof b.enabled !== 'boolean' ||
      b.shippingFeeMode !== 'SENDER_PAID' ||
      !Array.isArray(b.provinces) ||
      b.provinces.length > 34
    )
      throw failure(400, 'VALIDATION_ERROR', '须明确是否开放、寄送省份及商家承担运费');
    const provinces = b.provinces.map((v) => str(v, 40)).sort();
    if (
      new Set(provinces).size !== provinces.length ||
      provinces.some((x) =>
        Array.from(x).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127),
      ) ||
      (b.enabled && !provinces.length)
    )
      throw failure(400, 'VALIDATION_ERROR', '开放时须配置不重复的可寄送省份');
    const enabled = b.enabled,
      w = await this.staff.authorize(r);
    return this.catalog.write(
      r,
      'EXPRESS_POLICY',
      w,
      k,
      { version, enabled, provinces, shippingFeeMode: 'SENDER_PAID', reason },
      async (tx) => {
        await this.staff.authorize(r, tx);
        await tx.$queryRaw`SELECT id FROM warehouses WHERE id=${w}::uuid FOR UPDATE`;
        const p = await this.read(tx);
        if (p.version !== version)
          throw failure(409, 'VERSION_CONFLICT', '快递规则已变化，请重新读取');
        await tx.redemptionExpressPolicy.upsert({
          where: { warehouseId: w },
          create: {
            warehouseId: w,
            enabled,
            provinces,
            shippingFeeMode: 'SENDER_PAID',
            version: version + 1,
          },
          update: { enabled, provinces, version: version + 1 },
        });
        await this.catalog.audit(tx, r, 'EXPRESS_POLICY', w, w, reason, {
          before: { ...p },
          after: { enabled, provinces, shippingFeeMode: 'SENDER_PAID', version: version + 1 },
        });
        await this.staff.authorize(r, tx);
        return { id: w };
      },
    );
  }
}
const schema = object({
  enabled: { type: 'boolean' },
  provinces: { type: 'array', maxItems: 34, items: text },
  shippingFeeMode: { type: 'string', enum: ['SENDER_PAID'] },
  version: { type: 'integer' },
});
@ApiTags('积分商城快递范围与运费')
@Controller('redemption-express-policy')
export class PublicExpressPolicyController {
  constructor(@Inject(ExpressPolicyService) readonly service: ExpressPolicyService) {}
  @Get() @Public() @ApiResult(schema, [500, 503]) async read(
    @Req() r: ApiRequest,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.read());
  }
}
@ApiTags('积分商城快递规则配置')
@ApiCookieAuth('staffSession')
@Permissions('points.read')
@Controller('admin/redemption-express-policy')
export class AdminExpressPolicyController {
  constructor(@Inject(ExpressPolicyService) readonly service: ExpressPolicyService) {}
  @Get() @ApiResult(schema, [401, 403, 500, 503]) async read(
    @Req() r: ApiRequest,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.admin(r));
  }
  @Post('update')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({ schema: object({ ...schema.properties, reason: text }) })
  @ApiResult(object({ id: text }), [400, 401, 403, 409, 500, 503])
  async write(@Req() r: ApiRequest, @Body() b: unknown, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.write(r, key(r), b));
  }
}
