import { randomUUID } from 'node:crypto';
import type { Prisma } from './generated/prisma/client.js';
import type { createDatabase } from './index.js';
import { inventoryLocks, metadataLocks } from './reservation-locks.js';
type Tx = Prisma.TransactionClient;
type Db = ReturnType<typeof createDatabase>;
type Job = Prisma.RedemptionOutboxGetPayload<Record<string, never>>;
export type RedemptionPickingLease = { orderId: string; token: string };
export function redemptionPickingWorkerEnabled(env: NodeJS.ProcessEnv) {
  const flag = env.REDEMPTION_FULFILLMENT_WORKER_ENABLED ?? '0';
  if (!['0', '1'].includes(flag)) throw Error('Invalid REDEMPTION_FULFILLMENT_WORKER_ENABLED.');
  if (flag === '0') return false;
  let u: URL;
  try {
    u = new URL(env.DATABASE_URL ?? '');
  } catch {
    throw Error('Local redemption worker database required.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(u.protocol) ||
    [...u.searchParams.keys()].some((k) => k !== 'schema') ||
    !['development', 'test'].includes(env.NODE_ENV ?? 'development') ||
    !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) ||
    !['/yumi_dev', '/yumi_test'].includes(u.pathname) ||
    (env.API_HOST && !['localhost', '127.0.0.1', '::1'].includes(env.API_HOST))
  )
    throw Error('Redemption picking worker requires explicit local isolation.');
  return true;
}
export async function redemptionJobChange(
  tx: Tx,
  job: Job,
  data: Prisma.RedemptionOutboxUpdateInput,
  reason: string,
  requestId: string,
  actorId?: string,
) {
  const next = await tx.redemptionOutbox.update({
    where: { orderId: job.orderId },
    data: { ...data, version: job.version + 1 },
  });
  await tx.redemptionOutboxEvent.create({
    data: {
      id: randomUUID(),
      orderId: job.orderId,
      version: next.version,
      state: next.state,
      attempts: next.attempts,
      reason,
      lastErrorCode: next.lastErrorCode,
      leaseToken: next.leaseToken ?? job.leaseToken,
      actorId: actorId ?? null,
      requestId,
    },
  });
  return next;
}
const sourceInclude = {
  outbox: true,
  pickingTask: {
    include: {
      owner: { select: { displayName: true } },
      work: { orderBy: { version: 'asc' as const } },
      pack: {
        include: {
          lines: true,
          shipment: {
            include: {
              assignments: {
                where: {
                  withdrawal: null,
                  OR: [{ handoff: null }, { handoff: { returned: null } }],
                },
                include: { handoff: { include: { journey: true } } },
              },
            },
          },
        },
      },
    },
  },
  reward: {
    include: {
      sku: { include: { product: { include: { category: { include: { parent: true } } } } } },
      warehouse: true,
    },
  },
  allocations: {
    include: { position: { include: { lot: true, location: true } } },
    orderBy: { id: 'asc' as const },
  },
} satisfies Prisma.RedemptionOrderInclude;
export async function redemptionPickingReadiness(tx: Tx, id: string) {
  const order = await tx.redemptionOrder.findUnique({ where: { id }, include: sourceInclude });
  const blockers: string[] = [];
  if (!order) return { order: null, blockers: ['ORDER_MISSING'] };
  if (order.status !== 'ACTIVE') blockers.push('ORDER_CANCELED');
  if (!order.reward.warehouse.enabled) blockers.push('WAREHOUSE_PAUSED');
  const sku = order.reward.sku,
    category = sku.product.category;
  if (
    !sku.enabled ||
    sku.product.status !== 'PUBLISHED' ||
    !category.enabled ||
    (category.parent && !category.parent.enabled)
  )
    blockers.push('SOURCE_UNAVAILABLE');
  const [{ at }] = await tx.$queryRaw<[{ at: Date }]>`SELECT clock_timestamp() AS at`;
  const balance = await tx.stockBalance.findUnique({
    where: { warehouseId_skuId: { warehouseId: order.warehouseId, skuId: order.skuId } },
  });
  if (
    !balance ||
    balance.inventoryHold ||
    balance.activeCountId ||
    balance.reserved <
      order.allocations.filter((a) => !a.consumeLedgerId).reduce((n, a) => n + a.quantity, 0)
  )
    blockers.push('INVENTORY_HELD');
  if (
    order.allocations.reduce((n, a) => n + a.quantity, 0) !== order.quantity ||
    !order.allocations.length
  )
    blockers.push('ALLOCATION_INCOMPLETE');
  const lots = new Map<string, number>();
  for (const a of order.allocations.filter((a) => !a.consumeLedgerId))
    lots.set(a.lotId, (lots.get(a.lotId) ?? 0) + a.quantity);
  for (const a of order.allocations) {
    const p = a.position,
      l = p.lot;
    if (a.releaseLedgerId) blockers.push('ALLOCATION_RELEASED');
    if (a.consumeLedgerId && !order.pickingTask?.pack?.shipment)
      blockers.push('CONSUMPTION_UNVERIFIED');
    if (!p.location.enabled) blockers.push('LOCATION_DISABLED');
    if (l.expiresAt && l.expiresAt <= at) blockers.push('LOT_EXPIRED');
    if (
      p.reserved < (a.consumeLedgerId ? 0 : a.quantity) ||
      l.reserved < (lots.get(l.id) ?? 0) ||
      p.onHand - p.blocked < p.reserved ||
      l.onHand - l.blocked < l.reserved
    )
      blockers.push('RESERVATION_UNAVAILABLE');
  }
  if (
    !(await tx.pointsEntry.findFirst({
      where: {
        redemptionId: id,
        redemptionAction: 'REDEEM',
        userId: order.userId,
        delta: -order.totalPoints,
      },
    }))
  )
    blockers.push('POINTS_EVIDENCE_MISSING');
  return { order, blockers: [...new Set(blockers)] };
}
export async function leaseRedemptionPicking(
  db: Db,
  leaseSeconds = 30,
): Promise<RedemptionPickingLease | null> {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 60)
    throw Error('Invalid redemption lease interval');
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      Array<{ orderId: string }>
    >`SELECT j.order_id AS "orderId" FROM redemption_outbox j JOIN redemption_orders o ON o.id=j.order_id WHERE o.status='ACTIVE' AND o.delivery_mode='LOCAL_NO_CASH' AND ((j.state IN ('PENDING','RETRY') AND j.next_attempt_at<=clock_timestamp()) OR (j.state='LEASED' AND j.lease_until<=clock_timestamp())) ORDER BY j.next_attempt_at,j.order_id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`;
    if (!rows[0]) return null;
    const job = await tx.redemptionOutbox.findUniqueOrThrow({
      where: { orderId: rows[0].orderId },
    });
    if (job.attempts >= 3) {
      await redemptionJobChange(
        tx,
        job,
        { state: 'FAILED', leaseToken: null, leaseUntil: null, lastErrorCode: 'LEASE_EXHAUSTED' },
        'FAILED',
        randomUUID(),
      );
      return null;
    }
    const [{ at }] = await tx.$queryRaw<[{ at: Date }]>`SELECT clock_timestamp() AS at`,
      token = randomUUID();
    await redemptionJobChange(
      tx,
      job,
      {
        state: 'LEASED',
        attempts: job.attempts + 1,
        leaseToken: token,
        leaseUntil: new Date(at.getTime() + leaseSeconds * 1000),
        lastErrorCode: null,
      },
      job.state === 'LEASED' ? 'RECOVERED' : 'LEASED',
      randomUUID(),
    );
    return { orderId: job.orderId, token };
  });
}
async function validLease(tx: Tx, lease: RedemptionPickingLease) {
  await tx.$queryRaw`SELECT order_id FROM redemption_outbox WHERE order_id=${lease.orderId}::uuid FOR UPDATE`;
  const job = await tx.redemptionOutbox.findUnique({ where: { orderId: lease.orderId } }),
    [{ at }] = await tx.$queryRaw<[{ at: Date }]>`SELECT clock_timestamp() AS at`;
  return job?.state === 'LEASED' &&
    job.leaseToken === lease.token &&
    job.leaseUntil &&
    job.leaseUntil > at
    ? job
    : null;
}
async function retry(tx: Tx, job: Job, code: string) {
  const [{ at }] = await tx.$queryRaw<[{ at: Date }]>`SELECT clock_timestamp() AS at`;
  const exhausted = job.attempts >= 3;
  await redemptionJobChange(
    tx,
    job,
    {
      state: exhausted ? 'FAILED' : 'RETRY',
      leaseToken: null,
      leaseUntil: null,
      lastErrorCode: code,
      nextAttemptAt: new Date(at.getTime() + 2 ** job.attempts * 1000),
    },
    exhausted ? 'FAILED' : 'RETRY',
    randomUUID(),
  );
}
export async function finishRedemptionPicking(db: Db, lease: RedemptionPickingLease) {
  return db.$transaction(
    async (tx) => {
      const initial = await tx.redemptionOrder.findUnique({ where: { id: lease.orderId } });
      if (!initial) return false;
      await tx.$queryRaw`SELECT id FROM warehouses WHERE id=${initial.warehouseId}::uuid FOR SHARE`;
      await metadataLocks(tx, [initial.skuId]);
      await inventoryLocks(tx, initial.warehouseId, [initial.skuId]);
      await tx.$queryRaw`SELECT id FROM redemption_orders WHERE id=${lease.orderId}::uuid FOR UPDATE`;
      const job = await validLease(tx, lease);
      if (!job) return false;
      const ready = await redemptionPickingReadiness(tx, lease.orderId);
      if (!ready.order || ready.order.status !== 'ACTIVE') return false;
      if (ready.blockers.length) {
        await retry(
          tx,
          job,
          ready.blockers.includes('WAREHOUSE_PAUSED')
            ? 'WAREHOUSE_PAUSED'
            : ready.blockers.includes('SOURCE_UNAVAILABLE')
              ? 'SOURCE_UNAVAILABLE'
              : 'RESERVATION_UNAVAILABLE',
        );
        return true;
      }
      const existing = await tx.redemptionPickingTask.findUnique({
        where: { orderId: lease.orderId },
      });
      if (existing) throw Error('Unexpected existing redemption task');
      const id = randomUUID(),
        requestId = randomUUID();
      await tx.redemptionPickingTask.create({
        data: { id, orderId: initial.id, warehouseId: initial.warehouseId, skuId: initial.skuId },
      });
      await tx.redemptionPickingEvent.create({
        data: { id: randomUUID(), taskId: id, orderId: initial.id, action: 'CREATED', requestId },
      });
      await redemptionJobChange(
        tx,
        job,
        { state: 'COMPLETED', leaseToken: null, leaseUntil: null, lastErrorCode: null },
        'CREATED',
        requestId,
      );
      // A slow event/constraint write must not commit an expired lease or expired batch.
      const [{ at }] = await tx.$queryRaw<[{ at: Date }]>`SELECT clock_timestamp() AS at`;
      if (
        job.leaseUntil! <= at ||
        (await redemptionPickingReadiness(tx, lease.orderId)).blockers.length
      )
        throw Error('Lease or reservation expired during task creation');
      return true;
    },
    { timeout: 15000, maxWait: 10000 },
  );
}
export async function failRedemptionPicking(db: Db, lease: RedemptionPickingLease) {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM redemption_orders WHERE id=${lease.orderId}::uuid FOR UPDATE`;
    const job = await validLease(tx, lease);
    if (!job) return false;
    await retry(tx, job, 'PROCESSING_FAILED');
    return true;
  });
}
export async function runRedemptionPickingOnce(db: Db) {
  const lease = await leaseRedemptionPicking(db);
  if (!lease) return false;
  try {
    return await finishRedemptionPicking(db, lease);
  } catch {
    return failRedemptionPicking(db, lease);
  }
}
