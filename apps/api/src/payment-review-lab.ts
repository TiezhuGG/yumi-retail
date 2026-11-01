import {
  evidenceSources,
  evidenceReference,
  paymentEvidenceTimeline,
  type EvidenceFilter,
} from './payment-evidence-timeline.js';
import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiHeader, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import type { Prisma } from '@yumi/database';
import type { PaymentReviewCase, PaymentReviewNote } from '@yumi/contracts';
import { CatalogService } from './catalog-service.js';
import { fields, uuid, integer, str } from './catalog-input.js';
import { Permissions } from './staff-guard.js';
import { failure, success } from './http.js';
import type { ApiRequest } from './http.js';
import { object, ApiResult, text } from './api-result.js';
type Tx = Prisma.TransactionClient;
const filters = ['ALL', 'UNKNOWN', 'CONFLICT', 'EXHAUSTED', 'REVIEW'] as const;
export type ReviewFilter = (typeof filters)[number];
const attention: Prisma.PaymentAttemptLabWhereInput = {
  OR: [
    { evidence: 'UNKNOWN' },
    { evidence: 'CONFLICT' },
    { queryJob: { is: { state: { in: ['EXHAUSTED', 'REVIEW'] } } } },
  ],
};
const selected = { queryJob: true, _count: { select: { reviewNotes: true } } } as const;
type Row = Prisma.PaymentAttemptLabGetPayload<{ include: typeof selected }>;
const item = (r: Row): PaymentReviewCase => ({
  id: r.id,
  evidence: r.evidence,
  attemptVersion: r.version,
  taskState: r.queryJob?.state ?? null,
  jobVersion: r.queryJob?.version ?? null,
  createdAt: r.createdAt.toISOString(),
  noteCount: r._count.reviewNotes,
  needsReview:
    r.evidence === 'UNKNOWN' ||
    r.evidence === 'CONFLICT' ||
    ['EXHAUSTED', 'REVIEW'].includes(r.queryJob?.state ?? ''),
  syntheticOnly: true,
});
const noteView = (
  n: Prisma.PaymentReviewLabNoteGetPayload<Record<string, never>>,
): PaymentReviewNote => ({
  id: n.id,
  actorName: n.actorName,
  note: n.note,
  evidence: n.evidence,
  attemptVersion: n.attemptVersion,
  taskState: n.taskState,
  jobVersion: n.jobVersion,
  createdAt: n.createdAt.toISOString(),
});
export class PaymentReviewLabService {
  constructor(
    readonly catalog: CatalogService,
    readonly enabled = false,
  ) {}
  private async locked(tx: Tx, r: ApiRequest, w: string, id: string, write = false) {
    await this.catalog.warehouse(tx, r, w);
    if (write)
      await tx.$queryRaw`SELECT id FROM payment_attempt_labs WHERE id=${id}::uuid AND warehouse_id=${w}::uuid FOR UPDATE`;
    else
      await tx.$queryRaw`SELECT id FROM payment_attempt_labs WHERE id=${id}::uuid AND warehouse_id=${w}::uuid FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM payment_query_lab_jobs WHERE attempt_id=${id}::uuid FOR SHARE`;
    const a = await tx.paymentAttemptLab.findFirst({
      where: { id, warehouseId: w },
      include: selected,
    });
    if (!a) throw failure(404, 'RESOURCE_NOT_FOUND', '合成核查记录不存在');
    return a;
  }
  async list(r: ApiRequest, w: string, filter: ReviewFilter = 'ALL', cursor?: string) {
    return this.catalog.db.$transaction(async (tx) => {
      await this.catalog.warehouse(tx, r, w);
      const anchor = cursor
        ? await tx.paymentAttemptLab.findFirst({ where: { id: cursor, warehouseId: w } })
        : null;
      if (cursor && !anchor) throw failure(404, 'RESOURCE_NOT_FOUND', '核查游标不存在');
      const scope: Prisma.PaymentAttemptLabWhereInput =
        filter === 'ALL'
          ? attention
          : filter === 'EXHAUSTED' || filter === 'REVIEW'
            ? { queryJob: { is: { state: filter } } }
            : { evidence: filter };
      const rows = await tx.paymentAttemptLab.findMany({
        where: {
          AND: [
            { warehouseId: w },
            scope,
            ...(anchor
              ? [
                  {
                    OR: [
                      { createdAt: { lt: anchor.createdAt } },
                      { createdAt: anchor.createdAt, id: { lt: anchor.id } },
                    ],
                  },
                ]
              : []),
          ],
        },
        include: selected,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 21,
      });
      return {
        enabled: this.enabled,
        syntheticOnly: true as const,
        items: rows.slice(0, 20).map(item),
        nextCursor: rows.length > 20 ? rows[19]!.id : null,
      };
    });
  }
  async detail(r: ApiRequest, w: string, id: string, cursor?: string) {
    return this.catalog.db.$transaction(async (tx) => {
      const row = await this.locked(tx, r, w, id);
      const anchor = cursor
        ? await tx.paymentReviewLabNote.findFirst({
            where: { id: cursor, attemptId: id, warehouseId: w },
          })
        : null;
      if (cursor && !anchor) throw failure(404, 'RESOURCE_NOT_FOUND', '备注游标不存在');
      const notes = await tx.paymentReviewLabNote.findMany({
        where: {
          attemptId: id,
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
        item: item(row),
        notes: notes.slice(0, 20).map(noteView),
        nextNotesCursor: notes.length > 20 ? notes[19]!.id : null,
      };
    });
  }
  async timeline(
    r: ApiRequest,
    w: string,
    id: string,
    filter: EvidenceFilter,
    cursor?: string,
    focus?: string,
  ) {
    return this.catalog.db.$transaction(async (tx) => {
      const row = await this.locked(tx, r, w, id);
      return {
        ...(await paymentEvidenceTimeline(tx, w, id, filter, cursor, focus)),
        item: item(row),
      };
    });
  }
  async append(
    r: ApiRequest,
    w: string,
    id: string,
    input: { key: string; note: string; attemptVersion: number; jobVersion: number | null },
  ) {
    if (!this.enabled)
      throw failure(503, 'PAYMENT_REVIEW_LAB_DISABLED', '本机合成核查写入尚未开启');
    return this.catalog.db.$transaction(async (tx) => {
      const a = await this.locked(tx, r, w, id, true);
      const old = await tx.paymentReviewLabNote.findUnique({
        where: {
          attemptId_actorId_key: {
            attemptId: id,
            actorId: r.staffContext!.staffId,
            key: input.key,
          },
        },
      });
      if (old) {
        if (
          old.note !== input.note ||
          old.attemptVersion !== input.attemptVersion ||
          old.jobVersion !== input.jobVersion
        )
          throw failure(409, 'IDEMPOTENCY_CONFLICT', '原操作键的备注或快照已改变');
        return { note: noteView(old), duplicate: true };
      }
      if (a.version !== input.attemptVersion || (a.queryJob?.version ?? null) !== input.jobVersion)
        throw failure(409, 'REVIEW_SNAPSHOT_STALE', '证据或任务已变化，请刷新详情后重新核查');
      if (!item(a).needsReview)
        throw failure(409, 'REVIEW_NOT_NEEDED', '当前记录已不在待核查范围，请刷新详情');
      const note = await tx.paymentReviewLabNote.create({
        data: {
          id: randomUUID(),
          attemptId: id,
          warehouseId: w,
          actorId: r.staffContext!.staffId,
          actorName: r.staffContext!.displayName,
          key: input.key,
          note: input.note,
          evidence: a.evidence,
          attemptVersion: a.version,
          taskState: a.queryJob?.state ?? null,
          jobVersion: a.queryJob?.version ?? null,
        },
      });
      await this.catalog.audit(tx, r, 'PAYMENT_REVIEW_LAB_NOTE', id, w, null, {
        syntheticOnly: true,
        noteId: note.id,
      });
      return { note: noteView(note), duplicate: false };
    });
  }
}
const caseProps = {
  id: text,
  evidence: text,
  attemptVersion: { type: 'integer' as const },
  taskState: { type: 'string' as const, nullable: true },
  jobVersion: { type: 'integer' as const, nullable: true },
  createdAt: text,
  noteCount: { type: 'integer' as const },
  needsReview: { type: 'boolean' as const },
  syntheticOnly: { type: 'boolean' as const, enum: [true] },
};
const noteSchema = object({
  id: text,
  actorName: text,
  note: text,
  evidence: text,
  attemptVersion: { type: 'integer' },
  taskState: { type: 'string', nullable: true },
  jobVersion: { type: 'integer', nullable: true },
  createdAt: text,
});
function query(q: unknown, detail = false) {
  const b = fields(q, ['warehouseId', ...(detail ? ['notesCursor'] : ['filter', 'cursor'])]);
  let filter: ReviewFilter = 'ALL';
  if (!detail && b.filter !== undefined) {
    if (typeof b.filter !== 'string' || !filters.includes(b.filter as ReviewFilter))
      throw failure(400, 'VALIDATION_ERROR', '核查筛选无效');
    filter = b.filter as ReviewFilter;
  }
  return {
    w: uuid(b.warehouseId),
    filter,
    cursor:
      (detail ? b.notesCursor : b.cursor) === undefined
        ? undefined
        : uuid(detail ? b.notesCursor : b.cursor),
  };
}
@ApiTags('合成补偿异常核查')
@ApiCookieAuth('staffSession')
@Permissions('payment-readiness.read')
@Controller('admin/payment-review-lab')
export class PaymentReviewLabController {
  constructor(@Inject(PaymentReviewLabService) private readonly service: PaymentReviewLabService) {}
  @Get()
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiQuery({ name: 'filter', required: false, enum: filters })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiResult(
    object({
      enabled: { type: 'boolean' },
      syntheticOnly: { type: 'boolean', enum: [true] },
      items: { type: 'array', maxItems: 20, items: object(caseProps) },
      nextCursor: { type: 'string', nullable: true },
    }),
    [400, 401, 403, 404, 500],
  )
  async list(@Req() r: ApiRequest, @Query() q: unknown) {
    const b = query(q);
    return success(r, await this.service.list(r, b.w, b.filter, b.cursor));
  }
  @Get(':id')
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiQuery({ name: 'notesCursor', required: false, type: String })
  @ApiParam({ name: 'id', type: String })
  @ApiResult(
    object({
      item: object(caseProps),
      notes: { type: 'array', maxItems: 20, items: noteSchema },
      nextNotesCursor: { type: 'string', nullable: true },
    }),
    [400, 401, 403, 404, 500],
  )
  async detail(@Req() r: ApiRequest, @Query() q: unknown, @Param('id') id: string) {
    const b = query(q, true);
    return success(r, await this.service.detail(r, b.w, uuid(id), b.cursor));
  }
  @Get(':id/timeline')
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiQuery({ name: 'filter', required: false, enum: [...evidenceSources] })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({ name: 'focus', required: false, type: String })
  @ApiParam({ name: 'id', type: String })
  @ApiResult(
    object({
      item: object(caseProps),
      syntheticOnly: { type: 'boolean', enum: [true] },
      filter: { type: 'string', enum: [...evidenceSources] },
      focusedRef: { ...text, nullable: true },
      nextCursor: { ...text, nullable: true },
      items: {
        type: 'array',
        maxItems: 20,
        items: object({
          id: text,
          ref: text,
          source: { type: 'string', enum: [...evidenceSources].slice(1) },
          createdAt: text,
          title: text,
          entries: { type: 'array', maxItems: 8, items: object({ label: text, value: text }) },
          related: { type: 'array', maxItems: 2, items: object({ ref: text, label: text }) },
        }),
      },
    }),
    [400, 401, 403, 404, 500],
  )
  async timeline(@Req() r: ApiRequest, @Query() q: unknown, @Param('id') id: string) {
    const b = fields(q, ['warehouseId', 'filter', 'cursor', 'focus']);
    if (
      b.filter !== undefined &&
      (typeof b.filter !== 'string' || !evidenceSources.includes(b.filter as EvidenceFilter))
    )
      throw failure(400, 'VALIDATION_ERROR', '证据筛选无效');
    if (b.cursor !== undefined && b.focus !== undefined)
      throw failure(400, 'VALIDATION_ERROR', '分页与定位不能同时使用');
    if (b.cursor !== undefined) evidenceReference(b.cursor);
    if (b.focus !== undefined) evidenceReference(b.focus);
    return success(
      r,
      await this.service.timeline(
        r,
        uuid(b.warehouseId),
        uuid(id),
        (b.filter ?? 'ALL') as EvidenceFilter,
        b.cursor as string | undefined,
        b.focus as string | undefined,
      ),
    );
  }
  @Post(':id/notes')
  @HttpCode(200)
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiParam({ name: 'id', type: String })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({
    schema: object({
      key: { type: 'string', format: 'uuid' },
      note: { type: 'string', minLength: 1, maxLength: 500 },
      attemptVersion: { type: 'integer', minimum: 0, maximum: 100 },
      jobVersion: { type: 'integer', nullable: true, minimum: 0 },
    }),
  })
  @ApiResult(
    object({ note: noteSchema, duplicate: { type: 'boolean' } }),
    [400, 401, 403, 404, 409, 503, 500],
  )
  async append(
    @Req() r: ApiRequest,
    @Query() q: unknown,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const qv = fields(q, ['warehouseId']),
      b = fields(body, ['key', 'note', 'attemptVersion', 'jobVersion']);
    const note = str(typeof b.note === 'string' ? b.note.replace(/\r\n?/g, '\n') : b.note, 500);
    if (
      Array.from(note).some((c) => {
        const n = c.charCodeAt(0);
        return (n < 32 && n !== 9 && n !== 10) || n === 127;
      })
    )
      throw failure(400, 'VALIDATION_ERROR', '备注含无效控制字符');
    return success(
      r,
      await this.service.append(r, uuid(qv.warehouseId), uuid(id), {
        key: uuid(b.key),
        note,
        attemptVersion: integer(b.attemptVersion, 0, 100),
        jobVersion: b.jobVersion === null ? null : integer(b.jobVersion, 0, 2147483646),
      }),
    );
  }
}
