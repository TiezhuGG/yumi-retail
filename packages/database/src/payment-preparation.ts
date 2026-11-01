import { randomUUID } from 'node:crypto';
import type { Prisma } from './generated/prisma/client.js';
// Only called with the owning order locked and before any channel has been invoked.
export async function closePaymentPreparation(
  tx: Prisma.TransactionClient,
  orderId: string,
  reason: 'CONSUMER_CANCEL' | 'PAYMENT_TIMEOUT',
  requestId: string,
) {
  const p = await tx.paymentPreparation.findUnique({ where: { orderId } });
  if (!p) return;
  if (p.state !== 'PREPARED' || p.channel !== 'DISABLED')
    throw Error('Payment preparation requires reconciliation');
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  await tx.paymentPreparation.update({
    where: { id: p.id },
    data: { state: 'CLOSED', closedAt: clock[0]!.now, closeReason: reason },
  });
  await tx.paymentPreparationEvent.create({
    data: {
      id: randomUUID(),
      preparationId: p.id,
      type: 'CLOSED',
      actorKind: reason === 'PAYMENT_TIMEOUT' ? 'SYSTEM' : 'CONSUMER',
      requestId,
    },
  });
}
