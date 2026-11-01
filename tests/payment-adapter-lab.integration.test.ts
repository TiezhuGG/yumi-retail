import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { orderAdminFixture } from './helpers/order-admin-fixture.ts';
let f: Awaited<ReturnType<typeof orderAdminFixture>>, csrf: string;
const path = (run = false) =>
  '/admin/payment-adapter-lab' + (run ? '/run' : '') + '?warehouseId=' + f.warehouseId;
async function run(body: unknown = {}, cookie = f.extraCookies[0]!, token = csrf) {
  const r = await fetch(f.base + '/api/v1' + path(true), {
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
before(async () => {
  f = await orderAdminFixture({ notificationLab: true, holdSeconds: 3 });
  csrf = (await f.staff('/staff/me', f.extraCookies[0]!)).data.csrfToken;
});
after(async () => {
  if (f) await f.cleanup();
});
test('lab requires admin scope, CSRF, strict empty input and remains a no-write plan', async () => {
  assert.equal((await f.staff(path(), '')).status, 401);
  for (const cookie of f.cookies) assert.equal((await f.staff(path(), cookie)).status, 403);
  assert.equal((await run({}, f.extraCookies[0]!, '')).status, 403);
  assert.equal((await run({ paymentState: 'PAID' })).status, 400);
  assert.equal((await run({ rawBody: 'x' })).status, 400);
  assert.equal(
    (await f.staff('/admin/payment-adapter-lab?warehouseId=' + randomUUID(), f.extraCookies[0]!))
      .status,
    403,
  );
  const snapshot = async () => ({
    orders: await f.runtime.db.consumerOrder.count(),
    attempts: await f.runtime.db.paymentAttemptLab.count(),
    jobs: await f.runtime.db.paymentQueryLabJob.count(),
    notes: await f.runtime.db.paymentReviewLabNote.count(),
    records: await f.runtime.db.notificationLabRecord.count(),
    audits: await f.runtime.db.businessAudit.count(),
    ledgers: await f.runtime.db.stockLedger.count(),
  });
  const before = await snapshot();
  const info = await f.staff(path(), f.extraCookies[0]!);
  assert.equal(info.data.enabled, true);
  assert.equal(info.data.cases.length, 17);
  const r = await run();
  assert.equal(r.status, 200);
  assert.equal(r.data.results.length, 17);
  assert.ok(r.data.results.every((x: { status: string }) => x.status === 'PASSED'));
  assert.equal(r.data.callbackEnabled, false);
  assert.ok(r.data.results.every((x: { releaseAllowed: boolean }) => x.releaseAllowed === false));
  assert.ok(!JSON.stringify(r).includes('synthetic-private-error'));
  assert.deepEqual(await snapshot(), before);
});
test('default-off lab cannot run and revoked warehouse cannot inspect scenarios', async () => {
  const g = await orderAdminFixture();
  try {
    const token = (await g.staff('/staff/me', g.extraCookies[0]!)).data.csrfToken;
    const r = await fetch(
      g.base + '/api/v1/admin/payment-adapter-lab/run?warehouseId=' + g.warehouseId,
      {
        method: 'POST',
        headers: {
          Cookie: g.extraCookies[0]!,
          Origin: 'http://127.0.0.1:5188',
          'X-CSRF-Token': token,
          'Content-Type': 'application/json',
        },
        body: '{}',
      },
    );
    assert.equal(r.status, 503);
  } finally {
    await g.cleanup();
  }
  const me = (await f.staff('/staff/me', f.extraCookies[0]!)).data;
  await f.runtime.db.staffWarehouse.deleteMany({ where: { staffId: me.id } });
  assert.equal((await f.staff(path(), f.extraCookies[0]!)).status, 403);
});
