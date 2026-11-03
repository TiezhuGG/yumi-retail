import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { redemptionDeliveryFixture } from './helpers/redemption-delivery-fixture.ts';
import { runRedemptionPickingOnce } from '../packages/database/dist/index.js';
import type {
  ExpressAddressBook,
  RedemptionPrintPreview,
  RedemptionOrderView,
} from '../packages/contracts/src/index.ts';
type F = Awaited<ReturnType<typeof redemptionDeliveryFixture>>;
async function setup(work: (f: F) => Promise<void>) {
  const f = await redemptionDeliveryFixture();
  try {
    await work(f);
  } finally {
    await f.cleanup();
  }
}
const address = {
  version: 0,
  province: '浙江省',
  city: '杭州市',
  district: '西湖区',
  detailAddress: '合成街道1号101',
  contactName: '合成快递收件人',
  phone: '00000000000',
  note: '合成门牌说明',
  isDefault: true,
};
async function prepare(f: F) {
  const a = await f.call('/consumer/express-addresses', address);
  assert.equal(a.status, 200);
  const policy = {
    version: 0,
    enabled: true,
    provinces: ['浙江省'],
    shippingFeeMode: 'SENDER_PAID',
    reason: '合成限定范围及商家承担运费',
  };
  assert.equal((await f.api('/admin/redemption-express-policy/update', policy)).status, 200);
  return { ...f.input, deliveryMode: 'EXPRESS', addressId: a.data.id, addressVersion: 1 };
}
async function quote(f: F, input: unknown) {
  const q = await f.call('/consumer/redemption-quotes', input);
  assert.equal(q.status, 200, JSON.stringify(q.error));
  return q;
}
test('independent encrypted express addresses enforce owner, version, default/delete and original-key replay without changing local book', async () =>
  setup(async (f) => {
    const k = randomUUID();
    const a = await f.call('/consumer/express-addresses', address, k);
    assert.equal(a.status, 200);
    assert.equal((await f.call('/consumer/express-addresses', address, k)).data.id, a.data.id);
    assert.equal(
      (await f.call('/consumer/express-addresses', { ...address, city: '变更市' }, k)).status,
      409,
    );
    assert.equal(
      (
        await f.call(
          '/consumer/express-addresses/' + a.data.id + '/update',
          { ...address, version: 1 },
          randomUUID(),
          f.identityB.token,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await f.call('/consumer/express-addresses/' + a.data.id + '/update', {
          ...address,
          version: 0,
        })
      ).status,
      409,
    );
    const book = await f.call<ExpressAddressBook>('/consumer/express-addresses');
    assert.equal(book.data.items[0]!.available, false);
    assert.equal((await f.call('/consumer/addresses')).data.items.length, 1);
    const saved = await f.runtime.db.consumerExpressAddress.findUniqueOrThrow({
      where: { id: a.data.id },
    });
    assert.ok(!saved.payload!.includes(address.detailAddress));
    assert.ok(!saved.payload!.includes(address.contactName));
    const races = await Promise.all([
      f.call('/consumer/express-addresses/' + a.data.id + '/update', {
        ...address,
        version: 1,
        detailAddress: '合成甲地址',
      }),
      f.call('/consumer/express-addresses/' + a.data.id + '/update', {
        ...address,
        version: 1,
        detailAddress: '合成乙地址',
      }),
    ]);
    assert.deepEqual(races.map((r) => r.status).sort(), [200, 409]);
    assert.equal(
      (await f.call('/consumer/express-addresses/' + a.data.id + '/delete', { version: 2 })).status,
      200,
    );
    assert.equal(
      (await f.call<ExpressAddressBook>('/consumer/express-addresses')).data.items.length,
      0,
    );
    assert.equal(
      (await f.runtime.db.consumerExpressAddress.findUniqueOrThrow({ where: { id: a.data.id } }))
        .payload,
      null,
    );
  }));
test('express exchange snapshots address/fee, debits once, stays out of picking/rider queues, prints and cancels with balanced refund', async () =>
  setup(async (f) => {
    const input = await prepare(f),
      before = await f.runtime.db.pointsAccount.findUniqueOrThrow({
        where: { userId: f.identity.user.id },
      }),
      q = await quote(f, input),
      k = randomUUID();
    assert.equal(q.data.snapshot.deliveryMode, 'EXPRESS');
    assert.equal(q.data.snapshot.shippingFeeCents, 0);
    const o = await f.call('/consumer/redemptions', { quoteId: q.data.id }, k);
    assert.equal(o.status, 200, JSON.stringify(o.error));
    assert.equal(
      (await f.call('/consumer/redemptions', { quoteId: q.data.id }, k)).data.id,
      o.data.id,
    );
    assert.equal(
      (await f.runtime.db.redemptionOrder.findUniqueOrThrow({ where: { id: o.data.id } }))
        .deliveryMode,
      'EXPRESS',
    );
    assert.equal(
      (await f.runtime.db.redemptionOutbox.findUniqueOrThrow({ where: { orderId: o.data.id } }))
        .state,
      'EXPRESS_WAIT',
    );
    await runRedemptionPickingOnce(f.runtime.db);
    assert.equal(await f.runtime.db.redemptionPickingTask.count(), 0);
    await assert.rejects(
      f.runtime.db.redemptionPickingTask.create({
        data: {
          id: randomUUID(),
          orderId: o.data.id,
          warehouseId: f.warehouseId,
          skuId: f.catalog.skuIds[0]!,
        },
      }),
    );
    await assert.rejects(
      f.runtime.db.redemptionOutbox.update({
        where: { orderId: o.data.id },
        data: { state: 'PENDING', version: 1 },
      }),
    );
    const view = await f.call<RedemptionOrderView>('/consumer/redemptions/' + o.data.id);
    assert.equal(view.data.fulfillmentState, 'EXPRESS_WAIT_SHIP');
    assert.equal(
      (view.data.address as { detailAddress: string }).detailAddress,
      address.detailAddress,
    );
    assert.equal(
      (
        await f.call('/consumer/express-addresses/' + input.addressId + '/update', {
          ...address,
          version: 1,
          detailAddress: '合成编辑后地址',
        })
      ).status,
      200,
    );
    const print = await f.api('/admin/redemptions/print-preview', { ids: [o.data.id] });
    assert.equal(print.status, 200);
    const sheet = (print.data as unknown as RedemptionPrintPreview).items[0]!;
    assert.equal(sheet.deliveryMode, 'EXPRESS');
    assert.equal((sheet.address as { detailAddress: string }).detailAddress, address.detailAddress);
    assert.equal(
      (await f.call('/consumer/redemptions/' + o.data.id + '/cancel', { version: 0 })).status,
      200,
    );
    assert.equal(
      (
        await f.runtime.db.pointsAccount.findUniqueOrThrow({
          where: { userId: f.identity.user.id },
        })
      ).balance,
      before.balance,
    );
    assert.equal(
      (await f.runtime.db.redemptionOutbox.findUniqueOrThrow({ where: { orderId: o.data.id } }))
        .state,
      'CANCELED',
    );
    assert.ok(
      (await f.runtime.db.redemptionAllocation.findMany({ where: { orderId: o.data.id } })).every(
        (x) => x.releaseLedgerId,
      ),
    );
  }));
test('missing/paused/range policies, foreign addresses and changed quote rules reject before debit; legacy local orders remain local', async () =>
  setup(async (f) => {
    const a = await f.call('/consumer/express-addresses', address),
      input = { ...f.input, deliveryMode: 'EXPRESS', addressId: a.data.id, addressVersion: 1 };
    assert.equal((await f.call('/consumer/redemption-quotes', input)).status, 409);
    await f.call<ExpressAddressBook>(
      '/consumer/express-addresses',
      undefined,
      randomUUID(),
      f.identityB.token,
    );
    assert.equal(
      (
        await f.call(
          '/consumer/redemption-quotes',
          { ...input, addressVersion: 0 },
          randomUUID(),
          f.identityB.token,
        )
      ).status,
      404,
    );
    const policy = {
      version: 0,
      enabled: true,
      provinces: ['江苏省'],
      shippingFeeMode: 'SENDER_PAID',
      reason: '合成规则',
    };
    assert.equal((await f.api('/admin/redemption-express-policy/update', policy)).status, 200);
    assert.equal((await f.call('/consumer/redemption-quotes', input)).status, 409);
    assert.equal(
      (
        await f.api('/admin/redemption-express-policy/update', {
          ...policy,
          version: 1,
          provinces: ['浙江省'],
        })
      ).status,
      200,
    );
    const q = await quote(f, input);
    assert.equal(
      (
        await f.api('/admin/redemption-express-policy/update', {
          ...policy,
          version: 2,
          provinces: ['浙江省'],
          enabled: false,
        })
      ).status,
      200,
    );
    assert.equal((await f.call('/consumer/redemptions', { quoteId: q.data.id })).status, 409);
    assert.equal(await f.runtime.db.redemptionOrder.count(), 0);
    assert.equal(
      (
        await f.api('/admin/redemption-express-policy/update', {
          ...policy,
          version: 3,
          enabled: true,
          provinces: ['浙江省'],
        })
      ).status,
      200,
    );
    assert.equal((await f.call('/consumer/redemptions', { quoteId: q.data.id })).status, 409);
    const local = await quote(f, f.input),
      o = await f.call('/consumer/redemptions', { quoteId: local.data.id });
    assert.equal(o.status, 200);
    await runRedemptionPickingOnce(f.runtime.db);
    assert.equal(await f.runtime.db.redemptionPickingTask.count(), 1);
    assert.equal(
      (await f.runtime.db.redemptionOrder.findUniqueOrThrow({ where: { id: o.data.id } }))
        .deliveryMode,
      'LOCAL_NO_CASH',
    );
  }));
test('policy changes require scoped staff, valid sender-paid configuration, version, audit and original key; later failures roll back express exchange', async () =>
  setup(async (f) => {
    const picker = await f.workerActor('PICKER'),
      policy = {
        version: 0,
        enabled: true,
        provinces: ['浙江省'],
        shippingFeeMode: 'SENDER_PAID',
        reason: '合成开放',
      };
    assert.equal(
      (
        await f.api(
          '/admin/redemption-express-policy/update',
          policy,
          randomUUID(),
          picker.cookie,
          picker.csrf,
        )
      ).status,
      403,
    );
    for (const b of [
      { ...policy, shippingFeeMode: 'COLLECT' },
      { ...policy, provinces: [] },
      { ...policy, provinces: ['浙江省', '浙江省'] },
    ])
      assert.equal((await f.api('/admin/redemption-express-policy/update', b)).status, 400);
    const k = randomUUID();
    assert.equal((await f.api('/admin/redemption-express-policy/update', policy, k)).status, 200);
    assert.equal((await f.api('/admin/redemption-express-policy/update', policy, k)).status, 200);
    assert.equal((await f.api('/admin/redemption-express-policy/update', policy)).status, 409);
    const a = await f.call('/consumer/express-addresses', address),
      q = await quote(f, {
        ...f.input,
        deliveryMode: 'EXPRESS',
        addressId: a.data.id,
        addressVersion: 1,
      });
    const before = await f.runtime.db.pointsAccount.findMany();
    await f.runtime.db.$executeRawUnsafe(
      `CREATE FUNCTION fail_express_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$`,
    );
    await f.runtime.db.$executeRawUnsafe(
      'CREATE TRIGGER fail_express_event BEFORE INSERT ON redemption_events FOR EACH ROW EXECUTE FUNCTION fail_express_event()',
    );
    const key = randomUUID();
    assert.equal((await f.call('/consumer/redemptions', { quoteId: q.data.id }, key)).status, 500);
    assert.equal(await f.runtime.db.redemptionOrder.count(), 0);
    assert.deepEqual(await f.runtime.db.pointsAccount.findMany(), before);
    await f.runtime.db.$executeRawUnsafe('DROP TRIGGER fail_express_event ON redemption_events');
    assert.equal((await f.call('/consumer/redemptions', { quoteId: q.data.id }, key)).status, 200);
  }));
