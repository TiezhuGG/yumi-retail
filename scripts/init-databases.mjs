import { existsSync } from 'node:fs';
import pg from 'pg';

if (existsSync('.env')) process.loadEnvFile('.env');
const dev = new URL(process.env.DATABASE_URL ?? '');
const test = new URL(process.env.TEST_DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(dev.hostname) || dev.hostname !== test.hostname || test.pathname !== '/yumi_test' || dev.pathname !== '/yumi_dev') {
  throw new Error('Local database initialization only permits yumi_dev/yumi_test on the same loopback host.');
}
const pool = new pg.Pool({ connectionString: dev.toString(), max: 1, connectionTimeoutMillis: 5000 });
try {
  const found = await pool.query('SELECT 1 FROM pg_database WHERE datname=$1', ['yumi_test']);
  if (found.rowCount === 0) await pool.query('CREATE DATABASE yumi_test');
  console.log('Local development and isolated test databases are ready.');
} finally { await pool.end(); }
