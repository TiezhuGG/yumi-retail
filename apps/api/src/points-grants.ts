import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@yumi/database';
import { CatalogService } from './catalog-service.js';
import { fields, integer, key, str, uuid } from './catalog-input.js';
import { Permissions } from './staff-guard.js';
import { failure, success } from './http.js';
import type { ApiRequest } from './http.js';
import { ApiResult, object, text } from './api-result.js';
type Grant = {
  id: string;
  userId: string;
  displayName: string;
  amount: string;
  reason: string;
  reference: string;
  creatorId: string;
  status: string;
  version: number;
  decisionReason: string | null;
};
const amount = (v: unknown) => {
  if (typeof v !== 'string' || !/^\d{1,10}$/.test(v) || BigInt(v) < 1n || BigInt(v) > 1000000000n)
    throw failure(400, 'VALIDATION_ERROR', '积分须为1至10亿的整数字符串');
  return BigInt(v).toString();
};
export class PointsGrantService {
  constructor(readonly catalog: CatalogService) {}
  async authorize(r: ApiRequest, tx: Prisma.TransactionClient = this.catalog.db, approve = false) {
    const warehouse = this.catalog.publicWarehouseId;
    if (!warehouse) throw failure(503, 'STORE_UNAVAILABLE', '尚未配置经营仓库');
    const actor = r.staffContext!.staffId;
    const rows = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT s.id FROM staff s JOIN staff_sessions sess ON sess.staff_id=s.id JOIN staff_warehouses w ON w.staff_id=s.id JOIN staff_roles role ON role.staff_id=s.id WHERE sess.id=${r.staffContext!.sessionId}::uuid AND sess.revoked_at IS NULL AND sess.expires_at>clock_timestamp() AND sess.auth_version=s.auth_version AND s.id=${actor}::uuid AND s.enabled AND w.warehouse_id=${warehouse}::uuid AND role.role_code IN ('SUPER_ADMIN','OPERATIONS') AND (NOT ${approve} OR role.role_code='SUPER_ADMIN') FOR SHARE OF s,w,role,sess`;
    if (!rows.length) throw failure(403, 'FORBIDDEN', '当前账号无积分操作权限');
    await this.catalog.warehouse(tx, r, warehouse);
    return warehouse;
  }
  async read(r: ApiRequest, q: unknown) {
    const warehouse = await this.authorize(r);
    const row = fields(q, ['cursor', 'userId', 'status']);
    const status = row.status === undefined ? null : str(row.status, 16);
    if (status !== null && !['SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELED'].includes(status))
      throw failure(400, 'VALIDATION_ERROR', '申请状态无效');
    const userId = row.userId === undefined ? null : uuid(row.userId);
    const cursor = row.cursor === undefined ? null : uuid(row.cursor);
    const policies = await this.catalog.db.$queryRaw<
      Array<{ enabled: boolean; singleLimit: string; dailyLimit: string; version: number }>
    >`SELECT enabled,single_limit::text AS "singleLimit",daily_limit::text AS "dailyLimit",version FROM points_grant_policies WHERE warehouse_id=${warehouse}::uuid`;
    const items = await this.catalog.db.$queryRaw<
      Grant[]
    >`SELECT g.id,g.user_id AS "userId",u.display_name AS "displayName",g.amount::text,g.reason,g.reference,g.creator_id AS "creatorId",g.status,g.version,g.decision_reason AS "decisionReason" FROM points_grants g JOIN consumer_users u ON u.id=g.user_id WHERE g.warehouse_id=${warehouse}::uuid AND (${userId}::uuid IS NULL OR g.user_id=${userId}::uuid) AND (${status}::text IS NULL OR g.status=${status}) AND (${cursor}::uuid IS NULL OR g.id>${cursor}::uuid) ORDER BY g.id LIMIT 21`;
    return {
      policy: policies[0] ?? null,
      items: items.slice(0, 20),
      nextCursor: items.length > 20 ? items[19]!.id : null,
    };
  }
  async write(r: ApiRequest, k: string, action: string, id: string, b: unknown) {
    const approval = action === 'policy' || action === 'approve' || action === 'reject';
    const warehouse = await this.authorize(r, undefined, approval);
    const body = fields(
      b,
      action === 'policy'
        ? ['version', 'enabled', 'singleLimit', 'dailyLimit', 'reason']
        : action === 'create'
          ? ['userId', 'amount', 'reason', 'reference']
          : ['version', 'reason'],
    );
    let input: Record<string, unknown>;
    if (action === 'policy') {
      if (typeof body.enabled !== 'boolean') throw failure(400, 'VALIDATION_ERROR', '启用字段无效');
      input = {
        version: integer(body.version, 0, 2147483646),
        enabled: body.enabled,
        singleLimit: amount(body.singleLimit),
        dailyLimit: amount(body.dailyLimit),
        reason: str(body.reason, 300),
      };
      if (BigInt(input.dailyLimit as string) < BigInt(input.singleLimit as string))
        throw failure(400, 'VALIDATION_ERROR', '每日预算不能低于单笔上限');
    } else if (action === 'create')
      input = {
        userId: uuid(body.userId),
        amount: amount(body.amount),
        reason: str(body.reason, 300),
        reference: str(body.reference, 120),
      };
    else input = { version: integer(body.version, 0, 2147483646), reason: str(body.reason, 300) };
    return this.catalog.write(r, 'POINTS_' + action, id, k, input, async (tx) => {
      await this.authorize(r, tx, approval);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${warehouse + ':points-grant-policy'},0))::text`;
      const policies = await tx.$queryRaw<
        Array<{ enabled: boolean; single_limit: bigint; daily_limit: bigint; version: number }>
      >`SELECT * FROM points_grant_policies WHERE warehouse_id=${warehouse}::uuid FOR UPDATE`;
      const policy = policies[0];
      if (action === 'policy') {
        if ((policy?.version ?? 0) !== input.version)
          throw failure(409, 'VERSION_CONFLICT', '规则已更新');
        await tx.$executeRaw`INSERT INTO points_grant_policies(warehouse_id,enabled,single_limit,daily_limit,version) VALUES(${warehouse}::uuid,${input.enabled as boolean},${BigInt(input.singleLimit as string)},${BigInt(input.dailyLimit as string)},1) ON CONFLICT(warehouse_id) DO UPDATE SET enabled=EXCLUDED.enabled,single_limit=EXCLUDED.single_limit,daily_limit=EXCLUDED.daily_limit,version=points_grant_policies.version+1`;
      } else if (action === 'create') {
        const user = await tx.consumerUser.findUnique({ where: { id: input.userId as string } });
        if (!user?.enabled) throw failure(409, 'USER_UNAVAILABLE', '用户不可用');
        const grantId = randomUUID();
        await tx.$executeRaw`INSERT INTO points_grants(id,warehouse_id,user_id,amount,reason,reference,creator_id) VALUES(${grantId}::uuid,${warehouse}::uuid,${input.userId as string}::uuid,${BigInt(input.amount as string)},${input.reason as string},${input.reference as string},${r.staffContext!.staffId}::uuid)`;
        await this.catalog.audit(
          tx,
          r,
          'POINTS_CREATE',
          grantId,
          warehouse,
          input.reason as string,
        );
        return { id: grantId };
      } else {
        const grants = await tx.$queryRaw<
          Array<{
            status: string;
            creator_id: string;
            user_id: string;
            amount: bigint;
            version: number;
          }>
        >`SELECT * FROM points_grants WHERE id=${id}::uuid AND warehouse_id=${warehouse}::uuid FOR UPDATE`;
        const grant = grants[0];
        if (!grant) throw failure(404, 'RESOURCE_NOT_FOUND', '发放申请不存在');
        if (grant.version !== input.version || grant.status !== 'SUBMITTED')
          throw failure(409, 'VERSION_CONFLICT', '申请已处理，请刷新');
        if (
          action === 'cancel'
            ? grant.creator_id !== r.staffContext!.staffId
            : grant.creator_id === r.staffContext!.staffId
        )
          throw failure(
            403,
            'INDEPENDENT_REVIEW_REQUIRED',
            '仅申请人可撤销，审批须由另一名负责人执行',
          );
        if (action === 'approve') {
          if (!policy?.enabled) throw failure(409, 'POINTS_GRANTS_PAUSED', '积分发放尚未启用');
          const totals = await tx.$queryRaw<
            Array<{ used: bigint }>
          >`SELECT COALESCE(SUM(amount),0)::bigint AS used FROM points_grants WHERE warehouse_id=${warehouse}::uuid AND status='APPROVED' AND (decided_at AT TIME ZONE 'Asia/Shanghai')::date=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date`;
          if (
            grant.amount > policy.single_limit ||
            grant.amount + (totals[0]?.used ?? 0n) > policy.daily_limit
          )
            throw failure(409, 'POINTS_BUDGET_EXCEEDED', '超过单笔或今日发放预算');
          await tx.$queryRaw`SELECT id FROM consumer_users WHERE id=${grant.user_id}::uuid AND enabled FOR SHARE`;
          const user = await tx.consumerUser.findUnique({ where: { id: grant.user_id } });
          if (!user?.enabled) throw failure(409, 'USER_UNAVAILABLE', '用户已停用');
          await tx.$executeRaw`INSERT INTO points_accounts(user_id) VALUES(${grant.user_id}::uuid) ON CONFLICT DO NOTHING`;
          await tx.$queryRaw`SELECT user_id FROM points_accounts WHERE user_id=${grant.user_id}::uuid FOR UPDATE`;
          await tx.$executeRaw`UPDATE points_accounts SET balance=balance+${grant.amount},version=version+1 WHERE user_id=${grant.user_id}::uuid`;
          await tx.$executeRaw`INSERT INTO points_ledger(id,user_id,delta,action_key,reason,actor_id) VALUES(${randomUUID()}::uuid,${grant.user_id}::uuid,${grant.amount},${'GRANT:' + id},${input.reason as string},${r.staffContext!.staffId}::uuid)`;
        }
        const status =
          action === 'approve' ? 'APPROVED' : action === 'reject' ? 'REJECTED' : 'CANCELED';
        await tx.$executeRaw`UPDATE points_grants SET status=${status},reviewer_id=${r.staffContext!.staffId}::uuid,decision_reason=${input.reason as string},decided_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=${id}::uuid`;
      }
      await this.catalog.audit(
        tx,
        r,
        'POINTS_' + action.toUpperCase(),
        action === 'policy' ? warehouse : id,
        warehouse,
        input.reason as string,
      );
      return { id };
    });
  }
}
@ApiTags('积分发放审批')
@ApiCookieAuth('staffSession')
@Permissions('points.write')
@Controller('admin/points/grants')
export class PointsGrantController {
  constructor(@Inject(PointsGrantService) readonly service: PointsGrantService) {}
  @Get()
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['SUBMITTED', 'APPROVED', 'REJECTED', 'CANCELED'],
  })
  @ApiQuery({ name: 'userId', required: false, type: String, description: '仅查看指定顾客的申请' })
  @ApiResult(
    object({
      policy: {
        ...object({
          enabled: { type: 'boolean' },
          singleLimit: text,
          dailyLimit: text,
          version: { type: 'integer' },
        }),
        nullable: true,
      },
      items: {
        type: 'array',
        items: object({
          id: text,
          userId: text,
          displayName: text,
          amount: text,
          reason: text,
          reference: text,
          creatorId: text,
          status: text,
          version: { type: 'integer' },
          decisionReason: { type: 'string', nullable: true },
        }),
      },
      nextCursor: { type: 'string', nullable: true },
    }),
  )
  async list(@Req() r: ApiRequest, @Query() q: unknown) {
    return success(r, await this.service.read(r, q));
  }
  @Post(':id/:action')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({
    schema: {
      oneOf: [
        object({ userId: text, amount: text, reason: text, reference: text }),
        object({
          version: { type: 'integer' },
          enabled: { type: 'boolean' },
          singleLimit: text,
          dailyLimit: text,
          reason: text,
        }),
        object({ version: { type: 'integer' }, reason: text }),
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
    if (!['create', 'policy', 'approve', 'reject', 'cancel'].includes(action))
      throw failure(404, 'RESOURCE_NOT_FOUND', '操作不存在');
    const resource = ['create', 'policy'].includes(action) ? 'store' : uuid(id);
    if (resource === 'store' && id !== 'store')
      throw failure(400, 'VALIDATION_ERROR', '创建和规则操作使用store资源');
    return success(r, await this.service.write(r, key(r), action, resource, b));
  }
}
