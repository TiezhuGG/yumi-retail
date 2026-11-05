import { Controller, Get, Header, Inject, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { CatalogService } from './catalog-service.js';
import { redemptionReturnStateWhere } from './redemption-returns.js';
import { PointsGrantService } from './points-grants.js';
import type { ApplicationConfig } from './config.js';
import { Permissions } from './staff-guard.js';
import { fields } from './catalog-input.js';
import { success, type ApiRequest } from './http.js';
import { ApiResult, object, text } from './api-result.js';
import type { ExpressReadiness } from '@yumi/contracts';
export class ExpressReadinessService {
  readonly staff: PointsGrantService;
  constructor(
    readonly catalog: CatalogService,
    readonly config: ApplicationConfig,
  ) {
    this.staff = new PointsGrantService(catalog);
  }
  async read(r: ApiRequest): Promise<ExpressReadiness> {
    return this.catalog.db.$transaction(
      async (tx) => {
        const w = await this.staff.authorize(r, tx);
        const warehouse = await tx.warehouse.findUniqueOrThrow({
          where: { id: w },
          select: { name: true, enabled: true },
        });
        const policy = await tx.redemptionExpressPolicy.findUnique({ where: { warehouseId: w } });
        const rewards = await tx.rewardProduct.count({
          where: { warehouseId: w, status: 'PUBLISHED' },
        });
        const stats = (
          await tx.$queryRaw<
            Array<{ waiting: number; shipped: number; oldest: Date | null; exceptions: number }>
          >`SELECT
   count(*) FILTER(WHERE o.status='ACTIVE' AND j.state='EXPRESS_WAIT')::int AS waiting,
   count(*) FILTER(WHERE o.status='ACTIVE' AND j.state='EXPRESS_SHIPPED')::int AS shipped,
   min(o.created_at) FILTER(WHERE o.status='ACTIVE' AND j.state='EXPRESS_WAIT') AS oldest,
   count(*) FILTER(WHERE (o.status='CANCELED' AND (j.state IS DISTINCT FROM 'CANCELED' OR s.id IS NOT NULL)) OR (o.status='ACTIVE' AND (j.state IS NULL OR j.state NOT IN ('EXPRESS_WAIT','EXPRESS_SHIPPED') OR (j.state='EXPRESS_SHIPPED')<>(s.id IS NOT NULL))) OR EXISTS(SELECT 1 FROM redemption_picking_tasks p WHERE p.order_id=o.id) OR (o.status='ACTIVE' AND (SELECT COALESCE(sum(a.quantity),0) FROM redemption_allocations a WHERE a.order_id=o.id AND a.release_ledger_id IS NULL AND (CASE WHEN j.state='EXPRESS_SHIPPED' THEN a.consume_ledger_id IS NOT NULL ELSE a.consume_ledger_id IS NULL END))<>o.quantity))::int AS exceptions
   FROM redemption_orders o LEFT JOIN redemption_outbox j ON j.order_id=o.id LEFT JOIN redemption_express_shipments s ON s.order_id=o.id WHERE o.warehouse_id=${w}::uuid AND o.delivery_mode='EXPRESS'`
        )[0]!;
        const feedback = await tx.redemptionAfterSales.count({
          where: { warehouseId: w, status: { in: ['OPEN', 'PROCESSING'] } },
        });
        const badFeedback = (
          await tx.$queryRaw<
            Array<{ count: number }>
          >`SELECT count(*)::int AS count FROM redemption_after_sales c LEFT JOIN LATERAL (SELECT e.version,e.status,e.created_at FROM redemption_after_sales_events e WHERE e.case_id=c.id ORDER BY e.version DESC LIMIT 1) e ON true WHERE c.warehouse_id=${w}::uuid AND (e.version IS DISTINCT FROM c.version OR e.status IS DISTINCT FROM c.status OR e.created_at IS DISTINCT FROM c.updated_at OR (SELECT count(*) FROM redemption_after_sales_events a WHERE a.case_id=c.id)<>c.version+1)`
        )[0]!.count;
        const badClaims = (
          await tx.$queryRaw<
            Array<{ count: number }>
          >`SELECT count(*)::int AS count FROM redemption_express_shipments s WHERE s.warehouse_id=${w}::uuid AND (NOT EXISTS(SELECT 1 FROM redemption_express_waybills b WHERE b.shipment_id=s.id AND b.warehouse_id=s.warehouse_id AND b.carrier_code=s.carrier_code AND b.carrier_name=s.carrier_name AND b.tracking_no=s.tracking_no) OR EXISTS(SELECT 1 FROM redemption_express_shipment_corrections c WHERE c.shipment_id=s.id AND NOT EXISTS(SELECT 1 FROM redemption_express_waybills b WHERE b.shipment_id=s.id AND b.warehouse_id=s.warehouse_id AND b.carrier_code=c.carrier_code AND b.carrier_name=c.carrier_name AND b.tracking_no=c.tracking_no)))`
        )[0]!.count;
        const returnCounts = [];
        for (const status of ['REQUESTED', 'WAIT_RETURN', 'READY_TO_REFUND']) {
          returnCounts.push(
            await tx.redemptionReturn.count({
              where: { AND: [{ order: { warehouseId: w } }, redemptionReturnStateWhere(status)] },
            }),
          );
        }
        const badReturns = (
          await tx.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS count
          FROM redemption_returns r JOIN redemption_orders o ON o.id=r.order_id
          LEFT JOIN redemption_return_events a ON a.return_id=r.id AND a.kind='APPROVE'
          LEFT JOIN redemption_return_events c ON c.return_id=r.id AND c.kind='CANCEL'
          LEFT JOIN redemption_return_events d ON d.return_id=r.id AND d.kind='REJECT'
          LEFT JOIN redemption_return_events g ON g.return_id=r.id AND g.kind='RECEIVE'
          LEFT JOIN redemption_return_events f ON f.return_id=r.id AND f.kind='REFUND'
          LEFT JOIN points_ledger p ON p.action_key='RETURN_REFUND:'||r.id::text
          WHERE o.warehouse_id=${w}::uuid AND (
            r.user_id<>o.user_id OR o.delivery_mode<>'EXPRESS' OR o.status<>'ACTIVE'
            OR NOT EXISTS(SELECT 1 FROM redemption_express_shipments s WHERE s.order_id=o.id)
            OR (a.id IS NOT NULL)::int+(c.id IS NOT NULL)::int+(d.id IS NOT NULL)::int>1
            OR (a.id IS NOT NULL AND (a.requires_return IS NULL OR a.created_at<r.created_at))
            OR (g.id IS NOT NULL AND (a.id IS NULL OR a.requires_return IS DISTINCT FROM true OR g.quantity IS DISTINCT FROM r.quantity OR g.created_at<a.created_at OR g.condition IS NULL OR g.location IS NULL))
            OR (f.id IS NOT NULL AND (a.id IS NULL OR (a.requires_return AND g.id IS NULL) OR f.created_at<COALESCE(g.created_at,a.created_at)))
            OR (f.id IS NULL)<>(p.id IS NULL)
            OR (f.id IS NOT NULL AND (f.ledger_id IS DISTINCT FROM p.id OR p.user_id IS DISTINCT FROM r.user_id OR p.delta IS DISTINCT FROM r.quantity::bigint*o.points_price OR p.actor_id IS DISTINCT FROM f.actor_id))
            OR (SELECT COALESCE(sum(x.quantity),0) FROM redemption_returns x WHERE x.order_id=o.id AND NOT EXISTS(SELECT 1 FROM redemption_return_events e WHERE e.return_id=x.id AND e.kind IN ('REJECT','CANCEL')))>o.quantity
          )`
        )[0]!.count;
        const now = (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]!
          .now;
        await this.staff.authorize(r, tx);
        const check = (
          code: string,
          title: string,
          status: 'CONFIGURED' | 'BLOCKED' | 'UNVERIFIED',
          detail: string,
        ) => ({ code, title, status, detail });
        return {
          checkedAt: now.toISOString(),
          canLaunch: false,
          warehouseName: warehouse.name,
          metrics: {
            waiting: stats.waiting,
            shipped: stats.shipped,
            openFeedback: feedback,
            returnsRequested: returnCounts[0]!,
            returnsWaitingReceipt: returnCounts[1]!,
            returnsReadyToRefund: returnCounts[2]!,
            inconsistentReturns: badReturns,
            oldestWaitingAt: stats.oldest?.toISOString() ?? null,
            inconsistentOrders: stats.exceptions,
            inconsistentFeedback: badFeedback,
            inconsistentWaybills: badClaims,
          },
          checks: [
            check(
              'WAREHOUSE',
              '经营仓库',
              warehouse.enabled ? 'CONFIGURED' : 'BLOCKED',
              warehouse.enabled ? '当前仓库启用，仍需核对实际库房与实物。' : '当前仓库已停用。',
            ),
            check(
              'EXPRESS_POLICY',
              '快递范围与运费',
              policy?.enabled && policy.provinces.length && policy.shippingFeeMode === 'SENDER_PAID'
                ? 'CONFIGURED'
                : 'BLOCKED',
              policy?.enabled
                ? '已有寄送范围及商家承担运费配置；可达性、费用和真实地址仍需人工核实。'
                : '寄送规则缺失或暂停；不会默认全国发货。',
            ),
            check(
              'REWARDS',
              '兑换商品',
              rewards > 0 ? 'CONFIGURED' : 'BLOCKED',
              '已上架兑换商品 ' + rewards + ' 个；不代表商品来源、批次、效期及实时可售库存均可用。',
            ),
            check(
              'ENCRYPTION',
              '收件资料与反馈加密',
              this.config.addressEncryptionKey ? 'CONFIGURED' : 'BLOCKED',
              this.config.addressEncryptionKey
                ? '运行进程已配置加密密钥；密钥备份与恢复访问仍需验证。'
                : '运行进程未配置加密密钥。',
            ),
            check(
              'INVARIANTS',
              '快递事实核对',
              stats.exceptions + badFeedback + badClaims + badReturns === 0
                ? 'CONFIGURED'
                : 'BLOCKED',
              stats.exceptions + badFeedback + badClaims + badReturns === 0
                ? '本次检查未发现订单/预占、运单归属、反馈投影或售后/退积分流水差异；不代替全量账实核对。'
                : '发现事实差异；先暂停相关操作并核对原始记录，禁止自动填平。',
            ),
            check(
              'LOCAL_SWITCHES',
              '开发模式隔离',
              this.config.consumerDevLogin ||
                this.config.redemptionDevSubmit ||
                this.config.redemptionPickingDev
                ? 'BLOCKED'
                : 'CONFIGURED',
              '开发身份：' +
                (this.config.consumerDevLogin ? '开' : '关') +
                '；兑换提交：' +
                (this.config.redemptionDevSubmit ? '开' : '关') +
                '；快递作业：' +
                (this.config.redemptionPickingDev ? '开' : '关') +
                '。现有开关仅限本地隔离开发，不能用于生产放行。',
            ),
            check(
              'WECHAT_IDENTITY',
              '正式微信身份',
              this.config.wechatLogin && this.config.wechatAppId && this.config.wechatAppSecret
                ? 'CONFIGURED'
                : 'BLOCKED',
              this.config.wechatLogin
                ? '服务端微信身份适配器已配置；真实账号、AppID匹配、HTTPS及真机联调仍未验收。'
                : '微信身份适配器已实现但当前未开放或未配置；不会退回开发身份冒充登录。',
            ),
            check(
              'PRODUCTION_WRITE',
              '正式交易与作业门禁',
              this.config.pointsExpress?.mode && this.config.pointsExpress.mode !== 'off'
                ? 'CONFIGURED'
                : 'BLOCKED',
              '独立正式门禁已实现；当前模式：' +
                (this.config.pointsExpress?.mode ?? 'off') +
                '；新兑换：' +
                (this.config.pointsExpress?.submit ? '开' : '关') +
                '；快递/反馈作业：' +
                (this.config.pointsExpress?.operations ? '开' : '关') +
                '；受控账号数：' +
                (this.config.pointsExpress?.allowedUsers.length ?? 0) +
                '。配置不代表发布验收通过。',
            ),
            check(
              'DEVICE',
              'HTTPS与小程序工具/真机',
              'UNVERIFIED',
              '需真实测试域名、合法请求域名、微信工具及真机验证登录、兑换、原键恢复和隐私清理。',
            ),
            check(
              'PHYSICAL',
              '打印机与快递交接',
              'UNVERIFIED',
              '需实际打印配货单、核对实物/原批次库位、交快递及真实运单查询，浏览器截图不能代替。',
            ),
            check(
              'RECOVERY',
              '备份恢复及密钥恢复',
              'UNVERIFIED',
              '需在独立环境恢复数据库和密钥后核对原地址、积分、库存、运单与反馈；迁移重放不等于备份恢复。',
            ),
            check(
              'OPERATIONS',
              '经营参数与异常值守',
              'UNVERIFIED',
              '需负责人核实商品、寄送范围/成本、积分规则、售后沟通和监控值守安排。',
            ),
            check(
              'DEPLOYMENT',
              '受控部署授权与验收',
              'UNVERIFIED',
              '准备匹配版本、迁移、恢复方案和监控后，再单独执行已授权的受控部署；此页没有发布按钮。',
            ),
          ],
        };
      },
      { isolationLevel: 'RepeatableRead', timeout: 15000 },
    );
  }
}
const count = { type: 'integer' as const, minimum: 0 };
@ApiTags('积分快递首发准备')
@ApiCookieAuth('staffSession')
@Permissions('points.read')
@Controller('admin/redemption-express-readiness')
export class ExpressReadinessController {
  constructor(@Inject(ExpressReadinessService) readonly service: ExpressReadinessService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiResult(
    object({
      checkedAt: text,
      canLaunch: { type: 'boolean', enum: [false] },
      warehouseName: text,
      metrics: object({
        waiting: count,
        shipped: count,
        openFeedback: count,
        returnsRequested: count,
        returnsWaitingReceipt: count,
        returnsReadyToRefund: count,
        inconsistentReturns: count,
        oldestWaitingAt: { type: 'string', nullable: true },
        inconsistentOrders: count,
        inconsistentFeedback: count,
        inconsistentWaybills: count,
      }),
      checks: {
        type: 'array',
        items: object({
          code: text,
          title: text,
          status: { type: 'string', enum: ['CONFIGURED', 'BLOCKED', 'UNVERIFIED'] },
          detail: text,
        }),
      },
    }),
    [400, 401, 403, 500, 503],
  )
  async read(@Req() r: ApiRequest, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.read(r));
  }
}
