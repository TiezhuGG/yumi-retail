import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';

if (existsSync('.env')) {
  console.log('Existing .env preserved.');
} else {
  const password = randomBytes(24).toString('hex');
  const base = `postgresql://yumi_local:${password}@127.0.0.1:55432/`;
  writeFileSync('.env', [
    'POSTGRES_USER=yumi_local', `POSTGRES_PASSWORD=${password}`,
    'POSTGRES_DB=yumi_dev', 'POSTGRES_PORT=55432',
    `DATABASE_URL=${base}yumi_dev`, `TEST_DATABASE_URL=${base}yumi_test`,
    'API_HOST=127.0.0.1', 'API_PORT=3000', 'NODE_ENV=development',
    'PAYMENT_MODE=disabled', '',
  ].join('\n'), { flag: 'wx', mode: 0o600 });
  console.log('Created ignored .env with random local-only credentials; values are not logged.');
}
