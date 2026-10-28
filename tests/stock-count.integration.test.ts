import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { createDatabase, hashPassword } from '../packages/database/src/index.ts';
import { createApplication } from '../apps/api/dist/app.js';
import { applicationConfig } from '../apps/api/dist/config.js';
import type {
  StockCount,
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
const schema = 'count_' + randomUUID().replaceAll('-', '');
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
  assert.match(schema, /^count_[a-f0-9]{32}$/);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query("SELECT set_config('search_path',$1,false)", [schema]);
  const dir = 'packages/database/prisma/migrations';
  for (const n of (await readdir(dir)).filter((n) => /^\d/.test(n)).sort())
    await admin.query(await readFile(`${dir}/${n}/migration.sql`, 'utf8'));
  await db.warehouse.createMany({
    data: [
      { id: warehouseId, code: 'COUNT', name: '盘点测试仓' },
      { id: otherWarehouse, code: 'OTHER', name: '未授权仓' },
    ],
  });
  const passwordHash = await hashPassword(password);
  for (const [i, id] of actors.entries())
    await db.staff.create({
      data: {
        id,
        loginName: `count.${i}`,
        displayName: `盘点验收${i}`,
        passwordHash,
        roles: {
          create: { roleCode: ['SUPER_ADMIN', 'WAREHOUSE_MANAGER', 'PICKER', 'RIDER'][i]! },
        },
        warehouses: { create: { warehouseId } },
      },
    });
  categoryId = (await db.category.create({ data: { id: randomUUID(), name: '盘点测试' } })).id;
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
      body: JSON.stringify({ loginName: `count.${i}`, password }),
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
    assert.match(schema, /^count_[a-f0-9]{32}$/);
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await mkdir('.local', { recursive: true });
    await writeFile(
      '.local/count-results.json',
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
    sourceRef: '盘点测试合成入库',
    lines: [{ skuId, batchNo: 'COUNT', quantity, unitCostCents: 200 }],
  });
}
async function fresh(quantity = 10) {
  const product = await ok<Product>('/admin/products', {
    categoryId,
    name: `盘点商品${++serial}`,
    skus: [
      { code: `COUNT-${serial}`, spec: '1包', unit: '包', priceCents: 450, expiryManaged: false },
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
async function start(sku: string, key?: string) {
  return ok<StockCount>(
    path('stock-counts'),
    { skuId: sku, version: (await balance(sku)).version, reason: '月度实物盘点' },
    0,
    key,
  );
}
async function advance(c: StockCount, values?: number[]) {
  const submitted = await ok<StockCount>(path(`stock-counts/${c.id}/submit`), {
    version: c.version,
    lines: c.lines.map((l, i) => ({
      positionId: l.positionId,
      counted: values?.[i] ?? l.snapshotOnHand,
    })),
  });
  return ok<StockCount>(
    path(`stock-counts/${c.id}/approve`),
    { version: submitted.version, reason: '已复核实物差异' },
    1,
  );
}
async function visible(sku: string) {
  return (await call<SaleSku>(`/products/${sku}`, undefined, null)).data.available;
}
async function consistent(sku: string) {
  const r = await ok<{ issueCount: number }>(path('inventory-checks'), { skuId: sku });
  assert.equal(r.issueCount, 0);
}

test('freeze snapshots all positions, suppresses sale and rejects receipt/move; cancel releases without quantity change', async () => {
  const { sku, p } = await fresh();
  const c = await start(sku);
  assert.equal(c.lines[0]!.snapshotOnHand, 10);
  assert.equal(await visible(sku), 0);
  assert.equal((await balance(sku)).activeCountId, c.id);
  const loc = await ok<{ id: string }>(path('locations'), {
    code: `COUNT-${++serial}`,
    name: '盘点货架',
  });
  assert.equal(
    (
      await call(path('stock-transfers'), {
        sourcePositionId: p.id,
        targetLocationId: loc.id,
        quantity: 1,
        version: p.version,
        reason: '冻结期间测试',
      })
    ).error?.code,
    'COUNT_FROZEN',
  );
  const d = await receipt(sku);
  await ok(path(`receipts/${d.id}/approve`), { version: 0 });
  assert.equal((await call(path(`receipts/${d.id}/post`), { version: 1 })).status, 409);
  const cancelled = await ok<StockCount>(path(`stock-counts/${c.id}/cancel`), {
    version: 0,
    reason: '实物尚未准备，终止本次',
  });
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(await visible(sku), 10);
  assert.equal((await balance(sku)).onHand, 10);
  assert.equal((await balance(sku)).activeCountId, null);
  await consistent(sku);
  checks.push('freeze/cancel, public zero, receipt/move rejection');
});
test('last freeze contention and stable idempotency create exactly one document', async () => {
  const { sku } = await fresh();
  const body = { skuId: sku, version: (await balance(sku)).version, reason: '并发冻结' };
  const key = randomUUID();
  const same = await Promise.all(
    Array.from({ length: 20 }, () => call<StockCount>(path('stock-counts'), body, 0, key)),
  );
  assert.ok(same.every((r) => r.status === 200));
  assert.equal(new Set(same.map((r) => r.data.id)).size, 1);
  assert.equal(
    (await call(path('stock-counts'), { ...body, reason: '不同内容' }, 0, key)).error?.code,
    'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(
    (await call(path('stock-counts'), { ...body, version: (await balance(sku)).version })).error
      ?.code,
    'COUNT_FROZEN',
  );
  const another = await fresh();
  const input = {
    skuId: another.sku,
    version: (await balance(another.sku)).version,
    reason: '不同键争抢',
  };
  const results = await Promise.all(
    Array.from({ length: 8 }, () => call(path('stock-counts'), input)),
  );
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(await db.stockCount.count({ where: { warehouseId, skuId: another.sku } }), 1);
  checks.push('20 repeated intents and independent freeze contention');
});
test('submission rejects missing, duplicate, foreign, negative, fractional lines and stale versions', async () => {
  const { sku } = await fresh();
  const c = await start(sku);
  const p = c.lines[0]!.positionId;
  const endpoint = path(`stock-counts/${c.id}/submit`);
  assert.equal(
    (await call(endpoint, { version: 0, lines: [{ positionId: p, counted: 9 }] }, 1)).error?.code,
    'COUNT_OWNER_REQUIRED',
  );
  for (const lines of [
    [],
    [{ positionId: p, counted: -1 }],
    [{ positionId: p, counted: 1.1 }],
    [{ positionId: randomUUID(), counted: 1 }],
    [
      { positionId: p, counted: 1 },
      { positionId: p, counted: 1 },
    ],
  ])
    assert.equal((await call(endpoint, { version: 0, lines })).status, 400);
  assert.equal(
    (await call(endpoint, { version: 1, lines: [{ positionId: p, counted: 9 }] })).error?.code,
    'VERSION_CONFLICT',
  );
  assert.equal(
    (await db.stockCountLine.findFirstOrThrow({ where: { countId: c.id } })).counted,
    null,
  );
  checks.push('complete input, strict integers, unique positions, stale versions');
});
test('independent review, state actions, loss posting retries once and immutable facts reconcile', async () => {
  const { sku } = await fresh();
  const c = await start(sku);
  const s = await ok<StockCount>(path(`stock-counts/${c.id}/submit`), {
    version: 0,
    lines: c.lines.map((l) => ({ positionId: l.positionId, counted: 7 })),
  });
  assert.equal(
    (await call(path(`stock-counts/${c.id}/approve`), { version: s.version, reason: '自审' })).error
      ?.code,
    'INDEPENDENT_REVIEW_REQUIRED',
  );
  assert.equal(
    (await call(path(`stock-counts/${c.id}/post`), { version: s.version })).error?.code,
    'INVALID_TRANSITION',
  );
  const a = await ok<StockCount>(
    path(`stock-counts/${c.id}/approve`),
    { version: s.version, reason: '另人复核3件盘亏' },
    1,
  );
  const key = randomUUID();
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      call<StockCount>(path(`stock-counts/${c.id}/post`), { version: a.version }, 0, key),
    ),
  );
  assert.ok(results.every((r) => r.status === 200));
  assert.equal((await balance(sku)).onHand, 7);
  assert.equal(await visible(sku), 7);
  assert.equal(
    await db.stockLedger.count({ where: { actionKey: { startsWith: `COUNT:${c.id}:` } } }),
    1,
  );
  await consistent(sku);
  await assert.rejects(
    db.stockCountLine.update({ where: { id: c.lines[0]!.id }, data: { counted: 8 } }),
  );
  await assert.rejects(db.stockCount.update({ where: { id: c.id }, data: { reason: '篡改' } }));
  await assert.rejects(db.stockCount.delete({ where: { id: c.id } }));
  checks.push('independent reviewer, 20 post retries, loss ledger, immutable terminal/snapshot');
});
test('gain and zero difference post correctly; different posting keys apply once', async () => {
  for (const n of [14, 10]) {
    const { sku } = await fresh();
    const c = await advance(await start(sku), [n]);
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        call(path(`stock-counts/${c.id}/post`), { version: c.version }),
      ),
    );
    assert.equal(responses.filter((r) => r.status === 200).length, 1);
    assert.equal((await balance(sku)).onHand, n);
    assert.equal(await visible(sku), n);
    assert.equal(
      await db.stockLedger.count({ where: { actionKey: { startsWith: `COUNT:${c.id}:` } } }),
      n === 10 ? 0 : 1,
    );
    await consistent(sku);
  }
  checks.push('gain, zero difference, concurrent different post keys');
});
test('multi-position offset difference produces two entries and preserves warehouse/lot total', async () => {
  const { sku, p } = await fresh();
  const loc = await ok<{ id: string }>(path('locations'), {
    code: `MULTI-${++serial}`,
    name: '多位置盘点',
  });
  await ok(path('stock-transfers'), {
    sourcePositionId: p.id,
    targetLocationId: loc.id,
    quantity: 4,
    version: p.version,
    reason: '分位',
  });
  const c = await start(sku);
  assert.equal(c.lines.length, 2);
  const values = c.lines.map((l, i) => l.snapshotOnHand + (i === 0 ? 1 : -1));
  const a = await advance(c, values);
  await ok(path(`stock-counts/${c.id}/post`), { version: a.version });
  assert.equal((await balance(sku)).onHand, 10);
  await consistent(sku);
  assert.equal(
    await db.stockLedger.count({ where: { actionKey: { startsWith: `COUNT:${c.id}:` } } }),
    2,
  );
  checks.push('offsetting multi-position differences preserve total and both ledgers');
});
test('late transaction failure rolls back quantity, ledger, document, hold and intent; same key recovers', async () => {
  const { sku } = await fresh();
  const c = await advance(await start(sku), [8]);
  await admin.query(
    "CREATE FUNCTION count_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='COUNT_POST' THEN RAISE EXCEPTION 'synthetic late audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER count_test_fail BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION count_test_fail()",
  );
  const key = randomUUID();
  const failed = await call(path(`stock-counts/${c.id}/post`), { version: c.version }, 0, key);
  assert.equal(failed.status, 500);
  assert.equal((await balance(sku)).onHand, 10);
  assert.equal((await balance(sku)).activeCountId, c.id);
  assert.equal((await db.stockCount.findUniqueOrThrow({ where: { id: c.id } })).status, 'APPROVED');
  assert.equal(
    await db.stockLedger.count({ where: { actionKey: { startsWith: `COUNT:${c.id}:` } } }),
    0,
  );
  await admin.query(
    'DROP TRIGGER count_test_fail ON business_audits; DROP FUNCTION count_test_fail()',
  );
  await ok(path(`stock-counts/${c.id}/post`), { version: c.version }, 0, key);
  assert.equal(await visible(sku), 8);
  await consistent(sku);
  checks.push('late audit failure rolls back all writes and intent, original key retries');
});
test('database freezes old writers and ties active hold to document; snapshots cannot be rewritten', async () => {
  const { sku, p } = await fresh();
  const c = await start(sku);
  await assert.rejects(
    db.$transaction(async (tx) => {
      await tx.stockCount.update({
        where: { id: c.id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          version: { increment: 1 },
          cancelReason: null,
        },
      });
      await tx.stockBalance.update({
        where: { warehouseId_skuId: { warehouseId, skuId: sku } },
        data: { activeCountId: null },
      });
    }),
  );
  await assert.rejects(db.stockPosition.update({ where: { id: p.id }, data: { onHand: 9 } }));
  await assert.rejects(db.stockLot.update({ where: { id: p.lotId }, data: { onHand: 9 } }));
  await assert.rejects(
    db.stockBalance.update({
      where: { warehouseId_skuId: { warehouseId, skuId: sku } },
      data: { onHand: 9 },
    }),
  );
  await assert.rejects(
    db.stockBalance.update({
      where: { warehouseId_skuId: { warehouseId, skuId: sku } },
      data: { activeCountId: null },
    }),
  );
  await assert.rejects(
    db.stockCountLine.update({ where: { id: c.lines[0]!.id }, data: { snapshotOnHand: 9 } }),
  );
  await assert.rejects(db.stockCountLine.delete({ where: { id: c.lines[0]!.id } }));
  assert.equal((await balance(sku)).activeCountId, c.id);
  await consistent(sku);
  checks.push('DB guard against old writers, detached freezes, changed snapshots');
});
test('reserved and blocked protection, snapshot conflict and reconciliation hold remain independent', async () => {
  const { sku, p } = await fresh();
  // Synthetic protection entries are confined to this disposable schema, through both ledgers.
  async function protect(reserved: number, blocked: number) {
    await db.$transaction(async (tx) => {
      await tx.stockBalance.update({
        where: { warehouseId_skuId: { warehouseId, skuId: sku } },
        data: { reserved: { increment: reserved }, blocked: { increment: blocked } },
      });
      await tx.stockLot.update({
        where: { id: p.lotId },
        data: { reserved: { increment: reserved }, blocked: { increment: blocked } },
      });
      await tx.stockPosition.update({
        where: { id: p.id },
        data: {
          reserved: { increment: reserved },
          blocked: { increment: blocked },
          version: { increment: 1 },
        },
      });
      const ledgerId = randomUUID();
      await tx.stockLedger.create({
        data: {
          id: ledgerId,
          warehouseId,
          skuId: sku,
          lotId: p.lotId,
          actionKey: `FIXTURE:${ledgerId}`,
          deltaOnHand: 0,
          deltaReserved: reserved,
          deltaBlocked: blocked,
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
          stockLedgerId: ledgerId,
          deltaOnHand: 0,
          deltaReserved: reserved,
          deltaBlocked: blocked,
        },
      });
    });
  }
  await protect(1, 0);
  assert.equal(
    (
      await call(path('stock-counts'), {
        skuId: sku,
        version: (await balance(sku)).version,
        reason: '有预占',
      })
    ).error?.code,
    'STOCK_RESERVED',
  );
  await protect(-1, 2);
  const c = await start(sku);
  assert.equal(
    (
      await call(path(`stock-counts/${c.id}/submit`), {
        version: 0,
        lines: [{ positionId: p.id, counted: 1 }],
      })
    ).error?.code,
    'PROTECTED_STOCK',
  );
  await db.stockPosition.update({ where: { id: p.id }, data: { version: { increment: 1 } } });
  assert.equal(
    (
      await call(path(`stock-counts/${c.id}/submit`), {
        version: 0,
        lines: [{ positionId: p.id, counted: 8 }],
      })
    ).error?.code,
    'COUNT_SNAPSHOT_CONFLICT',
  );
  await db.stockBalance.update({
    where: { warehouseId_skuId: { warehouseId, skuId: sku } },
    data: { inventoryHold: true },
  });
  await ok(path(`stock-counts/${c.id}/cancel`), {
    version: 0,
    reason: '快照版本改变，保留核对暂停排查',
  });
  assert.equal((await balance(sku)).inventoryHold, true);
  assert.equal(await visible(sku), 0);
  checks.push(
    'reserved rejection, blocked floor, stale position, cancel keeps reconciliation hold',
  );
});
test('scope/role/privacy and pagination remain server enforced', async () => {
  const { sku } = await fresh();
  const c = await start(sku);
  for (const actor of [2, 3])
    assert.equal(
      (await call(path(`stock-counts/${c.id}/cancel`), { version: 0, reason: '越权' }, actor))
        .status,
      403,
    );
  assert.equal(
    (await call(`/warehouse/warehouses/${otherWarehouse}/stock-counts/${c.id}`)).status,
    403,
  );
  assert.equal((await call(path(`stock-counts/${c.id}`), undefined, null)).status, 401);
  const read = await ok<StockCount>(path(`stock-counts/${c.id}`), undefined, 2);
  assert.equal(read.id, c.id);
  assert.ok(!JSON.stringify(read).includes('unitCost'));
  const first = await ok<Page<StockCount>>(path('stock-counts?limit=1'));
  assert.equal(first.items.length, 1);
  assert.ok(first.nextCursor);
  const second = await ok<Page<StockCount>>(
    path(`stock-counts?limit=1&cursor=${first.nextCursor}`),
  );
  assert.notEqual(second.items[0]!.id, first.items[0]!.id);
  const filtered = await ok<Page<StockCount>>(path(`stock-counts?skuId=${sku}`));
  assert.ok(filtered.items.every((r) => r.skuId === sku));
  checks.push('warehouse/role/anonymous denial, no costs, filtered cursor pagination');
});

test('receipt/freeze and cancel/post races have one consistent outcome with no stranded freeze', async () => {
  const { sku } = await fresh();
  const d = await receipt(sku, 2);
  await ok(path(`receipts/${d.id}/approve`), { version: 0 });
  const initial = await balance(sku);
  const results = await Promise.all([
    call<StockCount>(path('stock-counts'), {
      skuId: sku,
      version: initial.version,
      reason: '与入库竞争冻结',
    }),
    call(path(`receipts/${d.id}/post`), { version: 1 }),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  if (results[0]!.status === 200) {
    assert.equal((await balance(sku)).onHand, 10);
    await ok(path(`stock-counts/${results[0]!.data.id}/cancel`), {
      version: 0,
      reason: '结束冻结竞争测试',
    });
  } else assert.equal((await balance(sku)).onHand, 12);
  await consistent(sku);
  const c = await advance(await start(sku), [8]);
  const race = await Promise.all([
    call<StockCount>(path(`stock-counts/${c.id}/post`), { version: c.version }),
    call<StockCount>(path(`stock-counts/${c.id}/cancel`), {
      version: c.version,
      reason: '终止与过账竞争',
    }),
  ]);
  assert.equal(race.filter((r) => r.status === 200).length, 1);
  assert.equal((await balance(sku)).activeCountId, null);
  await consistent(sku);
  checks.push('receipt versus freeze, post versus cancel serialize on balance lock');
});

test('partial multi-position submission is atomic; approved cancellation keeps quantities; expired stock stays unsaleable', async () => {
  const { sku, p } = await fresh();
  const loc = await ok<{ id: string }>(path('locations'), {
    code: `PARTIAL-${++serial}`,
    name: '部分盘点测试',
  });
  await ok(path('stock-transfers'), {
    sourcePositionId: p.id,
    targetLocationId: loc.id,
    quantity: 4,
    version: p.version,
    reason: '分位',
  });
  const c = await start(sku);
  assert.equal(
    (
      await call(path(`stock-counts/${c.id}/submit`), {
        version: 0,
        lines: [{ positionId: c.lines[0]!.positionId, counted: 5 }],
      })
    ).status,
    400,
  );
  assert.ok(
    (await db.stockCountLine.findMany({ where: { countId: c.id } })).every(
      (l) => l.counted === null,
    ),
  );
  const a = await advance(
    c,
    c.lines.map((l) => l.snapshotOnHand + 1),
  );
  await ok(path(`stock-counts/${c.id}/cancel`), {
    version: a.version,
    reason: '审核后复盘，取消本单',
  });
  assert.equal((await balance(sku)).onHand, 10);
  // Existing non-expiry SKU may still have an aged batch; use disposable fixture metadata only.
  await db.stockLot.update({
    where: { id: p.lotId },
    data: {
      producedAt: new Date('2020-01-01T00:00:00Z'),
      expiresAt: new Date('2021-01-01T00:00:00Z'),
    },
  });
  const expired = await advance(await start(sku));
  await ok(path(`stock-counts/${expired.id}/post`), { version: expired.version });
  assert.equal(await visible(sku), 0);
  await consistent(sku);
  checks.push('partial results rollback, approved cancellation, expiry after count');
});

test('aggregate quantity and full-snapshot size limits reject rather than silently truncate', async () => {
  const { sku, p } = await fresh();
  const loc = await ok<{ id: string }>(path('locations'), {
    code: `LIMIT-${++serial}`,
    name: '限额测试',
  });
  await ok(path('stock-transfers'), {
    sourcePositionId: p.id,
    targetLocationId: loc.id,
    quantity: 4,
    version: p.version,
    reason: '分位测试',
  });
  const c = await start(sku);
  const a = await advance(c, [1000000000, 1000000000]);
  assert.equal(
    (await call(path(`stock-counts/${c.id}/post`), { version: a.version })).error?.code,
    'STOCK_LIMIT',
  );
  assert.equal((await balance(sku)).onHand, 10);
  assert.equal((await balance(sku)).activeCountId, c.id);
  await ok(path(`stock-counts/${c.id}/cancel`), { version: a.version, reason: '超限结果终止' });
  const locations = Array.from({ length: 199 }, () => ({
    id: randomUUID(),
    warehouseId,
    code: `ZERO-${++serial}`,
    name: '空位置盘点边界',
  }));
  await db.warehouseLocation.createMany({ data: locations });
  await db.stockPosition.createMany({
    data: locations.slice(0, 198).map((l) => ({
      id: randomUUID(),
      warehouseId,
      skuId: sku,
      lotId: p.lotId,
      locationId: l.id,
      onHand: 0,
    })),
  });
  const atLimit = await start(sku);
  assert.equal(atLimit.lines.length, 200);
  await ok(path(`stock-counts/${atLimit.id}/cancel`), { version: 0, reason: '200位置边界通过' });
  await db.stockPosition.create({
    data: {
      id: randomUUID(),
      warehouseId,
      skuId: sku,
      lotId: p.lotId,
      locationId: locations[198]!.id,
      onHand: 0,
    },
  });
  assert.equal(
    (
      await call(path('stock-counts'), {
        skuId: sku,
        version: (await balance(sku)).version,
        reason: '201位置超限',
      })
    ).error?.code,
    'COUNT_SIZE_LIMIT',
  );
  assert.equal((await balance(sku)).activeCountId, null);
  await consistent(sku);
  checks.push('bounded aggregates, complete 200-position snapshot, rejection at 201');
});

test('cancellation detects a newly mismatched ledger and leaves reconciliation hold instead of selling', async () => {
  const { sku, p } = await fresh();
  const c = await start(sku);
  const ledgerId = randomUUID();
  // Only this disposable schema: emulate an erroneous writer adding facts without cache updates.
  await db.$transaction(async (tx) => {
    await tx.stockLedger.create({
      data: {
        id: ledgerId,
        warehouseId,
        skuId: sku,
        lotId: p.lotId,
        actionKey: `BAD-FIXTURE:${ledgerId}`,
        deltaOnHand: 1,
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
        stockLedgerId: ledgerId,
        deltaOnHand: 1,
        deltaReserved: 0,
        deltaBlocked: 0,
      },
    });
  });
  await ok(path(`stock-counts/${c.id}/cancel`), { version: 0, reason: '异常账本终止并保留停售' });
  const b = await balance(sku);
  assert.equal(b.activeCountId, null);
  assert.equal(b.inventoryHold, true);
  assert.equal(b.onHand, 10);
  assert.equal(await visible(sku), 0);
  assert.ok(
    await db.inventoryCheck.count({ where: { warehouseId, skuId: sku, status: 'DIFFERENCES' } }),
  );
  checks.push('cancel rechecks ledger, preserves zero sale with durable mismatch evidence');
});
