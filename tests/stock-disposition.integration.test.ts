import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { createDatabase, hashPassword } from '../packages/database/src/index.ts';
import { createApplication } from '../apps/api/dist/app.js';
import { applicationConfig } from '../apps/api/dist/config.js';
import type {
  StockIsolation,
  StockDisposition,
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
const schema = 'disposition_' + randomUUID().replaceAll('-', '');
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
  assert.match(schema, /^disposition_[a-f0-9]{32}$/);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query("SELECT set_config('search_path',$1,false)", [schema]);
  const dir = 'packages/database/prisma/migrations';
  for (const n of (await readdir(dir)).filter((n) => /^\d/.test(n)).sort())
    await admin.query(await readFile(`${dir}/${n}/migration.sql`, 'utf8'));
  await db.warehouse.createMany({
    data: [
      { id: warehouseId, code: 'DISPOSITION', name: '处置测试仓' },
      { id: otherWarehouse, code: 'OTHER', name: '未授权仓' },
    ],
  });
  const passwordHash = await hashPassword(password);
  for (const [i, id] of actors.entries())
    await db.staff.create({
      data: {
        id,
        loginName: `disposition.${i}`,
        displayName: `处置验收${i}`,
        passwordHash,
        roles: {
          create: { roleCode: ['SUPER_ADMIN', 'WAREHOUSE_MANAGER', 'PICKER', 'RIDER'][i]! },
        },
        warehouses: { create: { warehouseId } },
      },
    });
  categoryId = (await db.category.create({ data: { id: randomUUID(), name: '处置测试' } })).id;
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
      body: JSON.stringify({ loginName: `disposition.${i}`, password }),
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
    assert.match(schema, /^disposition_[a-f0-9]{32}$/);
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await mkdir('.local', { recursive: true });
    await writeFile(
      '.local/disposition-results.json',
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
    sourceRef: '处置测试合成入库',
    lines: [{ skuId, batchNo: 'DISPOSITION', quantity, unitCostCents: 200 }],
  });
}
async function fresh(quantity = 10) {
  const product = await ok<Product>('/admin/products', {
    categoryId,
    name: `处置商品${++serial}`,
    skus: [
      {
        code: `DISPOSITION-${serial}`,
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
  return { sku, p };
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

async function isolate(p: StockPosition, quantity = 4, key?: string) {
  return ok<StockIsolation>(
    path('stock-isolations'),
    { positionId: p.id, quantity, version: p.version, reason: '合成破包装隔离' },
    0,
    key,
  );
}
async function currentPosition(id: string) {
  return db.stockPosition.findUniqueOrThrow({ where: { id } });
}
async function draft(i: StockIsolation, kind: 'RELEASE' | 'DAMAGE' = 'DAMAGE', quantity = 1) {
  return ok<StockDisposition>(path('stock-dispositions'), {
    isolationId: i.id,
    kind,
    quantity,
    positionVersion: (await currentPosition(i.positionId)).version,
    isolationVersion: i.version,
    reason: '合成处置申请',
  });
}
async function approve(d: StockDisposition) {
  return ok<StockDisposition>(
    path(`stock-dispositions/${d.id}/approve`),
    { version: d.version, reason: '独立核验通过' },
    1,
  );
}
async function post(d: StockDisposition, key?: string) {
  return ok<StockDisposition>(
    path(`stock-dispositions/${d.id}/post`),
    {
      version: d.version,
      ...(d.kind === 'DAMAGE'
        ? { physicalConfirmed: true, physicalEvidence: '仅合成数据：实物处理记录' }
        : {}),
    },
    0,
    key,
  );
}

test('isolate blocks sale; release/damage update both ledgers and reconcile', async () => {
  const { sku, p } = await fresh();
  const i = await isolate(p);
  assert.equal(await visible(sku), 6);
  assert.equal((await balance(sku)).onHand, 10);
  assert.equal((await balance(sku)).blocked, 4);
  await post(await approve(await draft(i, 'RELEASE', 1)));
  assert.equal(await visible(sku), 7);
  const updated = await ok<StockIsolation>(path(`stock-isolations/${i.id}`));
  assert.equal(updated.remaining, 3);
  await post(await approve(await draft(updated, 'DAMAGE', 2)));
  const b = await balance(sku);
  assert.equal(b.onHand, 8);
  assert.equal(b.blocked, 1);
  assert.equal(await visible(sku), 7);
  assert.equal((await db.stockLot.findUniqueOrThrow({ where: { id: p.lotId } })).onHand, 8);
  const entries = await ok<Page<{ reason: string; deltaBlocked: number }>>(
    path(`positions/${p.id}/ledger`),
  );
  assert.ok(entries.items.some((e) => e.reason === '合成破包装隔离'));
  assert.equal(
    entries.items.reduce((n, e) => n + e.deltaBlocked, 0),
    1,
  );
  await consistent(sku);
  checks.push('isolate/release/damage, availability, both ledgers');
});
test('independent review, physical confirmation and terminal transitions', async () => {
  const { p } = await fresh();
  const d = await draft(await isolate(p));
  assert.equal(
    (await call(path(`stock-dispositions/${d.id}/approve`), { version: 0, reason: '自审' })).status,
    403,
  );
  assert.equal(
    (
      await call(path(`stock-dispositions/${d.id}/post`), {
        version: 0,
        physicalConfirmed: true,
        physicalEvidence: '测试',
      })
    ).status,
    409,
  );
  const a = await approve(d);
  for (const body of [
    { version: 1 },
    { version: 1, physicalConfirmed: false, physicalEvidence: '未核验' },
    { version: 1, physicalConfirmed: true },
  ])
    assert.equal((await call(path(`stock-dispositions/${d.id}/post`), body)).status, 400);
  await post(a);
  assert.equal(
    (await call(path(`stock-dispositions/${d.id}/cancel`), { version: 2, reason: '不能撤销' }))
      .status,
    409,
  );
  checks.push('independent reviewer, physical evidence, terminal protection');
});
test('overlapping drafts and cancellations do not restore sale or reserve quota', async () => {
  const { sku, p } = await fresh();
  const i = await isolate(p, 2);
  const d = await draft(i, 'RELEASE', 2),
    a = await approve(await draft(i, 'DAMAGE', 2));
  await ok(path(`stock-dispositions/${d.id}/cancel`), { version: 0, reason: '撤销申请' });
  assert.equal(await visible(sku), 8);
  assert.equal((await balance(sku)).blocked, 2);
  await ok(path(`stock-dispositions/${a.id}/cancel`), { version: 1, reason: '撤销已审申请' });
  assert.equal((await db.stockIsolation.findUniqueOrThrow({ where: { id: i.id } })).remaining, 2);
  checks.push('draft/cancel leave isolation intact');
});
test('20 isolate retries and 8 independent last-unit races', async () => {
  const { sku, p } = await fresh(1);
  const body = { positionId: p.id, quantity: 1, version: p.version, reason: '最后一件隔离' },
    key = randomUUID();
  const same = await Promise.all(
    Array.from({ length: 20 }, () => call<StockIsolation>(path('stock-isolations'), body, 0, key)),
  );
  assert.ok(same.every((r) => r.status === 200));
  assert.equal(new Set(same.map((r) => r.data.id)).size, 1);
  assert.equal(
    (await call(path('stock-isolations'), { ...body, reason: '更改意图' }, 0, key)).error?.code,
    'IDEMPOTENCY_CONFLICT',
  );
  assert.equal((await balance(sku)).blocked, 1);
  const next = await fresh(1);
  const input = { ...body, positionId: next.p.id };
  const results = await Promise.all(
    Array.from({ length: 8 }, () => call(path('stock-isolations'), input)),
  );
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal((await balance(next.sku)).blocked, 1);
  await consistent(next.sku);
  checks.push('same-key retries and distinct-key last-unit race');
});
test('approved documents cannot consume same remaining stock; post retries write one ledger', async () => {
  const { sku, p } = await fresh(1),
    i = await isolate(p, 1);
  const docs = [await approve(await draft(i)), await approve(await draft(i))];
  const results = await Promise.all(
    docs.map((d) =>
      call<StockDisposition>(path(`stock-dispositions/${d.id}/post`), {
        version: 1,
        physicalConfirmed: true,
        physicalEvidence: '并发合成核验',
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal((await balance(sku)).onHand, 0);
  assert.equal((await db.stockIsolation.findUniqueOrThrow({ where: { id: i.id } })).remaining, 0);
  const next = await fresh();
  const a = await approve(await draft(await isolate(next.p))),
    key = randomUUID();
  await Promise.all(Array.from({ length: 20 }, () => post(a, key)));
  assert.equal((await balance(next.sku)).onHand, 9);
  assert.equal(await db.stockLedger.count({ where: { actionKey: `DISPOSITION:${a.id}` } }), 1);
  await consistent(sku);
  await consistent(next.sku);
  checks.push('last remainder race and 20 post retries');
});
test('expiry and disabled location checked again at posting; damage remains possible', async () => {
  const { sku, p } = await fresh();
  const i = await isolate(p);
  const a = await approve(await draft(i, 'RELEASE'));
  await db.stockLot.update({
    where: { id: p.lotId },
    data: { producedAt: new Date(Date.now() - 86400000), expiresAt: new Date(Date.now() - 10000) },
  });
  assert.equal(
    (await call(path(`stock-dispositions/${a.id}/post`), { version: 1 })).error?.code,
    'EXPIRED_STOCK',
  );
  assert.equal(await visible(sku), 0);
  await post(await approve(await draft(i)));
  await consistent(sku);
  const next = await fresh();
  const iso = await isolate(next.p);
  const release = await approve(await draft(iso, 'RELEASE'));
  await db.warehouseLocation.update({
    where: { id: next.p.locationId },
    data: { enabled: false, version: { increment: 1 } },
  });
  try {
    assert.equal(
      (await call(path(`stock-dispositions/${release.id}/post`), { version: 1 })).error?.code,
      'LOCATION_UNAVAILABLE',
    );
    await post(await approve(await draft(iso)));
    await consistent(next.sku);
  } finally {
    await db.warehouseLocation.update({
      where: { id: next.p.locationId },
      data: { enabled: true, version: { increment: 1 } },
    });
  }
  checks.push('late expiry/location check, damage still allowed');
});
test('freeze/hold protect mutations, cancel allowed; stale snapshot rejected', async () => {
  const { sku, p } = await fresh();
  const i = await isolate(p),
    d = await draft(i);
  const c = await ok<{ id: string }>(path('stock-counts'), {
    skuId: sku,
    version: (await balance(sku)).version,
    reason: '冻结合成测试',
  });
  assert.equal(
    (
      await call(
        path(`stock-dispositions/${d.id}/approve`),
        { version: 0, reason: '冻结时审批' },
        1,
      )
    ).error?.code,
    'COUNT_FROZEN',
  );
  assert.equal(
    (
      await call(path('stock-isolations'), {
        positionId: p.id,
        version: 1,
        quantity: 1,
        reason: '冻结时隔离',
      })
    ).error?.code,
    'COUNT_FROZEN',
  );
  await ok(path(`stock-dispositions/${d.id}/cancel`), { version: 0, reason: '冻结时仍可取消申请' });
  await ok(path(`stock-counts/${c.id}/cancel`), { version: 0, reason: '完成冻结测试' });
  const stale = await draft(i);
  await isolate({ ...p, ...(await currentPosition(p.id)) }, 1);
  assert.equal(
    (
      await call(
        path(`stock-dispositions/${stale.id}/approve`),
        { version: 0, reason: '旧快照' },
        1,
      )
    ).error?.code,
    'VERSION_CONFLICT',
  );
  await db.stockBalance.update({
    where: { warehouseId_skuId: { warehouseId, skuId: sku } },
    data: { inventoryHold: true },
  });
  assert.equal(
    (
      await call(path('stock-isolations'), {
        positionId: p.id,
        version: 2,
        quantity: 1,
        reason: '核对暂停',
      })
    ).error?.code,
    'INVENTORY_HOLD',
  );
  checks.push('freeze/hold, cancel and stale snapshot');
});
test('late audit failure rolls back quantities, ledger, document and retry intent', async () => {
  const { sku, p } = await fresh();
  const i = await isolate(p);
  const a = await approve(await draft(i));
  const key = randomUUID();
  await admin.query(
    "CREATE FUNCTION disposition_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='DISPOSITION_POST' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER disposition_test_fail BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION disposition_test_fail()",
  );
  const body = { version: 1, physicalConfirmed: true, physicalEvidence: '合成核验' };
  try {
    assert.equal((await call(path(`stock-dispositions/${a.id}/post`), body, 0, key)).status, 500);
    assert.equal((await balance(sku)).onHand, 10);
    assert.equal((await balance(sku)).blocked, 4);
    assert.equal((await db.stockIsolation.findUniqueOrThrow({ where: { id: i.id } })).remaining, 4);
    assert.equal(
      (await db.stockDisposition.findUniqueOrThrow({ where: { id: a.id } })).status,
      'APPROVED',
    );
    assert.equal(await db.stockLedger.count({ where: { actionKey: `DISPOSITION:${a.id}` } }), 0);
  } finally {
    await admin.query(
      'DROP TRIGGER disposition_test_fail ON business_audits; DROP FUNCTION disposition_test_fail()',
    );
  }
  await ok(path(`stock-dispositions/${a.id}/post`), body, 0, key);
  await consistent(sku);
  checks.push('late audit failure atomic rollback and retry');
});
test('DB protects immutable facts, quota consumption and owned blocked stock', async () => {
  const { sku, p } = await fresh();
  const i = await isolate(p),
    d = await draft(i);
  await assert.rejects(
    db.stockIsolation.update({ where: { id: i.id }, data: { reason: '改历史' } }),
  );
  await assert.rejects(
    db.stockIsolation.update({ where: { id: i.id }, data: { remaining: 3, version: 1 } }),
  );
  await assert.rejects(db.stockIsolation.delete({ where: { id: i.id } }));
  await assert.rejects(db.stockDisposition.update({ where: { id: d.id }, data: { quantity: 2 } }));
  await assert.rejects(
    db.stockDisposition.update({
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
  await assert.rejects(db.stockDisposition.delete({ where: { id: d.id } }));
  await assert.rejects(db.stockPosition.update({ where: { id: p.id }, data: { blocked: 0 } }));
  await consistent(sku);
  checks.push('DB immutability, deferred quota/position constraints');
});
test('reserved and legacy blocked stock stay protected; ledger mismatches reject mutations', async () => {
  const { sku, p } = await fresh();
  // Synthetic protected quantities and matching immutable facts, only in this disposable schema.
  await db.$transaction(async (tx) => {
    const changes = { reserved: { increment: 3 }, blocked: { increment: 2 } };
    await tx.stockBalance.update({
      where: { warehouseId_skuId: { warehouseId, skuId: sku } },
      data: changes,
    });
    await tx.stockLot.update({ where: { id: p.lotId }, data: changes });
    await tx.stockPosition.update({
      where: { id: p.id },
      data: { ...changes, version: { increment: 1 } },
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
        deltaBlocked: 2,
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
        deltaBlocked: 2,
      },
    });
  });
  const current = { ...p, ...(await currentPosition(p.id)) };
  assert.equal(
    (
      await call(path('stock-isolations'), {
        positionId: p.id,
        version: current.version,
        quantity: 6,
        reason: '不可触碰预占',
      })
    ).error?.code,
    'INSUFFICIENT_STOCK',
  );
  const i = await isolate(current, 5);
  assert.equal(
    (
      await call(path('stock-dispositions'), {
        isolationId: i.id,
        kind: 'DAMAGE',
        quantity: 6,
        positionVersion: 2,
        isolationVersion: 0,
        reason: '不能消费旧不可售',
      })
    ).error?.code,
    'ISOLATION_EXHAUSTED',
  );
  await post(await approve(await draft(i, 'DAMAGE', 5)));
  const b = await balance(sku);
  assert.equal(b.onHand, 5);
  assert.equal(b.reserved, 3);
  assert.equal(b.blocked, 2);
  await consistent(sku);
  // Deliberately corrupt only this schema cache to verify API does not use disposition as repair.
  await db.stockBalance.update({
    where: { warehouseId_skuId: { warehouseId, skuId: sku } },
    data: { onHand: { increment: 1 } },
  });
  assert.equal(
    (
      await call(path('stock-isolations'), {
        positionId: p.id,
        version: 3,
        quantity: 1,
        reason: '拒绝不平账写入',
      })
    ).error?.code,
    'INVENTORY_MISMATCH',
  );
  checks.push('reserved/legacy blocked protection, owned quota and mismatch rejection');
});
test('scope/role/CSRF, integer validation, paging and public privacy', async () => {
  const { sku, p } = await fresh();
  const i = await isolate(p),
    d = await draft(i);
  for (const actor of [2, 3])
    assert.equal(
      (
        await call(
          path('stock-isolations'),
          { positionId: p.id, quantity: 1, version: 1, reason: '越权' },
          actor,
        )
      ).status,
      403,
    );
  assert.equal((await call(path(`stock-isolations/${i.id}`), undefined, 2)).status, 200);
  assert.equal((await call(path(`stock-isolations/${i.id}`), undefined, 3)).status, 403);
  assert.equal(
    (await call(`/warehouse/warehouses/${otherWarehouse}/stock-dispositions/${d.id}`)).status,
    403,
  );
  assert.equal((await call(path(`stock-isolations/${i.id}`), undefined, null)).status, 401);
  const csrf = await fetch(base + '/api/v1' + path('stock-isolations'), {
    method: 'POST',
    headers: {
      Cookie: identities[0]!.cookie,
      Origin: 'http://127.0.0.1:5173',
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({ positionId: p.id, quantity: 1, version: 1, reason: '缺csrf' }),
  });
  assert.equal(csrf.status, 403);
  for (const quantity of [0, -1, 1.5, 100001])
    assert.equal(
      (
        await call(path('stock-isolations'), {
          positionId: p.id,
          quantity,
          version: 1,
          reason: '无效数量',
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await call(path('stock-isolations'), {
        positionId: p.id,
        quantity: 1,
        version: 1,
        reason: '拒绝多余字段',
        status: 'POSTED',
      })
    ).status,
    400,
  );
  const first = await ok<Page<StockIsolation>>(path('stock-isolations?limit=1'));
  assert.equal(first.items.length, 1);
  assert.equal(first.hasMore, true);
  const next = await ok<Page<StockIsolation>>(
    path(`stock-isolations?limit=1&cursor=${first.nextCursor}`),
  );
  assert.notEqual(first.items[0]!.id, next.items[0]!.id);
  const publicRow = await call<SaleSku>(`/products/${sku}`, undefined, null);
  assert.equal(publicRow.data.available, 6);
  assert.doesNotMatch(
    JSON.stringify(publicRow),
    /physicalEvidence|unitCost|isolationId|createdBy|stockLedgerId/,
  );
  checks.push('server authorization, CSRF, validation, pagination and privacy');
});
