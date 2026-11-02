import { randomUUID } from 'node:crypto';
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { ApiBody, ApiCookieAuth, ApiHeader, ApiTags, ApiQuery, ApiParam } from '@nestjs/swagger';
import {
  inventoryLocks,
  metadataLocks,
  redemptionPickingReadiness,
  redemptionJobChange,
} from '@yumi/database';
import type { Prisma } from '@yumi/database';
import type { RedemptionPickingView } from '@yumi/contracts';
import { CatalogService } from './catalog-service.js';
import { fields, integer, key, str, uuid } from './catalog-input.js';
import { Permissions } from './staff-guard.js';
import { failure, success } from './http.js';
import type { ApiRequest } from './http.js';
import { object, text, ApiResult } from './api-result.js';
type Tx = Prisma.TransactionClient;
export class RedemptionPickingService {
  constructor(
    readonly catalog: CatalogService,
    readonly enabled = false,
  ) {}
  async authorize(tx: Tx, r: ApiRequest, w: string, manage = false) {
    const c = r.staffContext!;
    const rows = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT s.id FROM staff s JOIN staff_sessions sess ON sess.staff_id=s.id JOIN staff_warehouses sw ON sw.staff_id=s.id JOIN staff_roles role ON role.staff_id=s.id WHERE s.id=${c.staffId}::uuid AND sess.id=${c.sessionId}::uuid AND sess.revoked_at IS NULL AND sess.auth_version=s.auth_version AND sess.expires_at>clock_timestamp() AND s.enabled AND sw.warehouse_id=${w}::uuid AND role.role_code IN ('SUPER_ADMIN','WAREHOUSE_MANAGER','PICKER') AND (NOT ${manage} OR role.role_code IN ('SUPER_ADMIN','WAREHOUSE_MANAGER')) FOR SHARE OF s,sess,sw,role`;
    if (!rows.length) throw failure(403, 'FORBIDDEN', '当前账号无本仓兑换拣货权限');
    await this.catalog.warehouse(tx, r, w);
  }
  async view(tx: Tx, id: string): Promise<RedemptionPickingView> {
    const { order: o, blockers } = await redemptionPickingReadiness(tx, id);
    if (!o || !o.outbox) throw failure(404, 'REDEMPTION_NOT_FOUND', '兑换履约待办不存在');
    const task = o.pickingTask,
      j = o.outbox;
    return {
      id: o.id,
      orderNo: o.orderNo,
      title: o.title,
      spec: o.spec,
      quantity: o.quantity,
      state: o.status === 'CANCELED' ? 'CANCELED' : (task?.state ?? j.state),
      task: task
        ? {
            id: task.id,
            state: task.state,
            ownerId: task.ownerId,
            ownerName: task.owner?.displayName ?? null,
            version: task.version,
            claimedAt: task.claimedAt?.toISOString() ?? null,
          }
        : null,
      job: {
        state: j.state,
        attempts: j.attempts,
        version: j.version,
        lastErrorCode: j.lastErrorCode,
        nextAttemptAt: j.nextAttemptAt.toISOString(),
        leaseUntil: j.leaseUntil?.toISOString() ?? null,
      },
      readiness: {
        ready: o.status === 'ACTIVE' && task?.state === 'READY' && !blockers.length,
        blockers,
      },
      lines: o.allocations.map((a) => ({
        id: a.id,
        quantity: a.quantity,
        batchNo: a.position.lot.batchNo,
        locationName: a.position.location.name,
        locationCode: a.position.location.code,
        expiresAt: a.position.lot.expiresAt?.toISOString() ?? null,
      })),
    };
  }
  async read(r: ApiRequest, w: string, q: unknown, id?: string) {
    const b = fields(q, ['cursor', 'status', 'mine']),
      cursor = b.cursor === undefined ? null : uuid(b.cursor),
      status = b.status === undefined ? '' : str(b.status, 16);
    if (status && !['READY', 'CLAIMED', 'CANCELED', 'FAILED', 'QUEUED'].includes(status))
      throw failure(400, 'VALIDATION_ERROR', '任务筛选无效');
    if (b.mine !== undefined && b.mine !== '1')
      throw failure(400, 'VALIDATION_ERROR', '本人筛选无效');
    return this.catalog.db.$transaction(
      async (tx) => {
        await this.authorize(tx, r, w);
        const where: Prisma.RedemptionOrderWhereInput = {
          warehouseId: w,
          ...(id ? { id } : {}),
          ...(b.mine ? { pickingTask: { ownerId: r.staffContext!.staffId } } : {}),
          ...(status === 'CANCELED' ? { status: 'CANCELED' } : status ? { status: 'ACTIVE' } : {}),
          ...(['READY', 'CLAIMED'].includes(status)
            ? {
                pickingTask: {
                  state: status,
                  ...(b.mine ? { ownerId: r.staffContext!.staffId } : {}),
                },
              }
            : {}),
          ...(status === 'FAILED' ? { outbox: { state: 'FAILED' } } : {}),
          ...(status === 'QUEUED'
            ? { pickingTask: null, outbox: { state: { in: ['PENDING', 'LEASED', 'RETRY'] } } }
            : {}),
        };
        if (cursor && !(await tx.redemptionOrder.findFirst({ where: { ...where, id: cursor } })))
          throw failure(409, 'CURSOR_INVALID', '分页位置已变化，请重新读取');
        const rows = await tx.redemptionOrder.findMany({
          where: { ...where, ...(cursor ? { id: { gt: cursor } } : {}) },
          orderBy: { id: 'asc' },
          take: 21,
          select: { id: true },
        });
        if (id && !rows.length) throw failure(404, 'REDEMPTION_NOT_FOUND', '未找到本仓兑换单');
        const items = [];
        for (const row of rows.slice(0, 20)) items.push(await this.view(tx, row.id));
        return {
          enabled: this.enabled,
          items,
          nextCursor: rows.length > 20 ? items.at(-1)!.id : null,
        };
      },
      { isolationLevel: 'RepeatableRead', timeout: 15000 },
    );
  }
  async write(
    r: ApiRequest,
    w: string,
    id: string,
    action: 'claim' | 'retry',
    k: string,
    b: unknown,
  ) {
    const body = fields(b, ['version']),
      version = integer(body.version, 0, 2147483646);
    await this.authorize(this.catalog.db, r, w, action === 'retry');
    if (!this.enabled) throw failure(503, 'REDEMPTION_PICKING_DISABLED', '兑换拣货作业尚未启用');
    return this.catalog.write(
      r,
      'REDEMPTION_PICKING_' + action,
      w + ':' + id,
      k,
      { version },
      async (tx) => {
        await this.authorize(tx, r, w, action === 'retry');
        const initial = await tx.redemptionOrder.findFirst({ where: { id, warehouseId: w } });
        if (!initial) throw failure(404, 'REDEMPTION_NOT_FOUND', '未找到本仓兑换单');
        if (action === 'claim') {
          await metadataLocks(tx, [initial.skuId]);
          await inventoryLocks(tx, w, [initial.skuId]);
        }
        await tx.$queryRaw`SELECT id FROM redemption_orders WHERE id=${id}::uuid AND warehouse_id=${w}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT order_id FROM redemption_outbox WHERE order_id=${id}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM redemption_picking_tasks WHERE order_id=${id}::uuid FOR UPDATE`;
        const { order, blockers } = await redemptionPickingReadiness(tx, id);
        if (!order || order.status !== 'ACTIVE')
          throw failure(409, 'ORDER_CANCELED', '兑换已取消，不能领取或重试');
        if (action === 'retry') {
          if (
            order.outbox?.state !== 'FAILED' ||
            order.outbox.version !== version ||
            order.pickingTask
          )
            throw failure(409, 'VERSION_CONFLICT', '仅当前失败且未建任务的待办可重试，请刷新');
          await redemptionJobChange(
            tx,
            order.outbox,
            {
              state: 'RETRY',
              attempts: 0,
              leaseToken: null,
              leaseUntil: null,
              lastErrorCode: null,
              nextAttemptAt: new Date(),
            },
            'MANUAL_RETRY',
            r.requestId,
            r.staffContext!.staffId,
          );
        } else {
          const task = order.pickingTask;
          if (
            !task ||
            task.state !== 'READY' ||
            task.version !== version ||
            order.outbox?.state !== 'COMPLETED'
          )
            throw failure(409, 'TASK_ALREADY_CLAIMED', '任务状态已变化，请刷新');
          if (blockers.length)
            throw failure(409, 'PICKING_BLOCKED', '预占、效期或商品资格变化，请核查后再领取');
          await tx.redemptionPickingTask.update({
            where: { id: task.id },
            data: {
              state: 'CLAIMED',
              ownerId: r.staffContext!.staffId,
              claimedAt: new Date(),
              version: { increment: 1 },
            },
          });
          await tx.redemptionPickingEvent.create({
            data: {
              id: randomUUID(),
              taskId: task.id,
              orderId: id,
              action: 'CLAIMED',
              actorId: r.staffContext!.staffId,
              requestId: r.requestId,
            },
          });
        }
        await this.catalog.audit(tx, r, 'REDEMPTION_PICKING_' + action.toUpperCase(), id, w);
        await this.authorize(tx, r, w, action === 'retry');
        if (action === 'claim' && (await redemptionPickingReadiness(tx, id)).blockers.length)
          throw failure(409, 'PICKING_BLOCKED', '领取处理期间批次或预占资格已失效，本次领取回滚');
        return { id };
      },
    );
  }
}
const n = { type: 'integer' as const, minimum: 0 },
  nullable = { type: 'string' as const, nullable: true };
const task = object({
  id: text,
  orderNo: text,
  title: text,
  spec: text,
  quantity: n,
  state: text,
  task: {
    ...object({
      id: text,
      state: text,
      ownerId: nullable,
      ownerName: nullable,
      version: n,
      claimedAt: nullable,
    }),
    nullable: true,
  },
  job: object({
    state: text,
    attempts: n,
    version: n,
    lastErrorCode: nullable,
    nextAttemptAt: text,
    leaseUntil: nullable,
  }),
  readiness: object({ ready: { type: 'boolean' }, blockers: { type: 'array', items: text } }),
  lines: {
    type: 'array',
    items: object({
      id: text,
      quantity: n,
      batchNo: text,
      locationName: text,
      locationCode: text,
      expiresAt: nullable,
    }),
  },
});
@ApiTags('兑换真实拣货任务')
@ApiCookieAuth('staffSession')
@Controller('warehouse/warehouses/:warehouseId/redemption-picking')
export class RedemptionPickingController {
  constructor(@Inject(RedemptionPickingService) readonly service: RedemptionPickingService) {}
  @Get()
  @ApiParam({ name: 'warehouseId', type: String })
  @ApiQuery({ name: 'cursor', required: false, type: String })
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['READY', 'CLAIMED', 'CANCELED', 'FAILED', 'QUEUED'],
  })
  @ApiQuery({ name: 'mine', required: false, enum: ['1'] })
  @Permissions('redemption-picking.read')
  @ApiResult(
    object({
      enabled: { type: 'boolean' },
      items: { type: 'array', items: task },
      nextCursor: nullable,
    }),
    [400, 401, 403, 409, 500],
  )
  async list(@Req() r: ApiRequest, @Param('warehouseId') w: string, @Query() q: unknown) {
    return success(r, await this.service.read(r, uuid(w), q));
  }
  @Get(':id')
  @Permissions('redemption-picking.read')
  @ApiResult(
    object({
      enabled: { type: 'boolean' },
      items: { type: 'array', items: task },
      nextCursor: nullable,
    }),
    [400, 401, 403, 404, 500],
  )
  async detail(
    @Req() r: ApiRequest,
    @Param('warehouseId') w: string,
    @Param('id') id: string,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.read(r, uuid(w), {}, uuid(id)));
  }
  @Post(':id/claim')
  @HttpCode(200)
  @Permissions('redemption-picking.claim')
  @ApiBody({ schema: object({ version: n }) })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiResult(object({ id: text }), [400, 401, 403, 404, 409, 500, 503])
  async claim(
    @Req() r: ApiRequest,
    @Param('warehouseId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.write(r, uuid(w), uuid(id), 'claim', key(r), b));
  }
  @Post(':id/retry')
  @HttpCode(200)
  @Permissions('redemption-picking.retry')
  @ApiBody({ schema: object({ version: n }) })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiResult(object({ id: text }), [400, 401, 403, 404, 409, 500, 503])
  async retry(
    @Req() r: ApiRequest,
    @Param('warehouseId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.write(r, uuid(w), uuid(id), 'retry', key(r), b));
  }
}
