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
  packId?: string;
  packageCount?: number;
  singleQuantity?: number;
  tripleQuantity?: number;
};
export class PickingPackingService {
  constructor(
    readonly catalog: CatalogService,
    readonly enabled = false,
  ) {}
  async act(r: ApiRequest, w: string, id: string, action: 'PACK' | 'DISPATCH', input: Input) {
    if (!this.enabled) throw failure(503, 'PICKING_LAB_DISABLED', '本机拣货演练写入尚未开启');
    return this.catalog.db.$transaction(async (tx) => {
      await this.catalog.warehouse(tx, r, w);
      await tx.$queryRaw`SELECT id FROM picking_lab_tasks WHERE id=${id}::uuid AND warehouse_id=${w}::uuid FOR UPDATE`;
      const t = await tx.pickingLabTask.findFirst({ where: { id, warehouseId: w }, include });
      if (!t) throw failure(404, 'PICKING_LAB_NOT_FOUND', '演练任务不存在');
      const actor = r.staffContext!,
        old = action === 'PACK' ? t.pack : t.pack?.dispatch;
      if (old) {
        if (old.key === input.key && old.actorId === actor.staffId) {
          if (
            old.taskVersion !== input.version ||
            old.exceptionVersion !== input.exceptionVersion ||
            (action === 'PACK' &&
              (t.pack!.packageCount !== input.packageCount ||
                t.pack!.singleQuantity !== input.singleQuantity ||
                t.pack!.tripleQuantity !== input.tripleQuantity)) ||
            (action === 'DISPATCH' && t.pack!.id !== input.packId)
          )
            throw failure(409, 'IDEMPOTENCY_CONFLICT', '原打包/出库操作键的内容已改变');
          return { task: dto(t), duplicate: true };
        }
        throw failure(
          409,
          'PICKING_STAGE_RECORDED',
          action === 'PACK'
            ? '本任务已有合成打包记录，不能重复打包'
            : '本任务已有合成出库记录，不能重复出库',
        );
      }
      if (t.version !== input.version || t.exceptionVersion !== input.exceptionVersion)
        throw failure(409, 'PICKING_VERSION_STALE', '核对或缺货快照已变化，请刷新后处理');
      if (t.state !== 'CHECKED' || !fixture.every((l) => t.checkedLines.includes(l.id)))
        throw failure(409, 'PICKING_INCOMPLETE', '全部演练明细完成核对后才能打包/出库');
      if (t.shortages.some((s) => s.state === 'OPEN'))
        throw failure(409, 'PICKING_SHORTAGE_OPEN', '有未决缺货记录，不能打包/出库');
      if (action === 'PACK') {
        if (t.ownerId !== actor.staffId)
          throw failure(403, 'PICKING_NOT_OWNER', '只有领取人可记录合成打包');
        if (input.singleQuantity !== 2 || input.tripleQuantity !== 1)
          throw failure(409, 'PICKING_PACK_QUANTITY', '打包数量必须与原演练需求逐行一致');
        await tx.pickingLabPack.create({
          data: {
            id: randomUUID(),
            taskId: id,
            actorId: actor.staffId,
            actorName: actor.displayName,
            key: input.key,
            taskVersion: input.version,
            exceptionVersion: input.exceptionVersion,
            packageCount: input.packageCount!,
            singleQuantity: input.singleQuantity!,
            tripleQuantity: input.tripleQuantity!,
          },
        });
      } else {
        if (!t.pack) throw failure(409, 'PICKING_PACK_REQUIRED', '尚无合成打包记录，不能确认出库');
        if (t.pack.id !== input.packId)
          throw failure(409, 'PICKING_PACK_MISMATCH', '打包记录不属于当前任务');
        if (t.pack.taskVersion !== t.version || t.pack.exceptionVersion !== t.exceptionVersion)
          throw failure(409, 'PICKING_PACK_STALE', '打包快照不再匹配当前任务');
        await tx.pickingLabDispatch.create({
          data: {
            id: randomUUID(),
            taskId: id,
            packId: t.pack.id,
            actorId: actor.staffId,
            actorName: actor.displayName,
            key: input.key,
            taskVersion: input.version,
            exceptionVersion: input.exceptionVersion,
          },
        });
      }
      await this.catalog.audit(tx, r, 'PICKING_LAB_' + action, id, w, null, {
        syntheticOnly: true,
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
function parse(q: unknown, body: unknown, dispatch = false) {
  const b = fields(q, ['warehouseId']),
    v = fields(body, [
      'key',
      'version',
      'exceptionVersion',
      ...(dispatch ? ['packId'] : ['packageCount', 'singleQuantity', 'tripleQuantity']),
    ]);
  return {
    w: uuid(b.warehouseId),
    input: {
      key: uuid(v.key),
      version: integer(v.version, 0, 3),
      exceptionVersion: integer(v.exceptionVersion, 0, 100),
      ...(dispatch
        ? { packId: uuid(v.packId) }
        : {
            packageCount: integer(v.packageCount, 1, 20),
            singleQuantity: integer(v.singleQuantity, 0, 200),
            tripleQuantity: integer(v.tripleQuantity, 0, 200),
          }),
    },
  };
}
@ApiTags('合成打包及一次性出库')
@ApiCookieAuth('staffSession')
@Controller('warehouse/picking-lab')
export class PickingPackingController {
  constructor(@Inject(PickingPackingService) readonly service: PickingPackingService) {}
  @Post(':id/pack')
  @HttpCode(200)
  @Permissions('picking-lab.read', 'picking-lab.work')
  @ApiParam({ name: 'id', type: String })
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({
    schema: object({
      ...common,
      packageCount: { type: 'integer', minimum: 1, maximum: 20 },
      singleQuantity: { type: 'integer', minimum: 0, maximum: 200 },
      tripleQuantity: { type: 'integer', minimum: 0, maximum: 200 },
    }),
  })
  @ApiResult(
    object({ task: taskSchema, duplicate: { type: 'boolean' } }),
    [400, 401, 403, 404, 409, 503, 500],
  )
  async pack(
    @Req() r: ApiRequest,
    @Query() q: unknown,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(q, body);
    return success(r, await this.service.act(r, b.w, uuid(id), 'PACK', b.input));
  }
  @Post(':id/dispatch')
  @HttpCode(200)
  @Permissions('picking-lab.read', 'picking-lab.ship')
  @ApiParam({ name: 'id', type: String })
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({ schema: object({ ...common, packId: { type: 'string', format: 'uuid' } }) })
  @ApiResult(
    object({ task: taskSchema, duplicate: { type: 'boolean' } }),
    [400, 401, 403, 404, 409, 503, 500],
  )
  async dispatch(
    @Req() r: ApiRequest,
    @Query() q: unknown,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = parse(q, body, true);
    return success(r, await this.service.act(r, b.w, uuid(id), 'DISPATCH', b.input));
  }
}
