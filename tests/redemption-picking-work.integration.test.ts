import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { runRedemptionPickingOnce } from '../packages/database/dist/index.js';
import { RedemptionPickingService } from '../apps/api/dist/redemption-picking.js';
import { redemptionPickingFixture } from './helpers/redemption-picking-fixture.ts';
async function fixture(
  work: (f: Awaited<ReturnType<typeof redemptionPickingFixture>>, id: string) => Promise<void>,
) {
  const f = await redemptionPickingFixture();
  try {
    const id = await f.order();
    await runRedemptionPickingOnce(f.runtime.db);
    assert.equal((await f.api(f.prefix + '/' + id + '/claim', { version: 0 })).status, 200);
    await work(f, id);
  } finally {
    await f.cleanup();
  }
}
test('exact original allocation quantities, idempotent checks and completion preserve points and stock', async () =>
  fixture(async (f, id) => {
    const before = {
      points: await f.runtime.db.pointsAccount.findMany(),
      stock: await f.runtime.db.stockBalance.findMany(),
      ledger: await f.runtime.db.stockLedger.count(),
    };
    let v = (await f.read(id)).data.items[0]!;
    const a = v.lines[0]!;
    assert.equal(
      (await f.api(f.prefix + '/' + id + '/complete', { version: 1 })).error?.code,
      'PICKING_INCOMPLETE',
    );
    assert.equal(
      (
        await f.api(f.prefix + '/' + id + '/check', {
          version: 1,
          allocationId: randomUUID(),
          quantity: 1,
        })
      ).error?.code,
      'ALLOCATION_INVALID',
    );
    assert.equal(
      (await f.api(f.prefix + '/' + id + '/check', { version: 1, allocationId: a.id, quantity: 2 }))
        .error?.code,
      'QUANTITY_MISMATCH',
    );
    const key = randomUUID(),
      body = { version: 1, allocationId: a.id, quantity: a.quantity };
    assert.equal((await f.api(f.prefix + '/' + id + '/check', body, key)).status, 200);
    assert.equal((await f.api(f.prefix + '/' + id + '/check', body, key)).status, 200);
    v = (await f.read(id)).data.items[0]!;
    assert.equal(v.lines[0]!.checked, true);
    assert.equal(v.work.canComplete, true);
    const k = randomUUID();
    assert.equal((await f.api(f.prefix + '/' + id + '/complete', { version: 2 }, k)).status, 200);
    assert.equal((await f.api(f.prefix + '/' + id + '/complete', { version: 2 }, k)).status, 200);
    assert.equal((await f.read(id)).data.items[0]!.state, 'CHECKED');
    assert.equal(
      (await f.call('/consumer/redemptions/' + id)).data.fulfillmentState,
      'PICKED_WAIT_PACK',
    );
    assert.equal(
      (await f.call('/consumer/redemptions/' + id + '/cancel', { version: 0 })).error?.code,
      'CANCELLATION_REVIEW_REQUIRED',
    );
    assert.equal(
      (
        await f.api(f.prefix + '/' + id + '/report', {
          version: 3,
          allocationId: a.id,
          quantity: 1,
          kind: 'DAMAGE',
        })
      ).error?.code,
      'VERSION_CONFLICT',
    );
    assert.deepEqual(await f.runtime.db.pointsAccount.findMany(), before.points);
    assert.deepEqual(await f.runtime.db.stockBalance.findMany(), before.stock);
    assert.equal(await f.runtime.db.stockLedger.count(), before.ledger);
    assert.equal(await f.runtime.db.redemptionPickingWork.count(), 2);
  }));
test('shortage and damage invalidate earlier checks; resolution preserves issue and requires owner recheck', async () =>
  fixture(async (f, id) => {
    const a = (await f.read(id)).data.items[0]!.lines[0]!;
    const path = f.prefix + '/' + id;
    assert.equal(
      (await f.api(path + '/check', { version: 1, allocationId: a.id, quantity: 1 })).status,
      200,
    );
    for (const [version, kind] of [
      [2, 'SHORTAGE'],
      [5, 'DAMAGE'],
    ] as const) {
      assert.equal(
        (await f.api(path + '/report', { version, allocationId: a.id, quantity: 1, kind })).status,
        200,
      );
      const v = (await f.read(id)).data.items[0]!,
        issue = v.lines[0]!.issue!;
      assert.equal(v.lines[0]!.checked, false);
      assert.equal(issue.kind, kind);
      assert.equal(v.work.canComplete, false);
      assert.equal(
        (await f.api(path + '/complete', { version: version + 1 })).error?.code,
        'PICKING_INCOMPLETE',
      );
      assert.equal(
        (await f.api(path + '/check', { version: version + 1, allocationId: a.id, quantity: 1 }))
          .error?.code,
        'PICKING_ISSUE_OPEN',
      );
      assert.equal(
        (
          await f.api(path + '/report', {
            version: version + 1,
            allocationId: a.id,
            quantity: 1,
            kind,
          })
        ).error?.code,
        'PICKING_ISSUE_OPEN',
      );
      assert.equal(
        (
          await f.api(path + '/resolve', {
            version: version + 1,
            allocationId: a.id,
            quantity: 1,
            issueId: randomUUID(),
          })
        ).error?.code,
        'ISSUE_CHANGED',
      );
      assert.equal(
        (
          await f.api(path + '/resolve', {
            version: version + 1,
            allocationId: a.id,
            quantity: 1,
            issueId: issue.id,
          })
        ).status,
        200,
      );
      assert.equal(
        (await f.api(path + '/complete', { version: version + 2 })).error?.code,
        'PICKING_INCOMPLETE',
      );
      assert.equal(
        (await f.api(path + '/check', { version: version + 2, allocationId: a.id, quantity: 1 }))
          .status,
        200,
      );
    }
    assert.equal((await f.api(path + '/complete', { version: 8 })).status, 200);
    assert.equal(
      await f.runtime.db.redemptionPickingWork.count({
        where: { action: { in: ['SHORTAGE', 'DAMAGE'] } },
      }),
      2,
    );
  }));
test('current owner, warehouse, manager resolution, CSRF and strict payload checks apply to work and replay', async () =>
  fixture(async (f, id) => {
    const picker = await f.workerActor(),
      rider = await f.workerActor('RIDER'),
      a = (await f.read(id)).data.items[0]!.lines[0]!;
    async function post(actor: typeof picker, action: string, body: unknown, csrf = actor.csrf) {
      const r = await fetch(f.base + '/api/v1' + f.prefix + '/' + id + '/' + action, {
        method: 'POST',
        headers: {
          Cookie: actor.cookie,
          Origin: 'http://127.0.0.1:5188',
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': randomUUID(),
        },
        body: JSON.stringify(body),
      });
      return { status: r.status, ...(await r.json()) };
    }
    for (const action of ['check', 'report', 'complete']) {
      const b =
        action === 'complete'
          ? { version: 1 }
          : {
              version: 1,
              allocationId: a.id,
              quantity: 1,
              ...(action === 'report' ? { kind: 'DAMAGE' } : {}),
            };
      assert.equal((await post(picker, action, b)).status, 403);
      assert.equal((await post(rider, action, b)).status, 403);
    }
    assert.equal(
      (
        await post(picker, 'resolve', {
          version: 1,
          allocationId: a.id,
          quantity: 1,
          issueId: randomUUID(),
        })
      ).status,
      403,
    );
    assert.equal((await post(picker, 'complete', { version: 1 }, 'bad')).status, 403);
    for (const body of [
      { version: 1, allocationId: a.id, quantity: 0 },
      { version: 1, allocationId: a.id, quantity: 1.1 },
      { version: 1, allocationId: a.id, quantity: 1, extra: true },
    ])
      assert.equal((await f.api(f.prefix + '/' + id + '/check', body)).status, 400);
    await f.runtime.db.staffWarehouse.deleteMany({ where: { staffId: picker.id } });
    assert.equal((await post(picker, 'complete', { version: 1 })).status, 403);
  }));
test('concurrent check/report and complete/report serialize with stale version rejection', async () =>
  fixture(async (f, id) => {
    const a = (await f.read(id)).data.items[0]!.lines[0]!,
      p = f.prefix + '/' + id;
    const results = await Promise.all([
      f.api(p + '/check', { version: 1, allocationId: a.id, quantity: 1 }),
      f.api(p + '/report', { version: 1, allocationId: a.id, quantity: 1, kind: 'DAMAGE' }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    let v = (await f.read(id)).data.items[0]!;
    if (v.lines[0]!.issue) {
      assert.equal(
        (
          await f.api(p + '/resolve', {
            version: v.task!.version,
            allocationId: a.id,
            quantity: 1,
            issueId: v.lines[0]!.issue!.id,
          })
        ).status,
        200,
      );
      v = (await f.read(id)).data.items[0]!;
      assert.equal(
        (await f.api(p + '/check', { version: v.task!.version, allocationId: a.id, quantity: 1 }))
          .status,
        200,
      );
    }
    v = (await f.read(id)).data.items[0]!;
    const race = await Promise.all([
      f.api(p + '/complete', { version: v.task!.version }),
      f.api(p + '/report', {
        version: v.task!.version,
        allocationId: a.id,
        quantity: 1,
        kind: 'SHORTAGE',
      }),
    ]);
    assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
    v = (await f.read(id)).data.items[0]!;
    if (v.state === 'CHECKED') assert.equal(v.lines[0]!.issue, null);
    else {
      assert.ok(v.lines[0]!.issue);
      assert.equal(v.work.canComplete, false);
    }
  }));
test('stock holds block checks and completion, while reporting remains available', async () =>
  fixture(async (f, id) => {
    const db = f.runtime.db,
      a = (await f.read(id)).data.items[0]!.lines[0]!,
      p = f.prefix + '/' + id;
    await db.stockBalance.updateMany({
      where: { warehouseId: f.warehouseId, skuId: f.catalog.skuIds[0]! },
      data: { inventoryHold: true },
    });
    assert.equal(
      (await f.api(p + '/check', { version: 1, allocationId: a.id, quantity: 1 })).error?.code,
      'PICKING_BLOCKED',
    );
    assert.equal(
      (await f.api(p + '/report', { version: 1, allocationId: a.id, quantity: 1, kind: 'DAMAGE' }))
        .status,
      200,
    );
    const v = (await f.read(id)).data.items[0]!;
    assert.equal(
      (
        await f.api(p + '/resolve', {
          version: 2,
          allocationId: a.id,
          quantity: 1,
          issueId: v.lines[0]!.issue!.id,
        })
      ).error?.code,
      'PICKING_BLOCKED',
    );
  }));
test('immutable work/source constraints and missing fact prevent SQL bypass', async () =>
  fixture(async (f, id) => {
    const db = f.runtime.db,
      t = await db.redemptionPickingTask.findUniqueOrThrow({ where: { orderId: id } }),
      a = (await f.read(id)).data.items[0]!.lines[0]!;
    await assert.rejects(
      db.redemptionPickingTask.update({
        where: { id: t.id },
        data: { version: 2, state: 'CHECKED' },
      }),
    );
    await assert.rejects(
      db.$transaction(async (tx) => {
        await tx.redemptionPickingTask.update({
          where: { id: t.id },
          data: { version: 2, state: 'CHECKED' },
        });
        await tx.redemptionPickingWork.create({
          data: {
            id: randomUUID(),
            taskId: t.id,
            orderId: id,
            version: 2,
            action: 'COMPLETE',
            actorId: t.ownerId!,
            requestId: randomUUID(),
          },
        });
      }),
    );
    assert.equal(
      (await f.api(f.prefix + '/' + id + '/check', { version: 1, allocationId: a.id, quantity: 1 }))
        .status,
      200,
    );
    await assert.rejects(db.redemptionPickingWork.updateMany({ data: { quantity: 100 } }));
    await assert.rejects(db.redemptionPickingWork.deleteMany());
    assert.equal((await f.read(id)).data.items[0]!.task!.version, 2);
  }));

test('late audit failure rolls back all four actions and each original key can resume once', async () =>
  fixture(async (f, id) => {
    const db = f.runtime.db,
      a = (await f.read(id)).data.items[0]!.lines[0]!,
      p = f.prefix + '/' + id;
    await db.$executeRawUnsafe(
      "CREATE FUNCTION reject_work_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('REDEMPTION_PICKING_CHECK','REDEMPTION_PICKING_REPORT','REDEMPTION_PICKING_RESOLVE','REDEMPTION_PICKING_COMPLETE') THEN RAISE EXCEPTION 'synthetic work audit failure'; END IF; RETURN NEW; END $$",
    );
    let version = 1;
    for (const action of ['report', 'resolve', 'check', 'complete']) {
      const v = (await f.read(id)).data.items[0]!,
        issue = v.lines[0]!.issue;
      const body =
          action === 'complete'
            ? { version }
            : {
                version,
                allocationId: a.id,
                quantity: 1,
                ...(action === 'report' ? { kind: 'SHORTAGE' } : {}),
                ...(action === 'resolve' ? { issueId: issue!.id } : {}),
              },
        k = randomUUID(),
        count = await db.redemptionPickingWork.count();
      await db.$executeRawUnsafe(
        'CREATE TRIGGER reject_work_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION reject_work_audit()',
      );
      assert.equal((await f.api(p + '/' + action, body, k)).status, 500);
      assert.equal((await f.read(id)).data.items[0]!.task!.version, version);
      assert.equal(await db.redemptionPickingWork.count(), count);
      await db.$executeRawUnsafe('DROP TRIGGER reject_work_audit ON business_audits');
      assert.equal((await f.api(p + '/' + action, body, k)).status, 200);
      assert.equal((await f.api(p + '/' + action, body, k)).status, 200);
      assert.equal(await db.redemptionPickingWork.count(), count + 1);
      version++;
    }
  }));

test('expiry during completion audit rolls back checked state and completion evidence', async () =>
  fixture(async (f, id) => {
    const db = f.runtime.db,
      a = (await f.read(id)).data.items[0]!.lines[0]!,
      p = f.prefix + '/' + id;
    assert.equal(
      (await f.api(p + '/check', { version: 1, allocationId: a.id, quantity: 1 })).status,
      200,
    );
    const lot = await db.stockLot.findFirstOrThrow({ where: { skuId: f.catalog.skuIds[0]! } });
    await db.stockLot.update({
      where: { id: lot.id },
      data: { producedAt: new Date(0), expiresAt: new Date(Date.now() + 700) },
    });
    await db.$executeRawUnsafe(
      "CREATE FUNCTION slow_work_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='REDEMPTION_PICKING_COMPLETE' THEN PERFORM pg_sleep(1); END IF; RETURN NEW; END $$",
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER slow_work_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION slow_work_audit()',
    );
    assert.equal((await f.api(p + '/complete', { version: 2 })).error?.code, 'PICKING_BLOCKED');
    assert.equal((await f.read(id)).data.items[0]!.state, 'CLAIMED');
    assert.equal(await db.redemptionPickingWork.count({ where: { action: 'COMPLETE' } }), 0);
  }));

test('multi-batch reservations require every full allocation, and one partial shortage blocks the whole task', async () => {
  const f = await redemptionPickingFixture();
  try {
    const reviewer = await f.reviewer(),
      me = await fetch(f.base + '/api/v1/staff/me', { headers: { Cookie: reviewer } }),
      csrf = (await me.json()).data.csrfToken;
    const prefix = '/warehouse/warehouses/' + f.warehouseId;
    const receipt = await f.api(prefix + '/receipts', {
      sourceRef: randomUUID(),
      lines: [
        { skuId: f.catalog.skuIds[0]!, batchNo: 'P4B-SECOND', quantity: 3, unitCostCents: 100 },
      ],
    });
    assert.equal(receipt.status, 200);
    assert.equal(
      (
        await f.api(
          prefix + '/receipts/' + receipt.data.id + '/approve',
          { version: 0 },
          randomUUID(),
          reviewer,
          csrf,
        )
      ).status,
      200,
    );
    assert.equal(
      (await f.api(prefix + '/receipts/' + receipt.data.id + '/post', { version: 1 })).status,
      200,
    );
    assert.equal(
      (
        await f.api('/admin/rewards/' + f.rewardId + '/update', {
          title: '合成多批次纸巾',
          pointsPrice: '120',
          sortOrder: 10,
          version: 1,
          perUserLimit: 8,
          totalQuota: 20,
          reason: '合成多批次验证',
        })
      ).status,
      200,
    );
    const q = await f.call('/consumer/redemption-quotes', {
      ...f.input,
      rewardVersion: 2,
      quantity: 6,
    });
    assert.equal(q.status, 200);
    const o = await f.call('/consumer/redemptions', { quoteId: q.data.id });
    assert.equal(o.status, 200);
    const id = o.data.id,
      p = f.prefix + '/' + id;
    await runRedemptionPickingOnce(f.runtime.db);
    assert.equal((await f.api(p + '/claim', { version: 0 })).status, 200);
    const v = (await f.read(id)).data.items[0]!;
    assert.equal(v.lines.length, 2);
    assert.equal(
      v.lines.reduce((s, l) => s + l.quantity, 0),
      6,
    );
    const a = v.lines.find((l) => l.quantity > 1)!,
      b = v.lines.find((l) => l.id !== a.id)!;
    assert.equal(
      (await f.api(p + '/check', { version: 1, allocationId: a.id, quantity: a.quantity - 1 }))
        .error?.code,
      'QUANTITY_MISMATCH',
    );
    assert.equal(
      (await f.api(p + '/check', { version: 1, allocationId: b.id, quantity: b.quantity })).status,
      200,
    );
    assert.equal((await f.api(p + '/complete', { version: 2 })).error?.code, 'PICKING_INCOMPLETE');
    assert.equal(
      (
        await f.api(p + '/report', {
          version: 2,
          allocationId: a.id,
          quantity: 1,
          kind: 'SHORTAGE',
        })
      ).status,
      200,
    );
    const issue = (await f.read(id)).data.items[0]!.lines.find((l) => l.id === a.id)!.issue!;
    assert.equal(
      (
        await f.api(p + '/resolve', {
          version: 3,
          allocationId: a.id,
          quantity: 1,
          issueId: issue.id,
        })
      ).error?.code,
      'QUANTITY_MISMATCH',
    );
    assert.equal(
      (
        await f.api(p + '/resolve', {
          version: 3,
          allocationId: a.id,
          quantity: a.quantity,
          issueId: issue.id,
        })
      ).status,
      200,
    );
    assert.equal((await f.api(p + '/complete', { version: 4 })).error?.code, 'PICKING_INCOMPLETE');
    assert.equal(
      (await f.api(p + '/check', { version: 4, allocationId: a.id, quantity: a.quantity })).status,
      200,
    );
    assert.equal((await f.api(p + '/complete', { version: 5 })).status, 200);
  } finally {
    await f.cleanup();
  }
});

test('revocation between preliminary authorization and transaction blocks work; revoked callers cannot replay', async () =>
  fixture(async (f, id) => {
    const db = f.runtime.db,
      service = f.runtime.app.get(RedemptionPickingService),
      staff = await db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } }),
      a = (await f.read(id)).data.items[0]!.lines[0]!,
      p = f.prefix + '/' + id,
      key = randomUUID();
    const body = { version: 1, allocationId: a.id, quantity: 1 };
    assert.equal((await f.api(p + '/check', body, key)).status, 200);
    const original = service.catalog.write.bind(service.catalog);
    service.catalog.write = async (...args) => {
      await db.staffWarehouse.deleteMany({ where: { staffId: staff.id } });
      return original(...args);
    };
    try {
      assert.equal((await f.api(p + '/complete', { version: 2 })).status, 403);
    } finally {
      service.catalog.write = original;
    }
    assert.equal(await db.redemptionPickingWork.count({ where: { action: 'COMPLETE' } }), 0);
    assert.equal((await f.api(p + '/check', body, key)).status, 403);
    await db.staffWarehouse.create({ data: { staffId: staff.id, warehouseId: f.warehouseId } });
    assert.equal((await f.api(p + '/check', body, key)).status, 200);
    assert.equal((await f.api(p + '/complete', { version: 2 })).status, 200);
  }));
