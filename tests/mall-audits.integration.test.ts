import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  MALL_AUDIT_ACTIONS,
  type MallAuditPage,
  type MallAuditDetail,
} from '../packages/contracts/src/index.ts';
import { pointsReportFixture } from './helpers/points-report-fixture.ts';
import { MallAuditService } from '../apps/api/dist/mall-audits.js';
let f: Awaited<ReturnType<typeof pointsReportFixture>>;
before(async () => {
  f = await pointsReportFixture();
});
after(async () => {
  await f?.cleanup();
});
const path = '/admin/mall/audits';
async function list(extra = '', base = f.reportQuery) {
  const r = await f.api(path + base + extra);
  return { status: r.status, data: r.data as unknown as MallAuditPage };
}
async function detail(id: string) {
  const r = await f.api(path + '/' + id);
  return { status: r.status, data: r.data as unknown as MallAuditDetail };
}
async function actor() {
  return f.runtime.db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } });
}
async function fact(action: string, resourceId: string, options: Record<string, unknown> = {}) {
  return f.runtime.db.businessAudit.create({
    data: {
      id: randomUUID(),
      actorId: (await actor()).id,
      action,
      resourceId,
      warehouseId: f.warehouseId,
      requestId: randomUUID(),
      ...options,
    },
  });
}
async function finance() {
  const d = f.runtime.db;
  return JSON.stringify(
    [
      await d.pointsAccount.findMany({ orderBy: { userId: 'asc' } }),
      await d.pointsEntry.findMany({ orderBy: { id: 'asc' } }),
      await d.stockBalance.findMany({ orderBy: { skuId: 'asc' } }),
      await d.redemptionOrder.findMany({ orderBy: { id: 'asc' } }),
      await d.idempotencyRecord.count(),
      await d.businessAudit.count(),
    ],
    (_, v) => (typeof v === 'bigint' ? v.toString() : v),
  );
}
test('real mall actions resolve scoped source names and list/detail reads do not mutate business or audit facts', async () => {
  const before = await finance(),
    r = await list();
  assert.equal(r.status, 200);
  assert.ok(r.data.items.length > 5);
  for (const action of [
    'REWARD_CREATE',
    'POINTS_CREATE',
    'POINTS_APPROVE',
    'POINTS_CORRECTION_APPROVE',
    'REDEMPTION_EXPRESS_SHIP',
    'RETURN_REFUND',
  ]) {
    const item = r.data.items.find((x) => x.action === action);
    assert.ok(item, action);
    const d = await detail(item.id);
    assert.equal(d.status, 200);
    assert.equal(d.data.action, action);
    assert.ok(d.data.sourceLabel.length);
    assert.equal(d.data.exportSummary, null);
    assert.equal('details' in d.data, false);
    assert.equal('reason' in d.data, false);
    assert.equal('resourceId' in d.data, false);
  }
  assert.equal(await finance(), before);
});
test('encrypted customer notes and account reasons never escape the record summary', async () => {
  const secret = 'SYNTHETIC-PRIVATE-NOTE-00000000000';
  assert.equal(
    (
      await f.api('/admin/customers/' + f.identity.user.id + '/notes', {
        message: secret,
        scopeId: f.warehouseId,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.api('/admin/customers/' + f.identityB.user.id + '/status/disable', {
        version: (
          await f.runtime.db.consumerUser.findUniqueOrThrow({ where: { id: f.identityB.user.id } })
        ).authVersion,
        confirmed: true,
        reason: 'SYNTHETIC-PRIVATE-REASON',
      })
    ).status,
    200,
  );
  const r = await list('&group=CUSTOMERS');
  assert.ok(r.data.items.some((x) => x.action === 'CUSTOMER_NOTE_ADDED'));
  assert.ok(r.data.items.some((x) => x.action === 'CUSTOMER_DISABLED'));
  for (const item of r.data.items) {
    const d = await detail(item.id);
    assert.equal(d.status, 200);
    const text = JSON.stringify(d.data);
    for (const hidden of [
      secret,
      'SYNTHETIC-PRIVATE-REASON',
      'payload',
      'fromVersion',
      'actorId',
      'phone',
      'reason',
    ])
      assert.ok(!text.includes(hidden), hidden);
  }
});
test('export range uses only validated whitelisted metadata and never returns cached CSV or unrelated details', async () => {
  const q = new URLSearchParams(f.reportQuery),
    e = await f.api('/admin/points/report/export', {
      from: q.get('from'),
      to: q.get('to'),
      dataset: 'LEDGER',
    });
  assert.equal(e.status, 200);
  const entry = await f.runtime.db.businessAudit.findFirstOrThrow({
      where: { action: 'POINTS_REPORT_EXPORT', resourceId: e.data.id },
    }),
    r = await detail(entry.id);
  assert.equal(r.status, 200);
  assert.equal(r.data.exportSummary!.rowCount, 6);
  assert.equal(r.data.exportSummary!.dataset, 'LEDGER');
  assert.ok(!JSON.stringify(r.data).includes('csv'));
  const invalid = await fact('POINTS_REPORT_EXPORT', randomUUID(), {
    details: {
      dataset: 'LEDGER',
      from: '2026-02-30',
      to: '2026-03-01',
      kind: null,
      rowCount: 1,
      generatedAt: new Date().toISOString(),
      csv: 'SYNTHETIC-CSV-SECRET',
      payload: 'SECRET',
    },
  });
  assert.equal((await detail(invalid.id)).data.exportSummary, null);
  const valid = await fact('POINTS_REPORT_EXPORT', randomUUID(), {
    details: { ...r.data.exportSummary, secret: 'SYNTHETIC-UNLISTED-SECRET' },
  });
  const safe = (await detail(valid.id)).data;
  assert.ok(safe.exportSummary);
  assert.ok(!JSON.stringify(safe).includes('SYNTHETIC-UNLISTED-SECRET'));
  const malformed = await fact('POINTS_REPORT_EXPORT', randomUUID(), {
    details: { ...r.data.exportSummary, kind: { toString: 7 } },
  });
  const guarded = await detail(malformed.id);
  assert.equal(guarded.status, 200);
  assert.equal(guarded.data.exportSummary, null);
});
test('parcel and batch shipping records resolve actual member order numbers without recipient or waybill data', async () => {
  const ids = [await f.createExpress(), await f.createExpress()];
  assert.equal(
    (
      await f.api('/admin/redemptions/ship-parcel', {
        orders: ids.map((id) => ({ id, version: 0 })),
        carrierCode: 'SF',
        trackingNo: 'SF-AUDIT-PARCEL-001',
        dispatchConfirmed: true,
      })
    ).status,
    200,
  );
  const third = await f.createExpress();
  assert.equal(
    (
      await f.api('/admin/redemptions/waybill-import/confirm', {
        items: [{ id: third, version: 0, carrierCode: 'ZTO', trackingNo: 'ZTO-AUDIT-BATCH-001' }],
        dispatchConfirmed: true,
      })
    ).status,
    200,
  );
  for (const [action, count] of [
    ['REDEMPTION_EXPRESS_PARCEL_SHIP', 2],
    ['REDEMPTION_EXPRESS_BATCH_SHIP', 1],
  ] as const) {
    const record = await f.runtime.db.businessAudit.findFirstOrThrow({ where: { action } }),
      d = await detail(record.id);
    assert.equal(d.status, 200);
    assert.equal(d.data.orderNos.length, count);
    assert.equal(new Set(d.data.orderNos).size, count);
    for (const secret of [
      '00000000000',
      'SF-AUDIT-PARCEL',
      'ZTO-AUDIT-BATCH',
      '合成快递路',
      'addressPayload',
    ])
      assert.ok(!JSON.stringify(d.data).includes(secret));
  }
});
test('same-timestamp keyset pagination has no duplicates and ignores newly added later records on following pages', async () => {
  const at = new Date(),
    ids: string[] = [];
  for (let i = 0; i < 25; i++)
    ids.push((await fact('POINTS_REPORT_EXPORT', randomUUID(), { createdAt: at })).id);
  const expected = await f.runtime.db.businessAudit.findMany({
    where: { warehouseId: f.warehouseId, action: 'POINTS_REPORT_EXPORT' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { id: true },
  });
  const first = await list('&group=EXPORTS');
  assert.equal(first.data.items.length, 20);
  assert.ok(first.data.nextCursor);
  const newest = await fact('POINTS_REPORT_EXPORT', randomUUID(), {
    createdAt: new Date(at.getTime() + 1000),
  });
  const all = [...first.data.items];
  let cursor: string | null = first.data.nextCursor;
  while (cursor) {
    const page = await list('&group=EXPORTS&cursor=' + cursor);
    assert.equal(page.status, 200);
    all.push(...page.data.items);
    cursor = page.data.nextCursor;
  }
  assert.deepEqual(
    all.map((x) => x.id),
    expected.map((x) => x.id),
  );
  assert.equal(new Set(all.map((x) => x.id)).size, all.length);
  assert.ok(!all.some((x) => x.id === newest.id));
  assert.ok(ids.every((id) => all.some((x) => x.id === id)));
  assert.equal((await list('&group=POINTS&cursor=' + first.data.nextCursor)).status, 400);
});
test('actor search is literal and names explicitly reflect current staff profile, not a fabricated historic snapshot', async () => {
  assert.equal((await list('&actor=%25')).data.items.length, 0);
  assert.equal((await list('&actor=_')).data.items.length, 0);
  const staff = await actor();
  await f.runtime.db.staff.update({
    where: { id: staff.id },
    data: { displayName: '合成现名%_操作人' },
  });
  try {
    const r = await list('&actor=' + encodeURIComponent('%_'));
    assert.ok(r.data.items.length);
    assert.ok(r.data.items.every((x) => x.actorName === '合成现名%_操作人'));
    const d = await detail(r.data.items[0]!.id);
    assert.equal(d.data.actorName, '合成现名%_操作人');
  } finally {
    await f.runtime.db.staff.update({
      where: { id: staff.id },
      data: { displayName: staff.displayName },
    });
  }
});
test('Beijing date boundary, empty/malformed range, unknown actions and outside warehouses remain isolated', async () => {
  const timed = await fact('POINTS_POLICY', f.warehouseId, {
    createdAt: new Date('2026-01-01T16:00:00Z'),
  });
  assert.deepEqual(
    (await list('', '?from=2026-01-02&to=2026-01-02')).data.items.map((x) => x.id),
    [timed.id],
  );
  assert.equal((await list('', '?from=2026-01-01&to=2026-01-01')).data.items.length, 0);
  for (const query of [
    '?from=2026-02-30&to=2026-03-01',
    '?from=2026-01-01&to=2027-01-02',
    f.reportQuery + '&group=UNKNOWN',
    f.reportQuery + '&actor=' + 'x'.repeat(81),
    f.reportQuery + '&cursor=bad',
    f.reportQuery + '&action=UNKNOWN',
    f.reportQuery + '&warehouseId=' + randomUUID(),
  ])
    assert.equal((await f.api(path + query)).status, 400);
  const foreign = await f.runtime.db.warehouse.create({
      data: { id: randomUUID(), code: 'AUDIT-OTHER', name: '合成其他仓' },
    }),
    out = await fact('POINTS_POLICY', foreign.id, { warehouseId: foreign.id }),
    nullScope = await fact('CUSTOMER_NOTE_ADDED', f.identity.user.id, { warehouseId: null }),
    unknown = await fact('SYNTHETIC_UNLISTED', randomUUID(), {
      details: { secret: 'SYNTHETIC-HIDDEN' },
    });
  for (const id of [out.id, nullScope.id, unknown.id, randomUUID()])
    assert.equal((await detail(id)).status, 404);
  const reward = await f.runtime.db.rewardProduct.create({
      data: {
        id: randomUUID(),
        warehouseId: foreign.id,
        skuId: f.catalog.skuIds[0]!,
        title: 'FOREIGN-REWARD-SECRET',
        pointsPrice: 1n,
        perUserLimit: 1,
        totalQuota: 20,
      },
    }),
    wrongSource = await fact('REWARD_CREATE', reward.id);
  assert.equal((await detail(wrongSource.id)).data.sourceLabel, '关联资料不可用');
  let r = await list();
  const all = [...r.data.items];
  while (r.data.nextCursor) {
    r = await list('&cursor=' + r.data.nextCursor);
    all.push(...r.data.items);
  }
  assert.ok(all.every((x) => Object.hasOwn(MALL_AUDIT_ACTIONS, x.action)));
  for (const id of [out.id, nullScope.id, unknown.id]) assert.ok(!all.some((x) => x.id === id));
});
test('late current-session expiry returns no record and read transaction leaves no lasting session change', async () => {
  const service = f.runtime.app.get(MallAuditService),
    original = service.auth.authorize;
  let calls = 0;
  service.auth.authorize = async function (...args) {
    const result = await original.apply(this, args);
    if (++calls === 1)
      await args[1]!
        .$executeRaw`UPDATE staff_sessions SET created_at=clock_timestamp()-interval '1 day',expires_at=clock_timestamp()-interval '1 millisecond' WHERE staff_id=${args[0].staffContext!.staffId}::uuid`;
    return result;
  };
  try {
    const r = await list();
    assert.equal(r.status, 403);
    assert.equal(r.data, undefined);
  } finally {
    service.auth.authorize = original;
  }
  assert.equal((await list()).status, 200);
});
test('consumers, warehouse-only staff and lost current warehouse membership cannot read list or detail', async () => {
  const item = (await list()).data.items[0]!;
  assert.equal((await f.call(path + f.reportQuery)).status, 401);
  const picker = await f.workerActor('PICKER');
  assert.equal(
    (await f.api(path + f.reportQuery, undefined, randomUUID(), picker.cookie, picker.csrf)).status,
    403,
  );
  assert.equal(
    (await f.api(path + '/' + item.id, undefined, randomUUID(), picker.cookie, picker.csrf)).status,
    403,
  );
  const staff = await actor();
  await f.runtime.db.staffWarehouse.deleteMany({
    where: { staffId: staff.id, warehouseId: f.warehouseId },
  });
  assert.equal((await list()).status, 403);
  assert.equal((await detail(item.id)).status, 403);
});
