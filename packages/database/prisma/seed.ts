import { createDatabase } from '../src/index.js';

if (process.env.NODE_ENV === 'production') throw new Error('Development seed is disabled in production.');
const url = new URL(process.env.DATABASE_URL ?? '');
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/yumi_dev') throw new Error('Seed only permits the isolated local development database.');
const db = createDatabase(url.toString());
try {
  const id = '00000000-0000-4000-8000-000000000001';
  await db.validationStock.upsert({ where: { id }, create: { id, label: 'S0 development fixture (not a real saleable SKU)', onHand: 10 }, update: {} });
  console.log('S0 development fixture ready; existing stock quantities preserved.');
} finally { await db.$disconnect(); }
