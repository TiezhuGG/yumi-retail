import { Controller, Get, Header, Inject, Param, Query, Req } from '@nestjs/common';
import { ApiCookieAuth, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  MALL_AUDIT_ACTIONS,
  MALL_AUDIT_GROUPS,
  POINTS_REPORT_KIND_LABELS,
  type MallAuditAction,
  type MallAuditDetail,
  type MallAuditEntry,
  type MallAuditPage,
} from '@yumi/contracts';
import type { Prisma } from '@yumi/database';
import { CatalogService } from './catalog-service.js';
import { PointsGrantService } from './points-grants.js';
import { fields, str, uuid } from './catalog-input.js';
import { failure, success, type ApiRequest } from './http.js';
import { Permissions } from './staff-guard.js';
import { ApiResult, object, text } from './api-result.js';
const actions = Object.keys(MALL_AUDIT_ACTIONS) as MallAuditAction[];
const select = {
  id: true,
  action: true,
  resourceId: true,
  requestId: true,
  createdAt: true,
  actor: { select: { displayName: true } },
} satisfies Prisma.BusinessAuditSelect;
type RecordRow = Prisma.BusinessAuditGetPayload<{ select: typeof select }>;
type Tx = Prisma.TransactionClient;
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
function exportSummary(value: unknown): MallAuditDetail['exportSummary'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    !['LEDGER', 'DAILY'].includes(v.dataset as string) ||
    typeof v.from !== 'string' ||
    typeof v.to !== 'string' ||
    typeof v.generatedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.generatedAt) ||
    !Number.isFinite(Date.parse(v.generatedAt)) ||
    new Date(v.generatedAt).toISOString() !== v.generatedAt ||
    !Number.isSafeInteger(v.rowCount) ||
    (v.rowCount as number) < 0 ||
    (v.rowCount as number) > (v.dataset === 'DAILY' ? 366 : 5000) ||
    (v.kind !== null &&
      (typeof v.kind !== 'string' || !Object.hasOwn(POINTS_REPORT_KIND_LABELS, v.kind)))
  )
    return null;
  try {
    day(v.from);
    day(v.to);
  } catch {
    return null;
  }
  const days = (Date.parse(v.to) - Date.parse(v.from)) / 86400000 + 1;
  if (days < 1 || days > 366 || (v.dataset === 'DAILY' && v.kind !== null)) return null;
  return {
    dataset: v.dataset as 'LEDGER' | 'DAILY',
    from: v.from,
    to: v.to,
    kind: v.kind as string | null,
    rowCount: v.rowCount as number,
    generatedAt: v.generatedAt,
  };
}
export class MallAuditService {
  readonly auth: PointsGrantService;
  constructor(readonly catalog: CatalogService) {
    this.auth = new PointsGrantService(catalog);
  }
  private async source(
    tx: Tx,
    w: string,
    a: RecordRow,
  ): Promise<{ label: string; orderNos: string[] }> {
    const config = MALL_AUDIT_ACTIONS[a.action as MallAuditAction],
      base = { label: '关联资料不可用', orderNos: [] as string[] };
    switch (config.source) {
      case 'REWARD': {
        const r = await tx.rewardProduct.findFirst({
          where: { id: a.resourceId, warehouseId: w },
          select: { title: true, sku: { select: { spec: true } } },
        });
        return r ? { ...base, label: r.title + ' · ' + r.sku.spec } : base;
      }
      case 'GRANT': {
        const r = await tx.pointsGrant.findFirst({
          where: { id: a.resourceId, warehouseId: w },
          select: { amount: true, user: { select: { displayName: true } } },
        });
        return r
          ? { ...base, label: r.user.displayName + ' · 发放申请 ' + r.amount.toString() + '积分' }
          : base;
      }
      case 'CORRECTION': {
        const r = await tx.pointsCorrection.findFirst({
          where: { id: a.resourceId, warehouseId: w },
          select: { amount: true, grant: { select: { user: { select: { displayName: true } } } } },
        });
        return r
          ? {
              ...base,
              label: r.grant.user.displayName + ' · 冲正申请 ' + r.amount.toString() + '积分',
            }
          : base;
      }
      case 'ORDER': {
        const r = await tx.redemptionOrder.findFirst({
          where: { id: a.resourceId, warehouseId: w },
          select: { orderNo: true, title: true },
        });
        return r ? { label: r.orderNo + ' · ' + r.title, orderNos: [r.orderNo] } : base;
      }
      case 'PARCEL': {
        const p = await tx.redemptionExpressParcel.findFirst({
          where: { id: a.resourceId, warehouseId: w },
          select: { orderIds: true },
        });
        if (!p) return base;
        const rows = await tx.redemptionOrder.findMany({
          where: { warehouseId: w, id: { in: p.orderIds } },
          select: { orderNo: true },
          orderBy: { orderNo: 'asc' },
        });
        return { label: '合包发货 · ' + rows.length + '单', orderNos: rows.map((o) => o.orderNo) };
      }
      case 'BATCH': {
        const rows = await tx.redemptionExpressShipment.findMany({
          where: { warehouseId: w, requestId: a.requestId },
          select: { order: { select: { orderNo: true } } },
          orderBy: { orderId: 'asc' },
          take: 21,
        });
        return rows.length && rows.length <= 20
          ? {
              label: '批量运单发货 · ' + rows.length + '单',
              orderNos: rows.map((o) => o.order.orderNo),
            }
          : base;
      }
      case 'CUSTOMER': {
        const u = await tx.consumerUser.findUnique({
          where: { id: a.resourceId },
          select: { displayName: true },
        });
        return u ? { ...base, label: u.displayName } : base;
      }
      case 'EXPORT':
        return { ...base, label: '积分报表文件' };
      case 'POLICY':
        return { ...base, label: a.action === 'POINTS_POLICY' ? '积分发放规则' : '快递范围与运费' };
    }
  }
  private entry(a: RecordRow, sourceLabel: string): MallAuditEntry {
    return {
      id: a.id,
      action: a.action as MallAuditAction,
      group: MALL_AUDIT_ACTIONS[a.action as MallAuditAction].group,
      actorName: a.actor.displayName,
      createdAt: a.createdAt.toISOString(),
      sourceLabel,
    };
  }
  async list(r: ApiRequest, input: unknown): Promise<MallAuditPage> {
    const q = fields(input, ['from', 'to', 'group', 'actor', 'cursor']),
      from = day(q.from),
      to = day(q.to),
      start = new Date(from + 'T00:00:00+08:00'),
      end = new Date(new Date(to + 'T00:00:00+08:00').getTime() + 86400000);
    if (end <= start || end.getTime() - start.getTime() > 366 * 86400000)
      throw failure(400, 'VALIDATION_ERROR', '日期范围须为1至366天');
    const group = q.group === undefined ? null : str(q.group, 30),
      actor = q.actor === undefined ? null : str(q.actor, 80),
      cursor = q.cursor === undefined ? null : uuid(q.cursor);
    if (group && !Object.hasOwn(MALL_AUDIT_GROUPS, group))
      throw failure(400, 'VALIDATION_ERROR', '操作类别无效');
    return this.catalog.db.$transaction(
      async (tx) => {
        const w = await this.auth.authorize(r, tx);
        const where: Prisma.BusinessAuditWhereInput = {
          warehouseId: w,
          action: { in: actions.filter((a) => !group || MALL_AUDIT_ACTIONS[a].group === group) },
          createdAt: { gte: start, lt: end },
          ...(actor
            ? {
                actor: {
                  displayName: { contains: actor.replace(/[\\%_]/g, '\\$&'), mode: 'insensitive' },
                },
              }
            : {}),
        };
        const anchor = cursor
          ? await tx.businessAudit.findFirst({
              where: { ...where, id: cursor },
              select: { id: true, createdAt: true },
            })
          : null;
        if (cursor && !anchor) throw failure(400, 'INVALID_CURSOR', '分页条件已变化，请重新查询');
        const rows = await tx.businessAudit.findMany({
          where: {
            ...where,
            ...(anchor
              ? {
                  OR: [
                    { createdAt: { lt: anchor.createdAt } },
                    { createdAt: anchor.createdAt, id: { lt: anchor.id } },
                  ],
                }
              : {}),
          },
          select,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 21,
        });
        const cache = new Map<string, Awaited<ReturnType<MallAuditService['source']>>>(),
          items: MallAuditEntry[] = [];
        for (const a of rows.slice(0, 20)) {
          const key = MALL_AUDIT_ACTIONS[a.action as MallAuditAction].source + ':' + a.resourceId;
          let value = cache.get(key);
          if (!value) {
            value = await this.source(tx, w, a);
            cache.set(key, value);
          }
          items.push(this.entry(a, value.label));
        }
        await this.auth.authorize(r, tx);
        return { items, nextCursor: rows.length > 20 ? rows[19]!.id : null };
      },
      { isolationLevel: 'RepeatableRead', timeout: 15000 },
    );
  }
  async detail(r: ApiRequest, id: string): Promise<MallAuditDetail> {
    return this.catalog.db.$transaction(
      async (tx) => {
        const w = await this.auth.authorize(r, tx),
          record = await tx.businessAudit.findFirst({
            where: { id, warehouseId: w, action: { in: actions } },
            select,
          });
        if (!record) throw failure(404, 'MALL_AUDIT_NOT_FOUND', '未找到授权范围内的商城操作记录');
        const source = await this.source(tx, w, record);
        let summary: MallAuditDetail['exportSummary'] = null;
        if (record.action === 'POINTS_REPORT_EXPORT')
          summary = exportSummary(
            (await tx.businessAudit.findUniqueOrThrow({ where: { id }, select: { details: true } }))
              .details,
          );
        await this.auth.authorize(r, tx);
        return {
          ...this.entry(record, source.label),
          requestId: record.requestId,
          orderNos: source.orderNos,
          exportSummary: summary,
        };
      },
      { isolationLevel: 'RepeatableRead', timeout: 15000 },
    );
  }
}
const entry = object({
  id: text,
  action: { type: 'string', enum: actions },
  group: { type: 'string', enum: Object.keys(MALL_AUDIT_GROUPS) },
  actorName: text,
  createdAt: text,
  sourceLabel: text,
});
@ApiTags('商城操作记录')
@ApiCookieAuth('staffSession')
@Permissions('points.read')
@Controller('admin/mall/audits')
export class MallAuditController {
  constructor(@Inject(MallAuditService) readonly service: MallAuditService) {}
  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiQuery({ name: 'from', required: true, type: String })
  @ApiQuery({ name: 'to', required: true, type: String })
  @ApiQuery({ name: 'group', required: false, enum: Object.keys(MALL_AUDIT_GROUPS) })
  @ApiQuery({ name: 'actor', required: false, type: String })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiResult(
    object({
      items: { type: 'array', maxItems: 20, items: entry },
      nextCursor: { ...text, nullable: true },
    }),
    [400, 401, 403, 500, 503],
  )
  async list(@Req() r: ApiRequest, @Query() q: unknown) {
    return success(r, await this.service.list(r, q));
  }
  @Get(':id')
  @Header('Cache-Control', 'no-store')
  @ApiResult(
    object({
      ...entry.properties,
      requestId: text,
      orderNos: { type: 'array', maxItems: 20, items: text },
      exportSummary: {
        ...object({
          dataset: { type: 'string', enum: ['LEDGER', 'DAILY'] },
          from: text,
          to: text,
          kind: { ...text, nullable: true },
          rowCount: { type: 'integer', minimum: 0 },
          generatedAt: text,
        }),
        nullable: true,
      },
    }),
    [400, 401, 403, 404, 500, 503],
  )
  async detail(@Req() r: ApiRequest, @Param('id') id: string, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.detail(r, uuid(id)));
  }
}
