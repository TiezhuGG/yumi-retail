import { createHash, randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiHeader, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@yumi/database';
import { CatalogService } from './catalog-service.js';
import { fields, uuid } from './catalog-input.js';
import { Permissions } from './staff-guard.js';
import { failure, success } from './http.js';
import type { ApiRequest } from './http.js';
import { object, ApiResult, text } from './api-result.js';
import { syntheticNotification } from './notification-fixtures.js';
import { verifyPaymentNotification, NotificationVerificationError } from './wechat-notification.js';
const projection = (row: Prisma.NotificationLabRecordGetPayload<Record<string, never>>) => ({
  id: row.id,
  notificationId: row.notificationId,
  outTradeNo: row.outTradeNo,
  transactionId: row.transactionId,
  amountCents: Number(row.amountCents),
  currency: row.currency,
  successTime: row.successTime,
  createdAt: row.createdAt.toISOString(),
  syntheticOnly: true as const,
  state: 'RECORDED_ONLY' as const,
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
      const row = await tx.notificationLabRecord.findFirst({ where: { id, warehouseId } });
      if (!row) throw failure(404, 'RESOURCE_NOT_FOUND', '隔离记录不存在');
      return projection(row);
    });
  }
  // Only the synthetic producer below calls this; no HTTP accepts raw notifications or keys.
  async receive(
    r: ApiRequest,
    warehouseId: string,
    input: Parameters<typeof verifyPaymentNotification>[0],
  ) {
    if (!this.enabled)
      throw failure(503, 'NOTIFICATION_LAB_DISABLED', '通知隔离验证尚未在本机显式开启');
    let facts: ReturnType<typeof verifyPaymentNotification>;
    try {
      facts = verifyPaymentNotification(input);
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
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${warehouseId + ':notification-lab:' + facts.notificationId},0))::text`;
      const previous = await tx.notificationLabRecord.findUnique({
        where: {
          warehouseId_notificationId: { warehouseId, notificationId: facts.notificationId },
        },
      });
      if (previous) {
        if (previous.factsHash !== factsHash)
          throw failure(409, 'NOTIFICATION_CONFLICT', '同一通知的已验证事实发生冲突');
        return { record: projection(previous), duplicate: true };
      }
      const row = await tx.notificationLabRecord.create({
        data: {
          id: randomUUID(),
          warehouseId,
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
      });
      return { record: projection(row), duplicate: false };
    });
  }
  async simulate(r: ApiRequest, warehouseId: string, key: string) {
    await this.catalog.warehouse(this.catalog.db, r, warehouseId);
    if (!this.enabled)
      throw failure(503, 'NOTIFICATION_LAB_DISABLED', '通知隔离验证尚未在本机显式开启');
    const f = syntheticNotification();
    f.expected.outTradeNo = 'SYNTHETIC_' + key.replaceAll('-', '').slice(0, 22);
    const envelope = f.envelope({
      success_time: '2026-01-01T00:00:00.000Z',
      transaction_id: 'SYNTHETIC_' + key,
    });
    envelope.id = 'SYNTHETIC_' + key;
    return this.receive(r, warehouseId, f.signed(envelope));
  }
  async replay(r: ApiRequest, warehouseId: string, id: string) {
    const row = await this.detail(r, warehouseId, id);
    return this.simulate(r, warehouseId, uuid(row.notificationId.slice('SYNTHETIC_'.length)));
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
  state: { type: 'string', enum: ['RECORDED_ONLY'] },
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
  @ApiBody({ schema: object({ key: { type: 'string', format: 'uuid' } }) })
  @ApiResult(
    object({ record: recordSchema, duplicate: { type: 'boolean' } }),
    [400, 401, 403, 409, 503, 500],
  )
  async create(@Req() r: ApiRequest, @Query() q: unknown, @Body() body: unknown) {
    const b = fields(q, ['warehouseId']),
      v = fields(body, ['key']);
    return success(r, await this.service.simulate(r, uuid(b.warehouseId), uuid(v.key)));
  }
  @Post(':id/replay')
  @HttpCode(200)
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiParam({ name: 'id', type: String })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({ schema: object({}) })
  @ApiResult(
    object({ record: recordSchema, duplicate: { type: 'boolean' } }),
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
