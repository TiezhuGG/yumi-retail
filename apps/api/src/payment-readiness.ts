import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { PaymentReadiness, PaymentReadinessCheck } from '@yumi/contracts';
import { Prisma } from '@yumi/database';
import { CatalogService } from './catalog-service.js';
import { fields, uuid } from './catalog-input.js';
import { Permissions } from './staff-guard.js';
import { success } from './http.js';
import type { ApiRequest } from './http.js';
import { ApiResult, object, text } from './api-result.js';
export class PaymentReadinessService {
  constructor(
    readonly catalog: CatalogService,
    readonly configuration: PaymentReadinessCheck[],
  ) {}
  async read(r: ApiRequest, warehouseId: string): Promise<PaymentReadiness> {
    return this.catalog.db.$transaction(
      async (tx) => {
        await this.catalog.warehouse(tx, r, warehouseId);
        const warehouse = await tx.warehouse.findUniqueOrThrow({
          where: { id: warehouseId },
          select: { id: true, name: true },
        });
        const policy = await tx.checkoutPolicy.findUnique({
          where: { warehouseId },
          select: { open: true },
        });
        const area = await tx.serviceArea.findUnique({
          where: { warehouseId },
          select: {
            enabled: true,
            buildings: { where: { enabled: true }, select: { id: true }, take: 1 },
          },
        });
        return {
          checkedAt: new Date().toISOString(),
          channel: 'DISABLED',
          canStartPayment: false,
          warehouse,
          checks: [
            ...this.configuration,
            {
              code: 'CHECKOUT_POLICY',
              title: '经营报价规则',
              group: 'OPERATIONS',
              status: !policy ? 'MISSING' : !policy.open ? 'BLOCKED' : 'CONFIGURED',
              detail: !policy
                ? '尚未配置运费、起送及免运规则；不会填入开发样例。'
                : !policy.open
                  ? '已有规则但报价暂停；不能据此进行真实交易。'
                  : '已配置并开放报价；不代表负责人已完成经营验收。',
            },
            {
              code: 'SERVICE_AREA',
              title: '服务小区与楼栋',
              group: 'OPERATIONS',
              status: !area
                ? 'MISSING'
                : !area.enabled || !area.buildings.length
                  ? 'BLOCKED'
                  : 'CONFIGURED',
              detail: !area
                ? '尚未配置服务范围。'
                : !area.enabled || !area.buildings.length
                  ? '小区停用或没有启用楼栋。'
                  : '已配置有效范围；真实地址与配送能力仍需验收。',
            },
            {
              code: 'PROVIDER',
              title: '支付渠道实现',
              group: 'IMPLEMENTATION',
              status: 'BLOCKED',
              detail: '尚未实现渠道下单、查询和关闭，当前始终禁止发起支付。',
            },
            {
              code: 'CALLBACK',
              title: '支付通知与补偿',
              group: 'IMPLEMENTATION',
              status: 'BLOCKED',
              detail: '验签、通知解密、金额核验、重复通知及查单补偿尚未实现；没有可用回调入口。',
            },
            {
              code: 'MERCHANT_BINDING',
              title: '商户与小程序绑定',
              group: 'ACCEPTANCE',
              status: 'UNVERIFIED',
              detail: '未连接商户平台，开通权限、主体与AppID绑定均未验证。',
            },
            {
              code: 'CREDENTIALS',
              title: '凭据管理与签名验签',
              group: 'ACCEPTANCE',
              status: 'UNVERIFIED',
              detail: '本页不接收、读取或校验私钥、APIv3密钥及验签材料；需独立安全接入后验证。',
            },
            {
              code: 'IDENTITY',
              title: '真实微信身份',
              group: 'ACCEPTANCE',
              status: 'UNVERIFIED',
              detail: '当前仅有本机开发身份，真实微信登录和支付用户身份尚未接入。',
            },
            {
              code: 'HTTPS_DEVICE',
              title: 'HTTPS联通与真机',
              group: 'ACCEPTANCE',
              status: 'UNVERIFIED',
              detail: '不探测所填地址；DNS、证书、合法域名、通知可达性和真机支付尚未验收。',
            },
          ],
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
@ApiTags('支付接入检查（只读）')
@ApiCookieAuth('staffSession')
@Permissions('payment-readiness.read')
@Controller('admin/payment-readiness')
export class PaymentReadinessController {
  constructor(@Inject(PaymentReadinessService) private readonly service: PaymentReadinessService) {}
  @Get()
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiResult(
    object({
      checkedAt: { type: 'string', format: 'date-time' },
      channel: { type: 'string', enum: ['DISABLED'] },
      canStartPayment: { type: 'boolean', enum: [false] },
      warehouse: object({ id: { type: 'string', format: 'uuid' }, name: text }),
      checks: {
        type: 'array',
        maxItems: 11,
        items: object({
          code: text,
          title: text,
          group: {
            type: 'string',
            enum: ['CONFIGURATION', 'OPERATIONS', 'IMPLEMENTATION', 'ACCEPTANCE'],
          },
          status: {
            type: 'string',
            enum: ['MISSING', 'INVALID', 'FORMAT_OK', 'CONFIGURED', 'UNVERIFIED', 'BLOCKED'],
          },
          detail: text,
        }),
      },
    }),
    [400, 401, 403, 500],
  )
  async read(@Req() r: ApiRequest, @Query() q: unknown) {
    const b = fields(q, ['warehouseId']);
    return success(r, await this.service.read(r, uuid(b.warehouseId)));
  }
}
