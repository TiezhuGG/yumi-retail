import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { PointsReportExport, PointsReport } from '../packages/contracts/src/index.ts';
import { pointsReportFixture } from './helpers/points-report-fixture.ts';
import { PointsReportService } from '../apps/api/dist/points-report.js';
let f: Awaited<ReturnType<typeof pointsReportFixture>>;
before(async () => {
  f = await pointsReportFixture();
});
after(async () => {
  await f?.cleanup();
});
const path = '/admin/points/report/export';
function filter(dataset: 'LEDGER' | 'DAILY' = 'LEDGER') {
  const q = new URLSearchParams(f.reportQuery);
  return { from: q.get('from')!, to: q.get('to')!, dataset };
}
async function run(body: unknown) {
  const r = await f.api(path, body);
  return { status: r.status, data: r.data as unknown as PointsReportExport };
}
async function finance() {
  const d = f.runtime.db;
  return JSON.stringify(
    [
      await d.pointsAccount.findMany({ orderBy: { userId: 'asc' } }),
      await d.pointsEntry.findMany({ orderBy: { id: 'asc' } }),
      await d.redemptionOrder.findMany({ orderBy: { id: 'asc' } }),
      await d.redemptionAllocation.findMany({ orderBy: { id: 'asc' } }),
      await d.stockBalance.findMany({ orderBy: { skuId: 'asc' } }),
      await d.idempotencyRecord.count(),
    ],
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
  );
}
test('ledger and daily export match actual report, preserve finance and add scoped audit without private data', async () => {
  const before = await finance(),
    audits = await f.runtime.db.businessAudit.count({ where: { action: 'POINTS_REPORT_EXPORT' } }),
    ledger = await run(filter());
  assert.equal(ledger.status, 200);
  assert.equal(ledger.data.rowCount, 6);
  assert.equal(ledger.data.kind, null);
  assert.ok(ledger.data.csv.startsWith('\uFEFF'));
  assert.ok(ledger.data.filename.endsWith('.csv'));
  for (const word of ['积分发放', '商品兑换', '取消退回', '售后退回', '误发冲正'])
    assert.ok(ledger.data.csv.includes(word));
  for (const forbidden of [
    'phone',
    'addressPayload',
    '00000000000',
    '合成快递路',
    'provider',
    'subject',
    'reasonPayload',
    'token',
    'currentGlobalBalance',
  ])
    assert.ok(!ledger.data.csv.includes(forbidden));
  const daily = await run(filter('DAILY'));
  assert.equal(daily.status, 200);
  assert.equal(daily.data.rowCount, 1);
  assert.ok(daily.data.csv.includes('"360","250","110"'));
  assert.equal(await finance(), before);
  assert.equal(
    await f.runtime.db.businessAudit.count({ where: { action: 'POINTS_REPORT_EXPORT' } }),
    audits + 2,
  );
  const record = await f.runtime.db.businessAudit.findFirstOrThrow({
    where: { action: 'POINTS_REPORT_EXPORT', resourceId: ledger.data.id },
  });
  assert.equal(record.warehouseId, f.warehouseId);
  assert.deepEqual(record.details, {
    ...filter(),
    kind: null,
    rowCount: 6,
    generatedAt: ledger.data.generatedAt,
  });
});
test('filtered and empty exports reflect posting date and emit complete headers without artificial rows', async () => {
  const filtered = await run({ ...filter(), kind: 'RETURN' });
  assert.equal(filtered.status, 200);
  assert.equal(filtered.data.rowCount, 1);
  assert.ok(filtered.data.csv.includes('售后退回'));
  assert.ok(!filtered.data.csv.includes('商品兑换'));
  const empty = await run({ from: '2000-01-01', to: '2000-01-02', dataset: 'LEDGER' });
  assert.equal(empty.status, 200);
  assert.equal(empty.data.rowCount, 0);
  assert.equal(empty.data.csv.split('\r\n').length, 2);
  const emptyDaily = await run({ from: '2000-01-01', to: '2000-01-02', dataset: 'DAILY' });
  assert.equal(emptyDaily.data.rowCount, 0);
});
test('all pages are exported and exceeding the fixed cap fails as a whole without audit or truncated CSV', async () => {
  for (let i = 0; i < 22; i++) await f.grant('EXPORT-PAGE-' + i, '1');
  const r = await run({ ...filter(), kind: 'GRANT' });
  assert.equal(r.status, 200);
  assert.equal(r.data.rowCount, 23);
  for (let i = 0; i < 22; i++) assert.ok(r.data.csv.includes('EXPORT-PAGE-' + i));
  const svc = f.runtime.app.get(PointsReportService),
    audits = await f.runtime.db.businessAudit.count({ where: { action: 'POINTS_REPORT_EXPORT' } });
  Object.defineProperty(svc, 'exportLimit', { value: 5, configurable: true });
  try {
    const denied = await run(filter());
    assert.equal(denied.status, 409);
    assert.equal(denied.data, undefined);
    assert.equal(
      await f.runtime.db.businessAudit.count({ where: { action: 'POINTS_REPORT_EXPORT' } }),
      audits,
    );
  } finally {
    Object.defineProperty(svc, 'exportLimit', { value: 5000, configurable: true });
  }
});
test('literal formula-like nickname and reference are protected in actual exported CSV', async () => {
  const db = f.runtime.db,
    user = await db.consumerUser.findUniqueOrThrow({ where: { id: f.identity.user.id } });
  await db.consumerUser.update({ where: { id: user.id }, data: { displayName: '=合成危险昵称' } });
  try {
    await f.grant(' +SUM(合成,测试)', '1');
    const r = await run({ ...filter(), kind: 'GRANT' });
    assert.equal(r.status, 200);
    assert.ok(r.data.csv.includes('"\'=合成危险昵称"'));
    assert.ok(
      r.data.csv.includes('"\'+SUM(合成,测试)"') || r.data.csv.includes('"\' +SUM(合成,测试)"'),
    );
  } finally {
    await db.consumerUser.update({
      where: { id: user.id },
      data: { displayName: user.displayName },
    });
  }
});
test('bad ranges/fields and inappropriate daily kind/cursors are rejected; CSRF and role remain mandatory', async () => {
  const before = await finance(),
    audits = await f.runtime.db.businessAudit.count({ where: { action: 'POINTS_REPORT_EXPORT' } });
  for (const b of [
    { ...filter(), from: '2026-02-30' },
    { ...filter(), from: '2026-01-01', to: '2027-01-02' },
    { ...filter(), kind: 'UNKNOWN' },
    { ...filter('DAILY'), kind: 'GRANT' },
    { ...filter(), dataset: 'ISSUES' },
    { ...filter(), cursor: 'anything' },
    { ...filter(), limit: 100000 },
  ])
    assert.equal((await run(b)).status, 400);
  assert.equal((await f.api(path, filter(), randomUUID(), f.cookie, 'invalid')).status, 403);
  const picker = await f.workerActor('PICKER');
  assert.equal((await f.api(path, filter(), randomUUID(), picker.cookie, picker.csrf)).status, 403);
  assert.equal(await finance(), before);
  assert.equal(
    await f.runtime.db.businessAudit.count({ where: { action: 'POINTS_REPORT_EXPORT' } }),
    audits,
  );
});
test('Beijing midnight boundary uses actual posting time', async () => {
  const d = f.runtime.db,
    entry = await d.pointsEntry.findUniqueOrThrow({ where: { actionKey: 'GRANT:' + f.grantId } }),
    schema = (await d.$queryRaw<Array<{ schema: string }>>`SELECT current_schema() AS schema`)[0]!
      .schema;
  assert.ok(schema.startsWith('address_ui_'));
  await d.$executeRawUnsafe('ALTER TABLE points_ledger DISABLE TRIGGER points_ledger_immutable');
  try {
    await d.pointsEntry.update({
      where: { id: entry.id },
      data: { createdAt: new Date('2026-01-01T16:00:00.000Z') },
    });
    const r = await run({ from: '2026-01-02', to: '2026-01-02', dataset: 'LEDGER' });
    assert.equal(r.data.rowCount, 1);
    assert.ok(r.data.csv.includes('2026-01-02 00:00:00'));
    assert.equal(
      (await run({ from: '2026-01-01', to: '2026-01-01', dataset: 'LEDGER' })).data.rowCount,
      0,
    );
  } finally {
    await d.pointsEntry.update({ where: { id: entry.id }, data: { createdAt: entry.createdAt } });
    await d.$executeRawUnsafe('ALTER TABLE points_ledger ENABLE TRIGGER points_ledger_immutable');
  }
});
test('late session expiry during audit blocks export and rolls back its audit', async () => {
  const d = f.runtime.db,
    before = await finance(),
    count = await d.businessAudit.count({ where: { action: 'POINTS_REPORT_EXPORT' } });
  await d.$executeRawUnsafe(
    "CREATE FUNCTION expire_report_export() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='POINTS_REPORT_EXPORT' THEN UPDATE staff_sessions SET created_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()-interval '1 millisecond' WHERE staff_id=NEW.actor_id; END IF; RETURN NEW; END $$",
  );
  await d.$executeRawUnsafe(
    'CREATE TRIGGER expire_report_export BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION expire_report_export()',
  );
  try {
    const r = await run(filter());
    assert.equal(r.status, 403);
    assert.equal(r.data, undefined);
    assert.equal(await d.businessAudit.count({ where: { action: 'POINTS_REPORT_EXPORT' } }), count);
    assert.equal(await finance(), before);
  } finally {
    await d.$executeRawUnsafe('DROP TRIGGER expire_report_export ON business_audits');
  }
});
test('audit insertion failure produces no file response and no finance or audit changes', async () => {
  const d = f.runtime.db,
    before = await finance(),
    count = await d.businessAudit.count({ where: { action: 'POINTS_REPORT_EXPORT' } });
  await d.$executeRawUnsafe(
    "CREATE FUNCTION fail_report_export() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='POINTS_REPORT_EXPORT' THEN RAISE EXCEPTION 'synthetic export audit failure'; END IF; RETURN NEW; END $$",
  );
  await d.$executeRawUnsafe(
    'CREATE TRIGGER fail_report_export BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_report_export()',
  );
  try {
    const r = await run(filter());
    assert.equal(r.status, 500);
    assert.equal(r.data, undefined);
    assert.equal(await finance(), before);
    assert.equal(await d.businessAudit.count({ where: { action: 'POINTS_REPORT_EXPORT' } }), count);
  } finally {
    await d.$executeRawUnsafe('DROP TRIGGER fail_report_export ON business_audits');
  }
});
test('foreign warehouse facts stay out of CSV; removing current warehouse permission also blocks export', async () => {
  const d = f.runtime.db,
    w = await d.warehouse.create({
      data: { id: randomUUID(), code: 'EXPORT-FOREIGN', name: '合成外仓' },
    }),
    original = await d.pointsEntry.findUniqueOrThrow({
      where: { actionKey: 'GRANT:' + f.grantId },
    }),
    creator = await d.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } }),
    id = randomUUID();
  await d.pointsGrant.create({
    data: {
      id,
      warehouseId: w.id,
      userId: f.identity.user.id,
      amount: 9n,
      reference: 'FOREIGN-EXPORT-EXCLUDED',
      reason: '合成外仓',
      creatorId: creator.id,
    },
  });
  await d.$transaction(async (tx) => {
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
        reason: '合成外仓审批',
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
  const exported = await run(filter());
  assert.equal(exported.status, 200);
  assert.ok(!exported.data.csv.includes('FOREIGN-EXPORT-EXCLUDED'));
  const report = await f.api('/admin/points/report' + f.reportQuery);
  assert.equal(report.status, 200);
  assert.equal((report.data as unknown as PointsReport).reconciliation.accountIssues, 0);
  await d.staffWarehouse.deleteMany({ where: { staffId: creator.id, warehouseId: f.warehouseId } });
  assert.equal((await run(filter())).status, 403);
});
