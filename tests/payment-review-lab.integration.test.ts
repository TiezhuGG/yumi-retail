import { beforeEach, afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { orderAdminFixture } from './helpers/order-admin-fixture.ts';
import { claimPaymentQueryLab, finishPaymentQueryLab } from '../packages/database/dist/index.js';
let f: Awaited<ReturnType<typeof orderAdminFixture>>, csrf: string;
const path = (s = '') => '/admin/payment-review-lab' + s + '?warehouseId=' + f.warehouseId;
async function post(
  id: string,
  body: unknown,
  cookie = f.extraCookies[0]!,
  token = csrf,
  origin = 'http://127.0.0.1:5188',
) {
  const r = await fetch(f.base + '/api/v1' + path('/' + id + '/notes'), {
    method: 'POST',
    headers: {
      Cookie: cookie,
      Origin: origin,
      'X-CSRF-Token': token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, ...(await r.json()) };
}
async function attempt(action = 'unknown-result') {
  const url = '/api/v1/admin/payment-attempt-lab',
    headers = {
      Cookie: f.extraCookies[0]!,
      Origin: 'http://127.0.0.1:5188',
      'X-CSRF-Token': csrf,
      'Content-Type': 'application/json',
    };
  const r = await fetch(f.base + url + '?warehouseId=' + f.warehouseId, {
    method: 'POST',
    headers,
    body: JSON.stringify({ key: randomUUID() }),
  });
  const id = (await r.json()).data.attempt.id as string;
  const observe = async (a: string) => {
    const r = await fetch(
      f.base + url + '/' + id + '/actions/' + a + '?warehouseId=' + f.warehouseId,
      { method: 'POST', headers, body: JSON.stringify({ key: randomUUID() }) },
    );
    assert.equal(r.status, 200);
  };
  await observe(action);
  return { id, observe };
}
async function detail(id: string) {
  const r = await f.staff(path('/' + id), f.extraCookies[0]!);
  assert.equal(r.status, 200);
  return r.data;
}
const payload = (
  d: { item: { attemptVersion: number; jobVersion: number | null } },
  note = '合成核查：保留未知，等待后续可信结果。',
  key = randomUUID(),
) => ({ key, note, attemptVersion: d.item.attemptVersion, jobVersion: d.item.jobVersion });
beforeEach(async () => {
  f = await orderAdminFixture({ notificationLab: true });
  csrf = (await f.staff('/staff/me', f.extraCookies[0]!)).data.csrfToken;
});
afterEach(async () => {
  if (f) await f.cleanup();
});
test('admin, warehouse, CSRF, strict snapshot/note inputs and plaintext rendering boundary', async () => {
  const { id } = await attempt(),
    p = payload(await detail(id));
  assert.equal((await f.staff(path(), '')).status, 401);
  for (const cookie of [...f.cookies, f.extraCookies[1]!])
    assert.equal((await f.staff(path(), cookie)).status, 403);
  assert.equal((await post(id, p, f.extraCookies[0]!, '')).status, 403);
  assert.equal(
    (await post(id, p, f.extraCookies[0]!, csrf, 'http://untrusted.invalid')).status,
    403,
  );
  for (const body of [
    { ...p, note: '' },
    { ...p, note: 'x'.repeat(501) },
    { ...p, note: 'bad\u0000text' },
    { ...p, paid: true },
    { ...p, attemptVersion: -1 },
    { ...p, jobVersion: '0' },
  ])
    assert.equal((await post(id, body)).status, 400);
  assert.equal((await f.staff(path() + '&filter=PAID', f.extraCookies[0]!)).status, 400);
  assert.equal(
    (await f.staff('/admin/payment-review-lab?warehouseId=' + randomUUID(), f.extraCookies[0]!))
      .status,
    403,
  );
  assert.equal((await post(randomUUID(), p)).status, 404);
  const r = await post(id, { ...p, note: '  合成<script>仅作文字</script>\r\n换行  ' });
  assert.equal(r.status, 200);
  assert.equal(r.data.note.note, '合成<script>仅作文字</script>\n换行');
});
test('filters include unknown, conflict without tasks and exhausted known records', async () => {
  const unknown = await attempt(),
    conflict = await attempt('success-result');
  await conflict.observe('closed-result');
  let a = (await f.staff(path() + '&filter=ALL', f.extraCookies[0]!)).data;
  assert.equal(a.items.length, 2);
  assert.ok(a.items.every((v: { needsReview: boolean }) => v.needsReview));
  a = (await f.staff(path() + '&filter=CONFLICT', f.extraCookies[0]!)).data;
  assert.equal(a.items.length, 1);
  assert.equal(a.items[0].id, conflict.id);
  assert.equal(a.items[0].taskState, null);
  a = (await f.staff(path() + '&filter=UNKNOWN', f.extraCookies[0]!)).data;
  assert.equal(a.items[0].id, unknown.id);
  for (let i = 0; i < 3; i++) {
    assert.ok(await claimPaymentQueryLab(f.runtime.db, f.warehouseId, 1));
    await new Promise((r) => setTimeout(r, 1100));
  }
  await claimPaymentQueryLab(f.runtime.db, f.warehouseId);
  await unknown.observe('closed-result');
  a = (await f.staff(path() + '&filter=EXHAUSTED', f.extraCookies[0]!)).data;
  assert.equal(a.items.length, 1);
  assert.equal(a.items[0].evidence, 'CLOSED');
  assert.equal(a.items[0].taskState, 'EXHAUSTED');
});
test('same-key concurrent notes create one immutable note/audit; changed text conflicts and original replay survives state changes', async () => {
  const { id, observe } = await attempt(),
    p = payload(await detail(id));
  const r = await Promise.all(Array.from({ length: 8 }, () => post(id, p)));
  assert.ok(r.every((x) => x.status === 200));
  assert.equal(r.filter((x) => !x.data.duplicate).length, 1);
  assert.equal(await f.runtime.db.paymentReviewLabNote.count(), 1);
  assert.equal(
    await f.runtime.db.businessAudit.count({ where: { action: 'PAYMENT_REVIEW_LAB_NOTE' } }),
    1,
  );
  assert.equal((await post(id, { ...p, note: 'changed' })).status, 409);
  await observe('closed-result');
  const retry = await post(id, p);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.duplicate, true);
  assert.equal(retry.data.note.evidence, 'UNKNOWN');
  assert.equal((await detail(id)).item.needsReview, false);
});
test('worker changes invalidate both evidence and task snapshots; fresh note never changes task or evidence', async () => {
  const { id } = await attempt(),
    old = payload(await detail(id)),
    lease = await claimPaymentQueryLab(f.runtime.db, f.warehouseId);
  assert.ok(lease);
  assert.equal((await post(id, old)).error.code, 'REVIEW_SNAPSHOT_STALE');
  await finishPaymentQueryLab(f.runtime.db, lease);
  assert.equal((await post(id, old)).status, 409);
  const d = await detail(id),
    p = payload(d),
    before = await f.runtime.db.paymentQueryLabJob.findUniqueOrThrow({ where: { attemptId: id } }),
    events = await f.runtime.db.paymentAttemptLabEvent.count();
  const r = await post(id, p);
  assert.equal(r.status, 200);
  assert.equal(r.data.note.jobVersion, d.item.jobVersion);
  assert.deepEqual(
    await f.runtime.db.paymentQueryLabJob.findUniqueOrThrow({ where: { attemptId: id } }),
    before,
  );
  assert.equal(await f.runtime.db.paymentAttemptLabEvent.count(), events);
});
test('late audit failure rolls note back; database rejects alteration, deletion and forged snapshots', async () => {
  const { id } = await attempt(),
    p = payload(await detail(id));
  await f.runtime.db.$executeRawUnsafe(
    "CREATE FUNCTION fail_review_audit_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='PAYMENT_REVIEW_LAB_NOTE' THEN RAISE EXCEPTION 'isolated rollback'; END IF; RETURN NEW; END $$",
  );
  await f.runtime.db.$executeRawUnsafe(
    'CREATE TRIGGER fail_review_audit_test BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_review_audit_test()',
  );
  assert.equal((await post(id, p)).status, 500);
  assert.equal(await f.runtime.db.paymentReviewLabNote.count(), 0);
  await f.runtime.db.$executeRawUnsafe('DROP TRIGGER fail_review_audit_test ON business_audits');
  const r = await post(id, p);
  assert.equal(r.status, 200);
  const row = await f.runtime.db.paymentReviewLabNote.findUniqueOrThrow({
    where: { id: r.data.note.id },
  });
  await assert.rejects(() =>
    f.runtime.db.paymentReviewLabNote.update({
      where: { id: row.id },
      data: { note: 'overwrite' },
    }),
  );
  await assert.rejects(() => f.runtime.db.paymentReviewLabNote.delete({ where: { id: row.id } }));
  await assert.rejects(() =>
    f.runtime.db.paymentReviewLabNote.create({
      data: { ...row, id: randomUUID(), key: randomUUID(), evidence: 'SUCCEEDED' },
    }),
  );
});
test('case and note pagination are warehouse/attempt scoped and have no overlapping page rows', async () => {
  const { id } = await attempt(),
    d = await detail(id);
  for (let i = 0; i < 22; i++)
    assert.equal((await post(id, payload(d, '合成核查 ' + i))).status, 200);
  const a = await detail(id);
  assert.equal(a.notes.length, 20);
  assert.ok(a.nextNotesCursor);
  const b = (
    await f.staff(path('/' + id) + '&notesCursor=' + a.nextNotesCursor, f.extraCookies[0]!)
  ).data;
  assert.equal(b.notes.length, 2);
  assert.ok(
    b.notes.every((n: { id: string }) => !a.notes.some((m: { id: string }) => m.id === n.id)),
  );
  assert.equal(
    (await f.staff(path('/' + id) + '&notesCursor=' + randomUUID(), f.extraCookies[0]!)).status,
    404,
  );
  for (let i = 0; i < 21; i++)
    await attempt('success-result').then((x) => x.observe('closed-result'));
  const list = (await f.staff(path(), f.extraCookies[0]!)).data;
  assert.equal(list.items.length, 20);
  const next = (await f.staff(path() + '&cursor=' + list.nextCursor, f.extraCookies[0]!)).data;
  assert.equal(next.items.length, 2);
  assert.ok(
    next.items.every((n: { id: string }) => !list.items.some((m: { id: string }) => m.id === n.id)),
  );
});
test('note competing with new evidence is either a valid old snapshot or stale refusal; no business mutation', async () => {
  const { id, observe } = await attempt(),
    p = payload(await detail(id)),
    stock = await f.runtime.db.stockBalance.findMany(),
    ledger = await f.runtime.db.stockLedger.count();
  const [r] = await Promise.all([post(id, p), observe('closed-result')]);
  assert.ok([200, 409].includes(r.status));
  if (r.status === 200) assert.equal(r.data.note.evidence, 'UNKNOWN');
  assert.equal((await detail(id)).item.evidence, 'CLOSED');
  assert.deepEqual(await f.runtime.db.stockBalance.findMany(), stock);
  assert.equal(await f.runtime.db.stockLedger.count(), ledger);
  assert.equal(await f.runtime.db.consumerOrder.count(), 0);
  assert.equal(await f.runtime.db.paymentPreparation.count(), 0);
});
test('default-off notes cannot write; revoked warehouse loses list/detail/note access', async () => {
  const { id } = await attempt(),
    p = payload(await detail(id));
  const g = await orderAdminFixture();
  try {
    const token = (await g.staff('/staff/me', g.extraCookies[0]!)).data.csrfToken;
    const r = await fetch(
      g.base +
        '/api/v1/admin/payment-review-lab/' +
        randomUUID() +
        '/notes?warehouseId=' +
        g.warehouseId,
      {
        method: 'POST',
        headers: {
          Cookie: g.extraCookies[0]!,
          Origin: 'http://127.0.0.1:5188',
          'X-CSRF-Token': token,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(p),
      },
    );
    assert.equal(r.status, 503);
    assert.equal(
      (await g.staff('/admin/payment-review-lab?warehouseId=' + g.warehouseId, g.extraCookies[0]!))
        .data.enabled,
      false,
    );
  } finally {
    await g.cleanup();
  }
  const me = (await f.staff('/staff/me', f.extraCookies[0]!)).data;
  await f.runtime.db.staffWarehouse.deleteMany({ where: { staffId: me.id } });
  assert.equal((await f.staff(path(), f.extraCookies[0]!)).status, 403);
  assert.equal((await f.staff(path('/' + id), f.extraCookies[0]!)).status, 403);
  assert.equal((await post(id, p)).status, 403);
});
