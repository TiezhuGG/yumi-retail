import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import {
  parseWaybillCsv,
  type WaybillImportPreview,
  type WaybillCsvRow,
  type RedemptionOrderAddress,
} from '@yumi/contracts';
import { Prisma, redemptionPickingReadiness } from '@yumi/database';
import { ExpressShippingService } from './express-shipping.js';
import { metadataLocks, inventoryLocks } from './reservation-locks.js';
import { fields, integer, uuid } from './catalog-input.js';
import { failure, type ApiRequest } from './http.js';
type Entry = {
  id: string;
  version: number;
  carrierCode: string;
  carrierName: string;
  trackingNo: string;
};
export class ExpressWaybillImportService {
  constructor(readonly shipping: ExpressShippingService) {}
  private parse(input: unknown) {
    const b = fields(input, ['csv']);
    let rows: WaybillCsvRow[];
    try {
      rows = parseWaybillCsv(b.csv);
    } catch (e) {
      throw failure(400, 'INVALID_WAYBILL_CSV', e instanceof Error ? e.message : 'CSV无效');
    }
    const entries = rows.map((row) => {
      try {
        return { ...row, ...this.shipping.carrier(row as unknown as Record<string, unknown>) };
      } catch {
        throw failure(400, 'INVALID_WAYBILL_CSV', `第${row.row}行快递公司或运单格式无效`);
      }
    });
    this.uniqueTracking(entries);
    return entries;
  }
  private uniqueTracking(
    rows: Array<{ carrierCode: string; carrierName: string; trackingNo: string }>,
  ) {
    const seen = new Set<string>();
    for (const r of rows) {
      const identity = JSON.stringify([r.carrierCode, r.carrierName, r.trackingNo]);
      if (seen.has(identity))
        throw failure(
          400,
          'DUPLICATE_TRACKING',
          '同一运单重复出现，请删除重复行；需要同包发货时使用合包入口',
        );
      seen.add(identity);
    }
  }
  async preview(r: ApiRequest, input: unknown): Promise<WaybillImportPreview> {
    const rows = this.parse(input),
      { catalog, staff } = this.shipping;
    return catalog.db.$transaction(
      async (tx) => {
        const w = await staff.authorize(r, tx);
        const orders = await tx.redemptionOrder.findMany({
          where: { warehouseId: w, orderNo: { in: rows.map((x) => x.orderNo) } },
        });
        const ids = orders.map((x) => x.id).sort();
        if (ids.length)
          await tx.$queryRaw`SELECT id FROM redemption_orders WHERE warehouse_id=${w}::uuid AND id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR SHARE`;
        const items: WaybillImportPreview['items'] = [],
          issues: WaybillImportPreview['issues'] = [];
        for (const row of rows) {
          const initial = orders.find((o) => o.orderNo === row.orderNo);
          if (!initial) {
            issues.push({
              row: row.row,
              orderNo: row.orderNo,
              message: '未找到当前授权仓内的订单',
            });
            continue;
          }
          const { order: o, blockers } = await redemptionPickingReadiness(tx, initial.id);
          if (
            !o ||
            o.warehouseId !== w ||
            o.deliveryMode !== 'EXPRESS' ||
            o.status !== 'ACTIVE' ||
            o.outbox?.state !== 'EXPRESS_WAIT' ||
            o.expressShipment
          ) {
            issues.push({
              row: row.row,
              orderNo: row.orderNo,
              message: '订单非待发货快递订单，可能已取消或已发货',
            });
            continue;
          }
          if (
            !(this.shipping.formalGate
              ? this.shipping.formalGate.canOperate(o.executionMode, this.shipping.enabled)
              : this.shipping.enabled)
          ) {
            issues.push({ row: row.row, orderNo: row.orderNo, message: '快递发货暂未开放' });
            continue;
          }
          if (
            blockers.length ||
            o.pickingTask ||
            o.allocations.some((a) => a.consumeLedgerId || a.releaseLedgerId)
          ) {
            issues.push({
              row: row.row,
              orderNo: row.orderNo,
              message: '库存、批次、库位或原预占需核查',
            });
            continue;
          }
          try {
            await this.shipping.available(tx, w, null, row);
          } catch (e) {
            if (!(e instanceof HttpException) || e.getStatus() !== 409) throw e;
            issues.push({
              row: row.row,
              orderNo: row.orderNo,
              message: '运单已被其他订单或历史发货记录使用',
            });
            continue;
          }
          items.push({
            row: row.row,
            id: o.id,
            orderNo: o.orderNo,
            version: o.version,
            executionMode:
              o.executionMode as WaybillImportPreview['items'][number]['executionMode'],
            title: o.title,
            spec: o.spec,
            unit: o.unit,
            quantity: o.quantity,
            address: this.shipping.privateData.decrypt<RedemptionOrderAddress>(
              o.userId,
              o.id,
              o.addressPayload,
            ),
            carrierCode: row.carrierCode,
            carrierName: row.carrierName,
            trackingNo: row.trackingNo,
            allocations: o.allocations.map((a) => ({
              batchNo: a.position.lot.batchNo,
              locationName: a.position.location.name,
              quantity: a.quantity,
            })),
          });
        }
        await staff.authorize(r, tx);
        return { canShip: !issues.length, items: issues.length ? [] : items, issues };
      },
      { timeout: 15000 },
    );
  }
  async confirm(r: ApiRequest, k: string, input: unknown) {
    const b = fields(input, ['items', 'dispatchConfirmed']);
    if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > 20)
      throw failure(400, 'VALIDATION_ERROR', '每批请选择1至20笔订单');
    const entries: Entry[] = b.items
      .map((item) => {
        const x = fields(item, ['id', 'version', 'carrierCode', 'carrierName', 'trackingNo']);
        return {
          id: uuid(x.id).toLowerCase(),
          version: integer(x.version, 0, 2147483646),
          ...this.shipping.carrier(x),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    const ids = entries.map((x) => x.id);
    if (new Set(ids).size !== ids.length) throw failure(400, 'VALIDATION_ERROR', '订单不能重复');
    this.uniqueTracking(entries);
    if (b.dispatchConfirmed !== true)
      throw failure(
        400,
        'PHYSICAL_CONFIRMATION_REQUIRED',
        '须逐单核对原收件信息、实物与对应真实运单，确认全部已交给快递',
      );
    const { catalog, staff } = this.shipping,
      w = await staff.authorize(r);
    return catalog.write(
      r,
      'REDEMPTION_EXPRESS_BATCH_SHIP',
      w,
      k,
      { items: entries, dispatchConfirmed: true },
      async (tx) => {
        if (!this.shipping.formalGate && !this.shipping.enabled)
          throw failure(503, 'EXPRESS_SHIPPING_DISABLED', '快递发货暂未开放');
        const initial = [];
        for (const id of ids) initial.push(await this.shipping.source(tx, w, id));
        const wh = await tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM warehouses WHERE id=${w}::uuid AND enabled FOR SHARE`;
        if (!wh.length) throw failure(409, 'SHIPPING_BLOCKED', '仓库已暂停');
        const skuIds = [...new Set(initial.map((o) => o.skuId))].sort();
        await metadataLocks(tx, skuIds);
        await inventoryLocks(tx, w, skuIds);
        await tx.$queryRaw`SELECT id FROM redemption_orders WHERE warehouse_id=${w}::uuid AND id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`;
        await tx.$queryRaw`SELECT order_id FROM redemption_outbox WHERE order_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY order_id FOR UPDATE`;
        const actor = await tx.staff.findUniqueOrThrow({ where: { id: r.staffContext!.staffId } }),
          result = [];
        for (const entry of entries) {
          const { order: o, blockers } = await redemptionPickingReadiness(tx, entry.id);
          if (
            !o ||
            o.warehouseId !== w ||
            o.deliveryMode !== 'EXPRESS' ||
            o.status !== 'ACTIVE' ||
            o.version !== entry.version ||
            o.outbox?.state !== 'EXPRESS_WAIT' ||
            o.expressShipment
          )
            throw failure(
              409,
              'EXPRESS_STATE_CHANGED',
              '部分订单状态或版本已变化，整批未发货，请重新预检',
            );
          this.shipping.formalGate?.assertOperate(o.executionMode, this.shipping.enabled);
          if (
            blockers.length ||
            o.pickingTask ||
            o.allocations.some((a) => a.consumeLedgerId || a.releaseLedgerId)
          )
            throw failure(
              409,
              'SHIPPING_BLOCKED',
              '部分订单库存、批次、库位或原预占已变化，整批未发货',
            );
          await this.shipping.available(tx, w, null, entry);
          await tx.redemptionExpressShipment.create({
            data: {
              id: randomUUID(),
              orderId: o.id,
              warehouseId: w,
              skuId: o.skuId,
              carrierCode: entry.carrierCode,
              carrierName: entry.carrierName,
              trackingNo: entry.trackingNo,
              actorId: actor.id,
              actorName: actor.displayName,
              requestId: r.requestId,
            },
          });
          await this.shipping.consume(tx, r, w, o, actor);
          result.push({ id: o.id, orderNo: o.orderNo });
        }
        const id = randomUUID();
        await catalog.audit(tx, r, 'REDEMPTION_EXPRESS_BATCH_SHIP', id, w);
        for (const orderId of ids)
          if ((await redemptionPickingReadiness(tx, orderId)).blockers.length)
            throw failure(409, 'SHIPPING_BLOCKED', '处理期间资格或效期变化，整批发货已回滚');
        return { id, items: result };
      },
      (tx) => staff.authorize(r, tx),
    );
  }
}
