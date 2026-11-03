import { Controller, Get, Header, Inject, Query, Req, HttpException } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Consumer } from './staff-guard.js';
import { ApiResult, object, text } from './api-result.js';
import { fields } from './catalog-input.js';
import { success, type ApiRequest } from './http.js';
import { CatalogService } from './catalog-service.js';
import { CheckoutService } from './checkout.js';
import { PointsExpressGate } from './points-express-gate.js';
@ApiTags('积分兑换当前访问条件')
@ApiBearerAuth('consumerSession')
@Consumer()
@Controller('consumer/redemption-access')
export class RedemptionAccessController {
  constructor(
    @Inject(PointsExpressGate) readonly gate: PointsExpressGate,
    @Inject(CatalogService) readonly catalog: CatalogService,
  ) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiResult(
    object({
      executionMode: { type: 'string', enum: ['DEVELOPMENT', 'CONTROLLED', 'PRODUCTION'] },
      canSubmit: { type: 'boolean' },
      reason: text,
    }),
    [400, 401, 500],
  )
  async read(@Req() r: ApiRequest, @Query() q: unknown) {
    fields(q, []);
    return success(
      r,
      await this.catalog.db.$transaction(async (tx) => {
        const checkout = new CheckoutService(this.catalog),
          user = await checkout.session(tx, r);
        let canSubmit = true,
          reason = '可继续核验商品、地址与积分';
        try {
          await this.gate.assertSubmit(tx, user, 'EXPRESS');
        } catch (e) {
          if (e instanceof HttpException && [403, 409, 503].includes(e.getStatus())) {
            canSubmit = false;
            reason = (e.getResponse() as { message: string }).message;
          } else throw e;
        }
        await checkout.session(tx, r);
        return { executionMode: this.gate.mode(), canSubmit, reason };
      }),
    );
  }
}
