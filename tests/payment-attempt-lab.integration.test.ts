import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { orderAdminFixture } from './helpers/order-admin-fixture.ts';
import { PaymentAttemptLabService } from '../apps/api/dist/payment-attempt-lab.js';
import { CatalogService } from '../apps/api/dist/catalog-service.js';
import { createApplication } from '../apps/api/dist/app.js';
import { applicationConfig } from '../apps/api/dist/config.js';
import { mergePaymentEvidence } from '../packages/database/dist/index.js';
import type { ApiRequest } from '../apps/api/src/http.js';
let f: Awaited<ReturnType<typeof orderAdminFixture>>,
  csrf: string,
  service: PaymentAttemptLabService,
  request: ApiRequest,
  stock: unknown;
const root = '/admin/payment-attempt-lab';
const path = (suffix = '') => root + suffix + '?warehouseId=' + f.warehouseId;
async function post(
  body: unknown = { key: randomUUID() },
  suffix = '',
  cookie = f.extraCookies[0]!,
  token = csrf,
  origin = 'http://127.0.0.1:5188',
) {
  const r = await fetch(f.base + '/api/v1' + path(suffix), {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: origin,
      'X-CSRF-Token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, ...(await r.json()) };
}
const action = (id: string, a: string, key = randomUUID()) =>
  post({ key }, '/' + id + '/actions/' + a);
const snapshot = async () => ({
  balances: await f.runtime.db.stockBalance.findMany({
    orderBy: [{ warehouseId: 'asc' }, { skuId: 'asc' }],
  }),
  ledgers: await f.runtime.db.stockLedger.count(),
});
before(async () => {
  f = await orderAdminFixture({ notificationLab: true });
  const me = (await f.staff('/staff/me', f.extraCookies[0]!)).data;
  csrf = me.csrfToken;
  request = {
    method: 'POST',
    headers: {},
    socket: {},
    requestId: randomUUID(),
    staffContext: { ...me, staffId: me.id, sessionId: randomUUID() },
  };
  service = new PaymentAttemptLabService(new CatalogService(f.runtime.db), true);
  stock = await snapshot();
});
after(async () => {
  if (f) await f.cleanup();
});
test('scope, role, CSRF, origin and strictly named synthetic actions are enforced', async () => {
  assert.equal((await f.staff(path(), '')).status, 401);
  for (const cookie of [...f.cookies, f.extraCookies[1]!])
    assert.equal((await f.staff(path(), cookie)).status, 403);
  assert.equal((await post({ key: randomUUID() }, '', f.extraCookies[0]!, '')).status, 403);
  assert.equal(
    (await post({ key: randomUUID() }, '', f.extraCookies[0]!, csrf, 'http://untrusted.invalid'))
      .status,
    403,
  );
  for (const body of [
    {},
    { key: 'bad' },
    { key: randomUUID(), orderId: randomUUID() },
    { key: randomUUID(), evidence: 'SUCCEEDED' },
  ])
    assert.equal((await post(body)).status, 400);
  assert.equal(
    (await f.staff(root + '?warehouseId=' + randomUUID(), f.extraCookies[0]!)).status,
    403,
  );
  assert.equal((await f.staff(path() + '&evidence=UNKNOWN', f.extraCookies[0]!)).status, 400);
  assert.equal((await action(randomUUID(), 'paid')).status, 400);
  assert.equal((await action(randomUUID(), 'success-result')).status, 404);
});
test('concurrent creation and repeated unknown result append only once with paired audit', async () => {
  const key = randomUUID(),
    results = await Promise.all(Array.from({ length: 6 }, () => post({ key })));
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(results.filter((r) => !r.data.duplicate).length, 1);
  assert.equal(new Set(results.map((r) => r.data.attempt.id)).size, 1);
  const id = results[0]!.data.attempt.id,
    eventKey = randomUUID(),
    rs = await Promise.all(Array.from({ length: 6 }, () => action(id, 'unknown-result', eventKey)));
  assert.ok(rs.every((r) => r.status === 200));
  assert.equal(rs.filter((r) => !r.data.duplicate).length, 1);
  const detail = (await f.staff(path('/' + id), f.extraCookies[0]!)).data;
  assert.equal(detail.evidence, 'UNKNOWN');
  assert.equal(detail.plan, 'QUERY_CHANNEL');
  assert.equal(detail.releaseAllowed, false);
  assert.equal(detail.events.length, 2);
  assert.equal(await f.runtime.db.businessAudit.count({ where: { resourceId: id } }), 2);
  assert.equal((await action(id, 'success-result', eventKey)).status, 409);
  const retry = await post({ key });
  assert.equal(retry.data.attempt.id, id);
  assert.equal(retry.data.attempt.evidence, 'UNKNOWN');
});
test('success/closed concurrency converges, conflict is sticky and unknown cannot downgrade', async () => {
  const id = (await post()).data.attempt.id;
  const rs = await Promise.all([action(id, 'success-result'), action(id, 'closed-result')]);
  assert.ok(rs.every((r) => r.status === 200));
  let d = (await action(id, 'unknown-result')).data.attempt;
  assert.equal(d.evidence, 'CONFLICT');
  assert.equal(d.events.length, 4);
  assert.equal(d.plan, 'REVIEW_CONFLICT');
  const other = (await post()).data.attempt.id;
  await action(other, 'closed-result');
  d = (await action(other, 'unknown-result')).data.attempt;
  assert.equal(d.evidence, 'CLOSED');
  assert.equal(d.plan, 'RECONCILE_CLOSE');
});
test('new application instance recovers unresolved evidence and retries an existing result key', async () => {
  const id = (await post()).data.attempt.id,
    key = randomUUID();
  await action(id, 'unknown-result', key);
  const rows = await f.runtime.db.$queryRaw<
    { schema: string }[]
  >`SELECT current_schema() AS schema`;
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.searchParams.set('schema', rows[0]!.schema);
  const g = await createApplication(url.toString(), {
    config: applicationConfig({
      NODE_ENV: 'test',
      PAYMENT_NOTIFICATION_LAB_ENABLED: '1',
      STAFF_ALLOWED_ORIGINS: 'http://127.0.0.1:5188',
    }),
    accessLog: () => {},
  });
  try {
    await g.app.listen(0, '127.0.0.1');
    const r = await fetch(
      (await g.app.getUrl()) + '/api/v1' + path('/' + id + '/actions/unknown-result'),
      {
        method: 'POST',
        headers: {
          Cookie: f.extraCookies[0]!,
          Origin: 'http://127.0.0.1:5188',
          'X-CSRF-Token': csrf,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ key }),
      },
    );
    const data = (await r.json()).data;
    assert.equal(r.status, 200);
    assert.equal(data.duplicate, true);
    assert.equal(data.attempt.evidence, 'UNKNOWN');
    assert.equal(data.attempt.events.length, 2);
  } finally {
    await g.close();
  }
});
test('late audit failure rolls back start/result/event together; no real business rows are written', async () => {
  const bad = { ...request, staffContext: { ...request.staffContext!, staffId: randomUUID() } },
    before = await f.runtime.db.paymentAttemptLab.count();
  await assert.rejects(() => service.create(bad, f.warehouseId, randomUUID()));
  assert.equal(await f.runtime.db.paymentAttemptLab.count(), before);
  const id = (await post()).data.attempt.id,
    key = randomUUID();
  await assert.rejects(() => service.observe(bad, f.warehouseId, id, key, 'unknown-result'));
  const detail = await service.detail(request, f.warehouseId, id);
  assert.equal(detail.evidence, 'NONE');
  assert.equal(detail.events.length, 1);
  assert.equal((await action(id, 'unknown-result', key)).status, 200);
  assert.deepEqual(await snapshot(), stock);
  const counts = await Promise.all([
    f.runtime.db.consumerOrder.count(),
    f.runtime.db.paymentPreparation.count(),
    f.runtime.db.notificationLabRecord.count(),
    f.runtime.db.orderEvent.count(),
  ]);
  assert.deepEqual(counts, [0, 0, 0, 0]);
});
test('database rejects missing/forged chains, mutation and deletion; SQL and shared evidence merge agree', async () => {
  const id = (await post()).data.attempt.id,
    row = await f.runtime.db.paymentAttemptLab.findUniqueOrThrow({ where: { id } });
  await assert.rejects(() =>
    f.runtime.db.paymentAttemptLab.update({
      where: { id },
      data: { evidence: 'SUCCEEDED', version: 1 },
    }),
  );
  await assert.rejects(() =>
    f.runtime.db.paymentAttemptLabEvent.updateMany({
      where: { attemptId: id },
      data: { evidence: 'SUCCEEDED' },
    }),
  );
  await assert.rejects(() =>
    f.runtime.db.paymentAttemptLabEvent.deleteMany({ where: { attemptId: id } }),
  );
  await assert.rejects(() => f.runtime.db.paymentAttemptLab.delete({ where: { id } }));
  await assert.rejects(() =>
    f.runtime.db.paymentAttemptLab.create({
      data: { id: randomUUID(), warehouseId: f.warehouseId, key: randomUUID() },
    }),
  );
  await assert.rejects(() =>
    f.runtime.db.paymentAttemptLab.update({
      where: { id },
      data: { key: randomUUID(), version: 1 },
    }),
  );
  assert.equal(
    (await f.runtime.db.paymentAttemptLab.findUniqueOrThrow({ where: { id } })).version,
    row.version,
  );
  for (const a of ['NONE', 'UNKNOWN', 'CLOSED', 'SUCCEEDED', 'CONFLICT'])
    for (const b of ['NONE', 'UNKNOWN', 'CLOSED', 'SUCCEEDED', 'CONFLICT']) {
      const rows = await f.runtime.db.$queryRaw<
        { evidence: string }[]
      >`SELECT yumi_lab_evidence_merge(${a}::text,${b}::text) AS evidence`;
      assert.equal(rows[0]!.evidence, mergePaymentEvidence(a, b));
    }
});
test('bounded event history permits original-key recovery at limit; cursor pages do not overlap', async () => {
  const id = (await post()).data.attempt.id,
    key = randomUUID();
  await action(id, 'unknown-result', key);
  for (let i = 1; i < 100; i++) assert.equal((await action(id, 'unknown-result')).status, 200);
  assert.equal((await action(id, 'unknown-result')).status, 409);
  const r = await action(id, 'unknown-result', key);
  assert.equal(r.data.duplicate, true);
  assert.equal(r.data.attempt.events.length, 101);
  for (let i = 0; i < 21; i++) await post();
  const a = (await f.staff(path(), f.extraCookies[0]!)).data;
  assert.equal(a.items.length, 20);
  assert.ok(a.nextCursor);
  const b = (await f.staff(path() + '&cursor=' + a.nextCursor, f.extraCookies[0]!)).data;
  assert.ok(b.items.length > 0);
  assert.ok(
    b.items.every((r: { id: string }) => !a.items.some((v: { id: string }) => v.id === r.id)),
  );
  assert.equal((await f.staff(path() + '&cursor=' + randomUUID(), f.extraCookies[0]!)).status, 404);
});
test('default-off is readable but cannot write; revoked scope cannot mutate attempts', async () => {
  const g = await orderAdminFixture();
  try {
    const token = (await g.staff('/staff/me', g.extraCookies[0]!)).data.csrfToken;
    const url = g.base + '/api/v1' + root + '?warehouseId=' + g.warehouseId;
    const info = await fetch(url, { headers: { Cookie: g.extraCookies[0]! } });
    assert.equal((await info.json()).data.enabled, false);
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Cookie: g.extraCookies[0]!,
        Origin: 'http://127.0.0.1:5188',
        'X-CSRF-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ key: randomUUID() }),
    });
    assert.equal(r.status, 503);
  } finally {
    await g.cleanup();
  }
  const id = (await post()).data.attempt.id;
  await f.runtime.db.staffWarehouse.deleteMany({
    where: { staffId: request.staffContext!.staffId },
  });
  assert.equal((await action(id, 'unknown-result')).status, 403);
});
