import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { orderAdminFixture } from './helpers/order-admin-fixture.ts';
import { NotificationRecordsService } from '../apps/api/dist/notification-records.js';
import { CatalogService } from '../apps/api/dist/catalog-service.js';
import { syntheticNotification } from '../apps/api/dist/notification-fixtures.js';
import { createApplication } from '../apps/api/dist/app.js';
import { applicationConfig } from '../apps/api/dist/config.js';
import type { ApiRequest } from '../apps/api/src/http.js';
let f: Awaited<ReturnType<typeof orderAdminFixture>>,
  csrf: string,
  service: NotificationRecordsService,
  request: ApiRequest;
let originalStock: unknown;
const root = '/admin/payment-notification-records';
const path = (suffix = '') => root + suffix + '?warehouseId=' + f.warehouseId;
async function post(
  body: unknown = {},
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
before(async () => {
  f = await orderAdminFixture({ notificationLab: true });
  const me = (await f.staff('/staff/me', f.extraCookies[0]!)).data;
  csrf = me.csrfToken;
  originalStock = {
    balances: await f.runtime.db.stockBalance.findMany({
      orderBy: [{ warehouseId: 'asc' }, { skuId: 'asc' }],
    }),
    ledgers: await f.runtime.db.stockLedger.count(),
  };
  service = new NotificationRecordsService(new CatalogService(f.runtime.db), true);
  request = {
    method: 'POST',
    headers: {},
    socket: {},
    requestId: randomUUID(),
    staffContext: { ...me, staffId: me.id, sessionId: randomUUID() },
  };
});
after(async () => {
  if (f) await f.cleanup();
});
test('records require admin warehouse scope, CSRF and strict synthetic-only input', async () => {
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
    { key: randomUUID(), rawBody: 'x' },
    { key: randomUUID(), apiV3Key: 'x' },
  ])
    assert.equal((await post(body)).status, 400);
  assert.equal(
    (await f.staff(root + '?warehouseId=' + randomUUID(), f.extraCookies[0]!)).status,
    403,
  );
  assert.equal((await f.staff(path() + '&state=PAID', f.extraCookies[0]!)).status, 400);
  assert.equal((await f.staff(path('/' + randomUUID()), f.extraCookies[0]!)).status, 404);
});
test('concurrent repeated encrypted notifications produce one durable record and one atomic audit', async () => {
  const key = randomUUID(),
    before = await f.runtime.db.notificationLabRecord.count();
  const result = await Promise.all(Array.from({ length: 6 }, () => post({ key })));
  assert.ok(result.every((r) => r.status === 200));
  assert.equal(result.filter((r) => !r.data.duplicate).length, 1);
  const ids = new Set(result.map((r) => r.data.record.id));
  assert.equal(ids.size, 1);
  assert.equal(await f.runtime.db.notificationLabRecord.count(), before + 1);
  const id = result[0]!.data.record.id;
  assert.equal(
    await f.runtime.db.businessAudit.count({
      where: { resourceId: id, action: 'NOTIFICATION_LAB_RECORDED' },
    }),
    1,
  );
  const replay = await post({}, '/' + id + '/replay');
  assert.equal(replay.status, 200);
  assert.equal(replay.data.duplicate, true);
  assert.equal(replay.data.record.id, id);
  assert.equal((await f.staff(path('/' + id), f.extraCookies[0]!)).data.state, 'RECORDED_ONLY');
  for (const secret of [
    'PRIVATE KEY',
    'ciphertext',
    'payer',
    'factsHash',
    f.password,
    f.identity.token,
  ])
    assert.ok(!JSON.stringify(result).includes(secret));
});
test('dedup survives a new application instance using persisted sessions and records', async () => {
  const key = randomUUID(),
    first = await post({ key });
  const [schemaRow] = await f.runtime.db.$queryRaw<
    { schema: string }[]
  >`SELECT current_schema() AS schema`;
  const url = new URL(process.env.TEST_DATABASE_URL!);
  url.searchParams.set('schema', schemaRow!.schema);
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
    const r = await fetch((await g.app.getUrl()) + '/api/v1' + path(), {
      method: 'POST',
      headers: {
        Cookie: f.extraCookies[0]!,
        Origin: 'http://127.0.0.1:5188',
        'X-CSRF-Token': csrf,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ key }),
    });
    const data = (await r.json()).data;
    assert.equal(r.status, 200);
    assert.equal(data.duplicate, true);
    assert.equal(data.record.id, first.data.record.id);
  } finally {
    await g.close();
  }
});
test('bad signature creates no record; same notification with conflicting verified facts cannot overwrite', async () => {
  const fixture = syntheticNotification(),
    body = fixture.envelope(),
    id = 'SYNTHETIC_' + randomUUID();
  body.id = id;
  const input = fixture.signed(body),
    bad = { ...input, rawBody: Buffer.concat([input.rawBody, Buffer.from(' ')]) };
  const old = await f.runtime.db.notificationLabRecord.count();
  await assert.rejects(() => service.receive(request, f.warehouseId, bad));
  assert.equal(await f.runtime.db.notificationLabRecord.count(), old);
  const first = await service.receive(request, f.warehouseId, input);
  const conflicting = fixture.envelope({ transaction_id: 'SYNTHETIC_DIFFERENT' });
  conflicting.id = id;
  await assert.rejects(
    () => service.receive(request, f.warehouseId, fixture.signed(conflicting)),
    (e: unknown) =>
      Boolean(
        e && typeof e === 'object' && 'getStatus' in e && (e.getStatus as () => number)() === 409,
      ),
  );
  assert.equal(
    (await service.detail(request, f.warehouseId, first.record.id)).transactionId,
    first.record.transactionId,
  );
  await assert.rejects(() =>
    f.runtime.db.notificationLabRecord.update({
      where: { id: first.record.id },
      data: { amountCents: 1n },
    }),
  );
  await assert.rejects(() =>
    f.runtime.db.notificationLabRecord.delete({ where: { id: first.record.id } }),
  );
});
test('late audit failure rolls back record; business state and inventory are untouched', async () => {
  const body = syntheticNotification(),
    envelope = body.envelope();
  envelope.id = 'SYNTHETIC_' + randomUUID();
  const before = await f.runtime.db.notificationLabRecord.count();
  await assert.rejects(() =>
    service.receive(
      { ...request, staffContext: { ...request.staffContext!, staffId: randomUUID() } },
      f.warehouseId,
      body.signed(envelope),
    ),
  );
  assert.equal(await f.runtime.db.notificationLabRecord.count(), before);
  assert.equal(await f.runtime.db.consumerOrder.count(), 0);
  assert.equal(await f.runtime.db.paymentPreparation.count(), 0);
  assert.equal(await f.runtime.db.orderEvent.count(), 0);
  assert.deepEqual(
    {
      balances: await f.runtime.db.stockBalance.findMany({
        orderBy: [{ warehouseId: 'asc' }, { skuId: 'asc' }],
      }),
      ledgers: await f.runtime.db.stockLedger.count(),
    },
    originalStock,
  );
  const balance = await f.runtime.db.stockBalance.findMany();
  assert.ok(balance.every((r) => r.reserved === 0));
});
test('stable cursor pagination scopes records and rejects foreign cursors', async () => {
  for (let i = 0; i < 21; i++) assert.equal((await post({ key: randomUUID() })).status, 200);
  const a = await f.staff(path(), f.extraCookies[0]!);
  assert.equal(a.data.items.length, 20);
  assert.ok(a.data.nextCursor);
  const b = await f.staff(path() + '&cursor=' + a.data.nextCursor, f.extraCookies[0]!);
  assert.ok(b.data.items.length > 0);
  assert.ok(
    b.data.items.every(
      (r: { id: string }) => !a.data.items.some((q: { id: string }) => q.id === r.id),
    ),
  );
  assert.equal((await f.staff(path() + '&cursor=' + randomUUID(), f.extraCookies[0]!)).status, 404);
  assert.equal((await f.staff(path() + '&cursor=bad', f.extraCookies[0]!)).status, 400);
});
test('disabled mode remains readable but rejects writes; warehouse revocation applies to replay', async () => {
  const g = await orderAdminFixture();
  try {
    const token = (await g.staff('/staff/me', g.extraCookies[0]!)).data.csrfToken;
    const endpoint = g.base + '/api/v1' + root + '?warehouseId=' + g.warehouseId;
    const get = await fetch(endpoint, { headers: { Cookie: g.extraCookies[0]! } });
    assert.equal((await get.json()).data.enabled, false);
    const r = await fetch(endpoint, {
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
  const first = (await f.staff(path(), f.extraCookies[0]!)).data.items[0];
  await f.runtime.db.staffWarehouse.deleteMany({
    where: { staffId: request.staffContext!.staffId },
  });
  assert.equal((await post({}, '/' + first.id + '/replay')).status, 403);
});
