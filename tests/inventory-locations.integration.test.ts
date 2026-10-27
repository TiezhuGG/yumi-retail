import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createDatabase, hashPassword } from '../packages/database/src/index.ts';
import { createApplication } from '../apps/api/dist/app.js';
import { applicationConfig } from '../apps/api/dist/config.js';
import type {
  Page,
  Product,
  Receipt,
  SaleSku,
  StaffProfile,
} from '../packages/contracts/src/index.ts';

const url = new URL(process.env.TEST_DATABASE_URL ?? '');
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname != '/yumi_test')
  throw new Error('Inventory tests only permit local yumi_test.');
const schema = 'inv_' + randomUUID().replaceAll('-', '');
interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[] }>;
}
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => PgClient;
};
const admin = new Client({ connectionString: url.toString() });
url.searchParams.set('schema', schema);
const db = createDatabase(url.toString());
let runtime: Awaited<ReturnType<typeof createApplication>>,
  base = '',
  categoryId = '',
  counter = 0;
let legacy: Awaited<ReturnType<typeof seedLegacy>>, oldLedger: unknown;
const staffIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const otherWarehouse = randomUUID();
const password = randomBytes(18).toString('hex');
const identities: Array<{ cookie: string; csrf: string }> = [];
const checks: string[] = [];
const directory = 'packages/database/prisma/migrations';
const locationMigration = '202610270003_locations_reconciliation';
let migrations: string[] = [];
type Position = {
  id: string;
  warehouseId: string;
  skuId: string;
  lotId: string;
  locationId: string;
  onHand: number;
  reserved: number;
  blocked: number;
  version: number;
  locationCode: string;
};
type Location = {
  id: string;
  warehouseId: string;
  code: string;
  name: string;
  enabled: boolean;
  version: number;
};
type Transfer = {
  id: string;
  sourcePositionId: string;
  targetPositionId: string;
  stockLedgerId: string;
  quantity: number;
};
type Report = {
  id: string;
  status: string;
  issueCount: number;
  issues: Array<{ kind: string; resourceId: string }>;
};
async function seedLegacy(client: PgClient) {
  const w = randomUUID(),
    actor = randomUUID(),
    category = randomUUID(),
    product = randomUUID(),
    sku = randomUUID(),
    receipt = randomUUID(),
    line = randomUUID(),
    lot = randomUUID(),
    ledger = randomUUID();
  await client.query('INSERT INTO warehouses(id,code,name) VALUES($1,$2,$3)', [
    w,
    'LEGACY',
    '迁移测试仓',
  ]);
  await client.query(
    'INSERT INTO staff(id,login_name,display_name,password_hash) VALUES($1,$2,$3,$4)',
    [actor, 'migration.fixture', '迁移测试员工', 'not-a-login-hash'],
  );
  await client.query('INSERT INTO categories(id,name) VALUES($1,$2)', [category, '迁移分类']);
  await client.query(
    "INSERT INTO products(id,category_id,name,description,status) VALUES($1,$2,$3,$4,'PUBLISHED')",
    [product, category, '迁移商品', '迁移前已入库'],
  );
  await client.query(
    'INSERT INTO skus(id,product_id,code,spec,unit,price_cents,expiry_managed) VALUES($1,$2,$3,$4,$5,450,false)',
    [sku, product, 'LEGACY-SKU', '1包', '包'],
  );
  await client.query(
    "INSERT INTO inbound_receipts(id,warehouse_id,source_ref,status,version,created_by,reviewed_by,reviewed_at,posted_at) VALUES($1,$2,'LEGACY','POSTED',2,$3,$3,NOW(),NOW())",
    [receipt, w, actor],
  );
  await client.query(
    "INSERT INTO inbound_lines(id,receipt_id,warehouse_id,sku_id,batch_no,quantity,unit_cost_cents) VALUES($1,$2,$3,$4,'LEGACY',10,200)",
    [line, receipt, w, sku],
  );
  await client.query('INSERT INTO stock_balances(warehouse_id,sku_id,on_hand) VALUES($1,$2,10)', [
    w,
    sku,
  ]);
  await client.query(
    "INSERT INTO stock_lots(id,warehouse_id,sku_id,receipt_line_id,batch_no,on_hand,unit_cost_cents) VALUES($1,$2,$3,$4,'LEGACY',10,200)",
    [lot, w, sku, line],
  );
  await client.query(
    "INSERT INTO stock_ledger(id,lot_id,warehouse_id,sku_id,action_key,delta_on_hand,actor_id,request_id) VALUES($1,$2,$3,$4,'LEGACY-RECEIPT',10,$5,$6)",
    [ledger, lot, w, sku, actor, randomUUID()],
  );
  return { w, actor, category, product, sku, receipt, line, lot, ledger };
}
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
  const envelope = (await response.json()) as {
    data: T;
    error?: { code: string };
    requestId: string;
  };
  return { status: response.status, ...envelope };
}
async function ok<T>(path: string, body?: unknown, actor = 0, key?: string) {
  const result = await call<T>(path, body, actor, key);
  assert.equal(result.status, 200, `${path}: ${result.error?.code}`);
  return result.data;
}
const path = (suffix: string) => `/warehouse/warehouses/${legacy.w}/${suffix}`;
async function positions(skuId: string) {
  return (await ok<Page<Position>>(path(`positions?skuId=${skuId}&limit=50`))).items;
}
async function location() {
  return ok<Location>(path('locations'), { code: `A-${++counter}`, name: `货架${counter}` });
}
async function fresh(quantity = 10) {
  const p = await ok<Product>('/admin/products', {
    categoryId,
    name: `库存测试${++counter}`,
    skus: [
      { code: `INV-${counter}`, spec: '1包', unit: '包', priceCents: 450, expiryManaged: false },
    ],
  });
  await ok(`/admin/products/${p.id}/publish`, { version: 0 });
  const d = await ok<Receipt>(path('receipts'), {
    sourceRef: '库存测试',
    lines: [{ skuId: p.skus[0]!.id, batchNo: 'INV', quantity, unitCostCents: 200 }],
  });
  const a = await ok<Receipt>(path(`receipts/${d.id}/approve`), { version: 0 });
  await ok(path(`receipts/${d.id}/post`), { version: a.version });
  const source = (await positions(p.skus[0]!.id))[0]!;
  return { p, sku: p.skus[0]!.id, source };
}
const move = (source: Position, target: Location, quantity: number) => ({
  sourcePositionId: source.id,
  targetLocationId: target.id,
  quantity,
  version: source.version,
  reason: '同仓整理货架',
});
const visible = (sku: string) => call<SaleSku>(`/products/${sku}`, undefined, null);

before(async () => {
  await admin.connect();
  assert.match(schema, /^inv_[a-f0-9]{32}$/);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query("SELECT set_config('search_path',$1,false)", [schema]);
  migrations = (await readdir(directory)).filter((n) => /^\d/.test(n)).sort();
  for (const name of migrations.filter((name) => name < locationMigration))
    await admin.query(await readFile(`${directory}/${name}/migration.sql`, 'utf8'));
  legacy = await seedLegacy(admin);
  oldLedger = (
    await admin.query('SELECT row_to_json(e) value FROM stock_ledger e WHERE id=$1', [
      legacy.ledger,
    ])
  ).rows[0]!.value;
  for (const name of migrations.filter((name) => name >= locationMigration))
    await admin.query(await readFile(`${directory}/${name}/migration.sql`, 'utf8'));
  const passwordHash = await hashPassword(password);
  for (const [i, id] of staffIds.entries())
    await db.staff.create({
      data: {
        id,
        loginName: `inventory.${i}`,
        displayName: `库存验收${i}`,
        passwordHash,
        roles: {
          create: { roleCode: ['SUPER_ADMIN', 'WAREHOUSE_MANAGER', 'PICKER', 'RIDER'][i]! },
        },
        warehouses: { create: { warehouseId: legacy.w } },
      },
    });
  await db.warehouse.create({ data: { id: otherWarehouse, code: 'OTHER', name: '未授权仓' } });
  categoryId = legacy.category;
  runtime = await createApplication(url.toString(), {
    config: applicationConfig({ ...process.env, NODE_ENV: 'test', PUBLIC_WAREHOUSE_ID: legacy.w }),
    accessLog: () => {},
  });
  await runtime.app.listen(0, '127.0.0.1');
  base = await runtime.app.getUrl();
  for (let i = 0; i < staffIds.length; i++) {
    const response = await fetch(base + '/api/v1/staff/auth/session', {
      method: 'POST',
      headers: { Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' },
      body: JSON.stringify({ loginName: `inventory.${i}`, password }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const profile = (await fetch(base + '/api/v1/staff/me', { headers: { Cookie: cookie } }).then(
      (r) => r.json(),
    )) as { data: StaffProfile };
    identities.push({ cookie, csrf: profile.data.csrfToken });
  }
});
after(async () => {
  try {
    if (runtime) await runtime.close();
    await db.$disconnect();
    assert.match(schema, /^inv_[a-f0-9]{32}$/);
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await mkdir('.local', { recursive: true });
    await writeFile(
      '.local/inventory-results.json',
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

test('legacy migration preserves quantities and old facts and backfills actual positions', async () => {
  const after = (
    await admin.query('SELECT row_to_json(e) value FROM stock_ledger e WHERE id=$1', [
      legacy.ledger,
    ])
  ).rows[0]!.value;
  assert.deepEqual(after, oldLedger);
  const pos = (await positions(legacy.sku))[0]!;
  assert.equal(pos.onHand, 10);
  assert.equal(pos.locationCode, 'DEFAULT');
  assert.equal(pos.lotId, legacy.lot);
  const entry = await db.positionLedger.findUniqueOrThrow({ where: { id: legacy.ledger } });
  assert.equal(entry.stockLedgerId, legacy.ledger);
  assert.equal(entry.deltaOnHand, 10);
  const report = await ok<Report>(path('inventory-checks'), { skuId: legacy.sku });
  assert.equal(report.status, 'CONSISTENT');
  assert.equal(report.issueCount, 0);
  assert.equal((await visible(legacy.sku)).data.available, 10);
  checks.push('legacy values unchanged positions and historical ledger backfilled');
});
test('mismatched legacy inventory refuses migration atomically', async () => {
  const bad = 'inv_bad_' + randomUUID().replaceAll('-', '');
  assert.match(bad, /^inv_bad_[a-f0-9]{32}$/);
  await admin.query(`CREATE SCHEMA ${bad}`);
  try {
    await admin.query("SELECT set_config('search_path',$1,false)", [bad]);
    for (const name of migrations.filter((name) => name < locationMigration))
      await admin.query(await readFile(`${directory}/${name}/migration.sql`, 'utf8'));
    const fixture = await seedLegacy(admin);
    await admin.query('UPDATE stock_balances SET on_hand=11 WHERE sku_id=$1', [fixture.sku]);
    await assert.rejects(
      admin.query(await readFile(`${directory}/${locationMigration}/migration.sql`, 'utf8')),
      /Legacy inventory mismatch/,
    );
    await admin.query('ROLLBACK');
    assert.equal(
      (
        await admin.query(
          "SELECT count(*)::int n FROM information_schema.tables WHERE table_schema=$1 AND table_name='stock_positions'",
          [bad],
        )
      ).rows[0]!.n,
      0,
    );
    assert.equal(
      (await admin.query('SELECT on_hand FROM stock_balances WHERE sku_id=$1', [fixture.sku]))
        .rows[0]!.on_hand,
      11,
    );
  } finally {
    await admin.query('ROLLBACK');
    await admin.query("SELECT set_config('search_path',$1,false)", [schema]);
    await admin.query(`DROP SCHEMA ${bad} CASCADE`);
  }
  checks.push('inconsistent legacy migration stops without partial schema or quantity repair');
});
test('location actions preserve DEFAULT, reject duplicates and only disable empty locations', async () => {
  const target = await location();
  const key = randomUUID();
  const input = { code: `NEW-${++counter}`, name: '重试库位' };
  const a = await ok<Location>(path('locations'), input, 0, key);
  assert.equal((await ok<Location>(path('locations'), input, 0, key)).id, a.id);
  assert.equal((await call(path('locations'), input)).status, 409);
  const off = await ok<Location>(path(`locations/${target.id}/disable`), {
    version: target.version,
  });
  assert.equal(off.enabled, false);
  assert.equal(
    (await ok<Location>(path(`locations/${target.id}/enable`), { version: off.version })).enabled,
    true,
  );
  const def = await db.warehouseLocation.findUniqueOrThrow({
    where: { warehouseId_code: { warehouseId: legacy.w, code: 'DEFAULT' } },
  });
  assert.equal(
    (await call(path(`locations/${def.id}/disable`), { version: def.version })).status,
    409,
  );
  checks.push('location create idempotency uniqueness empty enable disable and default protection');
});
test('new receiving produces matching summary batch positions and two linked ledgers', async () => {
  const f = await fresh(6);
  const pos = (await positions(f.sku))[0]!;
  assert.equal(pos.onHand, 6);
  assert.equal(await db.positionLedger.count({ where: { positionId: pos.id } }), 1);
  assert.equal((await ok<Report>(path('inventory-checks'), { skuId: f.sku })).status, 'CONSISTENT');
  checks.push('new receiving maintains both ledgers and positions');
});
test('20 move retries create one transfer and paired entries without changing saleable stock', async () => {
  const f = await fresh(),
    target = await location();
  const key = randomUUID();
  const body = move(f.source, target, 3);
  const results = await Promise.all(
    Array.from({ length: 20 }, () => call<Transfer>(path('stock-transfers'), body, 1, key)),
  );
  assert.ok(
    results.every((r) => r.status === 200),
    JSON.stringify(results.map((r) => r.error)),
  );
  const id = results[0]!.data.id;
  assert.ok(results.every((r) => r.data.id === id));
  const rows = await positions(f.sku);
  assert.equal(rows.find((p) => p.locationId === target.id)!.onHand, 3);
  assert.equal(rows.find((p) => p.id === f.source.id)!.onHand, 7);
  const entries = await db.positionLedger.findMany({
    where: { stockLedgerId: results[0]!.data.stockLedgerId },
  });
  assert.equal(entries.length, 2);
  assert.equal(
    entries.reduce((sum, e) => sum + e.deltaOnHand, 0),
    0,
  );
  assert.equal(
    (
      await db.stockBalance.findUniqueOrThrow({
        where: { warehouseId_skuId: { warehouseId: legacy.w, skuId: f.sku } },
      })
    ).onHand,
    10,
  );
  assert.equal((await visible(f.sku)).data.available, 10);
  assert.equal((await ok<Report>(path('inventory-checks'), { skuId: f.sku })).status, 'CONSISTENT');
  assert.equal(
    (await call(path(`locations/${target.id}/disable`), { version: target.version })).status,
    409,
  );
  checks.push('20 retries move once paired ledger and quantity saleability preserved');
});
test('concurrent attempts against one source cannot overdraw or bypass version', async () => {
  const f = await fresh(5),
    a = await location(),
    b = await location();
  const results = await Promise.all([
    call(path('stock-transfers'), move(f.source, a, 4)),
    call(path('stock-transfers'), move(f.source, b, 4)),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.ok(results.every((r) => [200, 409].includes(r.status)));
  assert.equal(
    (await positions(f.sku)).reduce((n, p) => n + p.onHand, 0),
    5,
  );
  assert.equal((await positions(f.sku)).find((p) => p.id === f.source.id)!.onHand, 1);
  checks.push('concurrent move version and nonnegative source');
});
test('reserved blocked disabled cross-warehouse and invalid inputs refuse movement', async () => {
  const f = await fresh(),
    target = await location();
  await db.stockPosition.update({ where: { id: f.source.id }, data: { reserved: 1 } });
  assert.equal(
    (await call(path('stock-transfers'), move(f.source, target, 1))).error?.code,
    'STOCK_RESERVED',
  );
  await db.stockPosition.update({ where: { id: f.source.id }, data: { reserved: 0, blocked: 9 } });
  assert.equal((await call(path('stock-transfers'), move(f.source, target, 2))).status, 409);
  await db.stockPosition.update({ where: { id: f.source.id }, data: { blocked: 0 } });
  const other = await db.warehouseLocation.findUniqueOrThrow({
    where: { warehouseId_code: { warehouseId: otherWarehouse, code: 'DEFAULT' } },
  });
  assert.equal((await call(path('stock-transfers'), move(f.source, other, 1))).status, 403);
  await ok(path(`locations/${target.id}/disable`), { version: 0 });
  assert.equal((await call(path('stock-transfers'), move(f.source, target, 1))).status, 403);
  assert.equal(
    (await call(path('stock-transfers'), { ...move(f.source, target, 1), quantity: 1.5 })).status,
    400,
  );
  assert.equal(
    (await call(path('stock-transfers'), { ...move(f.source, target, 1), reason: '' })).status,
    400,
  );
  assert.equal((await positions(f.sku))[0]!.onHand, 10);
  checks.push('reserved blocked unavailable cross warehouse invalid input refusal');
});
test('late target failure rolls back source decrement audit ledgers transfer and original-key result', async () => {
  const f = await fresh(),
    target = await location();
  const overflow = await db.stockPosition.create({
    data: {
      id: randomUUID(),
      warehouseId: legacy.w,
      skuId: f.sku,
      lotId: f.source.lotId,
      locationId: target.id,
      onHand: 1000000000,
    },
  });
  const key = randomUUID(),
    body = move(f.source, target, 1);
  assert.equal((await call(path('stock-transfers'), body, 0, key)).status, 409);
  assert.equal(
    (await db.stockPosition.findUniqueOrThrow({ where: { id: f.source.id } })).onHand,
    10,
  );
  assert.equal(await db.stockTransfer.count({ where: { skuId: f.sku } }), 0);
  assert.equal(await db.stockLedger.count({ where: { skuId: f.sku } }), 1);
  await db.stockPosition.update({ where: { id: overflow.id }, data: { onHand: 0 } });
  assert.equal((await call(path('stock-transfers'), body, 0, key)).status, 200);
  checks.push('late failure is atomic and original intent can recover');
});
test('expired batches remain unsaleable after physical relocation', async () => {
  const f = await fresh(),
    target = await location();
  await db.stockLot.update({
    where: { id: f.source.lotId },
    data: { producedAt: new Date(Date.now() - 86400000), expiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal((await visible(f.sku)).data.available, 0);
  await ok(path('stock-transfers'), move(f.source, target, 2));
  assert.equal((await visible(f.sku)).data.available, 0);
  checks.push('expiry follows batch across locations');
});
test('differences create durable hold with no repair and fresh clean evidence is required to release', async () => {
  const f = await fresh(),
    target = await location();
  await db.stockBalance.update({
    where: { warehouseId_skuId: { warehouseId: legacy.w, skuId: f.sku } },
    data: { onHand: 11 },
  });
  const key = randomUUID();
  const report = await ok<Report>(path('inventory-checks'), { skuId: f.sku }, 0, key);
  assert.equal(report.status, 'DIFFERENCES');
  assert.ok(report.issueCount > 0);
  assert.equal(
    (await ok<Report>(path('inventory-checks'), { skuId: f.sku }, 0, key)).id,
    report.id,
  );
  let balance = await db.stockBalance.findUniqueOrThrow({
    where: { warehouseId_skuId: { warehouseId: legacy.w, skuId: f.sku } },
  });
  assert.equal(balance.onHand, 11);
  assert.equal(balance.inventoryHold, true);
  assert.equal((await visible(f.sku)).data.available, 0);
  assert.equal(
    (await call(path('stock-transfers'), move(f.source, target, 1))).error?.code,
    'INVENTORY_HOLD',
  );
  assert.equal(
    (
      await call(path(`stock/${f.sku}/release-check-hold`), {
        version: balance.version,
        reason: '未修复',
      })
    ).status,
    409,
  );
  const d = await ok<Receipt>(path('receipts'), {
    sourceRef: '暂停入库',
    lines: [{ skuId: f.sku, batchNo: 'HOLD', quantity: 1, unitCostCents: 200 }],
  });
  await ok(path(`receipts/${d.id}/approve`), { version: 0 });
  assert.equal((await call(path(`receipts/${d.id}/post`), { version: 1 })).status, 409);
  // Fault injection/repair only in this disposable test schema; no quantity-edit API exists.
  await db.stockBalance.update({
    where: { warehouseId_skuId: { warehouseId: legacy.w, skuId: f.sku } },
    data: { onHand: 10 },
  });
  assert.equal((await ok<Report>(path('inventory-checks'), { skuId: f.sku })).status, 'CONSISTENT');
  balance = await db.stockBalance.findUniqueOrThrow({
    where: { warehouseId_skuId: { warehouseId: legacy.w, skuId: f.sku } },
  });
  assert.equal(balance.inventoryHold, true);
  const released = await ok<{ inventoryHold: boolean; checkId: string }>(
    path(`stock/${f.sku}/release-check-hold`),
    { version: balance.version, reason: '隔离测试故障已排除且复核通过' },
  );
  assert.equal(released.inventoryHold, false);
  assert.equal((await visible(f.sku)).data.available, 10);
  assert.equal(
    (
      await db.businessAudit.findFirstOrThrow({
        where: { resourceId: released.checkId, action: 'INVENTORY_HOLD_RELEASE' },
      })
    ).reason,
    '隔离测试故障已排除且复核通过',
  );
  checks.push('mismatch blocks sales without repair and explicit clean checked release');
});
test('offsetting position corruption is detected even when warehouse and lot totals still match', async () => {
  const f = await fresh(),
    target = await location();
  await ok(path('stock-transfers'), move(f.source, target, 4));
  const rows = await positions(f.sku);
  const a = rows.find((p) => p.id === f.source.id)!,
    b = rows.find((p) => p.id !== f.source.id)!;
  await db.$transaction([
    db.stockPosition.update({ where: { id: a.id }, data: { onHand: { increment: 1 } } }),
    db.stockPosition.update({ where: { id: b.id }, data: { onHand: { decrement: 1 } } }),
  ]);
  const report = await ok<Report>(path('inventory-checks'), { skuId: f.sku });
  assert.equal(report.status, 'DIFFERENCES');
  assert.equal(report.issues.filter((i) => i.kind === 'POSITION_LEDGER').length, 2);
  assert.equal((await visible(f.sku)).data.available, 0);
  checks.push('offsetting corruption cannot hide behind aggregate equality');
});
test('database enforces append-only position facts and deferred complete event balancing', async () => {
  const entry = await db.positionLedger.findFirstOrThrow();
  await assert.rejects(
    db.positionLedger.update({ where: { id: entry.id }, data: { deltaOnHand: 999 } }),
  );
  await assert.rejects(db.positionLedger.delete({ where: { id: entry.id } }));
  const count = await db.stockLedger.count();
  await assert.rejects(
    db.stockLedger.create({
      data: {
        id: randomUUID(),
        lotId: legacy.lot,
        warehouseId: legacy.w,
        skuId: legacy.sku,
        actionKey: randomUUID(),
        deltaOnHand: 1,
        actorId: staffIds[0]!,
        requestId: randomUUID(),
      },
    }),
  );
  assert.equal(await db.stockLedger.count(), count);
  await assert.rejects(
    db.stockLedger.create({
      data: {
        id: randomUUID(),
        lotId: legacy.lot,
        warehouseId: legacy.w,
        skuId: legacy.sku,
        actionKey: randomUUID(),
        deltaOnHand: 0,
        actorId: staffIds[0]!,
        requestId: randomUUID(),
      },
    }),
  );
  assert.equal(await db.stockLedger.count(), count);
  const report = await db.inventoryCheck.findFirstOrThrow();
  await assert.rejects(db.inventoryCheck.delete({ where: { id: report.id } }));
  const transfer = await db.stockTransfer.findFirstOrThrow();
  await assert.rejects(
    db.stockTransfer.update({ where: { id: transfer.id }, data: { quantity: 999 } }),
  );
  checks.push('append only facts and deferred complete event invariant');
});
test('role scope privacy and pagination remain enforced on new endpoints', async () => {
  const smallest = await db.stockBalance.findFirstOrThrow({
    where: { warehouseId: legacy.w },
    orderBy: { skuId: 'asc' },
  });
  const filtered = await ok<Page<{ skuId: string }>>(
    path(`stock?skuId=${smallest.skuId}&cursor=${smallest.skuId}`),
  );
  assert.equal(filtered.items.length, 0);
  const result = await call<Page<Position>>(path('positions?limit=1'), undefined, 2);
  assert.equal(result.status, 200);
  assert.equal(result.data.items.length, 1);
  for (const name of ['unitCostCents', 'passwordHash', 'createdBy'])
    assert.equal(name in result.data.items[0]!, false);
  assert.equal((await call(path('inventory-checks'), { skuId: legacy.sku }, 2)).status, 403);
  assert.equal((await call(path('locations'), { code: 'PICKER', name: '禁止' }, 2)).status, 403);
  assert.equal((await call(path('positions'), undefined, 3)).status, 403);
  assert.equal((await call(`/warehouse/warehouses/${otherWarehouse}/locations`)).status, 403);
  assert.equal((await call(path('positions?limit=1000'))).status, 400);
  const next = await ok<Page<Position>>(path(`positions?limit=1&cursor=${result.data.nextCursor}`));
  assert.notEqual(next.items[0]!.id, result.data.items[0]!.id);
  const history = await ok<Page<{ deltaOnHand: number }>>(
    path(`positions/${legacy.lot}/ledger?limit=1`),
  );
  assert.equal(history.items[0]!.deltaOnHand, 10);
  checks.push('role scope no cost leakage cursor limits and traceable ledger');
});
