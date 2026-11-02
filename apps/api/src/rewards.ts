import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@yumi/database';
import { CatalogService } from './catalog-service.js';
import { PointsGrantService } from './points-grants.js';
import { fields, instant, integer, key, str, uuid } from './catalog-input.js';
import { Permissions, Public } from './staff-guard.js';
import { failure, success } from './http.js';
import type { ApiRequest } from './http.js';
import { ApiResult, object, text } from './api-result.js';

export type Reward = {
  id: string;
  skuId: string;
  title: string;
  name: string;
  spec: string;
  unit: string;
  description: string;
  categoryId: string;
  imageUrl: string | null;
  pointsPrice: string;
  status: string;
  sortOrder: number;
  perUserLimit: number;
  totalQuota: number;
  startsAt: Date | null;
  endsAt: Date | null;
  version: number;
  available: number;
};
const number = { type: 'integer' as const, minimum: 0 };
const nullableText = { type: 'string' as const, nullable: true };
const rewardSchema = object({
  id: text,
  skuId: text,
  title: text,
  name: text,
  spec: text,
  unit: text,
  description: text,
  categoryId: text,
  imageUrl: nullableText,
  pointsPrice: text,
  status: text,
  sortOrder: number,
  perUserLimit: number,
  totalQuota: number,
  startsAt: nullableText,
  endsAt: nullableText,
  version: number,
  available: number,
  redemptionEnabled: { type: 'boolean' },
});
const pageSchema = object({
  items: { type: 'array', items: rewardSchema },
  nextCursor: nullableText,
});
const detailsSchema = object(
  {
    title: text,
    pointsPrice: text,
    sortOrder: number,
    perUserLimit: number,
    totalQuota: number,
    startsAt: nullableText,
    endsAt: nullableText,
    reason: text,
  },
  ['title', 'pointsPrice', 'sortOrder', 'perUserLimit', 'totalQuota', 'reason'],
);
export class RewardService {
  readonly auth: PointsGrantService;
  constructor(
    readonly catalog: CatalogService,
    readonly redemptionEnabled = false,
  ) {
    this.auth = new PointsGrantService(catalog);
  }
  async list(q: unknown, r?: ApiRequest, id?: string) {
    const warehouse = r ? await this.auth.authorize(r) : await this.catalog.publicStore();
    const query = fields(q, ['keyword', 'categoryId', 'cursor', 'status']);
    const keyword = query.keyword === undefined ? '' : str(query.keyword, 80);
    const categoryId = query.categoryId === undefined ? null : uuid(query.categoryId);
    const cursor = query.cursor === undefined ? null : uuid(query.cursor);
    const status = query.status === undefined ? null : str(query.status, 16);
    if ((!r && status) || (status && !['DRAFT', 'PUBLISHED', 'UNPUBLISHED'].includes(status)))
      throw failure(400, 'VALIDATION_ERROR', '状态筛选无效');
    // Shared cash/points sellability calculation: expiry, blocked stock, safety, count holds and enabled locations.
    const visible = this.catalog.visibleSkus(warehouse, { keyword: '', categoryId: null });
    const where = Prisma.sql`rp.warehouse_id=${warehouse}::uuid
   AND (${id ?? null}::uuid IS NULL OR rp.id=${id ?? null}::uuid)
   AND (${status}::text IS NULL OR rp.status=${status})
   AND strpos(lower(rp.title||' '||p.name||' '||s.spec),lower(${keyword}))>0
   AND (${categoryId}::uuid IS NULL OR p.category_id=${categoryId}::uuid OR c.parent_id=${categoryId}::uuid)
   AND (${!!r} OR (rp.status='PUBLISHED' AND v.id IS NOT NULL AND (rp.starts_at IS NULL OR rp.starts_at<=statement_timestamp()) AND (rp.ends_at IS NULL OR rp.ends_at>statement_timestamp())))`;
    let anchor: { sort_order: number; id: string } | undefined;
    if (cursor) {
      const rows = await this.catalog.db.$queryRaw<Array<{ sort_order: number; id: string }>>(
        Prisma.sql`SELECT rp.sort_order,rp.id FROM reward_products rp JOIN skus s ON s.id=rp.sku_id JOIN products p ON p.id=s.product_id JOIN categories c ON c.id=p.category_id LEFT JOIN (${visible}) v ON v.id=s.id WHERE ${where} AND rp.id=${cursor}::uuid`,
      );
      anchor = rows[0];
      if (!anchor) throw failure(409, 'CURSOR_INVALID', '商品列表已变化，请重新查询');
    }
    const rows = await this.catalog.db.$queryRaw<Reward[]>(Prisma.sql`
   SELECT rp.id,rp.sku_id AS "skuId",rp.title,p.name,s.spec,s.unit,p.description,p.category_id AS "categoryId",v."imageUrl",rp.points_price::text AS "pointsPrice",rp.status,rp.sort_order AS "sortOrder",rp.per_user_limit AS "perUserLimit",rp.total_quota AS "totalQuota",rp.starts_at AS "startsAt",rp.ends_at AS "endsAt",rp.version,
   LEAST(COALESCE(v.available,0),GREATEST(0,rp.total_quota-COALESCE((SELECT SUM(quantity) FROM redemption_orders WHERE reward_id=rp.id AND status='ACTIVE'),0)),rp.per_user_limit)::int AS available
   FROM reward_products rp JOIN skus s ON s.id=rp.sku_id JOIN products p ON p.id=s.product_id JOIN categories c ON c.id=p.category_id LEFT JOIN (${visible}) v ON v.id=s.id
   WHERE ${where} AND (${cursor}::uuid IS NULL OR (rp.sort_order,rp.id)>(${anchor?.sort_order ?? 0},${cursor}::uuid))
   ORDER BY rp.sort_order,rp.id LIMIT 21`);
    const items = rows
      .slice(0, 20)
      .map((row) => ({ ...row, redemptionEnabled: this.redemptionEnabled }));
    if (id && !items.length) throw failure(404, 'REWARD_UNAVAILABLE', '兑换商品暂不可用');
    return { items, nextCursor: rows.length > 20 ? items.at(-1)!.id : null };
  }
  async write(r: ApiRequest, k: string, action: string, id: string, value: unknown) {
    const warehouse = await this.auth.authorize(r);
    const b = fields(
      value,
      action === 'create'
        ? [
            'skuId',
            'title',
            'pointsPrice',
            'sortOrder',
            'perUserLimit',
            'totalQuota',
            'startsAt',
            'endsAt',
            'reason',
          ]
        : action === 'update'
          ? [
              'version',
              'title',
              'pointsPrice',
              'sortOrder',
              'perUserLimit',
              'totalQuota',
              'startsAt',
              'endsAt',
              'reason',
            ]
          : ['version', 'reason'],
    );
    const reason = str(b.reason, 300);
    let input: Record<string, unknown> = { reason };
    if (action !== 'create') input.version = integer(b.version, 0, 2147483646);
    if (action === 'create' || action === 'update') {
      if (
        typeof b.pointsPrice !== 'string' ||
        !/^\d{1,10}$/.test(b.pointsPrice) ||
        BigInt(b.pointsPrice) < 1n ||
        BigInt(b.pointsPrice) > 1000000000n
      )
        throw failure(400, 'VALIDATION_ERROR', '积分价须为1至10亿的整数字符串');
      input = {
        ...input,
        title: str(b.title, 120),
        pointsPrice: BigInt(b.pointsPrice).toString(),
        sortOrder: integer(b.sortOrder, 0, 1000000),
        perUserLimit: integer(b.perUserLimit, 1, 100000),
        totalQuota: integer(b.totalQuota, 1, 100000000),
        startsAt: instant(b.startsAt),
        endsAt: instant(b.endsAt),
      };
      if (Number(input.perUserLimit) > Number(input.totalQuota))
        throw failure(400, 'VALIDATION_ERROR', '每人限额不能超过总配额');
      if (input.startsAt && input.endsAt && String(input.startsAt) >= String(input.endsAt))
        throw failure(400, 'VALIDATION_ERROR', '结束时间须晚于开始时间');
      if (action === 'create') input.skuId = uuid(b.skuId);
    }
    return this.catalog.write(r, 'REWARD_' + action, id, k, input, async (tx) => {
      await this.auth.authorize(r, tx);
      let rewardId = id;
      if (action === 'create') {
        rewardId = randomUUID();
        const sku = await tx.sku.findUnique({ where: { id: input.skuId as string } });
        if (!sku) throw failure(404, 'RESOURCE_NOT_FOUND', '商品规格不存在');
        await tx.rewardProduct.create({
          data: { id: rewardId, warehouseId: warehouse, skuId: sku.id, ...this.details(input) },
        });
      } else {
        const rows = await tx.$queryRaw<
          Array<{ version: number; status: string; sku_id: string }>
        >`SELECT version,status,sku_id FROM reward_products WHERE id=${id}::uuid AND warehouse_id=${warehouse}::uuid FOR UPDATE`;
        const row = rows[0];
        if (!row) throw failure(404, 'RESOURCE_NOT_FOUND', '兑换商品不存在');
        if (row.version !== input.version)
          throw failure(409, 'VERSION_CONFLICT', '商品已更新，请刷新后重新确认');
        if (action === 'update') {
          const usage = await tx.$queryRaw<
            Array<{ total: bigint; largest: bigint }>
          >`SELECT COALESCE(SUM(q),0)::bigint AS total,COALESCE(MAX(q),0)::bigint AS largest FROM (SELECT SUM(quantity) q FROM redemption_orders WHERE reward_id=${id}::uuid AND status='ACTIVE' GROUP BY user_id) used`;
          if (
            usage[0]!.total > BigInt(input.totalQuota as number) ||
            usage[0]!.largest > BigInt(input.perUserLimit as number)
          )
            throw failure(409, 'QUOTA_BELOW_USAGE', '限额不能低于当前有效兑换用量');
        }
        if (action === 'update')
          await tx.rewardProduct.update({
            where: { id },
            data: { ...this.details(input), version: { increment: 1 } },
          });
        else {
          if (action === 'publish') {
            if (row.status === 'PUBLISHED') throw failure(409, 'INVALID_TRANSITION', '商品已上架');
            // Lock source catalogue rows in the same order as catalogue writers.
            const sku = await tx.sku.findUniqueOrThrow({
              where: { id: row.sku_id },
              include: { product: true },
            });
            await this.catalog.lockCategoryTree(tx, sku.product.categoryId);
            await tx.$queryRaw`SELECT id FROM products WHERE id=${sku.productId}::uuid FOR SHARE`;
            await tx.$queryRaw`SELECT id FROM skus WHERE id=${sku.id}::uuid FOR SHARE`;
            const visible = await this.catalog.checkoutSkus(tx, warehouse, [sku.id]);
            if (!visible.length)
              throw failure(409, 'REWARD_UNAVAILABLE', '请先启用真实商品、规格和分类');
            const current = await tx.rewardProduct.findUniqueOrThrow({ where: { id } });
            if (current.endsAt && current.endsAt.getTime() <= Date.now())
              throw failure(409, 'REWARD_UNAVAILABLE', '开放时间已结束，请先修改');
          } else if (row.status !== 'PUBLISHED')
            throw failure(409, 'INVALID_TRANSITION', '仅已上架商品可以下架');
          await tx.rewardProduct.update({
            where: { id },
            data: {
              status: action === 'publish' ? 'PUBLISHED' : 'UNPUBLISHED',
              version: { increment: 1 },
            },
          });
        }
      }
      await this.catalog.audit(
        tx,
        r,
        'REWARD_' + action.toUpperCase(),
        rewardId,
        warehouse,
        reason,
        input as Prisma.InputJsonValue,
      );
      return { id: rewardId };
    });
  }
  private details(input: Record<string, unknown>) {
    return {
      title: input.title as string,
      pointsPrice: BigInt(input.pointsPrice as string),
      sortOrder: input.sortOrder as number,
      perUserLimit: input.perUserLimit as number,
      totalQuota: input.totalQuota as number,
      startsAt: input.startsAt ? new Date(input.startsAt as string) : null,
      endsAt: input.endsAt ? new Date(input.endsAt as string) : null,
    };
  }
}
@ApiTags('积分商城浏览')
@Public()
@Controller('rewards')
export class PublicRewardController {
  constructor(@Inject(RewardService) readonly service: RewardService) {}
  @Get()
  @ApiQuery({ name: 'keyword', required: false })
  @ApiQuery({ name: 'categoryId', required: false })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiResult(pageSchema, [400, 401, 403, 409, 500, 503])
  async list(@Req() r: ApiRequest, @Query() q: unknown) {
    return success(r, await this.service.list(q));
  }
  @Get(':id')
  @ApiResult(rewardSchema, [400, 404, 500, 503])
  async detail(@Req() r: ApiRequest, @Param('id') id: string, @Query() q: unknown) {
    fields(q, []);
    return success(r, (await this.service.list({}, undefined, uuid(id))).items[0]);
  }
}
@ApiTags('兑换商品管理')
@ApiCookieAuth('staffSession')
@Permissions('points.write')
@Controller('admin/rewards')
export class AdminRewardController {
  constructor(@Inject(RewardService) readonly service: RewardService) {}
  @Get()
  @ApiResult(pageSchema, [400, 401, 403, 409, 500, 503])
  async list(@Req() r: ApiRequest, @Query() q: unknown) {
    return success(r, await this.service.list(q, r));
  }
  @Get('skus')
  @ApiResult(
    object({
      items: {
        type: 'array',
        items: object({
          id: text,
          name: text,
          spec: text,
          unit: text,
          enabled: { type: 'boolean' },
        }),
      },
      nextCursor: nullableText,
    }),
  )
  async skus(@Req() r: ApiRequest, @Query() q: unknown) {
    await this.service.auth.authorize(r);
    const b = fields(q, ['keyword', 'cursor']);
    const keyword = b.keyword === undefined ? '' : str(b.keyword, 80),
      cursor = b.cursor === undefined ? null : uuid(b.cursor);
    const rows = await this.service.catalog.db.$queryRaw<
      Array<{ id: string; name: string; spec: string; unit: string; enabled: boolean }>
    >`SELECT s.id,p.name,s.spec,s.unit,s.enabled FROM skus s JOIN products p ON p.id=s.product_id WHERE strpos(lower(p.name||' '||s.spec),lower(${keyword}))>0 AND (${cursor}::uuid IS NULL OR s.id>${cursor}::uuid) ORDER BY s.id LIMIT 21`;
    return success(r, {
      items: rows.slice(0, 20),
      nextCursor: rows.length > 20 ? rows[19]!.id : null,
    });
  }
  @Post(':id/:action')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({
    schema: {
      oneOf: [
        {
          ...detailsSchema,
          properties: { ...detailsSchema.properties, skuId: text },
          required: [...detailsSchema.required!, 'skuId'],
        },
        {
          ...detailsSchema,
          properties: { ...detailsSchema.properties, version: number },
          required: [...detailsSchema.required!, 'version'],
        },
        object({ version: number, reason: text }),
      ],
    },
  })
  @ApiResult(object({ id: text }), [400, 401, 403, 404, 409, 500, 503])
  async write(
    @Req() r: ApiRequest,
    @Param('id') id: string,
    @Param('action') action: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    if (!['create', 'update', 'publish', 'unpublish'].includes(action))
      throw failure(404, 'RESOURCE_NOT_FOUND', '操作不存在');
    if (action === 'create' && id !== 'store')
      throw failure(400, 'VALIDATION_ERROR', '创建操作使用store');
    return success(
      r,
      await this.service.write(r, key(r), action, action === 'create' ? 'store' : uuid(id), b),
    );
  }
}
