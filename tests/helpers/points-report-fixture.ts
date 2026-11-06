// All source actions are real APIs, using synthetic identities in an auto-cleaned test schema.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expressShippingFixture } from './express-shipping-fixture.ts';
export async function pointsReportFixture() {
  const f = await expressShippingFixture();
  try {
    const reviewer = await f.reviewer();
    const { data: reviewProfile } = await (
      await fetch(f.base + '/api/v1/staff/me', { headers: { Cookie: reviewer } })
    ).json();
    assert.equal(
      (
        await f.api('/admin/points/grants/store/policy', {
          version: 0,
          enabled: true,
          singleLimit: '1000000000',
          dailyLimit: '1000000000',
          reason: '合成报表预算',
        })
      ).status,
      200,
    );
    async function grant(reference = 'REPORT', amount = '120') {
      const g = await f.api('/admin/points/grants/store/create', {
        userId: f.identity.user.id,
        amount,
        reference,
        reason: '合成报表发放',
      });
      assert.equal(g.status, 200);
      assert.equal(
        (
          await f.api(
            '/admin/points/grants/' + g.data.id + '/approve',
            { version: 0, reason: '合成报表独立审批' },
            randomUUID(),
            reviewer,
            reviewProfile.csrfToken,
          )
        ).status,
        200,
      );
      return g.data.id;
    }
    const grantId = await grant();
    const correction = await f.api('/admin/points/corrections/store/create', {
      grantId,
      amount: '10',
      reference: 'REPORT-CORRECTION',
      reason: '合成误发冲正',
    });
    assert.equal(correction.status, 200);
    assert.equal(
      (
        await f.api(
          '/admin/points/corrections/' + correction.data.id + '/approve',
          { version: 0, reason: '合成独立冲正' },
          randomUUID(),
          reviewer,
          reviewProfile.csrfToken,
        )
      ).status,
      200,
    );
    const canceled = await f.createExpress();
    assert.equal(
      (await f.call('/consumer/redemptions/' + canceled + '/cancel', { version: 0 })).status,
      200,
    );
    const shipped = await f.createExpress();
    assert.equal(
      (
        await f.api('/admin/redemptions/' + shipped + '/ship', {
          version: 0,
          carrierCode: 'SF',
          trackingNo: 'SF-REPORT',
          dispatchConfirmed: true,
        })
      ).status,
      200,
    );
    const ret = await f.call('/consumer/redemptions/' + shipped + '/returns', {
      quantity: 1,
      reason: '合成售后报表',
    });
    assert.equal(ret.status, 200);
    const returnId = ret.data.id;
    assert.equal(
      (
        await f.api('/admin/redemption-returns/' + returnId + '/approve', {
          requiresReturn: false,
          reason: '合成无需退回',
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.api('/admin/redemption-returns/' + returnId + '/refund', {
          confirmed: true,
          reason: '合成退回积分',
        })
      ).status,
      200,
    );
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    return { ...f, grantId, grant, returnId, reportQuery: '?from=' + today + '&to=' + today };
  } catch (e) {
    await f.cleanup();
    throw e;
  }
}
