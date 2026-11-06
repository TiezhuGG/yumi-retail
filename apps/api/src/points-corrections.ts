import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CatalogService } from './catalog-service.js';
import { PointsGrantService } from './points-grants.js';
import { fields, integer, key, str, uuid } from './catalog-input.js';
import { Permissions } from './staff-guard.js';
import { failure, success } from './http.js';
import type { ApiRequest } from './http.js';
import { ApiResult, object, text } from './api-result.js';
const parseAmount = (v: unknown) => {
  if (typeof v !== 'string' || !/^\d{1,10}$/.test(v) || BigInt(v) < 1n || BigInt(v) > 1000000000n)
    throw failure(400, 'VALIDATION_ERROR', '冲正积分须为1至10亿的整数字符串');
  return BigInt(v).toString();
};
export class PointsCorrectionService {
  constructor(readonly catalog: CatalogService) {}
  authorize(...args: Parameters<PointsGrantService['authorize']>) {
    return new PointsGrantService(this.catalog).authorize(...args);
  }
  async sources(r: ApiRequest, q: unknown) {
    const warehouse = await this.authorize(r);
    const b = fields(q, ['cursor', 'keyword', 'userId']);
    const userId = b.userId === undefined ? null : uuid(b.userId);
    const cursor = b.cursor === undefined ? null : uuid(b.cursor),
      keyword = b.keyword === undefined ? '' : str(b.keyword, 80);
    const rows = await this.catalog.db.$queryRaw<
      Array<{
        id: string;
        displayName: string;
        amount: string;
        remainingAmount: string;
        reference: string;
        reason: string;
      }>
    >`SELECT g.id,u.display_name AS "displayName",g.amount::text,(g.amount-COALESCE((SELECT SUM(c.amount) FROM points_corrections c WHERE c.grant_id=g.id AND c.status IN ('SUBMITTED','APPROVED')),0))::text AS "remainingAmount",g.reference,g.reason FROM points_grants g JOIN consumer_users u ON u.id=g.user_id WHERE g.warehouse_id=${warehouse}::uuid AND (${userId}::uuid IS NULL OR g.user_id=${userId}::uuid) AND g.status='APPROVED' AND (${cursor}::uuid IS NULL OR g.id>${cursor}::uuid) AND strpos(lower(u.display_name),lower(${keyword}))>0 ORDER BY g.id LIMIT 21`;
    return { items: rows.slice(0, 20), nextCursor: rows.length > 20 ? rows[19]!.id : null };
  }
  async read(r: ApiRequest, q: unknown) {
    const warehouse = await this.authorize(r);
    const b = fields(q, ['cursor', 'userId']);
    const userId = b.userId === undefined ? null : uuid(b.userId);
    const cursor = b.cursor === undefined ? null : uuid(b.cursor);
    const rows = await this.catalog.db.$queryRaw<
      Array<{
        id: string;
        grantId: string;
        displayName: string;
        amount: string;
        sourceAmount: string;
        sourceReference: string;
        reference: string;
        reason: string;
        creatorId: string;
        status: string;
        version: number;
        decisionReason: string | null;
      }>
    >`SELECT c.id,c.grant_id AS "grantId",u.display_name AS "displayName",c.amount::text,g.amount::text AS "sourceAmount",g.reference AS "sourceReference",c.reference,c.reason,c.creator_id AS "creatorId",c.status,c.version,c.decision_reason AS "decisionReason" FROM points_corrections c JOIN points_grants g ON g.id=c.grant_id JOIN consumer_users u ON u.id=c.user_id WHERE c.warehouse_id=${warehouse}::uuid AND (${userId}::uuid IS NULL OR c.user_id=${userId}::uuid) AND (${cursor}::uuid IS NULL OR c.id>${cursor}::uuid) ORDER BY c.id LIMIT 21`;
    return {
      policy: null,
      items: rows.slice(0, 20),
      nextCursor: rows.length > 20 ? rows[19]!.id : null,
    };
  }
  async write(r: ApiRequest, k: string, action: string, id: string, b: unknown) {
    const approval = action === 'approve' || action === 'reject';
    const warehouse = await this.authorize(r, undefined, approval);
    const body = fields(
      b,
      action === 'create' ? ['grantId', 'amount', 'reason', 'reference'] : ['version', 'reason'],
    );
    const input =
      action === 'create'
        ? {
            grantId: uuid(body.grantId),
            amount: parseAmount(body.amount),
            reason: str(body.reason, 300),
            reference: str(body.reference, 120),
          }
        : { version: integer(body.version, 0, 2147483646), reason: str(body.reason, 300) };
    return this.catalog.write(r, 'POINTS_CORRECTION_' + action, id, k, input, async (tx) => {
      await this.authorize(r, tx, approval);
      // Match the grant lock protocol before locking a source, correction or account.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${warehouse + ':points-grant-policy'},0))::text`;
      const candidates =
        action === 'create'
          ? []
          : await tx.$queryRaw<
              Array<{ grant_id: string }>
            >`SELECT grant_id FROM points_corrections WHERE id=${id}::uuid AND warehouse_id=${warehouse}::uuid`;
      const grantId = action === 'create' ? input.grantId : candidates[0]?.grant_id;
      if (!grantId) throw failure(404, 'RESOURCE_NOT_FOUND', '冲正申请不存在');
      const sources = await tx.$queryRaw<
        Array<{ id: string; user_id: string; amount: bigint; status: string }>
      >`SELECT id,user_id,amount,status FROM points_grants WHERE id=${grantId}::uuid AND warehouse_id=${warehouse}::uuid FOR UPDATE`;
      const source = sources[0];
      if (!source || source.status !== 'APPROVED')
        throw failure(409, 'CORRECTION_SOURCE_INVALID', '仅可冲正本仓已入账发放');
      if (action === 'create') {
        const totals = await tx.$queryRaw<
          Array<{ used: bigint }>
        >`SELECT COALESCE(SUM(amount),0)::bigint AS used FROM points_corrections WHERE grant_id=${grantId}::uuid AND status IN ('SUBMITTED','APPROVED')`;
        if (BigInt(input.amount!) + (totals[0]?.used ?? 0n) > source.amount)
          throw failure(
            409,
            'CORRECTION_LIMIT_EXCEEDED',
            '超过原发放剩余可冲正积分，待审批申请也占用额度',
          );
        const correctionId = randomUUID();
        await tx.$executeRaw`INSERT INTO points_corrections(id,grant_id,warehouse_id,user_id,amount,reason,reference,creator_id) VALUES(${correctionId}::uuid,${grantId}::uuid,${warehouse}::uuid,${source.user_id}::uuid,${BigInt(input.amount!)},${input.reason},${input.reference!},${r.staffContext!.staffId}::uuid)`;
        await this.catalog.audit(
          tx,
          r,
          'POINTS_CORRECTION_CREATE',
          correctionId,
          warehouse,
          input.reason,
          { grantId },
        );
        return { id: correctionId };
      }
      const rows = await tx.$queryRaw<
        Array<{ status: string; creator_id: string; amount: bigint; version: number }>
      >`SELECT status,creator_id,amount,version FROM points_corrections WHERE id=${id}::uuid FOR UPDATE`;
      const correction = rows[0]!;
      if (correction.status !== 'SUBMITTED' || correction.version !== input.version)
        throw failure(409, 'VERSION_CONFLICT', '冲正申请已处理，请刷新');
      if (
        action === 'cancel'
          ? correction.creator_id !== r.staffContext!.staffId
          : correction.creator_id === r.staffContext!.staffId
      )
        throw failure(
          403,
          'INDEPENDENT_REVIEW_REQUIRED',
          '仅申请人可撤销，审批须由另一名负责人执行',
        );
      if (action === 'approve') {
        await tx.$queryRaw`SELECT user_id FROM points_accounts WHERE user_id=${source.user_id}::uuid FOR UPDATE`;
        const changed =
          await tx.$executeRaw`UPDATE points_accounts SET balance=balance-${correction.amount},version=version+1 WHERE user_id=${source.user_id}::uuid AND balance>=${correction.amount}`;
        if (changed !== 1)
          throw failure(
            409,
            'POINTS_INSUFFICIENT',
            '账户余额不足，申请仍待审批；请核查后重试、驳回或撤销',
          );
        await tx.$executeRaw`INSERT INTO points_ledger(id,user_id,delta,action_key,reason,actor_id) VALUES(${randomUUID()}::uuid,${source.user_id}::uuid,${-correction.amount},${'CORRECTION:' + id},${input.reason},${r.staffContext!.staffId}::uuid)`;
      }
      const status =
        action === 'approve' ? 'APPROVED' : action === 'reject' ? 'REJECTED' : 'CANCELED';
      await tx.$executeRaw`UPDATE points_corrections SET status=${status},reviewer_id=${r.staffContext!.staffId}::uuid,decision_reason=${input.reason},decided_at=CURRENT_TIMESTAMP,version=version+1 WHERE id=${id}::uuid`;
      await this.catalog.audit(
        tx,
        r,
        'POINTS_CORRECTION_' + action.toUpperCase(),
        id,
        warehouse,
        input.reason,
        { grantId },
      );
      return { id };
    });
  }
}
const sourceSchema = object({
  id: text,
  displayName: text,
  amount: text,
  remainingAmount: text,
  reference: text,
  reason: text,
});
const correctionSchema = object({
  id: text,
  grantId: text,
  displayName: text,
  amount: text,
  sourceAmount: text,
  sourceReference: text,
  reference: text,
  reason: text,
  creatorId: text,
  status: text,
  version: { type: 'integer' },
  decisionReason: { type: 'string', nullable: true },
});
@ApiTags('积分误发冲正')
@ApiCookieAuth('staffSession')
@Permissions('points.write')
@Controller('admin/points/corrections')
export class PointsCorrectionController {
  constructor(@Inject(PointsCorrectionService) readonly service: PointsCorrectionService) {}
  @Get()
  @ApiQuery({ name: 'userId', required: false, type: String, description: '仅查看指定顾客的申请' })
  @ApiResult(
    object({
      policy: { type: 'object', nullable: true },
      items: { type: 'array', items: correctionSchema },
      nextCursor: { type: 'string', nullable: true },
    }),
  )
  async list(@Req() r: ApiRequest, @Query() q: unknown) {
    return success(r, await this.service.read(r, q));
  }
  @Get('sources')
  @ApiQuery({
    name: 'userId',
    required: false,
    type: String,
    description: '仅选择指定顾客的原发放记录',
  })
  @ApiResult(
    object({
      items: { type: 'array', items: sourceSchema },
      nextCursor: { type: 'string', nullable: true },
    }),
  )
  async sources(@Req() r: ApiRequest, @Query() q: unknown) {
    return success(r, await this.service.sources(r, q));
  }
  @Post(':id/:action')
  @HttpCode(200)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({
    schema: {
      oneOf: [
        object({ grantId: text, amount: text, reason: text, reference: text }),
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
    if (!['create', 'approve', 'reject', 'cancel'].includes(action))
      throw failure(404, 'RESOURCE_NOT_FOUND', '操作不存在');
    const resource = action === 'create' ? 'store' : uuid(id);
    if (action === 'create' && id !== 'store')
      throw failure(400, 'VALIDATION_ERROR', '创建冲正使用store资源');
    return success(r, await this.service.write(r, key(r), action, resource, b));
  }
}
