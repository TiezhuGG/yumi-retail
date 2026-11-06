import { Controller, Get, Header, Inject, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@yumi/database';
import type { MallTasks } from '@yumi/contracts';
import { CatalogService } from './catalog-service.js';
import { PointsGrantService } from './points-grants.js';
import { fields, uuid } from './catalog-input.js';
import { failure, success, type ApiRequest } from './http.js';
import { Permissions } from './staff-guard.js';
import { ApiResult, object, text } from './api-result.js';

export class MallTasksService {
  readonly auth: PointsGrantService;
  constructor(readonly catalog: CatalogService) {
    this.auth = new PointsGrantService(catalog);
  }
  async read(r: ApiRequest, query: unknown): Promise<MallTasks> {
    const q = fields(query, ['threshold', 'cursor', 'stock']);
    const threshold =
      q.threshold === undefined
        ? 5
        : typeof q.threshold === 'string' && /^(0|[1-9][0-9]{0,3})$/.test(q.threshold)
          ? Number(q.threshold)
          : NaN;
    if (!Number.isInteger(threshold) || threshold > 1000)
      throw failure(400, 'VALIDATION_ERROR', '查看阈值须为0至1000的整数');
    const cursor = q.cursor === undefined ? null : uuid(q.cursor);
    const filter = q.stock ?? 'ALL';
    if (!['ALL', 'ZERO', 'LOW'].includes(filter as string))
      throw failure(400, 'VALIDATION_ERROR', '库存筛选无效');
    return this.catalog.db.$transaction(
      async (tx) => {
        const w = await this.auth.authorize(r, tx);
        const now = (
          await tx.$queryRaw<Array<{ now: Date }>>`SELECT statement_timestamp() AS now`
        )[0]!.now;
        // Exactly the public inventory formula: active source + active published reward only.
        const matched = Prisma.sql`SELECT r.id,r.title,v.name,v.spec,v.unit,v.available FROM reward_products r JOIN (${this.catalog.visibleSkus(w, { keyword: '', categoryId: null })}) v ON v.id=r.sku_id WHERE r.warehouse_id=${w}::uuid AND r.status='PUBLISHED' AND (r.starts_at IS NULL OR r.starts_at<=${now}) AND (r.ends_at IS NULL OR r.ends_at>${now})`;
        const totals = (
          await tx.$queryRaw<Array<{ zero: number; low: number }>>(
            Prisma.sql`WITH m AS (${matched}) SELECT count(*) FILTER(WHERE available=0)::int AS zero,count(*) FILTER(WHERE available>0 AND available<=${threshold})::int AS low FROM m`,
          )
        )[0]!;
        const rows = await tx.$queryRaw<MallTasks['stock']['items']>(
          Prisma.sql`WITH m AS (${matched}) SELECT * FROM m WHERE (${cursor}::uuid IS NULL OR id>${cursor}::uuid) AND (CASE WHEN ${filter}='ZERO' THEN available=0 WHEN ${filter}='LOW' THEN available>0 AND available<=${threshold} ELSE available<=${threshold} END) ORDER BY id LIMIT 21`,
        );
        // Pending stages are facts, not a guessed SLA. Return waiting time starts at the
        // APPROVE/RECEIVE event, rather than incorrectly using the original application date.
        const queues = await tx.$queryRaw<
          Array<{ code: MallTasks['queues'][number]['code']; count: number; oldestAt: Date | null }>
        >`
        WITH returns AS (
          SELECT r.created_at,a.created_at AS approved_at,g.created_at AS received_at,
            CASE WHEN a.id IS NULL THEN 'REQUESTED' WHEN a.requires_return AND g.id IS NULL THEN 'WAIT_RETURN' ELSE 'READY_TO_REFUND' END AS state
          FROM redemption_returns r JOIN redemption_orders o ON o.id=r.order_id
          LEFT JOIN redemption_return_events a ON a.return_id=r.id AND a.kind='APPROVE'
          LEFT JOIN redemption_return_events g ON g.return_id=r.id AND g.kind='RECEIVE'
          WHERE o.warehouse_id=${w}::uuid AND NOT EXISTS(SELECT 1 FROM redemption_return_events e WHERE e.return_id=r.id AND e.kind IN ('REJECT','CANCEL','REFUND'))
        ), pending AS (
          SELECT 'WAIT_SHIP' AS code,o.created_at AS since FROM redemption_orders o JOIN redemption_outbox j ON j.order_id=o.id WHERE o.warehouse_id=${w}::uuid AND o.delivery_mode='EXPRESS' AND o.status='ACTIVE' AND j.state='EXPRESS_WAIT'
          UNION ALL SELECT 'GRANTS',created_at FROM points_grants WHERE warehouse_id=${w}::uuid AND status='SUBMITTED'
          UNION ALL SELECT 'CORRECTIONS',created_at FROM points_corrections WHERE warehouse_id=${w}::uuid AND status='SUBMITTED'
          UNION ALL SELECT CASE WHEN status='OPEN' THEN 'FEEDBACK_OPEN' ELSE 'FEEDBACK_PROCESSING' END,updated_at FROM redemption_after_sales WHERE warehouse_id=${w}::uuid AND status IN ('OPEN','PROCESSING')
          UNION ALL SELECT state,CASE WHEN state='REQUESTED' THEN created_at WHEN state='WAIT_RETURN' THEN approved_at ELSE COALESCE(received_at,approved_at) END FROM returns
        ) SELECT code,count(*)::int AS count,min(since) AS "oldestAt" FROM pending GROUP BY code`;
        await this.auth.authorize(r, tx);
        const codes: MallTasks['queues'][number]['code'][] = [
          'WAIT_SHIP',
          'GRANTS',
          'CORRECTIONS',
          'FEEDBACK_OPEN',
          'FEEDBACK_PROCESSING',
          'REQUESTED',
          'WAIT_RETURN',
          'READY_TO_REFUND',
        ];
        return {
          checkedAt: now.toISOString(),
          lowStockThreshold: threshold,
          stock: {
            outOfStock: totals.zero,
            lowStock: totals.low,
            items: rows.slice(0, 20),
            nextCursor: rows.length > 20 ? rows[19]!.id : null,
          },
          queues: codes.map((code) => {
            const row = queues.find((x) => x.code === code);
            return { code, count: row?.count ?? 0, oldestAt: row?.oldestAt?.toISOString() ?? null };
          }),
        };
      },
      { isolationLevel: 'RepeatableRead', timeout: 15000 },
    );
  }
}
const count = { type: 'integer' as const, minimum: 0 },
  nullable = { ...text, nullable: true };
@ApiTags('商城待办')
@ApiCookieAuth('staffSession')
@Permissions('points.read')
@Controller('admin/mall-tasks')
export class MallTasksController {
  constructor(@Inject(MallTasksService) readonly service: MallTasksService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiQuery({
    name: 'threshold',
    required: false,
    type: Number,
    description: '仅本次查看的低库存阈值，默认5，0至1000；不保存经营设置',
  })
  @ApiQuery({ name: 'stock', required: false, enum: ['ALL', 'ZERO', 'LOW'] })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiResult(
    object({
      checkedAt: text,
      lowStockThreshold: count,
      stock: object({
        outOfStock: count,
        lowStock: count,
        items: {
          type: 'array',
          maxItems: 20,
          items: object({
            id: text,
            title: text,
            name: text,
            spec: text,
            unit: text,
            available: count,
          }),
        },
        nextCursor: nullable,
      }),
      queues: {
        type: 'array',
        maxItems: 8,
        items: object({
          code: {
            type: 'string',
            enum: [
              'WAIT_SHIP',
              'GRANTS',
              'CORRECTIONS',
              'FEEDBACK_OPEN',
              'FEEDBACK_PROCESSING',
              'REQUESTED',
              'WAIT_RETURN',
              'READY_TO_REFUND',
            ],
          },
          count,
          oldestAt: nullable,
        }),
      },
    }),
    [400, 401, 403, 500, 503],
  )
  async read(@Req() r: ApiRequest, @Query() q: unknown) {
    return success(r, await this.service.read(r, q));
  }
}
