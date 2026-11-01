import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { orderAdminFixture } from './helpers/order-admin-fixture.ts';
let f: Awaited<ReturnType<typeof orderAdminFixture>>;
const url = () => '/admin/payment-readiness?warehouseId=' + f.warehouseId;
const read = () => f.staff(url(), f.extraCookies[0]!);
before(async () => {
  f = await orderAdminFixture();
});
after(async () => {
  if (f) await f.cleanup();
});
test('readiness is admin-only and consumer/operations/warehouse/rider cannot inspect deployment metadata', async () => {
  assert.equal((await f.staff(url(), '')).status, 401);
  assert.equal((await f.call(url())).status, 401);
  for (const cookie of [...f.cookies, f.extraCookies[1]!])
    assert.equal((await f.staff(url(), cookie)).status, 403);
  assert.equal((await read()).status, 200);
});
test('strict input, warehouse scope and disabled warehouse are enforced independently of the role', async () => {
  for (const path of [
    '/admin/payment-readiness',
    '/admin/payment-readiness?warehouseId=bad',
    url() + '&mode=wechat',
    url() + '&warehouseId=' + f.warehouseId,
  ])
    assert.equal((await f.staff(path, f.extraCookies[0]!)).status, 400);
  const other = randomUUID();
  assert.equal(
    (await f.staff('/admin/payment-readiness?warehouseId=' + other, f.extraCookies[0]!)).status,
    403,
  );
  await f.runtime.db.warehouse.update({ where: { id: f.warehouseId }, data: { enabled: false } });
  try {
    assert.equal((await read()).status, 403);
  } finally {
    await f.runtime.db.warehouse.update({ where: { id: f.warehouseId }, data: { enabled: true } });
  }
});
test('report reflects actual operational configuration and never marks payment ready', async () => {
  const r = await read();
  assert.equal(r.data.channel, 'DISABLED');
  assert.equal(r.data.canStartPayment, false);
  assert.equal(r.data.checks.length, 11);
  const by = (code: string) => r.data.checks.find((c: { code: string }) => c.code === code);
  assert.equal(by('CHECKOUT_POLICY').status, 'CONFIGURED');
  assert.equal(by('SERVICE_AREA').status, 'CONFIGURED');
  assert.equal(by('APP_ID').status, 'MISSING');
  assert.equal(by('PROVIDER').status, 'BLOCKED');
  assert.equal(by('CALLBACK').status, 'BLOCKED');
  assert.equal(by('CREDENTIALS').status, 'UNVERIFIED');
  await f.runtime.db.checkoutPolicy.update({
    where: { warehouseId: f.warehouseId },
    data: { open: false },
  });
  await f.runtime.db.serviceBuilding.update({
    where: { id: f.buildingId },
    data: { enabled: false },
  });
  const paused = await read();
  assert.equal(
    paused.data.checks.find((c: { code: string }) => c.code === 'CHECKOUT_POLICY').status,
    'BLOCKED',
  );
  assert.equal(
    paused.data.checks.find((c: { code: string }) => c.code === 'SERVICE_AREA').status,
    'BLOCKED',
  );
});
test('readiness does not write business rows, expose private records, or offer enable/credential endpoints', async () => {
  const before = {
    orders: await f.runtime.db.consumerOrder.count(),
    preparations: await f.runtime.db.paymentPreparation.count(),
    events: await f.runtime.db.orderEvent.count(),
    ledgers: await f.runtime.db.stockLedger.count(),
    policy: await f.runtime.db.checkoutPolicy.findMany(),
  };
  for (let i = 0; i < 3; i++) await read();
  assert.deepEqual(
    {
      orders: await f.runtime.db.consumerOrder.count(),
      preparations: await f.runtime.db.paymentPreparation.count(),
      events: await f.runtime.db.orderEvent.count(),
      ledgers: await f.runtime.db.stockLedger.count(),
      policy: await f.runtime.db.checkoutPolicy.findMany(),
    },
    before,
  );
  assert.equal((await f.staff(url(), f.extraCookies[0]!, 'POST')).status, 404);
  const body = JSON.stringify((await read()).data);
  assert.ok(!body.includes('合成门牌'));
  assert.ok(!body.includes('合成验收联系人'));
  assert.ok(!body.includes(f.identity.token));
  assert.ok(!body.includes(f.password));
});
test('role and warehouse revocation invalidate the next inspection request', async () => {
  const superId = (
    await f.runtime.db.staff.findUniqueOrThrow({ where: { loginName: 'order-test-0' } })
  ).id;
  await f.runtime.db.staffWarehouse.deleteMany({ where: { staffId: superId } });
  assert.equal((await read()).status, 403);
  await f.runtime.db.staffRole.deleteMany({ where: { staffId: superId } });
  assert.equal((await read()).status, 403);
});
