import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir, mkdir, writeFile, rm } from 'node:fs/promises';
import { createDatabase, hashPassword } from '../packages/database/src/index.ts';
import { createApplication } from '../apps/api/dist/app.js';
import { applicationConfig } from '../apps/api/dist/config.js';
import type {
  ProductGallery,
  PublicCategory,
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
      PRODUCT_IMAGE_LOCAL_DIR: `.local/test-images-${schema}`,
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
    await rm(`.local/test-images-${schema}`, { recursive: true, force: true });
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
  const byId = (rows: Product['skus']) => [...rows].sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(
    { ...updated, skus: byId(updated.skus) },
    { ...expected, skus: byId(expected.skus) },
  );
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

test('barcode validates auth/CSRF, ownership, strict string format, length and leading zeros', async () => {
  const p = await product(),
    route = skuRoute(p, 'set-barcode'),
    body = { version: p.version, barcode: ' 0012345678901 ' };
  assert.equal(p.skus[0]!.barcode, null);
  assert.equal((await call(route, { body })).status, 401);
  for (const actor of [1, 2, 3]) assert.equal((await call(route, { actor, body })).status, 403);
  for (const invalid of [
    { ...body, barcode: 123456789 },
    { ...body, barcode: '123 456' },
    { ...body, barcode: 'abc' },
    { ...body, barcode: '１２３' },
    { ...body, barcode: '1'.repeat(65) },
    { version: p.version },
    { ...body, version: -1 },
    { ...body, unit: '箱' },
    { ...body, enabled: false },
  ])
    assert.equal((await call(route, { actor: 0, body: invalid })).status, 400);
  const other = await product();
  assert.equal(
    (await call(skuRoute(p, 'set-barcode', other.skus[0]!.id), { actor: 0, body })).status,
    404,
  );
  assert.equal(
    (await call(skuRoute(p, 'set-barcode', randomUUID()), { actor: 0, body })).status,
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
  let changed = await ok<Product>(route, body);
  assert.equal(changed.skus[0]!.barcode, '0012345678901');
  assert.equal(changed.version, 1);
  changed = await ok<Product>(route, { version: changed.version, barcode: '9'.repeat(64) });
  assert.equal(changed.skus[0]!.barcode!.length, 64);
  changed = await ok<Product>(route, { version: changed.version, barcode: ' ' });
  assert.equal(changed.skus[0]!.barcode, null);
});

test('barcode uniqueness races across products, disabled binding persists, clearing permits safe reuse', async () => {
  const products = [await product(), await product()],
    barcode = '0000000000042',
    keys = [randomUUID(), randomUUID()];
  const results = await Promise.all(
    products.map((p, i) =>
      call<Product>(skuRoute(p, 'set-barcode'), {
        actor: 0,
        key: keys[i]!,
        body: { version: p.version, barcode },
      }),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const winner = results.findIndex((r) => r.status === 200),
    loser = 1 - winner;
  assert.equal(results[loser]!.error?.code, 'BARCODE_IN_USE');
  const losing = products[loser]!,
    winning = products[winner]!;
  assert.equal((await ok<Product>(`/admin/products/${losing.id}`)).version, 0);
  assert.equal(
    await db.businessAudit.count({
      where: { resourceId: losing.skus[0]!.id, action: 'SKU_SET_BARCODE' },
    }),
    0,
  );
  assert.equal(
    await db.idempotencyRecord.count({
      where: { scope: { endsWith: `:SKU_SET_BARCODE:${losing.skus[0]!.id}` } },
    }),
    0,
  );
  let current = results[winner]!.data;
  current = await ok<Product>(skuRoute(current, 'disable'), { version: current.version });
  assert.equal(
    (
      await call(skuRoute(losing, 'set-barcode'), {
        actor: 0,
        key: keys[loser]!,
        body: { version: 0, barcode },
      })
    ).error?.code,
    'BARCODE_IN_USE',
  );
  await ok<Product>(skuRoute(current, 'set-barcode'), {
    version: current.version,
    barcode: null,
  });
  const reused = await ok<Product>(
    skuRoute(losing, 'set-barcode'),
    { version: 0, barcode },
    0,
    keys[loser],
  );
  assert.equal(reused.skus[0]!.barcode, barcode);
  // Historical replay must not steal a barcode since rebound to another SKU.
  assert.equal(
    (await ok<Product>(skuRoute(winning, 'set-barcode'), { version: 0, barcode }, 0, keys[winner]))
      .skus[0]!.barcode,
    barcode,
  );
  assert.equal((await ok<Product>(`/admin/products/${winning.id}`)).skus[0]!.barcode, null);
  assert.equal((await ok<Product>(`/admin/products/${losing.id}`)).skus[0]!.barcode, barcode);
});

test('barcode changes leave product status, public data, SKU identity and all inventory/cost facts unchanged', async () => {
  let p = await product();
  const skuId = p.skus[0]!.id;
  const receipt = await approve(await draft([line(skuId)]));
  assert.equal((await post(receipt)).status, 200);
  p = await publish(p);
  const facts = async () => ({
    balances: await db.stockBalance.findMany({ where: { skuId } }),
    lots: await db.stockLot.findMany({ where: { skuId } }),
    positions: await db.stockPosition.findMany({ where: { skuId } }),
    lines: await db.inboundLine.findMany({ where: { skuId } }),
    ledgers: await db.stockLedger.findMany({ where: { skuId } }),
    positionLedgers: await db.positionLedger.findMany({ where: { skuId } }),
  });
  const before = await facts(),
    publicBefore = await visible(skuId);
  const updated = await ok<Product>(skuRoute(p, 'set-barcode'), {
    version: p.version,
    barcode: '0000000123456',
  });
  const expected = structuredClone(p);
  expected.version++;
  expected.skus[0]!.barcode = '0000000123456';
  assert.deepEqual(updated, expected);
  assert.deepEqual(await facts(), before);
  assert.deepEqual((await visible(skuId)).data, publicBefore.data);
  const cleared = await ok<Product>(skuRoute(updated, 'set-barcode'), {
    version: updated.version,
    barcode: null,
  });
  assert.equal(cleared.skus[0]!.barcode, null);
  assert.equal(cleared.status, 'PUBLISHED');
  assert.deepEqual(await facts(), before);
  checks.push(
    'barcode binding/clearing preserve public data, units, inventory and historical costs',
  );
});

test('barcode idempotent concurrency replays once and differing content is rejected', async () => {
  const p = await product(),
    route = skuRoute(p, 'set-barcode'),
    key = randomUUID(),
    body = { version: 0, barcode: '0000000000099' };
  const results = await Promise.all(
    Array.from({ length: 8 }, () => call<Product>(route, { actor: 0, key, body })),
  );
  assert(results.every((r) => r.status === 200 && r.data.version === 1));
  assert.equal(
    await db.businessAudit.count({
      where: { resourceId: p.skus[0]!.id, action: 'SKU_SET_BARCODE' },
    }),
    1,
  );
  assert.equal(
    (await call(route, { actor: 0, key, body: { ...body, barcode: null } })).error?.code,
    'IDEMPOTENCY_CONFLICT',
  );
  assert.equal((await call(route, { actor: 0, body })).error?.code, 'VERSION_CONFLICT');
});

test('barcode and SKU spec/price/disable/product publication share product version', async () => {
  for (const competitor of ['spec', 'price', 'disable', 'publish']) {
    const p = await product(),
      route =
        competitor === 'publish'
          ? `/admin/products/${p.id}/publish`
          : skuRoute(
              p,
              competitor === 'spec'
                ? 'update-spec'
                : competitor === 'price'
                  ? 'set-price'
                  : 'disable',
            );
    const body =
      competitor === 'spec'
        ? { version: 0, spec: '1包装（同规格）' }
        : competitor === 'price'
          ? { version: 0, priceCents: 101 }
          : { version: 0 };
    const result = await Promise.all([
      call(skuRoute(p, 'set-barcode'), {
        actor: 0,
        body: {
          version: 0,
          barcode: `99999${['spec', 'price', 'disable', 'publish'].indexOf(competitor)}`,
        },
      }),
      call(route, { actor: 0, body }),
    ]);
    assert.deepEqual(result.map((r) => r.status).sort(), [200, 409]);
    assert.equal(result.find((r) => r.status === 409)?.error?.code, 'VERSION_CONFLICT');
  }
});

test('barcode database constraints and late audit failure roll back binding/version before original-key retry', async () => {
  const p = await product(),
    route = skuRoute(p, 'set-barcode'),
    key = randomUUID(),
    body = { version: 0, barcode: '0000000011111' };
  await assert.rejects(db.sku.update({ where: { id: p.skus[0]!.id }, data: { barcode: '' } }));
  await assert.rejects(
    db.sku.update({ where: { id: p.skus[0]!.id }, data: { barcode: 'not-digits' } }),
  );
  await admin.query(
    "CREATE FUNCTION fail_barcode_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='SKU_SET_BARCODE' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$",
  );
  await admin.query(
    'CREATE TRIGGER fail_barcode_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_barcode_audit()',
  );
  try {
    assert.equal((await call(route, { actor: 0, key, body })).status, 500);
    assert.deepEqual(await ok<Product>(`/admin/products/${p.id}`), p);
    assert.equal(
      await db.idempotencyRecord.count({
        where: { scope: { endsWith: `:SKU_SET_BARCODE:${p.skus[0]!.id}` } },
      }),
      0,
    );
  } finally {
    await admin.query('DROP TRIGGER fail_barcode_audit ON business_audits');
    await admin.query('DROP FUNCTION fail_barcode_audit()');
  }
  assert.equal((await ok<Product>(route, body, 0, key)).skus[0]!.barcode, body.barcode);
});

const lookupRoute = (barcode: string, warehouseId = warehouses[0]!) =>
  `/warehouse/warehouses/${warehouseId}/skus/by-barcode?barcode=${encodeURIComponent(barcode)}`;
test('receipt barcode lookup is exact, text-preserving and enforces permissions/warehouse scope', async () => {
  const p = await product(),
    skuId = p.skus[0]!.id,
    barcode = '0000000005555';
  await ok<Product>(skuRoute(p, 'set-barcode'), { version: p.version, barcode });
  assert.equal((await call(lookupRoute(barcode))).status, 401);
  for (const actor of [2, 3])
    assert.equal((await call(lookupRoute(barcode), { actor })).status, 403);
  assert.equal((await call(lookupRoute(barcode, warehouses[1]!), { actor: 1 })).status, 403);
  for (const value of ['', '5555', '555', 'abc', '１２３', '1'.repeat(65)])
    assert.equal(
      (await call(lookupRoute(value), { actor: 1 })).status,
      value && /^[0-9]{1,64}$/.test(value) ? 404 : 400,
    );
  assert.equal((await call(lookupRoute(barcode) + '&extra=1', { actor: 1 })).status, 400);
  const result = await ok<import('../packages/contracts/src/index.ts').ReceiptSkuLookup>(
    lookupRoute(' ' + barcode + ' '),
    undefined,
    1,
  );
  assert.equal(result.id, skuId);
  assert.equal(result.name, p.name);
  assert.equal(result.barcode, barcode);
  assert.equal(result.spec, p.skus[0]!.spec);
  await db.warehouse.update({ where: { id: warehouses[0]! }, data: { enabled: false } });
  try {
    assert.equal((await call(lookupRoute(barcode), { actor: 1 })).status, 403);
  } finally {
    await db.warehouse.update({ where: { id: warehouses[0]! }, data: { enabled: true } });
  }
});

test('receipt lookup includes drafts/unpublished/category-disabled and disabled SKU status without writing business data', async () => {
  let p = await product();
  const barcode = '0000000006666';
  p = await ok<Product>(skuRoute(p, 'set-barcode'), { version: p.version, barcode });
  const before = {
    audits: await db.businessAudit.count(),
    receipts: await db.inboundReceipt.count(),
    stock: await db.stockLedger.count(),
  };
  const read = () =>
    ok<import('../packages/contracts/src/index.ts').ReceiptSkuLookup>(
      lookupRoute(barcode),
      undefined,
      1,
    );
  assert.equal((await read()).id, p.skus[0]!.id);
  const cat = await db.category.findUniqueOrThrow({ where: { id: p.categoryId } });
  await db.category.update({ where: { id: cat.id }, data: { enabled: false } });
  try {
    assert.equal((await read()).enabled, true);
  } finally {
    await db.category.update({ where: { id: cat.id }, data: { enabled: true } });
  }
  assert.deepEqual(
    {
      audits: await db.businessAudit.count(),
      receipts: await db.inboundReceipt.count(),
      stock: await db.stockLedger.count(),
    },
    before,
  );
  p = await ok<Product>(skuRoute(p, 'disable'), { version: p.version });
  assert.equal((await read()).enabled, false);
  assert.equal(
    (
      await call(`/warehouse/warehouses/${warehouses[0]}/receipts`, {
        actor: 1,
        body: { sourceRef: '停用查询候选不可收货', lines: [line(p.skus[0]!.id)] },
      })
    ).error?.code,
    'SKU_DISABLED',
  );
});

test('barcode lookup follows clearing/rebinding and selected SKU creates receipt through existing stock safeguards', async () => {
  let a = await product();
  const b = await product(),
    barcode = '0000000007777';
  a = await ok<Product>(skuRoute(a, 'set-barcode'), { version: a.version, barcode });
  const first = await ok<import('../packages/contracts/src/index.ts').ReceiptSkuLookup>(
    lookupRoute(barcode),
    undefined,
    1,
  );
  assert.equal(first.id, a.skus[0]!.id);
  a = await ok<Product>(skuRoute(a, 'set-barcode'), { version: a.version, barcode: null });
  assert.equal((await call(lookupRoute(barcode), { actor: 1 })).error?.code, 'BARCODE_NOT_FOUND');
  await ok<Product>(skuRoute(b, 'set-barcode'), { version: b.version, barcode });
  const current = await ok<import('../packages/contracts/src/index.ts').ReceiptSkuLookup>(
    lookupRoute(barcode),
    undefined,
    1,
  );
  assert.equal(current.id, b.skus[0]!.id);
  const receipt = await draft([line(current.id, 2)]);
  assert.equal(await db.stockBalance.count({ where: { skuId: current.id } }), 0);
  assert.equal((await post(await approve(receipt))).status, 200);
  assert.equal(
    (await db.stockBalance.findFirstOrThrow({ where: { skuId: current.id } })).onHand,
    2,
  );
  assert.equal(await db.stockBalance.count({ where: { skuId: first.id } }), 0);
  checks.push(
    'exact authorized barcode lookup follows binding, read-only; explicit receipt selection still uses normal guards',
  );
});

async function imageFile(name = 'image-red.png') {
  return {
    fileName: name,
    mime: name.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
    base64: (await readFile(`tests/fixtures/${name}`)).toString('base64'),
  };
}
const imageRoute = (p: Product) => `/admin/products/${p.id}/set-image`;
const photoUrl = (p: Product, publicRead = false) =>
  publicRead
    ? `/product-images/${p.id}/${p.imageId}`
    : `/admin/products/${p.id}/image/${p.imageId}`;
async function photo(p: Product, actor?: number, publicRead = false) {
  return fetch(base + '/api/v1' + photoUrl(p, publicRead), {
    headers: actor === undefined ? {} : { Cookie: identities[actor]!.cookie },
  });
}
test('product image upload authorizes, strictly validates bytes/type/extension/decode/dimensions and JSON bounds', async () => {
  const p = await product(),
    image = await imageFile(),
    body = { version: p.version, image },
    route = imageRoute(p);
  assert.equal((await call(route, { body })).status, 401);
  for (const actor of [1, 2, 3]) assert.equal((await call(route, { actor, body })).status, 403);
  const noCsrf = await fetch(base + '/api/v1' + route, {
    method: 'POST',
    headers: {
      Cookie: identities[0]!.cookie,
      Origin: 'http://127.0.0.1:5173',
      'Content-Type': 'application/json',
      'Idempotency-Key': randomUUID(),
    },
    body: JSON.stringify(body),
  });
  assert.equal(noCsrf.status, 403);
  for (const invalid of [
    { ...body, status: 'PUBLISHED' },
    { ...body, version: -1 },
    { ...body, image: { ...image, extra: true } },
    { ...body, image: { ...image, fileName: '../a.png' } },
    { ...body, image: { ...image, fileName: 'a.svg' } },
    { ...body, image: { ...image, mime: 'image/jpeg' } },
    {
      ...body,
      image: {
        ...image,
        base64: Buffer.from('<svg><script>bad()</script></svg>').toString('base64'),
      },
    },
    { ...body, image: { ...image, base64: image.base64.slice(0, 48) } },
    { ...body, image: await imageFile('image-tiny.png') },
    { ...body, image: await imageFile('image-wide.png') },
    { ...body, image: { ...image, base64: Buffer.alloc(2097153).toString('base64') } },
  ])
    assert.equal((await call(route, { actor: 0, body: invalid })).status, 400);
  assert.equal(
    (
      await call(route, {
        actor: 0,
        body: { version: 0, image: { ...image, base64: 'a'.repeat(3200000) } },
      })
    ).status,
    413,
  );
  const malformed = await fetch(base + '/api/v1' + route, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{oops',
  });
  assert.equal(malformed.status, 400);
  assert.equal(await db.productImage.count({ where: { productId: p.id } }), 0);
  assert.equal((await ok<Product>(`/admin/products/${p.id}`)).version, 0);
});

test('normalized product image reads are scoped to current owner and current public visibility', async () => {
  let p = await product();
  p = await ok<Product>(imageRoute(p), {
    version: p.version,
    image: await imageFile('image-blue.jpg'),
  });
  assert(p.imageId);
  assert.equal((await photo(p)).status, 401);
  assert.equal((await photo(p, 2)).status, 403);
  const response = await photo(p, 1);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(
    Buffer.from(await response.arrayBuffer()).subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  assert.equal((await photo(p, undefined, true)).status, 404);
  const other = await product();
  assert.equal(
    (await call(`/admin/products/${other.id}/image/${p.imageId}`, { actor: 0 })).status,
    404,
  );
  await assert.rejects(
    db.product.update({ where: { id: other.id }, data: { imageId: p.imageId! } }),
  );
  p = await publish(p);
  assert.equal((await photo(p, undefined, true)).status, 200);
  const sale = await visible(p.skus[0]!.id);
  assert.equal(sale.data.imageUrl, '/api/v1' + photoUrl(p, true));
  await db.category.update({ where: { id: p.categoryId }, data: { enabled: false } });
  try {
    assert.equal((await photo(p, undefined, true)).status, 404);
  } finally {
    await db.category.update({ where: { id: p.categoryId }, data: { enabled: true } });
  }
  const old = p;
  p = await ok<Product>(imageRoute(p), { version: p.version, image: await imageFile() });
  assert.notEqual(p.imageId, old.imageId);
  assert.equal((await photo(old, 0)).status, 404);
  assert.equal((await photo(old, undefined, true)).status, 404);
  const current = p;
  p = await ok<Product>(imageRoute(p), { version: p.version, image: null });
  assert.equal(p.imageId, null);
  assert.equal((await photo(current, undefined, true)).status, 404);
  assert.equal((await visible(p.skus[0]!.id)).data.imageUrl, null);
});

test('image idempotency and competing catalog version preserve one binding and historical replay cannot restore removed photo', async () => {
  const p = await product(),
    route = imageRoute(p),
    key = randomUUID(),
    body = { version: 0, image: await imageFile() };
  const results = await Promise.all(
    Array.from({ length: 5 }, () => call<Product>(route, { actor: 0, body, key })),
  );
  assert(results.every((r) => r.status === 200 && r.data.imageId === results[0]!.data.imageId));
  assert.equal(await db.productImage.count({ where: { productId: p.id } }), 1);
  assert.equal(
    await db.businessAudit.count({ where: { resourceId: p.id, action: 'PRODUCT_SET_IMAGE' } }),
    1,
  );
  const current = results[0]!.data;
  await ok<Product>(route, { version: current.version, image: null });
  assert.equal((await ok<Product>(route, body, 0, key)).imageId, current.imageId);
  assert.equal((await ok<Product>(`/admin/products/${p.id}`)).imageId, null);
  assert.equal(
    (await call(route, { actor: 0, body: { ...body, image: null }, key })).error?.code,
    'IDEMPOTENCY_CONFLICT',
  );
  const fresh = await product();
  const race = await Promise.all([
    call(imageRoute(fresh), { actor: 0, body: { version: 0, image: body.image } }),
    call(`/admin/products/${fresh.id}/publish`, { actor: 0, body: { version: 0 } }),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  assert.equal(race.find((r) => r.status === 409)?.error?.code, 'VERSION_CONFLICT');
});

test('image writes leave inventory, SKU identity, historical cost and status unchanged', async () => {
  let p = await product();
  const skuId = p.skus[0]!.id;
  assert.equal((await post(await approve(await draft([line(skuId)])))).status, 200);
  p = await publish(p);
  const facts = async () => ({
    balances: await db.stockBalance.findMany({ where: { skuId } }),
    lots: await db.stockLot.findMany({ where: { skuId } }),
    positions: await db.stockPosition.findMany({ where: { skuId } }),
    lines: await db.inboundLine.findMany({ where: { skuId } }),
    ledgers: await db.stockLedger.findMany({ where: { skuId } }),
  });
  const before = await facts(),
    result = await ok<Product>(imageRoute(p), { version: p.version, image: await imageFile() });
  assert.equal(result.status, p.status);
  assert.deepEqual(result.skus, p.skus);
  assert.deepEqual(await facts(), before);
  assert.equal((await visible(skuId)).data.available, 3);
});

test('late image audit failure rolls back metadata/version and removes unreferenced file, original-key retry succeeds', async () => {
  const p = await product(),
    route = imageRoute(p),
    key = randomUUID(),
    body = { version: 0, image: await imageFile() };
  const files = await readdir(`.local/test-images-${schema}`);
  await admin.query(
    "CREATE FUNCTION fail_image_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='PRODUCT_SET_IMAGE' THEN RAISE EXCEPTION 'synthetic failure'; END IF; RETURN NEW; END $$",
  );
  await admin.query(
    'CREATE TRIGGER fail_image_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_image_audit()',
  );
  try {
    assert.equal((await call(route, { actor: 0, body, key })).status, 500);
    assert.equal(await db.productImage.count({ where: { productId: p.id } }), 0);
    assert.equal((await ok<Product>(`/admin/products/${p.id}`)).version, 0);
    assert.deepEqual((await readdir(`.local/test-images-${schema}`)).sort(), files.sort());
  } finally {
    await admin.query('DROP TRIGGER fail_image_audit ON business_audits');
    await admin.query('DROP FUNCTION fail_image_audit()');
  }
  assert((await ok<Product>(route, body, 0, key)).imageId);
  checks.push(
    'image decoding, owner/public visibility, idempotent/version competition and rollback compensation preserve stock/cost',
  );
});

test('local image storage cannot be enabled by production configuration', () => {
  const config = applicationConfig({
    NODE_ENV: 'production',
    STAFF_ALLOWED_ORIGINS: 'https://staff.example.test',
  });
  assert.equal(config.productImageRoot, undefined);
  assert.throws(() =>
    applicationConfig({
      NODE_ENV: 'production',
      STAFF_ALLOWED_ORIGINS: 'https://staff.example.test',
      PRODUCT_IMAGE_LOCAL_DIR: '.local/images',
    }),
  );
});

const galleryRoute = (p: Product, action = 'images') => `/admin/products/${p.id}/${action}`;
async function addPhoto(p: Product, file = 'image-red.png') {
  return ok<ProductGallery>(galleryRoute(p, 'add-image'), {
    version: p.version,
    image: await imageFile(file),
  });
}
async function orderPhotos(g: ProductGallery, imageIds: string[], key?: string) {
  return ok<ProductGallery>(
    galleryRoute(g.product, 'set-images'),
    { version: g.product.version, imageIds },
    0,
    key,
  );
}
test('gallery API enforces auth, strict order input, image validation and database position constraints', async () => {
  const p = await product(),
    route = galleryRoute(p, 'set-images');
  assert.equal((await call(galleryRoute(p))).status, 401);
  assert.equal((await call(galleryRoute(p), { actor: 2 })).status, 403);
  assert.equal((await ok<ProductGallery>(galleryRoute(p), undefined, 1)).images.length, 0);
  for (const action of ['add-image', 'set-images']) {
    const body =
      action === 'add-image'
        ? { version: 0, image: await imageFile() }
        : { version: 0, imageIds: [] };
    assert.equal((await call(galleryRoute(p, action), { body })).status, 401);
    assert.equal((await call(galleryRoute(p, action), { actor: 1, body })).status, 403);
    const csrf = await fetch(base + '/api/v1' + galleryRoute(p, action), {
      method: 'POST',
      headers: {
        Cookie: identities[0]!.cookie,
        Origin: 'http://127.0.0.1:5173',
        'Content-Type': 'application/json',
        'Idempotency-Key': randomUUID(),
      },
      body: JSON.stringify(body),
    });
    assert.equal(csrf.status, 403);
  }
  for (const body of [
    { version: 0, imageIds: 'bad' },
    {
      version: 0,
      imageIds: [randomUUID(), randomUUID(), ...Array.from({ length: 5 }, () => randomUUID())],
    },
    { version: -1, imageIds: [] },
    { version: 0, imageIds: [], extra: true },
    { version: 0, imageIds: ['invalid'] },
    { version: 0, imageIds: [p.id, p.id] },
  ])
    assert.equal((await call(route, { actor: 0, body })).status, 400);
  assert.equal(
    (await call(galleryRoute(p, 'add-image'), { actor: 0, body: { version: 0, image: null } }))
      .status,
    400,
  );
  assert.equal(
    (
      await call(galleryRoute(p, 'add-image'), {
        actor: 0,
        body: { version: 0, image: await imageFile('image-wide.png') },
      })
    ).status,
    400,
  );
  const g = await addPhoto(p),
    image = await db.productImage.findUniqueOrThrow({ where: { id: g.images[0]!.id } });
  await assert.rejects(db.productImage.update({ where: { id: image.id }, data: { sortOrder: 6 } }));
  await assert.rejects(
    db.productImage.create({
      data: { ...image, id: randomUUID(), objectKey: `${randomUUID()}.png` },
    }),
  );
});

test('gallery add, reorder, remove and public detail preserve cover agreement, ownership and inventory facts', async () => {
  let p = await product();
  await post(await approve(await draft([line(p.skus[0]!.id)])));
  p = await publish(p);
  const before = await db.stockBalance.findMany({ where: { skuId: p.skus[0]!.id } });
  let g = await addPhoto(p);
  const first = g.images[0]!.id;
  g = await addPhoto(g.product, 'image-blue.jpg');
  const second = g.images[1]!.id;
  const read = (imageId: string) => fetch(base + `/api/v1/product-images/${p.id}/${imageId}`);
  assert.equal((await read(second)).status, 200);
  assert.equal(g.product.imageId, first);
  g = await orderPhotos(g, [second, first]);
  assert.equal(g.product.imageId, second);
  const audit = await db.businessAudit.findFirstOrThrow({
    where: { resourceId: p.id, action: 'PRODUCT_SET_IMAGES' },
    orderBy: { createdAt: 'desc' },
  });
  assert.deepEqual(audit.details, { before: [first, second], after: [second, first] });
  let sale = (await visible(p.skus[0]!.id)).data;
  assert.deepEqual(
    sale.imageUrls,
    [second, first].map((id) => `/api/v1/product-images/${p.id}/${id}`),
  );
  assert.equal(sale.imageUrl, sale.imageUrls![0]);
  const other = await addPhoto(await product());
  for (const imageId of [other.images[0]!.id, randomUUID()])
    assert.equal(
      (
        await call(galleryRoute(p, 'set-images'), {
          actor: 0,
          body: { version: g.product.version, imageIds: [imageId] },
        })
      ).error?.code,
      'INVALID_IMAGE_REFERENCE',
    );
  assert.equal(
    (await call(`/admin/products/${other.product.id}/image/${first}`, { actor: 0 })).status,
    404,
  );
  g = await orderPhotos(g, [first]);
  assert.equal((await read(second)).status, 404);
  assert.equal(
    (
      await call(galleryRoute(p, 'set-images'), {
        actor: 0,
        body: { version: g.product.version, imageIds: [second] },
      })
    ).status,
    400,
  );
  assert.equal(await db.productImage.count({ where: { productId: p.id } }), 2, 'metadata retained');
  await db.category.update({ where: { id: p.categoryId }, data: { enabled: false } });
  try {
    assert.equal((await read(first)).status, 404);
  } finally {
    await db.category.update({ where: { id: p.categoryId }, data: { enabled: true } });
  }
  g = await orderPhotos(g, []);
  assert.equal(g.product.imageId, null);
  sale = (await visible(p.skus[0]!.id)).data;
  assert.deepEqual(sale.imageUrls, []);
  assert.equal(sale.imageUrl, null);
  assert.equal((await read(first)).status, 404);
  assert.equal(g.product.status, p.status);
  assert.deepEqual(g.product.skus, p.skus);
  assert.deepEqual(await db.stockBalance.findMany({ where: { skuId: p.skus[0]!.id } }), before);
});

test('six-image cap survives concurrent adds and allows append after removal without restoring history', async () => {
  let g = await addPhoto(await product());
  for (let i = 1; i < 5; i++) g = await addPhoto(g.product);
  const route = galleryRoute(g.product, 'add-image'),
    body = { version: g.product.version, image: await imageFile() };
  const race = await Promise.all([
    call<ProductGallery>(route, { actor: 0, body }),
    call<ProductGallery>(route, { actor: 0, body }),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
  g = race.find((r) => r.status === 200)!.data;
  const files = await readdir(`.local/test-images-${schema}`);
  assert.equal(
    (await call(route, { actor: 0, body: { ...body, version: g.product.version } })).error?.code,
    'IMAGE_LIMIT',
  );
  assert.deepEqual((await readdir(`.local/test-images-${schema}`)).sort(), files.sort());
  g = await orderPhotos(
    g,
    g.images.slice(1).map((i) => i.id),
  );
  g = await addPhoto(g.product);
  assert.equal(g.images.length, 6);
  assert.deepEqual(
    (
      await db.productImage.findMany({
        where: { productId: g.product.id, sortOrder: { not: null } },
        orderBy: { sortOrder: 'asc' },
      })
    ).map((i) => i.sortOrder),
    [0, 1, 2, 3, 4, 5],
  );
});

test('gallery idempotent replay is historical and concurrent reorder/catalog edits have one winner', async () => {
  const p = await product(),
    route = galleryRoute(p, 'add-image'),
    key = randomUUID(),
    body = { version: p.version, image: await imageFile() };
  const copies = await Promise.all(
    Array.from({ length: 4 }, () => call<ProductGallery>(route, { actor: 0, body, key })),
  );
  assert(
    copies.every((r) => r.status === 200 && r.data.images[0]!.id === copies[0]!.data.images[0]!.id),
  );
  assert.equal(await db.productImage.count({ where: { productId: p.id } }), 1);
  assert.equal(
    await db.businessAudit.count({ where: { resourceId: p.id, action: 'PRODUCT_ADD_IMAGE' } }),
    1,
  );
  let g = await addPhoto(copies[0]!.data.product);
  const orderKey = randomUUID(),
    orderBody = { version: g.product.version, imageIds: [...g.images].reverse().map((i) => i.id) };
  g = await ok<ProductGallery>(galleryRoute(p, 'set-images'), orderBody, 0, orderKey);
  await orderPhotos(g, []);
  assert.deepEqual(
    (await ok<ProductGallery>(galleryRoute(p, 'set-images'), orderBody, 0, orderKey)).images,
    g.images,
  );
  assert.deepEqual((await ok<ProductGallery>(galleryRoute(p))).images, []);
  assert.equal(
    (
      await call(route, {
        actor: 0,
        body: { ...body, image: await imageFile('image-blue.jpg') },
        key,
      })
    ).error?.code,
    'IDEMPOTENCY_CONFLICT',
  );
  const fresh = await addPhoto(await product());
  const race = await Promise.all([
    call(galleryRoute(fresh.product, 'set-images'), {
      actor: 0,
      body: { version: fresh.product.version, imageIds: [] },
    }),
    call(`/admin/products/${fresh.product.id}/publish`, {
      actor: 0,
      body: { version: fresh.product.version },
    }),
  ]);
  assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
});

test('legacy cover update/removal preserves remaining gallery images and promotes next cover', async () => {
  let g = await addPhoto(await product());
  g = await addPhoto(g.product, 'image-blue.jpg');
  const retained = g.images[1]!.id,
    removed = g.images[0]!.id;
  let p = await ok<Product>(imageRoute(g.product), {
    version: g.product.version,
    image: await imageFile(),
  });
  g = await ok<ProductGallery>(galleryRoute(p));
  assert.deepEqual(
    g.images.map((i) => i.id),
    [p.imageId, retained],
  );
  assert.equal((await call(`/admin/products/${p.id}/image/${removed}`, { actor: 0 })).status, 404);
  p = await ok<Product>(imageRoute(p), { version: p.version, image: null });
  assert.equal(p.imageId, retained);
  assert.deepEqual(
    (await ok<ProductGallery>(galleryRoute(p))).images.map((i) => i.id),
    [retained],
  );
});

test('gallery late audit failure rolls back reorder/removal and compensates appended file with original-key retry', async () => {
  let g = await addPhoto(await product());
  g = await addPhoto(g.product);
  const before = await ok<ProductGallery>(galleryRoute(g.product)),
    files = await readdir(`.local/test-images-${schema}`);
  await admin.query(
    "CREATE FUNCTION fail_gallery_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('PRODUCT_ADD_IMAGE','PRODUCT_SET_IMAGES') THEN RAISE EXCEPTION 'synthetic gallery failure'; END IF; RETURN NEW; END $$",
  );
  await admin.query(
    'CREATE TRIGGER fail_gallery_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_gallery_audit()',
  );
  const key = randomUUID(),
    body = { version: g.product.version, image: await imageFile() };
  try {
    for (const imageIds of [[], [...g.images].reverse().map((i) => i.id)]) {
      assert.equal(
        (
          await call(galleryRoute(g.product, 'set-images'), {
            actor: 0,
            body: { version: g.product.version, imageIds },
          })
        ).status,
        500,
      );
      assert.deepEqual(await ok<ProductGallery>(galleryRoute(g.product)), before);
    }
    assert.equal(
      (await call(galleryRoute(g.product, 'add-image'), { actor: 0, body, key })).status,
      500,
    );
    assert.deepEqual(await ok<ProductGallery>(galleryRoute(g.product)), before);
    assert.equal(await db.productImage.count({ where: { productId: g.product.id } }), 2);
    assert.deepEqual((await readdir(`.local/test-images-${schema}`)).sort(), files.sort());
  } finally {
    await admin.query('DROP TRIGGER fail_gallery_audit ON business_audits');
    await admin.query('DROP FUNCTION fail_gallery_audit()');
  }
  assert.equal(
    (await ok<ProductGallery>(galleryRoute(g.product, 'add-image'), body, 0, key)).images.length,
    3,
  );
  checks.push(
    'gallery order/removal, ownership, cap, compatibility, concurrent/idempotent writes and late rollback passed',
  );
});

test('gallery migration backfills only the current owned cover and leaves historical/unbound images inactive', async () => {
  const scratch = schema + '_gallery_migration';
  assert.match(scratch, /^s2_[a-f0-9]{32}_gallery_migration$/);
  await admin.query('BEGIN');
  try {
    await admin.query(`CREATE SCHEMA ${scratch}`);
    await admin.query("SELECT set_config('search_path',$1,true)", [scratch]);
    await admin.query(
      'CREATE TABLE products(id uuid PRIMARY KEY,image_id uuid); CREATE TABLE product_images(id uuid PRIMARY KEY,product_id uuid NOT NULL)',
    );
    const p = randomUUID(),
      cover = randomUUID(),
      historic = randomUUID(),
      orphan = randomUUID();
    await admin.query('INSERT INTO products VALUES ($1,$2)', [p, cover]);
    for (const id of [cover, historic, orphan])
      await admin.query('INSERT INTO product_images VALUES ($1,$2)', [id, p]);
    await admin.query(
      await readFile(
        'packages/database/prisma/migrations/202610310002_product_gallery/migration.sql',
        'utf8',
      ),
    );
    const result = (await admin.query('SELECT id,sort_order FROM product_images')) as {
      rows: { id: string; sort_order: number | null }[];
    };
    assert.equal(result.rows.find((i) => i.id === cover)!.sort_order, 0);
    assert(result.rows.filter((i) => i.id !== cover).every((i) => i.sort_order === null));
  } finally {
    await admin.query('ROLLBACK');
  }
});

test('public detail returns same-product enabled variants with each price and stock, GET changes no business facts', async () => {
  let p = await ok<Product>('/admin/products', {
    categoryId,
    name: '多规格公开测试',
    description: '合成资料',
    skus: [
      { code: `VAR-A-${run}`, spec: '单包装', unit: '包', priceCents: 450, expiryManaged: false },
      { code: `VAR-B-${run}`, spec: '3包装', unit: '组', priceCents: 1299, expiryManaged: false },
      {
        code: `VAR-C-${run}`,
        spec: '停用规格',
        unit: '箱',
        priceCents: 9900,
        expiryManaged: false,
      },
    ],
  });
  const [a, b, c] = p.skus;
  await post(await approve(await draft([line(a!.id, 3), line(b!.id, 7)])));
  p = await ok<Product>(`/admin/products/${p.id}/skus/${c!.id}/disable`, { version: p.version });
  p = await publish(p);
  const before = {
    balances: await db.stockBalance.findMany({ where: { skuId: { in: p.skus.map((s) => s.id) } } }),
    audits: await db.businessAudit.count(),
    keys: await db.idempotencyRecord.count(),
  };
  const r = await call<import('../packages/contracts/src/index.ts').SaleSkuDetail>(
    `/products/${b!.id}`,
  );
  assert.equal(r.status, 200);
  assert.equal(r.data.id, b!.id);
  assert.equal(r.data.priceCents, 1299);
  assert.equal(r.data.available, 7);
  assert.deepEqual(r.data.variants.map((v) => v.id).sort(), [a!.id, b!.id].sort());
  assert.equal(r.data.variants.find((v) => v.id === a!.id)!.available, 3);
  assert(r.data.variants.every((v) => v.productId === p.id && !('barcode' in v) && !('code' in v)));
  assert.deepEqual(
    await db.stockBalance.findMany({ where: { skuId: { in: p.skus.map((s) => s.id) } } }),
    before.balances,
  );
  assert.equal(await db.businessAudit.count(), before.audits);
  assert.equal(await db.idempotencyRecord.count(), before.keys);
  await db.stockBalance.update({
    where: { warehouseId_skuId: { warehouseId: warehouses[0]!, skuId: a!.id } },
    data: { inventoryHold: true },
  });
  const held = await call<import('../packages/contracts/src/index.ts').SaleSkuDetail>(
    `/products/${a!.id}`,
  );
  assert.equal(held.status, 200);
  assert.equal(held.data.available, 0);
  assert.equal(held.data.variants.find((v) => v.id === b!.id)!.available, 7);
  p = await ok<Product>(`/admin/products/${p.id}/skus/${b!.id}/set-price`, {
    version: p.version,
    priceCents: 1399,
  });
  const refreshed = await call<import('../packages/contracts/src/index.ts').SaleSkuDetail>(
    `/products/${a!.id}`,
  );
  assert.equal(refreshed.data.variants.find((v) => v.id === b!.id)!.priceCents, 1399);
});

test('variant detail does not fall back from disabled/unpublished/category-hidden anchor and validates identity/query', async () => {
  let p = await ok<Product>('/admin/products', {
    categoryId,
    name: '规格范围测试',
    description: '合成范围验证',
    skus: [0, 1].map((i) => ({
      code: `V-SCOPE-${i}-${run}`,
      spec: `${i + 1}包`,
      unit: '包',
      priceCents: 450,
      expiryManaged: false,
    })),
  });
  const [a, b] = p.skus;
  p = await publish(p);
  p = await ok<Product>(`/admin/products/${p.id}/skus/${a!.id}/disable`, { version: p.version });
  assert.equal((await visible(a!.id)).status, 404);
  assert.equal((await visible(b!.id)).status, 200);
  assert.equal((await visible(randomUUID())).status, 404);
  assert.equal((await visible('bad-id')).status, 400);
  assert.equal((await visible(`${b!.id}?limit=1`)).status, 400);
  await db.category.update({ where: { id: categoryId }, data: { enabled: false } });
  try {
    assert.equal((await visible(b!.id)).status, 404);
  } finally {
    await db.category.update({ where: { id: categoryId }, data: { enabled: true } });
  }
  await db.warehouse.update({ where: { id: warehouses[0]! }, data: { enabled: false } });
  try {
    assert.equal((await visible(b!.id)).status, 503);
  } finally {
    await db.warehouse.update({ where: { id: warehouses[0]! }, data: { enabled: true } });
  }
  await ok<Product>(`/admin/products/${p.id}/unpublish`, { version: p.version });
  assert.equal((await visible(b!.id)).status, 404);
});

test('20-spec detail includes the selected last UUID and all enabled siblings without relying on catalog pagination', async () => {
  let p = await ok<Product>('/admin/products', {
    categoryId,
    name: '完整20规格测试',
    description: '合成边界验证',
    skus: Array.from({ length: 20 }, (_, i) => ({
      code: `V20-${i}-${run}`,
      spec: `${i + 1}包装`,
      unit: '包',
      priceCents: 100 + i,
      expiryManaged: false,
    })),
  });
  p = (await addPhoto(p)).product;
  p = await publish(p);
  const anchor = [...p.skus].sort((a, b) => a.id.localeCompare(b.id)).at(-1)!;
  const response = await call<import('../packages/contracts/src/index.ts').SaleSkuDetail>(
    `/products/${anchor.id}`,
  );
  assert.equal(response.status, 200);
  assert.equal(response.data.id, anchor.id);
  assert.equal(response.data.variants.length, 20);
  assert.deepEqual(
    response.data.variants.map((v) => v.id),
    p.skus.map((s) => s.id).sort(),
  );
  assert(
    response.data.variants.every((v) => v.available === 0 && v.imageUrl === response.data.imageUrl),
  );
  const extra = randomUUID();
  await db.sku.create({
    data: {
      id: extra,
      productId: p.id,
      code: `V21-${run}`,
      spec: '异常导入第21规格',
      unit: '包',
      priceCents: 150,
      expiryManaged: false,
      enabled: true,
    },
  });
  assert.equal(
    (await visible(anchor.id)).status,
    503,
    'inconsistent over-limit data fails closed instead of truncation',
  );
  await db.sku.update({ where: { id: extra }, data: { enabled: false } });
  assert.equal((await visible(anchor.id)).status, 200);
  checks.push(
    'public detail: all current enabled siblings, selected identity, stock/prices, hidden anchor and 20-spec boundary',
  );
});

test('public categories page only enabled categories with enabled parents, preserve empty nodes and expose no staff fields', async () => {
  const root = await ok<Category>('/admin/categories', { name: '公开分类根' });
  const child = await ok<Category>('/admin/categories', { name: '空子分类', parentId: root.id });
  const disabled = await ok<Category>('/admin/categories', { name: '停用分类' });
  const hiddenChild = await ok<Category>('/admin/categories', {
    name: '被父隐藏子分类',
    parentId: disabled.id,
  });
  await ok<Category>(`/admin/categories/${disabled.id}/disable`, { version: disabled.version });
  const before = {
    audit: await db.businessAudit.count(),
    keys: await db.idempotencyRecord.count(),
    balance: await db.stockBalance.count(),
  };
  const rows: import('../packages/contracts/src/index.ts').PublicCategory[] = [];
  let cursor: string | null = null;
  do {
    const page: { status: number; data: Page<PublicCategory> } = await call<Page<PublicCategory>>(
      `/categories?limit=7${cursor ? `&cursor=${cursor}` : ''}`,
    );
    assert.equal(page.status, 200);
    rows.push(...page.data.items);
    cursor = page.data.nextCursor;
  } while (cursor);
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
  assert.deepEqual(
    rows.map((r) => r.id),
    rows.map((r) => r.id).sort(),
  );
  assert.deepEqual(
    rows.find((r) => r.id === child.id),
    { id: child.id, name: child.name, parentId: root.id, parentName: root.name },
  );
  assert(rows.some((r) => r.id === root.id));
  assert(!rows.some((r) => r.id === disabled.id || r.id === hiddenChild.id));
  assert(rows.every((r) => Object.keys(r).sort().join(',') === 'id,name,parentId,parentName'));
  assert.deepEqual(
    {
      audit: await db.businessAudit.count(),
      keys: await db.idempotencyRecord.count(),
      balance: await db.stockBalance.count(),
    },
    before,
  );
});

test('public category pagination validates strict query and follows rename/parent disabling and store availability', async () => {
  let root = await ok<Category>('/admin/categories', { name: '动态公开根' });
  const child = await ok<Category>('/admin/categories', { name: '动态公开子', parentId: root.id });
  for (const q of ['limit=0', 'limit=51', 'cursor=bad', 'keyword=x', 'enabled=false'])
    assert.equal((await call(`/categories?${q}`)).status, 400);
  root = await ok<Category>(`/admin/categories/${root.id}/rename`, {
    version: root.version,
    name: '新公开根名称',
  });
  // Read all pages to ensure public names are current even when not on the first page.
  const all = async () => {
    const rows: import('../packages/contracts/src/index.ts').PublicCategory[] = [];
    let cursor: string | null = null;
    do {
      const p: Page<PublicCategory> = await ok<Page<PublicCategory>>(
        `/categories?limit=50${cursor ? `&cursor=${cursor}` : ''}`,
      );
      rows.push(...p.items);
      cursor = p.nextCursor;
    } while (cursor);
    return rows;
  };
  assert.equal((await all()).find((r) => r.id === child.id)!.parentName, root.name);
  await ok<Category>(`/admin/categories/${root.id}/disable`, { version: root.version });
  assert(!(await all()).some((r) => r.id === child.id || r.id === root.id));
  await db.warehouse.update({ where: { id: warehouses[0]! }, data: { enabled: false } });
  try {
    assert.equal((await call('/categories')).status, 503);
  } finally {
    await db.warehouse.update({ where: { id: warehouses[0]! }, data: { enabled: true } });
  }
  assert.equal((await call('/admin/categories')).status, 401);
});

test('real category browsing combines parent/child scope, keyword and cursor without leaking sibling products', async () => {
  const root = await ok<Category>('/admin/categories', { name: '筛选根' }),
    child = await ok<Category>('/admin/categories', { name: '筛选子', parentId: root.id }),
    other = await ok<Category>('/admin/categories', { name: '筛选外' });
  const products: Product[] = [];
  for (const [i, category] of [root, child, child, other].entries()) {
    let p = await ok<Product>('/admin/products', {
      categoryId: category.id,
      name: `分类筛选${i === 2 ? '特别' : '普通'}-${run}`,
      description: '合成筛选资料',
      skus: [
        {
          code: `CBROWSE-${i}-${run}`,
          spec: '1包',
          unit: '包',
          priceCents: 450,
          expiryManaged: false,
        },
      ],
    });
    p = await publish(p);
    products.push(p);
  }
  const first = await ok<Page<SaleSku>>(`/products?categoryId=${root.id}&limit=1`);
  assert.equal(first.items.length, 1);
  assert(first.nextCursor);
  const ids = first.items.map((r) => r.id);
  let cursor: string | null = first.nextCursor;
  while (cursor) {
    const p: Page<SaleSku> = await ok<Page<SaleSku>>(
      `/products?categoryId=${root.id}&limit=1&cursor=${cursor}`,
    );
    ids.push(...p.items.map((r) => r.id));
    cursor = p.nextCursor;
  }
  assert.deepEqual(
    ids,
    products
      .slice(0, 3)
      .map((p) => p.skus[0]!.id)
      .sort(),
  );
  const exact = await ok<Page<SaleSku>>(
    `/products?categoryId=${child.id}&keyword=${encodeURIComponent('特别')}`,
  );
  assert.deepEqual(
    exact.items.map((r) => r.id),
    [products[2]!.skus[0]!.id],
  );
  assert.equal((await ok<Page<SaleSku>>(`/products?categoryId=${randomUUID()}`)).items.length, 0);
  await ok<Category>(`/admin/categories/${root.id}/disable`, { version: root.version });
  assert.equal((await ok<Page<SaleSku>>(`/products?categoryId=${child.id}`)).items.length, 0);
  checks.push(
    'public categories: enabled parent scope, paging/names/empty nodes, strict query, read-only and actual category+keyword+cursor',
  );
});

async function cards(query = '') {
  return ok<Page<import('../packages/contracts/src/index.ts').ProductCard>>(
    '/storefront/products' + query,
  );
}
test('product cards choose lowest in-stock matching SKU, never sum unlike units and keep truthful out-of-stock reference', async () => {
  let p = await ok<Product>('/admin/products', {
    categoryId,
    name: `卡片价格-${run}`,
    description: '合成资料',
    skus: [
      {
        code: `CARD-CHEAP-${run}`,
        spec: '单包缺货',
        unit: '包',
        priceCents: 100,
        expiryManaged: false,
      },
      {
        code: `CARD-STOCK-${run}`,
        spec: '三包装有货',
        unit: '组',
        priceCents: 450,
        expiryManaged: false,
      },
      {
        code: `CARD-TIE-${run}`,
        spec: '同价有货',
        unit: '箱',
        priceCents: 450,
        expiryManaged: false,
      },
      {
        code: `CARD-OFF-${run}`,
        spec: '停用低价',
        unit: '包',
        priceCents: 1,
        expiryManaged: false,
      },
    ],
  });
  const stock = p.skus.find((s) => s.code.startsWith('CARD-STOCK-'))!,
    tie = p.skus.find((s) => s.code.startsWith('CARD-TIE-'))!,
    cheap = p.skus.find((s) => s.code.startsWith('CARD-CHEAP-'))!,
    off = p.skus.find((s) => s.code.startsWith('CARD-OFF-'))!;
  await post(await approve(await draft([line(stock.id, 3), line(tie.id, 2)])));
  p = await ok<Product>(`/admin/products/${p.id}/skus/${off.id}/disable`, { version: p.version });
  p = await publish(p);
  const before = {
    balances: await db.stockBalance.findMany({ where: { skuId: { in: p.skus.map((s) => s.id) } } }),
    audits: await db.businessAudit.count(),
    keys: await db.idempotencyRecord.count(),
  };
  const card = (await cards(`?keyword=${encodeURIComponent(p.name)}`)).items[0]!;
  assert.equal(card.id, p.id);
  assert.equal(card.priceCents, 450);
  assert.equal(card.hasStock, true);
  assert.equal(card.variantCount, 3);
  assert.equal(card.entrySkuId, [stock.id, tie.id].sort()[0]);
  assert(!('available' in card));
  assert(!('barcode' in card));
  assert.equal((await visible(card.entrySkuId)).data.priceCents, card.priceCents);
  assert.deepEqual(
    {
      balances: await db.stockBalance.findMany({
        where: { skuId: { in: p.skus.map((s) => s.id) } },
      }),
      audits: await db.businessAudit.count(),
      keys: await db.idempotencyRecord.count(),
    },
    before,
  );
  await db.stockBalance.updateMany({
    where: { skuId: { in: [stock.id, tie.id] } },
    data: { inventoryHold: true },
  });
  const held = (await cards(`?keyword=${encodeURIComponent(p.name)}`)).items[0]!;
  assert.equal(held.hasStock, false);
  assert.equal(held.priceCents, 100);
  assert.equal(held.entrySkuId, cheap.id);
});

test('product cursor pagination happens after grouping and search summarizes only matching variants', async () => {
  const root = await ok<Category>('/admin/categories', { name: '商品卡片分类' }),
    child = await ok<Category>('/admin/categories', { name: '商品卡片子类', parentId: root.id });
  const created: Product[] = [];
  for (const [i, size] of [20, 2, 1].entries()) {
    let p = await ok<Product>('/admin/products', {
      categoryId: i === 0 ? child.id : root.id,
      name: `聚合商品${i}-${run}`,
      description: '合成资料',
      skus: Array.from({ length: size }, (_, j) => ({
        code: `GROUP-${i}-${j}-${run}`,
        spec: j === 0 ? '目标规格' : `${j + 1}包装`,
        unit: '包',
        priceCents: 100 + j,
        expiryManaged: false,
      })),
    });
    p = await publish(p);
    created.push(p);
  }
  const all: import('../packages/contracts/src/index.ts').ProductCard[] = [];
  let cursor: string | null = null;
  do {
    const p: Page<import('../packages/contracts/src/index.ts').ProductCard> = await cards(
      `?categoryId=${root.id}&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
    );
    all.push(...p.items);
    cursor = p.nextCursor;
  } while (cursor);
  assert.deepEqual(
    all.map((c) => c.id),
    created.map((p) => p.id).sort(),
  );
  assert.equal(all.find((c) => c.id === created[0]!.id)!.variantCount, 20);
  const filtered = await cards(`?categoryId=${child.id}&keyword=${encodeURIComponent('目标规格')}`);
  assert.equal(filtered.items.length, 1);
  assert.equal(filtered.items[0]!.variantCount, 1);
  assert.equal(filtered.items[0]!.spec, '目标规格');
  const legacy = await ok<Page<SaleSku>>(`/products?categoryId=${child.id}&limit=50`);
  assert.equal(legacy.items.length, 20);
  const detail = await ok<import('../packages/contracts/src/index.ts').SaleSkuDetail>(
    `/products/${filtered.items[0]!.entrySkuId}`,
  );
  assert.equal(detail.variants.length, 20);
  const image = await addPhoto(created[0]!);
  const photographed = (await cards(`?categoryId=${child.id}`)).items[0]!;
  assert.equal(
    photographed.imageUrl,
    `/api/v1/product-images/${image.product.id}/${image.product.imageId}`,
  );
});

test('product cards retain public visibility/store checks and strictly validate product cursor filters', async () => {
  let p = await product();
  const q = `?keyword=${encodeURIComponent(p.name)}`;
  assert(!(await cards(q)).items.some((c) => c.id === p.id));
  p = await publish(p);
  assert((await cards(q)).items.some((c) => c.id === p.id));
  for (const query of ['?limit=0', '?limit=51', '?cursor=bad', '?categoryId=bad', '?skuId=x'])
    assert.equal((await call('/storefront/products' + query)).status, 400);
  await db.category.update({ where: { id: p.categoryId }, data: { enabled: false } });
  try {
    assert(!(await cards(q)).items.some((c) => c.id === p.id));
  } finally {
    await db.category.update({ where: { id: p.categoryId }, data: { enabled: true } });
  }
  await db.warehouse.update({ where: { id: warehouses[0]! }, data: { enabled: false } });
  try {
    assert.equal((await call('/storefront/products')).status, 503);
  } finally {
    await db.warehouse.update({ where: { id: warehouses[0]! }, data: { enabled: true } });
  }
  checks.push(
    'product card grouping: price/availability basis, matching variants, entry identity, product cursor, legacy API and read-only/public scope',
  );
});
