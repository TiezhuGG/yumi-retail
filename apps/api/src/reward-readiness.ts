import { Prisma } from '@yumi/database';
import type { RewardReadiness } from '@yumi/contracts';
import type { CatalogService } from './catalog-service.js';
import type { PointsGrantService } from './points-grants.js';
import { failure, type ApiRequest } from './http.js';
import { object, text } from './api-result.js';

export async function rewardReadiness(
  service: { catalog: CatalogService; auth: PointsGrantService; redemptionEnabled: boolean },
  request: ApiRequest,
  id: string,
): Promise<RewardReadiness> {
  return service.catalog.db.$transaction(
    async (tx) => {
      const warehouseId = await service.auth.authorize(request, tx);
      const row = await tx.rewardProduct.findFirst({
        where: { id, warehouseId },
        include: {
          sku: {
            include: {
              product: { include: { category: { include: { parent: true } }, image: true } },
            },
          },
        },
      });
      if (!row) throw failure(404, 'RESOURCE_NOT_FOUND', '兑换商品不存在');
      const { sku } = row,
        { product } = sku,
        { category } = product;
      const now = (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0]!
        .now;
      // Same inventory formula as visibleSkus, independent of catalogue visibility so a draft
      // with physical stock is not misleadingly diagnosed as missing stock. No stock writes.
      const stock = (
        await tx.$queryRaw<Array<{ available: number; held: boolean; counting: boolean }>>`
      SELECT CASE WHEN COALESCE(b.inventory_hold,false) OR b.active_count_id IS NOT NULL THEN 0 ELSE
        LEAST(GREATEST(0,COALESCE(b.on_hand-b.reserved-b.blocked-b.safety,0)),COALESCE(SUM(GREATEST(0,sp.on_hand-sp.reserved-sp.blocked)) FILTER(WHERE loc.enabled AND (l.expires_at IS NULL OR l.expires_at>${now})),0))::int END AS available,
        COALESCE(b.inventory_hold,false) AS held,(b.active_count_id IS NOT NULL) AS counting
      FROM skus s LEFT JOIN stock_balances b ON b.sku_id=s.id AND b.warehouse_id=${warehouseId}::uuid
      LEFT JOIN stock_lots l ON l.sku_id=s.id AND l.warehouse_id=${warehouseId}::uuid
      LEFT JOIN stock_positions sp ON sp.lot_id=l.id LEFT JOIN warehouse_locations loc ON loc.id=sp.location_id
      WHERE s.id=${sku.id}::uuid GROUP BY s.id,b.warehouse_id,b.sku_id`
      )[0]!;
      const shipping = await tx.redemptionExpressPolicy.findUnique({ where: { warehouseId } });
      const checks: RewardReadiness['checks'] = [];
      const add = (
        code: string,
        title: string,
        status: RewardReadiness['checks'][number]['status'],
        detail: string,
        action: RewardReadiness['checks'][number]['action'] = null,
      ) => checks.push({ code, title, status, detail, action });
      const categoryReady = category.enabled && category.parent?.enabled !== false;
      add(
        'CATEGORY',
        '商品分类',
        categoryReady ? 'READY' : 'BLOCKING',
        categoryReady
          ? `${category.parent ? category.parent.name + ' / ' : ''}${category.name}`
          : category.parent?.enabled === false
            ? '父分类已停用，请先启用或更换分类。'
            : '当前分类已停用，请先启用或更换分类。',
        'CATEGORY',
      );
      add(
        'PRODUCT',
        '基础商品',
        product.status === 'PUBLISHED' ? 'READY' : 'BLOCKING',
        product.status === 'PUBLISHED'
          ? '基础商品已上架。'
          : '基础商品尚未上架，积分商品不能发布。',
        product.status === 'PUBLISHED' ? 'PRODUCT' : 'PUBLISH_SOURCE',
      );
      add(
        'SKU',
        '商品规格',
        sku.enabled ? 'READY' : 'BLOCKING',
        `${sku.spec} / ${sku.unit} · ${sku.enabled ? '已启用' : '已停用，需先启用'}`,
        'SKU',
      );
      add(
        'PRICE',
        '售价与兑换积分',
        'READY',
        `售价 ¥${(Number(sku.priceCents) / 100).toFixed(2)} · 兑换 ${row.pointsPrice} 积分；兑换只扣积分。`,
        'REWARD',
      );
      const imageReady = !!product.image && product.image.sortOrder !== null;
      add(
        'IMAGE',
        '商品封面',
        imageReady ? 'READY' : 'WARNING',
        imageReady
          ? '已配置封面，图片加载效果请在图片管理中预览核对。'
          : '尚未配置有效封面，可补图；当前规则不因缺图阻止上架。',
        'IMAGE',
      );
      const ended = !!row.endsAt && row.endsAt <= now,
        scheduled = !!row.startsAt && row.startsAt > now;
      add(
        'SCHEDULE',
        '开放时间',
        ended ? 'BLOCKING' : scheduled ? 'WARNING' : 'READY',
        ended
          ? '开放时间已结束，请先调整结束时间。'
          : scheduled
            ? '尚未到开始时间，可提前上架，届时才会展示。'
            : '当前处于开放时间内。',
        'REWARD',
      );
      add(
        'STOCK',
        '库存',
        stock.available > 0 ? 'READY' : 'WARNING',
        stock.held
          ? '库存核对冻结中，当前可用库存为0。'
          : stock.counting
            ? '正在盘点，当前可用库存为0。'
            : stock.available > 0
              ? `本仓可用库存 ${stock.available} 件；实际兑换仍需实时预占。`
              : '本仓可用库存为0；检查有效期、可用库位、安全量、隔离及预占，或由仓库收货入库。零库存允许上架但不能兑换。',
        'STOCK',
      );
      add(
        'SHIPPING',
        '快递范围与运费',
        shipping?.enabled && shipping.provinces.length && shipping.shippingFeeMode === 'SENDER_PAID'
          ? 'READY'
          : 'WARNING',
        shipping?.enabled && shipping.provinces.length
          ? `已启用 ${shipping.provinces.length} 个省级范围，商家承担运费；实际地址仍须核验。`
          : '尚未启用有效快递范围；不阻止商品上架，实际快递兑换可能被拒绝。',
        'SHIPPING',
      );
      add(
        'SUBMISSION',
        '兑换提交',
        service.redemptionEnabled ? 'INFO' : 'WARNING',
        service.redemptionEnabled
          ? '当前环境允许提交，仍受顾客身份、库存、积分及配送规则约束；不代表正式上线验收通过。'
          : '当前环境的兑换提交未开放；商品上架不会更改经营开关。',
        'STORE',
      );
      add(
        'STATE',
        '积分商品状态',
        'INFO',
        row.status === 'PUBLISHED'
          ? '积分商品已上架，仍可能因其他条件不可见或不可兑换。'
          : '保存规则后仍需使用独立上架操作。',
        'REWARD',
      );
      await service.auth.authorize(request, tx);
      const sourceReady = categoryReady && sku.enabled && product.status === 'PUBLISHED';
      return {
        checkedAt: now.toISOString(),
        canPublish: row.status !== 'PUBLISHED' && !checks.some((c) => c.status === 'BLOCKING'),
        displayableNow: sourceReady && row.status === 'PUBLISHED' && !ended && !scheduled,
        inventoryAvailable: stock.available,
        submissionEnabled: service.redemptionEnabled,
        product: {
          id: product.id,
          version: product.version,
          status: product.status,
          categoryId: category.id,
          parentCategoryId: category.parentId,
          categoryToEditId: category.parent?.enabled === false ? category.parent.id : category.id,
        },
        reward: {
          id: row.id,
          skuId: sku.id,
          title: row.title,
          name: product.name,
          spec: sku.spec,
          unit: sku.unit,
          priceCents: Number(sku.priceCents),
          pointsPrice: row.pointsPrice.toString(),
          status: row.status,
          version: row.version,
          sortOrder: row.sortOrder,
          perUserLimit: row.perUserLimit,
          totalQuota: row.totalQuota,
          startsAt: row.startsAt?.toISOString() ?? null,
          endsAt: row.endsAt?.toISOString() ?? null,
          available: sourceReady ? stock.available : 0,
        },
        checks,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
const integer = { type: 'integer' as const, minimum: 0 },
  nullable = { ...text, nullable: true };
const snapshotFields = Object.fromEntries(
  ['id', 'skuId', 'title', 'name', 'spec', 'unit', 'pointsPrice', 'status'].map((k) => [k, text]),
);
export const rewardReadinessSchema = object({
  checkedAt: { ...text, format: 'date-time' },
  canPublish: { type: 'boolean' },
  displayableNow: { type: 'boolean' },
  inventoryAvailable: integer,
  submissionEnabled: { type: 'boolean' },
  product: object({
    id: text,
    version: integer,
    status: text,
    categoryId: text,
    parentCategoryId: nullable,
    categoryToEditId: text,
  }),
  reward: object({
    ...snapshotFields,
    priceCents: integer,
    version: integer,
    sortOrder: integer,
    perUserLimit: integer,
    totalQuota: integer,
    startsAt: nullable,
    endsAt: nullable,
    available: integer,
  }),
  checks: {
    type: 'array',
    maxItems: 10,
    items: object({
      code: text,
      title: text,
      status: { type: 'string', enum: ['READY', 'WARNING', 'BLOCKING', 'INFO'] },
      detail: text,
      action: {
        type: 'string',
        nullable: true,
        enum: [
          'PRODUCT',
          'CATEGORY',
          'PUBLISH_SOURCE',
          'SKU',
          'IMAGE',
          'REWARD',
          'STOCK',
          'SHIPPING',
          'STORE',
          null,
        ],
      },
    }),
  },
});
