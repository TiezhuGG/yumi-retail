import { randomUUID } from 'node:crypto';
import type { Prisma } from './generated/prisma/client.js';
import type { createDatabase } from './index.js';
import { adapterFixtureBinding, paymentAdapterCases } from './payment-adapter-fixtures.js';
import { executePaymentQuery, type PaymentQueryObservation } from './payment-query-adapter.js';
import { mergePaymentEvidence } from './payment-close-policy.js';
type Tx = Prisma.TransactionClient;
type Job = Prisma.PaymentQueryLabJobGetPayload<Record<string, never>>;
export function paymentQueryLabWorkerEnabled(env: NodeJS.ProcessEnv): boolean {
  const flag = env.PAYMENT_QUERY_LAB_WORKER_ENABLED ?? '0';
  if (!['0', '1'].includes(flag)) throw Error('Invalid PAYMENT_QUERY_LAB_WORKER_ENABLED.');
  if (flag === '0') return false;
  let u: URL;
  try {
    u = new URL(env.DATABASE_URL ?? '');
  } catch {
    throw Error('Query lab requires local isolated database.');
  }
  if (
    !['development', 'test'].includes(env.NODE_ENV ?? 'development') ||
    env.PAYMENT_NOTIFICATION_LAB_ENABLED !== '1' ||
    env.PAYMENT_MODE !== 'disabled' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) ||
    !['/yumi_dev', '/yumi_test'].includes(u.pathname) ||
    (env.API_HOST && !['localhost', '127.0.0.1', '::1'].includes(env.API_HOST))
  )
    throw Error('Query lab worker requires explicit non-production local isolation.');
  return true;
}
export async function schedulePaymentQueryLab(
  tx: Tx,
  attempt: { id: string; warehouseId: string; evidence: string },
) {
  if (attempt.evidence !== 'UNKNOWN') return;
  const old = await tx.paymentQueryLabJob.findUnique({ where: { attemptId: attempt.id } });
  if (old) return old;
  const job = await tx.paymentQueryLabJob.create({
    data: { id: randomUUID(), attemptId: attempt.id, warehouseId: attempt.warehouseId },
  });
  await tx.paymentQueryLabEvent.create({
    data: {
      id: randomUUID(),
      jobId: job.id,
      key: job.id,
      reason: 'SCHEDULED',
      state: job.state,
      attempts: 0,
      version: 0,
    },
  });
  return job;
}
async function change(
  tx: Tx,
  job: Job,
  data: Prisma.PaymentQueryLabJobUpdateInput,
  reason: string,
  key: string = randomUUID(),
  attemptEventId?: string,
  result?: PaymentQueryObservation,
  scenario?: string,
) {
  const row = await tx.paymentQueryLabJob.update({
    where: { id: job.id },
    data: { ...data, version: job.version + 1 },
  });
  await tx.paymentQueryLabEvent.create({
    data: {
      id: randomUUID(),
      jobId: job.id,
      key,
      reason,
      state: row.state,
      attempts: row.attempts,
      version: row.version,
      attemptEventId,
      classification: result?.classification,
      resultEvidence: result?.evidence,
      next: result?.next,
      scenario,
    },
  });
  return row;
}
export interface QueryLabLease {
  id: string;
  attemptId: string;
  warehouseId: string;
  token: string;
}
export async function claimPaymentQueryLab(
  db: ReturnType<typeof createDatabase>,
  warehouseId?: string,
  leaseSeconds = 30,
): Promise<QueryLabLease | null> {
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 1 || leaseSeconds > 60)
    throw Error('Invalid lab lease interval');
  return db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      Job[]
    >`SELECT j.id,j.attempt_id AS "attemptId",j.warehouse_id AS "warehouseId",j.state,j.attempts,j.version,j.next_run_at AS "nextRunAt",j.lease_token AS "leaseToken",j.lease_until AS "leaseUntil",j.created_at AS "createdAt" FROM payment_query_lab_jobs j JOIN warehouses w ON w.id=j.warehouse_id WHERE w.enabled AND (${warehouseId ?? null}::uuid IS NULL OR j.warehouse_id=${warehouseId ?? null}::uuid) AND ((j.state='RETRY' AND j.next_run_at<=clock_timestamp()) OR (j.state='LEASED' AND j.lease_until<=clock_timestamp())) ORDER BY j.next_run_at,j.id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`;
    const job = rows[0];
    if (!job) return null;
    if (job.attempts >= 3) {
      await change(
        tx,
        job,
        { state: 'EXHAUSTED', leaseToken: null, leaseUntil: null },
        'LEASE_EXHAUSTED',
      );
      return null;
    }
    const [{ now }] = await tx.$queryRaw<[{ now: Date }]>`SELECT clock_timestamp() AS now`;
    const token = randomUUID();
    await change(
      tx,
      job,
      {
        state: 'LEASED',
        attempts: job.attempts + 1,
        leaseToken: token,
        leaseUntil: new Date(now.getTime() + leaseSeconds * 1000),
      },
      job.state === 'LEASED' ? 'LEASE_RECOVERED' : 'CLAIMED',
    );
    return { id: job.id, attemptId: job.attemptId, warehouseId: job.warehouseId, token };
  });
}
export async function finishPaymentQueryLab(
  db: ReturnType<typeof createDatabase>,
  lease: QueryLabLease,
  scenario = 'NOTPAY',
): Promise<boolean> {
  const fixture = paymentAdapterCases.find((c) => c.code === scenario);
  if (!fixture) throw Error('INVALID_QUERY_SCENARIO');
  // Fixed in-memory fixtures only. Query outside the transaction, then validate the lease again.
  const result = await executePaymentQuery(fixture.adapter, adapterFixtureBinding, fixture.timeout);
  return db.$transaction(async (tx) => {
    const warehouses = await tx.$queryRaw<
      { enabled: boolean }[]
    >`SELECT enabled FROM warehouses WHERE id=${lease.warehouseId}::uuid FOR SHARE`;
    if (!warehouses[0]?.enabled) return false;
    // Match API writer order: attempt first, task second. Claims only hold task locks.
    await tx.$queryRaw`SELECT id FROM payment_attempt_labs WHERE id=${lease.attemptId}::uuid AND warehouse_id=${lease.warehouseId}::uuid FOR UPDATE`;
    await tx.$queryRaw`SELECT id FROM payment_query_lab_jobs WHERE id=${lease.id}::uuid FOR UPDATE`;
    const job = await tx.paymentQueryLabJob.findUnique({ where: { id: lease.id } }),
      attempt = await tx.paymentAttemptLab.findUnique({ where: { id: lease.attemptId } });
    const [{ now }] = await tx.$queryRaw<[{ now: Date }]>`SELECT clock_timestamp() AS now`;
    if (
      !job ||
      !attempt ||
      job.attemptId !== lease.attemptId ||
      job.warehouseId !== lease.warehouseId ||
      job.state !== 'LEASED' ||
      job.leaseToken !== lease.token ||
      !job.leaseUntil ||
      job.leaseUntil <= now
    )
      return false;
    if (
      (attempt.evidence !== 'UNKNOWN' && result.evidence === 'UNKNOWN') ||
      attempt.version >= 100
    ) {
      await change(
        tx,
        job,
        {
          state: attempt.evidence === 'CONFLICT' ? 'REVIEW' : 'DONE',
          leaseToken: null,
          leaseUntil: null,
        },
        attempt.evidence !== 'UNKNOWN' ? 'STOPPED_KNOWN' : 'EVENT_LIMIT',
        lease.token,
      );
      return true;
    }
    // Synthetic evidence only; never linked to an order or real funds.
    const evidence = mergePaymentEvidence(attempt.evidence, result.evidence),
      version = attempt.version + 1,
      eventId = randomUUID();
    await tx.paymentAttemptLab.update({ where: { id: attempt.id }, data: { evidence, version } });
    await tx.paymentAttemptLabEvent.create({
      data: {
        id: eventId,
        attemptId: attempt.id,
        key: lease.token,
        action:
          result.evidence === 'SUCCEEDED'
            ? 'SUCCESS_RESULT'
            : result.evidence === 'CLOSED'
              ? 'CLOSED_RESULT'
              : 'UNKNOWN_RESULT',
        observation: result.evidence,
        evidence,
        version,
      },
    });
    await change(
      tx,
      job,
      {
        state:
          evidence === 'CONFLICT' || result.next === 'REVIEW'
            ? 'REVIEW'
            : result.next === 'RECONCILE'
              ? 'DONE'
              : job.attempts >= 3
                ? 'EXHAUSTED'
                : 'RETRY',
        leaseToken: null,
        leaseUntil: null,
        nextRunAt: new Date(now.getTime() + (job.attempts === 1 ? 1000 : 5000)),
      },
      evidence === 'CONFLICT' || result.next === 'REVIEW'
        ? 'REVIEW_REQUIRED'
        : result.next === 'RECONCILE'
          ? 'CLASSIFIED_KNOWN'
          : job.attempts >= 3
            ? 'EXHAUSTED_UNKNOWN'
            : 'RETRY_UNKNOWN',
      lease.token,
      eventId,
      result,
      scenario,
    );
    return true;
  });
}
export async function runPaymentQueryLabOnce(
  db: ReturnType<typeof createDatabase>,
  warehouseId?: string,
  scenario = 'NOTPAY',
) {
  if (!paymentAdapterCases.some((c) => c.code === scenario)) throw Error('INVALID_QUERY_SCENARIO');
  const lease = await claimPaymentQueryLab(db, warehouseId);
  if (!lease) return { processed: false };
  return { processed: await finishPaymentQueryLab(db, lease, scenario) };
}
export async function retryPaymentQueryLab(
  tx: Tx,
  attempt: { id: string; warehouseId: string; evidence: string },
  key: string,
) {
  let job = await tx.paymentQueryLabJob.findUnique({ where: { attemptId: attempt.id } });
  if (job) {
    await tx.$queryRaw`SELECT id FROM payment_query_lab_jobs WHERE id=${job.id}::uuid FOR UPDATE`;
    job = await tx.paymentQueryLabJob.findUniqueOrThrow({ where: { id: job.id } });
    const old = await tx.paymentQueryLabEvent.findUnique({
      where: { jobId_key: { jobId: job.id, key } },
    });
    if (old) {
      if (old.reason !== 'MANUAL_RETRY') throw Error('QUERY_KEY_CONFLICT');
      return false;
    }
  }
  if (attempt.evidence !== 'UNKNOWN' || (job && job.state !== 'EXHAUSTED'))
    throw Error('QUERY_RETRY_NOT_ALLOWED');
  if (!job) {
    job = (await schedulePaymentQueryLab(tx, attempt)) ?? null;
    if (!job) throw Error('QUERY_RETRY_NOT_ALLOWED');
  }
  const [{ now }] = await tx.$queryRaw<[{ now: Date }]>`SELECT clock_timestamp() AS now`;
  await change(
    tx,
    job,
    { state: 'RETRY', attempts: 0, nextRunAt: now, leaseToken: null, leaseUntil: null },
    'MANUAL_RETRY',
    key,
  );
  return true;
}

/** Caller already holds the attempt lock; preserve an existing manual-review requirement. */
export async function settleQueryLabFromNotification(
  tx: Tx,
  attempt: { id: string; evidence: string },
  eventId: string,
) {
  await tx.$queryRaw`SELECT id FROM payment_query_lab_jobs WHERE attempt_id=${attempt.id}::uuid FOR UPDATE`;
  const job = await tx.paymentQueryLabJob.findUnique({ where: { attemptId: attempt.id } });
  if (!job) return;
  const state = attempt.evidence === 'CONFLICT' || job.state === 'REVIEW' ? 'REVIEW' : 'DONE';
  await change(
    tx,
    job,
    { state, leaseToken: null, leaseUntil: null },
    'NOTIFICATION_EVIDENCE',
    randomUUID(),
    eventId,
  );
}
