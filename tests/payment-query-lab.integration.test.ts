import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { orderAdminFixture } from './helpers/order-admin-fixture.ts';
import {
  claimPaymentQueryLab,
  finishPaymentQueryLab,
  runPaymentQueryLabOnce,
  createDatabase,
  paymentQueryLabWorkerEnabled,
} from '../packages/database/dist/index.js';
let f: Awaited<ReturnType<typeof orderAdminFixture>>, csrf: string;
const base = (s = '') => '/admin/payment-attempt-lab' + s + '?warehouseId=' + f.warehouseId;
async function post(s = '', body: unknown = {}, cookie = f.extraCookies[0]!, token = csrf) {
  const r = await fetch(f.base + '/api/v1' + base(s), {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: 'http://127.0.0.1:5188',
      'X-CSRF-Token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, ...(await r.json()) };
}
async function unknown() {
  const a = await post('', { key: randomUUID() }),
    id = a.data.attempt.id;
  assert.equal(
    (await post('/' + id + '/actions/unknown-result', { key: randomUUID() })).status,
    200,
  );
  return id as string;
}
async function job() {
  return f.runtime.db.paymentQueryLabJob.findFirstOrThrow();
}
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
beforeEach(async () => {
  f = await orderAdminFixture({ notificationLab: true });
  csrf = (await f.staff('/staff/me', f.extraCookies[0]!)).data.csrfToken;
});
afterEach(async () => {
  if (f) await f.cleanup();
});
test('unknown observations atomically schedule once; admin scope/CSRF/strict action guards apply', async () => {
  const id = await unknown();
  await post('/' + id + '/actions/unknown-result', { key: randomUUID() });
  assert.equal(await f.runtime.db.paymentQueryLabJob.count(), 1);
  assert.equal(await f.runtime.db.paymentQueryLabEvent.count(), 1);
  assert.equal((await post('/run-query-cycle', {}, '', csrf)).status, 401);
  assert.equal((await post('/run-query-cycle', {}, f.cookies[0]!)).status, 403);
  assert.equal((await post('/run-query-cycle', {}, f.extraCookies[0]!, '')).status, 403);
  assert.equal((await post('/run-query-cycle', { result: 'SUCCEEDED' })).status, 400);
  assert.equal((await post('/' + id + '/retry-query', { key: randomUUID() })).status, 409);
  const info = (await f.staff(base('/' + id), f.extraCookies[0]!)).data;
  assert.equal(info.queryJob.state, 'RETRY');
  assert.equal(info.releaseAllowed, false);
  assert.ok(!JSON.stringify(info).includes('leaseToken'));
});
test('competing workers claim once; bounded retries exhaust and original manual retry key is idempotent', async () => {
  const id = await unknown(),
    leases = await Promise.all(
      Array.from({ length: 8 }, () => claimPaymentQueryLab(f.runtime.db, f.warehouseId)),
    );
  assert.equal(leases.filter(Boolean).length, 1);
  assert.equal(await finishPaymentQueryLab(f.runtime.db, leases.find(Boolean)!), true);
  assert.equal(await finishPaymentQueryLab(f.runtime.db, leases.find(Boolean)!), false);
  assert.equal((await runPaymentQueryLabOnce(f.runtime.db, f.warehouseId)).processed, false);
  await pause(1100);
  assert.equal((await runPaymentQueryLabOnce(f.runtime.db, f.warehouseId)).processed, true);
  await pause(5100);
  assert.equal((await runPaymentQueryLabOnce(f.runtime.db, f.warehouseId)).processed, true);
  assert.equal((await job()).state, 'EXHAUSTED');
  assert.equal((await job()).attempts, 3);
  assert.equal(
    (await f.runtime.db.paymentAttemptLab.findUniqueOrThrow({ where: { id } })).evidence,
    'UNKNOWN',
  );
  const key = randomUUID();
  assert.equal((await post('/' + id + '/retry-query', { key })).status, 200);
  const version = (await job()).version;
  assert.equal((await post('/' + id + '/retry-query', { key })).status, 200);
  assert.equal((await job()).version, version);
  assert.equal((await job()).attempts, 0);
});
test('expired lease survives a new database client; old owner cannot append after reclaim', async () => {
  await unknown();
  const old = await claimPaymentQueryLab(f.runtime.db, f.warehouseId, 1);
  assert.ok(old);
  await pause(1100);
  const rows = await f.runtime.db.$queryRaw<
    { schema: string }[]
  >`SELECT current_schema() AS schema`;
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.searchParams.set('schema', rows[0]!.schema);
  const other = createDatabase(url.toString());
  try {
    const fresh = await claimPaymentQueryLab(other, f.warehouseId);
    assert.ok(fresh);
    assert.notEqual(old.token, fresh.token);
    const count = await f.runtime.db.paymentAttemptLabEvent.count();
    assert.equal(await finishPaymentQueryLab(f.runtime.db, old), false);
    assert.equal(await f.runtime.db.paymentAttemptLabEvent.count(), count);
    assert.equal(await finishPaymentQueryLab(other, fresh), true);
    assert.equal(
      await f.runtime.db.paymentQueryLabEvent.count({ where: { reason: 'LEASE_RECOVERED' } }),
      1,
    );
  } finally {
    await other.$disconnect();
  }
});
test('known result during an outstanding query stops work and cannot be downgraded by worker', async () => {
  const id = await unknown(),
    lease = await claimPaymentQueryLab(f.runtime.db, f.warehouseId);
  assert.ok(lease);
  await post('/' + id + '/actions/closed-result', { key: randomUUID() });
  const count = await f.runtime.db.paymentAttemptLabEvent.count();
  assert.equal(await finishPaymentQueryLab(f.runtime.db, lease), true);
  assert.equal((await job()).state, 'DONE');
  assert.equal(await f.runtime.db.paymentAttemptLabEvent.count(), count);
  assert.equal(
    (await f.runtime.db.paymentAttemptLab.findUniqueOrThrow({ where: { id } })).evidence,
    'CLOSED',
  );
  assert.equal((await post('/' + id + '/retry-query', { key: randomUUID() })).status, 409);
});
test('late result-history failure rolls back evidence and task completion; same valid lease can retry', async () => {
  await unknown();
  const lease = await claimPaymentQueryLab(f.runtime.db, f.warehouseId);
  assert.ok(lease);
  const count = await f.runtime.db.paymentAttemptLabEvent.count();
  await f.runtime.db.$executeRawUnsafe(
    `CREATE FUNCTION reject_query_result_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.reason='RETRY_UNKNOWN' THEN RAISE EXCEPTION 'isolated test rollback'; END IF; RETURN NEW; END $$`,
  );
  await f.runtime.db.$executeRawUnsafe(
    `CREATE TRIGGER reject_query_result_test BEFORE INSERT ON payment_query_lab_events FOR EACH ROW EXECUTE FUNCTION reject_query_result_test()`,
  );
  await assert.rejects(() => finishPaymentQueryLab(f.runtime.db, lease));
  assert.equal((await job()).state, 'LEASED');
  assert.equal(await f.runtime.db.paymentAttemptLabEvent.count(), count);
  await f.runtime.db.$executeRawUnsafe(
    'DROP TRIGGER reject_query_result_test ON payment_query_lab_events',
  );
  assert.equal(await finishPaymentQueryLab(f.runtime.db, lease), true);
  assert.equal(await f.runtime.db.paymentAttemptLabEvent.count(), count + 1);
});
test('database rejects unlogged updates and history mutation; disabled warehouse cannot be claimed', async () => {
  await unknown();
  const row = await job();
  await assert.rejects(() =>
    f.runtime.db.paymentQueryLabJob.update({
      where: { id: row.id },
      data: { version: 1, state: 'DONE' },
    }),
  );
  await assert.rejects(() =>
    f.runtime.db.paymentQueryLabEvent.deleteMany({ where: { jobId: row.id } }),
  );
  await assert.rejects(() =>
    f.runtime.db.paymentQueryLabEvent.updateMany({
      where: { jobId: row.id },
      data: { state: 'DONE' },
    }),
  );
  await assert.rejects(() => f.runtime.db.paymentQueryLabJob.delete({ where: { id: row.id } }));
  await f.runtime.db.warehouse.update({ where: { id: f.warehouseId }, data: { enabled: false } });
  assert.equal(await claimPaymentQueryLab(f.runtime.db, f.warehouseId), null);
  await f.runtime.db.warehouse.update({ where: { id: f.warehouseId }, data: { enabled: true } });
  const lease = await claimPaymentQueryLab(f.runtime.db, f.warehouseId);
  assert.ok(lease);
  await f.runtime.db.warehouse.update({ where: { id: f.warehouseId }, data: { enabled: false } });
  assert.equal(await finishPaymentQueryLab(f.runtime.db, lease), false);
});
test('third abandoned lease exhausts without stale writes; query history remains explicit', async () => {
  await unknown();
  let lease = await claimPaymentQueryLab(f.runtime.db, f.warehouseId, 1);
  await pause(1100);
  lease = await claimPaymentQueryLab(f.runtime.db, f.warehouseId, 1);
  await pause(1100);
  lease = await claimPaymentQueryLab(f.runtime.db, f.warehouseId, 1);
  assert.ok(lease);
  await pause(1100);
  assert.equal(await claimPaymentQueryLab(f.runtime.db, f.warehouseId), null);
  assert.equal((await job()).state, 'EXHAUSTED');
  assert.equal(await finishPaymentQueryLab(f.runtime.db, lease), false);
  assert.equal(
    await f.runtime.db.paymentQueryLabEvent.count({ where: { reason: 'LEASE_EXHAUSTED' } }),
    1,
  );
});
test('real worker entry point processes synthetic tasks with explicit opt-in and preserves business state', async () => {
  await unknown();
  const stock = await f.runtime.db.stockBalance.findMany({ orderBy: { skuId: 'asc' } }),
    ledger = await f.runtime.db.stockLedger.count();
  const rows = await f.runtime.db.$queryRaw<
    { schema: string }[]
  >`SELECT current_schema() AS schema`;
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.searchParams.set('schema', rows[0]!.schema);
  const child = spawn(process.execPath, ['apps/worker/dist/main.js'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DATABASE_URL: url.toString(),
      PAYMENT_MODE: 'disabled',
      PAYMENT_NOTIFICATION_LAB_ENABLED: '1',
      PAYMENT_QUERY_LAB_WORKER_ENABLED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (b) => (log += String(b)));
  child.stderr.on('data', (b) => (log += String(b)));
  const closed = new Promise<void>((r) => child.once('exit', () => r()));
  try {
    for (let i = 0; i < 60 && (await job()).attempts === 0; i++) await pause(100);
    assert.ok((await job()).attempts >= 1);
    assert.match(log, /Synthetic payment-query lab worker enabled/);
  } finally {
    child.kill('SIGTERM');
    await closed;
  }
  assert.deepEqual(await f.runtime.db.stockBalance.findMany({ orderBy: { skuId: 'asc' } }), stock);
  assert.equal(await f.runtime.db.stockLedger.count(), ledger);
  assert.equal(await f.runtime.db.consumerOrder.count(), 0);
  assert.equal(await f.runtime.db.paymentPreparation.count(), 0);
});
test('automatic worker gate is default off and rejects production, remote database or missing isolation', () => {
  assert.equal(paymentQueryLabWorkerEnabled({}), false);
  for (const env of [
    { PAYMENT_QUERY_LAB_WORKER_ENABLED: 'yes' },
    {
      PAYMENT_QUERY_LAB_WORKER_ENABLED: '1',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      NODE_ENV: 'production',
    },
    {
      PAYMENT_QUERY_LAB_WORKER_ENABLED: '1',
      DATABASE_URL: 'postgresql://local@remote.invalid/yumi_test',
      PAYMENT_MODE: 'disabled',
      PAYMENT_NOTIFICATION_LAB_ENABLED: '1',
    },
    {
      PAYMENT_QUERY_LAB_WORKER_ENABLED: '1',
      DATABASE_URL: process.env.TEST_DATABASE_URL,
      PAYMENT_MODE: 'disabled',
    },
  ])
    assert.throws(() => paymentQueryLabWorkerEnabled(env));
});

test('migration backfills a pre-existing isolated UNKNOWN attempt with paired durable task history', async () => {
  const { Client } = createRequire(import.meta.url)('pg'),
    client = new Client({ connectionString: process.env.TEST_DATABASE_URL }),
    schema = 'query_migration_' + randomUUID().replaceAll('-', '');
  await client.connect();
  try {
    await client.query('CREATE SCHEMA ' + schema);
    await client.query('SET search_path TO ' + schema);
    const dirs = (await readdir('packages/database/prisma/migrations'))
      .filter((n) => /^\d/.test(n))
      .sort();
    for (const dir of dirs.filter((n) => n < '202611010005_payment_query_labs'))
      await client.query(
        await readFile('packages/database/prisma/migrations/' + dir + '/migration.sql', 'utf8'),
      );
    const w = randomUUID(),
      a = randomUUID(),
      key = randomUUID();
    await client.query('BEGIN');
    await client.query('INSERT INTO warehouses(id,code,name) VALUES($1,$2,$3)', [
      w,
      'QUERY-MIGRATION',
      '合成迁移仓',
    ]);
    await client.query(
      "INSERT INTO payment_attempt_labs(id,warehouse_id,key,evidence,version) VALUES($1,$2,$3,'UNKNOWN',1)",
      [a, w, key],
    );
    await client.query(
      "INSERT INTO payment_attempt_lab_events(id,attempt_id,key,action,observation,evidence,version) VALUES($1,$2,$3,'STARTED','NONE','NONE',0),($4,$2,$5,'UNKNOWN_RESULT','UNKNOWN','UNKNOWN',1)",
      [randomUUID(), a, key, randomUUID(), randomUUID()],
    );
    await client.query('COMMIT');
    await client.query(
      await readFile(
        'packages/database/prisma/migrations/202611010005_payment_query_labs/migration.sql',
        'utf8',
      ),
    );
    const rows = await client.query(
      'SELECT j.state,j.attempts,e.reason FROM payment_query_lab_jobs j JOIN payment_query_lab_events e ON e.job_id=j.id',
    );
    assert.deepEqual(rows.rows, [{ state: 'RETRY', attempts: 0, reason: 'SCHEDULED' }]);
  } finally {
    await client.query('ROLLBACK');
    await client.query('DROP SCHEMA IF EXISTS ' + schema + ' CASCADE');
    await client.end();
  }
});
