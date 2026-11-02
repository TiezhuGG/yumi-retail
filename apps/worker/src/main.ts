import {
  createDatabase,
  redemptionPickingWorkerEnabled,
  runRedemptionPickingOnce,
  expireUnpaidOrders,
  paymentQueryLabWorkerEnabled,
  runPaymentQueryLabOnce,
} from '@yumi/database';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
if (process.env.PAYMENT_MODE !== 'disabled')
  throw new Error('Worker foundation requires PAYMENT_MODE=disabled.');
const redemptionPickingEnabled = redemptionPickingWorkerEnabled(process.env);
const queryLabEnabled = paymentQueryLabWorkerEnabled(process.env);
const db = createDatabase(process.env.DATABASE_URL);
await db.$queryRaw`SELECT 1`;
console.log('Yumi worker connected. Expires unpaid orders only when payment was never started.');
if (redemptionPickingEnabled)
  console.log(
    'Redemption source picking materialization enabled; no outbound stock or delivery actions.',
  );
if (queryLabEnabled)
  console.log('Synthetic payment-query lab worker enabled; no channel requests.');
let running: Promise<void> | null = null,
  stopping = false;
const tick = () => {
  if (stopping || running) return;
  running = (async () => {
    await db.$queryRaw`SELECT 1`;
    await expireUnpaidOrders(db);
    if (queryLabEnabled) await runPaymentQueryLabOnce(db);
    if (redemptionPickingEnabled) await runRedemptionPickingOnce(db);
  })()
    .catch(() => {
      console.error('Worker local health/order-expiry/query/redemption job failed; will retry.');
    })
    .finally(() => {
      running = null;
    });
};
tick();
const timer = setInterval(tick, queryLabEnabled || redemptionPickingEnabled ? 1000 : 30000);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, async () => {
    stopping = true;
    clearInterval(timer);
    if (running) await running;
    await db.$disconnect();
    process.exit(0);
  });
