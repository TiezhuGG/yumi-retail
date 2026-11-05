import assert from 'node:assert/strict';
import { redemptionFixture } from './redemption-fixture.ts';
export async function pointsCartFixture() {
  const f = await redemptionFixture({ limit: 5 });
  try {
    const a = await f.call('/consumer/express-addresses', {
      version: 0,
      province: '浙江省',
      city: '杭州市',
      district: '西湖区',
      detailAddress: '合成路1号',
      contactName: '合成顾客',
      phone: '00000000000',
      note: '仅隔离验证',
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
          reason: '隔离购物车验证',
        })
      ).status,
      200,
    );
    const reward = await f.api('/admin/rewards/store/create', {
      sortOrder: 20,
      startsAt: null,
      endsAt: null,
      reason: '隔离购物车商品',
      skuId: f.catalog.skuIds[1],
      title: '合成第二款商品',
      pointsPrice: '200',
      perUserLimit: 5,
      totalQuota: 20,
    });
    assert.equal(reward.status, 200);
    assert.equal(
      (
        await f.api('/admin/rewards/' + reward.data.id + '/publish', {
          version: 0,
          reason: '隔离上架',
        })
      ).status,
      200,
    );
    const cartInput = {
      items: [
        { rewardId: f.rewardId, rewardVersion: 1, quantity: 1 },
        { rewardId: reward.data.id, rewardVersion: 1, quantity: 2 },
      ],
      addressId: a.data.id,
      addressVersion: 1,
    };
    return { ...f, cartInput, secondRewardId: reward.data.id };
  } catch (e) {
    await f.cleanup();
    throw e;
  }
}
