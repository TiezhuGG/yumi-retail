import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiHeader, ApiParam, ApiQuery, ApiTags } from '@nestjs/swagger';
import { Prisma } from '@yumi/database';
import type { DeliveryLabTask } from '@yumi/contracts';
import { CatalogService } from './catalog-service.js';
import { fields, uuid, integer } from './catalog-input.js';
import { Permissions } from './staff-guard.js';
import { failure, success, type ApiRequest } from './http.js';
import { object, text, strings, items, warehouseSchema, ApiResult } from './api-result.js';
const include = {
  pack: { include: { task: { include: { shortages: true } } } },
  assignment: {
    include: {
      exception: true,
      journeyFacts: true,
      handoff: true,
      rider: { include: { roles: true, warehouses: true } },
    },
  },
};
type Row = Prisma.PickingLabDispatchGetPayload<{ include: typeof include }>;
const manager = (r: ApiRequest) => r.staffContext!.permissions.includes('delivery-lab.assign');
const dto = (d: Row, enabled: boolean): DeliveryLabTask => {
  const a = d.assignment,
    t = d.pack.task;
  const blockers = [
    ...(!enabled ? ['LAB_DISABLED'] : []),
    ...(!a ? ['UNASSIGNED'] : []),
    ...(a && !a.rider.enabled ? ['RIDER_DISABLED'] : []),
    ...(a && !a.rider.roles.some((r) => r.roleCode === 'RIDER') ? ['RIDER_ROLE_REMOVED'] : []),
    ...(a && !a.rider.warehouses.some((w) => w.warehouseId === t.warehouseId)
      ? ['RIDER_WAREHOUSE_REMOVED']
      : []),
    ...(t.state !== 'CHECKED' ||
    t.version !== d.taskVersion ||
    t.exceptionVersion !== d.exceptionVersion ||
    t.shortages.some((s) => s.state === 'OPEN')
      ? ['PICKING_NOT_READY']
      : []),
  ];
  return {
    id: d.id,
    label: '合成配送 · ' + t.id.slice(-8),
    packageCount: d.pack.packageCount,
    dispatchedAt: d.createdAt.toISOString(),
    syntheticOnly: true,
    assignment: a
      ? {
          id: a.id,
          riderName: a.riderName,
          actorName: a.actorName,
          createdAt: a.createdAt.toISOString(),
        }
      : null,
    handoff: a?.handoff
      ? {
          id: a.handoff.id,
          packageCount: a.handoff.packageCount,
          createdAt: a.handoff.createdAt.toISOString(),
        }
      : null,
    journey: {
      start: a?.journeyFacts.find((f) => f.kind === 'START')
        ? {
            id: a.journeyFacts.find((f) => f.kind === 'START')!.id,
            createdAt: a.journeyFacts.find((f) => f.kind === 'START')!.createdAt.toISOString(),
          }
        : null,
      completion: a?.journeyFacts.find((f) => f.kind === 'COMPLETE')
        ? {
            id: a.journeyFacts.find((f) => f.kind === 'COMPLETE')!.id,
            createdAt: a.journeyFacts.find((f) => f.kind === 'COMPLETE')!.createdAt.toISOString(),
          }
        : null,
    },
    exception: a?.exception
      ? {
          id: a.exception.id,
          reason: a.exception.reason,
          createdAt: a.exception.createdAt.toISOString(),
        }
      : null,
    handoffReadiness: { ready: blockers.length === 0, blockers },
  };
};
const taskSchema = object({
  id: text,
  label: text,
  packageCount: { type: 'integer' },
  dispatchedAt: { type: 'string', format: 'date-time' },
  syntheticOnly: { type: 'boolean', enum: [true] },
  assignment: {
    ...object({
      id: text,
      riderName: text,
      actorName: text,
      createdAt: { type: 'string', format: 'date-time' },
    }),
    nullable: true,
  },
  handoff: {
    ...object({
      id: text,
      packageCount: { type: 'integer' },
      createdAt: { type: 'string', format: 'date-time' },
    }),
    nullable: true,
  },
  journey: object({
    start: {
      ...object({ id: text, createdAt: { type: 'string', format: 'date-time' } }),
      nullable: true,
    },
    completion: {
      ...object({ id: text, createdAt: { type: 'string', format: 'date-time' } }),
      nullable: true,
    },
  }),
  exception: {
    ...object({ id: text, reason: text, createdAt: { type: 'string', format: 'date-time' } }),
    nullable: true,
  },
  handoffReadiness: object({ ready: { type: 'boolean' }, blockers: strings }),
});
const listSchema = object({
  enabled: { type: 'boolean' },
  selfOnly: { type: 'boolean' },
  items: { type: 'array', items: taskSchema },
  nextCursor: { type: 'string', nullable: true },
});
export class DeliveryLabService {
  constructor(
    readonly catalog: CatalogService,
    readonly enabled = false,
  ) {}
  scope(r: ApiRequest, w: string): Prisma.PickingLabDispatchWhereInput {
    return {
      pack: { task: { warehouseId: w } },
      ...(!manager(r) ? { assignment: { riderId: r.staffContext!.staffId } } : {}),
    };
  }
  async list(r: ApiRequest, w: string, cursor?: string) {
    return this.catalog.db.$transaction(
      async (tx) => {
        await this.catalog.warehouse(tx, r, w);
        const where = this.scope(r, w);
        let anchor;
        if (cursor) {
          anchor = await tx.pickingLabDispatch.findFirst({ where: { ...where, id: cursor } });
          if (!anchor) throw failure(404, 'DELIVERY_LAB_NOT_FOUND', '合成配送任务不存在');
        }
        const rows = await tx.pickingLabDispatch.findMany({
          where: {
            AND: [
              where,
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
          include,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 21,
        });
        return {
          enabled: this.enabled,
          selfOnly: !manager(r),
          items: rows.slice(0, 20).map((d) => dto(d, this.enabled)),
          nextCursor: rows.length > 20 ? rows[19]!.id : null,
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  async detail(r: ApiRequest, w: string, id: string) {
    return this.catalog.db.$transaction(
      async (tx) => {
        await this.catalog.warehouse(tx, r, w);
        const d = await tx.pickingLabDispatch.findFirst({
          where: { ...this.scope(r, w), id },
          include,
        });
        if (!d) throw failure(404, 'DELIVERY_LAB_NOT_FOUND', '合成配送任务不存在');
        return { enabled: this.enabled, task: dto(d, this.enabled) };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }
  async riders(r: ApiRequest, w: string) {
    return this.catalog.db.$transaction(async (tx) => {
      await this.catalog.warehouse(tx, r, w);
      return {
        items: await tx.staff.findMany({
          where: {
            enabled: true,
            roles: { some: { roleCode: 'RIDER' } },
            warehouses: { some: { warehouseId: w } },
          },
          select: { id: true, displayName: true },
          orderBy: [{ displayName: 'asc' }, { id: 'asc' }],
        }),
      };
    });
  }
  async report(r: ApiRequest, w: string, id: string, key: string, reason: string) {
    if (!this.enabled) throw failure(503, 'PICKING_LAB_DISABLED', '本机配送演练写入尚未开启');
    return this.catalog.db.$transaction(async (tx) => {
      await this.catalog.warehouse(tx, r, w);
      await tx.$queryRaw`SELECT t.id FROM picking_lab_tasks t JOIN picking_lab_packs p ON p.task_id=t.id JOIN picking_lab_dispatches d ON d.pack_id=p.id WHERE d.id=${id}::uuid AND t.warehouse_id=${w}::uuid FOR UPDATE OF t`;
      const d = await tx.pickingLabDispatch.findFirst({
        where: {
          id,
          pack: { task: { warehouseId: w } },
          assignment: { riderId: r.staffContext!.staffId },
        },
        include,
      });
      if (!d || !d.assignment)
        throw failure(404, 'DELIVERY_LAB_NOT_FOUND', '本人合成配送任务不存在');
      const h = d.assignment.exception;
      if (h) {
        if (h.key !== key)
          throw failure(409, 'DELIVERY_STAGE_ALREADY_RECORDED', '此合成阶段已记录，不能重复提交');
        if (h.reason !== reason) throw failure(409, 'IDEMPOTENCY_CONFLICT', '原异常类型已改变');
        return { task: dto(d, this.enabled), duplicate: true };
      }
      // Lock current qualifications before re-reading them; revocation serializes with this receipt.
      const people = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM staff WHERE id=${d.assignment.riderId}::uuid AND enabled FOR SHARE`;
      const roles = await tx.$queryRaw<
        { staff_id: string }[]
      >`SELECT staff_id FROM staff_roles WHERE staff_id=${d.assignment.riderId}::uuid AND role_code='RIDER' FOR SHARE`;
      const scopes = await tx.$queryRaw<
        { staff_id: string }[]
      >`SELECT staff_id FROM staff_warehouses WHERE staff_id=${d.assignment.riderId}::uuid AND warehouse_id=${w}::uuid FOR SHARE`;
      if (
        !people.length ||
        !roles.length ||
        !scopes.length ||
        !dto(d, this.enabled).handoffReadiness.ready
      )
        throw failure(409, 'DELIVERY_NOT_READY', '当前骑手或任务不满足接货资格');
      if (!d.assignment.handoff || d.assignment.journeyFacts.some((f) => f.kind === 'COMPLETE'))
        throw failure(409, 'DELIVERY_EXCEPTION_NOT_READY', '需已接货且尚未合成送达');
      await tx.deliveryLabException.create({
        data: { id: randomUUID(), assignmentId: d.assignment.id, key, reason },
      });
      await this.catalog.audit(tx, r, 'DELIVERY_LAB_EXCEPTION', id, w, null, {
        syntheticOnly: true,
        reason,
      });
      return {
        task: dto(
          await tx.pickingLabDispatch.findUniqueOrThrow({ where: { id }, include }),
          this.enabled,
        ),
        duplicate: false,
      };
    });
  }
  async progress(r: ApiRequest, w: string, id: string, key: string, kind: 'START' | 'COMPLETE') {
    if (!this.enabled) throw failure(503, 'PICKING_LAB_DISABLED', '本机配送演练写入尚未开启');
    return this.catalog.db.$transaction(async (tx) => {
      await this.catalog.warehouse(tx, r, w);
      await tx.$queryRaw`SELECT t.id FROM picking_lab_tasks t JOIN picking_lab_packs p ON p.task_id=t.id JOIN picking_lab_dispatches d ON d.pack_id=p.id WHERE d.id=${id}::uuid AND t.warehouse_id=${w}::uuid FOR UPDATE OF t`;
      const d = await tx.pickingLabDispatch.findFirst({
        where: {
          id,
          pack: { task: { warehouseId: w } },
          assignment: { riderId: r.staffContext!.staffId },
        },
        include,
      });
      if (!d || !d.assignment)
        throw failure(404, 'DELIVERY_LAB_NOT_FOUND', '本人合成配送任务不存在');
      const h = d.assignment.journeyFacts.find((f) => f.kind === kind);
      if (h) {
        if (h.key !== key)
          throw failure(409, 'DELIVERY_STAGE_ALREADY_RECORDED', '此合成阶段已记录，不能重复提交');
        return { task: dto(d, this.enabled), duplicate: true };
      }
      // Lock current qualifications before re-reading them; revocation serializes with this receipt.
      const people = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM staff WHERE id=${d.assignment.riderId}::uuid AND enabled FOR SHARE`;
      const roles = await tx.$queryRaw<
        { staff_id: string }[]
      >`SELECT staff_id FROM staff_roles WHERE staff_id=${d.assignment.riderId}::uuid AND role_code='RIDER' FOR SHARE`;
      const scopes = await tx.$queryRaw<
        { staff_id: string }[]
      >`SELECT staff_id FROM staff_warehouses WHERE staff_id=${d.assignment.riderId}::uuid AND warehouse_id=${w}::uuid FOR SHARE`;
      if (
        !people.length ||
        !roles.length ||
        !scopes.length ||
        !dto(d, this.enabled).handoffReadiness.ready
      )
        throw failure(409, 'DELIVERY_NOT_READY', '当前骑手或任务不满足接货资格');
      if (
        !d.assignment.handoff ||
        (kind === 'COMPLETE' && !d.assignment.journeyFacts.some((f) => f.kind === 'START'))
      )
        throw failure(409, 'DELIVERY_STAGE_NOT_READY', '请先完成合成接货及开始配送');
      if (d.assignment.exception)
        throw failure(409, 'DELIVERY_EXCEPTION_OPEN', '合成异常尚未处理，禁止继续配送阶段');
      await tx.deliveryLabJourneyFact.create({
        data: { id: randomUUID(), assignmentId: d.assignment.id, key, kind },
      });
      await this.catalog.audit(
        tx,
        r,
        kind === 'START' ? 'DELIVERY_LAB_START' : 'DELIVERY_LAB_COMPLETE',
        id,
        w,
        null,
        { syntheticOnly: true },
      );
      return {
        task: dto(
          await tx.pickingLabDispatch.findUniqueOrThrow({ where: { id }, include }),
          this.enabled,
        ),
        duplicate: false,
      };
    });
  }
  async accept(r: ApiRequest, w: string, id: string, key: string, packageCount: number) {
    if (!this.enabled) throw failure(503, 'PICKING_LAB_DISABLED', '本机配送演练写入尚未开启');
    return this.catalog.db.$transaction(async (tx) => {
      await this.catalog.warehouse(tx, r, w);
      await tx.$queryRaw`SELECT t.id FROM picking_lab_tasks t JOIN picking_lab_packs p ON p.task_id=t.id JOIN picking_lab_dispatches d ON d.pack_id=p.id WHERE d.id=${id}::uuid AND t.warehouse_id=${w}::uuid FOR UPDATE OF t`;
      const d = await tx.pickingLabDispatch.findFirst({
        where: {
          id,
          pack: { task: { warehouseId: w } },
          assignment: { riderId: r.staffContext!.staffId },
        },
        include,
      });
      if (!d || !d.assignment)
        throw failure(404, 'DELIVERY_LAB_NOT_FOUND', '本人合成配送任务不存在');
      const h = d.assignment.handoff;
      if (h) {
        if (h.key !== key)
          throw failure(409, 'DELIVERY_ALREADY_ACCEPTED', '已经接货，不能重复交接');
        if (h.packageCount !== packageCount)
          throw failure(409, 'IDEMPOTENCY_CONFLICT', '原接货数量已改变');
        return { task: dto(d, this.enabled), duplicate: true };
      }
      // Lock current qualifications before re-reading them; revocation serializes with this receipt.
      const people = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM staff WHERE id=${d.assignment.riderId}::uuid AND enabled FOR SHARE`;
      const roles = await tx.$queryRaw<
        { staff_id: string }[]
      >`SELECT staff_id FROM staff_roles WHERE staff_id=${d.assignment.riderId}::uuid AND role_code='RIDER' FOR SHARE`;
      const scopes = await tx.$queryRaw<
        { staff_id: string }[]
      >`SELECT staff_id FROM staff_warehouses WHERE staff_id=${d.assignment.riderId}::uuid AND warehouse_id=${w}::uuid FOR SHARE`;
      if (
        !people.length ||
        !roles.length ||
        !scopes.length ||
        !dto(d, this.enabled).handoffReadiness.ready
      )
        throw failure(409, 'DELIVERY_NOT_READY', '当前骑手或任务不满足接货资格');
      if (packageCount !== d.pack.packageCount)
        throw failure(409, 'PACKAGE_COUNT_MISMATCH', '核对包裹数必须与合成出库凭据一致');
      await tx.deliveryLabHandoff.create({
        data: { id: randomUUID(), assignmentId: d.assignment.id, key, packageCount },
      });
      await this.catalog.audit(tx, r, 'DELIVERY_LAB_ACCEPT', id, w, null, {
        syntheticOnly: true,
        packageCount,
      });
      return {
        task: dto(
          await tx.pickingLabDispatch.findUniqueOrThrow({ where: { id }, include }),
          this.enabled,
        ),
        duplicate: false,
      };
    });
  }
  async assign(r: ApiRequest, w: string, id: string, key: string, riderId: string) {
    if (!this.enabled) throw failure(503, 'PICKING_LAB_DISABLED', '本机配送演练写入尚未开启');
    return this.catalog.db.$transaction(async (tx) => {
      await this.catalog.warehouse(tx, r, w);
      await tx.$queryRaw`SELECT t.id FROM picking_lab_tasks t JOIN picking_lab_packs p ON p.task_id=t.id JOIN picking_lab_dispatches d ON d.pack_id=p.id WHERE d.id=${id}::uuid AND t.warehouse_id=${w}::uuid FOR UPDATE OF t`;
      const d = await tx.pickingLabDispatch.findFirst({
        where: { id, pack: { task: { warehouseId: w } } },
        include,
      });
      if (!d) throw failure(404, 'DELIVERY_LAB_NOT_FOUND', '合成配送任务不存在或尚未出库');
      if (d.assignment) {
        if (d.assignment.actorId === r.staffContext!.staffId && d.assignment.key === key) {
          if (d.assignment.riderId !== riderId)
            throw failure(409, 'IDEMPOTENCY_CONFLICT', '原分配操作的骑手已改变');
          return { task: dto(d, this.enabled), duplicate: true };
        }
        throw failure(409, 'DELIVERY_ALREADY_ASSIGNED', '本任务已有分配凭据，不能重复或覆盖');
      }
      const checks = dto(d, this.enabled);
      if (checks.handoffReadiness.blockers.some((b) => b !== 'UNASSIGNED'))
        throw failure(409, 'DELIVERY_NOT_READY', '当前合成任务不满足分配资格');
      // Shared locks serialize account/role/scope revocation with committing assignment.
      const people = await tx.$queryRaw<
        { display_name: string }[]
      >`SELECT display_name FROM staff WHERE id=${riderId}::uuid AND enabled FOR SHARE`;
      const roles = await tx.$queryRaw<
        { staff_id: string }[]
      >`SELECT staff_id FROM staff_roles WHERE staff_id=${riderId}::uuid AND role_code='RIDER' FOR SHARE`;
      const warehouses = await tx.$queryRaw<
        { staff_id: string }[]
      >`SELECT staff_id FROM staff_warehouses WHERE staff_id=${riderId}::uuid AND warehouse_id=${w}::uuid FOR SHARE`;
      if (!people.length || !roles.length || !warehouses.length)
        throw failure(409, 'RIDER_INELIGIBLE', '请选择本仓启用且具备骑手角色的人员');
      await tx.deliveryLabAssignment.create({
        data: {
          id: randomUUID(),
          dispatchId: id,
          riderId,
          riderName: people[0]!.display_name,
          actorId: r.staffContext!.staffId,
          actorName: r.staffContext!.displayName,
          key,
        },
      });
      await this.catalog.audit(tx, r, 'DELIVERY_LAB_ASSIGN', id, w, null, { syntheticOnly: true });
      return {
        task: dto(
          await tx.pickingLabDispatch.findUniqueOrThrow({ where: { id }, include }),
          this.enabled,
        ),
        duplicate: false,
      };
    });
  }
}
function query(q: unknown, extra: string[] = []) {
  const b = fields(q, ['warehouseId', ...extra]);
  return { w: uuid(b.warehouseId), cursor: b.cursor === undefined ? undefined : uuid(b.cursor) };
}
@ApiTags('合成配送分配与交接资格')
@ApiCookieAuth('staffSession')
@Permissions('delivery-lab.read')
@Controller('delivery-lab')
export class DeliveryLabController {
  constructor(@Inject(DeliveryLabService) readonly service: DeliveryLabService) {}
  @Get('warehouses')
  @ApiResult(items(warehouseSchema))
  async warehouses(@Req() r: ApiRequest, @Query() q: unknown) {
    fields(q, []);
    return success(r, {
      items: await this.service.catalog.db.warehouse.findMany({
        where: { id: { in: r.staffContext!.warehouseIds }, enabled: true },
        select: { id: true, code: true, name: true },
        orderBy: { code: 'asc' },
      }),
    });
  }
  @Get('riders')
  @Permissions('delivery-lab.read', 'delivery-lab.assign')
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiResult(items(object({ id: text, displayName: text })), [400, 401, 403, 500])
  async riders(@Req() r: ApiRequest, @Query() q: unknown) {
    return success(r, await this.service.riders(r, query(q).w));
  }
  @Get()
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiResult(listSchema, [400, 401, 403, 404, 500])
  async list(@Req() r: ApiRequest, @Query() q: unknown) {
    const v = query(q, ['cursor']);
    return success(r, await this.service.list(r, v.w, v.cursor));
  }
  @Get(':id')
  @ApiParam({ name: 'id', type: String })
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiResult(object({ enabled: { type: 'boolean' }, task: taskSchema }), [400, 401, 403, 404, 500])
  async detail(@Req() r: ApiRequest, @Query() q: unknown, @Param('id') id: string) {
    return success(r, await this.service.detail(r, query(q).w, uuid(id)));
  }
  @Post(':id/report-exception')
  @HttpCode(200)
  @Permissions('delivery-lab.read', 'delivery-lab.work')
  @ApiParam({ name: 'id', type: String })
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({
    schema: object({
      key: { type: 'string', format: 'uuid' },
      reason: { type: 'string', enum: ['UNREACHABLE', 'REFUSED', 'DAMAGED'] },
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
    const b = fields(body, ['key', 'reason']);
    if (typeof b.reason !== 'string' || !['UNREACHABLE', 'REFUSED', 'DAMAGED'].includes(b.reason))
      throw failure(400, 'VALIDATION_ERROR', '请选择合成异常类型');
    return success(r, await this.service.report(r, query(q).w, uuid(id), uuid(b.key), b.reason));
  }
  @Post(':id/start')
  @HttpCode(200)
  @Permissions('delivery-lab.read', 'delivery-lab.work')
  @ApiParam({ name: 'id', type: String })
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({ schema: object({ key: { type: 'string', format: 'uuid' } }) })
  @ApiResult(
    object({ task: taskSchema, duplicate: { type: 'boolean' } }),
    [400, 401, 403, 404, 409, 503, 500],
  )
  async start(
    @Req() r: ApiRequest,
    @Query() q: unknown,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = fields(body, ['key']);
    return success(r, await this.service.progress(r, query(q).w, uuid(id), uuid(b.key), 'START'));
  }
  @Post(':id/complete')
  @HttpCode(200)
  @Permissions('delivery-lab.read', 'delivery-lab.work')
  @ApiParam({ name: 'id', type: String })
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({ schema: object({ key: { type: 'string', format: 'uuid' } }) })
  @ApiResult(
    object({ task: taskSchema, duplicate: { type: 'boolean' } }),
    [400, 401, 403, 404, 409, 503, 500],
  )
  async complete(
    @Req() r: ApiRequest,
    @Query() q: unknown,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = fields(body, ['key']);
    return success(
      r,
      await this.service.progress(r, query(q).w, uuid(id), uuid(b.key), 'COMPLETE'),
    );
  }
  @Post(':id/accept')
  @HttpCode(200)
  @Permissions('delivery-lab.read', 'delivery-lab.accept')
  @ApiParam({ name: 'id', type: String })
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({
    schema: object({
      key: { type: 'string', format: 'uuid' },
      packageCount: { type: 'integer', minimum: 1, maximum: 100 },
    }),
  })
  @ApiResult(
    object({ task: taskSchema, duplicate: { type: 'boolean' } }),
    [400, 401, 403, 404, 409, 503, 500],
  )
  async accept(
    @Req() r: ApiRequest,
    @Query() q: unknown,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = fields(body, ['key', 'packageCount']);
    return success(
      r,
      await this.service.accept(
        r,
        query(q).w,
        uuid(id),
        uuid(b.key),
        integer(b.packageCount, 1, 100),
      ),
    );
  }
  @Post(':id/assign')
  @HttpCode(200)
  @Permissions('delivery-lab.read', 'delivery-lab.assign')
  @ApiParam({ name: 'id', type: String })
  @ApiQuery({ name: 'warehouseId', required: true, type: String })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({
    schema: object({
      key: { type: 'string', format: 'uuid' },
      riderId: { type: 'string', format: 'uuid' },
    }),
  })
  @ApiResult(
    object({ task: taskSchema, duplicate: { type: 'boolean' } }),
    [400, 401, 403, 404, 409, 503, 500],
  )
  async assign(
    @Req() r: ApiRequest,
    @Query() q: unknown,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const b = fields(body, ['key', 'riderId']);
    return success(
      r,
      await this.service.assign(r, query(q).w, uuid(id), uuid(b.key), uuid(b.riderId)),
    );
  }
}
