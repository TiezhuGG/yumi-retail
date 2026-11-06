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
              code: 'JSAPI_PROTOCOL',
              title: 'JSAPI下单与调起签名',
              group: 'IMPLEMENTATION',
              status: 'UNVERIFIED',
              detail:
                '请求签名、应答验签和小程序调起参数已实现并做离线验证；尚未接入真实商户凭据、HTTP下单或订单入账。',
            },
            {
              code: 'JSAPI_TRANSPORT',
              title: '凭据加载与HTTPS传输',
              group: 'IMPLEMENTATION',
              status: 'UNVERIFIED',
              detail:
                '私有凭据校验、轮换及固定地址HTTPS请求层已实现，仅用合成材料验证；支付尝试持久化、恢复和取消保护未接入，不提供下单入口。',
            },
            {
              code: 'PROVIDER',
              title: '支付渠道实现',
              group: 'IMPLEMENTATION',
              status: 'BLOCKED',
              detail: '订单尚未连接下单请求层，查询和关闭未实现，当前始终禁止发起支付。',
            },
            {
              code: 'CALLBACK',
              title: '支付通知与补偿',
              group: 'IMPLEMENTATION',
              status: 'BLOCKED',
              detail:
                '原文验签/解密及合成通知落库去重已隔离验证；真实接收、订单入账和查单补偿未实现，没有可用回调入口。',
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
              detail:
                '本页不接收或读取凭据。私有加载器已用合成材料验证；真实商户证书/公钥归属、保管、轮换和灾备尚未验收，APIv3密钥未接入。',
            },
            {
              code: 'IDENTITY',
              title: '真实微信身份',
              group: 'ACCEPTANCE',
              status: 'UNVERIFIED',
              detail:
                '登录时的付款人加密绑定已实现；旧微信账号需在配置独立密钥后重新登录补齐。开发身份和身份哈希不能用于付款，真实账号/环境尚未验收。',
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
        maxItems: 14,
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
