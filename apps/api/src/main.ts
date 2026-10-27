import { createApplication } from './app.js';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required. Run local setup first.');
if (process.env.PAYMENT_MODE !== 'disabled')
  throw new Error('S0 application requires PAYMENT_MODE=disabled.');
const runtime = await createApplication(process.env.DATABASE_URL);
await runtime.app.listen(Number(process.env.API_PORT ?? 3000), process.env.API_HOST ?? '127.0.0.1');
console.log('Yumi API ready on loopback; payment integration is disabled.');
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, async () => {
    await runtime.close();
    process.exit(0);
  });
