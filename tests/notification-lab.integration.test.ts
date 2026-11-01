import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { orderAdminFixture } from './helpers/order-admin-fixture.ts';
import { applicationConfig } from '../apps/api/dist/config.js';
import { createApplication } from '../apps/api/dist/app.js';
let f: Awaited<ReturnType<typeof orderAdminFixture>>, csrf: string;
const url = (run = false) =>
  '/admin/payment-notification-lab' + (run ? '/run' : '') + '?warehouseId=' + f.warehouseId;
async function run(
  body: unknown = {},
  cookie = f.extraCookies[0]!,
  token = csrf,
  origin = 'http://127.0.0.1:5188',
  query = url(true),
) {
  const r = await fetch(f.base + '/api/v1' + query, {
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
  csrf = (await f.staff('/staff/me', f.extraCookies[0]!)).data.csrfToken;
});
after(async () => {
  if (f) await f.cleanup();
});
test('lab is opt-in and rejects production, public binding and remote/non-dev database', async () => {
  assert.equal(applicationConfig({}).notificationLabEnabled, false);
  for (const env of [
    { PAYMENT_NOTIFICATION_LAB_ENABLED: 'yes' },
    {
      PAYMENT_NOTIFICATION_LAB_ENABLED: '1',
      NODE_ENV: 'production',
      STAFF_ALLOWED_ORIGINS: 'https://retail.invalid',
    },
    { PAYMENT_NOTIFICATION_LAB_ENABLED: '1', API_HOST: '0.0.0.0' },
  ])
    assert.throws(() => applicationConfig(env));
  const config = applicationConfig({ PAYMENT_NOTIFICATION_LAB_ENABLED: '1' });
  for (const db of [
    'postgresql://user:pass@db.invalid/yumi_test',
    'postgresql://user:pass@127.0.0.1/other',
  ])
    await assert.rejects(() => createApplication(db, { config }), /local isolated database/);
});
test('admin cookie, warehouse scope and CSRF are enforced; bodies cannot supply keys or notifications', async () => {
  assert.equal((await f.staff(url(), '')).status, 401);
  assert.equal((await f.call(url())).status, 401);
  for (const cookie of [...f.cookies, f.extraCookies[1]!])
    assert.equal((await f.staff(url(), cookie)).status, 403);
  assert.equal((await run({}, f.extraCookies[0]!, '')).status, 403);
  assert.equal((await run({}, f.extraCookies[0]!, csrf, 'http://untrusted.invalid')).status, 403);
  for (const body of [
    { rawBody: 'not allowed' },
    { apiV3Key: 'synthetic-secret' },
    { privateKey: 'synthetic-secret' },
  ])
    assert.equal((await run(body)).status, 400);
  assert.equal((await f.staff(url() + '&extra=1', f.extraCookies[0]!)).status, 400);
  assert.equal(
    (
      await f.staff(
        '/admin/payment-notification-lab?warehouseId=' + randomUUID(),
        f.extraCookies[0]!,
      )
    ).status,
    403,
  );
});
test('real synthetic crypto suite passes without changing any business rows or returning credentials', async () => {
  const info = await f.staff(url(), f.extraCookies[0]!);
  assert.equal(info.status, 200);
  assert.equal(info.data.enabled, true);
  assert.equal(info.data.cases.length, 9);
  const snapshot = async () => ({
    orders: await f.runtime.db.consumerOrder.count(),
    preparations: await f.runtime.db.paymentPreparation.count(),
    stock: await f.runtime.db.stockBalance.findMany(),
    ledgers: await f.runtime.db.stockLedger.count(),
    events: await f.runtime.db.orderEvent.count(),
  });
  const old = await snapshot();
  const r = await run();
  assert.equal(r.status, 200);
  assert.equal(r.data.callbackEnabled, false);
  assert.ok(r.data.results.every((c: { status: string }) => c.status === 'PASSED'));
  assert.deepEqual(await snapshot(), old);
  for (const text of [
    'PRIVATE KEY',
    'ciphertext',
    'SYNTHETIC_PRIVATE_ID',
    f.identity.token,
    f.password,
  ])
    assert.ok(!JSON.stringify(r).includes(text));
});
test('no public payment receiver or paid endpoint is registered and readiness stays blocked', async () => {
  for (const route of ['/payments/wechat/notify', '/payments/notify', '/consumer/payments/success'])
    assert.equal((await f.call(route, {})).status, 404);
  const r = await f.staff(
    '/admin/payment-readiness?warehouseId=' + f.warehouseId,
    f.extraCookies[0]!,
  );
  assert.equal(r.data.canStartPayment, false);
  assert.equal(
    r.data.checks.find((c: { code: string }) => c.code === 'CALLBACK').status,
    'BLOCKED',
  );
});
test('disabled lab advertises cases but execution returns503; revoked warehouse/role cannot run', async () => {
  const g = await orderAdminFixture();
  try {
    const t = (await g.staff('/staff/me', g.extraCookies[0]!)).data.csrfToken;
    const r = await fetch(
      g.base + '/api/v1/admin/payment-notification-lab/run?warehouseId=' + g.warehouseId,
      {
        method: 'POST',
        headers: {
          Cookie: g.extraCookies[0]!,
          Origin: 'http://127.0.0.1:5188',
          'X-CSRF-Token': t,
          'Content-Type': 'application/json',
        },
        body: '{}',
      },
    );
    assert.equal(r.status, 503);
    assert.equal(
      (
        await g.staff(
          '/admin/payment-notification-lab?warehouseId=' + g.warehouseId,
          g.extraCookies[0]!,
        )
      ).data.enabled,
      false,
    );
  } finally {
    await g.cleanup();
  }
  const staff = (
    await f.runtime.db.staff.findUniqueOrThrow({ where: { loginName: 'order-test-0' } })
  ).id;
  await f.runtime.db.staffWarehouse.deleteMany({ where: { staffId: staff } });
  assert.equal((await run()).status, 403);
  await f.runtime.db.staffRole.deleteMany({ where: { staffId: staff } });
  assert.equal((await run()).status, 403);
});
