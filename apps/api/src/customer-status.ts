import { createHash, randomUUID } from 'node:crypto';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@yumi/database';
import type { CustomerStatusHistory } from '@yumi/contracts';
import { CatalogService } from './catalog-service.js';
import { PointsGrantService } from './points-grants.js';
import { fields, integer, key, str, uuid } from './catalog-input.js';
import { failure, success, type ApiRequest } from './http.js';
import { Permissions } from './staff-guard.js';
import { ApiResult, object, text } from './api-result.js';
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export class CustomerStatusService {
  readonly auth: PointsGrantService;
  constructor(readonly catalog: CatalogService) {
    this.auth = new PointsGrantService(catalog);
  }
  async change(
    r: ApiRequest,
    id: string,
    action: 'disable' | 'enable',
    requestKey: string,
    body: unknown,
  ) {
    const b = fields(body, ['version', 'reason', 'confirmed']);
    if (b.confirmed !== true) throw failure(400, 'CONFIRMATION_REQUIRED', '须确认账号操作及其影响');
    const input = {
      version: integer(b.version, 0, 2147483646),
      reason: str(b.reason, 200),
      confirmed: true,
    };
    const scope = r.staffContext!.staffId + ':CUSTOMER_' + action + ':' + id,
      keyHash = digest(requestKey),
      requestHash = digest(JSON.stringify(input));
    try {
      return await this.catalog.db.$transaction(
        async (tx) => {
          // Authorization also runs on replays: a saved result must not bypass revoked roles.
          const warehouseId = await this.auth.authorize(r, tx, true);
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${scope + ':' + keyHash},0))::text`;
          const previous = await tx.idempotencyRecord.findUnique({
            where: { scope_keyHash: { scope, keyHash } },
          });
          if (previous) {
            if (previous.requestHash !== requestHash)
              throw failure(409, 'IDEMPOTENCY_CONFLICT', '原账号操作内容已改变，请使用原请求核实');
            await this.auth.authorize(r, tx, true);
            return previous.result;
          }
          const rows = await tx.$queryRaw<
            Array<{ enabled: boolean; auth_version: number }>
          >`SELECT enabled,auth_version FROM consumer_users WHERE id=${id}::uuid FOR UPDATE`;
          const user = rows[0];
          if (!user) throw failure(404, 'CUSTOMER_NOT_FOUND', '顾客不存在');
          if (user.auth_version !== input.version)
            throw failure(409, 'VERSION_CONFLICT', '账号状态已变化，请刷新资料后重新确认');
          const enabled = action === 'enable';
          if (user.enabled === enabled)
            throw failure(409, 'INVALID_TRANSITION', enabled ? '账号已经恢复' : '账号已经停用');
          // Lock only the identity, never session rows after it. This serializes with login,
          // checkout and profile edits without reversing profile's session -> identity locks.
          // Generation advancement permanently invalidates old sessions, including after restore.
          const updated = await tx.consumerUser.update({
            where: { id },
            data: { enabled, authVersion: { increment: 1 } },
          });
          const actor = await tx.staff.findUniqueOrThrow({
            where: { id: r.staffContext!.staffId },
            select: { displayName: true },
          });
          const now = (
            await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`
          )[0]!.now;
          await tx.businessAudit.create({
            data: {
              id: randomUUID(),
              actorId: r.staffContext!.staffId,
              action: enabled ? 'CUSTOMER_ENABLED' : 'CUSTOMER_DISABLED',
              resourceId: id,
              warehouseId,
              reason: input.reason,
              requestId: r.requestId,
              createdAt: now,
              details: {
                fromEnabled: user.enabled,
                toEnabled: enabled,
                fromVersion: user.auth_version,
                toVersion: updated.authVersion,
                actorName: actor.displayName,
              },
            },
          });
          await this.auth.authorize(r, tx, true);
          const result = { id, enabled, stateVersion: updated.authVersion };
          await tx.idempotencyRecord.create({ data: { scope, keyHash, requestHash, result } });
          return result;
        },
        { timeout: 15000, maxWait: 10000 },
      );
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && ['P2034', 'P2002'].includes(e.code))
        throw failure(503, 'RETRYABLE_CONFLICT', '并发变化，请使用原账号操作请求重试');
      throw e;
    }
  }
  async history(r: ApiRequest, id: string, query: unknown): Promise<CustomerStatusHistory> {
    const q = fields(query, ['cursor']),
      cursor = q.cursor === undefined ? null : uuid(q.cursor);
    return this.catalog.db.$transaction(
      async (tx) => {
        await this.auth.authorize(r, tx);
        if (!(await tx.consumerUser.findUnique({ where: { id }, select: { id: true } })))
          throw failure(404, 'CUSTOMER_NOT_FOUND', '顾客不存在');
        const actions = ['CUSTOMER_DISABLED', 'CUSTOMER_ENABLED'];
        const anchor = cursor
          ? await tx.businessAudit.findFirst({
              where: { id: cursor, resourceId: id, action: { in: actions } },
            })
          : null;
        if (cursor && !anchor)
          throw failure(409, 'CURSOR_INVALID', '账号操作记录分页位置无效，请刷新');
        const rows = await tx.$queryRaw<
          Array<Omit<CustomerStatusHistory['items'][number], 'createdAt'> & { createdAt: Date }>
        >`SELECT a.id,a.action,COALESCE(a.details->>'actorName',s.display_name) AS "actorName",a.reason,(a.details->>'fromEnabled')::boolean AS "fromEnabled",(a.details->>'toEnabled')::boolean AS "toEnabled",a.created_at AS "createdAt" FROM business_audits a JOIN staff s ON s.id=a.actor_id WHERE a.resource_id=${id}::uuid AND a.action IN ('CUSTOMER_DISABLED','CUSTOMER_ENABLED') AND (${anchor?.id ?? null}::uuid IS NULL OR (a.created_at,a.id)<(${anchor?.createdAt ?? null}::timestamptz,${anchor?.id ?? null}::uuid)) ORDER BY a.created_at DESC,a.id DESC LIMIT 21`;
        await this.auth.authorize(r, tx);
        return {
          items: rows.slice(0, 20).map((x) => ({ ...x, createdAt: x.createdAt.toISOString() })),
          nextCursor: rows.length > 20 ? rows[19]!.id : null,
        };
      },
      { isolationLevel: 'RepeatableRead', timeout: 15000 },
    );
  }
}
const integerSchema = { type: 'integer' as const, minimum: 0 };
@ApiTags('顾客账号状态')
@ApiCookieAuth('staffSession')
@Controller('admin/customers')
export class CustomerStatusController {
  constructor(@Inject(CustomerStatusService) readonly service: CustomerStatusService) {}
  @Get(':id/status-history')
  @Header('Cache-Control', 'no-store')
  @Permissions('points.read')
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiResult(
    object({
      items: {
        type: 'array',
        maxItems: 20,
        items: object({
          id: text,
          action: { type: 'string', enum: ['CUSTOMER_DISABLED', 'CUSTOMER_ENABLED'] },
          actorName: text,
          reason: text,
          fromEnabled: { type: 'boolean' },
          toEnabled: { type: 'boolean' },
          createdAt: text,
        }),
      },
      nextCursor: { ...text, nullable: true },
    }),
    [400, 401, 403, 404, 409, 500, 503],
  )
  async history(@Req() r: ApiRequest, @Param('id') id: string, @Query() q: unknown) {
    return success(r, await this.service.history(r, uuid(id), q));
  }
  @Post(':id/status/:action')
  @HttpCode(200)
  @Permissions('points.write')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({
    schema: object({
      version: integerSchema,
      reason: { ...text, maxLength: 200 },
      confirmed: { type: 'boolean', enum: [true] },
    }),
  })
  @ApiResult(
    object({ id: text, enabled: { type: 'boolean' }, stateVersion: integerSchema }),
    [400, 401, 403, 404, 409, 500, 503],
  )
  async change(
    @Req() r: ApiRequest,
    @Param('id') id: string,
    @Param('action') action: string,
    @Query() q: unknown,
    @Body() b: unknown,
  ) {
    fields(q, []);
    if (action !== 'disable' && action !== 'enable')
      throw failure(404, 'RESOURCE_NOT_FOUND', '账号操作不存在');
    return success(r, await this.service.change(r, uuid(id), action, key(r), b));
  }
}
