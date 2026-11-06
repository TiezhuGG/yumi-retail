import type { PointsExpressGate } from './points-express-gate.js';
import { expressShipmentInclude, expressShipmentView } from './express-shipment-view.js';
import { randomUUID } from 'node:crypto';
import {
  EXPRESS_CARRIERS,
  type RedemptionOrderAddress,
  type RedemptionExpressShippingView,
  type ExpressParcelPreview,
} from '@yumi/contracts';
import { redemptionPickingReadiness, redemptionJobChange, Prisma } from '@yumi/database';
import { CatalogService } from './catalog-service.js';
import { PointsGrantService } from './points-grants.js';
import { OrderPrivateData } from './order-private.js';
import { metadataLocks, inventoryLocks } from './reservation-locks.js';
import { fields, integer, str, uuid } from './catalog-input.js';
import { failure, type ApiRequest } from './http.js';
type Tx = Prisma.TransactionClient;
type ReadyOrder = NonNullable<Awaited<ReturnType<typeof redemptionPickingReadiness>>['order']>;
export class ExpressShippingService {
  readonly staff: PointsGrantService;
  readonly privateData: OrderPrivateData;
  constructor(
    readonly catalog: CatalogService,
    readonly enabled = false,
    hex?: string,
    readonly formalGate?: PointsExpressGate,
  ) {
    this.staff = new PointsGrantService(catalog);
    this.privateData = new OrderPrivateData(hex);
  }
  async source(tx: Tx, w: string, id: string) {
    const o = await tx.redemptionOrder.findFirst({
      where: { id, warehouseId: w },
      include: { expressShipment: expressShipmentInclude, outbox: true },
    });
    if (!o) throw failure(404, 'REDEMPTION_NOT_FOUND', '未找到授权范围内的兑换单');
    if (o.deliveryMode !== 'EXPRESS')
      throw failure(409, 'EXPRESS_ORDER_REQUIRED', '该订单属于原配送流程，不能录入快递发货');
    return o;
  }
  async read(r: ApiRequest, id: string): Promise<RedemptionExpressShippingView> {
    return this.catalog.db.$transaction(async (tx) => {
      const w = await this.staff.authorize(r, tx),
        o = await this.source(tx, w, id),
        ready = await redemptionPickingReadiness(tx, id);
      const blockers = o.expressShipment
        ? []
        : [
            ...ready.blockers,
            ...(o.outbox?.state !== 'EXPRESS_WAIT' ? ['EXPRESS_STATE_CHANGED'] : []),
          ];
      await this.staff.authorize(r, tx);
      return {
        id: o.id,
        orderNo: o.orderNo,
        version: o.version,
        title: o.title,
        spec: o.spec,
        quantity: o.quantity,
        address: this.privateData.decrypt<RedemptionOrderAddress>(o.userId, o.id, o.addressPayload),
        shipment: expressShipmentView(o.expressShipment),
        canCorrect:
          (this.formalGate
            ? this.formalGate.canOperate(o.executionMode, this.enabled)
            : this.enabled) &&
          o.status === 'ACTIVE' &&
          o.outbox?.state === 'EXPRESS_SHIPPED' &&
          !!o.expressShipment,
        shipmentHistory: o.expressShipment
          ? [
              {
                version: 0,
                carrierCode: o.expressShipment.carrierCode,
                carrierName: o.expressShipment.carrierName,
                trackingNo: o.expressShipment.trackingNo,
                reason: null,
                actorName: o.expressShipment.actorName,
                recordedAt: o.expressShipment.createdAt.toISOString(),
              },
              ...o.expressShipment.corrections
                .slice()
                .reverse()
                .map((c) => ({
                  version: c.version,
                  carrierCode: c.carrierCode,
                  carrierName: c.carrierName,
                  trackingNo: c.trackingNo,
                  reason: c.reason,
                  actorName: c.actorName,
                  recordedAt: c.createdAt.toISOString(),
                })),
            ]
          : [],
        enabled: this.formalGate
          ? this.formalGate.canOperate(o.executionMode, this.enabled)
          : this.enabled,
        canShip:
          (this.formalGate
            ? this.formalGate.canOperate(o.executionMode, this.enabled)
            : this.enabled) &&
          !o.expressShipment &&
          !blockers.length,
        blockers: [...new Set(blockers)],
      };
    });
  }
  private ids(input: unknown) {
    if (!Array.isArray(input) || input.length < 2 || input.length > 20)
      throw failure(400, 'VALIDATION_ERROR', '合包请选择2至20笔订单');
    const ids = input.map((x) => uuid(x).toLowerCase()).sort();
    if (new Set(ids).size !== ids.length) throw failure(400, 'VALIDATION_ERROR', '订单不能重复');
    return ids;
  }
  private async parcelSources(tx: Tx, w: string, ids: string[]) {
    const orders: Array<Awaited<ReturnType<ExpressShippingService['source']>>> = [];
    for (const id of ids) orders.push(await this.source(tx, w, id));
    const addresses = orders.map((o) =>
      this.privateData.decrypt<RedemptionOrderAddress>(o.userId, o.id, o.addressPayload),
    );
    const addressKey = (a: RedemptionOrderAddress) =>
      'province' in a
        ? JSON.stringify([
            a.contactName,
            a.phone,
            a.province,
            a.city,
            a.district,
            a.detailAddress,
            a.note,
          ])
        : null;
    if (
      orders.some(
        (o) => o.userId !== orders[0]!.userId || o.executionMode !== orders[0]!.executionMode,
      ) ||
      !addressKey(addresses[0]!) ||
      addresses.some((a) => addressKey(a) !== addressKey(addresses[0]!))
    )
      throw failure(
        409,
        'PARCEL_MISMATCH',
        '合包必须是同一顾客、相同原收件信息及相同运行模式的快递订单',
      );
    if (
      orders.some(
        (o) => o.status !== 'ACTIVE' || o.outbox?.state !== 'EXPRESS_WAIT' || o.expressShipment,
      )
    )
      throw failure(409, 'EXPRESS_STATE_CHANGED', '部分订单已取消、已发货或状态变化，请重新查询');
    return { orders, address: addresses[0]! };
  }
  async parcelPreview(r: ApiRequest, input: unknown): Promise<ExpressParcelPreview> {
    const b = fields(input, ['ids']),
      ids = this.ids(b.ids);
    return this.catalog.db.$transaction(
      async (tx) => {
        const w = await this.staff.authorize(r, tx);
        await tx.$queryRaw`SELECT id FROM redemption_orders WHERE warehouse_id=${w}::uuid AND id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR SHARE`;
        const { orders, address } = await this.parcelSources(tx, w, ids);
        const items: ExpressParcelPreview['items'] = [],
          blockers: string[] = [];
        for (const o of orders) {
          if (
            !(this.formalGate
              ? this.formalGate.canOperate(o.executionMode, this.enabled)
              : this.enabled)
          )
            blockers.push('快递发货暂未开放');
          const ready = await redemptionPickingReadiness(tx, o.id);
          if (ready.blockers.length || ready.order?.pickingTask)
            blockers.push(o.orderNo + '：库存、批次、库位或原预占需核查');
          items.push({
            id: o.id,
            orderNo: o.orderNo,
            version: o.version,
            title: o.title,
            spec: o.spec,
            unit: o.unit,
            quantity: o.quantity,
            orderNote: this.privateData.decrypt<RedemptionOrderAddress>(
              o.userId,
              o.id,
              o.addressPayload,
            ).orderNote,
            allocations:
              ready.order?.allocations.map((a) => ({
                batchNo: a.position.lot.batchNo,
                locationName: a.position.location.name,
                quantity: a.quantity,
              })) ?? [],
          });
        }
        await this.staff.authorize(r, tx);
        return {
          executionMode: orders[0]!.executionMode as ExpressParcelPreview['executionMode'],
          address,
          items,
          canShip: !blockers.length,
          blockers: [...new Set(blockers)],
        };
      },
      { timeout: 15000 },
    );
  }
  async shipParcel(r: ApiRequest, k: string, input: unknown) {
    const b = fields(input, [
      'orders',
      'carrierCode',
      'carrierName',
      'trackingNo',
      'dispatchConfirmed',
    ]);
    if (!Array.isArray(b.orders)) throw failure(400, 'VALIDATION_ERROR', '请选择合包订单');
    const selected = b.orders
      .map((x) => {
        const v = fields(x, ['id', 'version']);
        return { id: uuid(v.id).toLowerCase(), version: integer(v.version, 0, 2147483646) };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    const ids = this.ids(selected.map((x) => x.id)),
      values = this.carrier(b);
    if (b.dispatchConfirmed !== true)
      throw failure(
        400,
        'PHYSICAL_CONFIRMATION_REQUIRED',
        '须核对全部订单的原预占实物、相同收件信息和真实运单，确认已装入同一包裹并交给快递',
      );
    const w = await this.staff.authorize(r);
    return this.catalog.write(
      r,
      'REDEMPTION_EXPRESS_PARCEL_SHIP',
      w,
      k,
      { orders: selected, ...values, dispatchConfirmed: true },
      async (tx) => {
        if (!this.formalGate && !this.enabled)
          throw failure(503, 'EXPRESS_SHIPPING_DISABLED', '快递发货暂未开放');
        const initial = await this.parcelSources(tx, w, ids);
        const wh = await tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM warehouses WHERE id=${w}::uuid AND enabled FOR SHARE`;
        if (!wh.length) throw failure(409, 'SHIPPING_BLOCKED', '仓库已暂停');
        const skuIds = [...new Set(initial.orders.map((o) => o.skuId))].sort();
        await metadataLocks(tx, skuIds);
        await inventoryLocks(tx, w, skuIds);
        await tx.$queryRaw`SELECT id FROM redemption_orders WHERE warehouse_id=${w}::uuid AND id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`;
        await tx.$queryRaw`SELECT order_id FROM redemption_outbox WHERE order_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY order_id FOR UPDATE`;
        const { orders } = await this.parcelSources(tx, w, ids);
        const readyOrders: ReadyOrder[] = [];
        for (const o of orders) {
          this.formalGate?.assertOperate(o.executionMode, this.enabled);
          const ready = await redemptionPickingReadiness(tx, o.id);
          if (
            o.version !== selected.find((x) => x.id === o.id)!.version ||
            !ready.order ||
            ready.blockers.length ||
            ready.order.pickingTask ||
            ready.order.allocations.some((a) => a.consumeLedgerId || a.releaseLedgerId)
          )
            throw failure(
              409,
              'SHIPPING_BLOCKED',
              '部分订单版本、原预占、库存、批次或库位已变化，本包未发货',
            );
          readyOrders.push(ready.order);
        }
        await this.available(tx, w, null, values);
        const parcelId = randomUUID(),
          actor = await tx.staff.findUniqueOrThrow({ where: { id: r.staffContext!.staffId } });
        await tx.redemptionExpressParcel.create({
          data: {
            id: parcelId,
            warehouseId: w,
            userId: orders[0]!.userId,
            executionMode: orders[0]!.executionMode,
            orderIds: ids,
            actorId: actor.id,
            requestId: r.requestId,
          },
        });
        for (const [i, o] of readyOrders.entries()) {
          await tx.redemptionExpressShipment.create({
            data: {
              id: i === 0 ? parcelId : randomUUID(),
              parcelId,
              orderId: o.id,
              warehouseId: w,
              skuId: o.skuId,
              ...values,
              actorId: actor.id,
              actorName: actor.displayName,
              requestId: r.requestId,
            },
          });
          await this.consume(tx, r, w, o, actor);
        }
        await this.catalog.audit(tx, r, 'REDEMPTION_EXPRESS_PARCEL_SHIP', parcelId, w);
        for (const id of ids)
          if ((await redemptionPickingReadiness(tx, id)).blockers.length)
            throw failure(409, 'SHIPPING_BLOCKED', '处理期间资格或效期变化，本包发货已回滚');
        return { id: parcelId, orderIds: ids };
      },
      (tx) => this.staff.authorize(r, tx),
    );
  }
  carrier(b: Record<string, unknown>) {
    const carrierCode = str(b.carrierCode, 20);
    if (!Object.hasOwn(EXPRESS_CARRIERS, carrierCode))
      throw failure(400, 'VALIDATION_ERROR', '请选择有效快递公司');
    const carrierName =
        carrierCode === 'OTHER'
          ? str(b.carrierName, 40)
          : EXPRESS_CARRIERS[carrierCode as keyof typeof EXPRESS_CARRIERS],
      trackingNo = str(b.trackingNo, 40).toUpperCase();
    if (
      Array.from(carrierName).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      !/^[A-Z0-9][A-Z0-9-]{5,39}$/.test(trackingNo) ||
      (carrierCode !== 'OTHER' && b.carrierName !== undefined && b.carrierName !== carrierName)
    )
      throw failure(
        400,
        'VALIDATION_ERROR',
        '快递名称或单号格式无效，单号需6至40位字母、数字或连字符',
      );

    return { carrierCode, carrierName, trackingNo };
  }
  async correct(r: ApiRequest, id: string, k: string, input: unknown) {
    const b = fields(input, [
      'version',
      'carrierCode',
      'carrierName',
      'trackingNo',
      'reason',
      'verified',
    ]);
    const version = integer(b.version, 0, 2147483646),
      values = this.carrier(b),
      reason = str(b.reason, 200);
    if (
      Array.from(reason).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) ||
      b.verified !== true
    )
      throw failure(
        400,
        'VALIDATION_ERROR',
        '请填写更正原因并确认已核对真实运单；原因中勿填写个人信息',
      );
    const w = await this.staff.authorize(r);
    const initial = await this.source(this.catalog.db, w, id);
    const memberIds = initial.expressShipment?.parcel?.orderIds.slice().sort() ?? [id];
    return this.catalog.write(
      r,
      'REDEMPTION_EXPRESS_CORRECT',
      w + ':' + (initial.expressShipment?.parcelId ?? id),
      k,
      { version, ...values, reason, verified: true },
      async (tx) => {
        await this.staff.authorize(r, tx);
        if (!this.formalGate && !this.enabled)
          throw failure(503, 'EXPRESS_SHIPPING_DISABLED', '快递作业暂未开放');
        await tx.$queryRaw`SELECT id FROM redemption_orders WHERE warehouse_id=${w}::uuid AND id IN (${Prisma.join(memberIds.map((id) => Prisma.sql`${id}::uuid`))}) ORDER BY id FOR UPDATE`;
        const o = await this.source(tx, w, id),
          s = o.expressShipment;
        this.formalGate?.assertOperate(o.executionMode, this.enabled);
        if (o.status !== 'ACTIVE' || o.outbox?.state !== 'EXPRESS_SHIPPED' || !s)
          throw failure(409, 'EXPRESS_SHIPMENT_REQUIRED', '仅已快递发货订单可更正运单资料');
        const latest = expressShipmentView(s)!;
        if (latest.correctionVersion !== version)
          throw failure(409, 'VERSION_CONFLICT', '运单资料已变化，请刷新核对');
        if (
          latest.carrierCode === values.carrierCode &&
          latest.carrierName === values.carrierName &&
          latest.trackingNo === values.trackingNo
        )
          throw failure(409, 'NO_CHANGE', '运单资料未变化');
        await this.available(tx, w, s.id, values);
        const actor = await tx.staff.findUniqueOrThrow({ where: { id: r.staffContext!.staffId } });
        for (const memberId of memberIds) {
          const member = await this.source(tx, w, memberId),
            shipment = member.expressShipment;
          if (
            member.status !== 'ACTIVE' ||
            member.outbox?.state !== 'EXPRESS_SHIPPED' ||
            !shipment ||
            expressShipmentView(shipment)!.correctionVersion !== version
          )
            throw failure(409, 'VERSION_CONFLICT', '包裹内订单或运单已变化，请重新查询');
          this.formalGate?.assertOperate(member.executionMode, this.enabled);
          await tx.redemptionExpressShipmentCorrection.create({
            data: {
              id: randomUUID(),
              shipmentId: shipment.id,
              version: version + 1,
              ...values,
              reason,
              actorId: actor.id,
              actorName: actor.displayName,
              requestId: r.requestId,
            },
          });
          await this.catalog.audit(tx, r, 'REDEMPTION_EXPRESS_CORRECT', memberId, w);
        }
        await this.staff.authorize(r, tx);
        return { id, correctionVersion: version + 1 };
      },
      (tx) => this.staff.authorize(r, tx),
    );
  }
  async available(
    tx: Tx,
    w: string,
    shipmentId: string | null,
    values: { carrierCode: string; carrierName: string; trackingNo: string },
  ) {
    const rows = await tx.$queryRaw<
      Array<{ shipment_id: string }>
    >`SELECT shipment_id FROM redemption_express_waybills WHERE warehouse_id=${w}::uuid AND carrier_code=${values.carrierCode} AND carrier_name=${values.carrierName} AND tracking_no=${values.trackingNo}`;
    const source = shipmentId
      ? await tx.redemptionExpressShipment.findUnique({
          where: { id: shipmentId },
          select: { parcelId: true },
        })
      : null;
    const owner = source?.parcelId ?? shipmentId;
    if (rows.some((x) => x.shipment_id !== owner))
      throw failure(409, 'TRACKING_ALREADY_USED', '该运单已用于其他兑换单（含历史资料），请核实');
  }
  async ship(r: ApiRequest, id: string, k: string, input: unknown) {
    const b = fields(input, [
      'version',
      'carrierCode',
      'carrierName',
      'trackingNo',
      'dispatchConfirmed',
    ]);
    const version = integer(b.version, 0, 2147483646),
      { carrierCode, carrierName, trackingNo } = this.carrier(b);
    if (b.dispatchConfirmed !== true)
      throw failure(
        400,
        'PHYSICAL_CONFIRMATION_REQUIRED',
        '须核对原单全部实物、收件信息和运单，确认整单已交给快递',
      );
    const w = await this.staff.authorize(r);
    await this.source(this.catalog.db, w, id);
    return this.catalog.write(
      r,
      'REDEMPTION_EXPRESS_SHIP',
      w + ':' + id,
      k,
      { version, carrierCode, carrierName, trackingNo, dispatchConfirmed: true },
      async (tx) => {
        await this.staff.authorize(r, tx);
        if (!this.formalGate && !this.enabled)
          throw failure(503, 'EXPRESS_SHIPPING_DISABLED', '快递发货暂未开放');
        const initial = await this.source(tx, w, id);
        this.formalGate?.assertOperate(initial.executionMode, this.enabled);
        const wh = await tx.$queryRaw<
          Array<{ id: string }>
        >`SELECT id FROM warehouses WHERE id=${w}::uuid AND enabled FOR SHARE`;
        if (!wh.length) throw failure(409, 'SHIPPING_BLOCKED', '仓库已暂停');
        await metadataLocks(tx, [initial.skuId]);
        await inventoryLocks(tx, w, [initial.skuId]);
        await tx.$queryRaw`SELECT id FROM redemption_orders WHERE id=${id}::uuid FOR UPDATE`;
        await tx.$queryRaw`SELECT order_id FROM redemption_outbox WHERE order_id=${id}::uuid FOR UPDATE`;
        const { order: o, blockers } = await redemptionPickingReadiness(tx, id);
        if (
          !o ||
          o.deliveryMode !== 'EXPRESS' ||
          o.status !== 'ACTIVE' ||
          o.version !== version ||
          o.outbox?.state !== 'EXPRESS_WAIT' ||
          o.expressShipment
        )
          throw failure(409, 'EXPRESS_STATE_CHANGED', '订单已取消、已发货或状态变化，请刷新');
        if (
          blockers.length ||
          o.pickingTask ||
          o.allocations.some((a) => a.consumeLedgerId || a.releaseLedgerId)
        )
          throw failure(409, 'SHIPPING_BLOCKED', '当前冻结、效期、原预占或出库凭据不允许发货');
        await this.available(tx, w, null, { carrierCode, carrierName, trackingNo });
        const duplicate = await tx.redemptionExpressShipment.findFirst({
          where: { warehouseId: w, carrierCode, carrierName, trackingNo },
        });
        if (duplicate)
          throw failure(409, 'TRACKING_ALREADY_USED', '该快递公司和运单已用于其他兑换单，请核实');
        const actor = await tx.staff.findUniqueOrThrow({ where: { id: r.staffContext!.staffId } });
        await tx.redemptionExpressShipment.create({
          data: {
            id: randomUUID(),
            orderId: id,
            warehouseId: w,
            skuId: o.skuId,
            carrierCode,
            carrierName,
            trackingNo,
            actorId: actor.id,
            actorName: actor.displayName,
            requestId: r.requestId,
          },
        });
        await this.consume(tx, r, w, o, actor);
        await this.staff.authorize(r, tx);
        if ((await redemptionPickingReadiness(tx, id)).blockers.length)
          throw failure(409, 'SHIPPING_BLOCKED', '处理期间资格或效期变化，本次发货已回滚');
        return { id };
      },
    );
  }
  private async consume(tx: Tx, r: ApiRequest, w: string, o: ReadyOrder, actor: { id: string }) {
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
          actorId: actor.id,
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
      await tx.redemptionAllocation.update({ where: { id: a.id }, data: { consumeLedgerId } });
    }
    await redemptionJobChange(
      tx,
      o.outbox!,
      { state: 'EXPRESS_SHIPPED' },
      'EXPRESS_SHIPPED',
      r.requestId,
      actor.id,
    );
    await this.catalog.audit(tx, r, 'REDEMPTION_EXPRESS_SHIP', o.id, w);
  }
}
