import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { orderAdminFixture } from './helpers/order-admin-fixture.ts';
import { NotificationRecordsService } from '../apps/api/dist/notification-records.js';
import { CatalogService } from '../apps/api/dist/catalog-service.js';
import { syntheticNotification } from '../apps/api/dist/notification-fixtures.js';
import {
  claimPaymentQueryLab,
  finishPaymentQueryLab,
  createDatabase,
} from '../packages/database/dist/index.js';
import type { ApiRequest } from '../apps/api/src/http.js';
let f: Awaited<ReturnType<typeof orderAdminFixture>>,
  csrf: string,
  service: NotificationRecordsService,
  request: ApiRequest;
const records = '/admin/payment-notification-records',
  attempts = '/admin/payment-attempt-lab';
async function post(path: string, body: unknown, cookie = f.extraCookies[0]!, token = csrf) {
  const r = await fetch(f.base + '/api/v1' + path + '?warehouseId=' + f.warehouseId, {
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
async function start(unknown = false) {
  const r = await post(attempts, { key: randomUUID() });
  assert.equal(r.status, 200);
  const id = r.data.attempt.id as string;
  if (unknown) await post(attempts + '/' + id + '/actions/unknown-result', { key: randomUUID() });
  return id;
}
async function material(id: string, patch: Record<string, unknown> = {}, key = randomUUID()) {
  const b = await f.runtime.db.paymentNotificationLabBinding.findUniqueOrThrow({
      where: { attemptId: id },
    }),
    v = syntheticNotification();
  Object.assign(v.expected, {
    appid: b.appId,
    mchid: b.merchantId,
    outTradeNo: b.outTradeNo,
    total: Number(b.amountCents),
  });
  const e = v.envelope({
    transaction_id: 'SYNTHETIC_TX_' + id,
    success_time: '2026-01-01T00:00:00.000Z',
    ...patch,
  });
  e.id = 'SYNTHETIC_' + key;
  return v.signed(e);
}
beforeEach(async () => {
  f = await orderAdminFixture({ notificationLab: true });
  const me = (await f.staff('/staff/me', f.extraCookies[0]!)).data;
  csrf = me.csrfToken;
  service = new NotificationRecordsService(new CatalogService(f.runtime.db), true);
  request = {
    method: 'POST',
    headers: {},
    socket: {},
    requestId: randomUUID(),
    staffContext: { ...me, staffId: me.id, sessionId: randomUUID() },
  };
});
afterEach(async () => {
  if (f) await f.cleanup();
});
test('authorized binding options and strict synthetic target input; scoped unknown targets cannot write', async () => {
  const id = await start();
  const options = await f.staff(
    records + '/attempts?warehouseId=' + f.warehouseId,
    f.extraCookies[0]!,
  );
  assert.equal(options.status, 200);
  assert.equal(options.data.items[0].id, id);
  assert.equal(options.data.items[0].amountCents, 2499);
  assert.equal((await f.staff(records + '/attempts?warehouseId=' + f.warehouseId, '')).status, 401);
  assert.equal(
    (await post(records, { key: randomUUID(), attemptId: id }, f.cookies[0]!)).status,
    403,
  );
  assert.equal(
    (await post(records, { key: randomUUID(), attemptId: id }, f.extraCookies[0]!, '')).status,
    403,
  );
  for (const body of [
    { key: randomUUID(), attemptId: 'bad' },
    { key: randomUUID(), attemptId: id, rawBody: 'x' },
  ])
    assert.equal((await post(records, body)).status, 400);
  assert.equal((await post(records, { key: randomUUID(), attemptId: randomUUID() })).status, 404);
  assert.equal(await f.runtime.db.notificationLabRecord.count(), 0);
  const b = await f.runtime.db.paymentNotificationLabBinding.findUniqueOrThrow({
    where: { attemptId: id },
  });
  assert.equal(b.outTradeNo.length, 32);
  assert.ok(b.outTradeNo.startsWith('SYNTHETIC_'));
});
test('concurrent same notification creates one record, one linked application and one evidence/audit effect', async () => {
  const id = await start(),
    key = randomUUID(),
    stock = await f.runtime.db.stockLedger.count();
  const r = await Promise.all(
    Array.from({ length: 5 }, () => post(records, { key, attemptId: id })),
  );
  assert.ok(r.every((x) => x.status === 200));
  assert.equal(r.filter((x) => x.data.applied).length, 1);
  assert.equal(r.filter((x) => !x.data.duplicate).length, 1);
  assert.equal(await f.runtime.db.notificationLabRecord.count(), 1);
  assert.equal(await f.runtime.db.paymentNotificationLabApplication.count(), 1);
  assert.equal(
    await f.runtime.db.paymentAttemptLabEvent.count({
      where: { attemptId: id, observation: 'SUCCEEDED' },
    }),
    1,
  );
  const a = await f.runtime.db.paymentAttemptLab.findUniqueOrThrow({ where: { id } });
  assert.equal(a.version, 1);
  assert.equal(a.evidence, 'SUCCEEDED');
  assert.equal(r[0].data.record.application.attemptId, id);
  assert.equal(r[0].data.record.state, 'LINKED_SYNTHETIC');
  assert.equal(await f.runtime.db.consumerOrder.count(), 0);
  assert.equal(await f.runtime.db.paymentPreparation.count(), 0);
  assert.equal(await f.runtime.db.stockLedger.count(), stock);
  assert.equal(
    await f.runtime.db.businessAudit.count({ where: { action: 'NOTIFICATION_LAB_RECORDED' } }),
    1,
  );
  for (const secret of ['ciphertext', 'PRIVATE KEY', 'payer', 'factsHash', 'apiV3Key'])
    assert.ok(!JSON.stringify(r).includes(secret));
});
test('different notification IDs for one transaction preserve both records but share evidence; every ID remains conflict checked after restart', async () => {
  const id = await start(),
    a = await post(records, { key: randomUUID(), attemptId: id }),
    b = await post(records, { key: randomUUID(), attemptId: id });
  assert.equal(a.data.applied, true);
  assert.equal(b.data.applied, false);
  assert.equal(b.data.duplicate, false);
  assert.equal(await f.runtime.db.notificationLabRecord.count(), 2);
  assert.equal(await f.runtime.db.paymentNotificationLabApplication.count(), 1);
  for (const r of [a, b]) {
    const replay = await post(records + '/' + r.data.record.id + '/replay', {});
    assert.equal(replay.status, 200);
    assert.equal(replay.data.duplicate, true);
    assert.equal(replay.data.applied, false);
  }
  const [{ schema }] = await f.runtime.db.$queryRaw<
    [{ schema: string }]
  >`SELECT current_schema() AS schema`;
  const u = new URL(process.env.TEST_DATABASE_URL!);
  u.searchParams.set('schema', schema);
  const other = createDatabase(u.toString());
  try {
    const next = new NotificationRecordsService(new CatalogService(other), true);
    const key = b.data.record.notificationId.slice('SYNTHETIC_'.length);
    const recovered = await next.simulate(request, f.warehouseId, key, id);
    assert.equal(recovered.duplicate, true);
  } finally {
    await other.$disconnect();
  }
  const key = b.data.record.notificationId.slice('SYNTHETIC_'.length);
  const changed = await material(id, { success_time: '2026-02-01T00:00:00.000Z' }, key);
  await assert.rejects(() => service.receive(request, f.warehouseId, changed, id));
  assert.equal(await f.runtime.db.notificationLabRecord.count(), 2);
});
test('binding verification rejects wrong order, amount, app, merchant, currency and target before evidence mutation', async () => {
  const a = await start(),
    b = await start();
  for (const patch of [
    { out_trade_no: 'SYNTHETIC_WRONG' },
    { amount: { total: 2500, currency: 'CNY' } },
    { appid: 'wx2222222222222222' },
    { mchid: 'other' },
    { amount: { total: 2499, currency: 'USD' } },
  ]) {
    const input = await material(a, patch);
    await assert.rejects(() => service.receive(request, f.warehouseId, input, a));
  }
  const input = await material(a);
  await assert.rejects(() => service.receive(request, f.warehouseId, input, b));
  assert.equal(await f.runtime.db.notificationLabRecord.count(), 0);
  assert.equal(await f.runtime.db.paymentNotificationLabApplication.count(), 0);
  assert.equal(
    (await f.runtime.db.paymentAttemptLab.findUniqueOrThrow({ where: { id: a } })).evidence,
    'NONE',
  );
  await post(records, { key: randomUUID(), attemptId: a });
  const reuse = await material(b, { transaction_id: 'SYNTHETIC_TX_' + a });
  await assert.rejects(() => service.receive(request, f.warehouseId, reuse, b));
  assert.equal(
    (await f.runtime.db.paymentAttemptLab.findUniqueOrThrow({ where: { id: b } })).evidence,
    'NONE',
  );
});
test('notification invalidates outstanding lease, closes unknown tasks and preserves conflict or existing review', async () => {
  const a = await start(true),
    lease = await claimPaymentQueryLab(f.runtime.db, f.warehouseId);
  assert.ok(lease);
  await post(records, { key: randomUUID(), attemptId: a });
  assert.equal(await finishPaymentQueryLab(f.runtime.db, lease, 'CLOSED'), false);
  assert.equal(
    (await f.runtime.db.paymentQueryLabJob.findUniqueOrThrow({ where: { attemptId: a } })).state,
    'DONE',
  );
  const b = await start(true);
  await post(attempts + '/run-query-cycle', { scenario: 'CLOSED' });
  await post(records, { key: randomUUID(), attemptId: b });
  assert.equal(
    (await f.runtime.db.paymentAttemptLab.findUniqueOrThrow({ where: { id: b } })).evidence,
    'CONFLICT',
  );
  assert.equal(
    (await f.runtime.db.paymentQueryLabJob.findUniqueOrThrow({ where: { attemptId: b } })).state,
    'REVIEW',
  );
  const c = await start(true);
  await post(attempts + '/run-query-cycle', { scenario: 'MISSING' });
  await post(records, { key: randomUUID(), attemptId: c });
  assert.equal(
    (await f.runtime.db.paymentQueryLabJob.findUniqueOrThrow({ where: { attemptId: c } })).state,
    'REVIEW',
  );
  const list = (
    await f.staff('/admin/payment-review-lab?warehouseId=' + f.warehouseId, f.extraCookies[0]!)
  ).data;
  assert.equal(list.items.length, 2);
  const d = await start();
  await post(records, { key: randomUUID(), attemptId: d });
  await post(attempts + '/' + d + '/actions/closed-result', { key: randomUUID() });
  assert.equal(
    (await f.runtime.db.paymentAttemptLab.findUniqueOrThrow({ where: { id: d } })).evidence,
    'CONFLICT',
  );
});
test('audit failure rolls back notification, application, attempt evidence and query settlement together', async () => {
  const id = await start(true),
    key = randomUUID(),
    before = await f.runtime.db.paymentQueryLabJob.findUniqueOrThrow({ where: { attemptId: id } });
  await f.runtime.db.$executeRawUnsafe(
    "CREATE FUNCTION fail_link_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='NOTIFICATION_LAB_RECORDED' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$",
  );
  await f.runtime.db.$executeRawUnsafe(
    'CREATE TRIGGER fail_link_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_link_audit()',
  );
  assert.equal((await post(records, { key, attemptId: id })).status, 500);
  assert.equal(await f.runtime.db.notificationLabRecord.count(), 0);
  assert.equal(await f.runtime.db.paymentNotificationLabApplication.count(), 0);
  assert.equal(
    (await f.runtime.db.paymentAttemptLab.findUniqueOrThrow({ where: { id } })).evidence,
    'UNKNOWN',
  );
  assert.equal(
    (await f.runtime.db.paymentQueryLabJob.findUniqueOrThrow({ where: { attemptId: id } })).version,
    before.version,
  );
  await f.runtime.db.$executeRawUnsafe('DROP TRIGGER fail_link_audit ON business_audits');
  assert.equal((await post(records, { key, attemptId: id })).data.applied, true);
});
test('SQL refuses binding/application mutation, orphan or mismatched facts and evidence; history has no automatic links', async () => {
  const id = await start(),
    r = await post(records, { key: randomUUID(), attemptId: id }),
    app = await f.runtime.db.paymentNotificationLabApplication.findUniqueOrThrow({
      where: { attemptId: id },
    });
  await assert.rejects(() =>
    f.runtime.db.paymentNotificationLabBinding.update({
      where: { attemptId: id },
      data: { amountCents: 1 },
    }),
  );
  await assert.rejects(() =>
    f.runtime.db.paymentNotificationLabApplication.delete({ where: { id: app.id } }),
  );
  await assert.rejects(() =>
    f.runtime.db.notificationLabRecord.update({
      where: { id: r.data.record.id },
      data: { applicationId: null },
    }),
  );
  const n = await f.runtime.db.notificationLabRecord.findUniqueOrThrow({
    where: { id: r.data.record.id },
  });
  await assert.rejects(() =>
    f.runtime.db.notificationLabRecord.create({
      data: {
        ...n,
        id: randomUUID(),
        notificationId: 'SYNTHETIC_' + randomUUID(),
        amountCents: 2500,
      },
    }),
  );
  const b = await start();
  await assert.rejects(() =>
    f.runtime.db.paymentNotificationLabApplication.create({
      data: {
        id: randomUUID(),
        attemptId: b,
        warehouseId: f.warehouseId,
        transactionId: 'SYNTHETIC_OTHER',
        successTime: n.successTime,
        attemptEventId: app.attemptEventId,
      },
    }),
  );
  await assert.rejects(() =>
    f.runtime.db.$transaction(async (tx) => {
      const effect = randomUUID(),
        event = randomUUID();
      await tx.paymentAttemptLab.update({
        where: { id: b },
        data: { evidence: 'SUCCEEDED', version: 1 },
      });
      await tx.paymentAttemptLabEvent.create({
        data: {
          id: event,
          attemptId: b,
          key: effect,
          action: 'SUCCESS_RESULT',
          observation: 'SUCCEEDED',
          evidence: 'SUCCEEDED',
          version: 1,
        },
      });
      await tx.paymentNotificationLabApplication.create({
        data: {
          id: effect,
          attemptId: b,
          warehouseId: f.warehouseId,
          transactionId: 'SYNTHETIC_ORPHAN',
          successTime: n.successTime,
          attemptEventId: event,
        },
      });
    }),
  );
  assert.equal(
    (await f.runtime.db.paymentAttemptLab.findUniqueOrThrow({ where: { id: b } })).version,
    0,
  );
  const standalone = await post(records, { key: randomUUID() });
  assert.equal(standalone.data.record.application, null);
  assert.equal(standalone.data.applied, false);
});
test('binding options paginate without overlap and legacy attempts remain unbound', async () => {
  for (let i = 0; i < 21; i++) await start();
  const first = (
    await f.staff(records + '/attempts?warehouseId=' + f.warehouseId, f.extraCookies[0]!)
  ).data;
  assert.equal(first.items.length, 20);
  const next = (
    await f.staff(
      records + '/attempts?warehouseId=' + f.warehouseId + '&cursor=' + first.nextCursor,
      f.extraCookies[0]!,
    )
  ).data;
  assert.equal(next.items.length, 1);
  assert.equal(new Set([...first.items, ...next.items].map((x) => x.id)).size, 21);
  const id = randomUUID(),
    key = randomUUID();
  await f.runtime.db.$transaction(async (tx) => {
    await tx.paymentAttemptLab.create({ data: { id, key, warehouseId: f.warehouseId } });
    await tx.paymentAttemptLabEvent.create({
      data: {
        id: randomUUID(),
        attemptId: id,
        key,
        action: 'STARTED',
        observation: 'NONE',
        evidence: 'NONE',
        version: 0,
      },
    });
  });
  const detail = (
    await f.staff(attempts + '/' + id + '?warehouseId=' + f.warehouseId, f.extraCookies[0]!)
  ).data;
  assert.equal(detail.notificationBinding, null);
  assert.equal((await post(records, { key: randomUUID(), attemptId: id })).status, 404);
});
