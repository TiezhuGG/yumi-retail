import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { CatalogService } from './catalog-service.js';
import { Consumer, Permissions } from './staff-guard.js';
import { fields, str, uuid } from './catalog-input.js';
import { failure, success } from './http.js';
import type { ApiRequest } from './http.js';
import { ApiResult, object, text } from './api-result.js';

export class PointsService {
  constructor(readonly catalog: CatalogService) {}
  async account(userId: string) {
    const rows = await this.catalog.db.$queryRaw<Array<{ balance: string }>>`
      SELECT balance::text FROM points_accounts WHERE user_id=${userId}::uuid`;
    return { balance: rows[0]?.balance ?? '0', expiryPolicy: 'NO_EXPIRY' };
  }
  async ledger(userId: string, query: unknown) {
    const q = fields(query, ['cursor']);
    const cursor = q.cursor === undefined ? null : uuid(q.cursor);
    const rows = await this.catalog.db.$queryRaw<
      Array<{
        id: string;
        delta: string;
        reason: string;
        createdAt: Date;
      }>
    >`SELECT id,delta::text,reason,created_at AS "createdAt" FROM points_ledger
       WHERE user_id=${userId}::uuid AND (${cursor}::uuid IS NULL OR id>${cursor}::uuid)
       ORDER BY id LIMIT 21`;
    const items = rows.slice(0, 20).map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
    return {
      items,
      hasMore: rows.length > 20,
      nextCursor: rows.length > 20 ? items.at(-1)!.id : null,
    };
  }
  async scope(r: ApiRequest) {
    const warehouseId = this.catalog.publicWarehouseId;
    if (!warehouseId) throw failure(503, 'STORE_UNAVAILABLE', '尚未配置经营仓库');
    await this.catalog.warehouse(this.catalog.db, r, warehouseId);
  }
  async users(r: ApiRequest, query: unknown) {
    await this.scope(r);
    const q = fields(query, ['keyword', 'cursor']);
    const keyword = q.keyword === undefined ? '' : str(q.keyword, 80);
    const cursor = q.cursor === undefined ? null : uuid(q.cursor);
    const rows = await this.catalog.db.$queryRaw<
      Array<{ id: string; displayName: string; balance: string }>
    >`
      SELECT u.id,u.display_name AS "displayName",COALESCE(a.balance,0)::text AS balance
      FROM consumer_users u LEFT JOIN points_accounts a ON a.user_id=u.id
      WHERE (${cursor}::uuid IS NULL OR u.id>${cursor}::uuid)
      AND strpos(lower(u.display_name),lower(${keyword}))>0 ORDER BY u.id LIMIT 21`;
    const items = rows.slice(0, 20);
    return {
      items,
      hasMore: rows.length > 20,
      nextCursor: rows.length > 20 ? items.at(-1)!.id : null,
    };
  }
}
const accountSchema = object({ balance: text, expiryPolicy: text });
const ledgerSchema = object({
  items: { type: 'array', items: object({ id: text, delta: text, reason: text, createdAt: text }) },
  hasMore: { type: 'boolean' },
  nextCursor: { type: 'string', nullable: true },
});
@ApiTags('本人积分')
@ApiBearerAuth('consumerSession')
@Consumer()
@Controller('consumer/points')
export class ConsumerPointsController {
  constructor(@Inject(PointsService) private readonly service: PointsService) {}
  @Get()
  @ApiResult(accountSchema)
  async account(@Req() r: ApiRequest, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.account(r.consumerContext!.userId));
  }
  @Get('ledger')
  @ApiResult(ledgerSchema)
  async ledger(@Req() r: ApiRequest, @Query() q: unknown) {
    return success(r, await this.service.ledger(r.consumerContext!.userId, q));
  }
}
@ApiTags('积分账户查询')
@ApiCookieAuth('staffSession')
@Permissions('points.read')
@Controller('admin/points/accounts')
export class AdminPointsController {
  constructor(@Inject(PointsService) private readonly service: PointsService) {}
  @Get()
  @ApiResult(
    object({
      items: { type: 'array', items: object({ id: text, displayName: text, balance: text }) },
      hasMore: { type: 'boolean' },
      nextCursor: { type: 'string', nullable: true },
    }),
  )
  async list(@Req() r: ApiRequest, @Query() q: unknown) {
    return success(r, await this.service.users(r, q));
  }
  @Get(':id/ledger')
  @ApiResult(ledgerSchema)
  async ledger(@Req() r: ApiRequest, @Param('id') id: string, @Query() q: unknown) {
    await this.service.scope(r);
    const userId = uuid(id);
    if (!(await this.service.catalog.db.consumerUser.findUnique({ where: { id: userId } })))
      throw failure(404, 'RESOURCE_NOT_FOUND', '用户不存在');
    return success(r, await this.service.ledger(userId, q));
  }
}
