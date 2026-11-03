import assert from 'node:assert/strict';
import { redemptionDeliveryFixture } from './redemption-delivery-fixture.ts';
export async function expressShippingFixture() {
  const f = await redemptionDeliveryFixture();
  try {
    const a = await f.call('/consumer/express-addresses', {
      version: 0,
      province: '浙江省',
      city: '杭州市',
      district: '西湖区',
      detailAddress: '合成快递路1号101',
      contactName: '合成快递收件人',
      phone: '00000000000',
      note: '合成收件说明',
      isDefault: true,
    });
    assert.equal(a.status, 200);
    assert.equal(
      (
        await f.api('/admin/redemption-express-policy/update', {
          version: 0,
          enabled: true,
          provinces: ['浙江省'],
          shippingFeeMode: 'SENDER_PAID',
          reason: '合成快递发货验证',
        })
      ).status,
      200,
    );
    async function createExpress(quantity = 1) {
      const q = await f.call('/consumer/redemption-quotes', {
        ...f.input,
        quantity,
        deliveryMode: 'EXPRESS',
        addressId: a.data.id,
        addressVersion: 1,
      });
      assert.equal(q.status, 200);
      const o = await f.call('/consumer/redemptions', { quoteId: q.data.id });
      assert.equal(o.status, 200);
      return o.data.id;
    }
    return { ...f, createExpress };
  } catch (e) {
    await f.cleanup();
    throw e;
  }
}
