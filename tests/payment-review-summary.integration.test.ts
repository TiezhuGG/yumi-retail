import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { orderAdminFixture } from './helpers/order-admin-fixture.ts';
import { claimPaymentQueryLab } from '../packages/database/dist/index.js';
import type { PaymentReviewFilter } from '../packages/contracts/dist/index.js';
let f: Awaited<ReturnType<typeof orderAdminFixture>>, csrf: string;
const base = '/admin/payment-review-lab';
const filters: PaymentReviewFilter[] = ['ALL', 'UNKNOWN', 'CONFLICT', 'EXHAUSTED', 'REVIEW'];
async function summary(w: string = f.warehouseId, cookie = f.extraCookies[0]!) {
  return f.staff(base + '/summary?warehouseId=' + w, cookie);
}
async function post(path: string, body: unknown, w: string = f.warehouseId) {
  const r = await fetch(f.base + '/api/v1' + path + '?warehouseId=' + w, {
    method: 'POST',
    headers: {
      Cookie: f.extraCookies[0]!,
      Origin: 'http://127.0.0.1:5188',
      'X-CSRF-Token': csrf,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  assert.equal(r.status, 200);
  return (await r.json()).data;
}
async function start(action?: string, w: string = f.warehouseId) {
  const a = await post('/admin/payment-attempt-lab', { key: randomUUID() }, w);
  const id = a.attempt.id as string;
  if (action) await observe(id, action, w);
  return id;
}
async function observe(id: string, action: string, w: string = f.warehouseId) {
  return post('/admin/payment-attempt-lab/' + id + '/actions/' + action, { key: randomUUID() }, w);
}
beforeEach(async () => {
  f = await orderAdminFixture({ notificationLab: true });
  csrf = (await f.staff('/staff/me', f.extraCookies[0]!)).data.csrfToken;
});
afterEach(async () => {
  if (f) await f.cleanup();
});
test('summary has strict input and requires admin plus an enabled assigned warehouse', async () => {
  assert.equal((await summary(f.warehouseId, '')).status, 401);
  for (const c of [...f.cookies, f.extraCookies[1]!])
    assert.equal((await summary(f.warehouseId, c)).status, 403);
  for (const q of [
    '',
    '?warehouseId=bad',
    '?warehouseId=' + f.warehouseId + '&filter=ALL',
    '?warehouseId=' + f.warehouseId + '&cursor=' + randomUUID(),
    '?warehouseId=' + f.warehouseId + '&warehouseId=' + f.warehouseId,
  ])
    assert.equal((await f.staff(base + '/summary' + q, f.extraCookies[0]!)).status, 400);
  assert.equal((await summary(randomUUID())).status, 403);
  await f.runtime.db.warehouse.update({ where: { id: f.warehouseId }, data: { enabled: false } });
  assert.equal((await summary()).status, 403);
  await f.runtime.db.warehouse.update({ where: { id: f.warehouseId }, data: { enabled: true } });
  const admin = (await f.staff('/staff/me', f.extraCookies[0]!)).data;
  await f.runtime.db.staffWarehouse.delete({
    where: { staffId_warehouseId: { staffId: admin.id, warehouseId: f.warehouseId } },
  });
  assert.equal((await summary()).status, 403);
});
test('empty and default-off summaries remain readable and expose only scoped counts and timestamp', async () => {
  const r = await summary();
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.counts, { ALL: 0, UNKNOWN: 0, CONFLICT: 0, EXHAUSTED: 0, REVIEW: 0 });
  assert.equal(r.data.warehouseId, f.warehouseId);
  assert.equal(r.data.syntheticOnly, true);
  assert.equal(r.data.enabled, true);
  assert.ok(Number.isFinite(Date.parse(r.data.generatedAt)));
  assert.deepEqual(Object.keys(r.data).sort(), [
    'counts',
    'enabled',
    'generatedAt',
    'syntheticOnly',
    'warehouseId',
  ]);
  const g = await orderAdminFixture();
  try {
    // Legacy unknown with a complete immutable evidence chain, no modern task/binding.
    const id = randomUUID(),
      key = randomUUID();
    await g.runtime.db.$transaction(async (tx) => {
      await tx.paymentAttemptLab.create({
        data: { id, key, warehouseId: g.warehouseId, evidence: 'UNKNOWN', version: 1 },
      });
      await tx.paymentAttemptLabEvent.createMany({
        data: [
          {
            id: randomUUID(),
            attemptId: id,
            key,
            action: 'STARTED',
            observation: 'NONE',
            evidence: 'NONE',
            version: 0,
          },
          {
            id: randomUUID(),
            attemptId: id,
            key: randomUUID(),
            action: 'UNKNOWN_RESULT',
            observation: 'UNKNOWN',
            evidence: 'UNKNOWN',
            version: 1,
          },
        ],
      });
    });
    const off = await g.staff(base + '/summary?warehouseId=' + g.warehouseId, g.extraCookies[0]!);
    assert.equal(off.status, 200);
    assert.equal(off.data.enabled, false);
    assert.deepEqual(off.data.counts, { ALL: 1, UNKNOWN: 1, CONFLICT: 0, EXHAUSTED: 0, REVIEW: 0 });
    assert.equal(await g.runtime.db.paymentQueryLabJob.count(), 0);
  } finally {
    await g.cleanup();
  }
});
test('overlapping reasons use distinct attempts; known exhausted remains counted and notes never reduce counts', async () => {
  const exhausted = await start('unknown-result');
  for (let i = 0; i < 3; i++) {
    assert.ok(await claimPaymentQueryLab(f.runtime.db, f.warehouseId, 1));
    await new Promise((r) => setTimeout(r, 1100));
  }
  await claimPaymentQueryLab(f.runtime.db, f.warehouseId);
  assert.deepEqual((await summary()).data.counts, {
    ALL: 1,
    UNKNOWN: 1,
    CONFLICT: 0,
    EXHAUSTED: 1,
    REVIEW: 0,
  });
  await observe(exhausted, 'success-result');
  const review = await start('unknown-result');
  await post('/admin/payment-attempt-lab/run-query-cycle', { scenario: 'MISSING' });
  const conflict = await start('success-result');
  await observe(conflict, 'closed-result');
  await start('success-result');
  await start('closed-result');
  await start();
  const before = await summary();
  assert.deepEqual(before.data.counts, {
    ALL: 3,
    UNKNOWN: 1,
    CONFLICT: 1,
    EXHAUSTED: 1,
    REVIEW: 1,
  });
  for (const filter of filters) {
    const list = await f.staff(
      base + '?warehouseId=' + f.warehouseId + '&filter=' + filter,
      f.extraCookies[0]!,
    );
    assert.equal(list.data.items.length, before.data.counts[filter]);
  }
  const d = (
    await f.staff(base + '/' + review + '?warehouseId=' + f.warehouseId, f.extraCookies[0]!)
  ).data;
  await post(base + '/' + review + '/notes', {
    key: randomUUID(),
    note: '仅记录合成核查，原因仍保留',
    attemptVersion: d.item.attemptVersion,
    jobVersion: d.item.jobVersion,
  });
  assert.deepEqual((await summary()).data.counts, before.data.counts);
});
test('summary covers all pages and excludes a second warehouse even when both are authorized', async () => {
  for (let i = 0; i < 23; i++) await start('unknown-result');
  const admin = (await f.staff('/staff/me', f.extraCookies[0]!)).data,
    other = await f.runtime.db.warehouse.create({
      data: { id: randomUUID(), code: 'SUMMARY-OTHER', name: '概览第二测试仓' },
    });
  await f.runtime.db.staffWarehouse.create({ data: { staffId: admin.id, warehouseId: other.id } });
  await start('unknown-result', other.id);
  const first = (await f.staff(base + '?warehouseId=' + f.warehouseId, f.extraCookies[0]!)).data;
  assert.equal(first.items.length, 20);
  assert.ok(first.nextCursor);
  assert.deepEqual((await summary()).data.counts, {
    ALL: 23,
    UNKNOWN: 23,
    CONFLICT: 0,
    EXHAUSTED: 0,
    REVIEW: 0,
  });
  assert.deepEqual((await summary(other.id)).data.counts, {
    ALL: 1,
    UNKNOWN: 1,
    CONFLICT: 0,
    EXHAUSTED: 0,
    REVIEW: 0,
  });
});
test('refresh sees evidence changes while concurrent reads stay internally consistent and perform no business writes', async () => {
  const id = await start('unknown-result');
  assert.equal((await summary()).data.counts.ALL, 1);
  const results = await Promise.all([
    observe(id, 'success-result'),
    ...Array.from({ length: 12 }, () => summary()),
  ]);
  for (const r of results.slice(1)) {
    assert.equal(r.status, 200);
    const c = r.data.counts;
    assert.ok([0, 1].includes(c.ALL));
    assert.equal(c.ALL, c.UNKNOWN);
    assert.equal(c.CONFLICT, 0);
    assert.equal(c.EXHAUSTED, 0);
    assert.equal(c.REVIEW, 0);
  }
  assert.equal((await summary()).data.counts.ALL, 0);
  const before = await facts();
  await Promise.all(Array.from({ length: 8 }, () => summary()));
  assert.deepEqual(await facts(), before);
});
async function facts() {
  const db = f.runtime.db;
  return {
    attempts: await db.paymentAttemptLab.findMany(),
    events: await db.paymentAttemptLabEvent.count(),
    jobs: await db.paymentQueryLabJob.findMany(),
    queryEvents: await db.paymentQueryLabEvent.count(),
    notes: await db.paymentReviewLabNote.count(),
    notifications: await db.notificationLabRecord.count(),
    audit: await db.businessAudit.count(),
    orders: await db.consumerOrder.count(),
    preparations: await db.paymentPreparation.count(),
    ledger: await db.stockLedger.count(),
    balances: await db.stockBalance.findMany(),
  };
}
