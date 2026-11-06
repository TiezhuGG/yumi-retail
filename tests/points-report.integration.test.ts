import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PointsReport } from '../packages/contracts/src/index.ts';
import { pointsReportFixture } from './helpers/points-report-fixture.ts';
let f: Awaited<ReturnType<typeof pointsReportFixture>>;
before(async () => {
  f = await pointsReportFixture();
});
after(async () => {
  await f?.cleanup();
});
async function read(extra = '', query = f.reportQuery) {
  const r = await f.api('/admin/points/report' + query + extra);
  assert.equal(r.status, 200);
  return r.data as unknown as PointsReport;
}
test('real grant, correction, redemption, cancellation and refund sum exactly and reads are side-effect-free', async () => {
  const db = f.runtime.db;
  const state = async () =>
    JSON.stringify(
      [
        await db.pointsAccount.findMany(),
        await db.pointsEntry.findMany(),
        await db.pointsGrant.findMany(),
        await db.businessAudit.count(),
        await db.idempotencyRecord.count(),
      ],
      (_, v) => (typeof v === 'bigint' ? v.toString() : v),
    );
  const before = await state(),
    r = await read();
  assert.deepEqual(Object.fromEntries(r.totals.map((t) => [t.kind, t.points])), {
    GRANT: '120',
    REDEEM: '-240',
    CANCEL: '120',
    RETURN: '120',
    CORRECTION: '-10',
  });
  assert.equal(r.netPoints, '110');
  assert.equal(r.items.length, 6);
  assert.equal(r.daily.length, 1);
  assert.equal(r.daily[0]!.incoming, '360');
  assert.equal(r.daily[0]!.outgoing, '250');
  assert.equal(r.reconciliation.sourceIssues, 0);
  assert.equal(r.reconciliation.accountIssues, 0);
  assert.equal(r.reconciliation.currentGlobalBalance, '2110');
  assert.equal(r.reconciliation.globalLedgerTotal, '2110');
  assert.equal(r.reconciliation.unassignedCount, 2);
  assert.equal(r.reconciliation.unassignedPoints, '2000');
  assert.equal(await state(), before);
  for (const key of [
    'phone',
    'addressPayload',
    'subject',
    'csrf',
    'token',
    'actorId',
    'reasonPayload',
  ])
    assert.ok(!JSON.stringify(r).includes(key));
  const filtered = await read('&kind=RETURN');
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0]!.kind, 'RETURN');
  assert.equal(filtered.netPoints, '110');
  const empty = await read('', '?from=2000-01-01&to=2000-01-02');
  assert.equal(empty.items.length, 0);
  assert.equal(empty.netPoints, '0');
  assert.equal(empty.reconciliation.currentGlobalBalance, '2110');
});
test('Beijing inclusive date range uses ledger posting time, not original request or UTC date', async () => {
  const db = f.runtime.db,
    g = await f.grant('REPORT-DATE', '7');
  const entry = await db.pointsEntry.findUniqueOrThrow({ where: { actionKey: 'GRANT:' + g } });
  const schema = (
    await db.$queryRaw<Array<{ schema: string }>>`SELECT current_schema() AS schema`
  )[0]!.schema;
  assert.ok(schema!.startsWith('address_ui_'));
  await db.$executeRawUnsafe('ALTER TABLE points_ledger DISABLE TRIGGER points_ledger_immutable');
  try {
    await db.pointsEntry.update({
      where: { id: entry.id },
      data: { createdAt: new Date('2026-01-01T16:00:00.000Z') },
    });
    const d = await read('', '?from=2026-01-02&to=2026-01-02');
    assert.equal(d.totals.find((t) => t.kind === 'GRANT')!.points, '7');
    assert.equal(d.daily[0]!.date, '2026-01-02');
    assert.equal((await read('', '?from=2026-01-01&to=2026-01-01')).items.length, 0);
  } finally {
    await db.pointsEntry.update({ where: { id: entry.id }, data: { createdAt: entry.createdAt } });
    await db.$executeRawUnsafe('ALTER TABLE points_ledger ENABLE TRIGGER points_ledger_immutable');
  }
});
test('keyset pagination is complete, filtered before paging and sums preserve integer precision', async () => {
  for (let i = 0; i < 22; i++) await f.grant('REPORT-PAGE-' + i, '1');
  const a = await read('&kind=GRANT');
  assert.equal(a.items.length, 20);
  assert.ok(a.nextCursor);
  const b = await read('&kind=GRANT&cursor=' + a.nextCursor);
  assert.equal(b.items.length, 4);
  assert.equal(b.nextCursor, null);
  assert.equal(new Set([...a.items, ...b.items].map((x) => x.key)).size, 24);
  const db = f.runtime.db,
    staff = await db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } });
  await db.$transaction(async (tx) => {
    await tx.pointsAccount.update({
      where: { userId: f.identity.user.id },
      data: { balance: { increment: 9007199254740993n } },
    });
    await tx.pointsEntry.create({
      data: {
        id: randomUUID(),
        userId: f.identity.user.id,
        delta: 9007199254740993n,
        actionKey: 'REPORT-SYNTHETIC:' + randomUUID(),
        reason: '合成精度核对',
        actorId: staff.id,
      },
    });
  });
  const r = await read();
  assert.equal(r.reconciliation.currentGlobalBalance, '9007199254743132');
  assert.equal(r.reconciliation.currentGlobalBalance, r.reconciliation.globalLedgerTotal);
  assert.equal(r.netPoints, '139');
});
test('controlled corruption is detected without repair: wrong amount/actor, missing and unexpected postings, offsetting account differences', async () => {
  const db = f.runtime.db,
    schema = (await db.$queryRaw<Array<{ schema: string }>>`SELECT current_schema() AS schema`)[0]!
      .schema;
  assert.ok(schema!.startsWith('address_ui_'));
  const e = await db.pointsEntry.findUniqueOrThrow({ where: { actionKey: 'GRANT:' + f.grantId } }),
    a = await db.pointsAccount.findUniqueOrThrow({ where: { userId: f.identity.user.id } }),
    b = await db.pointsAccount.findUniqueOrThrow({ where: { userId: f.identityB.user.id } });
  // Test-only corruption; never disabled on a business schema. Restore original rows in finally.
  await db.$executeRawUnsafe('ALTER TABLE points_ledger DISABLE TRIGGER USER');
  await db.$executeRawUnsafe('ALTER TABLE points_accounts DISABLE TRIGGER USER');
  const pending = await f.api('/admin/points/grants/store/create', {
    userId: f.identity.user.id,
    amount: '3',
    reason: '合成未批准',
    reference: 'REPORT-PENDING',
  });
  assert.equal(pending.status, 200);
  const rogue = randomUUID();
  try {
    await db.pointsEntry.update({
      where: { id: e.id },
      data: {
        delta: 121n,
        actorId:
          e.actorId === null
            ? undefined
            : (await db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } })).id,
      },
    });
    await db.pointsAccount.update({
      where: { userId: a.userId },
      data: { balance: a.balance + 2n },
    });
    await db.pointsAccount.update({
      where: { userId: b.userId },
      data: { balance: b.balance - 1n },
    });
    let r = await read('&view=ISSUES');
    assert.equal(r.reconciliation.invalidLedger, 1);
    assert.equal(r.reconciliation.accountIssues, 2);
    assert.equal(r.accountDifferences.items.length, 2);
    const followingAccount = await read(
      '&view=ISSUES&accountCursor=' + r.accountDifferences.items[0]!.userId,
    );
    assert.equal(followingAccount.accountDifferences.items.length, 1);
    assert.equal(r.items[0]!.issue, 'INVALID');
    await db.pointsEntry.delete({ where: { id: e.id } });
    r = await read('&view=ISSUES');
    assert.equal(r.reconciliation.missingLedger, 1);
    assert.equal(r.items[0]!.actualPoints, null);
    await db.pointsEntry.create({
      data: {
        id: rogue,
        userId: a.userId,
        delta: 3n,
        actionKey: 'GRANT:' + pending.data.id,
        reason: '合成非授权流水',
        actorId: e.actorId,
      },
    });
    r = await read('&view=ISSUES');
    assert.equal(r.reconciliation.unexpectedLedger, 1);
    assert.equal(r.items.find((x) => x.issue === 'UNEXPECTED')!.expectedPoints, '0');
    assert.equal(r.reconciliation.sourceIssues, 2);
    assert.equal(r.items.length, 2);
    const next = await read('&view=ISSUES&cursor=' + r.items[0]!.key);
    assert.equal(next.items.length, 1);
  } finally {
    await db.pointsEntry.deleteMany({ where: { id: { in: [e.id, rogue] } } });
    await db.pointsEntry.create({ data: e });
    await db.pointsAccount.update({ where: { userId: a.userId }, data: { balance: a.balance } });
    await db.pointsAccount.update({ where: { userId: b.userId }, data: { balance: b.balance } });
    await db.$executeRawUnsafe('ALTER TABLE points_ledger ENABLE TRIGGER USER');
    await db.$executeRawUnsafe('ALTER TABLE points_accounts ENABLE TRIGGER USER');
  }
  assert.equal((await read()).reconciliation.sourceIssues, 0);
  assert.equal((await read()).reconciliation.accountIssues, 0);
});

test('foreign warehouse business is excluded from store flows but retained in explicitly global balance checks', async () => {
  const db = f.runtime.db,
    before = await read(),
    w = await db.warehouse.create({
      data: { id: randomUUID(), code: 'REPORT-FOREIGN', name: '合成外仓' },
    }),
    original = await db.pointsEntry.findUniqueOrThrow({
      where: { actionKey: 'GRANT:' + f.grantId },
    }),
    creator = await db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } }),
    id = randomUUID();
  await db.pointsGrant.create({
    data: {
      id,
      warehouseId: w.id,
      userId: f.identity.user.id,
      amount: 9n,
      reference: 'FOREIGN-REPORT-MUST-NOT-APPEAR',
      reason: '合成外仓',
      creatorId: creator.id,
    },
  });
  await db.$transaction(async (tx) => {
    await tx.pointsAccount.update({
      where: { userId: f.identity.user.id },
      data: { balance: { increment: 9n }, version: { increment: 1 } },
    });
    await tx.pointsEntry.create({
      data: {
        id: randomUUID(),
        userId: f.identity.user.id,
        delta: 9n,
        actionKey: 'GRANT:' + id,
        reason: '合成外仓已审批',
        actorId: original.actorId,
      },
    });
    await tx.pointsGrant.update({
      where: { id },
      data: {
        status: 'APPROVED',
        version: 1,
        reviewerId: original.actorId,
        decisionReason: '合成独立审批',
        decidedAt: new Date(),
      },
    });
  });
  const r = await read();
  assert.equal(r.netPoints, before.netPoints);
  assert.equal(r.reconciliation.unassignedCount, before.reconciliation.unassignedCount);
  assert.equal(
    r.reconciliation.currentGlobalBalance,
    (BigInt(before.reconciliation.currentGlobalBalance) + 9n).toString(),
  );
  assert.equal(r.reconciliation.accountIssues, 0);
  assert.equal(r.reconciliation.sourceIssues, 0);
  assert.ok(!JSON.stringify(r.items).includes('FOREIGN-REPORT'));
});
test('input is strict and report denies consumer, warehouse-only role and lost warehouse binding', async () => {
  for (const query of [
    '',
    '?from=2026-02-30&to=2026-03-01',
    '?from=0000-01-01&to=0000-01-01',
    '?from=2026-01-02&to=2026-01-01',
    '?from=2025-01-01&to=2026-12-31',
    f.reportQuery + '&kind=oops',
    f.reportQuery + '&view=oops',
    f.reportQuery + '&cursor=bad',
    f.reportQuery + '&accountCursor=bad',
    f.reportQuery + '&warehouseId=' + randomUUID(),
  ])
    assert.equal((await f.api('/admin/points/report' + query)).status, 400, query);
  assert.equal(
    (
      await fetch(f.base + '/api/v1/admin/points/report' + f.reportQuery, {
        headers: { Authorization: 'Bearer ' + f.identity.token },
      })
    ).status,
    401,
  );
  const { data: p } = await (
      await fetch(f.base + '/api/v1/staff/me', { headers: { Cookie: f.cookie } })
    ).json(),
    db = f.runtime.db;
  await db.staffRole.updateMany({
    where: { staffId: p.id },
    data: { roleCode: 'WAREHOUSE_MANAGER' },
  });
  assert.equal((await f.api('/admin/points/report' + f.reportQuery)).status, 403);
  await db.staffRole.updateMany({ where: { staffId: p.id }, data: { roleCode: 'SUPER_ADMIN' } });
  await db.staffWarehouse.deleteMany({ where: { staffId: p.id, warehouseId: f.warehouseId } });
  assert.equal((await f.api('/admin/points/report' + f.reportQuery)).status, 403);
});
