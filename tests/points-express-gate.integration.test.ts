import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { controlledExpressFixture } from './helpers/controlled-express-fixture.ts';
test('controlled express accepts allowed WeChat accounts only, records immutable execution mode and directly ships without development or rider gates', async () => {
  const f = await controlledExpressFixture();
  try {
    assert.equal((await f.call('/consumer/redemption-access')).data.canSubmit, true);
    const denied = await f.call('/consumer/redemption-access', undefined, randomUUID(), f.b.token);
    assert.equal(denied.data.canSubmit, false);
    assert.equal(JSON.stringify(denied.data).includes(f.a.id), false);
    assert.equal(
      (await f.call('/consumer/redemption-quotes', f.quoteInput, randomUUID(), f.b.token)).status,
      403,
    );
    assert.equal(
      (await f.call('/consumer/redemption-quotes', f.quoteInput, randomUUID(), f.identity.token))
        .status,
      401,
    );
    assert.equal(
      (
        await f.call('/consumer/redemption-quotes', {
          ...f.quoteInput,
          deliveryMode: 'LOCAL_NO_CASH',
        })
      ).status,
      409,
    );
    const { id, quote } = await f.controlledOrder();
    assert.equal(quote.snapshot.executionMode, 'CONTROLLED');
    const row = await f.controlled.db.redemptionOrder.findUniqueOrThrow({ where: { id } });
    assert.equal(row.executionMode, 'CONTROLLED');
    assert.equal((await f.call('/consumer/redemptions/' + id)).data.executionMode, 'CONTROLLED');
    const print = await f.call(
      '/admin/redemptions/print-preview',
      { ids: [id] },
      randomUUID(),
      '',
      true,
    );
    assert.equal(print.status, 200);
    assert.equal(print.data.items[0].executionMode, 'CONTROLLED');
    const key = randomUUID(),
      ship = {
        version: 0,
        carrierCode: 'SF',
        trackingNo: 'SF-CONTROLLED-001',
        dispatchConfirmed: true,
      };
    assert.equal(
      (await f.call('/admin/redemptions/' + id + '/ship', ship, key, '', true)).status,
      200,
    );
    assert.equal(await f.controlled.db.redemptionPickingTask.count(), 0);
    assert.equal(
      (
        await f.call('/consumer/redemptions/' + id + '/after-sales', {
          category: 'OTHER',
          message: '合成受控反馈',
        })
      ).status,
      200,
    );
    f.config.pointsExpress.operations = false;
    assert.equal(
      (await f.call('/admin/redemptions/' + id + '/ship', ship, key, '', true)).status,
      200,
    );
    assert.equal(
      (
        await f.call(
          '/admin/redemptions/' + id + '/shipping-corrections',
          {
            version: 0,
            carrierCode: 'SF',
            trackingNo: 'SF-CONTROLLED-002',
            reason: '合成更正',
            verified: true,
          },
          randomUUID(),
          '',
          true,
        )
      ).status,
      503,
    );
    assert.equal(
      (
        await f.call('/consumer/redemptions/' + id + '/after-sales/supplement', {
          version: 0,
          message: '暂停时新反馈',
        })
      ).status,
      503,
    );
    assert.equal(
      (await f.call('/admin/redemptions/' + id + '/shipping', undefined, randomUUID(), '', true))
        .data.enabled,
      false,
    );
    await assert.rejects(
      f.controlled.db.redemptionOrder.update({
        where: { id },
        data: { executionMode: 'PRODUCTION' },
      }),
    );
  } finally {
    await f.cleanup();
  }
});
test('pausing submissions or removing eligibility preserves successful original request recovery and accepted-order cancellation', async () => {
  const f = await controlledExpressFixture();
  try {
    const { id, key, quote } = await f.controlledOrder();
    f.config.pointsExpress.submit = false;
    assert.equal((await f.call('/consumer/redemption-access')).data.canSubmit, false);
    assert.equal((await f.call('/consumer/redemption-quotes', f.quoteInput)).status, 503);
    assert.equal((await f.call('/consumer/redemptions', { quoteId: quote.id }, key)).status, 200);
    f.config.pointsExpress.allowedUsers = [f.b.id];
    assert.equal(
      (await f.call('/consumer/redemptions/' + id + '/cancel', { version: 0 })).status,
      200,
    );
    assert.equal(
      (await f.controlled.db.pointsAccount.findUniqueOrThrow({ where: { userId: f.a.id } }))
        .balance,
      1000n,
    );
    const allocations = await f.controlled.db.redemptionAllocation.findMany({
      where: { orderId: id },
    });
    assert.ok(allocations.every((a) => a.releaseLedgerId && !a.consumeLedgerId));
    assert.equal((await f.call('/consumer/redemptions', { quoteId: quote.id }, key)).status, 200);
    f.config.pointsExpress.submit = true;
    assert.equal((await f.call('/consumer/redemption-quotes', f.quoteInput)).status, 403);
  } finally {
    await f.cleanup();
  }
});
test('formal operations cannot consume development orders and cancellation racing controlled shipment settles exactly once', async () => {
  const f = await controlledExpressFixture();
  try {
    const dev = await f.createExpress();
    assert.equal(
      (
        await f.call(
          '/admin/redemptions/' + dev + '/ship',
          { version: 0, carrierCode: 'SF', trackingNo: 'SF-NO-DEV-001', dispatchConfirmed: true },
          randomUUID(),
          '',
          true,
        )
      ).status,
      503,
    );
    const { id } = await f.controlledOrder(),
      race = await Promise.all([
        f.call(
          '/admin/redemptions/' + id + '/ship',
          {
            version: 0,
            carrierCode: 'SF',
            trackingNo: 'SF-CONTROLLED-RACE',
            dispatchConfirmed: true,
          },
          randomUUID(),
          '',
          true,
        ),
        f.call('/consumer/redemptions/' + id + '/cancel', { version: 0 }),
      ]);
    assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
    const allocations = await f.controlled.db.redemptionAllocation.findMany({
        where: { orderId: id },
      }),
      shipped = await f.controlled.db.redemptionExpressShipment.count({ where: { orderId: id } });
    assert.ok(
      allocations.every((a) =>
        shipped
          ? !!a.consumeLedgerId && !a.releaseLedgerId
          : !!a.releaseLedgerId && !a.consumeLedgerId,
      ),
    );
    const report = await f.call(
      '/admin/redemption-express-readiness',
      undefined,
      randomUUID(),
      '',
      true,
    );
    assert.equal(report.data.canLaunch, false);
    assert.equal(report.data.metrics.inconsistentOrders, 0);
    assert.equal(JSON.stringify(report.data).includes(f.a.id), false);
  } finally {
    await f.cleanup();
  }
});
