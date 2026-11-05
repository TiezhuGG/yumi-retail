import assert from 'node:assert/strict';
import { expressShippingFixture } from './express-shipping-fixture.ts';
export async function consumerReturnsFixture(extraCanceled = 0) {
  const f = await expressShippingFixture();
  try {
    const orderId = await f.createExpress(4);
    assert.equal(
      (
        await f.api('/admin/redemptions/' + orderId + '/ship', {
          version: 0,
          carrierCode: 'SF',
          trackingNo: 'SF-CONSUMER-RETURN-LIST',
          dispatchConfirmed: true,
        })
      ).status,
      200,
    );
    const request = async (reason = '合成售后申请') => {
      const r = await f.call<{ id: string }>('/consumer/redemptions/' + orderId + '/returns', {
        quantity: 1,
        reason,
      });
      assert.equal(r.status, 200);
      return r.data.id;
    };
    const action = async (id: string, name: string, body: unknown) =>
      assert.equal((await f.api('/admin/redemption-returns/' + id + '/' + name, body)).status, 200);
    const rejected = await request('合成未通过申请');
    await action(rejected, 'reject', { reason: '合成未通过原因' });
    const canceled = await request('合成撤销申请');
    assert.equal(
      (await f.call('/consumer/redemptions/' + orderId + '/returns/' + canceled + '/cancel', {}))
        .status,
      200,
    );
    for (let i = 0; i < extraCanceled; i++) {
      const id = await request('合成历史撤销申请');
      assert.equal(
        (await f.call('/consumer/redemptions/' + orderId + '/returns/' + id + '/cancel', {}))
          .status,
        200,
      );
    }
    const requested = await request('合成待审核说明'),
      waiting = await request('合成需退货说明'),
      ready = await request('合成等待退积分说明'),
      refunded = await request('合成已退积分说明');
    await action(waiting, 'approve', { requiresReturn: true, reason: '合成需寄回原因' });
    await action(ready, 'approve', { requiresReturn: false, reason: '合成无需寄回' });
    await action(refunded, 'approve', { requiresReturn: false, reason: '合成无需寄回' });
    await action(refunded, 'refund', { confirmed: true, reason: '合成原额退还' });
    return { ...f, orderId, requested, waiting, ready, refunded, rejected, canceled };
  } catch (e) {
    await f.cleanup();
    throw e;
  }
}
