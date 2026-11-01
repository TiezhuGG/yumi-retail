import { randomUUID } from 'node:crypto';
import { closePaymentPreparation } from './payment-preparation.js';
import type { Prisma } from './generated/prisma/client.js';
import type { createDatabase } from './index.js';
type Tx = Prisma.TransactionClient;
export async function orderReservationDelta(
  tx: Tx,
  allocation: {
    id: string;
    orderId: string;
    positionId: string;
    warehouseId: string;
    skuId: string;
    lotId: string;
    quantity: number;
  },
  release: boolean,
  requestId: string,
  consumerId?: string,
) {
  const quantity = release ? -allocation.quantity : allocation.quantity;
  await tx.stockBalance.update({
    where: { warehouseId_skuId: { warehouseId: allocation.warehouseId, skuId: allocation.skuId } },
    data: { reserved: { increment: quantity }, version: { increment: 1 } },
  });
  await tx.stockLot.update({
    where: { id: allocation.lotId },
    data: { reserved: { increment: quantity } },
  });
  await tx.stockPosition.update({
    where: { id: allocation.positionId },
    data: { reserved: { increment: quantity }, version: { increment: 1 } },
  });
  const stockLedgerId = randomUUID();
  await tx.stockLedger.create({
    data: {
      id: stockLedgerId,
      lotId: allocation.lotId,
      warehouseId: allocation.warehouseId,
      skuId: allocation.skuId,
      actionKey: `ORDER_${release ? 'RELEASE' : 'RESERVE'}:${allocation.id}`,
      deltaOnHand: 0,
      deltaReserved: quantity,
      deltaBlocked: 0,
      actorKind: consumerId ? 'CONSUMER' : 'SYSTEM',
      consumerActorId: consumerId ?? null,
      requestId,
    },
  });
  await tx.positionLedger.create({
    data: {
      id: randomUUID(),
      positionId: allocation.positionId,
      warehouseId: allocation.warehouseId,
      skuId: allocation.skuId,
      lotId: allocation.lotId,
      stockLedgerId,
      deltaOnHand: 0,
      deltaReserved: quantity,
      deltaBlocked: 0,
    },
  });
  return stockLedgerId;
}
// Caller holds the order row. Only orders which never started a payment may release without a channel close.
export async function releaseUnpaidOrder(
  tx: Tx,
  order: { id: string; warehouseId: string; userId: string; status: string; paymentState: string },
  reason: 'CONSUMER_CANCEL' | 'PAYMENT_TIMEOUT',
  requestId: string,
) {
  if (order.status === 'CANCELED') return;
  if (order.status !== 'AWAITING_PAYMENT' || order.paymentState !== 'NOT_STARTED')
    throw Error('Order cannot release without payment reconciliation');
  const allocations = await tx.orderAllocation.findMany({
    where: { orderId: order.id },
    orderBy: [{ skuId: 'asc' }, { lotId: 'asc' }, { positionId: 'asc' }],
  });
  for (const skuId of [...new Set(allocations.map((a) => a.skuId))].sort())
    await tx.$queryRaw`SELECT sku_id FROM stock_balances WHERE warehouse_id=${order.warehouseId}::uuid AND sku_id=${skuId}::uuid FOR UPDATE`;
  for (const a of allocations) {
    if (a.releaseLedgerId) throw Error('Inconsistent reservation release');
    const id = await orderReservationDelta(
      tx,
      a,
      true,
      requestId,
      reason === 'CONSUMER_CANCEL' ? order.userId : undefined,
    );
    await tx.orderAllocation.update({ where: { id: a.id }, data: { releaseLedgerId: id } });
  }
  await closePaymentPreparation(tx, order.id, reason, requestId);
  await tx.consumerOrder.update({
    where: { id: order.id },
    data: { status: 'CANCELED', cancelReason: reason, version: { increment: 1 } },
  });
  await tx.orderEvent.create({
    data: {
      id: randomUUID(),
      orderId: order.id,
      type: 'ORDER_CANCELED',
      actorKind: reason === 'CONSUMER_CANCEL' ? 'CONSUMER' : 'SYSTEM',
      requestId,
      payload: { reason },
      state: 'PENDING',
    },
  });
}
export async function expireUnpaidOrders(db: ReturnType<typeof createDatabase>) {
  let count = 0;
  for (let i = 0; i < 20; i++) {
    const expired = await db.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          Array<{
            id: string;
            warehouseId: string;
            userId: string;
            status: string;
            paymentState: string;
          }>
        >`SELECT id,warehouse_id AS "warehouseId",user_id AS "userId",status,payment_state AS "paymentState" FROM consumer_orders WHERE status='AWAITING_PAYMENT' AND payment_state='NOT_STARTED' AND payment_deadline<=clock_timestamp() ORDER BY payment_deadline,id LIMIT 1 FOR UPDATE SKIP LOCKED`;
        const row = rows[0];
        if (!row) return false;
        await releaseUnpaidOrder(tx, row, 'PAYMENT_TIMEOUT', randomUUID());
        return true;
      },
      { timeout: 15000, maxWait: 10000 },
    );
    if (!expired) break;
    count++;
  }
  return count;
}
