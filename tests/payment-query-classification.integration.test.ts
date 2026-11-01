import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { orderAdminFixture } from './helpers/order-admin-fixture.ts';
import {
  claimPaymentQueryLab,
  finishPaymentQueryLab,
  runPaymentQueryLabOnce,
  createDatabase,
} from '../packages/database/dist/index.js';
let f: Awaited<ReturnType<typeof orderAdminFixture>>, csrf: string;
const path = (s = '') => '/admin/payment-attempt-lab' + s + '?warehouseId=' + f.warehouseId;
async function post(s: string, body: unknown, cookie = f.extraCookies[0]!, token = csrf) {
  const r = await fetch(f.base + '/api/v1' + path(s), {
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
  const r = await post('', { key: randomUUID() });
  const id = r.data.attempt.id as string;
  assert.equal(
    (await post('/' + id + '/actions/unknown-result', { key: randomUUID() })).status,
    200,
  );
  return id;
}
const job = () => f.runtime.db.paymentQueryLabJob.findFirstOrThrow();
const last = () =>
  f.runtime.db.paymentQueryLabEvent.findFirstOrThrow({
    where: { classification: { not: null } },
    orderBy: { createdAt: 'desc' },
  });
beforeEach(async () => {
  f = await orderAdminFixture({ notificationLab: true });
  csrf = (await f.staff('/staff/me', f.extraCookies[0]!)).data.csrfToken;
});
afterEach(async () => {
  if (f) await f.cleanup();
});
test('strict synthetic scenarios cannot inject responses, bypass roles or consume a lease on invalid input', async () => {
  await unknown();
  for (const body of [
    { scenario: 'real' },
    { scenario: 1 },
    { scenario: 'SUCCESS', rawBody: 'x' },
    { next: 'RECONCILE' },
  ])
    assert.equal((await post('/run-query-cycle', body)).status, 400);
  assert.equal(
    (await post('/run-query-cycle', { scenario: 'SUCCESS' }, f.cookies[0]!)).status,
    403,
  );
  assert.equal(
    (await post('/run-query-cycle', { scenario: 'SUCCESS' }, f.extraCookies[0]!, '')).status,
    403,
  );
  assert.equal((await job()).attempts, 0);
  const info = (await f.staff(path(), f.extraCookies[0]!)).data;
  assert.equal(info.queryScenarios.length, 17);
  assert.equal((await post('/run-query-cycle', { scenario: 'RATE' })).status, 200);
  const e = await last();
  assert.equal(e.classification, 'RATE_LIMIT');
  assert.equal(e.next, 'RETRY');
  assert.equal(e.resultEvidence, 'UNKNOWN');
  assert.equal(e.scenario, 'RATE');
  assert.equal(e.state, 'RETRY');
  assert.ok(e.attemptEventId);
  assert.equal((await job()).attempts, 1);
  assert.equal((await job()).state, 'RETRY');
  assert.equal((await post('/run-query-cycle', { scenario: 'SUCCESS' })).data.processed, false);
});
test('review classification stops automatic claiming, prohibits retry override and supports review notes snapshot', async () => {
  const id = await unknown();
  await post('/run-query-cycle', { scenario: 'MISSING' });
  assert.equal((await job()).state, 'REVIEW');
  assert.equal((await last()).classification, 'NOT_FOUND');
  assert.equal(await claimPaymentQueryLab(f.runtime.db, f.warehouseId), null);
  assert.equal((await post('/' + id + '/retry-query', { key: randomUUID() })).status, 409);
  const list = await f.staff(
    '/admin/payment-review-lab?warehouseId=' + f.warehouseId + '&filter=REVIEW',
    f.extraCookies[0]!,
  );
  assert.equal(list.data.items.length, 1);
  const a = list.data.items[0];
  const r = await fetch(
    f.base + '/api/v1/admin/payment-review-lab/' + id + '/notes?warehouseId=' + f.warehouseId,
    {
      method: 'POST',
      headers: {
        Cookie: f.extraCookies[0]!,
        Origin: 'http://127.0.0.1:5188',
        'X-CSRF-Token': csrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        key: randomUUID(),
        note: '合成查询核查，仍保留未知',
        attemptVersion: a.attemptVersion,
        jobVersion: a.jobVersion,
      }),
    },
  );
  assert.equal(r.status, 200);
  assert.equal((await job()).state, 'REVIEW');
  assert.equal((await f.runtime.db.paymentReviewLabNote.findFirstOrThrow()).taskState, 'REVIEW');
  await post('/' + id + '/actions/success-result', { key: randomUUID() });
  const retained = await f.staff(
    '/admin/payment-review-lab?warehouseId=' + f.warehouseId + '&filter=ALL',
    f.extraCookies[0]!,
  );
  assert.equal(retained.data.items.length, 1);
  assert.equal(retained.data.items[0].needsReview, true);
  assert.equal(retained.data.items[0].evidence, 'SUCCEEDED');
  assert.equal((await job()).state, 'REVIEW');
});
test('known synthetic query facts update experiment evidence and stop tasks without business writes', async () => {
  const initialLedgers = await f.runtime.db.stockLedger.count();
  for (const [scenario, evidence] of [
    ['SUCCESS', 'SUCCEEDED'],
    ['CLOSED', 'CLOSED'],
  ]) {
    const id = await unknown();
    const r = await post('/run-query-cycle', { scenario });
    assert.equal(r.status, 200);
    const a = await f.runtime.db.paymentAttemptLab.findUniqueOrThrow({ where: { id } });
    assert.equal(a.evidence, evidence);
    const j = await f.runtime.db.paymentQueryLabJob.findUniqueOrThrow({ where: { attemptId: id } });
    assert.equal(j.state, 'DONE');
    const detail = (await f.staff(path('/' + id), f.extraCookies[0]!)).data;
    assert.equal(detail.queryJob.events.at(-1).resultEvidence, evidence);
    assert.equal(detail.releaseAllowed, false);
  }
  assert.equal(await f.runtime.db.consumerOrder.count(), 0);
  assert.equal(await f.runtime.db.paymentPreparation.count(), 0);
  assert.equal(await f.runtime.db.stockLedger.count(), initialLedgers);
});
test('opposite known evidence arriving during query becomes conflict and review in either direction', async () => {
  for (const [manual, scenario] of [
    ['closed-result', 'SUCCESS'],
    ['success-result', 'CLOSED'],
  ]) {
    const id = await unknown(),
      lease = await claimPaymentQueryLab(f.runtime.db, f.warehouseId);
    assert.ok(lease);
    await post('/' + id + '/actions/' + manual, { key: randomUUID() });
    assert.equal(await finishPaymentQueryLab(f.runtime.db, lease, scenario), true);
    assert.equal(
      (await f.runtime.db.paymentAttemptLab.findUniqueOrThrow({ where: { id } })).evidence,
      'CONFLICT',
    );
    assert.equal(
      (await f.runtime.db.paymentQueryLabJob.findUniqueOrThrow({ where: { attemptId: id } })).state,
      'REVIEW',
    );
  }
});
test('expired and superseded leases cannot append classified success; current lease writes once', async () => {
  await unknown();
  const lease = await claimPaymentQueryLab(f.runtime.db, f.warehouseId, 1);
  assert.ok(lease);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(await finishPaymentQueryLab(f.runtime.db, lease, 'SUCCESS'), false);
  assert.equal(
    await f.runtime.db.paymentQueryLabEvent.count({ where: { classification: { not: null } } }),
    0,
  );
  const current = await claimPaymentQueryLab(f.runtime.db, f.warehouseId);
  assert.ok(current);
  assert.equal(await finishPaymentQueryLab(f.runtime.db, lease, 'SUCCESS'), false);
  assert.equal(await finishPaymentQueryLab(f.runtime.db, current, 'UNVERIFIED'), true);
  assert.equal(await finishPaymentQueryLab(f.runtime.db, current, 'SUCCESS'), false);
  assert.equal((await last()).classification, 'UNVERIFIED');
});
test('late classification insert failure rolls back evidence and task; lease retries atomically', async () => {
  const id = await unknown(),
    lease = await claimPaymentQueryLab(f.runtime.db, f.warehouseId);
  assert.ok(lease);
  const before = await job();
  await f.runtime.db.$executeRawUnsafe(
    "CREATE FUNCTION fail_classification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.classification IS NOT NULL THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$",
  );
  await f.runtime.db.$executeRawUnsafe(
    'CREATE TRIGGER fail_classification BEFORE INSERT ON payment_query_lab_events FOR EACH ROW EXECUTE FUNCTION fail_classification()',
  );
  await assert.rejects(() => finishPaymentQueryLab(f.runtime.db, lease, 'SUCCESS'));
  assert.equal((await job()).version, before.version);
  assert.equal((await job()).state, 'LEASED');
  assert.equal(
    (await f.runtime.db.paymentAttemptLab.findUniqueOrThrow({ where: { id } })).evidence,
    'UNKNOWN',
  );
  await f.runtime.db.$executeRawUnsafe(
    'DROP TRIGGER fail_classification ON payment_query_lab_events',
  );
  assert.equal(await finishPaymentQueryLab(f.runtime.db, lease, 'SUCCESS'), true);
});
test('classified history is immutable and survives a new client; malformed SQL classification is rejected', async () => {
  await unknown();
  await runPaymentQueryLabOnce(f.runtime.db, f.warehouseId, 'BINDING');
  const e = await last();
  await assert.rejects(() =>
    f.runtime.db.paymentQueryLabEvent.update({
      where: { id: e.id },
      data: { classification: 'SUCCEEDED' },
    }),
  );
  await assert.rejects(() => f.runtime.db.paymentQueryLabEvent.delete({ where: { id: e.id } }));
  const [{ schema }] = await f.runtime.db.$queryRaw<
    [{ schema: string }]
  >`SELECT current_schema() AS schema`;
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.searchParams.set('schema', schema);
  const other = createDatabase(url.toString());
  try {
    assert.equal(
      (await other.paymentQueryLabEvent.findUniqueOrThrow({ where: { id: e.id } })).classification,
      'BINDING_MISMATCH',
    );
  } finally {
    await other.$disconnect();
  }
  await assert.rejects(() =>
    f.runtime.db.$executeRawUnsafe(
      "INSERT INTO payment_query_lab_events(id,job_id,key,reason,state,attempts,version,classification,result_evidence,next,scenario) VALUES($1::uuid,$2::uuid,$3::uuid,'REVIEW_REQUIRED','REVIEW',1,99,'SUCCEEDED','UNKNOWN','REVIEW','SUCCESS')",
      randomUUID(),
      e.jobId,
      randomUUID(),
    ),
  );
  const schedule = await f.runtime.db.paymentQueryLabEvent.findFirstOrThrow({
    where: { reason: 'SCHEDULED' },
  });
  assert.equal(schedule.classification, null);
  assert.equal(schedule.scenario, null);
});
test('competing cycles persist one classification and exhausted retries retain all observations', async () => {
  await unknown();
  const r = await Promise.all(
    Array.from({ length: 6 }, () => runPaymentQueryLabOnce(f.runtime.db, f.warehouseId, 'SERVER')),
  );
  assert.equal(r.filter((x) => x.processed).length, 1);
  await new Promise((r) => setTimeout(r, 1100));
  await runPaymentQueryLabOnce(f.runtime.db, f.warehouseId, 'NETWORK');
  await new Promise((r) => setTimeout(r, 5100));
  await runPaymentQueryLabOnce(f.runtime.db, f.warehouseId, 'TIMEOUT');
  assert.equal((await job()).state, 'EXHAUSTED');
  assert.equal(
    await f.runtime.db.paymentQueryLabEvent.count({ where: { classification: { not: null } } }),
    3,
  );
  const lastEvent = await last();
  assert.equal(lastEvent.classification, 'TIMEOUT');
  assert.equal(lastEvent.next, 'RETRY');
  assert.equal(lastEvent.state, 'EXHAUSTED');
});
