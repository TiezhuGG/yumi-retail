import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { expressShippingFixture } from './helpers/express-shipping-fixture.ts';
import { RedemptionAfterSalesService } from '../apps/api/dist/redemption-after-sales.js';
import type { RedemptionReturnPage } from '../packages/contracts/src/index.ts';
type F = Awaited<ReturnType<typeof expressShippingFixture>>;
async function setup(work: (f: F, id: string) => Promise<void>) {
  const f = await expressShippingFixture();
  try {
    const id = await f.createExpress(2);
    assert.equal(
      (
        await f.api('/admin/redemptions/' + id + '/ship', {
          version: 0,
          carrierCode: 'SF',
          trackingNo: 'SF-RETURN-TEST',
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
const path = (id: string) => '/consumer/redemptions/' + id + '/returns';
const ap = (id: string, action: string) => '/admin/redemption-returns/' + id + '/' + action;
async function read(f: F, id: string) {
  return (await f.call<RedemptionReturnPage>(path(id))).data;
}
async function request(f: F, id: string, quantity = 1) {
  const r = await f.call(path(id), { quantity, reason: '合成商品问题，请按原价退积分' });
  assert.equal(r.status, 200);
  return r.data.id as string;
}
async function stock(f: F) {
  const d = f.runtime.db;
  return {
    stock: await d.stockBalance.findMany(),
    lots: await d.stockLot.findMany(),
    positions: await d.stockPosition.findMany(),
    ledger: await d.stockLedger.count(),
    pl: await d.positionLedger.count(),
    orders: await d.redemptionOrder.findMany(),
    allocations: await d.redemptionAllocation.findMany(),
  };
}
test('full return approval, complete isolated receipt and original-price refund happen exactly once without reselling or restoring quota', async () =>
  setup(async (f, id) => {
    const before = await stock(f),
      account = await f.runtime.db.pointsAccount.findUniqueOrThrow({
        where: { userId: f.identity.user.id },
      }),
      rid = await request(f, id, 2),
      k = randomUUID();
    assert.equal(
      (await f.api(ap(rid, 'approve'), { requiresReturn: true, reason: '请联系门店寄回' })).status,
      200,
    );
    assert.equal(
      (await f.api(ap(rid, 'refund'), { confirmed: true, reason: '尝试跳步' })).status,
      409,
    );
    assert.equal(
      (
        await f.api(ap(rid, 'receive'), {
          quantity: 1,
          condition: 'DAMAGED',
          location: '合成隔离区A',
          physicalConfirmed: true,
          reason: '不完整退货',
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.api(ap(rid, 'receive'), {
          quantity: 2,
          condition: 'DAMAGED',
          location: '合成隔离区A',
          physicalConfirmed: true,
          reason: '全部实物验收隔离',
        })
      ).status,
      200,
    );
    const body = { confirmed: true, reason: '按原积分价退还' };
    assert.equal((await f.api(ap(rid, 'refund'), body, k)).status, 200);
    assert.equal((await f.api(ap(rid, 'refund'), body, k)).status, 200);
    assert.equal((await f.api(ap(rid, 'refund'), body)).status, 409);
    assert.equal((await read(f, id)).items[0]!.state, 'REFUNDED');
    assert.equal((await read(f, id)).remainingQuantity, 0);
    const after = await f.runtime.db.pointsAccount.findUniqueOrThrow({
      where: { userId: f.identity.user.id },
    });
    assert.equal(after.balance - account.balance, 240n);
    assert.deepEqual(await stock(f), before);
    assert.equal(
      await f.runtime.db.pointsEntry.count({ where: { actionKey: 'RETURN_REFUND:' + rid } }),
      1,
    );
    const entries = (
      await f.call<{ items: Array<{ entryKind: string; redemptionId: string }> }>(
        '/consumer/points/ledger',
      )
    ).data.items;
    assert.ok(
      entries.some(
        (e: { entryKind: string; redemptionId: string }) =>
          e.entryKind === 'AFTER_SALES_RETURN' && e.redemptionId === id,
      ),
    );
  }));
test('partial no-return compensation reserves quantity and refunds only the original unit points', async () =>
  setup(async (f, id) => {
    const rid = await request(f, id);
    assert.equal((await read(f, id)).remainingQuantity, 1);
    assert.equal(
      (await f.api(ap(rid, 'approve'), { requiresReturn: false, reason: '无需退回实物' })).status,
      200,
    );
    assert.equal(
      (await f.api(ap(rid, 'refund'), { confirmed: true, reason: '补退一件原积分' })).status,
      200,
    );
    assert.equal((await read(f, id)).items[0]!.points, '120');
    const rid2 = await request(f, id);
    assert.notEqual(rid, rid2);
    assert.equal((await f.call(path(id), { quantity: 1, reason: '再次申请' })).status, 409);
  }));
test('rejection and owner cancellation release only return allowance, preserving all history', async () =>
  setup(async (f, id) => {
    const rid = await request(f, id, 2);
    assert.equal((await f.api(ap(rid, 'reject'), { reason: '合成证据不足' })).status, 200);
    assert.equal((await read(f, id)).remainingQuantity, 2);
    const r2 = await request(f, id, 2);
    assert.equal((await f.call(path(id) + '/' + r2 + '/cancel', {})).status, 200);
    assert.equal((await read(f, id)).remainingQuantity, 2);
    assert.deepEqual(
      (await read(f, id)).items.map((v) => v.state),
      ['REJECTED', 'CANCELED'],
    );
    assert.equal(
      (await f.api(ap(r2, 'approve'), { requiresReturn: false, reason: '不能审批已撤销' })).status,
      409,
    );
  }));
test('same key restores submission; changed input conflicts and concurrent quantity requests cannot exceed source', async () =>
  setup(async (f, id) => {
    const k = randomUUID(),
      body = { quantity: 1, reason: '合成同键申请' };
    const a = await f.call(path(id), body, k),
      b = await f.call(path(id), body, k);
    assert.equal(a.status, 200);
    assert.equal(b.data.id, a.data.id);
    assert.equal((await f.call(path(id), { ...body, quantity: 2 }, k)).status, 409);
    const rs = await Promise.all([f.call(path(id), body), f.call(path(id), body)]);
    assert.deepEqual(rs.map((x) => x.status).sort(), [200, 409]);
    assert.equal(await f.runtime.db.redemptionReturn.count(), 2);
  }));
test('another consumer and ordinary operations cannot read or refund another scope; CSRF and strict physical fields apply', async () =>
  setup(async (f, id) => {
    assert.equal((await f.call(path(id), undefined, undefined, f.identityB.token)).status, 404);
    const rid = await request(f, id),
      ops = await f.workerActor('OPERATIONS');
    assert.equal(
      (
        await f.api(
          ap(rid, 'approve'),
          { requiresReturn: false, reason: '无审批权限' },
          randomUUID(),
          ops.cookie,
          ops.csrf,
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.api(ap(rid, 'approve'), { requiresReturn: false, reason: '非法积分', points: 999 }))
        .status,
      400,
    );
    assert.equal(
      (await f.api(ap(rid, 'approve'), { requiresReturn: true, reason: '请退回' })).status,
      200,
    );
    assert.equal(
      (
        await f.api(ap(rid, 'receive'), {
          quantity: 1,
          condition: 'UNOPENED',
          location: '隔离区',
          physicalConfirmed: false,
          reason: '未核实',
        })
      ).status,
      400,
    );
    assert.equal((await f.call(path(id) + '/' + rid + '/cancel', {})).status, 409);
  }));
test('competing decision and refund requests commit one fact; no double credit', async () =>
  setup(async (f, id) => {
    const rid = await request(f, id);
    const rs = await Promise.all([
      f.api(ap(rid, 'approve'), { requiresReturn: false, reason: '批准' }),
      f.api(ap(rid, 'reject'), { reason: '拒绝' }),
    ]);
    assert.deepEqual(rs.map((x) => x.status).sort(), [200, 409]);
    if ((await read(f, id)).items[0]!.state === 'READY_TO_REFUND') {
      const refunds = await Promise.all([
        f.api(ap(rid, 'refund'), { confirmed: true, reason: '原积分退还' }),
        f.api(ap(rid, 'refund'), { confirmed: true, reason: '原积分退还' }),
      ]);
      assert.deepEqual(refunds.map((x) => x.status).sort(), [200, 409]);
    }
  }));
test('late audit failure rolls back approval and refund including balance, original key recovers once', async () =>
  setup(async (f, id) => {
    const rid = await request(f, id),
      db = f.runtime.db;
    await db.$executeRawUnsafe(
      "CREATE FUNCTION fail_return_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('RETURN_APPROVE','RETURN_REFUND') THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$",
    );
    for (const action of ['approve', 'refund']) {
      const body =
          action === 'approve'
            ? { requiresReturn: false, reason: '无需退货' }
            : { confirmed: true, reason: '原积分退还' },
        k = randomUUID(),
        before = await db.pointsAccount.findMany(),
        count = await db.redemptionReturnEvent.count();
      await db.$executeRawUnsafe(
        'CREATE TRIGGER fail_return_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_return_audit()',
      );
      assert.equal((await f.api(ap(rid, action), body, k)).status, 500);
      assert.deepEqual(await db.pointsAccount.findMany(), before);
      assert.equal(await db.redemptionReturnEvent.count(), count);
      await db.$executeRawUnsafe('DROP TRIGGER fail_return_audit ON business_audits');
      assert.equal((await f.api(ap(rid, action), body, k)).status, 200);
    }
  }));
test('SQL rejects extra quantities, fact mutation and orphaned refund credit', async () =>
  setup(async (f, id) => {
    const rid = await request(f, id),
      db = f.runtime.db;
    await assert.rejects(db.redemptionReturn.updateMany({ data: { quantity: 10 } }));
    await assert.rejects(db.redemptionReturn.deleteMany());
    const req = await db.redemptionReturn.findUniqueOrThrow({ where: { id: rid } });
    await assert.rejects(
      db.redemptionReturn.create({ data: { ...req, id: randomUUID(), quantity: 2 } }),
    );
    const admin = await db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } });
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.pointsAccount.update({
          where: { userId: f.identity.user.id },
          data: { balance: { increment: 120 }, version: { increment: 1 } },
        });
        await tx.pointsEntry.create({
          data: {
            id: randomUUID(),
            userId: f.identity.user.id,
            delta: 120,
            actorId: admin.id,
            actionKey: 'RETURN_REFUND:' + rid,
            reason: '合成无审批孤立退分',
          },
        });
      }),
    );
    assert.equal(await db.redemptionReturnEvent.count(), 0);
    assert.equal(
      (await f.api(ap(rid, 'approve'), { requiresReturn: true, reason: '合成退货审批' })).status,
      200,
    );
    await assert.rejects(
      db.redemptionReturnEvent.create({
        data: {
          id: randomUUID(),
          returnId: rid,
          kind: 'RECEIVE',
          actorId: admin.id,
          reasonPayload: req.reasonPayload,
          requestId: randomUUID(),
        },
      }),
    );
  }));
test('default-disabled writes stop new requests and refunds while preserving history', async () =>
  setup(async (f, id) => {
    const svc = f.runtime.app.get(RedemptionAfterSalesService);
    Object.defineProperty(svc, 'enabled', { value: false, configurable: true });
    assert.equal((await f.call(path(id), { quantity: 1, reason: '关闭时申请' })).status, 503);
    Object.defineProperty(svc, 'enabled', { value: true });
    const rid = await request(f, id);
    assert.equal(
      (await f.api(ap(rid, 'approve'), { requiresReturn: false, reason: '批准' })).status,
      200,
    );
    Object.defineProperty(svc, 'enabled', { value: false });
    assert.equal(
      (await f.api(ap(rid, 'refund'), { confirmed: true, reason: '关闭时退分' })).status,
      503,
    );
    assert.equal((await read(f, id)).items[0]!.state, 'READY_TO_REFUND');
  }));
for (const phase of ['approve', 'refund'])
  test('late staff session expiry rolls back ' + phase, async () =>
    setup(async (f, id) => {
      const rid = await request(f, id);
      if (phase === 'refund')
        assert.equal(
          (await f.api(ap(rid, 'approve'), { requiresReturn: false, reason: '同意退款' })).status,
          200,
        );
      const db = f.runtime.db,
        admin = await db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } }),
        before = await db.pointsAccount.findMany(),
        count = await db.redemptionReturnEvent.count();
      await db.$executeRawUnsafe(
        "CREATE FUNCTION slow_return_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('RETURN_APPROVE','RETURN_REFUND') THEN PERFORM pg_sleep(1); END IF; RETURN NEW; END $$",
      );
      await db.$executeRawUnsafe(
        'CREATE TRIGGER slow_return_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION slow_return_audit()',
      );
      await db.staffSession.updateMany({
        where: { staffId: admin.id },
        data: { expiresAt: new Date(Date.now() + 700) },
      });
      const body =
        phase === 'approve'
          ? { requiresReturn: false, reason: '批准' }
          : { confirmed: true, reason: '原积分退款' };
      assert.equal((await f.api(ap(rid, phase), body)).status, 403);
      assert.deepEqual(await db.pointsAccount.findMany(), before);
      assert.equal(await db.redemptionReturnEvent.count(), count);
    }),
  );
test('consumer expiry during insertion rolls back request and allowance', async () =>
  setup(async (f, id) => {
    const db = f.runtime.db;
    await db.$executeRawUnsafe(
      'CREATE FUNCTION slow_return_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$',
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER slow_return_request BEFORE INSERT ON redemption_returns FOR EACH ROW EXECUTE FUNCTION slow_return_request()',
    );
    await db.consumerSession.updateMany({
      where: { userId: f.identity.user.id },
      data: { expiresAt: new Date(Date.now() + 700) },
    });
    assert.equal((await f.call(path(id), { quantity: 2, reason: '合成过期检查' })).status, 401);
    assert.equal(await db.redemptionReturn.count(), 0);
  }));
test('admin state/search filters and cursors stay in the active warehouse and filter scope', async () =>
  setup(async (f, id) => {
    const rejected = await request(f, id);
    await f.api(ap(rejected, 'reject'), { reason: '合成驳回' });
    const rid = await request(f, id);
    await f.api(ap(rid, 'approve'), { requiresReturn: true, reason: '合成退货审核' });
    const list = async (q: string) => {
      const r = await fetch(f.base + '/api/v1/admin/redemption-returns?' + q, {
        headers: { Cookie: f.cookie },
      });
      return { status: r.status, ...(await r.json()) };
    };
    assert.equal((await list('status=WAIT_RETURN')).data.items[0].id, rid);
    assert.equal((await list('status=REQUESTED')).data.items.length, 0);
    assert.equal((await list('status=WAIT_RETURN&cursor=' + rejected)).status, 409);
    assert.equal((await list('status=NOT_REAL')).status, 400);
    assert.equal((await list('keyword=' + encodeURIComponent('不存在商品'))).data.items.length, 0);
    await f.api(ap(rid, 'receive'), {
      quantity: 1,
      condition: 'UNOPENED',
      location: '合成隔离区',
      physicalConfirmed: true,
      reason: '完整验收',
    });
    assert.equal((await list('status=WAIT_RETURN')).data.items.length, 0);
    assert.equal((await list('status=READY_TO_REFUND')).data.items[0].id, rid);
  }));
