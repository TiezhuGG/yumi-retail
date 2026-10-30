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

test('receipt detail is warehouse-scoped, cost-protected and reflects current status with unchanged receipt facts', async () => {
  const a = await product(),
    b = await product();
  const input = [line(a.skus[0]!.id, 2), { ...line(b.skus[0]!.id, 3), unitCostCents: 719 }];
  const receipt = await draft(input);
  const route = `/warehouse/warehouses/${receipt.warehouseId}/receipts/${receipt.id}`;
  const read = await ok<import('../packages/contracts/src/index.ts').ReceiptDetail>(
    route,
    undefined,
    1,
  );
  assert.equal(read.status, 'DRAFT');
  assert.equal(read.lines.length, 2);
  assert.equal(read.lines.find((l) => l.skuId === b.skus[0]!.id)!.unitCostCents, 719);
  assert.equal(read.lines.find((l) => l.skuId === a.skus[0]!.id)!.sku.name, a.name);
  assert.equal(read.lines.find((l) => l.skuId === b.skus[0]!.id)!.sku.spec, b.skus[0]!.spec);
  const facts = read.lines.map(({ sku: _sku, ...l }) => l);
  await db.product.update({ where: { id: a.id }, data: { name: '当前目录名称，仅测试资料' } });
  const renamed = await ok<import('../packages/contracts/src/index.ts').ReceiptDetail>(
    route,
    undefined,
    1,
  );
  assert.equal(
    renamed.lines.find((l) => l.skuId === a.skus[0]!.id)!.sku.name,
    '当前目录名称，仅测试资料',
  );
  assert.deepEqual(
    renamed.lines.map(({ sku: _sku, ...l }) => l),
    facts,
  );
  const ledgerCount = await db.stockLedger.count();
  assert.equal((await call(route)).status, 401);
  for (const actor of [2, 3]) {
    const denied = await call(route, { actor });
    assert.equal(denied.status, 403);
    assert.equal(denied.data, undefined);
  }
  assert.equal(
    (await call(`/warehouse/warehouses/${warehouses[1]}/receipts/${receipt.id}`, { actor: 1 }))
      .status,
    403,
  );
  assert.equal(
    (
      await call(`/warehouse/warehouses/${receipt.warehouseId}/receipts/${randomUUID()}`, {
        actor: 1,
      })
    ).status,
    404,
  );
  assert.equal(
    (await call(`/warehouse/warehouses/${receipt.warehouseId}/receipts/not-a-uuid`, { actor: 1 }))
      .status,
    400,
  );
  await db.staffWarehouse.create({ data: { staffId: staffIds[0]!, warehouseId: warehouses[1]! } });
  try {
    assert.equal(
      (await call(`/warehouse/warehouses/${warehouses[1]}/receipts/${receipt.id}`, { actor: 0 }))
        .status,
      404,
    );
  } finally {
    await db.staffWarehouse.delete({
      where: { staffId_warehouseId: { staffId: staffIds[0]!, warehouseId: warehouses[1]! } },
    });
  }
  assert.equal(await db.stockLedger.count(), ledgerCount);
  const reviewed = await approve(receipt);
  assert.equal((await ok<Receipt>(route, undefined, 1)).status, 'APPROVED');
  assert.equal((await post(reviewed)).status, 200);
  const posted = await ok<Receipt>(route, undefined, 1);
  assert.equal(posted.status, 'POSTED');
  assert.equal(posted.version, reviewed.version + 1);
  assert.equal(
    posted.lines.reduce((n, l) => n + l.quantity, 0),
    5,
  );
  checks.push(
    'receipt detail scopes current metadata and state without changing receipt facts or leaking costs',
  );
});

const detailsBody = (
  p: Product,
  extra: Partial<{ name: string; categoryId: string; description: string }> = {},
) => ({
  version: p.version,
  categoryId: p.categoryId,
  name: p.name + '更新',
  description: '',
  ...extra,
});

test('product details read/write enforces permission, authentication and CSRF', async () => {
  const p = await product();
  const route = `/admin/products/${p.id}`;
  assert.equal((await call(route)).status, 401);
  assert.equal((await ok<Product>(route, undefined, 1)).id, p.id);
  assert.equal((await call(route, { actor: 2 })).status, 403);
  assert.equal((await call('/admin/products/not-a-uuid', { actor: 0 })).status, 400);
  assert.equal((await call(`/admin/products/${randomUUID()}`, { actor: 0 })).status, 404);
  for (const actor of [undefined, 1, 2, 3])
    assert.equal(
      (await call(route + '/update-details', { actor, body: detailsBody(p) })).status,
      actor === undefined ? 401 : 403,
    );
  for (const headers of [
    { Cookie: identities[0]!.cookie },
    {
      Cookie: identities[0]!.cookie,
      Origin: 'https://untrusted.invalid',
      'X-CSRF-Token': identities[0]!.csrf,
    },
  ] as Array<Record<string, string>>) {
    const response = await fetch(base + '/api/v1' + route + '/update-details', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
      body: JSON.stringify(detailsBody(p)),
    });
    assert.equal(response.status, 403);
  }
  assert.equal((await ok<Product>(route)).version, p.version);
  assert.equal(
    (
      await call(`/admin/products/${randomUUID()}/update-details`, {
        actor: 0,
        body: detailsBody(p),
      })
    ).status,
    404,
  );
});

test('editing published metadata preserves SKUs, receipt facts and all inventory records', async () => {
  let p = await product();
  const receipt = await approve(await draft([line(p.skus[0]!.id)]));
  assert.equal((await post(receipt)).status, 200);
  p = await publish(p);
  const nextCategory = await ok<Category>('/admin/categories', { name: '编辑后分类' });
  const facts = async () => ({
    sku: await db.sku.findMany({ where: { productId: p.id } }),
    balances: await db.stockBalance.findMany({ where: { skuId: p.skus[0]!.id } }),
    lots: await db.stockLot.findMany({ where: { skuId: p.skus[0]!.id } }),
    positions: await db.stockPosition.findMany({ where: { skuId: p.skus[0]!.id } }),
    lines: await db.inboundLine.findMany({ where: { receiptId: receipt.id } }),
    ledgers: await db.stockLedger.findMany({ where: { skuId: p.skus[0]!.id } }),
  });
  const before = await facts();
  const result = await ok<Product>(
    `/admin/products/${p.id}/update-details`,
    detailsBody(p, { name: ' 新名称 ', categoryId: nextCategory.id, description: ' 新说明 ' }),
  );
  assert.equal(result.name, '新名称');
  assert.equal(result.description, '新说明');
  assert.equal(result.categoryId, nextCategory.id);
  assert.equal(result.status, 'PUBLISHED');
  assert.equal(result.version, p.version + 1);
  assert.deepEqual(await facts(), before);
  const sale = await visible(p.skus[0]!.id);
  assert.equal(sale.data.name, '新名称');
  assert.equal(sale.data.description, '新说明');
  assert.equal(sale.data.priceCents, p.skus[0]!.priceCents);
  assert.equal(sale.data.available, 3);
  const audit = await db.businessAudit.findFirstOrThrow({
    where: { resourceId: p.id, action: 'PRODUCT_UPDATE_DETAILS' },
  });
  assert.equal(audit.actorId, staffIds[0]);
  assert.match(audit.reason!, /name,categoryId,description/);
  checks.push(
    'product metadata edit updates public display without changing SKU, receipt or inventory facts',
  );
});

test('product edit idempotency replays once and current detail remains authoritative after later edits', async () => {
  const p = await product(),
    key = randomUUID(),
    body = detailsBody(p);
  const route = `/admin/products/${p.id}/update-details`;
  const results = await Promise.all(
    Array.from({ length: 8 }, () => call<Product>(route, { actor: 0, body, key })),
  );
  assert(results.every((r) => r.status === 200));
  assert(results.every((r) => r.data.version === p.version + 1));
  assert.equal(
    await db.businessAudit.count({ where: { resourceId: p.id, action: 'PRODUCT_UPDATE_DETAILS' } }),
    1,
  );
  const second = await ok<Product>(
    route,
    detailsBody(results[0]!.data, { name: '之后的当前名称' }),
  );
  const replay = await ok<Product>(route, body, 0, key);
  assert.equal(replay.name, body.name);
  assert.equal(replay.version, p.version + 1);
  assert.equal((await ok<Product>(`/admin/products/${p.id}`)).name, second.name);
  assert.equal(
    (await call(route, { actor: 0, body: { ...body, name: '同键改内容' }, key })).error?.code,
    'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(
    await db.businessAudit.count({ where: { resourceId: p.id, action: 'PRODUCT_UPDATE_DETAILS' } }),
    2,
  );
});

test('concurrent edits and edit versus publish serialize on the product version', async () => {
  for (const againstPublish of [false, true]) {
    const p = await product();
    const requests = [
      call<Product>(`/admin/products/${p.id}/update-details`, { actor: 0, body: detailsBody(p) }),
      againstPublish
        ? call<Product>(`/admin/products/${p.id}/publish`, {
            actor: 0,
            body: { version: p.version },
          })
        : call<Product>(`/admin/products/${p.id}/update-details`, {
            actor: 0,
            body: detailsBody(p, { name: '并发的另一份资料' }),
          }),
    ];
    const result = await Promise.all(requests);
    assert.deepEqual(result.map((r) => r.status).sort(), [200, 409]);
    assert.equal(result.find((r) => r.status === 409)?.error?.code, 'VERSION_CONFLICT');
    assert.equal((await ok<Product>(`/admin/products/${p.id}`)).version, p.version + 1);
  }
});

test('product edit rejects unknown/immutable fields and invalid lengths or versions', async () => {
  const p = await product(),
    body = detailsBody(p),
    route = `/admin/products/${p.id}/update-details`;
  for (const invalid of [
    { ...body, status: 'PUBLISHED' },
    { ...body, skus: [] },
    { ...body, priceCents: 1 },
    { ...body, name: ' ' },
    { ...body, name: '长'.repeat(121) },
    { ...body, description: null },
    { ...body, description: '长'.repeat(2001) },
    { ...body, categoryId: 'bad-id' },
    { ...body, version: 0.5 },
    { ...body, version: -1 },
  ])
    assert.equal((await call(route, { actor: 0, body: invalid })).status, 400);
  assert.equal((await ok<Product>(`/admin/products/${p.id}`)).version, p.version);
});

test('product edit requires enabled category and parent; empty description clears existing text', async () => {
  const p = await product(),
    route = `/admin/products/${p.id}/update-details`;
  const parent = await ok<Category>('/admin/categories', { name: '测试父分类' });
  const child = await ok<Category>('/admin/categories', {
    name: '测试子分类',
    parentId: parent.id,
  });
  await db.category.update({ where: { id: parent.id }, data: { enabled: false } });
  assert.equal(
    (await call(route, { actor: 0, body: detailsBody(p, { categoryId: child.id }) })).status,
    400,
  );
  await db.category.update({ where: { id: parent.id }, data: { enabled: true } });
  await db.category.update({ where: { id: child.id }, data: { enabled: false } });
  assert.equal(
    (await call(route, { actor: 0, body: detailsBody(p, { categoryId: child.id }) })).status,
    400,
  );
  assert.equal(
    (await call(route, { actor: 0, body: detailsBody(p, { categoryId: randomUUID() }) })).status,
    400,
  );
  const cleared = await ok<Product>(route, detailsBody(p));
  assert.equal(cleared.description, '');
  assert.equal(cleared.status, 'DRAFT');
});

test('late edit audit failure rolls back metadata/version and retrying the original intent succeeds', async () => {
  const p = await product(),
    route = `/admin/products/${p.id}/update-details`,
    key = randomUUID(),
    body = detailsBody(p);
  await admin.query(
    "CREATE FUNCTION fail_product_edit_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='PRODUCT_UPDATE_DETAILS' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$",
  );
  await admin.query(
    'CREATE TRIGGER fail_product_edit_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_product_edit_audit()',
  );
  try {
    assert.equal((await call(route, { actor: 0, body, key })).status, 500);
    const current = await ok<Product>(`/admin/products/${p.id}`);
    assert.equal(current.name, p.name);
    assert.equal(current.version, p.version);
    assert.equal(
      await db.businessAudit.count({
        where: { resourceId: p.id, action: 'PRODUCT_UPDATE_DETAILS' },
      }),
      0,
    );
    assert.equal(
      await db.idempotencyRecord.count({
        where: { scope: { endsWith: `:PRODUCT_UPDATE_DETAILS:${p.id}` } },
      }),
      0,
    );
  } finally {
    await admin.query('DROP TRIGGER fail_product_edit_audit ON business_audits');
    await admin.query('DROP FUNCTION fail_product_edit_audit()');
  }
  assert.equal((await ok<Product>(route, body, 0, key)).version, p.version + 1);
  checks.push(
    'product edit audit and idempotency commit atomically, including late-failure rollback',
  );
});

const skuRoute = (p: Product, action: string, skuId = p.skus[0]!.id) =>
  `/admin/products/${p.id}/skus/${skuId}/${action}`;

test('SKU price strict cents, authorization, scope and aggregate version', async () => {
  const p = await product(),
    route = skuRoute(p, 'set-price'),
    body = { version: p.version, priceCents: 29 };
  assert.equal((await call(route, { body })).status, 401);
  for (const actor of [1, 2, 3]) assert.equal((await call(route, { actor, body })).status, 403);
  for (const priceCents of [0, -1, 0.29, 100000001, '29', null])
    assert.equal((await call(route, { actor: 0, body: { ...body, priceCents } })).status, 400);
  for (const invalid of [
    { ...body, enabled: false },
    { ...body, version: -1 },
    { ...body, version: 0.1 },
    { ...body, code: 'OTHER' },
  ])
    assert.equal((await call(route, { actor: 0, body: invalid })).status, 400);
  const other = await product();
  assert.equal(
    (await call(skuRoute(p, 'set-price', other.skus[0]!.id), { actor: 0, body })).status,
    404,
  );
  assert.equal(
    (await call(skuRoute(p, 'set-price', randomUUID()), { actor: 0, body })).status,
    404,
  );
  const response = await fetch(base + '/api/v1' + route, {
    method: 'POST',
    headers: {
      Origin: 'http://127.0.0.1:5173',
      Cookie: identities[0]!.cookie,
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 403);
  const saved = await ok<Product>(route, body);
  assert.equal(saved.skus[0]!.priceCents, 29);
  assert.equal(saved.version, p.version + 1);
  assert.equal(saved.status, 'DRAFT');
  assert.equal((await call(route, { actor: 0, body })).error?.code, 'VERSION_CONFLICT');
  assert.equal(
    (await ok<Product>(route, { version: saved.version, priceCents: 100000000 })).skus[0]!
      .priceCents,
    100000000,
  );
});

test('SKU idempotent replay does not overwrite later price and audit is once', async () => {
  const p = await product(),
    route = skuRoute(p, 'set-price'),
    key = randomUUID(),
    body = { version: p.version, priceCents: 719 };
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => call<Product>(route, { actor: 0, body, key })),
  );
  assert(responses.every((r) => r.status === 200 && r.data.version === p.version + 1));
  assert.equal(
    await db.businessAudit.count({ where: { resourceId: p.skus[0]!.id, action: 'SKU_SET_PRICE' } }),
    1,
  );
  const newer = await ok<Product>(route, { version: p.version + 1, priceCents: 299 });
  assert.equal((await ok<Product>(route, body, 0, key)).skus[0]!.priceCents, 719);
  assert.equal(
    (await ok<Product>(`/admin/products/${p.id}`)).skus[0]!.priceCents,
    newer.skus[0]!.priceCents,
  );
  assert.equal(
    (await call(route, { actor: 0, body: { ...body, priceCents: 720 }, key })).error?.code,
    'IDEMPOTENCY_CONFLICT',
  );
});

test('SKU disable hides public SKU, prevents receipt create/post, retains all stock and cost facts', async () => {
  let p = await product();
  const skuId = p.skus[0]!.id;
  const receipt = await approve(await draft([line(skuId)]));
  assert.equal((await post(receipt)).status, 200);
  const pending = await approve(await draft([line(skuId)]));
  const facts = async () => ({
    balances: await db.stockBalance.findMany({ where: { skuId } }),
    lots: await db.stockLot.findMany({ where: { skuId } }),
    positions: await db.stockPosition.findMany({ where: { skuId } }),
    lines: await db.inboundLine.findMany({ where: { skuId } }),
    ledgers: await db.stockLedger.findMany({ where: { skuId } }),
  });
  const before = await facts();
  p = await publish(p);
  p = await ok<Product>(skuRoute(p, 'set-price'), { version: p.version, priceCents: 29 });
  assert.equal((await visible(skuId)).data.priceCents, 29);
  assert.equal((await visible(skuId)).data.available, 3);
  assert.equal(
    (await call(skuRoute(p, 'disable'), { actor: 0, body: { version: p.version } })).error?.code,
    'LAST_ENABLED_SKU',
  );
  p = await ok<Product>(`/admin/products/${p.id}/unpublish`, { version: p.version });
  p = await ok<Product>(skuRoute(p, 'disable'), { version: p.version });
  assert.equal(p.skus[0]!.enabled, false);
  assert.equal((await visible(skuId)).status, 404);
  assert.equal(
    (
      await call(`/warehouse/warehouses/${warehouses[0]}/receipts`, {
        actor: 1,
        body: { sourceRef: 'disabled', lines: [line(skuId)] },
      })
    ).error?.code,
    'SKU_DISABLED',
  );
  assert.equal((await post(pending)).error?.code, 'SKU_DISABLED');
  assert.deepEqual(await facts(), before);
  assert.equal(
    (await call(`/admin/products/${p.id}/publish`, { actor: 0, body: { version: p.version } }))
      .status,
    409,
  );
  assert.equal(
    (await call(skuRoute(p, 'disable'), { actor: 0, body: { version: p.version } })).error?.code,
    'INVALID_TRANSITION',
  );
  p = await ok<Product>(skuRoute(p, 'enable'), { version: p.version });
  assert.equal(p.status, 'UNPUBLISHED');
  assert.equal((await visible(skuId)).status, 404);
  p = await publish(p);
  assert.equal((await visible(skuId)).data.priceCents, 29);
  assert.deepEqual(await facts(), before);
  assert.equal((await post(pending)).status, 200);
  checks.push(
    'SKU price/enable/disable preserve inventory and historical costs, public/receipt rules enforced',
  );
});

test('published multi-SKU disabling affects only selected SKU and keeps product published', async () => {
  const p0 = await product();
  await db.sku.create({
    data: {
      id: randomUUID(),
      productId: p0.id,
      code: `SECOND-${run}`,
      spec: '2包',
      unit: '包',
      priceCents: 800,
      expiryManaged: false,
    },
  });
  let p = await publish(await ok<Product>(`/admin/products/${p0.id}`));
  const selected = p.skus[0]!,
    other = p.skus[1]!;
  p = await ok<Product>(skuRoute(p, 'disable', selected.id), { version: p.version });
  assert.equal(p.status, 'PUBLISHED');
  assert.equal((await visible(selected.id)).status, 404);
  assert.equal((await visible(other.id)).status, 200);
  assert.equal(
    (await call(skuRoute(p, 'disable', other.id), { actor: 0, body: { version: p.version } })).error
      ?.code,
    'LAST_ENABLED_SKU',
  );
  p = await ok<Product>(skuRoute(p, 'enable', selected.id), { version: p.version });
  assert.equal((await visible(selected.id)).status, 200);
});

test('SKU actions compete with metadata/publish/other SKU actions on one product version', async () => {
  for (const competitor of ['metadata', 'publish', 'disable']) {
    const p = await product();
    const otherRoute =
      competitor === 'metadata'
        ? `/admin/products/${p.id}/update-details`
        : competitor === 'publish'
          ? `/admin/products/${p.id}/publish`
          : skuRoute(p, 'disable');
    const results = await Promise.all([
      call<Product>(skuRoute(p, 'set-price'), {
        actor: 0,
        body: { version: p.version, priceCents: 99 },
      }),
      call<Product>(otherRoute, {
        actor: 0,
        body: competitor === 'metadata' ? detailsBody(p) : { version: p.version },
      }),
    ]);
    assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
    assert.equal(results.find((r) => r.status === 409)?.error?.code, 'VERSION_CONFLICT');
    assert.equal((await ok<Product>(`/admin/products/${p.id}`)).version, p.version + 1);
  }
});

test('late SKU audit failure rolls back price/version and original key can be retried', async () => {
  const p = await product(),
    route = skuRoute(p, 'set-price'),
    key = randomUUID(),
    body = { version: p.version, priceCents: 29 };
  await admin.query(
    "CREATE FUNCTION fail_sku_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='SKU_SET_PRICE' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$",
  );
  await admin.query(
    'CREATE TRIGGER fail_sku_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_sku_audit()',
  );
  try {
    assert.equal((await call(route, { actor: 0, body, key })).status, 500);
    assert.deepEqual(await ok<Product>(`/admin/products/${p.id}`), p);
    assert.equal(
      await db.idempotencyRecord.count({
        where: { scope: { endsWith: `:SKU_SET_PRICE:${p.skus[0]!.id}` } },
      }),
      0,
    );
  } finally {
    await admin.query('DROP TRIGGER fail_sku_audit ON business_audits');
    await admin.query('DROP FUNCTION fail_sku_audit()');
  }
  assert.equal((await ok<Product>(route, body, 0, key)).version, p.version + 1);
});

test('receipt posting versus SKU disabling serializes: posted stock is complete or unchanged', async () => {
  for (let i = 0; i < 4; i++) {
    const p = await product(),
      skuId = p.skus[0]!.id;
    const receipt = await approve(await draft([line(skuId, 7)]));
    const [posting, disabling] = await Promise.all([
      post(receipt),
      call<Product>(skuRoute(p, 'disable'), { actor: 0, body: { version: p.version } }),
    ]);
    assert.equal(disabling.status, 200);
    assert.equal(disabling.data.skus[0]!.enabled, false);
    const count = await db.stockLedger.count({ where: { skuId } });
    if (posting.status === 200) {
      assert.equal(count, 1);
      assert.equal((await db.stockBalance.findFirstOrThrow({ where: { skuId } })).onHand, 7);
    } else {
      assert.equal(posting.status, 409);
      assert.equal(posting.error?.code, 'SKU_DISABLED');
      assert.equal(count, 0);
      assert.equal(await db.stockBalance.count({ where: { skuId } }), 0);
      assert.equal(
        (await db.inboundReceipt.findUniqueOrThrow({ where: { id: receipt.id } })).status,
        'APPROVED',
      );
    }
  }
});

const categoryRoute = (c: Category, action: string) => `/admin/categories/${c.id}/${action}`;

test('category maintenance validates version/fields/auth/CSRF and reads parent without changing hierarchy', async () => {
  const parent = await ok<Category>('/admin/categories', { name: '分类父项' });
  const c = await ok<Category>('/admin/categories', { name: '分类子项', parentId: parent.id });
  assert.equal(c.version, 0);
  await assert.rejects(db.category.update({ where: { id: c.id }, data: { version: -1 } }));
  const route = categoryRoute(c, 'rename'),
    body = { version: c.version, name: ' 新分类名 ' };
  assert.equal((await call(route, { body })).status, 401);
  assert.equal((await call(`/admin/categories/${c.id}`)).status, 401);
  for (const actor of [1, 2, 3]) assert.equal((await call(route, { actor, body })).status, 403);
  const detail = await ok<Category & { parent: Category }>(
    `/admin/categories/${c.id}`,
    undefined,
    1,
  );
  assert.equal(detail.parent.id, parent.id);
  assert.equal(detail.parent.version, 0);
  assert.equal((await call(`/admin/categories/${randomUUID()}`, { actor: 0 })).status, 404);
  assert.equal((await call('/admin/categories/bad-id', { actor: 0 })).status, 400);
  for (const invalid of [
    { ...body, name: ' ' },
    { ...body, name: '长'.repeat(81) },
    { ...body, version: -1 },
    { ...body, version: 0.2 },
    { ...body, parentId: null },
    { ...body, enabled: false },
  ])
    assert.equal((await call(route, { actor: 0, body: invalid })).status, 400);
  const response = await fetch(base + '/api/v1' + route, {
    method: 'POST',
    headers: {
      Origin: 'http://127.0.0.1:5173',
      Cookie: identities[0]!.cookie,
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 403);
  const updated = await ok<Category>(route, body);
  assert.equal(updated.name, '新分类名');
  assert.equal(updated.parentId, parent.id);
  assert.equal(updated.enabled, true);
  assert.equal(updated.version, 1);
  assert.equal((await call(route, { actor: 0, body })).error?.code, 'VERSION_CONFLICT');
});

test('category idempotency concurrent replay, later rename and disable retain current authority', async () => {
  let c = await ok<Category>('/admin/categories', { name: '分类幂等' });
  const route = categoryRoute(c, 'rename'),
    key = randomUUID(),
    body = { version: c.version, name: '首次分类名' };
  const results = await Promise.all(
    Array.from({ length: 8 }, () => call<Category>(route, { actor: 0, body, key })),
  );
  assert(results.every((r) => r.status === 200 && r.data.version === 1));
  assert.equal(
    await db.businessAudit.count({ where: { resourceId: c.id, action: 'CATEGORY_RENAME' } }),
    1,
  );
  c = await ok<Category>(route, { version: 1, name: '当前分类名' });
  c = await ok<Category>(categoryRoute(c, 'disable'), { version: c.version });
  assert.equal((await ok<Category>(route, body, 0, key)).name, '首次分类名');
  const now = await ok<Category>(`/admin/categories/${c.id}`);
  assert.equal(now.name, '当前分类名');
  assert.equal(now.enabled, false);
  assert.equal(
    (await call(route, { actor: 0, body: { ...body, name: '同键改名' }, key })).error?.code,
    'IDEMPOTENCY_CONFLICT',
  );
  assert.equal(
    (await call(categoryRoute(c, 'disable'), { actor: 0, body: { version: c.version } })).error
      ?.code,
    'INVALID_TRANSITION',
  );
});

test('parent disable hides descendant products without rewriting children, products, SKUs, receipt or inventory', async () => {
  let parent = await ok<Category>('/admin/categories', { name: '可见父分类' });
  let child = await ok<Category>('/admin/categories', { name: '可见子分类', parentId: parent.id });
  let p = await product();
  p = await ok<Product>(
    `/admin/products/${p.id}/update-details`,
    detailsBody(p, { categoryId: child.id }),
  );
  const skuId = p.skus[0]!.id;
  const receipt = await approve(await draft([line(skuId)]));
  assert.equal((await post(receipt)).status, 200);
  p = await publish(p);
  const facts = async () => ({
    product: await db.product.findUnique({ where: { id: p.id }, include: { skus: true } }),
    child: await db.category.findUnique({ where: { id: child.id } }),
    balances: await db.stockBalance.findMany({ where: { skuId } }),
    lots: await db.stockLot.findMany({ where: { skuId } }),
    positions: await db.stockPosition.findMany({ where: { skuId } }),
    lines: await db.inboundLine.findMany({ where: { skuId } }),
    ledgers: await db.stockLedger.findMany({ where: { skuId } }),
  });
  const before = await facts();
  parent = await ok<Category>(categoryRoute(parent, 'disable'), { version: parent.version });
  assert.equal((await visible(skuId)).status, 404);
  assert.deepEqual(await facts(), before);
  const listing = await call<Page<SaleSku>>(`/products?categoryId=${child.id}&limit=50`);
  assert(!listing.data.items.some((s) => s.id === skuId));
  assert.equal(
    (
      await call('/admin/categories', {
        actor: 0,
        body: { name: '被禁父级下新建', parentId: parent.id },
      })
    ).status,
    400,
  );
  const newInput = {
    categoryId: child.id,
    name: '禁分类新商品',
    skus: [
      { code: `BLOCK-${run}`, spec: '1包', unit: '包', priceCents: 100, expiryManaged: false },
    ],
  };
  assert.equal((await call('/admin/products', { actor: 0, body: newInput })).status, 400);
  assert.equal(
    (await call(`/admin/products/${p.id}/update-details`, { actor: 0, body: detailsBody(p) }))
      .status,
    400,
  );
  // Warehouse receipt operations depend on SKU, not catalog visibility.
  assert.equal((await post(await approve(await draft([line(skuId)])))).status, 200);
  child = await ok<Category>(categoryRoute(child, 'disable'), { version: child.version });
  assert.equal(
    (await call(categoryRoute(child, 'enable'), { actor: 0, body: { version: child.version } }))
      .error?.code,
    'PARENT_DISABLED',
  );
  parent = await ok<Category>(categoryRoute(parent, 'enable'), { version: parent.version });
  assert.equal((await visible(skuId)).status, 404);
  child = await ok<Category>(categoryRoute(child, 'enable'), { version: child.version });
  assert.equal((await visible(skuId)).status, 200);
  const renamed = await ok<Category>(categoryRoute(child, 'rename'), {
    version: child.version,
    name: '新子分类名',
  });
  assert.equal(renamed.parentId, parent.id);
  assert.equal((await db.product.findUniqueOrThrow({ where: { id: p.id } })).version, p.version);
  checks.push(
    'category ancestor visibility, own child state, stock/cost preservation and warehouse independence',
  );
});

test('category competing actions share version; parent disable and child enable serialize safely', async () => {
  const c = await ok<Category>('/admin/categories', { name: '分类竞争' });
  const result = await Promise.all([
    call(categoryRoute(c, 'rename'), { actor: 0, body: { version: c.version, name: '竞争名' } }),
    call(categoryRoute(c, 'disable'), { actor: 0, body: { version: c.version } }),
  ]);
  assert.deepEqual(result.map((r) => r.status).sort(), [200, 409]);
  assert.equal(result.find((r) => r.status === 409)?.error?.code, 'VERSION_CONFLICT');
  for (let i = 0; i < 4; i++) {
    const parent = await ok<Category>('/admin/categories', { name: '父级竞争' });
    let child = await ok<Category>('/admin/categories', { name: '子级竞争', parentId: parent.id });
    child = await ok<Category>(categoryRoute(child, 'disable'), { version: 0 });
    const [disabled, enabled] = await Promise.all([
      call<Category>(categoryRoute(parent, 'disable'), { actor: 0, body: { version: 0 } }),
      call<Category>(categoryRoute(child, 'enable'), {
        actor: 0,
        body: { version: child.version },
      }),
    ]);
    assert.equal(disabled.status, 200);
    assert([200, 409].includes(enabled.status));
    if (enabled.status === 409) assert.equal(enabled.error?.code, 'PARENT_DISABLED');
    assert.equal((await ok<Category>(`/admin/categories/${parent.id}`)).enabled, false);
  }
});

test('category disable races with product creation/publication without deadlocks or invalid visibility', async () => {
  for (let i = 0; i < 3; i++) {
    const c = await ok<Category>('/admin/categories', { name: '商品分类竞争' });
    let p = await product();
    p = await ok<Product>(
      `/admin/products/${p.id}/update-details`,
      detailsBody(p, { categoryId: c.id }),
    );
    const [disabled, published, created] = await Promise.all([
      call(categoryRoute(c, 'disable'), { actor: 0, body: { version: c.version } }),
      call(`/admin/products/${p.id}/publish`, { actor: 0, body: { version: p.version } }),
      call('/admin/products', {
        actor: 0,
        body: {
          categoryId: c.id,
          name: '并发新商品',
          skus: [
            {
              code: `RACE-CAT-${run}-${i}`,
              spec: '1包',
              unit: '包',
              priceCents: 100,
              expiryManaged: false,
            },
          ],
        },
      }),
    ]);
    assert.equal(disabled.status, 200);
    assert([200, 409].includes(published.status));
    assert([200, 400].includes(created.status));
    assert.equal((await visible(p.skus[0]!.id)).status, 404);
  }
});

test('category late audit failure rolls back version/state and original key retries', async () => {
  const c = await ok<Category>('/admin/categories', { name: '分类回滚' }),
    key = randomUUID(),
    route = categoryRoute(c, 'disable'),
    body = { version: c.version };
  await admin.query(
    "CREATE FUNCTION fail_category_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='CATEGORY_DISABLE' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$",
  );
  await admin.query(
    'CREATE TRIGGER fail_category_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_category_audit()',
  );
  try {
    assert.equal((await call(route, { actor: 0, body, key })).status, 500);
    const now = await ok<Category>(`/admin/categories/${c.id}`);
    assert.equal(now.enabled, true);
    assert.equal(now.version, 0);
    assert.equal(
      await db.idempotencyRecord.count({
        where: { scope: { endsWith: `:CATEGORY_DISABLE:${c.id}` } },
      }),
      0,
    );
  } finally {
    await admin.query('DROP TRIGGER fail_category_audit ON business_audits');
    await admin.query('DROP FUNCTION fail_category_audit()');
  }
  assert.equal((await ok<Category>(route, body, 0, key)).enabled, false);
});

test('SKU spec update validates auth, CSRF, ownership, strict text and immutable fields', async () => {
  const p = await product(),
    route = skuRoute(p, 'update-spec'),
    body = { version: p.version, spec: ' 1包装（说明更正） ' };
  assert.equal((await call(route, { body })).status, 401);
  for (const actor of [1, 2, 3]) assert.equal((await call(route, { actor, body })).status, 403);
  for (const invalid of [
    { ...body, spec: ' ' },
    { ...body, spec: '长'.repeat(101) },
    { ...body, spec: null },
    { ...body, version: -1 },
    { ...body, version: 1.2 },
    { ...body, code: 'OTHER' },
    { ...body, unit: '箱' },
    { ...body, priceCents: 1 },
    { ...body, enabled: false },
    { ...body, expiryManaged: true },
  ])
    assert.equal((await call(route, { actor: 0, body: invalid })).status, 400);
  const other = await product();
  assert.equal(
    (await call(skuRoute(p, 'update-spec', other.skus[0]!.id), { actor: 0, body })).status,
    404,
  );
  assert.equal(
    (await call(skuRoute(p, 'update-spec', randomUUID()), { actor: 0, body })).status,
    404,
  );
  assert.equal(
    (
      await call(`/admin/products/${randomUUID()}/skus/${p.skus[0]!.id}/update-spec`, {
        actor: 0,
        body,
      })
    ).status,
    404,
  );
  const response = await fetch(base + '/api/v1' + route, {
    method: 'POST',
    headers: {
      Origin: 'http://127.0.0.1:5173',
      Cookie: identities[0]!.cookie,
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify(body),
  });
  assert.equal(response.status, 403);
  const changed = await ok<Product>(route, body);
  assert.equal(changed.skus[0]!.spec, '1包装（说明更正）');
  assert.equal(changed.version, p.version + 1);
  assert.equal((await call(route, { actor: 0, body })).error?.code, 'VERSION_CONFLICT');
  const max = '长'.repeat(100);
  assert.equal(
    (await ok<Product>(route, { version: changed.version, spec: max })).skus[0]!.spec,
    max,
  );
});

test('published SKU spec display changes while stock, costs, units, other SKUs and status remain unchanged', async () => {
  let p = await product();
  const skuId = p.skus[0]!.id;
  await db.sku.create({
    data: {
      id: randomUUID(),
      productId: p.id,
      code: `SPEC-SECOND-${run}`,
      spec: '单件装',
      unit: '件',
      priceCents: 800,
      expiryManaged: false,
    },
  });
  const receipt = await approve(await draft([line(skuId)]));
  assert.equal((await post(receipt)).status, 200);
  p = await publish(await ok<Product>(`/admin/products/${p.id}`));
  const facts = async () => ({
    balances: await db.stockBalance.findMany({ where: { skuId } }),
    lots: await db.stockLot.findMany({ where: { skuId } }),
    positions: await db.stockPosition.findMany({ where: { skuId } }),
    lines: await db.inboundLine.findMany({ where: { skuId } }),
    ledgers: await db.stockLedger.findMany({ where: { skuId } }),
    positionLedgers: await db.positionLedger.findMany({ where: { skuId } }),
  });
  const before = await facts(),
    spec = '1包装（原包装，文字更正）';
  const updated = await ok<Product>(skuRoute(p, 'update-spec', skuId), {
    version: p.version,
    spec,
  });
  assert.equal(updated.status, 'PUBLISHED');
  assert.equal(updated.version, p.version + 1);
  const expected = structuredClone(p);
  expected.version++;
  expected.skus.find((s) => s.id === skuId)!.spec = spec;
  assert.deepEqual(updated, expected);
  assert.deepEqual(await facts(), before);
  const sale = await visible(skuId);
  assert.equal(sale.data.spec, spec);
  assert.equal(sale.data.priceCents, 450);
  assert.equal(sale.data.available, 3);
  const detail = await ok<
    Receipt & { lines: Array<{ sku: { spec: string }; quantity: number; unitCostCents: number }> }
  >(`/warehouse/warehouses/${receipt.warehouseId}/receipts/${receipt.id}`, undefined, 1);
  assert.equal(detail.lines[0]!.sku.spec, spec);
  assert.equal(detail.lines[0]!.quantity, 3);
  assert.equal(detail.lines[0]!.unitCostCents, 200);
  checks.push(
    'SKU description changes current public/warehouse display only; identifiers, units, inventory and costs unchanged',
  );
});

test('SKU spec idempotent replay, historical response, disabled editing and current authority', async () => {
  let p = await product();
  const key = randomUUID(),
    route = skuRoute(p, 'update-spec'),
    body = { version: p.version, spec: '1包装（说明一）' };
  const results = await Promise.all(
    Array.from({ length: 8 }, () => call<Product>(route, { actor: 0, body, key })),
  );
  assert(results.every((r) => r.status === 200 && r.data.version === p.version + 1));
  assert.equal(
    await db.businessAudit.count({
      where: { resourceId: p.skus[0]!.id, action: 'SKU_UPDATE_SPEC' },
    }),
    1,
  );
  p = await ok<Product>(route, { version: p.version + 1, spec: '1包装（说明二）' });
  assert.equal((await ok<Product>(route, body, 0, key)).skus[0]!.spec, body.spec);
  assert.equal((await ok<Product>(`/admin/products/${p.id}`)).skus[0]!.spec, '1包装（说明二）');
  assert.equal(
    (await call(route, { actor: 0, body: { ...body, spec: '同键改文' }, key })).error?.code,
    'IDEMPOTENCY_CONFLICT',
  );
  p = await ok<Product>(skuRoute(p, 'disable'), { version: p.version });
  p = await ok<Product>(route, { version: p.version, spec: '1包装（停用时更正）' });
  assert.equal(p.skus[0]!.enabled, false);
  assert.equal(p.status, 'DRAFT');
  assert.equal((await visible(p.skus[0]!.id)).status, 404);
});

test('SKU spec competes with price, enable state, product metadata and publishing on one version', async () => {
  for (const competitor of ['price', 'disable', 'metadata', 'publish']) {
    const p = await product();
    const route =
      competitor === 'price'
        ? skuRoute(p, 'set-price')
        : competitor === 'disable'
          ? skuRoute(p, 'disable')
          : `/admin/products/${p.id}/${competitor === 'metadata' ? 'update-details' : 'publish'}`;
    const body =
      competitor === 'price'
        ? { version: p.version, priceCents: 99 }
        : competitor === 'metadata'
          ? detailsBody(p)
          : { version: p.version };
    const result = await Promise.all([
      call(skuRoute(p, 'update-spec'), {
        actor: 0,
        body: { version: p.version, spec: '1包装（并发更正）' },
      }),
      call(route, { actor: 0, body }),
    ]);
    assert.deepEqual(result.map((r) => r.status).sort(), [200, 409]);
    assert.equal(result.find((r) => r.status === 409)?.error?.code, 'VERSION_CONFLICT');
    assert.equal((await ok<Product>(`/admin/products/${p.id}`)).version, p.version + 1);
  }
});

test('late SKU spec audit failure rolls back text and version and original key retries', async () => {
  const p = await product(),
    route = skuRoute(p, 'update-spec'),
    key = randomUUID(),
    body = { version: p.version, spec: '1包装（回滚验证）' };
  await admin.query(
    "CREATE FUNCTION fail_sku_spec_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='SKU_UPDATE_SPEC' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$",
  );
  await admin.query(
    'CREATE TRIGGER fail_sku_spec_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_sku_spec_audit()',
  );
  try {
    assert.equal((await call(route, { actor: 0, body, key })).status, 500);
    assert.deepEqual(await ok<Product>(`/admin/products/${p.id}`), p);
    assert.equal(
      await db.idempotencyRecord.count({
        where: { scope: { endsWith: `:SKU_UPDATE_SPEC:${p.skus[0]!.id}` } },
      }),
      0,
    );
  } finally {
    await admin.query('DROP TRIGGER fail_sku_spec_audit ON business_audits');
    await admin.query('DROP FUNCTION fail_sku_spec_audit()');
  }
  assert.equal((await ok<Product>(route, body, 0, key)).skus[0]!.spec, body.spec);
});
