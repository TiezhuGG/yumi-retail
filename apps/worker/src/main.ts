import { createDatabase } from '@yumi/database';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required.');
if (process.env.PAYMENT_MODE !== 'disabled')
  throw new Error('S0 worker requires PAYMENT_MODE=disabled.');
const db = createDatabase(process.env.DATABASE_URL);
await db.$queryRaw`SELECT 1`;
console.log('Yumi worker connected. Business jobs are not implemented in S0.');
const timer = setInterval(async () => {
  try {
    await db.$queryRaw`SELECT 1`;
  } catch {
    console.error('Worker database health check failed.');
  }
}, 30000);
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, async () => {
    clearInterval(timer);
    await db.$disconnect();
    process.exit(0);
  });
