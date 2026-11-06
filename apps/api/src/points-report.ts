import { Controller, Get, Header, Inject, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@yumi/database';
import type { PointsReport, PointsReportKind } from '@yumi/contracts';
import { CatalogService } from './catalog-service.js';
import { PointsGrantService } from './points-grants.js';
import { fields, str, uuid } from './catalog-input.js';
import { failure, success, type ApiRequest } from './http.js';
import { Permissions } from './staff-guard.js';
import { ApiResult, object, text } from './api-result.js';
const kinds: PointsReportKind[] = ['GRANT', 'REDEEM', 'CANCEL', 'RETURN', 'CORRECTION'];
// One canonical business source per ledger key. Includes non-posted states to detect
// unexpected entries; refunds must point back to their immutable REFUND event.
function sources() {
  return Prisma.sql`
 SELECT 'GRANT:'||g.id::text AS key,'GRANT' AS kind,g.id AS source_id,g.warehouse_id,g.user_id,g.amount AS expected_points,COALESCE(g.decided_at,g.created_at) AS occurred_at,g.status='APPROVED' AS expected,g.reference,NULL::uuid AS redemption_id,NULL::text AS redemption_action,NULL::uuid AS refund_ledger_id,g.reviewer_id AS expected_actor_id,NULL::uuid AS expected_consumer_id
 FROM points_grants g
 UNION ALL SELECT 'CORRECTION:'||c.id::text,'CORRECTION',c.id,c.warehouse_id,c.user_id,-c.amount,COALESCE(c.decided_at,c.created_at),c.status='APPROVED',c.reference,NULL,NULL,NULL,c.reviewer_id,NULL FROM points_corrections c
 UNION ALL SELECT 'REDEMPTION:'||o.id::text,'REDEEM',o.id,o.warehouse_id,o.user_id,-o.total_points,o.created_at,true,o.order_no,o.id,'REDEEM',NULL,NULL,o.user_id FROM redemption_orders o
 UNION ALL SELECT 'REDEMPTION_CANCEL:'||o.id::text,'CANCEL',o.id,o.warehouse_id,o.user_id,o.total_points,COALESCE(o.canceled_at,o.created_at),o.status='CANCELED',o.order_no,o.id,'CANCEL',NULL,NULL,o.user_id FROM redemption_orders o
 UNION ALL SELECT 'RETURN_REFUND:'||r.id::text,'RETURN',r.id,o.warehouse_id,r.user_id,r.quantity::bigint*o.points_price,COALESCE(e.created_at,r.created_at),e.id IS NOT NULL,o.order_no,NULL,NULL,e.ledger_id,e.actor_id,NULL FROM redemption_returns r JOIN redemption_orders o ON o.id=r.order_id LEFT JOIN redemption_return_events e ON e.return_id=r.id AND e.kind='REFUND'
`;
}
function day(v: unknown) {
  if (
    typeof v !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
    v.startsWith('0000-') ||
    !Number.isFinite(Date.parse(v + 'T00:00:00Z')) ||
    new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) !== v
  )
    throw failure(400, 'VALIDATION_ERROR', '日期须为有效的YYYY-MM-DD');
  return v;
}
export class PointsReportService {
  readonly auth: PointsGrantService;
  constructor(readonly catalog: CatalogService) {
    this.auth = new PointsGrantService(catalog);
  }
  async read(r: ApiRequest, query: unknown): Promise<PointsReport> {
    const q = fields(query, ['from', 'to', 'kind', 'view', 'cursor', 'accountCursor']);
    const from = day(q.from),
      to = day(q.to),
      start = new Date(from + 'T00:00:00+08:00'),
      end = new Date(new Date(to + 'T00:00:00+08:00').getTime() + 86400000);
    if (end <= start || end.getTime() - start.getTime() > 366 * 86400000)
      throw failure(400, 'VALIDATION_ERROR', '日期范围须为1至366天');
    const kind = q.kind === undefined ? null : str(q.kind, 20);
    if (kind !== null && !kinds.includes(kind as PointsReportKind))
      throw failure(400, 'VALIDATION_ERROR', '积分类型无效');
    const view = q.view ?? 'LEDGER';
    if (!['LEDGER', 'ISSUES'].includes(view as string))
      throw failure(400, 'VALIDATION_ERROR', '明细范围无效');
    const accountCursor = q.accountCursor === undefined ? null : uuid(q.accountCursor);
    const cursor = q.cursor === undefined ? null : str(q.cursor, 160);
    if (
      cursor !== null &&
      !/^(GRANT|CORRECTION|REDEMPTION|REDEMPTION_CANCEL|RETURN_REFUND):[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        cursor,
      )
    )
      throw failure(400, 'VALIDATION_ERROR', '分页位置无效');
    return this.catalog.db.$transaction(
      async (tx) => {
        const w = await this.auth.authorize(r, tx);
        const now = (
          await tx.$queryRaw<Array<{ now: Date }>>`SELECT statement_timestamp() AS now`
        )[0]!.now;
        const allSources = sources();
        const matched = Prisma.sql`SELECT s.*,l.id AS ledger_id,l.delta,l.created_at AS ledger_at,u.display_name,
    CASE WHEN s.expected AND l.id IS NULL THEN 'MISSING' WHEN NOT s.expected AND l.id IS NOT NULL THEN 'UNEXPECTED'
    WHEN l.id IS NOT NULL AND (l.user_id<>s.user_id OR l.delta<>s.expected_points OR l.actor_id IS DISTINCT FROM s.expected_actor_id OR l.consumer_actor_id IS DISTINCT FROM s.expected_consumer_id OR l.redemption_id IS DISTINCT FROM s.redemption_id OR l.redemption_action IS DISTINCT FROM s.redemption_action OR (s.kind='RETURN' AND l.id IS DISTINCT FROM s.refund_ledger_id)) THEN 'INVALID' ELSE NULL END AS issue
    FROM (${allSources}) s LEFT JOIN points_ledger l ON l.action_key=s.key JOIN consumer_users u ON u.id=s.user_id WHERE s.warehouse_id=${w}::uuid`;
        const totalsRaw = await tx.$queryRaw<
          Array<{ kind: PointsReportKind; count: number; points: string }>
        >(
          Prisma.sql`WITH m AS (${matched}) SELECT kind,count(*)::int AS count,sum(delta)::text AS points FROM m WHERE ledger_at>=${start} AND ledger_at<${end} GROUP BY kind`,
        );
        const totals = kinds.map(
          (kind) => totalsRaw.find((t) => t.kind === kind) ?? { kind, count: 0, points: '0' },
        );
        const daily = await tx.$queryRaw<PointsReport['daily']>(
          Prisma.sql`WITH m AS (${matched}) SELECT to_char(ledger_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS date,COALESCE(sum(delta) FILTER(WHERE delta>0),0)::text AS incoming,COALESCE(sum(-delta) FILTER(WHERE delta<0),0)::text AS outgoing,sum(delta)::text AS net FROM m WHERE ledger_at>=${start} AND ledger_at<${end} GROUP BY date ORDER BY date`,
        );
        const checks = (
          await tx.$queryRaw<
            Array<{
              sourceIssues: number;
              missingLedger: number;
              invalidLedger: number;
              unexpectedLedger: number;
            }>
          >(
            Prisma.sql`WITH m AS (${matched}) SELECT count(*) FILTER(WHERE issue IS NOT NULL)::int AS "sourceIssues",count(*) FILTER(WHERE issue='MISSING')::int AS "missingLedger",count(*) FILTER(WHERE issue='INVALID')::int AS "invalidLedger",count(*) FILTER(WHERE issue='UNEXPECTED')::int AS "unexpectedLedger" FROM m`,
          )
        )[0]!;
        const global = (
          await tx.$queryRaw<
            Array<{
              accountIssues: number;
              currentGlobalBalance: string;
              globalLedgerTotal: string;
            }>
          >`WITH ledger AS (SELECT user_id,sum(delta) AS total FROM points_ledger GROUP BY user_id),accounts AS (SELECT u.id,COALESCE(a.balance,0) AS balance,COALESCE(l.total,0) AS total FROM consumer_users u LEFT JOIN points_accounts a ON a.user_id=u.id LEFT JOIN ledger l ON l.user_id=u.id) SELECT count(*) FILTER(WHERE balance<>total)::int AS "accountIssues",COALESCE(sum(balance),0)::text AS "currentGlobalBalance",COALESCE(sum(total),0)::text AS "globalLedgerTotal" FROM accounts`
        )[0]!;
        const unassigned = (
          await tx.$queryRaw<Array<{ unassignedCount: number; unassignedPoints: string }>>(
            Prisma.sql`WITH s AS (${allSources}) SELECT count(*)::int AS "unassignedCount",COALESCE(sum(l.delta),0)::text AS "unassignedPoints" FROM points_ledger l WHERE NOT EXISTS(SELECT 1 FROM s WHERE s.key=l.action_key)`,
          )
        )[0]!;
        const rows = await tx.$queryRaw<
          Array<{
            key: string;
            kind: PointsReportKind;
            sourceId: string;
            reference: string;
            displayName: string;
            expectedPoints: string;
            actualPoints: string | null;
            occurredAt: Date;
            ledgerAt: Date | null;
            issue: PointsReport['items'][number]['issue'];
          }>
        >(
          Prisma.sql`WITH m AS (${matched}) SELECT key,kind,source_id AS "sourceId",reference,display_name AS "displayName",(CASE WHEN expected THEN expected_points ELSE 0 END)::text AS "expectedPoints",delta::text AS "actualPoints",occurred_at AS "occurredAt",ledger_at AS "ledgerAt",issue FROM m WHERE (${kind}::text IS NULL OR kind=${kind}) AND (${cursor}::text IS NULL OR key>${cursor}) AND (CASE WHEN ${view}='ISSUES' THEN issue IS NOT NULL ELSE ledger_at>=${start} AND ledger_at<${end} END) ORDER BY key LIMIT 21`,
        );
        const differences = await tx.$queryRaw<
          Array<{ userId: string; displayName: string; balance: string; ledgerTotal: string }>
        >`WITH ledger AS (SELECT user_id,sum(delta) AS total FROM points_ledger GROUP BY user_id) SELECT u.id AS "userId",u.display_name AS "displayName",COALESCE(a.balance,0)::text AS balance,COALESCE(l.total,0)::text AS "ledgerTotal" FROM consumer_users u LEFT JOIN points_accounts a ON a.user_id=u.id LEFT JOIN ledger l ON l.user_id=u.id WHERE COALESCE(a.balance,0)<>COALESCE(l.total,0) AND (${accountCursor}::uuid IS NULL OR u.id>${accountCursor}::uuid) ORDER BY u.id LIMIT 21`;
        await this.auth.authorize(r, tx);
        return {
          accountDifferences: {
            items: differences.slice(0, 20),
            nextCursor: differences.length > 20 ? differences[19]!.userId : null,
          },
          checkedAt: now.toISOString(),
          from,
          to,
          view: view as PointsReport['view'],
          totals,
          netPoints: totals.reduce((sum, t) => sum + BigInt(t.points), 0n).toString(),
          daily,
          reconciliation: { ...checks, ...global, ...unassigned },
          items: rows.slice(0, 20).map((x) => ({
            ...x,
            occurredAt: x.occurredAt.toISOString(),
            ledgerAt: x.ledgerAt?.toISOString() ?? null,
          })),
          nextCursor: rows.length > 20 ? rows[19]!.key : null,
        };
      },
      { isolationLevel: 'RepeatableRead', timeout: 15000 },
    );
  }
}
const count = { type: 'integer' as const, minimum: 0 },
  nullable = { ...text, nullable: true },
  kindSchema = { type: 'string' as const, enum: kinds };
@ApiTags('积分运营报表')
@ApiCookieAuth('staffSession')
@Permissions('points.read')
@Controller('admin/points/report')
export class PointsReportController {
  constructor(@Inject(PointsReportService) readonly service: PointsReportService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiQuery({
    name: 'from',
    required: true,
    type: String,
    description: '北京时间起始日期YYYY-MM-DD',
  })
  @ApiQuery({
    name: 'to',
    required: true,
    type: String,
    description: '北京时间结束日期（含），最多366天',
  })
  @ApiQuery({ name: 'kind', required: false, enum: kinds })
  @ApiQuery({ name: 'view', required: false, enum: ['LEDGER', 'ISSUES'] })
  @ApiQuery({ name: 'accountCursor', required: false, type: String })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiResult(
    object({
      accountDifferences: object({
        items: {
          type: 'array',
          maxItems: 20,
          items: object({ userId: text, displayName: text, balance: text, ledgerTotal: text }),
        },
        nextCursor: nullable,
      }),
      checkedAt: text,
      from: text,
      to: text,
      view: { type: 'string', enum: ['LEDGER', 'ISSUES'] },
      totals: {
        type: 'array',
        maxItems: 5,
        items: object({ kind: kindSchema, count, points: text }),
      },
      netPoints: text,
      daily: {
        type: 'array',
        maxItems: 366,
        items: object({ date: text, incoming: text, outgoing: text, net: text }),
      },
      reconciliation: object({
        sourceIssues: count,
        missingLedger: count,
        invalidLedger: count,
        unexpectedLedger: count,
        accountIssues: count,
        currentGlobalBalance: text,
        globalLedgerTotal: text,
        unassignedCount: count,
        unassignedPoints: text,
      }),
      items: {
        type: 'array',
        maxItems: 20,
        items: object({
          key: text,
          kind: kindSchema,
          sourceId: text,
          reference: text,
          displayName: text,
          expectedPoints: text,
          actualPoints: nullable,
          occurredAt: text,
          ledgerAt: nullable,
          issue: {
            type: 'string',
            nullable: true,
            enum: ['MISSING', 'INVALID', 'UNEXPECTED', null],
          },
        }),
      },
      nextCursor: nullable,
    }),
    [400, 401, 403, 500, 503],
  )
  async read(@Req() r: ApiRequest, @Query() q: unknown) {
    return success(r, await this.service.read(r, q));
  }
}
