import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiHeader, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@yumi/database';
import type { PickingLabTask } from '@yumi/contracts';
import { CatalogService } from './catalog-service.js';
import { fields, uuid, integer } from './catalog-input.js';
import { Permissions } from './staff-guard.js';
import { failure, success, type ApiRequest } from './http.js';
import { object, text, ApiResult } from './api-result.js';
export const fixture = [
  {
    id: 'PAPER_SINGLE',
    name: '合成纸巾',
    spec: '单包装',
    unit: '包',
    batchNo: 'LAB-BATCH-A',
    location: '合成拣货位 A',
    required: 2,
  },
  {
    id: 'PAPER_TRIPLE',
    name: '合成纸巾',
    spec: '3包装',
    unit: '组',
    batchNo: 'LAB-BATCH-B',
    location: '合成拣货位 B',
    required: 1,
  },
];
export const include = {
  owner: { select: { displayName: true } },
  events: { orderBy: { version: 'asc' as const } },
  shortages: {
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
    include: {
      reporter: { select: { displayName: true } },
      resolver: { select: { displayName: true } },
      events: { orderBy: { revision: 'asc' as const } },
    },
  },
};
type Row = Prisma.PickingLabTaskGetPayload<{ include: typeof include }>;
export const dto = (t: Row): PickingLabTask => ({
  id: t.id,
  label: '演练任务 · ' + t.id.slice(-8),
  state: t.state as PickingLabTask['state'],
  version: t.version,
  exceptionVersion: t.exceptionVersion,
  shortages: t.shortages.map((s) => ({
    id: s.id,
    lineId: s.lineId,
    missingQuantity: s.missingQuantity,
    reason: s.reason,
    state: s.state,
    version: s.version,
    reporterName: s.reporter.displayName,
    resolverName: s.resolver?.displayName ?? null,
    createdAt: s.createdAt.toISOString(),
    resolvedAt: s.resolvedAt?.toISOString() ?? null,
    events: s.events.map((e) => ({
      action: e.action,
      actorName: e.actorName,
      quantity: e.quantity,
      createdAt: e.createdAt.toISOString(),
    })),
  })),
  ownerId: t.ownerId,
  ownerName: t.owner?.displayName ?? null,
  createdAt: t.createdAt.toISOString(),
  syntheticOnly: true,
  lines: fixture.map((i) => ({ ...i, checked: t.checkedLines.includes(i.id) })),
  events: t.events.map((e) => ({
    action: e.action,
    actorName: e.actorName,
    lineId: e.lineId,
    quantity: e.quantity,
    createdAt: e.createdAt.toISOString(),
  })),
});
export class PickingLabService {
  constructor(
    readonly catalog: CatalogService,
    readonly enabled = false,
  ) {}
  private assertEnabled() {
    if (!this.enabled) throw failure(503, 'PICKING_LAB_DISABLED', '本机拣货演练写入尚未开启');
  }
  async list(r: ApiRequest, w: string, cursor?: string) {
    return this.catalog.db.$transaction(
      async (tx) => {
        await this.catalog.warehouse(tx, r, w);
        const anchor = cursor
          ? await tx.pickingLabTask.findFirst({ where: { id: cursor, warehouseId: w } })
          : null;
        if (cursor && !anchor) throw failure(404, 'PICKING_LAB_NOT_FOUND', '演练分页位置不存在');
        const rows = await tx.pickingLabTask.findMany({
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
          include,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 21,
        });
        return {
          enabled: this.enabled,
          syntheticOnly: true as const,
          items: rows.slice(0, 20).map(dto),
          nextCursor: rows.length > 20 ? rows[19]!.id : null,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async read(r: ApiRequest, w: string, id: string) {
    return this.catalog.db.$transaction(
      async (tx) => {
        await this.catalog.warehouse(tx, r, w);
        const t = await tx.pickingLabTask.findFirst({ where: { id, warehouseId: w }, include });
        if (!t) throw failure(404, 'PICKING_LAB_NOT_FOUND', '演练任务不存在');
        return { enabled: this.enabled, task: dto(t) };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
  async create(r: ApiRequest, w: string, key: string) {
    this.assertEnabled();
    return this.catalog.db.$transaction(async (tx) => {
      await this.catalog.warehouse(tx, r, w);
      const actor = r.staffContext!,
        id = randomUUID();
      const added = await tx.pickingLabTask.createMany({
        data: { id, warehouseId: w, creatorId: actor.staffId, key },
        skipDuplicates: true,
      });
      await tx.$queryRaw`SELECT id FROM picking_lab_tasks WHERE warehouse_id=${w}::uuid AND creator_id=${actor.staffId}::uuid AND key=${key}::uuid FOR SHARE`;
      const t = await tx.pickingLabTask.findUniqueOrThrow({
        where: { warehouseId_creatorId_key: { warehouseId: w, creatorId: actor.staffId, key } },
        include,
      });
      if (added.count) {
        await tx.pickingLabEvent.create({
          data: {
            id: randomUUID(),
            taskId: t.id,
            actorId: actor.staffId,
            actorName: actor.displayName,
            key,
            action: 'CREATE',
            version: 0,
            state: 'READY',
            checkedLines: [],
          },
        });
        await this.catalog.audit(tx, r, 'PICKING_LAB_CREATE', t.id, w, null, {
          syntheticOnly: true,
        });
      }
      return {
        task: dto(await tx.pickingLabTask.findUniqueOrThrow({ where: { id: t.id }, include })),
        duplicate: !added.count,
      };
    });
  }
  async act(
    r: ApiRequest,
    w: string,
    id: string,
    action: 'CLAIM' | 'CHECK',
    input: {
      key: string;
      version: number;
      exceptionVersion?: number;
      lineId?: string;
      quantity?: number;
    },
  ) {
    this.assertEnabled();
    return this.catalog.db.$transaction(async (tx) => {
      await this.catalog.warehouse(tx, r, w);
      await tx.$queryRaw`SELECT id FROM picking_lab_tasks WHERE id=${id}::uuid AND warehouse_id=${w}::uuid FOR UPDATE`;
      const t = await tx.pickingLabTask.findFirst({ where: { id, warehouseId: w }, include });
      if (!t) throw failure(404, 'PICKING_LAB_NOT_FOUND', '演练任务不存在');
      const actor = r.staffContext!;
      const old = await tx.pickingLabEvent.findUnique({
        where: { taskId_actorId_key: { taskId: id, actorId: actor.staffId, key: input.key } },
      });
      if (old) {
        if (
          old.action !== action ||
          old.expectedVersion !== input.version ||
          old.exceptionVersion !== (input.exceptionVersion ?? 0) ||
          old.lineId !== (input.lineId ?? null) ||
          old.quantity !== (input.quantity ?? null)
        )
          throw failure(409, 'IDEMPOTENCY_CONFLICT', '原操作键的动作或核对内容已改变');
        return { task: dto(t), duplicate: true };
      }
      if (t.version !== input.version || t.exceptionVersion !== (input.exceptionVersion ?? 0))
        throw failure(409, 'PICKING_VERSION_STALE', '演练任务已变化，请刷新后核对');
      if (action === 'CLAIM') {
        if (t.state !== 'READY')
          throw failure(409, 'PICKING_ALREADY_CLAIMED', '任务已被领取，不能重复领取或抢占');
      } else {
        if (t.ownerId !== actor.staffId)
          throw failure(403, 'PICKING_NOT_OWNER', '只能核对本人领取的演练任务');
        if (t.shortages.some((s) => s.state === 'OPEN'))
          throw failure(409, 'PICKING_SHORTAGE_OPEN', '有未决缺货记录，整项演练暂停核对');
        if (t.state !== 'PICKING') throw failure(409, 'PICKING_NOT_OPEN', '当前任务不能继续核对');
        const line = fixture.find((l) => l.id === input.lineId)!;
        if (input.quantity !== line.required)
          throw failure(409, 'PICKING_QUANTITY_MISMATCH', '核对数量与固定演练需求不一致，未保存');
        if (t.checkedLines.includes(line.id))
          throw failure(409, 'PICKING_LINE_CHECKED', '该行已核对；结果未知时请按原操作重试');
      }
      const checkedLines = action === 'CHECK' ? [...t.checkedLines, input.lineId!] : t.checkedLines;
      const updated = await tx.pickingLabTask.update({
        where: { id },
        data: {
          ownerId: action === 'CLAIM' ? actor.staffId : t.ownerId,
          checkedLines,
          state: checkedLines.length === 2 ? 'CHECKED' : 'PICKING',
          version: t.version + 1,
        },
      });
      await tx.pickingLabEvent.create({
        data: {
          id: randomUUID(),
          taskId: id,
          actorId: actor.staffId,
          actorName: actor.displayName,
          key: input.key,
          action,
          expectedVersion: input.version,
          exceptionVersion: input.exceptionVersion ?? 0,
          version: updated.version,
          lineId: input.lineId,
          quantity: input.quantity,
          state: updated.state,
          ownerId: updated.ownerId,
          checkedLines,
        },
      });
      await this.catalog.audit(tx, r, 'PICKING_LAB_' + action, id, w, null, {
        syntheticOnly: true,
        lineId: input.lineId ?? null,
      });
      return {
        task: dto(await tx.pickingLabTask.findUniqueOrThrow({ where: { id }, include })),
        duplicate: false,
      };
    });
  }
}
export const taskSchema = object({
  id: text,
  label: text,
  state: { type: 'string', enum: ['READY', 'PICKING', 'CHECKED'] },
  version: { type: 'integer', minimum: 0, maximum: 3 },
  exceptionVersion: { type: 'integer', minimum: 0, maximum: 100 },
  shortages: {
    type: 'array',
    maxItems: 50,
    items: object({
      id: text,
      lineId: text,
      missingQuantity: { type: 'integer' },
      reason: text,
      state: { type: 'string', enum: ['OPEN', 'RESOLVED'] },
      version: { type: 'integer' },
      reporterName: text,
      resolverName: { ...text, nullable: true },
      createdAt: text,
      resolvedAt: { ...text, nullable: true },
      events: {
        type: 'array',
        maxItems: 2,
        items: object({
          action: text,
          actorName: text,
          quantity: { type: 'integer' },
          createdAt: text,
        }),
      },
    }),
  },
  ownerId: { ...text, nullable: true },
  ownerName: { ...text, nullable: true },
  createdAt: text,
  syntheticOnly: { type: 'boolean', enum: [true] },
  lines: {
    type: 'array',
    minItems: 2,
    maxItems: 2,
    items: object({
      id: text,
      name: text,
      spec: text,
      unit: text,
      batchNo: text,
      location: text,
      required: { type: 'integer' },
      checked: { type: 'boolean' },
    }),
  },
  events: {
    type: 'array',
    maxItems: 4,
    items: object({
      action: text,
      actorName: text,
      lineId: { ...text, nullable: true },
      quantity: { type: 'integer', nullable: true },
      createdAt: text,
    }),
  },
});
const writeSchema = object({ task: taskSchema, duplicate: { type: 'boolean' } });
@ApiTags('拣货隔离演练')
@ApiCookieAuth('staffSession')
@Permissions('picking-lab.read')
@Controller('warehouse/picking-lab')
export class PickingLabController {
  constructor(@Inject(PickingLabService) readonly service: PickingLabService) {}
  @Get()
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiResult(
    object({
      enabled: { type: 'boolean' },
      syntheticOnly: { type: 'boolean', enum: [true] },
      items: { type: 'array', maxItems: 20, items: taskSchema },
      nextCursor: { ...text, nullable: true },
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
  @ApiResult(object({ enabled: { type: 'boolean' }, task: taskSchema }), [400, 401, 403, 404, 500])
  async read(@Req() r: ApiRequest, @Query() q: unknown, @Param('id') id: string) {
    const b = fields(q, ['warehouseId']);
    return success(r, await this.service.read(r, uuid(b.warehouseId), uuid(id)));
  }
  @Post()
  @HttpCode(200)
  @Permissions('picking-lab.read', 'picking-lab.create')
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({ schema: object({ key: { type: 'string', format: 'uuid' } }) })
  @ApiResult(writeSchema, [400, 401, 403, 503, 500])
  async create(@Req() r: ApiRequest, @Query() q: unknown, @Body() body: unknown) {
    const b = fields(q, ['warehouseId']),
      v = fields(body, ['key']);
    return success(r, await this.service.create(r, uuid(b.warehouseId), uuid(v.key)));
  }
  @Post(':id/claim')
  @HttpCode(200)
  @Permissions('picking-lab.read', 'picking-lab.work')
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiParam({ name: 'id', type: String })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({
    schema: object(
      {
        key: { type: 'string', format: 'uuid' },
        version: { type: 'integer', minimum: 0, maximum: 3 },
        exceptionVersion: { type: 'integer', minimum: 0, maximum: 100 },
      },
      ['key', 'version'],
    ),
  })
  @ApiResult(writeSchema, [400, 401, 403, 404, 409, 503, 500])
  async claim(
    @Req() r: ApiRequest,
    @Query() q: unknown,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = fields(q, ['warehouseId']),
      v = fields(body, ['key', 'version', 'exceptionVersion']);
    return success(
      r,
      await this.service.act(r, uuid(b.warehouseId), uuid(id), 'CLAIM', {
        key: uuid(v.key),
        version: integer(v.version, 0, 3),
        exceptionVersion:
          v.exceptionVersion === undefined ? 0 : integer(v.exceptionVersion, 0, 100),
      }),
    );
  }
  @Post(':id/check')
  @HttpCode(200)
  @Permissions('picking-lab.read', 'picking-lab.work')
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiParam({ name: 'id', type: String })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({
    schema: object(
      {
        key: { type: 'string', format: 'uuid' },
        version: { type: 'integer', minimum: 0, maximum: 3 },
        lineId: { type: 'string', enum: fixture.map((l) => l.id) },
        quantity: { type: 'integer', minimum: 0, maximum: 200 },
        exceptionVersion: { type: 'integer', minimum: 0, maximum: 100 },
      },
      ['key', 'version', 'lineId', 'quantity'],
    ),
  })
  @ApiResult(writeSchema, [400, 401, 403, 404, 409, 503, 500])
  async check(
    @Req() r: ApiRequest,
    @Query() q: unknown,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = fields(q, ['warehouseId']),
      v = fields(body, ['key', 'version', 'exceptionVersion', 'lineId', 'quantity']);
    if (typeof v.lineId !== 'string' || !fixture.some((l) => l.id === v.lineId))
      throw failure(400, 'VALIDATION_ERROR', '演练明细无效');
    return success(
      r,
      await this.service.act(r, uuid(b.warehouseId), uuid(id), 'CHECK', {
        key: uuid(v.key),
        version: integer(v.version, 0, 3),
        exceptionVersion:
          v.exceptionVersion === undefined ? 0 : integer(v.exceptionVersion, 0, 100),
        lineId: v.lineId,
        quantity: integer(v.quantity, 0, 200),
      }),
    );
  }
}
