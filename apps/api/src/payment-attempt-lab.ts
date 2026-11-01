import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiHeader, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  paymentAdapterCases,
  mergePaymentEvidence,
  paymentCloseDecision,
  schedulePaymentQueryLab,
  retryPaymentQueryLab,
  runPaymentQueryLabOnce,
} from '@yumi/database';
import type { Prisma } from '@yumi/database';
import type { PaymentAttemptLabSummary } from '@yumi/contracts';
import { CatalogService } from './catalog-service.js';
import { fields, uuid } from './catalog-input.js';
import { Permissions } from './staff-guard.js';
import { failure, success } from './http.js';
import type { ApiRequest } from './http.js';
import { object, ApiResult, text } from './api-result.js';
type Tx = Prisma.TransactionClient;
type Row = Prisma.PaymentAttemptLabGetPayload<Record<string, never>>;
const actions = {
  'unknown-result': { action: 'UNKNOWN_RESULT', observation: 'UNKNOWN' },
  'closed-result': { action: 'CLOSED_RESULT', observation: 'CLOSED' },
  'success-result': { action: 'SUCCESS_RESULT', observation: 'SUCCEEDED' },
} as const;
export type AttemptAction = keyof typeof actions;
const summary = (r: Row): PaymentAttemptLabSummary => ({
  id: r.id,
  evidence: r.evidence as PaymentAttemptLabSummary['evidence'],
  version: r.version,
  createdAt: r.createdAt.toISOString(),
  syntheticOnly: true as const,
  plan: paymentCloseDecision({ status: 'AWAITING_PAYMENT', paymentState: 'PENDING' }, r.evidence)
    .action,
  releaseAllowed: false as const,
});
export class PaymentAttemptLabService {
  constructor(
    readonly catalog: CatalogService,
    readonly enabled = false,
  ) {}
  private writable() {
    if (!this.enabled)
      throw failure(503, 'PAYMENT_ATTEMPT_LAB_DISABLED', '合成支付尝试尚未在本机显式开启');
  }
  private async find(tx: Tx, r: ApiRequest, w: string, id: string, lock = false) {
    await this.catalog.warehouse(tx, r, w);
    if (lock)
      await tx.$queryRaw`SELECT id FROM payment_attempt_labs WHERE id=${id}::uuid AND warehouse_id=${w}::uuid FOR UPDATE`;
    const row = await tx.paymentAttemptLab.findFirst({ where: { id, warehouseId: w } });
    if (!row) throw failure(404, 'RESOURCE_NOT_FOUND', '合成支付尝试不存在');
    return row;
  }
  private async view(tx: Tx, row: Row) {
    return {
      ...summary(row),
      queryJob: await this.queryView(tx, row.id),
      events: (
        await tx.paymentAttemptLabEvent.findMany({
          where: { attemptId: row.id },
          orderBy: { version: 'asc' },
        })
      ).map((e) => ({
        id: e.id,
        action: e.action,
        observation: e.observation,
        evidence: e.evidence,
        version: e.version,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }
  private async queryView(tx: Tx, id: string) {
    await tx.$queryRaw`SELECT id FROM payment_query_lab_jobs WHERE attempt_id=${id}::uuid FOR SHARE`;
    const job = await tx.paymentQueryLabJob.findUnique({
      where: { attemptId: id },
      include: { events: { orderBy: { version: 'asc' } } },
    });
    if (!job) return null;
    return {
      state: job.state,
      attempts: job.attempts,
      nextRunAt: job.nextRunAt.toISOString(),
      leaseUntil: job.leaseUntil?.toISOString() ?? null,
      events: job.events.map((e) => ({
        id: e.id,
        reason: e.reason,
        classification: e.classification,
        resultEvidence: e.resultEvidence,
        next: e.next,
        scenario: e.scenario,
        state: e.state,
        attempts: e.attempts,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }
  async retryQuery(r: ApiRequest, w: string, id: string, key: string) {
    this.writable();
    return this.catalog.db.$transaction(async (tx) => {
      const attempt = await this.find(tx, r, w, id, true);
      try {
        const changed = await retryPaymentQueryLab(tx, attempt, key);
        if (changed)
          await this.catalog.audit(tx, r, 'PAYMENT_QUERY_LAB_RETRY', id, w, null, {
            syntheticOnly: true,
          });
      } catch (e) {
        if (
          e instanceof Error &&
          ['QUERY_RETRY_NOT_ALLOWED', 'QUERY_KEY_CONFLICT'].includes(e.message)
        )
          throw failure(
            409,
            e.message,
            '只有未知且已耗尽的任务可重新安排查询，待人工核查任务不能自动恢复',
          );
        throw e;
      }
      return this.view(tx, attempt);
    });
  }
  async runQuery(r: ApiRequest, w: string, scenario = 'NOTPAY') {
    this.writable();
    await this.catalog.warehouse(this.catalog.db, r, w);
    return {
      ...(await runPaymentQueryLabOnce(this.catalog.db, w, scenario)),
      syntheticOnly: true as const,
    };
  }
  async list(r: ApiRequest, w: string, cursor?: string) {
    return this.catalog.db.$transaction(async (tx) => {
      await this.catalog.warehouse(tx, r, w);
      const anchor = cursor
        ? await tx.paymentAttemptLab.findFirst({ where: { id: cursor, warehouseId: w } })
        : null;
      if (cursor && !anchor) throw failure(404, 'RESOURCE_NOT_FOUND', '记录游标不存在');
      const rows = await tx.paymentAttemptLab.findMany({
        where: {
          warehouseId: w,
          ...(anchor
            ? {
                OR: [
                  { createdAt: { lt: anchor.createdAt } },
                  { createdAt: anchor.createdAt, id: { lt: anchor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 21,
      });
      return {
        enabled: this.enabled,
        syntheticOnly: true as const,
        callbackEnabled: false as const,
        queryScenarios: paymentAdapterCases.map(({ code, title }) => ({ code, title })),
        items: rows.slice(0, 20).map(summary),
        nextCursor: rows.length > 20 ? rows[19]!.id : null,
      };
    });
  }
  async detail(r: ApiRequest, w: string, id: string) {
    return this.catalog.db.$transaction(async (tx) =>
      this.view(tx, await this.find(tx, r, w, id, true)),
    );
  }
  async create(r: ApiRequest, w: string, key: string) {
    this.writable();
    return this.catalog.db.$transaction(async (tx) => {
      await this.catalog.warehouse(tx, r, w);
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${w + ':attempt-lab:' + key},0))::text`;
      const old = await tx.paymentAttemptLab.findUnique({
        where: { warehouseId_key: { warehouseId: w, key } },
      });
      if (old)
        return {
          attempt: await this.view(tx, await this.find(tx, r, w, old.id, true)),
          duplicate: true,
        };
      const row = await tx.paymentAttemptLab.create({
        data: { id: randomUUID(), warehouseId: w, key },
      });
      await tx.paymentAttemptLabEvent.create({
        data: {
          id: randomUUID(),
          attemptId: row.id,
          key,
          action: 'STARTED',
          observation: 'NONE',
          evidence: 'NONE',
          version: 0,
        },
      });
      await this.catalog.audit(tx, r, 'PAYMENT_ATTEMPT_LAB_STARTED', row.id, w, null, {
        syntheticOnly: true,
      });
      return { attempt: await this.view(tx, row), duplicate: false };
    });
  }
  async observe(r: ApiRequest, w: string, id: string, key: string, action: AttemptAction) {
    this.writable();
    const input = actions[action];
    if (!input) throw failure(400, 'INVALID_INPUT', '不支持该合成动作');
    return this.catalog.db.$transaction(async (tx) => {
      const row = await this.find(tx, r, w, id, true);
      const previous = await tx.paymentAttemptLabEvent.findUnique({
        where: { attemptId_key: { attemptId: id, key } },
      });
      if (previous) {
        if (previous.action !== input.action)
          throw failure(409, 'IDEMPOTENCY_CONFLICT', '原操作键已用于其他动作');
        return { attempt: await this.view(tx, row), duplicate: true };
      }
      if (row.version >= 100)
        throw failure(409, 'LAB_EVENT_LIMIT', '单次合成尝试最多记录100次结果，请创建新的合成尝试');
      const evidence = mergePaymentEvidence(row.evidence, input.observation),
        version = row.version + 1;
      const updated = await tx.paymentAttemptLab.update({
        where: { id },
        data: { evidence, version },
      });
      await tx.paymentAttemptLabEvent.create({
        data: { id: randomUUID(), attemptId: id, key, ...input, evidence, version },
      });
      await schedulePaymentQueryLab(tx, updated);
      await this.catalog.audit(tx, r, 'PAYMENT_ATTEMPT_LAB_RESULT', id, w, null, {
        syntheticOnly: true,
        action: input.action,
      });
      return { attempt: await this.view(tx, updated), duplicate: false };
    });
  }
}
const props = {
  id: text,
  evidence: {
    type: 'string' as const,
    enum: ['NONE', 'UNKNOWN', 'CLOSED', 'SUCCEEDED', 'CONFLICT'],
  },
  version: { type: 'integer' as const },
  createdAt: text,
  syntheticOnly: { type: 'boolean' as const, enum: [true] },
  plan: text,
  releaseAllowed: { type: 'boolean' as const, enum: [false] },
};
const querySchema = object({
  state: text,
  attempts: { type: 'integer' },
  nextRunAt: text,
  leaseUntil: { type: 'string', nullable: true },
  events: {
    type: 'array',
    items: object({
      id: text,
      reason: text,
      classification: { ...text, nullable: true },
      resultEvidence: { ...text, nullable: true },
      next: { ...text, nullable: true },
      scenario: { ...text, nullable: true },
      state: text,
      attempts: { type: 'integer' },
      createdAt: text,
    }),
  },
});
const detail = object({
  ...props,
  queryJob: { ...querySchema, nullable: true },
  events: {
    type: 'array',
    maxItems: 101,
    items: object({
      id: text,
      action: text,
      observation: text,
      evidence: text,
      version: { type: 'integer' },
      createdAt: text,
    }),
  },
});
@ApiTags('合成支付尝试与未知结果')
@ApiCookieAuth('staffSession')
@Permissions('payment-readiness.read')
@Controller('admin/payment-attempt-lab')
export class PaymentAttemptLabController {
  constructor(
    @Inject(PaymentAttemptLabService) private readonly service: PaymentAttemptLabService,
  ) {}
  @Get()
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiResult(
    object({
      enabled: { type: 'boolean' },
      syntheticOnly: { type: 'boolean', enum: [true] },
      callbackEnabled: { type: 'boolean', enum: [false] },
      queryScenarios: { type: 'array', items: object({ code: text, title: text }) },
      items: { type: 'array', items: object(props) },
      nextCursor: { type: 'string', nullable: true },
    }),
    [400, 401, 403, 404, 500],
  )
  async list(@Req() r: ApiRequest, @Query() q: unknown) {
    const b = fields(q, ['warehouseId', 'cursor']);
    return success(
      r,
      await this.service.list(
        r,
        uuid(b.warehouseId),
        b.cursor === undefined ? undefined : uuid(b.cursor),
      ),
    );
  }
  @Get(':id')
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiParam({ name: 'id', type: String })
  @ApiResult(detail, [400, 401, 403, 404, 500])
  async detail(@Req() r: ApiRequest, @Query() q: unknown, @Param('id') id: string) {
    const b = fields(q, ['warehouseId']);
    return success(r, await this.service.detail(r, uuid(b.warehouseId), uuid(id)));
  }
  @Post('run-query-cycle')
  @HttpCode(200)
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({
    schema: {
      ...object({ scenario: { type: 'string', enum: paymentAdapterCases.map((c) => c.code) } }),
      required: [],
    },
  })
  @ApiResult(
    object({ processed: { type: 'boolean' }, syntheticOnly: { type: 'boolean', enum: [true] } }),
    [400, 401, 403, 503, 500],
  )
  async runQuery(@Req() r: ApiRequest, @Query() q: unknown, @Body() body: unknown) {
    const b = fields(q, ['warehouseId']);
    const v = fields(body, ['scenario']);
    if (v.scenario !== undefined && !paymentAdapterCases.some((c) => c.code === v.scenario))
      throw failure(400, 'INVALID_INPUT', '请选择固定合成查询场景');
    return success(
      r,
      await this.service.runQuery(r, uuid(b.warehouseId), v.scenario as string | undefined),
    );
  }
  @Post(':id/retry-query')
  @HttpCode(200)
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiParam({ name: 'id', type: String })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({ schema: object({ key: { type: 'string', format: 'uuid' } }) })
  @ApiResult(detail, [400, 401, 403, 404, 409, 503, 500])
  async retryQuery(
    @Req() r: ApiRequest,
    @Query() q: unknown,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = fields(q, ['warehouseId']),
      v = fields(body, ['key']);
    return success(r, await this.service.retryQuery(r, uuid(b.warehouseId), uuid(id), uuid(v.key)));
  }
  @Post()
  @HttpCode(200)
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({ schema: object({ key: { type: 'string', format: 'uuid' } }) })
  @ApiResult(object({ attempt: detail, duplicate: { type: 'boolean' } }), [400, 401, 403, 503, 500])
  async create(@Req() r: ApiRequest, @Query() q: unknown, @Body() body: unknown) {
    const qv = fields(q, ['warehouseId']),
      b = fields(body, ['key']);
    return success(r, await this.service.create(r, uuid(qv.warehouseId), uuid(b.key)));
  }
  @Post(':id/actions/:action')
  @HttpCode(200)
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'action', enum: ['unknown-result', 'closed-result', 'success-result'] })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({ schema: object({ key: { type: 'string', format: 'uuid' } }) })
  @ApiResult(
    object({ attempt: detail, duplicate: { type: 'boolean' } }),
    [400, 401, 403, 404, 409, 503, 500],
  )
  async observe(
    @Req() r: ApiRequest,
    @Query() q: unknown,
    @Param('id') id: string,
    @Param('action') action: string,
    @Body() body: unknown,
  ) {
    const qv = fields(q, ['warehouseId']),
      b = fields(body, ['key']);
    if (!Object.hasOwn(actions, action)) throw failure(400, 'INVALID_INPUT', '不支持该合成动作');
    return success(
      r,
      await this.service.observe(
        r,
        uuid(qv.warehouseId),
        uuid(id),
        uuid(b.key),
        action as AttemptAction,
      ),
    );
  }
}
