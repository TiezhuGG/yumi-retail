import { randomUUID } from 'node:crypto';
import { Body, Controller, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiHeader, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { CatalogService } from './catalog-service.js';
import { fields, uuid, integer } from './catalog-input.js';
import { Permissions } from './staff-guard.js';
import { failure, success, type ApiRequest } from './http.js';
import { object, ApiResult } from './api-result.js';
import { fixture, include, dto, taskSchema } from './picking-lab.js';
type Input = {
  key: string;
  version: number;
  exceptionVersion: number;
  lineId?: string;
  quantity: number;
  reason?: string;
  shortageVersion?: number;
};
export class PickingShortageService {
  constructor(
    readonly catalog: CatalogService,
    readonly enabled = false,
  ) {}
  async act(
    r: ApiRequest,
    w: string,
    id: string,
    action: 'REPORT' | 'RESTORE',
    input: Input,
    shortageId?: string,
  ) {
    if (!this.enabled) throw failure(503, 'PICKING_LAB_DISABLED', '本机拣货演练写入尚未开启');
    return this.catalog.db.$transaction(async (tx) => {
      await this.catalog.warehouse(tx, r, w);
      await tx.$queryRaw`SELECT id FROM picking_lab_tasks WHERE id=${id}::uuid AND warehouse_id=${w}::uuid FOR UPDATE`;
      const t = await tx.pickingLabTask.findFirst({ where: { id, warehouseId: w }, include });
      if (!t) throw failure(404, 'PICKING_LAB_NOT_FOUND', '演练任务不存在');
      const actor = r.staffContext!;
      const old = await tx.pickingLabShortageEvent.findUnique({
        where: { taskId_actorId_key: { taskId: id, actorId: actor.staffId, key: input.key } },
      });
      if (old) {
        if (
          old.action !== action ||
          old.taskVersion !== input.version ||
          old.expectedRevision !== input.exceptionVersion ||
          old.quantity !== input.quantity ||
          old.reason !== (input.reason ?? null) ||
          (action === 'REPORT' && old.lineId !== input.lineId) ||
          (action === 'RESTORE' &&
            (old.shortageId !== shortageId ||
              old.expectedShortageVersion !== input.shortageVersion))
        )
          throw failure(409, 'IDEMPOTENCY_CONFLICT', '原缺货操作键的内容已改变');
        return { task: dto(t), duplicate: true };
      }
      if (t.version !== input.version || t.exceptionVersion !== input.exceptionVersion)
        throw failure(409, 'PICKING_VERSION_STALE', '演练或缺货记录已变化，请刷新后处理');
      if (t.exceptionVersion >= 100)
        throw failure(409, 'PICKING_EXCEPTION_LIMIT', '本任务演练记录已达上限，请使用新演练任务');
      if (t.state !== 'PICKING')
        throw failure(409, 'PICKING_NOT_OPEN', '仅已领取且未完成的任务可处理缺货');
      let sid = shortageId,
        lineId = input.lineId;
      if (action === 'REPORT') {
        if (t.exceptionVersion + t.shortages.filter((s) => s.state === 'OPEN').length + 2 > 100)
          throw failure(
            409,
            'PICKING_EXCEPTION_LIMIT',
            '本任务缺货演练已达上限，已预留未决记录处理空间',
          );
        if (t.ownerId !== actor.staffId)
          throw failure(403, 'PICKING_NOT_OWNER', '只能为本人领取的演练任务上报缺货');
        const line = fixture.find((l) => l.id === input.lineId)!;
        if (t.checkedLines.includes(line.id))
          throw failure(409, 'PICKING_LINE_CHECKED', '已核对明细不能再上报缺货');
        if (input.quantity > line.required)
          throw failure(409, 'PICKING_SHORTAGE_QUANTITY', '缺货数量不能超过原演练需求');
        if (t.shortages.some((s) => s.lineId === line.id && s.state === 'OPEN'))
          throw failure(409, 'PICKING_SHORTAGE_OPEN', '该明细已有未决缺货记录，请勿重复上报');
        sid = randomUUID();
        await tx.pickingLabShortage.create({
          data: {
            id: sid,
            taskId: id,
            lineId: line.id,
            missingQuantity: input.quantity,
            reason: input.reason!,
            reporterId: actor.staffId,
          },
        });
      } else {
        const s = t.shortages.find((s) => s.id === shortageId);
        if (!s) throw failure(404, 'PICKING_SHORTAGE_NOT_FOUND', '本任务缺货记录不存在');
        if (s.state !== 'OPEN' || s.version !== input.shortageVersion)
          throw failure(409, 'PICKING_SHORTAGE_STALE', '缺货记录已处理，请刷新查看');
        const line = fixture.find((l) => l.id === s.lineId)!;
        lineId = line.id;
        if (input.quantity !== line.required)
          throw failure(
            409,
            'PICKING_RESTORE_QUANTITY',
            '必须确认原需求已全部备齐，不能按部分数量解除阻断',
          );
        await tx.pickingLabShortage.update({
          where: { id: s.id },
          data: {
            state: 'RESOLVED',
            version: 1,
            resolverId: actor.staffId,
            resolvedAt: new Date(),
          },
        });
      }
      await tx.pickingLabShortageEvent.create({
        data: {
          id: randomUUID(),
          taskId: id,
          shortageId: sid!,
          actorId: actor.staffId,
          actorName: actor.displayName,
          key: input.key,
          action,
          lineId: lineId!,
          quantity: input.quantity,
          reason: input.reason,
          taskVersion: input.version,
          expectedRevision: input.exceptionVersion,
          expectedShortageVersion: input.shortageVersion,
          revision: t.exceptionVersion + 1,
        },
      });
      await tx.pickingLabTask.update({
        where: { id },
        data: { exceptionVersion: t.exceptionVersion + 1 },
      });
      await this.catalog.audit(tx, r, 'PICKING_LAB_' + action, id, w, null, {
        syntheticOnly: true,
        shortageId: sid!,
      });
      return {
        task: dto(await tx.pickingLabTask.findUniqueOrThrow({ where: { id }, include })),
        duplicate: false,
      };
    });
  }
}
const common = {
  key: { type: 'string' as const, format: 'uuid' },
  version: { type: 'integer' as const, minimum: 0, maximum: 3 },
  exceptionVersion: { type: 'integer' as const, minimum: 0, maximum: 100 },
};
function parse(q: unknown, body: unknown, restore = false) {
  const b = fields(q, ['warehouseId']),
    v = fields(body, [
      'key',
      'version',
      'exceptionVersion',
      ...(restore
        ? ['shortageVersion', 'confirmedQuantity']
        : ['lineId', 'missingQuantity', 'reason']),
    ]);
  if (
    !restore &&
    (typeof v.lineId !== 'string' ||
      !fixture.some((l) => l.id === v.lineId) ||
      !['MISSING', 'DAMAGED'].includes(v.reason as string))
  )
    throw failure(400, 'VALIDATION_ERROR', '缺货明细或原因无效');
  return {
    w: uuid(b.warehouseId),
    input: {
      key: uuid(v.key),
      version: integer(v.version, 0, 3),
      exceptionVersion: integer(v.exceptionVersion, 0, 100),
      quantity: integer(restore ? v.confirmedQuantity : v.missingQuantity, 1, 200),
      ...(restore
        ? { shortageVersion: integer(v.shortageVersion, 0, 1) }
        : { lineId: v.lineId as string, reason: v.reason as string }),
    },
  };
}
@ApiTags('拣货合成缺货隔离处理')
@ApiCookieAuth('staffSession')
@Controller('warehouse/picking-lab')
export class PickingShortageController {
  constructor(@Inject(PickingShortageService) readonly service: PickingShortageService) {}
  @Post(':id/shortages')
  @HttpCode(200)
  @Permissions('picking-lab.read', 'picking-lab.work')
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiParam({ name: 'id', type: String })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({
    schema: object({
      ...common,
      lineId: { type: 'string', enum: fixture.map((l) => l.id) },
      missingQuantity: { type: 'integer', minimum: 1, maximum: 2 },
      reason: { type: 'string', enum: ['MISSING', 'DAMAGED'] },
    }),
  })
  @ApiResult(
    object({ task: taskSchema, duplicate: { type: 'boolean' } }),
    [400, 401, 403, 404, 409, 503, 500],
  )
  async report(
    @Req() r: ApiRequest,
    @Query() q: unknown,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(q, body);
    return success(r, await this.service.act(r, b.w, uuid(id), 'REPORT', b.input));
  }
  @Post(':id/shortages/:shortageId/restore')
  @HttpCode(200)
  @Permissions('picking-lab.read', 'picking-lab.resolve')
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'shortageId', type: String })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({
    schema: object({
      ...common,
      shortageVersion: { type: 'integer', minimum: 0, maximum: 1 },
      confirmedQuantity: { type: 'integer', minimum: 1, maximum: 2 },
    }),
  })
  @ApiResult(
    object({ task: taskSchema, duplicate: { type: 'boolean' } }),
    [400, 401, 403, 404, 409, 503, 500],
  )
  async restore(
    @Req() r: ApiRequest,
    @Query() q: unknown,
    @Param('id') id: string,
    @Param('shortageId') sid: string,
    @Body() body: unknown,
  ) {
    const b = parse(q, body, true);
    return success(r, await this.service.act(r, b.w, uuid(id), 'RESTORE', b.input, uuid(sid)));
  }
}
