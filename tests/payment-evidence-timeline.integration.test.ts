import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { orderAdminFixture } from './helpers/order-admin-fixture.ts';
let f: Awaited<ReturnType<typeof orderAdminFixture>>, csrf: string;
const attempts = '/admin/payment-attempt-lab',
  records = '/admin/payment-notification-records',
  reviews = '/admin/payment-review-lab';
async function post(path: string, body: unknown) {
  const r = await fetch(f.base + '/api/v1' + path + '?warehouseId=' + f.warehouseId, {
    method: 'POST',
    headers: {
      Cookie: f.extraCookies[0]!,
      Origin: 'http://127.0.0.1:5188',
      'X-CSRF-Token': csrf,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, ...(await r.json()) };
}
async function timeline(id: string, extra = '', cookie = f.extraCookies[0]!) {
  return f.staff(reviews + '/' + id + '/timeline?warehouseId=' + f.warehouseId + extra, cookie);
}
async function start() {
  const a = await post(attempts, { key: randomUUID() }),
    id = a.data.attempt.id as string;
  await post(attempts + '/' + id + '/actions/unknown-result', { key: randomUUID() });
  return id;
}
async function note(id: string, text = '合成核查说明') {
  const detail = (
    await f.staff(reviews + '/' + id + '?warehouseId=' + f.warehouseId, f.extraCookies[0]!)
  ).data;
  const r = await post(reviews + '/' + id + '/notes', {
    key: randomUUID(),
    note: text,
    attemptVersion: detail.item.attemptVersion,
    jobVersion: detail.item.jobVersion,
  });
  assert.equal(r.status, 200);
  return r.data.note;
}
async function seed() {
  const id = await start();
  await post(attempts + '/run-query-cycle', { scenario: 'CLOSED' });
  await post(records, { key: randomUUID(), attemptId: id });
  await post(records, { key: randomUUID(), attemptId: id });
  await note(id, '合成备注：<script>unsafe()</script>，保留冲突。');
  return id;
}
beforeEach(async () => {
  f = await orderAdminFixture({ notificationLab: true });
  csrf = (await f.staff('/staff/me', f.extraCookies[0]!)).data.csrfToken;
});
afterEach(async () => {
  if (f) await f.cleanup();
});
test('timeline authorization, source and reference parsing are strict and scoped to current warehouse/attempt', async () => {
  const a = await start(),
    b = await start(),
    other = await timeline(b);
  assert.equal((await timeline(a, '', '')).status, 401);
  for (const c of f.cookies) assert.equal((await timeline(a, '', c)).status, 403);
  for (const q of [
    '&filter=UNKNOWN',
    '&filter=ALL&extra=x',
    '&focus=ATTEMPT:bad',
    '&cursor=NONE:' + randomUUID(),
    '&cursor=ATTEMPT:' + randomUUID() + '&focus=ATTEMPT:' + randomUUID(),
  ])
    assert.equal((await timeline(a, q)).status, 400);
  const ref = other.data.items[0].ref;
  assert.equal((await timeline(a, '&focus=' + ref)).status, 404);
  assert.equal((await timeline(a, '&cursor=' + ref)).status, 404);
  assert.equal((await timeline(a, '&focus=ATTEMPT:' + randomUUID())).status, 404);
  assert.equal(
    (await f.staff(reviews + '/' + a + '/timeline?warehouseId=' + randomUUID(), f.extraCookies[0]!))
      .status,
    403,
  );
  assert.equal((await timeline(randomUUID())).status, 404);
});
test('four sources merge into a sanitized read-only timeline with all application records and snapshot links', async () => {
  const id = await seed(),
    before = {
      audits: await f.runtime.db.businessAudit.count(),
      events: await f.runtime.db.paymentAttemptLabEvent.count(),
      query: await f.runtime.db.paymentQueryLabEvent.count(),
      notes: await f.runtime.db.paymentReviewLabNote.count(),
      notifications: await f.runtime.db.notificationLabRecord.count(),
      ledgers: await f.runtime.db.stockLedger.count(),
    };
  const r = await timeline(id);
  assert.equal(r.status, 200);
  assert.equal(r.data.items.length, 11);
  assert.equal(new Set(r.data.items.map((i: { source: string }) => i.source)).size, 4);
  assert.equal(r.data.item.evidence, 'CONFLICT');
  assert.equal(r.data.item.taskState, 'REVIEW');
  assert.equal(
    r.data.items.filter((x: { source: string }) => x.source === 'NOTIFICATION').length,
    2,
  );
  assert.equal(r.data.nextCursor, null);
  assert.ok(JSON.stringify(r).includes('<script>unsafe()</script>'));
  for (const secret of [
    'leaseToken',
    'factsHash',
    'ciphertext',
    'apiV3Key',
    'passwordHash',
    'payer',
    'requestId',
  ])
    assert.ok(!JSON.stringify(r.data).includes(secret));
  assert.deepEqual(
    {
      audits: await f.runtime.db.businessAudit.count(),
      events: await f.runtime.db.paymentAttemptLabEvent.count(),
      query: await f.runtime.db.paymentQueryLabEvent.count(),
      notes: await f.runtime.db.paymentReviewLabNote.count(),
      notifications: await f.runtime.db.notificationLabRecord.count(),
      ledgers: await f.runtime.db.stockLedger.count(),
    },
    before,
  );
  assert.equal(await f.runtime.db.consumerOrder.count(), 0);
});
test('every relationship resolves within scope and focus puts exact target first without changing facts', async () => {
  const id = await seed(),
    page = (await timeline(id)).data;
  for (const row of page.items)
    for (const link of row.related) {
      const focused = await timeline(id, '&focus=' + encodeURIComponent(link.ref));
      assert.equal(focused.status, 200);
      assert.equal(focused.data.items[0].ref, link.ref);
      assert.equal(focused.data.focusedRef, link.ref);
    }
  const upper = await timeline(id, '&focus=' + page.items[0].ref.toUpperCase());
  assert.equal(upper.data.focusedRef, page.items[0].ref);
  const n = page.items.find((x: { source: string }) => x.source === 'NOTIFICATION');
  assert.equal((await timeline(id, '&filter=NOTE&focus=' + n.ref)).status, 400);
  const notices = page.items.filter((x: { source: string }) => x.source === 'NOTIFICATION');
  assert.equal(notices[0].related[0].ref, notices[1].related[0].ref);
  const success = page.items.find((x: { ref: string }) => x.ref === notices[0].related[0].ref);
  assert.ok(success.related.some((x: { ref: string }) => x.ref.startsWith('NOTIFICATION:')));
  assert.ok(
    success.entries.some(
      (x: { label: string; value: string }) => x.label === '同交易通知记录数' && x.value === '2',
    ),
  );
});
test('keyset pagination is deterministic for tied timestamps and has no duplicate or missing rows', async () => {
  const id = await start(),
    me = (await f.staff('/staff/me', f.extraCookies[0]!)).data;
  const a = await f.runtime.db.paymentAttemptLab.findUniqueOrThrow({ where: { id } }),
    j = await f.runtime.db.paymentQueryLabJob.findUniqueOrThrow({ where: { attemptId: id } });
  for (let i = 0; i < 45; i++)
    await f.runtime.db.paymentReviewLabNote.create({
      data: {
        id: randomUUID(),
        attemptId: id,
        warehouseId: f.warehouseId,
        actorId: me.id,
        actorName: '合成分页核查人',
        key: randomUUID(),
        note: '合成同刻备注 ' + i,
        evidence: a.evidence,
        attemptVersion: a.version,
        taskState: j.state,
        jobVersion: j.version,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
  const refs: string[] = [];
  let cursor: string | null = null,
    pages = 0;
  do {
    const r = await timeline(id, cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    assert.equal(r.status, 200);
    assert.ok(r.data.items.length <= 20);
    refs.push(...r.data.items.map((x: { ref: string }) => x.ref));
    cursor = r.data.nextCursor;
    pages++;
  } while (cursor);
  assert.equal(pages, 3);
  assert.equal(refs.length, 48);
  assert.equal(new Set(refs).size, 48);
  const expected = await f.runtime.db.paymentReviewLabNote.findMany({
    where: { attemptId: id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
  });
  assert.deepEqual(
    refs.filter((r) => r.startsWith('NOTE:')),
    expected.map((n) => 'NOTE:' + n.id),
  );
  // Three source types at the same millisecond, including the same UUID in separate tables.
  const tied = randomUUID(),
    started = randomUUID(),
    observed = randomUUID(),
    jobId = randomUUID(),
    queryId = randomUUID(),
    key = randomUUID(),
    time = new Date('2026-01-01T00:00:00.000Z');
  await f.runtime.db.$transaction(async (tx) => {
    await tx.paymentAttemptLab.create({
      data: {
        id: tied,
        key,
        warehouseId: f.warehouseId,
        evidence: 'UNKNOWN',
        version: 1,
        createdAt: time,
      },
    });
    await tx.paymentAttemptLabEvent.createMany({
      data: [
        {
          id: started,
          attemptId: tied,
          key,
          action: 'STARTED',
          observation: 'NONE',
          evidence: 'NONE',
          version: 0,
          createdAt: time,
        },
        {
          id: observed,
          attemptId: tied,
          key: randomUUID(),
          action: 'UNKNOWN_RESULT',
          observation: 'UNKNOWN',
          evidence: 'UNKNOWN',
          version: 1,
          createdAt: time,
        },
      ],
    });
    await tx.paymentQueryLabJob.create({
      data: { id: jobId, attemptId: tied, warehouseId: f.warehouseId, createdAt: time },
    });
    await tx.paymentQueryLabEvent.create({
      data: {
        id: queryId,
        jobId,
        key: jobId,
        reason: 'SCHEDULED',
        state: 'RETRY',
        attempts: 0,
        version: 0,
        createdAt: time,
      },
    });
    await tx.paymentReviewLabNote.create({
      data: {
        id: observed,
        attemptId: tied,
        warehouseId: f.warehouseId,
        actorId: me.id,
        actorName: '合成同刻核查人',
        key: randomUUID(),
        note: '合成同刻跨来源',
        evidence: 'UNKNOWN',
        attemptVersion: 1,
        taskState: 'RETRY',
        jobVersion: 0,
        createdAt: time,
      },
    });
  });
  const tiedPage = (await timeline(tied)).data;
  assert.deepEqual(
    tiedPage.items.map((x: { source: string }) => x.source),
    ['NOTE', 'QUERY', 'ATTEMPT', 'ATTEMPT'],
  );
  assert.equal(new Set(tiedPage.items.map((x: { ref: string }) => x.ref)).size, 4);
  assert.equal(
    (await timeline(tied, '&cursor=NOTE:' + observed)).data.items[0].ref,
    'QUERY:' + queryId,
  );
  const first = await timeline(id, '&filter=NOTE'),
    second = await timeline(id, '&filter=NOTE&cursor=' + first.data.nextCursor);
  assert.equal(first.data.items.length, 20);
  assert.equal(second.data.items.length, 20);
  assert.ok(first.data.items.every((i: { source: string }) => i.source === 'NOTE'));
});
test('new append between pages is visible on refresh while continuation excludes newer rows', async () => {
  const id = await start();
  for (let i = 0; i < 21; i++) await note(id, '合成备注 ' + i);
  const first = (await timeline(id)).data;
  const added = await note(id, '合成新增备注');
  const older = (await timeline(id, '&cursor=' + encodeURIComponent(first.nextCursor))).data;
  assert.ok(!older.items.some((x: { ref: string }) => x.ref === 'NOTE:' + added.id));
  assert.equal(new Set([...first.items, ...older.items].map((x) => x.ref)).size, 24);
  assert.equal((await timeline(id)).data.items[0].ref, 'NOTE:' + added.id);
});
test('note references its original evidence/task snapshot, not current conflict; absent source is empty', async () => {
  const id = await start();
  assert.equal((await timeline(id, '&filter=NOTIFICATION')).data.items.length, 0);
  const saved = await note(id, '合成旧快照备注');
  await post(attempts + '/run-query-cycle', { scenario: 'CLOSED' });
  await post(records, { key: randomUUID(), attemptId: id });
  const page = (await timeline(id, '&filter=NOTE')).data,
    row = page.items.find((i: { id: string }) => i.id === saved.id);
  assert.ok(
    row.entries.some(
      (e: { label: string; value: string }) => e.label === '当时证据' && e.value === '结果未知',
    ),
  );
  const attempt = row.related.find((r: { ref: string }) => r.ref.startsWith('ATTEMPT:')),
    query = row.related.find((r: { ref: string }) => r.ref.startsWith('QUERY:'));
  assert.equal(
    (await timeline(id, '&focus=' + attempt.ref)).data.items[0].entries.find(
      (e: { label: string }) => e.label === '尝试记录序号',
    ).value,
    '1',
  );
  assert.equal((await timeline(id, '&focus=' + query.ref)).data.items[0].title, '已安排查询');
  assert.equal(page.item.evidence, 'CONFLICT');
});
test('concurrent scoped readers and writers return internally consistent event versions without modifying business data', async () => {
  const id = await start();
  const result = await Promise.all([
    post(records, { key: randomUUID(), attemptId: id }),
    ...Array.from({ length: 8 }, () => timeline(id)),
  ]);
  for (const r of result.slice(1)) {
    assert.equal(r.status, 200);
    const attempts = r.data.items.filter((x: { source: string }) => x.source === 'ATTEMPT');
    const queries = r.data.items.filter((x: { source: string }) => x.source === 'QUERY');
    assert.equal(attempts.length, r.data.item.attemptVersion + 1);
    assert.equal(queries.length, r.data.item.jobVersion + 1);
  }
  assert.equal(await f.runtime.db.paymentNotificationLabApplication.count(), 1);
  assert.equal(await f.runtime.db.consumerOrder.count(), 0);
});
test('default-off mode can read legacy evidence; revoked warehouse loses timeline and locator access', async () => {
  const g = await orderAdminFixture();
  try {
    const id = randomUUID(),
      key = randomUUID();
    await g.runtime.db.$transaction(async (tx) => {
      await tx.paymentAttemptLab.create({ data: { id, key, warehouseId: g.warehouseId } });
      await tx.paymentAttemptLabEvent.create({
        data: {
          id: randomUUID(),
          attemptId: id,
          key,
          action: 'STARTED',
          observation: 'NONE',
          evidence: 'NONE',
          version: 0,
        },
      });
    });
    const url = reviews + '/' + id + '/timeline?warehouseId=' + g.warehouseId,
      r = await g.staff(url, g.extraCookies[0]!);
    assert.equal(r.status, 200);
    assert.equal(r.data.items.length, 1);
    assert.equal(r.data.item.needsReview, false);
    const me = (await g.staff('/staff/me', g.extraCookies[0]!)).data;
    await g.runtime.db.staffWarehouse.deleteMany({ where: { staffId: me.id } });
    assert.equal(
      (await g.staff(url + '&focus=' + r.data.items[0].ref, g.extraCookies[0]!)).status,
      403,
    );
  } finally {
    await g.cleanup();
  }
});
