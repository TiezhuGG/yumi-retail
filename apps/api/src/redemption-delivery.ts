import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiHeader, ApiQuery, ApiTags } from '@nestjs/swagger';
import {
  inventoryLocks,
  metadataLocks,
  redemptionPickingReadiness,
  type Prisma,
} from '@yumi/database';
import type { ConsumerOrderAddress, RedemptionDeliveryView } from '@yumi/contracts';
import { CatalogService } from './catalog-service.js';
import { OrderPrivateData } from './order-private.js';
import { fields, integer, key, str, uuid } from './catalog-input.js';
import { Permissions } from './staff-guard.js';
import { failure, success, type ApiRequest } from './http.js';
import { object, text, ApiResult } from './api-result.js';
type Tx = Prisma.TransactionClient;
const include = {
  assignment: { include: { handoff: { include: { lines: true, journey: true } } } },
  pack: { include: { task: true, lines: true } },
} as const;
export class RedemptionDeliveryService {
  readonly privateData: OrderPrivateData;
  constructor(
    readonly catalog: CatalogService,
    readonly enabled = false,
    hex?: string,
  ) {
    this.privateData = new OrderPrivateData(hex);
  }
  async authorize(tx: Tx, r: ApiRequest, w: string, manage = false) {
    const c = r.staffContext!;
    const rows = await tx.$queryRaw<
      Array<{ role_code: string }>
    >`SELECT role.role_code FROM staff s JOIN staff_sessions sess ON sess.staff_id=s.id JOIN staff_warehouses sw ON sw.staff_id=s.id JOIN staff_roles role ON role.staff_id=s.id WHERE s.id=${c.staffId}::uuid AND sess.id=${c.sessionId}::uuid AND sess.revoked_at IS NULL AND sess.auth_version=s.auth_version AND sess.expires_at>clock_timestamp() AND s.enabled AND sw.warehouse_id=${w}::uuid AND role.role_code IN ('SUPER_ADMIN','WAREHOUSE_MANAGER','RIDER') AND (NOT ${manage} OR role.role_code IN ('SUPER_ADMIN','WAREHOUSE_MANAGER')) FOR SHARE OF s,sess,sw,role`;
    if (!rows.length) throw failure(403, 'FORBIDDEN', '当前账号无本仓兑换交接权限');
    await this.catalog.warehouse(tx, r, w);
    return rows.some((v) => v.role_code === 'SUPER_ADMIN' || v.role_code === 'WAREHOUSE_MANAGER');
  }
  async person(tx: Tx, id: string, w: string, manager = false) {
    const rows = await tx.$queryRaw<
      Array<{ display_name: string }>
    >`SELECT s.display_name FROM staff s JOIN staff_roles role ON role.staff_id=s.id JOIN staff_warehouses sw ON sw.staff_id=s.id WHERE s.id=${id}::uuid AND s.enabled AND sw.warehouse_id=${w}::uuid AND ((NOT ${manager} AND role.role_code='RIDER') OR (${manager} AND role.role_code IN ('SUPER_ADMIN','WAREHOUSE_MANAGER'))) FOR SHARE OF s,role,sw`;
    return rows[0]?.display_name ?? null;
  }
  async source(tx: Tx, w: string, id: string, self?: string) {
    const sh = await tx.redemptionShipment.findFirst({
      where: {
        id,
        pack: { task: { warehouseId: w } },
        ...(self ? { assignment: { riderId: self } } : {}),
      },
      include,
    });
    if (!sh) throw failure(404, 'REDEMPTION_DELIVERY_NOT_FOUND', '未找到授权范围内的兑换交接单');
    const readiness = await redemptionPickingReadiness(tx, sh.orderId),
      o = readiness.order;
    if (!o) throw failure(404, 'REDEMPTION_DELIVERY_NOT_FOUND', '原兑换单不存在');
    return { sh, o, blockers: readiness.blockers };
  }
  async view(
    tx: Tx,
    w: string,
    id: string,
    self?: string,
    detail = false,
  ): Promise<RedemptionDeliveryView> {
    const { sh, o, blockers } = await this.source(tx, w, id, self),
      a = sh.assignment,
      start = a?.handoff?.journey.find((f) => f.kind === 'START'),
      completion = a?.handoff?.journey.find((f) => f.kind === 'COMPLETE');
    if (
      o.status !== 'ACTIVE' ||
      o.pickingTask?.state !== 'CHECKED' ||
      o.allocations.some((l) => !l.consumeLedgerId || l.releaseLedgerId)
    )
      blockers.push('SHIPMENT_UNVERIFIED');
    if (a) {
      if (!(await this.person(tx, a.riderId, w))) blockers.push('RIDER_UNAVAILABLE');
      if (!(await this.person(tx, a.actorId, w, true))) blockers.push('ASSIGNER_UNAVAILABLE');
    }
    return {
      id: sh.id,
      orderNo: o.orderNo,
      title: o.title,
      spec: o.spec,
      quantity: o.quantity,
      packageCount: sh.pack.packageCount,
      shippedAt: sh.createdAt.toISOString(),
      state: completion
        ? 'DELIVERED'
        : start
          ? 'DELIVERING'
          : a?.handoff
            ? 'HANDED_OVER'
            : a
              ? 'ASSIGNED'
              : 'UNASSIGNED',
      journey: {
        start: start ? { id: start.id, createdAt: start.createdAt.toISOString() } : null,
        completion: completion
          ? { id: completion.id, createdAt: completion.createdAt.toISOString() }
          : null,
      },
      canStart: !blockers.length && !!a?.handoff && !start,
      canComplete: !blockers.length && !!start && !completion,
      assignment: a
        ? {
            id: a.id,
            riderId: a.riderId,
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
      readiness: { ready: !blockers.length && !a?.handoff, blockers: [...new Set(blockers)] },
      lines: sh.pack.lines.map((l) => {
        const al = o.allocations.find((a) => a.id === l.allocationId)!;
        return {
          allocationId: l.allocationId,
          quantity: l.quantity,
          batchNo: al.position.lot.batchNo,
          locationName: al.position.location.name,
          locationCode: al.position.location.code,
          expiresAt: al.position.lot.expiresAt?.toISOString() ?? null,
        };
      }),
      ...(detail
        ? {
            address: this.privateData.decrypt<ConsumerOrderAddress>(
              o.userId,
              o.id,
              o.addressPayload,
            ),
          }
        : {}),
    };
  }
  async read(r: ApiRequest, w: string, input: unknown, id?: string) {
    const q = fields(input, ['cursor', 'status']),
      cursor = q.cursor === undefined ? null : uuid(q.cursor),
      status = q.status === undefined ? '' : str(q.status, 20);
    if (
      status &&
      !['UNASSIGNED', 'ASSIGNED', 'HANDED_OVER', 'DELIVERING', 'DELIVERED'].includes(status)
    )
      throw failure(400, 'VALIDATION_ERROR', '交接状态筛选无效');
    return this.catalog.db.$transaction(
      async (tx) => {
        const manager = await this.authorize(tx, r, w),
          self = manager ? undefined : r.staffContext!.staffId;
        const where: Prisma.RedemptionShipmentWhereInput = {
          pack: { task: { warehouseId: w } },
          ...(self ? { assignment: { riderId: self } } : {}),
          ...(status === 'UNASSIGNED'
            ? { assignment: null }
            : status
              ? {
                  assignment: {
                    ...(self ? { riderId: self } : {}),
                    handoff:
                      status === 'ASSIGNED'
                        ? null
                        : {
                            is: {
                              journey:
                                status === 'HANDED_OVER'
                                  ? { none: { kind: 'START' } }
                                  : status === 'DELIVERING'
                                    ? { some: { kind: 'START' }, none: { kind: 'COMPLETE' } }
                                    : { some: { kind: 'COMPLETE' } },
                            },
                          },
                  },
                }
              : {}),
        };
        // Keep the self scope even for UNASSIGNED; a rider can never query the unassigned pool.
        const scoped: Prisma.RedemptionShipmentWhereInput = {
          AND: [where, ...(self ? [{ assignment: { riderId: self } }] : [])],
        };
        if (
          cursor &&
          !(await tx.redemptionShipment.findFirst({ where: { ...scoped, id: cursor } }))
        )
          throw failure(409, 'CURSOR_INVALID', '分页位置已变化，请重新查询');
        const rows = await tx.redemptionShipment.findMany({
          where: { ...scoped, ...(id ? { id } : cursor ? { id: { gt: cursor } } : {}) },
          orderBy: { id: 'asc' },
          select: { id: true },
          take: 21,
        });
        if (id && !rows.length)
          throw failure(404, 'REDEMPTION_DELIVERY_NOT_FOUND', '未找到授权范围内的兑换交接单');
        const items = [];
        for (const row of rows.slice(0, 20)) items.push(await this.view(tx, w, row.id, self, !!id));
        await this.authorize(tx, r, w);
        return {
          enabled: this.enabled,
          selfOnly: !manager,
          items,
          nextCursor: rows.length > 20 ? items.at(-1)!.id : null,
        };
      },
      { isolationLevel: 'RepeatableRead', timeout: 15000 },
    );
  }
  async riders(r: ApiRequest, w: string) {
    return this.catalog.db.$transaction(async (tx) => {
      await this.authorize(tx, r, w, true);
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
  async progress(
    r: ApiRequest,
    w: string,
    id: string,
    action: 'start' | 'complete',
    k: string,
    input: unknown,
  ) {
    const b = fields(
      input,
      action === 'start' ? ['handoffId', 'departureConfirmed'] : ['startId', 'deliveryConfirmed'],
    );
    const sourceId = uuid(action === 'start' ? b.handoffId : b.startId),
      riderId = r.staffContext!.staffId;
    if ((action === 'start' ? b.departureConfirmed : b.deliveryConfirmed) !== true)
      throw failure(
        400,
        'PHYSICAL_CONFIRMATION_REQUIRED',
        '须由骑手本人确认实际出发或全部包裹已交付原收货人',
      );
    await this.authorize(this.catalog.db, r, w);
    if (!(await this.person(this.catalog.db, riderId, w)))
      throw failure(403, 'FORBIDDEN', '仅当前有效骑手本人可操作');
    await this.source(this.catalog.db, w, id, riderId);
    if (!this.enabled) throw failure(503, 'REDEMPTION_DELIVERY_DISABLED', '兑换配送写入尚未启用');
    return this.catalog.write(
      r,
      'REDEMPTION_DELIVERY_' + action,
      w + ':' + id,
      k,
      { sourceId, confirmed: true },
      async (tx) => {
        await this.authorize(tx, r, w);
        const initial = await this.source(tx, w, id, riderId);
        if (
          !(await this.person(tx, riderId, w)) ||
          !(await this.person(tx, initial.sh.assignment!.actorId, w, true))
        )
          throw failure(409, 'DELIVERY_PERSON_UNAVAILABLE', '骑手或原分配人权限已变化，请核查');
        await metadataLocks(tx, [initial.o.skuId]);
        await inventoryLocks(tx, w, [initial.o.skuId]);
        await tx.$queryRaw`SELECT id FROM redemption_orders WHERE id=${initial.o.id}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM redemption_picking_tasks WHERE order_id=${initial.o.id}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM redemption_shipments WHERE id=${id}::uuid FOR UPDATE`;
        const { sh } = await this.source(tx, w, id, riderId),
          v = await this.view(tx, w, id, riderId);
        const h = sh.assignment?.handoff;
        if (!h || (action === 'complete' && !v.journey.start))
          throw failure(409, 'JOURNEY_SEQUENCE_REQUIRED', '须先由本人接货并按顺序开始配送');
        if (sourceId !== (action === 'start' ? h.id : v.journey.start!.id))
          throw failure(409, 'JOURNEY_SOURCE_CHANGED', '请刷新并使用本单原阶段凭据');
        if (action === 'start' ? !!v.journey.start : !!v.journey.completion)
          throw failure(409, 'JOURNEY_ALREADY_RECORDED', '本阶段已记录，请查看配送记录');
        if (v.readiness.blockers.length)
          throw failure(409, 'DELIVERY_BLOCKED', '原出库或人员资格变化，请先核查');
        await tx.redemptionJourneyFact.create({
          data: {
            id: randomUUID(),
            handoffId: h.id,
            orderId: sh.orderId,
            kind: action === 'start' ? 'START' : 'COMPLETE',
            startId: action === 'complete' ? sourceId : null,
            actorId: riderId,
            requestId: r.requestId,
          },
        });
        await this.catalog.audit(
          tx,
          r,
          'REDEMPTION_DELIVERY_' + action.toUpperCase(),
          sh.orderId,
          w,
        );
        await this.authorize(tx, r, w);
        const final = await this.view(tx, w, id, riderId);
        if (final.readiness.blockers.length)
          throw failure(409, 'DELIVERY_BLOCKED', '处理期间效期或配送人员资格失效，本次操作回滚');
        return { id };
      },
    );
  }

  async write(
    r: ApiRequest,
    w: string,
    id: string,
    action: 'assign' | 'accept',
    k: string,
    input: unknown,
  ) {
    const b = fields(
      input,
      action === 'assign'
        ? ['riderId']
        : ['assignmentId', 'packageCount', 'lines', 'physicalConfirmed'],
    );
    const riderId = action === 'assign' ? uuid(b.riderId) : r.staffContext!.staffId,
      assignmentId = action === 'accept' ? uuid(b.assignmentId) : null,
      packageCount = action === 'accept' ? integer(b.packageCount, 1, 100) : null;
    const lines: Array<{ allocationId: string; quantity: number }> = [];
    if (action === 'accept') {
      if (b.physicalConfirmed !== true)
        throw failure(400, 'PHYSICAL_CONFIRMATION_REQUIRED', '须核验包裹与逐项实物后接货');
      if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 1000)
        throw failure(400, 'VALIDATION_ERROR', '须核对每项出库实物');
      for (const v of b.lines) {
        const l = fields(v, ['allocationId', 'quantity']);
        lines.push({
          allocationId: uuid(l.allocationId),
          quantity: integer(l.quantity, 1, 100000),
        });
      }
      lines.sort((a, b) => a.allocationId.localeCompare(b.allocationId));
      if (new Set(lines.map((l) => l.allocationId)).size !== lines.length)
        throw failure(400, 'VALIDATION_ERROR', '实物核对项不能重复');
    }
    await this.authorize(this.catalog.db, r, w, action === 'assign');
    // Resource ownership is checked even when catalog.write returns a historical idempotent result.
    if (action === 'accept') await this.source(this.catalog.db, w, id, riderId);
    if (!this.enabled)
      throw failure(503, 'REDEMPTION_DELIVERY_DISABLED', '兑换骑手分配与接货尚未启用');
    return this.catalog.write(
      r,
      'REDEMPTION_DELIVERY_' + action,
      w + ':' + id,
      k,
      { riderId, assignmentId, packageCount, lines },
      async (tx) => {
        await this.authorize(tx, r, w, action === 'assign');
        const initial = await this.source(tx, w, id, action === 'accept' ? riderId : undefined);
        const managerId =
          action === 'assign' ? r.staffContext!.staffId : initial.sh.assignment!.actorId;
        if (!(await this.person(tx, riderId, w)) || !(await this.person(tx, managerId, w, true)))
          throw failure(409, 'DELIVERY_PERSON_UNAVAILABLE', '骑手或原分配人权限已变化，请核查');
        await metadataLocks(tx, [initial.o.skuId]);
        await inventoryLocks(tx, w, [initial.o.skuId]);
        await tx.$queryRaw`SELECT id FROM redemption_orders WHERE id=${initial.o.id}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM redemption_picking_tasks WHERE order_id=${initial.o.id}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM redemption_shipments WHERE id=${id}::uuid FOR UPDATE`;
        const { sh } = await this.source(tx, w, id, action === 'accept' ? riderId : undefined),
          v = await this.view(tx, w, id, action === 'accept' ? riderId : undefined);
        if (action === 'assign' && sh.assignment)
          throw failure(409, 'DELIVERY_ALREADY_ASSIGNED', '本出库单已有分配，不能重复分配或改派');
        if (action === 'accept' && (!sh.assignment || sh.assignment.id !== assignmentId))
          throw failure(409, 'ASSIGNMENT_CHANGED', '请使用当前本人分配凭据');
        if (sh.assignment?.handoff)
          throw failure(409, 'DELIVERY_ALREADY_ACCEPTED', '本人接货已记录，不能重复接货');
        if (!v.readiness.ready)
          throw failure(409, 'DELIVERY_BLOCKED', '实物、效期或原出库资格变化，请核查后再交接');
        if (action === 'assign') {
          const riderName = await this.person(tx, riderId, w),
            actorName = await this.person(tx, managerId, w, true);
          await tx.redemptionAssignment.create({
            data: {
              id: randomUUID(),
              shipmentId: id,
              orderId: sh.orderId,
              riderId,
              riderName: riderName!,
              actorId: managerId,
              actorName: actorName!,
              requestId: r.requestId,
            },
          });
        } else {
          if (
            packageCount !== sh.pack.packageCount ||
            lines.length !== sh.pack.lines.length ||
            sh.pack.lines.some(
              (l) =>
                !lines.some((x) => x.allocationId === l.allocationId && x.quantity === l.quantity),
            )
          )
            throw failure(
              409,
              'HANDOFF_QUANTITY_MISMATCH',
              '须与原装包逐项件数及包裹数完全一致，不能部分接货',
            );
          const h = await tx.redemptionHandoff.create({
            data: {
              id: randomUUID(),
              assignmentId: assignmentId!,
              shipmentId: id,
              orderId: sh.orderId,
              actorId: riderId,
              packageCount: packageCount!,
              requestId: r.requestId,
            },
          });
          await tx.redemptionHandoffLine.createMany({
            data: lines.map((l) => ({ ...l, handoffId: h.id, orderId: sh.orderId })),
          });
        }
        await this.catalog.audit(
          tx,
          r,
          'REDEMPTION_DELIVERY_' + action.toUpperCase(),
          sh.orderId,
          w,
        );
        await this.authorize(tx, r, w, action === 'assign');
        const final = await this.view(tx, w, id, action === 'accept' ? riderId : undefined);
        if (
          final.readiness.blockers.length ||
          !(await this.person(tx, riderId, w)) ||
          !(await this.person(tx, managerId, w, true))
        )
          throw failure(409, 'DELIVERY_BLOCKED', '处理期间效期或交接人员资格失效，本次操作回滚');
        return { id };
      },
    );
  }
}
const nullable = { type: 'string' as const, nullable: true },
  n = { type: 'integer' as const, minimum: 1 };
const task = object(
  {
    id: text,
    orderNo: text,
    title: text,
    spec: text,
    quantity: n,
    packageCount: n,
    shippedAt: text,
    state: {
      type: 'string',
      enum: ['UNASSIGNED', 'ASSIGNED', 'HANDED_OVER', 'DELIVERING', 'DELIVERED'],
    },
    assignment: {
      ...object({ id: text, riderId: text, riderName: text, actorName: text, createdAt: text }),
      nullable: true,
    },
    handoff: { ...object({ id: text, packageCount: n, createdAt: text }), nullable: true },
    journey: object({
      start: { ...object({ id: text, createdAt: text }), nullable: true },
      completion: { ...object({ id: text, createdAt: text }), nullable: true },
    }),
    canStart: { type: 'boolean' },
    canComplete: { type: 'boolean' },
    readiness: object({ ready: { type: 'boolean' }, blockers: { type: 'array', items: text } }),
    lines: {
      type: 'array',
      items: object({
        allocationId: text,
        quantity: n,
        batchNo: text,
        locationName: text,
        locationCode: text,
        expiresAt: nullable,
      }),
    },
    address: {
      ...object({
        areaName: text,
        buildingName: text,
        unit: text,
        room: text,
        contactName: text,
        phone: text,
        note: text,
        orderNote: text,
      }),
      nullable: true,
    },
  },
  [
    'id',
    'orderNo',
    'title',
    'spec',
    'quantity',
    'packageCount',
    'shippedAt',
    'state',
    'assignment',
    'handoff',
    'journey',
    'canStart',
    'canComplete',
    'readiness',
    'lines',
  ],
);
const page = object({
  enabled: { type: 'boolean' },
  selfOnly: { type: 'boolean' },
  items: { type: 'array', items: task },
  nextCursor: nullable,
});
@ApiTags('真实兑换骑手交接与配送')
@ApiCookieAuth('staffSession')
@Controller('warehouse/warehouses/:warehouseId/redemption-delivery')
export class RedemptionDeliveryController {
  constructor(@Inject(RedemptionDeliveryService) readonly service: RedemptionDeliveryService) {}
  @Get()
  @Permissions('redemption-delivery.read')
  @ApiQuery({ name: 'cursor', required: false })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['UNASSIGNED', 'ASSIGNED', 'HANDED_OVER', 'DELIVERING', 'DELIVERED'],
  })
  @ApiResult(page, [400, 401, 403, 409, 500])
  async list(@Req() r: ApiRequest, @Param('warehouseId') w: string, @Query() q: unknown) {
    return success(r, await this.service.read(r, uuid(w), q));
  }
  @Get('riders')
  @Permissions('redemption-delivery.assign')
  @ApiResult(
    object({ items: { type: 'array', items: object({ id: text, displayName: text }) } }),
    [400, 401, 403, 500],
  )
  async riders(@Req() r: ApiRequest, @Param('warehouseId') w: string, @Query() q: unknown) {
    fields(q, []);
    return success(r, await this.service.riders(r, uuid(w)));
  }
  @Get(':id')
  @Permissions('redemption-delivery.read')
  @ApiResult(page, [400, 401, 403, 404, 500])
  async detail(
    @Req() r: ApiRequest,
    @Param('warehouseId') w: string,
    @Param('id') id: string,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.read(r, uuid(w), {}, uuid(id)));
  }
  @Post(':id/assign')
  @HttpCode(200)
  @Permissions('redemption-delivery.assign')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({ schema: object({ riderId: text }) })
  @ApiResult(object({ id: text }), [400, 401, 403, 404, 409, 500, 503])
  async assign(
    @Req() r: ApiRequest,
    @Param('warehouseId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.write(r, uuid(w), uuid(id), 'assign', key(r), b));
  }
  @Post(':id/accept')
  @HttpCode(200)
  @Permissions('redemption-delivery.accept')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({
    schema: object({
      assignmentId: text,
      packageCount: { ...n, maximum: 100 },
      lines: {
        type: 'array',
        minItems: 1,
        maxItems: 1000,
        items: object({ allocationId: text, quantity: { ...n, maximum: 100000 } }),
      },
      physicalConfirmed: { type: 'boolean', enum: [true] },
    }),
  })
  @ApiResult(object({ id: text }), [400, 401, 403, 404, 409, 500, 503])
  async accept(
    @Req() r: ApiRequest,
    @Param('warehouseId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.write(r, uuid(w), uuid(id), 'accept', key(r), b));
  }
  @Post(':id/start')
  @HttpCode(200)
  @Permissions('redemption-delivery.work')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({
    schema: object({ handoffId: text, departureConfirmed: { type: 'boolean', enum: [true] } }),
  })
  @ApiResult(object({ id: text }), [400, 401, 403, 404, 409, 500, 503])
  async start(
    @Req() r: ApiRequest,
    @Param('warehouseId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.progress(r, uuid(w), uuid(id), 'start', key(r), b));
  }

  @Post(':id/complete')
  @HttpCode(200)
  @Permissions('redemption-delivery.work')
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiBody({
    schema: object({ startId: text, deliveryConfirmed: { type: 'boolean', enum: [true] } }),
  })
  @ApiResult(object({ id: text }), [400, 401, 403, 404, 409, 500, 503])
  async complete(
    @Req() r: ApiRequest,
    @Param('warehouseId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.progress(r, uuid(w), uuid(id), 'complete', key(r), b));
  }
}
