import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { createDatabase, hashPassword } from '../packages/database/src/index.ts';
import { createApplication } from '../apps/api/dist/app.js';
import { applicationConfig } from '../apps/api/dist/config.js';
import type {
  ReceiptReversal,
  ReceiptReversalSource,
  StockPosition,
  Page,
  Product,
  Receipt,
  StaffProfile,
  SaleSku,
} from '../packages/contracts/src/index.ts';
const url = new URL(process.env.TEST_DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/yumi_test')
  throw new Error('Only local yumi_test allowed');
const schema = 'reversal_' + randomUUID().replaceAll('-', '');
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => {
    connect(): Promise<void>;
    end(): Promise<void>;
    query(sql: string, values?: unknown[]): Promise<unknown>;
  };
};
const admin = new Client({ connectionString: url.toString() });
url.searchParams.set('schema', schema);
const db = createDatabase(url.toString());
const warehouseId = randomUUID(),
  otherWarehouse = randomUUID(),
  actors = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const password = randomBytes(24).toString('hex');
const identities: Array<{ cookie: string; csrf: string }> = [];
let runtime: Awaited<ReturnType<typeof createApplication>>,
  base = '',
  categoryId = '',
  serial = 0;
const checks: string[] = [];
const path = (suffix: string) => `/warehouse/warehouses/${warehouseId}/${suffix}`;
async function call<T>(
  path: string,
  body?: unknown,
  actor: number | null = 0,
  key: string = randomUUID(),
) {
  const headers: Record<string, string> = { Origin: 'http://127.0.0.1:5173' };
  if (actor !== null) {
    headers.Cookie = identities[actor]!.cookie;
    headers['X-CSRF-Token'] = identities[actor]!.csrf;
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = key;
  }
  const response = await fetch(base + '/api/v1' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = (await response.json()) as { data: T; error?: { code: string } };
  return { status: response.status, ...result };
}
async function ok<T>(path: string, body?: unknown, actor = 0, key?: string) {
  const r = await call<T>(path, body, actor, key);
  assert.equal(r.status, 200, `${path}: ${r.error?.code}`);
  return r.data;
}
before(async () => {
  await admin.connect();
  assert.match(schema, /^reversal_[a-f0-9]{32}$/);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query("SELECT set_config('search_path',$1,false)", [schema]);
  const dir = 'packages/database/prisma/migrations';
  for (const n of (await readdir(dir)).filter((n) => /^\d/.test(n)).sort())
    await admin.query(await readFile(`${dir}/${n}/migration.sql`, 'utf8'));
  await db.warehouse.createMany({
    data: [
      { id: warehouseId, code: 'REVERSAL', name: '逆向测试仓' },
      { id: otherWarehouse, code: 'OTHER', name: '未授权仓' },
    ],
  });
  const passwordHash = await hashPassword(password);
  for (const [i, id] of actors.entries())
    await db.staff.create({
      data: {
        id,
        loginName: `reversal.${i}`,
        displayName: `逆向验收${i}`,
        passwordHash,
        roles: {
          create: { roleCode: ['SUPER_ADMIN', 'WAREHOUSE_MANAGER', 'PICKER', 'RIDER'][i]! },
        },
        warehouses: { create: { warehouseId } },
      },
    });
  categoryId = (await db.category.create({ data: { id: randomUUID(), name: '逆向测试' } })).id;
  runtime = await createApplication(url.toString(), {
    config: applicationConfig({
      ...process.env,
      NODE_ENV: 'test',
      PUBLIC_WAREHOUSE_ID: warehouseId,
    }),
    accessLog: () => {},
  });
  await runtime.app.listen(0, '127.0.0.1');
  base = await runtime.app.getUrl();
  for (let i = 0; i < actors.length; i++) {
    const response = await fetch(base + '/api/v1/staff/auth/session', {
      method: 'POST',
      headers: { Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginName: `reversal.${i}`, password }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const p = (await fetch(base + '/api/v1/staff/me', { headers: { Cookie: cookie } }).then((r) =>
      r.json(),
    )) as { data: StaffProfile };
    identities.push({ cookie, csrf: p.data.csrfToken });
  }
});
after(async () => {
  try {
    if (runtime) await runtime.close();
    await db.$disconnect();
    assert.match(schema, /^reversal_[a-f0-9]{32}$/);
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await mkdir('.local', { recursive: true });
    await writeFile(
      '.local/reversal-results.json',
      JSON.stringify(
        {
          finishedAt: new Date().toISOString(),
          checks,
          isolation: 'local yumi_test disposable schema',
          schemaRemoved: true,
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    await admin.end();
  }
});
async function receipt(skuId: string, quantity = 10) {
  return ok<Receipt>(path('receipts'), {
    sourceRef: '逆向测试合成入库',
    lines: [{ skuId, batchNo: 'REVERSAL', quantity, unitCostCents: 200 }],
  });
}
async function fresh(quantity = 10) {
  const product = await ok<Product>('/admin/products', {
    categoryId,
    name: `逆向商品${++serial}`,
    skus: [
      {
        code: `REVERSAL-${serial}`,
        spec: '1包',
        unit: '包',
        priceCents: 450,
        expiryManaged: false,
      },
    ],
  });
  await ok(`/admin/products/${product.id}/publish`, { version: 0 });
  const sku = product.skus[0]!.id;
  const d = await receipt(sku, quantity);
  await ok(path(`receipts/${d.id}/approve`), { version: 0 });
  await ok(path(`receipts/${d.id}/post`), { version: 1 });
  const p = (await ok<Page<StockPosition>>(path(`positions?skuId=${sku}`))).items[0]!;
  return { sku, p, receiptId: d.id };
}
async function balance(sku: string) {
  return db.stockBalance.findUniqueOrThrow({
    where: { warehouseId_skuId: { warehouseId, skuId: sku } },
  });
}
async function visible(sku: string) {
  return (await call<SaleSku>(`/products/${sku}`, undefined, null)).data.available;
}
async function consistent(sku: string) {
  const r = await ok<{ issueCount: number }>(path('inventory-checks'), { skuId: sku });
  assert.equal(r.issueCount, 0);
}

async function position(id: string) {
  return db.stockPosition.findUniqueOrThrow({ where: { id } });
}
async function draft(p: StockPosition, quantity = 2, key?: string) {
  return ok<ReceiptReversal>(
    path('receipt-reversals'),
    { positionId: p.id, quantity, positionVersion: p.version, reason: '合成误录收货数量纠正' },
    0,
    key,
  );
}
async function approve(d: ReceiptReversal) {
  return ok<ReceiptReversal>(
    path(`receipt-reversals/${d.id}/approve`),
    { version: d.version, reason: '独立复核原单及误录数量' },
    1,
  );
}
async function post(d: ReceiptReversal, key?: string) {
  return ok<ReceiptReversal>(
    path(`receipt-reversals/${d.id}/post`),
    {
      version: d.version,
      physicalConfirmed: true,
      physicalEvidence: '仅合成验收：原单和实物误录核验',
    },
    0,
    key,
  );
}

test('partial reversal preserves original receipt/cost/ledger and reconciles all stock levels', async () => {
  const { sku, p, receiptId } = await fresh();
  const before = await db.inboundReceipt.findUniqueOrThrow({
    where: { id: receiptId },
    include: { lines: true },
  });
  const d = await draft(p, 3);
  assert.equal(await visible(sku), 10);
  const a = await approve(d);
  await post(a);
  const b = await balance(sku);
  assert.equal(b.onHand, 7);
  assert.equal(b.blocked, 0);
  assert.equal(b.reserved, 0);
  assert.equal(await visible(sku), 7);
  assert.equal((await position(p.id)).onHand, 7);
  assert.equal((await db.stockLot.findUniqueOrThrow({ where: { id: p.lotId } })).onHand, 7);
  assert.deepEqual(
    await db.inboundReceipt.findUniqueOrThrow({
      where: { id: receiptId },
      include: { lines: true },
    }),
    before,
  );
  const source = await ok<ReceiptReversalSource>(path(`receipt-reversal-sources/${p.id}`));
  assert.equal(source.receiptId, receiptId);
  assert.equal(source.reversedQuantity, 3);
  assert.equal(source.remaining, 7);
  assert.equal(source.freeQuantity, 7);
  const ledger = await db.stockLedger.findUniqueOrThrow({
    where: { actionKey: `RECEIPT_REVERSE:${d.id}` },
    include: { positionEntries: true },
  });
  assert.equal(ledger.deltaOnHand, -3);
  assert.equal(ledger.positionEntries.length, 1);
  assert.equal(ledger.positionEntries[0]!.positionId, p.id);
  const read = await ok<Page<{ reason: string }>>(path(`positions/${p.id}/ledger`));
  assert.ok(read.items.some((e) => e.reason === d.reason));
  await consistent(sku);
  checks.push(
    'partial reversal, untouched original, three stock levels/two ledgers/public availability',
  );
});
test('independent review, mandatory physical evidence, action transitions and cancellation', async () => {
  const { sku, p } = await fresh();
  const d = await draft(p);
  assert.equal(
    (await call(path(`receipt-reversals/${d.id}/approve`), { version: 0, reason: '自审' })).status,
    403,
  );
  assert.equal(
    (
      await call(path(`receipt-reversals/${d.id}/post`), {
        version: 0,
        physicalConfirmed: true,
        physicalEvidence: '测试',
      })
    ).status,
    409,
  );
  await approve(d);
  for (const body of [
    { version: 1 },
    { version: 1, physicalConfirmed: false, physicalEvidence: '未确认' },
    { version: 1, physicalConfirmed: true },
  ])
    assert.equal((await call(path(`receipt-reversals/${d.id}/post`), body)).status, 400);
  await ok(path(`receipt-reversals/${d.id}/cancel`), { version: 1, reason: '无需纠错' });
  assert.equal((await balance(sku)).onHand, 10);
  assert.equal(
    (
      await call(path(`receipt-reversals/${d.id}/post`), {
        version: 2,
        physicalConfirmed: true,
        physicalEvidence: '终态不能过账',
      })
    ).status,
    409,
  );
  const next = await draft(p);
  await ok(path(`receipt-reversals/${next.id}/cancel`), { version: 0, reason: '取消草稿' });
  await consistent(sku);
  checks.push('independent reviewer, evidence, terminal and both cancellation paths');
});
test('20 identical draft/post retries and independent keys apply a single intent', async () => {
  const { sku, p } = await fresh(1);
  const body = { positionId: p.id, quantity: 1, positionVersion: p.version, reason: '最后1件纠错' },
    key = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      call<ReceiptReversal>(path('receipt-reversals'), body, 0, key),
    ),
  );
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(new Set(results.map((r) => r.data.id)).size, 1);
  assert.equal(
    (await call(path('receipt-reversals'), { ...body, reason: '不同意图' }, 0, key)).error?.code,
    'IDEMPOTENCY_CONFLICT',
  );
  const a = await approve(results[0]!.data),
    postKey = randomUUID();
  await Promise.all(Array.from({ length: 20 }, () => post(a, postKey)));
  assert.equal((await balance(sku)).onHand, 0);
  assert.equal(await db.stockLedger.count({ where: { actionKey: `RECEIPT_REVERSE:${a.id}` } }), 1);
  const next = await fresh(1);
  const docs = [await approve(await draft(next.p, 1)), await approve(await draft(next.p, 1))];
  const race = await Promise.all(
    docs.map((d) =>
      call(path(`receipt-reversals/${d.id}/post`), {
        version: 1,
        physicalConfirmed: true,
        physicalEvidence: '独立键争抢',
      }),
    ),
  );
  assert.equal(race.filter((r) => r.status === 200).length, 1);
  assert.equal((await balance(next.sku)).onHand, 0);
  await consistent(next.sku);
  checks.push('20 create/post retries, payload mismatch and independent-key last unit');
});
test('transferred positions retain original lot capacity; partial corrections may span positions', async () => {
  const { sku, p } = await fresh();
  const loc = await ok<{ id: string }>(path('locations'), {
    code: `REV-${++serial}`,
    name: '纠错货位',
  });
  await ok(path('stock-transfers'), {
    sourcePositionId: p.id,
    targetLocationId: loc.id,
    quantity: 4,
    version: p.version,
    reason: '合成移位',
  });
  const rows = (await ok<Page<StockPosition>>(path(`positions?skuId=${sku}`))).items;
  const target = rows.find((r) => r.locationId === loc.id)!;
  const d1 = await approve(await draft({ ...p, ...(await position(p.id)) }, 6));
  const d2 = await approve(await draft(target, 4));
  await post(d1);
  await post(d2);
  assert.equal((await balance(sku)).onHand, 0);
  assert.equal(
    (await ok<ReceiptReversalSource>(path(`receipt-reversal-sources/${target.id}`))).remaining,
    0,
  );
  await consistent(sku);
  checks.push('original batch provenance through transfers and two positions');
});
test('count gains do not replenish original reversal quota; late cap checks prevent overdraft', async () => {
  const { sku, p } = await fresh();
  const c = await ok<{ id: string; lines: Array<{ positionId: string }> }>(path('stock-counts'), {
    skuId: sku,
    version: (await balance(sku)).version,
    reason: '合成盘盈',
  });
  await ok(path(`stock-counts/${c.id}/submit`), {
    version: 0,
    lines: c.lines.map((l) => ({ positionId: l.positionId, counted: 20 })),
  });
  await ok(path(`stock-counts/${c.id}/approve`), { version: 1, reason: '独立复核合成盘盈' }, 1);
  await ok(path(`stock-counts/${c.id}/post`), { version: 2 });
  const current = { ...p, ...(await position(p.id)) };
  await post(await approve(await draft(current, 8)));
  const latest = { ...p, ...(await position(p.id)) };
  assert.equal((await balance(sku)).onHand, 12);
  assert.equal(
    (
      await call(path('receipt-reversals'), {
        positionId: p.id,
        positionVersion: latest.version,
        quantity: 3,
        reason: '不能冲回盘盈',
      })
    ).error?.code,
    'REVERSAL_LIMIT',
  );
  await post(await approve(await draft(latest, 2)));
  assert.equal((await balance(sku)).onHand, 10);
  assert.equal(
    (await ok<ReceiptReversalSource>(path(`receipt-reversal-sources/${p.id}`))).remaining,
    0,
  );
  await consistent(sku);
  checks.push('original cap independent of count gain');
});
test('reserved/blocked/owned isolation remain untouched; stale snapshots reject', async () => {
  const { sku, p } = await fresh();
  await db.$transaction(async (tx) => {
    const updates = { reserved: { increment: 3 } };
    await tx.stockBalance.update({
      where: { warehouseId_skuId: { warehouseId, skuId: sku } },
      data: updates,
    });
    await tx.stockLot.update({ where: { id: p.lotId }, data: updates });
    await tx.stockPosition.update({
      where: { id: p.id },
      data: { ...updates, version: { increment: 1 } },
    });
    const id = randomUUID();
    await tx.stockLedger.create({
      data: {
        id,
        warehouseId,
        skuId: sku,
        lotId: p.lotId,
        actionKey: `FIXTURE:${id}`,
        deltaOnHand: 0,
        deltaReserved: 3,
        actorId: actors[0]!,
        requestId: randomUUID(),
      },
    });
    await tx.positionLedger.create({
      data: {
        id: randomUUID(),
        warehouseId,
        skuId: sku,
        lotId: p.lotId,
        positionId: p.id,
        stockLedgerId: id,
        deltaOnHand: 0,
        deltaReserved: 3,
        deltaBlocked: 0,
      },
    });
  });
  const i = await ok<{ id: string }>(path('stock-isolations'), {
    positionId: p.id,
    quantity: 2,
    version: 1,
    reason: '合成保护库存',
  });
  assert.equal(
    (
      await call(path('receipt-reversals'), {
        positionId: p.id,
        quantity: 6,
        positionVersion: 2,
        reason: '不可扣保护数',
      })
    ).error?.code,
    'INSUFFICIENT_STOCK',
  );
  const d = await draft({ ...p, ...(await position(p.id)) }, 5);
  await post(await approve(d));
  const b = await balance(sku);
  assert.equal(b.onHand, 5);
  assert.equal(b.reserved, 3);
  assert.equal(b.blocked, 2);
  assert.equal((await db.stockIsolation.findUniqueOrThrow({ where: { id: i.id } })).remaining, 2);
  const next = await fresh();
  const old = await draft(next.p);
  await db.stockPosition.update({ where: { id: next.p.id }, data: { version: { increment: 1 } } });
  assert.equal(
    (
      await call(
        path(`receipt-reversals/${old.id}/approve`),
        { version: 0, reason: '旧位置快照' },
        1,
      )
    ).error?.code,
    'VERSION_CONFLICT',
  );
  await consistent(sku);
  checks.push('reserved/blocked/isolation protection and stale position');
});
test('count freeze, reconciliation hold and ledger mismatch reject; frozen cancellation does not release holds', async () => {
  const { sku, p } = await fresh();
  const a = await approve(await draft(p));
  const c = await ok<{ id: string }>(path('stock-counts'), {
    skuId: sku,
    version: (await balance(sku)).version,
    reason: '合成冻结',
  });
  assert.equal(
    (
      await call(path(`receipt-reversals/${a.id}/post`), {
        version: 1,
        physicalConfirmed: true,
        physicalEvidence: '冻结期间拒绝',
      })
    ).error?.code,
    'COUNT_FROZEN',
  );
  assert.equal(
    (
      await call(path('receipt-reversals'), {
        positionId: p.id,
        quantity: 1,
        positionVersion: 0,
        reason: '冻结申请',
      })
    ).error?.code,
    'COUNT_FROZEN',
  );
  await ok(path(`receipt-reversals/${a.id}/cancel`), { version: 1, reason: '冻结仍可取消' });
  assert.equal((await balance(sku)).activeCountId, c.id);
  await ok(path(`stock-counts/${c.id}/cancel`), { version: 0, reason: '结束合成盘点' });
  await db.stockBalance.update({
    where: { warehouseId_skuId: { warehouseId, skuId: sku } },
    data: { inventoryHold: true },
  });
  assert.equal(
    (
      await call(path('receipt-reversals'), {
        positionId: p.id,
        quantity: 1,
        positionVersion: 0,
        reason: '暂停申请',
      })
    ).error?.code,
    'INVENTORY_HOLD',
  );
  const next = await fresh();
  await db.stockBalance.update({
    where: { warehouseId_skuId: { warehouseId, skuId: next.sku } },
    data: { onHand: { increment: 1 } },
  });
  assert.equal(
    (
      await call(path('receipt-reversals'), {
        positionId: next.p.id,
        quantity: 1,
        positionVersion: 0,
        reason: '拒绝掩盖不平账',
      })
    ).error?.code,
    'INVENTORY_MISMATCH',
  );
  checks.push('freeze/hold/mismatch protection and independent cancellation');
});
test('late audit failure atomically rolls back reversal and original key retries', async () => {
  const { sku, p } = await fresh();
  const a = await approve(await draft(p));
  const key = randomUUID();
  await admin.query(
    "CREATE FUNCTION reversal_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='REVERSAL_POST' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reversal_test_fail BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION reversal_test_fail()",
  );
  const body = { version: 1, physicalConfirmed: true, physicalEvidence: '合成原单核验' };
  try {
    assert.equal((await call(path(`receipt-reversals/${a.id}/post`), body, 0, key)).status, 500);
    assert.equal((await balance(sku)).onHand, 10);
    assert.equal((await position(p.id)).onHand, 10);
    assert.equal(
      (await db.receiptReversal.findUniqueOrThrow({ where: { id: a.id } })).status,
      'APPROVED',
    );
    assert.equal(
      await db.stockLedger.count({ where: { actionKey: `RECEIPT_REVERSE:${a.id}` } }),
      0,
    );
    assert.equal(
      (await ok<ReceiptReversalSource>(path(`receipt-reversal-sources/${p.id}`))).remaining,
      10,
    );
  } finally {
    await admin.query(
      'DROP TRIGGER reversal_test_fail ON business_audits; DROP FUNCTION reversal_test_fail()',
    );
  }
  await ok(path(`receipt-reversals/${a.id}/post`), body, 0, key);
  await consistent(sku);
  checks.push('late audit rollback and stable retry intent');
});
test('database preserves source/documents and requires real posted ledger facts', async () => {
  const { sku, p, receiptId } = await fresh();
  const d = await draft(p);
  const line = (
    await db.inboundReceipt.findUniqueOrThrow({
      where: { id: receiptId },
      include: { lines: true },
    })
  ).lines[0]!;
  await assert.rejects(
    db.inboundReceipt.update({ where: { id: receiptId }, data: { sourceRef: '改原单' } }),
  );
  await assert.rejects(db.inboundLine.update({ where: { id: line.id }, data: { quantity: 20 } }));
  await assert.rejects(db.inboundLine.create({ data: { ...line, id: randomUUID() } }));
  await assert.rejects(db.receiptReversal.delete({ where: { id: d.id } }));
  await assert.rejects(db.receiptReversal.update({ where: { id: d.id }, data: { quantity: 3 } }));
  await assert.rejects(
    db.receiptReversal.update({
      where: { id: d.id },
      data: {
        status: 'APPROVED',
        version: 1,
        reviewedBy: actors[0]!,
        reviewedAt: new Date(),
        reviewReason: '自审',
      },
    }),
  );
  const a = await approve(d);
  await assert.rejects(
    db.receiptReversal.update({
      where: { id: a.id },
      data: {
        status: 'POSTED',
        version: 2,
        postedAt: new Date(),
        stockLedgerId: randomUUID(),
        physicalEvidence: '伪造流水',
      },
    }),
  );
  await post(a);
  await assert.rejects(
    db.receiptReversal.update({ where: { id: a.id }, data: { reason: '改终态' } }),
  );
  await consistent(sku);
  checks.push('source immutability, document transitions and posted fact constraints');
});
test('database refuses excessive posted quantity even when application is bypassed', async () => {
  const { p } = await fresh();
  const id = randomUUID();
  await db.receiptReversal.create({
    data: {
      id,
      warehouseId,
      skuId: p.skuId,
      lotId: p.lotId,
      positionId: p.id,
      positionVersion: 0,
      quantity: 11,
      reason: '仅合成DB保护验收',
      createdBy: actors[0]!,
    },
  });
  await db.receiptReversal.update({
    where: { id },
    data: {
      status: 'APPROVED',
      version: 1,
      reviewedBy: actors[1]!,
      reviewedAt: new Date(),
      reviewReason: '合成超额攻击',
    },
  });
  const original = await db.stockLedger.findFirstOrThrow({ where: { lotId: p.lotId } });
  await assert.rejects(
    db.receiptReversal.update({
      where: { id },
      data: {
        status: 'POSTED',
        version: 2,
        postedAt: new Date(),
        stockLedgerId: original.id,
        physicalEvidence: '伪造冲回',
      },
    }),
    /capacity exceeded/,
  );
  assert.equal((await db.receiptReversal.findUniqueOrThrow({ where: { id } })).status, 'APPROVED');
  await assert.rejects(db.stockLot.update({ where: { id: p.lotId }, data: { unitCostCents: 1n } }));
  checks.push('deferred original cap and lot provenance resist bypass');
});
test('expired lot may be corrected without restoring sellable qualification', async () => {
  const { sku, p } = await fresh();
  const a = await approve(await draft(p));
  await db.stockLot.update({
    where: { id: p.lotId },
    data: { producedAt: new Date(Date.now() - 86400000), expiresAt: new Date(Date.now() - 1000) },
  });
  await post(a);
  assert.equal((await balance(sku)).onHand, 8);
  assert.equal(await visible(sku), 0);
  await consistent(sku);
  checks.push('expiry remains excluded after correction');
});
test('scope/role/CSRF/validation/pagination and public privacy remain enforced', async () => {
  const { sku, p } = await fresh();
  const d = await draft(p);
  for (const actor of [2, 3])
    assert.equal(
      (
        await call(
          path('receipt-reversals'),
          { positionId: p.id, quantity: 1, positionVersion: 0, reason: '越权' },
          actor,
        )
      ).status,
      403,
    );
  assert.equal((await call(path(`receipt-reversals/${d.id}`), undefined, 2)).status, 200);
  assert.equal((await call(path(`receipt-reversals/${d.id}`), undefined, 3)).status, 403);
  assert.equal(
    (await call(`/warehouse/warehouses/${otherWarehouse}/receipt-reversals/${d.id}`)).status,
    403,
  );
  assert.equal((await call(path(`receipt-reversals/${d.id}`), undefined, null)).status, 401);
  const csrf = await fetch(base + '/api/v1' + path('receipt-reversals'), {
    method: 'POST',
    headers: {
      Cookie: identities[0]!.cookie,
      Origin: 'http://127.0.0.1:5173',
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({ positionId: p.id, quantity: 1, positionVersion: 0, reason: '无CSRF' }),
  });
  assert.equal(csrf.status, 403);
  for (const quantity of [0, -1, 1.5, 100001])
    assert.equal(
      (
        await call(path('receipt-reversals'), {
          positionId: p.id,
          quantity,
          positionVersion: 0,
          reason: '错误数量',
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await call(path('receipt-reversals'), {
        positionId: p.id,
        quantity: 1,
        positionVersion: 0,
        reason: '拒绝额外字段',
        warehouseId: otherWarehouse,
      })
    ).status,
    400,
  );
  const first = await ok<Page<ReceiptReversal>>(path('receipt-reversals?limit=1'));
  assert.equal(first.items.length, 1);
  assert.equal(first.hasMore, true);
  const next = await ok<Page<ReceiptReversal>>(
    path(`receipt-reversals?limit=1&cursor=${first.nextCursor}`),
  );
  assert.notEqual(first.items[0]!.id, next.items[0]!.id);
  assert.doesNotMatch(
    JSON.stringify(await call(`/products/${sku}`, undefined, null)),
    /physicalEvidence|unitCost|stockLedgerId|createdBy/,
  );
  assert.doesNotMatch(
    JSON.stringify(await ok(path(`receipt-reversal-sources/${p.id}`))),
    /unitCost|password/,
  );
  checks.push('authorization, CSRF, strict input, paging and public privacy');
});
