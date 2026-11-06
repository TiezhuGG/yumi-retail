import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@yumi/database';
import { CatalogService } from './catalog-service.js';
import { PointsGrantService } from './points-grants.js';
import { fields, key, productInput, str, uuid } from './catalog-input.js';
import { Permissions } from './staff-guard.js';
import { failure, success } from './http.js';
import type { ApiRequest } from './http.js';
import { ApiResult, object, text } from './api-result.js';

export class AdminMallService {
  readonly auth: PointsGrantService;
  constructor(readonly catalog: CatalogService) {
    this.auth = new PointsGrantService(catalog);
  }
  async create(r: ApiRequest, requestKey: string, value: unknown) {
    const b = fields(value, ['categoryId', 'name', 'description', 'skus', 'pointsPrice', 'reason']);
    const input = productInput({
      categoryId: b.categoryId,
      name: b.name,
      description: b.description,
      skus: b.skus,
    });
    const pointsPrice =
      b.pointsPrice === undefined || b.pointsPrice === null ? null : b.pointsPrice;
    if (
      pointsPrice !== null &&
      (typeof pointsPrice !== 'string' ||
        !/^\d{1,10}$/.test(pointsPrice) ||
        BigInt(pointsPrice) < 1n ||
        BigInt(pointsPrice) > 1000000000n)
    )
      throw failure(400, 'VALIDATION_ERROR', '兑换积分须为1至10亿的整数');
    if (input.skus.length !== 1)
      throw failure(400, 'VALIDATION_ERROR', '此入口先创建一个规格，其他规格可在商品详情添加');
    const reason = str(b.reason, 300);
    const warehouseId = await this.auth.authorize(r);
    return this.catalog.write(
      r,
      'MALL_PRODUCT_CREATE',
      'catalog',
      requestKey,
      { ...input, pointsPrice, reason },
      async (tx) => {
        await this.auth.authorize(r, tx);
        const product = await this.catalog.insertProduct(tx, r, input);
        let rewardId: string | null = null;
        if (pointsPrice !== null) {
          rewardId = randomUUID();
          await tx.rewardProduct.create({
            data: {
              id: rewardId,
              warehouseId,
              skuId: product.skus[0]!.id,
              title: input.name,
              pointsPrice: BigInt(pointsPrice),
              sortOrder: 0,
              perUserLimit: 100000,
              totalQuota: 100000000,
            },
          });
          await this.catalog.audit(tx, r, 'REWARD_CREATE', rewardId, warehouseId, reason, {
            productId: product.id,
            pointsPrice,
          });
        }
        await this.auth.authorize(r, tx);
        return { id: product.id, skuId: product.skus[0]!.id, rewardId };
      },
    );
  }
  async customers(r: ApiRequest, query: unknown, id?: string) {
    const b = fields(query, id ? [] : ['keyword', 'provider', 'enabled', 'cursor']);
    const keyword = b.keyword === undefined ? '' : str(b.keyword, 80),
      provider = b.provider === undefined ? null : str(b.provider, 16),
      enabled =
        b.enabled === undefined
          ? null
          : b.enabled === 'true'
            ? true
            : b.enabled === 'false'
              ? false
              : 'INVALID',
      cursor = b.cursor === undefined ? null : uuid(b.cursor);
    if ((provider && !['WECHAT', 'DEVELOPMENT'].includes(provider)) || enabled === 'INVALID')
      throw failure(400, 'VALIDATION_ERROR', '顾客筛选无效');
    return this.catalog.db.$transaction(
      async (tx) => {
        const warehouseId = await this.auth.authorize(r, tx);
        const where = Prisma.sql`strpos(lower(u.display_name),lower(${keyword}))>0 AND (${provider}::text IS NULL OR u.provider=${provider}) AND (${enabled}::boolean IS NULL OR u.enabled=${enabled})`;
        if (cursor) {
          const anchor = await tx.$queryRaw<Array<{ id: string }>>(
            Prisma.sql`SELECT u.id FROM consumer_users u WHERE ${where} AND u.id=${cursor}::uuid`,
          );
          if (!anchor.length) throw failure(409, 'CURSOR_INVALID', '顾客列表已变化，请重新查询');
        }
        const rows = await tx.$queryRaw<
          Array<{
            id: string;
            displayName: string;
            provider: string;
            enabled: boolean;
            stateVersion: number;
            createdAt: Date;
            balance: string;
          }>
        >(
          Prisma.sql`SELECT u.id,u.display_name AS "displayName",u.provider,u.enabled,u.auth_version AS "stateVersion",u.created_at AS "createdAt",COALESCE(a.balance,0)::text AS balance FROM consumer_users u LEFT JOIN points_accounts a ON a.user_id=u.id WHERE ${where} AND (${id ?? null}::uuid IS NULL OR u.id=${id ?? null}::uuid) AND (${cursor}::uuid IS NULL OR u.id>${cursor}::uuid) ORDER BY u.id LIMIT 21`,
        );
        const items = rows
          .slice(0, 20)
          .map((u) => ({ ...u, createdAt: u.createdAt.toISOString() }));
        if (!id) {
          await this.auth.authorize(r, tx);
          return { items, nextCursor: rows.length > 20 ? items.at(-1)!.id : null };
        }
        if (!items.length) throw failure(404, 'CUSTOMER_NOT_FOUND', '顾客不存在');
        const last = await tx.consumerSession.aggregate({
          where: { userId: id },
          _max: { createdAt: true },
        });
        const [orders, redemptions, pendingGrants, pendingCorrections] = await Promise.all([
          tx.consumerOrder.count({ where: { userId: id, warehouseId } }),
          tx.redemptionOrder.count({ where: { userId: id, warehouseId } }),
          tx.pointsGrant.count({ where: { userId: id, warehouseId, status: 'SUBMITTED' } }),
          tx.pointsCorrection.count({ where: { userId: id, warehouseId, status: 'SUBMITTED' } }),
        ]);
        await this.auth.authorize(r, tx);
        return {
          user: items[0]!,
          lastLoginAt: last._max.createdAt?.toISOString() ?? null,
          orders,
          redemptions,
          pendingGrants,
          pendingCorrections,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
const userSchema = object({
  id: text,
  displayName: text,
  provider: { type: 'string', enum: ['WECHAT', 'DEVELOPMENT'] },
  enabled: { type: 'boolean' },
  stateVersion: { type: 'integer', minimum: 0 },
  createdAt: text,
  balance: text,
});
const count = { type: 'integer' as const, minimum: 0 };
@ApiTags('顾客管理')
@ApiCookieAuth('staffSession')
@Permissions('points.read')
@Controller('admin/customers')
export class AdminCustomersController {
  constructor(@Inject(AdminMallService) readonly service: AdminMallService) {}
  @Get()
  @ApiQuery({ name: 'keyword', required: false })
  @ApiQuery({ name: 'provider', required: false, enum: ['WECHAT', 'DEVELOPMENT'] })
  @ApiQuery({ name: 'enabled', required: false, enum: ['true', 'false'] })
  @ApiQuery({ name: 'cursor', required: false })
  @ApiResult(
    object({
      items: { type: 'array', items: userSchema },
      nextCursor: { ...text, nullable: true },
    }),
    [400, 401, 403, 409, 503],
  )
  async list(@Req() r: ApiRequest, @Query() q: unknown) {
    return success(r, await this.service.customers(r, q));
  }
  @Get(':id')
  @ApiResult(
    object({
      user: userSchema,
      lastLoginAt: { ...text, nullable: true },
      orders: count,
      redemptions: count,
      pendingGrants: count,
      pendingCorrections: count,
    }),
    [400, 401, 403, 404, 503],
  )
  async detail(@Req() r: ApiRequest, @Param('id') id: string, @Query() q: unknown) {
    return success(r, await this.service.customers(r, q, uuid(id)));
  }
}
@ApiTags('商城商品创建')
@ApiCookieAuth('staffSession')
@Permissions('catalog.write', 'points.write')
@Controller('admin/mall-products')
export class AdminMallProductController {
  constructor(@Inject(AdminMallService) readonly service: AdminMallService) {}
  @Post()
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({
    schema: object(
      {
        categoryId: text,
        name: text,
        description: text,
        skus: {
          type: 'array',
          minItems: 1,
          maxItems: 1,
          items: object({
            code: text,
            spec: text,
            unit: text,
            priceCents: { type: 'integer', minimum: 1, maximum: 100000000 },
            expiryManaged: { type: 'boolean' },
          }),
        },
        pointsPrice: { ...text, nullable: true },
        reason: text,
      },
      ['categoryId', 'name', 'skus', 'reason'],
    ),
  })
  @ApiResult(
    object({ id: text, skuId: text, rewardId: { ...text, nullable: true } }),
    [400, 401, 403, 409, 503],
  )
  async create(@Req() r: ApiRequest, @Body() b: unknown, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.create(r, key(r), b));
  }
}
