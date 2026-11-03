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
      state:
        o.status === 'CANCELED'
          ? 'CANCELED'
          : task?.pack?.shipment
            ? 'SHIPPED'
            : task?.pack
              ? 'PACKED'
              : (task?.state ?? j.state),
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
      work: {
        complete: task?.state === 'CHECKED',
        canComplete:
          task?.state === 'CLAIMED' &&
          !blockers.length &&
          o.allocations.every(
            (a) => task.work.filter((e) => e.allocationId === a.id).at(-1)?.action === 'CHECK',
          ),
      },
      packing: {
        canPack: task?.state === 'CHECKED' && !task.pack && !blockers.length,
        canShip: !!task?.pack && !task.pack.shipment && !blockers.length,
        pack: task?.pack
          ? {
              id: task.pack.id,
              packageCount: task.pack.packageCount,
              actorId: task.pack.actorId,
              createdAt: task.pack.createdAt.toISOString(),
              lines: task.pack.lines.map((l) => ({
                allocationId: l.allocationId,
                quantity: l.quantity,
              })),
            }
          : null,
        shipment: task?.pack?.shipment
          ? {
              id: task.pack.shipment.id,
              deliveryState: task.pack.shipment.assignments[0]?.handoff?.journey.some(
                (f) => f.kind === 'COMPLETE',
              )
                ? 'DELIVERED'
                : task.pack.shipment.assignments[0]?.handoff?.journey.some(
                      (f) => f.kind === 'START',
                    )
                  ? 'DELIVERING'
                  : task.pack.shipment.assignments[0]?.handoff
                    ? 'HANDED_OVER'
                    : task.pack.shipment.assignments[0]
                      ? 'ASSIGNED'
                      : 'UNASSIGNED',
              actorId: task.pack.shipment.actorId,
              createdAt: task.pack.shipment.createdAt.toISOString(),
            }
          : null,
      },
      history: (task?.work ?? []).map((e) => ({
        id: e.id,
        action: e.action,
        allocationId: e.allocationId,
        quantity: e.quantity,
        actorId: e.actorId,
        createdAt: e.createdAt.toISOString(),
      })),
      lines: o.allocations.map((a) => ({
        checked: task?.work.filter((e) => e.allocationId === a.id).at(-1)?.action === 'CHECK',
        issue: (() => {
          const e = task?.work.filter((e) => e.allocationId === a.id).at(-1);
          return e && ['SHORTAGE', 'DAMAGE'].includes(e.action)
            ? { id: e.id, kind: e.action, quantity: e.quantity! }
            : null;
        })(),
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
    if (
      status &&
      ![
        'READY',
        'CLAIMED',
        'CHECKED',
        'PACKED',
        'SHIPPED',
        'CANCELED',
        'FAILED',
        'QUEUED',
      ].includes(status)
    )
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
          ...(['READY', 'CLAIMED', 'CHECKED', 'PACKED', 'SHIPPED'].includes(status)
            ? {
                pickingTask: {
                  state: ['PACKED', 'SHIPPED'].includes(status) ? 'CHECKED' : status,
                  ...(status === 'CHECKED'
                    ? { pack: null }
                    : status === 'PACKED'
                      ? { pack: { shipment: null } }
                      : status === 'SHIPPED'
                        ? { pack: { shipment: { isNot: null } } }
                        : {}),
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
  async work(
    r: ApiRequest,
    w: string,
    id: string,
    action: 'check' | 'report' | 'resolve' | 'complete',
    k: string,
    input: unknown,
  ) {
    const allowed =
      action === 'complete'
        ? ['version']
        : action === 'report'
          ? ['version', 'allocationId', 'quantity', 'kind']
          : action === 'resolve'
            ? ['version', 'allocationId', 'quantity', 'issueId']
            : ['version', 'allocationId', 'quantity'];
    const b = fields(input, allowed),
      version = integer(b.version, 1, 2147483646);
    const allocationId = action === 'complete' ? null : uuid(b.allocationId);
    const quantity = action === 'complete' ? null : integer(b.quantity, 1, 2147483647);
    const issueId = action === 'resolve' ? uuid(b.issueId) : null;
    const kind = action === 'report' ? str(b.kind, 16) : null;
    if (kind && !['SHORTAGE', 'DAMAGE'].includes(kind))
      throw failure(400, 'VALIDATION_ERROR', '异常原因无效');
    await this.authorize(this.catalog.db, r, w, action === 'resolve');
    if (!this.enabled) throw failure(503, 'REDEMPTION_PICKING_DISABLED', '兑换拣货作业尚未启用');
    return this.catalog.write(
      r,
      'REDEMPTION_PICKING_' + action,
      w + ':' + id,
      k,
      { version, allocationId, quantity, issueId, kind },
      async (tx) => {
        await this.authorize(tx, r, w, action === 'resolve');
        const initial = await tx.redemptionOrder.findFirst({ where: { id, warehouseId: w } });
        if (!initial) throw failure(404, 'REDEMPTION_NOT_FOUND', '未找到本仓兑换单');
        await metadataLocks(tx, [initial.skuId]);
        await inventoryLocks(tx, w, [initial.skuId]);
        await tx.$queryRaw`SELECT id FROM redemption_orders WHERE id=${id}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT order_id FROM redemption_outbox WHERE order_id=${id}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM redemption_picking_tasks WHERE order_id=${id}::uuid FOR UPDATE`;
        const { order: o, blockers } = await redemptionPickingReadiness(tx, id),
          t = o?.pickingTask;
        if (
          !o ||
          o.status !== 'ACTIVE' ||
          o.outbox?.state !== 'COMPLETED' ||
          !t ||
          t.state !== 'CLAIMED' ||
          t.version !== version
        )
          throw failure(409, 'VERSION_CONFLICT', '任务已变化，请刷新后核实');
        if (action !== 'resolve' && t.ownerId !== r.staffContext!.staffId)
          throw failure(403, 'PICKING_OWNER_REQUIRED', '仅当前领取人可核对、上报或完成');
        const a = o.allocations.find((a) => a.id === allocationId),
          latest = t.work.filter((e) => e.allocationId === allocationId).at(-1);
        const open = latest && ['SHORTAGE', 'DAMAGE'].includes(latest.action);
        if (action !== 'complete') {
          if (!a || a.releaseLedgerId)
            throw failure(409, 'ALLOCATION_INVALID', '必须选择本单原预占批次和库位');
          if (quantity! > a.quantity || (action !== 'report' && quantity !== a.quantity))
            throw failure(
              409,
              'QUANTITY_MISMATCH',
              '核对及处置须为原预占完整件数，异常件数不得超过原预占',
            );
          if (action === 'resolve') {
            if (!open || latest.id !== issueId)
              throw failure(409, 'ISSUE_CHANGED', '原未决异常已变化，请刷新');
          } else if (open)
            throw failure(409, 'PICKING_ISSUE_OPEN', '此项异常尚未处置，不能重复上报或核对');
          else if (action === 'check' && latest?.action === 'CHECK')
            throw failure(409, 'ALREADY_CHECKED', '此项已核对');
        } else if (
          !o.allocations.length ||
          o.allocations.some(
            (a) => t.work.filter((e) => e.allocationId === a.id).at(-1)?.action !== 'CHECK',
          )
        )
          throw failure(409, 'PICKING_INCOMPLETE', '仍有未核对项或未决异常，不能完成');
        // Reporting remains available when stock is held or expired, so actual problems can be recorded.
        if (action !== 'report' && blockers.length)
          throw failure(409, 'PICKING_BLOCKED', '预占、效期或商品资格变化，不能核对、处置或完成');
        await tx.redemptionPickingTask.update({
          where: { id: t.id },
          data: {
            version: { increment: 1 },
            ...(action === 'complete' ? { state: 'CHECKED' } : {}),
          },
        });
        await tx.redemptionPickingWork.create({
          data: {
            id: randomUUID(),
            taskId: t.id,
            orderId: id,
            version: version + 1,
            action: kind ?? action.toUpperCase(),
            allocationId,
            quantity,
            issueId,
            actorId: r.staffContext!.staffId,
            requestId: r.requestId,
          },
        });
        await this.catalog.audit(tx, r, 'REDEMPTION_PICKING_' + action.toUpperCase(), id, w);
        await this.authorize(tx, r, w, action === 'resolve');
        if (action !== 'report' && (await redemptionPickingReadiness(tx, id)).blockers.length)
          throw failure(409, 'PICKING_BLOCKED', '处理期间批次或预占资格失效，本次操作回滚');
        return { id };
      },
    );
  }
  async packing(
    r: ApiRequest,
    w: string,
    id: string,
    action: 'pack' | 'ship',
    k: string,
    input: unknown,
  ) {
    const b = fields(
      input,
      action === 'pack'
        ? ['version', 'packageCount', 'lines']
        : ['version', 'packId', 'physicalConfirmed'],
    );
    if (action === 'ship' && b.physicalConfirmed !== true)
      throw failure(400, 'PHYSICAL_CONFIRMATION_REQUIRED', '须确认核验包裹及原预占实物后出库');
    const version = integer(b.version, 2, 2147483646),
      packId = action === 'ship' ? uuid(b.packId) : null;
    const packageCount = action === 'pack' ? integer(b.packageCount, 1, 100) : null;
    const lines: Array<{ allocationId: string; quantity: number }> = [];
    if (action === 'pack') {
      if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 1000)
        throw failure(400, 'VALIDATION_ERROR', '须提交每项原预占装包件数');
      for (const v of b.lines) {
        const l = fields(v, ['allocationId', 'quantity']);
        lines.push({
          allocationId: uuid(l.allocationId),
          quantity: integer(l.quantity, 1, 100000),
        });
      }
      lines.sort((a, b) => a.allocationId.localeCompare(b.allocationId));
      if (new Set(lines.map((l) => l.allocationId)).size !== lines.length)
        throw failure(400, 'VALIDATION_ERROR', '同一预占项不能重复');
    }
    await this.authorize(this.catalog.db, r, w, action === 'ship');
    if (!this.enabled) throw failure(503, 'REDEMPTION_PICKING_DISABLED', '兑换拣货作业尚未启用');
    return this.catalog.write(
      r,
      'REDEMPTION_PICKING_' + action,
      w + ':' + id,
      k,
      { version, packId, packageCount, lines },
      async (tx) => {
        await this.authorize(tx, r, w, action === 'ship');
        const initial = await tx.redemptionOrder.findFirst({ where: { id, warehouseId: w } });
        if (!initial) throw failure(404, 'REDEMPTION_NOT_FOUND', '未找到本仓兑换单');
        await metadataLocks(tx, [initial.skuId]);
        await inventoryLocks(tx, w, [initial.skuId]);
        await tx.$queryRaw`SELECT id FROM redemption_orders WHERE id=${id}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT order_id FROM redemption_outbox WHERE order_id=${id}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM redemption_picking_tasks WHERE order_id=${id}::uuid FOR UPDATE`;
        const { order: o, blockers } = await redemptionPickingReadiness(tx, id),
          t = o?.pickingTask;
        if (
          !o ||
          o.status !== 'ACTIVE' ||
          o.outbox?.state !== 'COMPLETED' ||
          !t ||
          t.state !== 'CHECKED' ||
          t.version !== version
        )
          throw failure(409, 'VERSION_CONFLICT', '须使用当前已完成拣货任务，请刷新');
        if (action === 'pack' && t.ownerId !== r.staffContext!.staffId)
          throw failure(403, 'PICKING_OWNER_REQUIRED', '仅原领取人可确认打包');
        if ((action === 'pack' && t.pack) || t.pack?.shipment)
          throw failure(409, 'STAGE_ALREADY_RECORDED', '打包或出库已记录，不能重复执行');
        if (
          action === 'ship' &&
          (!t.pack || t.pack.id !== packId || t.pack.taskVersion !== version)
        )
          throw failure(409, 'PACK_REQUIRED', '须选择本单当前打包凭据');
        if (
          !o.allocations.length ||
          !t.work.some((e) => e.action === 'COMPLETE' && e.version === version) ||
          o.allocations.some(
            (a) =>
              a.releaseLedgerId ||
              a.consumeLedgerId ||
              t.work.filter((e) => e.allocationId === a.id).at(-1)?.action !== 'CHECK',
          )
        )
          throw failure(409, 'PICKING_INCOMPLETE', '原预占未全部核对或已结算，不能打包或出库');
        if (blockers.length)
          throw failure(409, 'PICKING_BLOCKED', '当前冻结、效期或预占资格变化，不能打包或出库');
        if (action === 'pack') {
          if (
            lines.length !== o.allocations.length ||
            o.allocations.some(
              (a) => !lines.some((l) => l.allocationId === a.id && l.quantity === a.quantity),
            )
          )
            throw failure(
              409,
              'PACK_QUANTITY_MISMATCH',
              '装包须逐项等于原预占完整件数，不能漏项、换项或部分出库',
            );
          const packed = await tx.redemptionPack.create({
            data: {
              id: randomUUID(),
              taskId: t.id,
              orderId: id,
              taskVersion: version,
              packageCount: packageCount!,
              actorId: r.staffContext!.staffId,
              requestId: r.requestId,
            },
          });
          await tx.redemptionPackLine.createMany({
            data: lines.map((l) => ({ ...l, packId: packed.id, orderId: id })),
          });
        } else {
          await tx.redemptionShipment.create({
            data: {
              id: randomUUID(),
              taskId: t.id,
              orderId: id,
              packId: packId!,
              taskVersion: version,
              actorId: r.staffContext!.staffId,
              requestId: r.requestId,
            },
          });
          for (const a of o.allocations) {
            const consumeLedgerId = randomUUID();
            await tx.stockPosition.update({
              where: { id: a.positionId },
              data: {
                onHand: { decrement: a.quantity },
                reserved: { decrement: a.quantity },
                version: { increment: 1 },
              },
            });
            await tx.stockLot.update({
              where: { id: a.lotId },
              data: { onHand: { decrement: a.quantity }, reserved: { decrement: a.quantity } },
            });
            await tx.stockBalance.update({
              where: { warehouseId_skuId: { warehouseId: w, skuId: o.skuId } },
              data: {
                onHand: { decrement: a.quantity },
                reserved: { decrement: a.quantity },
                version: { increment: 1 },
              },
            });
            await tx.stockLedger.create({
              data: {
                id: consumeLedgerId,
                warehouseId: w,
                skuId: a.skuId,
                lotId: a.lotId,
                actionKey: 'REDEMPTION_SHIP:' + a.id,
                deltaOnHand: -a.quantity,
                deltaReserved: -a.quantity,
                deltaBlocked: 0,
                actorId: r.staffContext!.staffId,
                requestId: r.requestId,
              },
            });
            await tx.positionLedger.create({
              data: {
                id: randomUUID(),
                warehouseId: w,
                skuId: a.skuId,
                lotId: a.lotId,
                positionId: a.positionId,
                stockLedgerId: consumeLedgerId,
                deltaOnHand: -a.quantity,
                deltaReserved: -a.quantity,
                deltaBlocked: 0,
              },
            });
            await tx.redemptionAllocation.update({
              where: { id: a.id },
              data: { consumeLedgerId },
            });
          }
        }
        await this.catalog.audit(tx, r, 'REDEMPTION_PICKING_' + action.toUpperCase(), id, w);
        await this.authorize(tx, r, w, action === 'ship');
        if ((await redemptionPickingReadiness(tx, id)).blockers.length)
          throw failure(409, 'PICKING_BLOCKED', '处理期间批次或预占资格变化，本次打包/出库回滚');
        return { id };
      },
    );
  }
}
const n = { type: 'integer' as const, minimum: 0 },
  positive = { ...n, minimum: 1 },
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
  packing: object({
    canPack: { type: 'boolean' },
    canShip: { type: 'boolean' },
    pack: {
      ...object({
        id: text,
        packageCount: n,
        actorId: text,
        createdAt: text,
        lines: { type: 'array', items: object({ allocationId: text, quantity: n }) },
      }),
      nullable: true,
    },
    shipment: {
      ...object({
        id: text,
        actorId: text,
        createdAt: text,
        deliveryState: {
          type: 'string',
          enum: ['UNASSIGNED', 'ASSIGNED', 'HANDED_OVER', 'DELIVERING', 'DELIVERED'],
        },
      }),
      nullable: true,
    },
  }),
  work: object({ complete: { type: 'boolean' }, canComplete: { type: 'boolean' } }),
  history: {
    type: 'array',
    items: object({
      id: text,
      action: text,
      allocationId: nullable,
      quantity: { ...n, nullable: true },
      actorId: text,
      createdAt: text,
    }),
  },
  lines: {
    type: 'array',
    items: object({
      id: text,
      quantity: n,
      checked: { type: 'boolean' },
      issue: { ...object({ id: text, kind: text, quantity: n }), nullable: true },
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
    enum: ['READY', 'CLAIMED', 'CHECKED', 'PACKED', 'SHIPPED', 'CANCELED', 'FAILED', 'QUEUED'],
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
  @Post(':id/check')
  @HttpCode(200)
  @Permissions('redemption-picking.work')
  @ApiBody({ schema: object({ version: positive, allocationId: text, quantity: positive }) })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiResult(object({ id: text }), [400, 401, 403, 404, 409, 500, 503])
  async check(
    @Req() r: ApiRequest,
    @Param('warehouseId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.work(r, uuid(w), uuid(id), 'check', key(r), b));
  }

  @Post(':id/report')
  @HttpCode(200)
  @Permissions('redemption-picking.work')
  @ApiBody({
    schema: object({
      version: positive,
      allocationId: text,
      quantity: positive,
      kind: { type: 'string', enum: ['SHORTAGE', 'DAMAGE'] },
    }),
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiResult(object({ id: text }), [400, 401, 403, 404, 409, 500, 503])
  async report(
    @Req() r: ApiRequest,
    @Param('warehouseId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.work(r, uuid(w), uuid(id), 'report', key(r), b));
  }

  @Post(':id/resolve')
  @HttpCode(200)
  @Permissions('redemption-picking.resolve')
  @ApiBody({
    schema: object({ version: positive, allocationId: text, quantity: positive, issueId: text }),
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiResult(object({ id: text }), [400, 401, 403, 404, 409, 500, 503])
  async resolve(
    @Req() r: ApiRequest,
    @Param('warehouseId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.work(r, uuid(w), uuid(id), 'resolve', key(r), b));
  }

  @Post(':id/complete')
  @HttpCode(200)
  @Permissions('redemption-picking.work')
  @ApiBody({ schema: object({ version: positive }) })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiResult(object({ id: text }), [400, 401, 403, 404, 409, 500, 503])
  async complete(
    @Req() r: ApiRequest,
    @Param('warehouseId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.work(r, uuid(w), uuid(id), 'complete', key(r), b));
  }
  @Post(':id/pack')
  @HttpCode(200)
  @Permissions('redemption-picking.work')
  @ApiBody({
    schema: object({
      version: positive,
      packageCount: { type: 'integer', minimum: 1, maximum: 100 },
      lines: {
        type: 'array',
        minItems: 1,
        maxItems: 1000,
        items: object({ allocationId: text, quantity: positive }),
      },
    }),
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiResult(object({ id: text }), [400, 401, 403, 404, 409, 500, 503])
  async pack(
    @Req() r: ApiRequest,
    @Param('warehouseId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.packing(r, uuid(w), uuid(id), 'pack', key(r), b));
  }

  @Post(':id/ship')
  @HttpCode(200)
  @Permissions('redemption-picking.ship')
  @ApiBody({
    schema: object({
      version: positive,
      packId: text,
      physicalConfirmed: { type: 'boolean', enum: [true] },
    }),
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiHeader({ name: 'X-CSRF-Token', required: true })
  @ApiResult(object({ id: text }), [400, 401, 403, 404, 409, 500, 503])
  async ship(
    @Req() r: ApiRequest,
    @Param('warehouseId') w: string,
    @Param('id') id: string,
    @Body() b: unknown,
    @Query() q: unknown,
  ) {
    fields(q, []);
    return success(r, await this.service.packing(r, uuid(w), uuid(id), 'ship', key(r), b));
  }
}
