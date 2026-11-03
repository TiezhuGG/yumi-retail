import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expressShippingFixture } from './helpers/express-shipping-fixture.ts';
import { ExpressReadinessService } from '../apps/api/dist/express-readiness.js';
import { createApplication } from '../apps/api/dist/app.js';
import type {
  RedemptionOrderView,
  RedemptionAfterSalesView,
} from '../packages/contracts/src/index.ts';
test('API process recreation preserves encrypted snapshots, shipment/correction/feedback facts and successful original requests without repeated stock or points', async () => {
  const f = await expressShippingFixture();
  let restarted: Awaited<ReturnType<typeof createApplication>> | undefined;
  try {
    const id = await f.createExpress(),
      shipKey = randomUUID(),
      correctionKey = randomUUID(),
      feedbackKey = randomUUID();
    const ship = {
        version: 0,
        carrierCode: 'SF',
        trackingNo: 'SF-RESTART-ORIGINAL-001',
        dispatchConfirmed: true,
      },
      correction = {
        version: 0,
        carrierCode: 'SF',
        trackingNo: 'SF-RESTART-CURRENT-001',
        reason: '合成重启核对',
        verified: true,
      },
      feedback = { category: 'OTHER', message: '合成重启后保留反馈' };
    assert.equal((await f.api('/admin/redemptions/' + id + '/ship', ship, shipKey)).status, 200);
    assert.equal(
      (await f.api('/admin/redemptions/' + id + '/shipping-corrections', correction, correctionKey))
        .status,
      200,
    );
    assert.equal(
      (await f.call('/consumer/redemptions/' + id + '/after-sales', feedback, feedbackKey)).status,
      200,
    );
    const original = (await f.call<RedemptionOrderView>('/consumer/redemptions/' + id)).data;
    const points = await f.runtime.db.pointsEntry.count(),
      ledger = await f.runtime.db.stockLedger.count();
    const schema = (
      await f.runtime.db.$queryRaw<Array<{ schema: string }>>`SELECT current_schema() AS schema`
    )[0]!.schema;
    assert.match(schema, /^address_ui_[a-f0-9]+$/);
    const config = f.runtime.app.get(ExpressReadinessService).config,
      url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('schema', schema);
    await f.runtime.close();
    restarted = await createApplication(url.toString(), { config, accessLog: () => {} });
    await restarted.app.listen(0, '127.0.0.1');
    const base = await restarted.app.getUrl();
    async function request(path: string, body?: unknown, key?: string, staff = false) {
      const response = await fetch(base + '/api/v1' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(staff
            ? {
                Cookie: f.cookie,
                Origin: 'http://127.0.0.1:5188',
                'X-CSRF-Token': f.profile.csrfToken,
              }
            : { Authorization: 'Bearer ' + f.identity.token }),
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    }
    const order = await request('/consumer/redemptions/' + id);
    assert.equal(order.status, 200);
    assert.deepEqual(order.body.data.address, original.address);
    assert.equal(order.body.data.expressShipment.trackingNo, correction.trackingNo);
    assert.equal(order.body.data.expressShipment.shippedAt, original.expressShipment!.shippedAt);
    const view = await request('/consumer/redemptions/' + id + '/after-sales');
    assert.equal(view.status, 200);
    assert.equal(
      (view.body.data as RedemptionAfterSalesView).ticket!.events[0]!.message,
      feedback.message,
    );
    assert.equal(
      (await request('/admin/redemptions/' + id + '/ship', ship, shipKey, true)).status,
      200,
    );
    assert.equal(
      (
        await request(
          '/admin/redemptions/' + id + '/shipping-corrections',
          correction,
          correctionKey,
          true,
        )
      ).status,
      200,
    );
    assert.equal(
      (await request('/consumer/redemptions/' + id + '/after-sales', feedback, feedbackKey)).status,
      200,
    );
    assert.equal(await restarted.db.pointsEntry.count(), points);
    assert.equal(await restarted.db.stockLedger.count(), ledger);
    assert.equal(await restarted.db.redemptionExpressShipment.count(), 1);
    assert.equal(await restarted.db.redemptionExpressShipmentCorrection.count(), 1);
    assert.equal(await restarted.db.redemptionAfterSalesEvent.count(), 1);
    assert.equal(await restarted.db.redemptionPickingTask.count(), 0);
  } finally {
    await restarted?.close();
    await f.cleanup();
  }
});
