import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';

if (existsSync('.env')) {
  console.log('Existing .env preserved.');
} else {
  const password = randomBytes(24).toString('hex');
  const base = `postgresql://yumi_local:${password}@127.0.0.1:55432/`;
  writeFileSync(
    '.env',
    [
      'POSTGRES_USER=yumi_local',
      `POSTGRES_PASSWORD=${password}`,
      'POSTGRES_DB=yumi_dev',
      'POSTGRES_PORT=55432',
      `DATABASE_URL=${base}yumi_dev`,
      `TEST_DATABASE_URL=${base}yumi_test`,
      'API_HOST=127.0.0.1',
      'API_PORT=3000',
      'NODE_ENV=development',
      'PAYMENT_MODE=disabled',
      '',
    ].join('\n'),
    { flag: 'wx', mode: 0o600 },
  );
  console.log('Created ignored .env with random local-only credentials; values are not logged.');
}

const existing = readFileSync('.env', 'utf8');
const defaults = {
  LOCAL_ADMIN_LOGIN: 'admin.local',
  LOCAL_ADMIN_PASSWORD: randomBytes(18).toString('hex'),
  LOCAL_WAREHOUSE_LOGIN: 'warehouse.local',
  LOCAL_WAREHOUSE_PASSWORD: randomBytes(18).toString('hex'),
  LOCAL_RIDER_LOGIN: 'rider.local',
  LOCAL_RIDER_PASSWORD: randomBytes(18).toString('hex'),
};
const additions = Object.entries(defaults).filter(
  ([key]) => !new RegExp(`^${key}=`, 'm').test(existing),
);
if (additions.length)
  appendFileSync(
    '.env',
    '\n' + additions.map(([key, value]) => `${key}=${value}`).join('\n') + '\n',
  );
console.log(
  'Local staff configuration is ready in ignored .env; credential values are not logged.',
);
