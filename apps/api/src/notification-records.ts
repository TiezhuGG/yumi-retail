import { createHash, randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiHeader, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { mergePaymentEvidence, settleQueryLabFromNotification } from '@yumi/database';
import type { Prisma } from '@yumi/database';
import { CatalogService } from './catalog-service.js';
import { fields, uuid } from './catalog-input.js';
import { Permissions } from './staff-guard.js';
import { failure, success } from './http.js';
import type { ApiRequest } from './http.js';
import { object, ApiResult, text } from './api-result.js';
import { syntheticNotification } from './notification-fixtures.js';
import { verifyPaymentNotification, NotificationVerificationError } from './wechat-notification.js';
const projection = (
  row: Prisma.NotificationLabRecordGetPayload<Record<string, never>> & {
    application?: { attemptId: string; attemptEventId: string } | null;
  },
) => ({
  id: row.id,
  notificationId: row.notificationId,
  outTradeNo: row.outTradeNo,
  transactionId: row.transactionId,
  amountCents: Number(row.amountCents),
  currency: row.currency,
  successTime: row.successTime,
  createdAt: row.createdAt.toISOString(),
  syntheticOnly: true as const,
  state: row.applicationId ? ('LINKED_SYNTHETIC' as const) : ('RECORDED_ONLY' as const),
  application: row.application
    ? { attemptId: row.application.attemptId, eventId: row.application.attemptEventId }
    : null,
});
export class NotificationRecordsService {
  constructor(
    readonly catalog: CatalogService,
    readonly enabled = false,
  ) {}
  async list(r: ApiRequest, warehouseId: string, cursor?: string) {
    return this.catalog.db.$transaction(async (tx) => {
      await this.catalog.warehouse(tx, r, warehouseId);
      const anchor = cursor
        ? await tx.notificationLabRecord.findFirst({ where: { id: cursor, warehouseId } })
        : null;
      if (cursor && !anchor) throw failure(404, 'RESOURCE_NOT_FOUND', '记录游标不存在');
      const rows = await tx.notificationLabRecord.findMany({
        include: { application: true },
        where: {
          warehouseId,
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
        items: rows.slice(0, 20).map(projection),
        nextCursor: rows.length > 20 ? rows[19]!.id : null,
      };
    });
  }
  async detail(r: ApiRequest, warehouseId: string, id: string) {
    return this.catalog.db.$transaction(async (tx) => {
      await this.catalog.warehouse(tx, r, warehouseId);
      const row = await tx.notificationLabRecord.findFirst({
        where: { id, warehouseId },
        include: { application: true },
      });
      if (!row) throw failure(404, 'RESOURCE_NOT_FOUND', '隔离记录不存在');
      return projection(row);
    });
  }
  private async binding(r: ApiRequest, w: string, id: string) {
    await this.catalog.warehouse(this.catalog.db, r, w);
    const b = await this.catalog.db.paymentNotificationLabBinding.findFirst({
      where: { attemptId: id, warehouseId: w },
    });
    if (!b)
      throw failure(
        404,
        'NOTIFICATION_BINDING_NOT_FOUND',
        '该合成尝试没有通知绑定，请选择新建尝试',
      );
    return b;
  }
  async options(r: ApiRequest, w: string, cursor?: string) {
    return this.catalog.db.$transaction(async (tx) => {
      await this.catalog.warehouse(tx, r, w);
      const anchor = cursor
        ? await tx.paymentNotificationLabBinding.findFirst({
            where: { attemptId: cursor, warehouseId: w },
          })
        : null;
      if (cursor && !anchor) throw failure(404, 'RESOURCE_NOT_FOUND', '绑定游标不存在');
      const rows = await tx.paymentNotificationLabBinding.findMany({
        where: {
          warehouseId: w,
          ...(anchor
            ? {
                OR: [
                  { createdAt: { lt: anchor.createdAt } },
                  { createdAt: anchor.createdAt, attemptId: { lt: anchor.attemptId } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { attemptId: 'desc' }],
        take: 21,
      });
      return {
        items: rows.slice(0, 20).map((b) => ({
          id: b.attemptId,
          label: '合成尝试 · ' + b.attemptId.slice(-8),
          amountCents: Number(b.amountCents),
        })),
        nextCursor: rows.length > 20 ? rows[19]!.attemptId : null,
      };
    });
  }
  // Only the synthetic producer below calls this; no HTTP accepts raw notifications or keys.
  async receive(
    r: ApiRequest,
    warehouseId: string,
    input: Parameters<typeof verifyPaymentNotification>[0],
    attemptId?: string,
  ) {
    if (!this.enabled)
      throw failure(503, 'NOTIFICATION_LAB_DISABLED', '通知隔离验证尚未在本机显式开启');
    const binding = attemptId ? await this.binding(r, warehouseId, attemptId) : null;
    let facts: ReturnType<typeof verifyPaymentNotification>;
    try {
      facts = verifyPaymentNotification(
        binding
          ? {
              ...input,
              expected: {
                appid: binding.appId,
                mchid: binding.merchantId,
                outTradeNo: binding.outTradeNo,
                total: Number(binding.amountCents),
              },
            }
          : input,
      );
    } catch (e) {
      if (e instanceof NotificationVerificationError)
        throw failure(400, 'NOTIFICATION_REJECTED', '合成通知验证未通过');
      throw e;
    }
    if (
      ![facts.notificationId, facts.outTradeNo, facts.transactionId].every((v) =>
        v.startsWith('SYNTHETIC_'),
      )
    )
      throw failure(400, 'SYNTHETIC_ONLY', '仅允许合成通知');
    // Semantic facts, never ciphertext: independently signed/encrypted retries must deduplicate.
    const factsHash = createHash('sha256').update(JSON.stringify(facts)).digest('hex');
    return this.catalog.db.$transaction(async (tx) => {
      await this.catalog.warehouse(tx, r, warehouseId);
      if (binding)
        await tx.$queryRaw`SELECT id FROM payment_attempt_labs WHERE id=${binding.attemptId}::uuid AND warehouse_id=${warehouseId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${warehouseId + ':notification-lab:' + facts.notificationId},0))::text`;
      const previous = await tx.notificationLabRecord.findUnique({
        include: { application: true },
        where: {
          warehouseId_notificationId: { warehouseId, notificationId: facts.notificationId },
        },
      });
      if (previous) {
        if (
          previous.factsHash !== factsHash ||
          (previous.application?.attemptId ?? null) !== (attemptId ?? null)
        )
          throw failure(409, 'NOTIFICATION_CONFLICT', '同一通知的已验证事实发生冲突');
        return { record: projection(previous), duplicate: true, applied: false };
      }
      let applicationId: string | null = null,
        applied = false;
      if (binding) {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${warehouseId + ':notification-transaction:' + facts.transactionId},0))::text`;
        let app = await tx.paymentNotificationLabApplication.findUnique({
          where: { attemptId: binding.attemptId },
        });
        const transaction = await tx.paymentNotificationLabApplication.findUnique({
          where: { warehouseId_transactionId: { warehouseId, transactionId: facts.transactionId } },
        });
        if (
          (transaction && transaction.attemptId !== binding.attemptId) ||
          (app &&
            (app.transactionId !== facts.transactionId || app.successTime !== facts.successTime))
        )
          throw failure(
            409,
            'NOTIFICATION_TRANSACTION_CONFLICT',
            '渠道交易与合成尝试的绑定事实冲突',
          );
        if (!app) {
          const attempt = await tx.paymentAttemptLab.findUniqueOrThrow({
            where: { id: binding.attemptId },
          });
          if (attempt.version >= 100)
            throw failure(409, 'LAB_EVENT_LIMIT', '该尝试证据已达上限，请新建合成尝试');
          const id = randomUUID(),
            eventId = randomUUID(),
            evidence = mergePaymentEvidence(attempt.evidence, 'SUCCEEDED'),
            version = attempt.version + 1;
          const updated = await tx.paymentAttemptLab.update({
            where: { id: attempt.id },
            data: { evidence, version },
          });
          await tx.paymentAttemptLabEvent.create({
            data: {
              id: eventId,
              attemptId: attempt.id,
              key: id,
              action: 'SUCCESS_RESULT',
              observation: 'SUCCEEDED',
              evidence,
              version,
            },
          });
          app = await tx.paymentNotificationLabApplication.create({
            data: {
              id,
              attemptId: attempt.id,
              warehouseId,
              transactionId: facts.transactionId,
              successTime: facts.successTime,
              attemptEventId: eventId,
            },
          });
          await settleQueryLabFromNotification(tx, updated, eventId);
          applied = true;
        }
        applicationId = app.id;
      }
      const row = await tx.notificationLabRecord.create({
        include: { application: true },
        data: {
          id: randomUUID(),
          warehouseId,
          applicationId,
          notificationId: facts.notificationId,
          outTradeNo: facts.outTradeNo,
          transactionId: facts.transactionId,
          amountCents: BigInt(facts.total),
          currency: facts.currency,
          successTime: facts.successTime,
          factsHash,
        },
      });
      await this.catalog.audit(tx, r, 'NOTIFICATION_LAB_RECORDED', row.id, warehouseId, null, {
        syntheticOnly: true,
        applicationId,
        attemptId: attemptId ?? null,
        applied,
      });
      return { record: projection(row), duplicate: false, applied };
    });
  }
  async simulate(r: ApiRequest, warehouseId: string, key: string, attemptId?: string) {
    await this.catalog.warehouse(this.catalog.db, r, warehouseId);
    if (!this.enabled)
      throw failure(503, 'NOTIFICATION_LAB_DISABLED', '通知隔离验证尚未在本机显式开启');
    const binding = attemptId ? await this.binding(r, warehouseId, attemptId) : null;
    const f = syntheticNotification();
    f.expected.outTradeNo = 'SYNTHETIC_' + key.replaceAll('-', '').slice(0, 22);
    if (binding)
      Object.assign(f.expected, {
        appid: binding.appId,
        mchid: binding.merchantId,
        outTradeNo: binding.outTradeNo,
        total: Number(binding.amountCents),
      });
    const envelope = f.envelope({
      success_time: '2026-01-01T00:00:00.000Z',
      transaction_id: binding ? 'SYNTHETIC_TX_' + binding.attemptId : 'SYNTHETIC_' + key,
    });
    envelope.id = 'SYNTHETIC_' + key;
    return this.receive(r, warehouseId, f.signed(envelope), attemptId);
  }
  async replay(r: ApiRequest, warehouseId: string, id: string) {
    const row = await this.detail(r, warehouseId, id);
    return this.simulate(
      r,
      warehouseId,
      uuid(row.notificationId.slice('SYNTHETIC_'.length)),
      row.application?.attemptId,
    );
  }
}
const recordSchema = object({
  id: text,
  notificationId: text,
  outTradeNo: text,
  transactionId: text,
  amountCents: { type: 'integer' },
  currency: text,
  successTime: text,
  createdAt: text,
  syntheticOnly: { type: 'boolean', enum: [true] },
  state: { type: 'string', enum: ['RECORDED_ONLY', 'LINKED_SYNTHETIC'] },
  application: { ...object({ attemptId: text, eventId: text }), nullable: true },
});
@ApiTags('合成通知持久化记录')
@ApiCookieAuth('staffSession')
@Permissions('payment-readiness.read')
@Controller('admin/payment-notification-records')
export class NotificationRecordsController {
  constructor(
    @Inject(NotificationRecordsService) private readonly service: NotificationRecordsService,
  ) {}
  @Get()
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiResult(
    object({
      enabled: { type: 'boolean' },
      syntheticOnly: { type: 'boolean', enum: [true] },
      callbackEnabled: { type: 'boolean', enum: [false] },
      items: { type: 'array', items: recordSchema },
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
  @Get('attempts')
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiResult(
    object({
      items: {
        type: 'array',
        items: object({ id: text, label: text, amountCents: { type: 'integer' } }),
      },
      nextCursor: { ...text, nullable: true },
    }),
    [400, 401, 403, 404, 500],
  )
  async options(@Req() r: ApiRequest, @Query() q: unknown) {
    const b = fields(q, ['warehouseId', 'cursor']);
    return success(
      r,
      await this.service.options(
        r,
        uuid(b.warehouseId),
        b.cursor === undefined ? undefined : uuid(b.cursor),
      ),
    );
  }
  @Get(':id')
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiParam({ name: 'id', type: String })
  @ApiResult(recordSchema, [400, 401, 403, 404, 500])
  async detail(@Req() r: ApiRequest, @Query() q: unknown, @Param('id') id: string) {
    const b = fields(q, ['warehouseId']);
    return success(r, await this.service.detail(r, uuid(b.warehouseId), uuid(id)));
  }
  @Post()
  @HttpCode(200)
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({
    schema: {
      ...object({
        key: { type: 'string', format: 'uuid' },
        attemptId: { type: 'string', format: 'uuid' },
      }),
      required: ['key'],
    },
  })
  @ApiResult(
    object({ record: recordSchema, duplicate: { type: 'boolean' }, applied: { type: 'boolean' } }),
    [400, 401, 403, 404, 409, 503, 500],
  )
  async create(@Req() r: ApiRequest, @Query() q: unknown, @Body() body: unknown) {
    const b = fields(q, ['warehouseId']),
      v = fields(body, ['key', 'attemptId']);
    return success(
      r,
      await this.service.simulate(
        r,
        uuid(b.warehouseId),
        uuid(v.key),
        v.attemptId === undefined ? undefined : uuid(v.attemptId),
      ),
    );
  }
  @Post(':id/replay')
  @HttpCode(200)
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiParam({ name: 'id', type: String })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({ schema: object({}) })
  @ApiResult(
    object({ record: recordSchema, duplicate: { type: 'boolean' }, applied: { type: 'boolean' } }),
    [400, 401, 403, 404, 409, 503, 500],
  )
  async replay(
    @Req() r: ApiRequest,
    @Query() q: unknown,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = fields(q, ['warehouseId']);
    fields(body, []);
    return success(r, await this.service.replay(r, uuid(b.warehouseId), uuid(id)));
  }
}
