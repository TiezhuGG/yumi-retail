import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createDatabase, hashPassword } from '../packages/database/src/index.ts';
import { createApplication } from '../apps/api/dist/app.js';
import { applicationConfig } from '../apps/api/dist/config.js';
import type {
  Category,
  Page,
  Product,
  Receipt,
  SaleSku,
  StaffProfile,
} from '../packages/contracts/src/index.ts';

const url = new URL(process.env.TEST_DATABASE_URL ?? '');
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname != '/yumi_test')
  throw new Error('S2 only permits the local isolated test database.');
const schema = 's2_' + randomUUID().replaceAll('-', '');
const { Client } = createRequire(import.meta.url)('pg') as {
  Client: new (config: { connectionString: string }) => {
    connect(): Promise<void>;
    query(text: string, values?: unknown[]): Promise<unknown>;
    end(): Promise<void>;
  };
};
const admin = new Client({ connectionString: url.toString() });
url.searchParams.set('schema', schema);
const db = createDatabase(url.toString());
const warehouses = [randomUUID(), randomUUID()];
const staffIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const password = randomBytes(18).toString('hex');
const run = randomUUID().replaceAll('-', '');
let counter = 0;
let base = '';
let categoryId = '';
let runtime: Awaited<ReturnType<typeof createApplication>>;
const identities: Array<{ cookie: string; csrf: string }> = [];
const checks: string[] = [];
async function call<T>(
  path: string,
  options: { actor?: number; body?: unknown; key?: string; method?: string } = {},
) {
  const headers: Record<string, string> = { Origin: 'http://127.0.0.1:5173' };
  if (options.actor !== undefined) {
    const identity = identities[options.actor]!;
    headers.Cookie = identity.cookie;
    headers['X-CSRF-Token'] = identity.csrf;
  }
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Idempotency-Key'] = options.key ?? randomUUID();
  }
  const response = await fetch(base + '/api/v1' + path, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const envelope = (await response.json()) as {
    data: T;
    error?: { code: string; message: string };
    requestId: string;
  };
  return { status: response.status, ...envelope };
}
async function ok<T>(path: string, body?: unknown, actor = 0, key?: string) {
  const result = await call<T>(path, { body, actor, key });
  assert.equal(result.status, 200, `${path}: ${result.error?.code}`);
  return result.data;
}
async function product(expiryManaged = false) {
  const p = await ok<Product>('/admin/products', {
    categoryId,
    name: `测试商品${++counter}`,
    description: '固定规格演示',
    skus: [
      { code: `S2-${run}-${counter}`, spec: '1包', unit: '包', priceCents: 450, expiryManaged },
    ],
  });
  return p;
}
function line(skuId: string, quantity = 3) {
  return {
    skuId,
    batchNo: 'BATCH-TEST',
    quantity,
    unitCostCents: 200,
    producedAt: null as string | null,
    expiresAt: null as string | null,
  };
}
async function draft(lines: ReturnType<typeof line>[], actor = 1, warehouseId = warehouses[0]!) {
  return ok<Receipt>(
    `/warehouse/warehouses/${warehouseId}/receipts`,
    { sourceRef: '测试来源', lines },
    actor,
  );
}
async function approve(receipt: Receipt, actor = 1) {
  return ok<Receipt>(
    `/warehouse/warehouses/${receipt.warehouseId}/receipts/${receipt.id}/approve`,
    { version: receipt.version },
    actor,
  );
}
async function post(receipt: Receipt, key?: string, actor = 1) {
  return call<Receipt>(`/warehouse/warehouses/${receipt.warehouseId}/receipts/${receipt.id}/post`, {
    body: { version: receipt.version },
    actor,
    key,
  });
}
async function publish(p: Product) {
  return ok<Product>(`/admin/products/${p.id}/publish`, { version: p.version });
}
async function visible(id: string) {
  return call<SaleSku>(`/products/${id}`);
}

before(async () => {
  await admin.connect();
  assert.match(schema, /^s2_[a-f0-9]{32}$/);
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query("SELECT set_config('search_path',$1,false)", [schema]);
  const directory = 'packages/database/prisma/migrations';
  for (const name of (await readdir(directory)).filter((n) => /^\d/.test(n)).sort()) {
    await admin.query(await readFile(`${directory}/${name}/migration.sql`, 'utf8'));
  }
  const passwordHash = await hashPassword(password);
  await db.warehouse.createMany({
    data: warehouses.map((id, i) => ({ id, code: `TEST-${i}`, name: `测试仓${i}` })),
  });
  for (const [i, id] of staffIds.entries())
    await db.staff.create({
      data: {
        id,
        loginName: `s2.${i}.${run}`,
        displayName: `测试员工${i}`,
        passwordHash,
        roles: {
          create: { roleCode: ['SUPER_ADMIN', 'WAREHOUSE_MANAGER', 'RIDER', 'PICKER'][i]! },
        },
        warehouses: { create: { warehouseId: warehouses[0]! } },
      },
    });
  runtime = await createApplication(url.toString(), {
    config: applicationConfig({
      ...process.env,
      NODE_ENV: 'test',
      PUBLIC_WAREHOUSE_ID: warehouses[0],
    }),
    accessLog: () => {},
  });
  await runtime.app.listen(0, '127.0.0.1');
  base = await runtime.app.getUrl();
  for (let i = 0; i < staffIds.length; i++) {
    const response = await fetch(base + '/api/v1/staff/auth/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173' },
      body: JSON.stringify({ loginName: `s2.${i}.${run}`, password }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
    const profile = (await fetch(base + '/api/v1/staff/me', { headers: { Cookie: cookie } }).then(
      (r) => r.json(),
    )) as { data: StaffProfile };
    identities.push({ cookie, csrf: profile.data.csrfToken });
  }
  categoryId = (await ok<Category>('/admin/categories', { name: '测试日用品' })).id;
});
after(async () => {
  try {
    if (runtime) await runtime.close();
    await db.$disconnect();
    // Only this run's disposable schema is removed. Public development/test tables are untouched.
    assert.match(schema, /^s2_[a-f0-9]{32}$/);
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await mkdir('.local', { recursive: true });
    await writeFile(
      '.local/s2-results.json',
      JSON.stringify(
        {
          finishedAt: new Date().toISOString(),
          checks,
          testDatabase: 'yumi_test',
          isolation: 'per-run disposable schema',
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

test('two-level category, strict inputs and durable create idempotency', async () => {
  const key = randomUUID();
  const a = await ok<Category>(
    '/admin/categories',
    { name: '二级分类', parentId: categoryId },
    0,
    key,
  );
  assert.equal(
    (await ok<Category>('/admin/categories', { name: '二级分类', parentId: categoryId }, 0, key))
      .id,
    a.id,
  );
  assert.equal(
    (await call('/admin/categories', { actor: 0, key, body: { name: '不同内容' } })).status,
    409,
  );
  assert.equal(
    (await call('/admin/categories', { actor: 0, body: { name: '第三级', parentId: a.id } }))
      .status,
    400,
  );
  assert.equal(
    (await call('/admin/categories', { actor: 0, body: { name: '注入字段', enabled: true } }))
      .status,
    400,
  );
  const bad = await call('/admin/products', {
    actor: 0,
    body: {
      categoryId,
      name: '非法价格',
      skus: [{ code: 'INVALID', spec: '包', unit: '包', priceCents: 4.5, expiryManaged: false }],
    },
  });
  assert.equal(bad.status, 400);
  checks.push('strict inputs category depth and durable create idempotency');
});

test('draft is hidden; publish and actual inbound create saleable stock without exposing costs', async () => {
  const p = await product();
  const sku = p.skus[0]!;
  assert.equal((await visible(sku.id)).status, 404);
  await publish(p);
  const zero = await visible(sku.id);
  assert.equal(zero.data.available, 0);
  const d = await draft([line(sku.id)]);
  assert.equal((await post(d)).status, 409);
  const approved = await approve(d);
  const posted = await post(approved);
  assert.equal(posted.status, 200);
  assert.equal(posted.data.status, 'POSTED');
  const publicSku = await visible(sku.id);
  assert.equal(publicSku.status, 200);
  assert.equal(publicSku.data.available, 3);
  assert.equal(publicSku.data.priceCents, 450);
  for (const secret of ['unitCostCents', 'createdBy', 'warehouseId', 'batchNo', 'code'])
    assert.equal(secret in publicSku.data, false);
  const balance = await db.stockBalance.findUniqueOrThrow({
    where: { warehouseId_skuId: { warehouseId: warehouses[0]!, skuId: sku.id } },
  });
  const lots = await db.stockLot.aggregate({ where: { skuId: sku.id }, _sum: { onHand: true } });
  const ledger = await db.stockLedger.aggregate({
    where: { skuId: sku.id },
    _sum: { deltaOnHand: true },
  });
  assert.equal(balance.onHand, 3);
  assert.equal(lots._sum.onHand, 3);
  assert.equal(ledger._sum.deltaOnHand, 3);
  assert.equal(
    await db.businessAudit.count({ where: { resourceId: d.id, action: 'RECEIPT_POST' } }),
    1,
  );
  checks.push('draft approval posting public catalog and balanced ledger');
});

test('20 identical retries and competing different keys post a receipt exactly once', async () => {
  const p = await product();
  const receipt = await approve(await draft([line(p.skus[0]!.id, 7)]));
  const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 20 }, () => post(receipt, key)));
  assert.ok(results.every((r) => r.status === 200 && r.data.id === receipt.id));
  const changed = await call(
    `/warehouse/warehouses/${receipt.warehouseId}/receipts/${receipt.id}/post`,
    { actor: 1, key, body: { version: 2 } },
  );
  assert.equal(changed.status, 409);
  assert.equal(changed.error?.code, 'IDEMPOTENCY_CONFLICT');
  const originalBase = base;
  const secondInstance = await createApplication(url.toString(), {
    config: applicationConfig({
      ...process.env,
      NODE_ENV: 'test',
      PUBLIC_WAREHOUSE_ID: warehouses[0],
    }),
    accessLog: () => {},
  });
  try {
    await secondInstance.app.listen(0, '127.0.0.1');
    base = await secondInstance.app.getUrl();
    assert.equal((await post(receipt, key)).status, 200);
  } finally {
    base = originalBase;
    await secondInstance.close();
  }
  assert.equal((await post(receipt, randomUUID())).status, 409);
  const second = await approve(await draft([line(p.skus[0]!.id, 2)]));
  const race = await Promise.all(Array.from({ length: 10 }, () => post(second)));
  assert.equal(race.filter((r) => r.status === 200).length, 1);
  assert.ok(race.every((r) => [200, 409].includes(r.status)));
  assert.equal(
    (
      await db.stockBalance.findUniqueOrThrow({
        where: { warehouseId_skuId: { warehouseId: warehouses[0]!, skuId: p.skus[0]!.id } },
      })
    ).onHand,
    9,
  );
  assert.equal(await db.stockLedger.count({ where: { skuId: p.skus[0]!.id } }), 2);
  checks.push('20 retry and 10 competing keys produce one posting each');
});

test('separate receipts for one SKU serialize stock increments without loss', async () => {
  const p = await product();
  const sku = p.skus[0]!.id;
  const docs = await Promise.all(
    Array.from({ length: 8 }, async () => approve(await draft([line(sku, 2)]))),
  );
  const results = await Promise.all(docs.map((d) => post(d)));
  assert.ok(
    results.every((r) => r.status === 200),
    JSON.stringify(results.map((r) => ({ status: r.status, code: r.error?.code }))),
  );
  assert.equal(
    (
      await db.stockBalance.findUniqueOrThrow({
        where: { warehouseId_skuId: { warehouseId: warehouses[0]!, skuId: sku } },
      })
    ).onHand,
    16,
  );
  assert.equal(await db.stockLedger.count({ where: { skuId: sku } }), 8);
  checks.push('concurrent receipts do not lose updates');
});

test('multi-SKU failure rolls back earlier stock, lots, ledger, audit and idempotency', async () => {
  const a = await product(),
    b = await product();
  const ids = [a.skus[0]!.id, b.skus[0]!.id].sort();
  const receipt = await approve(await draft(ids.map((id) => line(id, 5))));
  await db.sku.update({ where: { id: ids[1] }, data: { enabled: false } });
  const key = randomUUID();
  assert.equal((await post(receipt, key)).status, 409);
  assert.equal(await db.stockBalance.count({ where: { skuId: { in: ids } } }), 0);
  assert.equal(await db.stockLot.count({ where: { skuId: { in: ids } } }), 0);
  assert.equal(await db.stockLedger.count({ where: { skuId: { in: ids } } }), 0);
  assert.equal(
    await db.businessAudit.count({ where: { resourceId: receipt.id, action: 'RECEIPT_POST' } }),
    0,
  );
  assert.equal(
    (await db.inboundReceipt.findUniqueOrThrow({ where: { id: receipt.id } })).status,
    'APPROVED',
  );
  await db.sku.update({ where: { id: ids[1] }, data: { enabled: true } });
  assert.equal((await post(receipt, key)).status, 200);
  checks.push('multi SKU failure rolls back and original key can recover');
});

test('expiry requirements and posting-time revalidation prevent expired inbound', async () => {
  const p = await product(true);
  const sku = p.skus[0]!.id;
  assert.equal(
    (
      await call(`/warehouse/warehouses/${warehouses[0]}/receipts`, {
        actor: 1,
        body: { sourceRef: '缺少效期', lines: [line(sku)] },
      })
    ).status,
    409,
  );
  const entry = {
    ...line(sku),
    producedAt: new Date(Date.now() - 86400000).toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
  const receipt = await approve(await draft([entry]));
  await db.inboundLine.updateMany({
    where: { receiptId: receipt.id },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal((await post(receipt)).status, 409);
  assert.equal(await db.stockBalance.count({ where: { skuId: sku } }), 0);
  checks.push('expiry required and revalidated during posting');
});

test('expired lots, safety stock, disabled SKU/category and unpublished product are not saleable', async () => {
  const p = await product(true);
  const sku = p.skus[0]!.id;
  await publish(p);
  const entry = {
    ...line(sku, 10),
    producedAt: new Date(Date.now() - 86400000).toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
  };
  const receipt = await approve(await draft([entry]));
  assert.equal((await post(receipt)).status, 200);
  assert.equal((await visible(sku)).data.available, 10);
  await db.stockBalance.update({
    where: { warehouseId_skuId: { warehouseId: warehouses[0]!, skuId: sku } },
    data: { safety: 3 },
  });
  assert.equal((await visible(sku)).data.available, 7);
  await db.stockLot.updateMany({
    where: { skuId: sku },
    data: { expiresAt: new Date(Date.now() - 1000) },
  });
  assert.equal((await visible(sku)).data.available, 0);
  await db.sku.update({ where: { id: sku }, data: { enabled: false } });
  assert.equal((await visible(sku)).status, 404);
  await db.sku.update({ where: { id: sku }, data: { enabled: true } });
  await db.category.update({ where: { id: categoryId }, data: { enabled: false } });
  assert.equal((await visible(sku)).status, 404);
  await db.category.update({ where: { id: categoryId }, data: { enabled: true } });
  await ok(`/admin/products/${p.id}/unpublish`, { version: 1 });
  assert.equal((await visible(sku)).status, 404);
  checks.push('expiry and all saleability gates enforced server side');
});

test('warehouse scope, rider denial, CSRF and stale version are enforced', async () => {
  assert.equal(
    (await call(`/warehouse/warehouses/${warehouses[0]}/receipts`, { actor: 3 })).status,
    403,
  );
  assert.equal(
    (await call(`/warehouse/warehouses/${warehouses[0]}/stock`, { actor: 3 })).status,
    200,
  );
  assert.equal(
    (await call(`/warehouse/warehouses/${warehouses[1]}/receipts`, { actor: 1 })).status,
    403,
  );
  assert.equal(
    (await call(`/warehouse/warehouses/${warehouses[0]}/receipts`, { actor: 2 })).status,
    403,
  );
  assert.equal((await call('/admin/products', { actor: 1, body: {} })).status, 403);
  const p = await product();
  const d = await draft([line(p.skus[0]!.id)]);
  await approve(d);
  assert.equal(
    (
      await call(`/warehouse/warehouses/${d.warehouseId}/receipts/${d.id}/approve`, {
        actor: 1,
        body: { version: 0 },
      })
    ).status,
    409,
  );
  const response = await fetch(base + '/api/v1/admin/categories', {
    method: 'POST',
    headers: {
      Cookie: identities[0]!.cookie,
      Origin: 'http://127.0.0.1:5173',
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify({ name: '缺少CSRF' }),
  });
  assert.equal(response.status, 403);
  await db.warehouse.update({ where: { id: warehouses[0] }, data: { enabled: false } });
  assert.equal((await call('/products')).status, 503);
  assert.equal(
    (await call(`/warehouse/warehouses/${warehouses[0]}/stock`, { actor: 1 })).status,
    403,
  );
  await db.warehouse.update({ where: { id: warehouses[0] }, data: { enabled: true } });
  checks.push('scope role CSRF version and disabled warehouse enforced');
});

test('public pagination/search/detail and tampered warehouse input are bounded', async () => {
  for (let i = 0; i < 3; i++) await publish(await product());
  const first = await call<Page<SaleSku>>('/products?limit=1');
  assert.equal(first.data.items.length, 1);
  assert.equal(first.data.hasMore, true);
  const second = await call<Page<SaleSku>>(`/products?limit=1&cursor=${first.data.nextCursor}`);
  assert.notEqual(first.data.items[0]!.id, second.data.items[0]!.id);
  assert.equal((await call('/products?limit=10000')).status, 400);
  assert.equal((await call(`/products?warehouseId=${warehouses[1]}`)).status, 400);
  assert.equal((await call('/products?keyword=%27%20OR%201%3D1--')).data !== undefined, true);
  assert.equal((await call<Page<SaleSku>>('/products?keyword=完全不存在')).data.items.length, 0);
  checks.push('bounded cursor pagination search and fixed operating warehouse');
});

test('database checks, composite foreign keys and append-only facts resist invalid writes', async () => {
  const lot = await db.stockLot.findFirstOrThrow();
  await assert.rejects(
    db.stockBalance.update({
      where: { warehouseId_skuId: { warehouseId: lot.warehouseId, skuId: lot.skuId } },
      data: { onHand: -1 },
    }),
  );
  const ledger = await db.stockLedger.findFirstOrThrow();
  await assert.rejects(
    db.stockLedger.update({ where: { id: ledger.id }, data: { deltaOnHand: 999 } }),
  );
  await assert.rejects(db.stockLedger.delete({ where: { id: ledger.id } }));
  await assert.rejects(
    db.stockLedger.create({
      data: {
        id: randomUUID(),
        lotId: lot.id,
        warehouseId: warehouses[1]!,
        skuId: lot.skuId,
        actionKey: randomUUID(),
        deltaOnHand: 1,
        actorId: staffIds[0]!,
        requestId: randomUUID(),
      },
    }),
  );
  const audit = await db.businessAudit.findFirstOrThrow();
  await assert.rejects(db.businessAudit.delete({ where: { id: audit.id } }));
  checks.push('database quantities composite keys and append only facts');
});
