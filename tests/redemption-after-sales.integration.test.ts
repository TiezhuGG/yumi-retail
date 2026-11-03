import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expressShippingFixture } from './helpers/express-shipping-fixture.ts';
import { RedemptionAfterSalesService } from '../apps/api/dist/redemption-after-sales.js';
import type {
  RedemptionAfterSalesView,
  RedemptionAfterSalesPage,
} from '../packages/contracts/src/index.ts';
type F = Awaited<ReturnType<typeof expressShippingFixture>>;
const input = { category: 'DAMAGED', message: '合成包装破损，请核实处理' };
const path = (id: string) => '/consumer/redemptions/' + id + '/after-sales';
const admin = (id: string) => '/admin/redemption-after-sales/' + id;
async function setup(work: (f: F, id: string) => Promise<void>) {
  const f = await expressShippingFixture();
  try {
    const id = await f.createExpress();
    assert.equal(
      (
        await f.api('/admin/redemptions/' + id + '/ship', {
          version: 0,
          carrierCode: 'SF',
          trackingNo: 'SF-E4B-000001',
          dispatchConfirmed: true,
        })
      ).status,
      200,
    );
    await work(f, id);
  } finally {
    await f.cleanup();
  }
}
async function read(f: F, id: string) {
  const r = await f.call<RedemptionAfterSalesView>(path(id));
  assert.equal(r.status, 200);
  return r.data;
}
async function stock(f: F) {
  const d = f.runtime.db;
  return {
    orders: await d.redemptionOrder.findMany({ orderBy: { id: 'asc' } }),
    shipments: await d.redemptionExpressShipment.findMany({ orderBy: { id: 'asc' } }),
    allocations: await d.redemptionAllocation.findMany({ orderBy: { id: 'asc' } }),
    stock: await d.stockBalance.findMany({ orderBy: { skuId: 'asc' } }),
    lots: await d.stockLot.findMany({ orderBy: { id: 'asc' } }),
    positions: await d.stockPosition.findMany({ orderBy: { id: 'asc' } }),
    stockEntries: await d.stockLedger.count(),
    positionEntries: await d.positionLedger.count(),
    points: await d.pointsAccount.findMany({ orderBy: { userId: 'asc' } }),
    entries: await d.pointsEntry.count(),
    jobs: await d.redemptionOutbox.findMany({ orderBy: { orderId: 'asc' } }),
  };
}

test('encrypted feedback, supplements, public replies, closure and reopening keep complete history without changing fulfillment or accounts', async () =>
  setup(async (f, id) => {
    const before = await stock(f),
      key = randomUUID();
    assert.equal((await read(f, id)).canSubmit, true);
    assert.equal((await f.call(path(id), input, key)).status, 200);
    assert.equal((await f.call(path(id), input, key)).status, 200);
    assert.equal((await f.call(path(id), { ...input, message: 'changed' }, key)).status, 409);
    assert.equal((await f.call(path(id), input)).status, 409);
    assert.equal(
      (await f.call(path(id) + '/supplement', { version: 0, message: '合成补充说明' })).status,
      200,
    );
    const k = randomUUID();
    assert.equal(
      (await f.api(admin(id) + '/reply', { version: 1, message: '合成门店已联系核查' }, k)).status,
      200,
    );
    assert.equal(
      (await f.api(admin(id) + '/reply', { version: 1, message: '合成门店已联系核查' }, k)).status,
      200,
    );
    assert.equal(
      (await f.api(admin(id) + '/close', { version: 2, message: '合成沟通完成，本次反馈结束' }))
        .status,
      200,
    );
    assert.equal(
      (await f.call(path(id) + '/supplement', { version: 3, message: 'wrong action' })).status,
      409,
    );
    assert.equal(
      (await f.call(path(id) + '/reopen', { version: 3, message: '合成问题仍需帮助' })).status,
      200,
    );
    assert.equal(
      (await f.api(admin(id) + '/reply', { version: 4, message: '合成继续核查' })).status,
      200,
    );
    assert.equal(
      (await f.api(admin(id) + '/close', { version: 5, message: '合成再次沟通结束' })).status,
      200,
    );
    const v = await read(f, id);
    assert.equal(v.ticket!.status, 'CLOSED');
    assert.equal(v.ticket!.version, 6);
    assert.equal(v.ticket!.events.length, 7);
    assert.equal(v.canSubmit, false);
    assert.equal(v.ticket!.events[2]!.actor, 'STORE');
    assert.equal(v.ticket!.events[2]!.message, '合成门店已联系核查');
    assert.equal('staffName' in v.ticket!.events[2]!, false);
    assert.equal('staffId' in v.ticket!.events[2]!, false);
    assert.equal('address' in v, false);
    const staff = await f.api(admin(id));
    assert.ok((staff.data as unknown as RedemptionAfterSalesView).ticket!.events[2]!.staffName);
    const rows = await f.runtime.db.redemptionAfterSalesEvent.findMany();
    assert.equal(JSON.stringify(rows).includes(input.message), false);
    assert.ok(rows.every((e) => e.messagePayload.startsWith('v1.')));
    assert.deepEqual(await stock(f), before);
    assert.equal(
      (await f.call('/consumer/redemptions/' + id + '/cancel', { version: 0 })).status,
      409,
    );
  }));

test('owner, warehouse, role, csrf, strict input, shipped express source and state revisions are enforced', async () =>
  setup(async (f, id) => {
    assert.equal((await f.call(path(id), input, randomUUID(), f.identityB.token)).status, 404);
    assert.equal((await f.call(path(id), undefined, randomUUID(), f.identityB.token)).status, 404);
    for (const b of [
      { ...input, extra: true },
      { ...input, category: 'BAD' },
      { ...input, message: '' },
      { ...input, message: 'bad\u0001text' },
      { ...input, message: 'x'.repeat(501) },
    ])
      assert.equal((await f.call(path(id), b)).status, 400);
    const pending = await f.createExpress();
    assert.equal((await read(f, pending)).canSubmit, false);
    assert.equal((await f.call(path(pending), input)).status, 409);
    assert.equal(
      (await f.call('/consumer/redemptions/' + pending + '/cancel', { version: 0 })).status,
      200,
    );
    assert.equal((await f.call(path(pending), input)).status, 409);
    const q = await f.call('/consumer/redemption-quotes', f.input),
      o = await f.call('/consumer/redemptions', { quoteId: q.data.id });
    assert.equal((await f.call(path(o.data.id), input)).status, 409);
    assert.equal(
      (await f.call(path(id) + '/reopen', { version: 0, message: 'not created' })).status,
      409,
    );
    assert.equal((await f.call(path(id), input)).status, 200);
    const picker = await f.workerActor('PICKER');
    assert.equal(
      (
        await f.api(
          admin(id) + '/reply',
          { version: 0, message: 'invalid' },
          randomUUID(),
          picker.cookie,
          picker.csrf,
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.api(admin(id), undefined, randomUUID(), picker.cookie, picker.csrf)).status,
      403,
    );
    assert.equal(
      (
        await f.api(
          admin(id) + '/reply',
          { version: 0, message: 'invalid' },
          randomUUID(),
          f.cookie,
          'wrong',
        )
      ).status,
      403,
    );
    const w = randomUUID();
    await f.runtime.db.warehouse.create({
      data: { id: w, code: 'AFTER-SALES-OTHER', name: '合成异仓' },
    });
    const other = await f.workerActor('OPERATIONS', w);
    assert.equal(
      (await f.api(admin(id), undefined, randomUUID(), other.cookie, other.csrf)).status,
      403,
    );
    assert.equal((await f.api(admin(id) + '/reply', { version: 1, message: 'stale' })).status, 409);
    assert.equal(
      (await f.call(path(id) + '/reopen', { version: 0, message: 'not closed' })).status,
      409,
    );
    assert.equal((await f.api(admin(id) + '/close', { version: 0, message: '' })).status, 400);
    for (const query of [
      '?status=BAD',
      '?keyword=' + encodeURIComponent('x'.repeat(81)),
      '?cursor=bad',
      '?unknown=1',
    ])
      assert.equal((await f.api('/admin/redemption-after-sales' + query)).status, 400);
  }));

test('create and action races commit exactly one revision; filters and pagination cursors do not expose private message bodies', async () =>
  setup(async (f, id) => {
    const first = await Promise.all([
      f.call(path(id), input),
      f.call(path(id), { ...input, message: '另一并发反馈' }),
    ]);
    assert.deepEqual(first.map((x) => x.status).sort(), [200, 409]);
    const next = await Promise.all([
      f.api(admin(id) + '/reply', { version: 0, message: 'reply' }),
      f.api(admin(id) + '/close', { version: 0, message: 'close' }),
    ]);
    assert.deepEqual(next.map((x) => x.status).sort(), [200, 409]);
    assert.equal((await read(f, id)).ticket!.events.length, 2);
    const status = (await read(f, id)).ticket!.status;
    const list = await f.api('/admin/redemption-after-sales?status=' + status);
    const p = list.data as unknown as RedemptionAfterSalesPage;
    assert.equal(p.items.length, 1);
    assert.equal('message' in p.items[0]!, false);
    assert.equal(p.nextCursor, null);
    const ticket = await f.runtime.db.redemptionAfterSales.findUniqueOrThrow({
      where: { orderId: id },
    });
    assert.equal(
      (
        (await f.api('/admin/redemption-after-sales?cursor=' + ticket.id))
          .data as unknown as RedemptionAfterSalesPage
      ).items.length,
      0,
    );
    assert.equal(
      (
        (await f.api('/admin/redemption-after-sales?keyword=unmatched'))
          .data as unknown as RedemptionAfterSalesPage
      ).items.length,
      0,
    );
    assert.equal(
      (
        (
          await f.api(
            '/admin/redemption-after-sales?keyword=' +
              encodeURIComponent((await read(f, id)).orderNo),
          )
        ).data as unknown as RedemptionAfterSalesPage
      ).items.length,
      1,
    );
  }));

test('late initial event failure and staff audit failure restore the entire operation and allow original-key recovery', async () =>
  setup(async (f, id) => {
    const d = f.runtime.db,
      k = randomUUID(),
      before = await stock(f);
    await d.$executeRawUnsafe(
      "CREATE FUNCTION fail_aftersales_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$",
    );
    await d.$executeRawUnsafe(
      'CREATE TRIGGER fail_aftersales_event BEFORE INSERT ON redemption_after_sales_events FOR EACH ROW EXECUTE FUNCTION fail_aftersales_event()',
    );
    assert.equal((await f.call(path(id), input, k)).status, 500);
    assert.equal(await d.redemptionAfterSales.count(), 0);
    assert.equal(await d.redemptionAfterSalesEvent.count(), 0);
    assert.deepEqual(await stock(f), before);
    await d.$executeRawUnsafe(
      'DROP TRIGGER fail_aftersales_event ON redemption_after_sales_events',
    );
    assert.equal((await f.call(path(id), input, k)).status, 200);
    assert.equal((await f.call(path(id), input, k)).status, 200);
    await d.$executeRawUnsafe(
      "CREATE FUNCTION fail_aftersales_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'REDEMPTION_AFTER_SALES_%' THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$",
    );
    await d.$executeRawUnsafe(
      'CREATE TRIGGER fail_aftersales_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_aftersales_audit()',
    );
    const replyKey = randomUUID();
    assert.equal(
      (await f.api(admin(id) + '/reply', { version: 0, message: 'repair' }, replyKey)).status,
      500,
    );
    assert.equal((await read(f, id)).ticket!.version, 0);
    assert.equal(await d.redemptionAfterSalesEvent.count(), 1);
    await d.$executeRawUnsafe('DROP TRIGGER fail_aftersales_audit ON business_audits');
    assert.equal(
      (await f.api(admin(id) + '/reply', { version: 0, message: 'repair' }, replyKey)).status,
      200,
    );
    assert.equal(
      (await f.api(admin(id) + '/reply', { version: 0, message: 'repair' }, replyKey)).status,
      200,
    );
    assert.deepEqual(await stock(f), before);
  }));

test('consumer session expiring during event write rolls back ticket, encrypted payload and original request result', async () =>
  setup(async (f, id) => {
    const d = f.runtime.db,
      k = randomUUID();
    await d.$executeRawUnsafe(
      "CREATE FUNCTION expire_aftersales_consumer() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN UPDATE consumer_sessions SET created_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()-interval '1 millisecond' WHERE user_id=NEW.consumer_id; RETURN NEW; END $$",
    );
    await d.$executeRawUnsafe(
      'CREATE TRIGGER expire_aftersales_consumer AFTER INSERT ON redemption_after_sales_events FOR EACH ROW EXECUTE FUNCTION expire_aftersales_consumer()',
    );
    assert.equal((await f.call(path(id), input, k)).status, 401);
    assert.equal(await d.redemptionAfterSales.count(), 0);
    assert.equal(await d.redemptionAfterSalesEvent.count(), 0);
    await d.$executeRawUnsafe(
      'DROP TRIGGER expire_aftersales_consumer ON redemption_after_sales_events',
    );
    assert.equal((await f.call(path(id), input, k)).status, 200);
  }));

test('paused gate permits reads and successful original requests only; replay still checks current authorization', async () =>
  setup(async (f, id) => {
    const k = randomUUID();
    assert.equal((await f.call(path(id), input, k)).status, 200);
    const rk = randomUUID();
    assert.equal(
      (await f.api(admin(id) + '/reply', { version: 0, message: '合成有效回复' }, rk)).status,
      200,
    );
    const service = f.runtime.app.get(RedemptionAfterSalesService);
    Object.defineProperty(service, 'enabled', { value: false, configurable: true });
    try {
      assert.equal((await read(f, id)).enabled, false);
      assert.equal((await f.call(path(id), input, k)).status, 200);
      assert.equal(
        (await f.call(path(id) + '/supplement', { version: 1, message: 'paused' })).status,
        503,
      );
      assert.equal(
        (await f.api(admin(id) + '/reply', { version: 0, message: '合成有效回复' }, rk)).status,
        200,
      );
      assert.equal(
        (await f.api(admin(id) + '/close', { version: 1, message: 'paused' })).status,
        503,
      );
    } finally {
      Object.defineProperty(service, 'enabled', { value: true, configurable: true });
    }
    const actor = await f.runtime.db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } });
    await f.runtime.db.staffWarehouse.deleteMany({ where: { staffId: actor.id } });
    assert.equal(
      (await f.api(admin(id) + '/reply', { version: 0, message: '合成有效回复' }, rk)).status,
      403,
    );
  }));

test('database requires shipped source, original consumer, complete immutable event chain and matching status projection', async () =>
  setup(async (f, id) => {
    const d = f.runtime.db;
    const o = await d.redemptionOrder.findUniqueOrThrow({ where: { id } });
    await assert.rejects(
      d.redemptionAfterSales.create({
        data: {
          id: randomUUID(),
          orderId: id,
          userId: o.userId,
          warehouseId: o.warehouseId,
          category: 'OTHER',
        },
      }),
    );
    assert.equal((await f.call(path(id), input)).status, 200);
    const c = await d.redemptionAfterSales.findUniqueOrThrow({ where: { orderId: id } });
    await assert.rejects(
      d.redemptionAfterSales.update({
        where: { id: c.id },
        data: { status: 'CLOSED', version: 1 },
      }),
    );
    await assert.rejects(
      d.redemptionAfterSales.update({
        where: { id: c.id },
        data: { category: 'OTHER', version: 1 },
      }),
    );
    await assert.rejects(d.redemptionAfterSales.deleteMany());
    await assert.rejects(d.redemptionAfterSalesEvent.deleteMany());
    await assert.rejects(
      d.redemptionAfterSalesEvent.updateMany({ data: { messagePayload: 'v1.overwrite' } }),
    );
    const b = {
      id: randomUUID(),
      caseId: c.id,
      version: 1,
      kind: 'SUPPLEMENTED',
      status: 'OPEN',
      messagePayload: 'v1.fake',
      consumerId: f.identityB.userId,
      requestId: randomUUID(),
    };
    const foreign = await d.consumerUser.findFirstOrThrow({ where: { id: { not: o.userId } } });
    await assert.rejects(
      d.redemptionAfterSalesEvent.create({ data: { ...b, consumerId: foreign.id } }),
    );
    await assert.rejects(
      d.redemptionAfterSalesEvent.create({ data: { ...b, consumerId: o.userId, version: 5 } }),
    );
    assert.equal((await read(f, id)).ticket!.events.length, 1);
  }));
