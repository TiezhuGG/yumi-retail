import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PickingLabTask } from '../packages/contracts/src/index.ts';
import { pickingFixture } from './helpers/picking-fixture.ts';
let f: Awaited<ReturnType<typeof pickingFixture>>;
const base = '/warehouse/picking-lab';
async function csrf(cookie: string) {
  return (await f.staff('/staff/me', cookie)).data.csrfToken as string;
}
async function post(
  suffix: string,
  body: unknown,
  cookie = f.extraCookies[0]!,
  token?: string,
  origin = 'http://127.0.0.1:5188',
) {
  const r = await fetch(f.base + '/api/v1' + base + suffix + '?warehouseId=' + f.warehouseId, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: origin,
      'X-CSRF-Token': token ?? (await csrf(cookie)),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, ...(await r.json()) };
}
async function create() {
  const r = await post('', { key: randomUUID() });
  assert.equal(r.status, 200);
  return r.data.task;
}
async function detail(id: string) {
  const r = await f.staff(base + '/' + id + '?warehouseId=' + f.warehouseId, f.pickerCookie);
  assert.equal(r.status, 200);
  return r.data;
}
beforeEach(async () => {
  f = await pickingFixture({ pickingLab: true });
});
afterEach(async () => {
  if (f) await f.cleanup();
});

async function claimed() {
  const t = await create();
  assert.equal(
    (await post('/' + t.id + '/claim', { key: randomUUID(), version: 0 }, f.pickerCookie)).status,
    200,
  );
  return (await detail(t.id)).task;
}
const reportBody = (t: { version: number; exceptionVersion: number }, lineId = 'PAPER_SINGLE') => ({
  key: randomUUID(),
  version: t.version,
  exceptionVersion: t.exceptionVersion,
  lineId,
  missingQuantity: 1,
  reason: 'MISSING',
});
const restoreBody = (t: { version: number; exceptionVersion: number }, quantity = 2) => ({
  key: randomUUID(),
  version: t.version,
  exceptionVersion: t.exceptionVersion,
  shortageVersion: 0,
  confirmedQuantity: quantity,
});
async function report(
  t: { id: string; version: number; exceptionVersion: number },
  lineId = 'PAPER_SINGLE',
) {
  const r = await post('/' + t.id + '/shortages', reportBody(t, lineId), f.pickerCookie);
  assert.equal(r.status, 200);
  return r.data.task;
}
async function restore(
  t: PickingLabTask,
  sid: string,
  quantity = 2,
  body = restoreBody(t, quantity),
) {
  return post('/' + t.id + '/shortages/' + sid + '/restore', body);
}
test('report/restore inputs, role, owner, warehouse and CSRF are enforced', async () => {
  const t = await claimed(),
    p = reportBody(t),
    path = '/' + t.id + '/shortages';
  assert.equal((await post(path, p)).status, 403);
  assert.equal((await post(path, p, f.pickerCookie, '')).status, 403);
  for (const body of [
    { ...p, lineId: 'REAL' },
    { ...p, missingQuantity: 0 },
    { ...p, reason: 'REFUND' },
    { ...p, orderId: randomUUID() },
    { ...p, exceptionVersion: undefined },
  ])
    assert.equal((await post(path, body, f.pickerCookie)).status, 400);
  assert.equal((await post(path, { ...p, missingQuantity: 3 }, f.pickerCookie)).status, 409);
  const r = await post(path, p, f.pickerCookie);
  assert.equal(r.status, 200);
  const d = r.data.task,
    sid = d.shortages[0].id;
  assert.equal(
    (await post('/' + t.id + '/shortages/' + sid + '/restore', restoreBody(d), f.pickerCookie))
      .status,
    403,
  );
  assert.equal((await restore(d, sid, 1)).status, 409);
  assert.equal((await restore(d, randomUUID())).status, 404);
  const other = await create();
  assert.equal(
    (
      await post('/' + other.id + '/shortages/' + sid + '/restore', {
        ...restoreBody(d),
        version: 0,
        exceptionVersion: 0,
      })
    ).status,
    409,
  );
  const token = await csrf(f.extraCookies[0]!);
  const raw = await fetch(
    f.base + '/api/v1' + base + '/' + t.id + '/shortages?warehouseId=' + randomUUID(),
    {
      method: 'POST',
      headers: {
        Cookie: f.extraCookies[0]!,
        Origin: 'http://127.0.0.1:5188',
        'X-CSRF-Token': token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(p),
    },
  );
  assert.equal(raw.status, 403);
});
test('same report key is once and every unchecked line is blocked until all open records are restored', async () => {
  const t = await claimed(),
    body = reportBody(t),
    r = await Promise.all(
      Array.from({ length: 8 }, () => post('/' + t.id + '/shortages', body, f.pickerCookie)),
    );
  assert.ok(r.every((x) => x.status === 200));
  assert.equal(r.filter((x) => !x.data.duplicate).length, 1);
  let d = (await detail(t.id)).task;
  assert.equal(d.version, 1);
  assert.equal(d.exceptionVersion, 1);
  assert.equal(d.shortages.length, 1);
  assert.equal(d.events.length, 2);
  assert.equal(
    await f.runtime.db.businessAudit.count({ where: { action: 'PICKING_LAB_REPORT' } }),
    1,
  );
  assert.equal(
    (
      await post(
        '/' + t.id + '/shortages',
        { ...body, key: randomUUID(), exceptionVersion: 1 },
        f.pickerCookie,
      )
    ).status,
    409,
  );
  for (const lineId of ['PAPER_SINGLE', 'PAPER_TRIPLE'])
    assert.equal(
      (
        await post(
          '/' + t.id + '/check',
          {
            key: randomUUID(),
            version: 1,
            exceptionVersion: 1,
            lineId,
            quantity: lineId === 'PAPER_SINGLE' ? 2 : 1,
          },
          f.pickerCookie,
        )
      ).status,
      409,
    );
  d = await report(d, 'PAPER_TRIPLE');
  assert.equal(d.exceptionVersion, 2);
  let rr = await restore(
    d,
    d.shortages.find((s: PickingLabTask['shortages'][number]) => s.lineId === 'PAPER_SINGLE').id,
  );
  assert.equal(rr.status, 200);
  d = rr.data.task;
  assert.equal(
    d.shortages.filter((s: PickingLabTask['shortages'][number]) => s.state === 'OPEN').length,
    1,
  );
  assert.equal(
    (
      await post(
        '/' + t.id + '/check',
        { key: randomUUID(), version: 1, exceptionVersion: 3, lineId: 'PAPER_SINGLE', quantity: 2 },
        f.pickerCookie,
      )
    ).status,
    409,
  );
  rr = await restore(
    d,
    d.shortages.find((s: PickingLabTask['shortages'][number]) => s.lineId === 'PAPER_TRIPLE').id,
    1,
  );
  assert.equal(rr.status, 200);
  assert.equal(rr.data.task.state, 'PICKING');
  assert.ok(rr.data.task.lines.every((l: PickingLabTask['lines'][number]) => !l.checked));
});
test('restore recovery survives completion and changed body or old exception snapshots conflict', async () => {
  let d = await report(await claimed());
  const sid = d.shortages[0].id,
    body = restoreBody(d);
  const all = await Promise.all(Array.from({ length: 6 }, () => restore(d, sid, 2, body)));
  assert.ok(all.every((r) => r.status === 200));
  assert.equal(all.filter((r) => !r.data.duplicate).length, 1);
  d = all[0].data.task;
  assert.equal(d.exceptionVersion, 2);
  assert.equal(d.shortages[0].events.length, 2);
  assert.equal(
    (
      await post(
        '/' + d.id + '/check',
        { key: randomUUID(), version: 1, lineId: 'PAPER_SINGLE', quantity: 2 },
        f.pickerCookie,
      )
    ).status,
    409,
  );
  assert.equal((await restore(d, sid, 2, { ...body, confirmedQuantity: 1 })).status, 409);
  for (const [lineId, quantity] of [
    ['PAPER_SINGLE', 2],
    ['PAPER_TRIPLE', 1],
  ] as const) {
    const r = await post(
      '/' + d.id + '/check',
      {
        key: randomUUID(),
        version: d.version,
        exceptionVersion: d.exceptionVersion,
        lineId,
        quantity,
      },
      f.pickerCookie,
    );
    assert.equal(r.status, 200);
    d = r.data.task;
  }
  assert.equal(d.state, 'CHECKED');
  assert.equal((await restore(d, sid, 2, body)).data.duplicate, true);
  assert.equal((await post('/' + d.id + '/shortages', reportBody(d), f.pickerCookie)).status, 409);
});
test('report racing check cannot produce a checked line with an unresolved shortage', async () => {
  const t = await claimed(),
    r = await Promise.all([
      post('/' + t.id + '/shortages', reportBody(t), f.pickerCookie),
      post(
        '/' + t.id + '/check',
        { key: randomUUID(), version: 1, exceptionVersion: 0, lineId: 'PAPER_SINGLE', quantity: 2 },
        f.pickerCookie,
      ),
    ]);
  assert.deepEqual(r.map((x) => x.status).sort(), [200, 409]);
  const d = (await detail(t.id)).task;
  assert.ok(
    !(
      d.lines[0].checked &&
      d.shortages.some((s: PickingLabTask['shortages'][number]) => s.state === 'OPEN')
    ),
  );
});
test('late audit failure rolls report or restore back with original key reusable', async () => {
  const t = await claimed(),
    body = reportBody(t);
  await f.runtime.db.$executeRawUnsafe(
    "CREATE FUNCTION fail_shortage_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('PICKING_LAB_REPORT','PICKING_LAB_RESTORE') THEN RAISE EXCEPTION 'Synthetic shortage audit fail'; END IF; RETURN NEW; END $$",
  );
  await f.runtime.db.$executeRawUnsafe(
    'CREATE TRIGGER fail_shortage_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_shortage_audit()',
  );
  assert.equal((await post('/' + t.id + '/shortages', body, f.pickerCookie)).status, 500);
  assert.equal(await f.runtime.db.pickingLabShortage.count(), 0);
  assert.equal((await detail(t.id)).task.exceptionVersion, 0);
  await f.runtime.db.$executeRawUnsafe('DROP TRIGGER fail_shortage_audit ON business_audits');
  const made = await post('/' + t.id + '/shortages', body, f.pickerCookie);
  assert.equal(made.status, 200);
  let d = made.data.task;
  const sid = d.shortages[0].id,
    restoreInput = restoreBody(d);
  await f.runtime.db.$executeRawUnsafe(
    'CREATE TRIGGER fail_shortage_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_shortage_audit()',
  );
  assert.equal((await restore(d, sid, 2, restoreInput)).status, 500);
  d = (await detail(t.id)).task;
  assert.equal(d.exceptionVersion, 1);
  assert.equal(d.shortages[0].state, 'OPEN');
  await f.runtime.db.$executeRawUnsafe('DROP TRIGGER fail_shortage_audit ON business_audits');
  assert.equal((await restore(d, sid, 2, restoreInput)).status, 200);
});
test('database rejects silent check while blocked, history mutation and stale snapshot after restore', async () => {
  let d = await report(await claimed());
  const s = await f.runtime.db.pickingLabShortage.findFirstOrThrow();
  await assert.rejects(
    f.runtime.db.pickingLabTask.update({
      where: { id: d.id },
      data: { version: 2, checkedLines: ['PAPER_TRIPLE'] },
    }),
  );
  await assert.rejects(
    f.runtime.db.pickingLabShortage.update({
      where: { id: s.id },
      data: { state: 'RESOLVED', version: 1, resolverId: f.pickerId, resolvedAt: new Date() },
    }),
  );
  const event = await f.runtime.db.pickingLabShortageEvent.findFirstOrThrow();
  await assert.rejects(f.runtime.db.pickingLabShortageEvent.delete({ where: { id: event.id } }));
  await assert.rejects(
    f.runtime.db.pickingLabShortageEvent.update({ where: { id: event.id }, data: { quantity: 2 } }),
  );
  await assert.rejects(f.runtime.db.pickingLabShortage.delete({ where: { id: s.id } }));
  d = (await restore(d, s.id)).data.task;
  await assert.rejects(
    f.runtime.db.$transaction(async (tx) => {
      await tx.pickingLabTask.update({
        where: { id: d.id },
        data: { version: 2, checkedLines: ['PAPER_SINGLE'] },
      });
      await tx.pickingLabEvent.create({
        data: {
          id: randomUUID(),
          taskId: d.id,
          actorId: f.pickerId,
          actorName: '隔离测试员',
          key: randomUUID(),
          action: 'CHECK',
          expectedVersion: 1,
          exceptionVersion: 0,
          version: 2,
          lineId: 'PAPER_SINGLE',
          quantity: 2,
          state: 'PICKING',
          ownerId: f.pickerId,
          checkedLines: ['PAPER_SINGLE'],
        },
      });
    }),
  );
});
test('shortage workflow never changes formal orders, stock, reservations or payment and revocation blocks resolver', async () => {
  await f.create();
  const before = {
    order: await f.runtime.db.consumerOrder.findMany(),
    allocations: await f.runtime.db.orderAllocation.findMany(),
    positions: await f.runtime.db.stockPosition.findMany(),
    stock: await f.runtime.db.stockBalance.findMany(),
    ledger: await f.runtime.db.stockLedger.count(),
    payments: await f.runtime.db.paymentPreparation.count(),
  };
  let d = await report(await claimed());
  const admin = (await f.staff('/staff/me', f.extraCookies[0]!)).data;
  await f.runtime.db.staffRole.deleteMany({ where: { staffId: admin.id } });
  assert.equal((await restore(d, d.shortages[0].id)).status, 403);
  await f.runtime.db.staffRole.create({ data: { staffId: admin.id, roleCode: 'SUPER_ADMIN' } });
  d = (await restore(d, d.shortages[0].id)).data.task;
  assert.equal(d.state, 'PICKING');
  assert.deepEqual(
    {
      order: await f.runtime.db.consumerOrder.findMany(),
      allocations: await f.runtime.db.orderAllocation.findMany(),
      positions: await f.runtime.db.stockPosition.findMany(),
      stock: await f.runtime.db.stockBalance.findMany(),
      ledger: await f.runtime.db.stockLedger.count(),
      payments: await f.runtime.db.paymentPreparation.count(),
    },
    before,
  );
});

test('default-off shortage writes are refused without creating records', async () => {
  const g = await pickingFixture();
  try {
    const me = (await g.staff('/staff/me', g.extraCookies[0]!)).data;
    for (const suffix of [
      '/' + randomUUID() + '/shortages',
      '/' + randomUUID() + '/shortages/' + randomUUID() + '/restore',
    ]) {
      const restore = suffix.endsWith('/restore'),
        body = restore
          ? {
              key: randomUUID(),
              version: 1,
              exceptionVersion: 0,
              shortageVersion: 0,
              confirmedQuantity: 2,
            }
          : {
              key: randomUUID(),
              version: 1,
              exceptionVersion: 0,
              lineId: 'PAPER_SINGLE',
              missingQuantity: 1,
              reason: 'MISSING',
            };
      const r = await fetch(g.base + '/api/v1' + base + suffix + '?warehouseId=' + g.warehouseId, {
        method: 'POST',
        headers: {
          Cookie: g.extraCookies[0]!,
          Origin: 'http://127.0.0.1:5188',
          'X-CSRF-Token': me.csrfToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      assert.equal(r.status, 503);
    }
    assert.equal(await g.runtime.db.pickingLabShortage.count(), 0);
    assert.equal(await g.runtime.db.pickingLabShortageEvent.count(), 0);
  } finally {
    await g.cleanup();
  }
});
test('exception history limit reserves space to resolve open records and never strands the task', async () => {
  let d = await claimed();
  for (let i = 0; i < 49; i++) {
    d = await report(d);
    const r = await restore(d, d.shortages.at(-1)!.id);
    assert.equal(r.status, 200);
    d = r.data.task;
  }
  assert.equal(d.exceptionVersion, 98);
  d = await report(d);
  assert.equal(d.exceptionVersion, 99);
  assert.equal(
    (await post('/' + d.id + '/shortages', reportBody(d, 'PAPER_TRIPLE'), f.pickerCookie)).status,
    409,
  );
  const restored = await restore(d, d.shortages.at(-1)!.id);
  assert.equal(restored.status, 200);
  d = restored.data.task;
  assert.equal(d.exceptionVersion, 100);
  assert.ok(d.shortages.every((s: PickingLabTask['shortages'][number]) => s.state === 'RESOLVED'));
  assert.equal((await post('/' + d.id + '/shortages', reportBody(d), f.pickerCookie)).status, 409);
  assert.equal(
    (
      await post(
        '/' + d.id + '/check',
        {
          key: randomUUID(),
          version: 1,
          exceptionVersion: 100,
          lineId: 'PAPER_SINGLE',
          quantity: 2,
        },
        f.pickerCookie,
      )
    ).status,
    200,
  );
});
