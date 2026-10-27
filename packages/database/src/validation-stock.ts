import { randomUUID } from 'node:crypto';
import type { PrismaClient } from './index.js';

// S0 transaction probe only; not the production checkout or batch allocation service.
export async function reserveValidationStock(
  db: PrismaClient,
  stockId: string,
  requestKey: string,
  quantity = 1,
) {
  if (!Number.isInteger(quantity) || quantity <= 0 || requestKey.length > 200)
    throw new Error('Invalid validation reservation input.');
  return db.$transaction(
    async (tx) => {
      // Serializes decisions on the stock row. Re-read the idempotency fact after locking.
      const locked = await tx.$queryRaw<
        Array<{ id: string }>
      >`SELECT id FROM validation_stock WHERE id=${stockId}::uuid FOR UPDATE`;
      if (!locked.length) throw new Error('Validation stock not found.');
      const existing = await tx.validationReservation.findUnique({ where: { requestKey } });
      if (existing) {
        if (existing.stockId !== stockId || existing.quantity !== quantity)
          throw new Error('IDEMPOTENCY_CONFLICT');
        return { accepted: true, reused: true };
      }
      const changed = await tx.$queryRaw<Array<{ id: string }>>`
      UPDATE validation_stock SET reserved=reserved+${quantity}, version=version+1, updated_at=CURRENT_TIMESTAMP
      WHERE id=${stockId}::uuid AND on_hand-reserved>=${quantity} RETURNING id`;
      if (!changed.length) return { accepted: false, reused: false };
      await tx.validationReservation.create({
        data: { id: randomUUID(), requestKey, stockId, quantity },
      });
      await tx.validationLedger.create({
        data: { id: randomUUID(), actionKey: requestKey, stockId, deltaReserved: quantity },
      });
      return { accepted: true, reused: false };
    },
    { isolationLevel: 'ReadCommitted', maxWait: 15000, timeout: 15000 },
  );
}
