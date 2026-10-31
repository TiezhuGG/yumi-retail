import { ConsumerCartService } from '../apps/api/dist/consumer-cart.js';
import { CatalogService } from '../apps/api/dist/catalog-service.js';
import { tokenHash } from '../apps/api/dist/staff-auth.js';
import { seedCartCatalog } from './helpers/cart-catalog.ts';
import type { ConsumerCart, CartMergeResult } from '../packages/contracts/src/index.ts';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { createDatabase } from '../packages/database/src/index.ts';
import { createApplication } from '../apps/api/dist/app.js';
import { applicationConfig } from '../apps/api/dist/config.js';
import type { AccessEvent } from '../apps/api/dist/app.js';
const url = new URL(process.env.TEST_DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/yumi_test')
  throw Error('Local test database only');
const schema = 'cart_' + randomUUID().replaceAll('-', '');
const { Client } = createRequire(import.meta.url)('pg');
const admin = new Client({ connectionString: url.toString() });
url.searchParams.set('schema', schema);
const db = createDatabase(url.toString());
const logs: AccessEvent[] = [];
const warehouseId = randomUUID();
const config = applicationConfig({
  NODE_ENV: 'test',
  CONSUMER_DEV_LOGIN_ENABLED: '1',
  PUBLIC_WAREHOUSE_ID: warehouseId,
});
let fixture: Awaited<ReturnType<typeof seedCartCatalog>>;
let runtime: Awaited<ReturnType<typeof createApplication>>;
let base: string;
const tokens: string[] = [];
interface Login {
  token: string;
  expiresAt: string;
  user: { id: string; displayName: string; provider: string };
}
async function call<T = ConsumerCart>(
  path: string,
  opts: { token?: string; body?: unknown; headers?: Record<string, string>; method?: string } = {},
  target = base,
) {
  const response = await fetch(target + '/api/v1' + path, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers: {
      'Content-Type': 'application/json',
      'X-Yumi-Dev-Login': '1',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...opts.headers,
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return {
    status: response.status,
    cookie: response.headers.get('set-cookie'),
    ...((await response.json()) as { data: T; error?: { code: string }; requestId: string }),
  };
}
async function login(profile = 'customer-a', target = base) {
  const result = await call<Login>('/consumer/auth/dev-session', { body: { profile } }, target);
  assert.equal(result.status, 200);
  tokens.push(result.data.token);
  return result.data;
}
before(async () => {
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query("SELECT set_config('search_path',$1,false)", [schema]);
  const directory = 'packages/database/prisma/migrations';
  for (const name of (await readdir(directory)).filter((n) => /^\d/.test(n)).sort())
    await admin.query(await readFile(`${directory}/${name}/migration.sql`, 'utf8'));
  runtime = await createApplication(url.toString(), { config, accessLog: (e) => logs.push(e) });
  await runtime.app.listen(0, '127.0.0.1');
  base = await runtime.app.getUrl();
  fixture = await seedCartCatalog(runtime, warehouseId);
});
after(async () => {
  try {
    if (runtime) await runtime.close();
    await db.$disconnect();
    assert.match(schema, /^cart_[a-f0-9]{32}$/);
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await admin.end();
  }
});

const item = (skuId: string, quantity = 1, selected = true) => ({
  skuId,
  quantity,
  selected,
  name: '草稿标签',
  spec: '旧规格',
  unit: '包',
});
const merge = (token: string, items: unknown[], key = randomUUID()) =>
  call<CartMergeResult>('/consumer/cart/merge', {
    token,
    body: { items },
    headers: { 'Idempotency-Key': key },
  });
const read = (token: string) => call('/consumer/cart', { token });
test('anonymous/staff identities and userId injection cannot access a consumer cart', async () => {
  assert.equal((await read('')).status, 401);
  const a = await login();
  assert.equal(
    (await call('/consumer/cart?userId=' + randomUUID(), { token: a.token })).status,
    400,
  );
  assert.equal(
    (
      await call('/consumer/cart/items', {
        token: a.token,
        body: { version: 0, skuId: fixture.skuIds[0], userId: randomUUID() },
      })
    ).status,
    400,
  );
});
test('add uses real available stock, snapshots current labels, merges same SKU, preserves unchecked state and never reserves', async () => {
  const a = await login();
  const current = (await read(a.token)).data;
  const before = await db.stockBalance.findMany();
  let added = await call('/consumer/cart/items', {
    token: a.token,
    body: { version: current.version, skuId: fixture.skuIds[0] },
  });
  assert.equal(added.status, 200);
  assert.equal(added.data.items[0]!.quantity, 1);
  assert.equal(added.data.items[0]!.name, '合成纸巾');
  added = await call('/consumer/cart/items/' + fixture.skuIds[0], {
    token: a.token,
    method: 'PUT',
    body: { version: added.data.version, quantity: 2, selected: false },
  });
  assert.equal(added.status, 200);
  const merged = await merge(a.token, [
    item(fixture.skuIds[0]!, 2, true),
    item(fixture.skuIds[1]!, 1),
  ]);
  assert.equal(merged.status, 200);
  assert.equal(merged.data.cart.items.find((i) => i.skuId === fixture.skuIds[0])!.quantity, 4);
  assert.equal(merged.data.cart.items.find((i) => i.skuId === fixture.skuIds[0])!.selected, false);
  assert.deepEqual(await db.stockBalance.findMany(), before);
});
test('same key concurrent/repeated merge only adds once, canonical ordering replays and altered content conflicts', async () => {
  const a = await login(),
    key = randomUUID(),
    items = [item(fixture.skuIds[0]!), item(fixture.skuIds[1]!)];
  const before = (await read(a.token)).data;
  const responses = await Promise.all([merge(a.token, items, key), merge(a.token, items, key)]);
  assert.equal(responses[0]!.status, 200);
  assert.deepEqual(responses[0]!.data, responses[1]!.data);
  const replay = await merge(a.token, [...items].reverse(), key);
  assert.deepEqual(replay.data, responses[0]!.data);
  assert.equal((await read(a.token)).data.version, before.version + 1);
  assert.equal((await merge(a.token, [item(fixture.skuIds[0]!, 2)], key)).status, 409);
});
test('other account cannot see or edit these rows and same merge key is scoped per user', async () => {
  const a = await login(),
    b = await login('customer-b'),
    key = randomUUID();
  assert.equal((await read(b.token)).data.items.length, 0);
  const remote = (await read(b.token)).data;
  assert.equal(
    (
      await call('/consumer/cart/items/' + fixture.skuIds[0], {
        token: b.token,
        method: 'DELETE',
        body: { version: remote.version },
      })
    ).status,
    404,
  );
  const [x, y] = await Promise.all([
    merge(a.token, [item(randomUUID())], key),
    merge(b.token, [item(randomUUID())], key),
  ]);
  assert.equal(x.status, 200);
  assert.equal(y.status, 200);
  assert.notDeepEqual(x.data.cart.items, y.data.cart.items);
});
test('unknown/disabled/out-of-stock and excess entries are retained with explicit merge checks', async () => {
  const b = await login('customer-b');
  const missing = randomUUID();
  const result = await merge(b.token, [item(missing), item(fixture.skuIds[0]!, 10)]);
  assert.equal(result.status, 200);
  assert.equal(result.data.checks.find((i) => i.skuId === missing)!.status, 'unavailable');
  assert.equal(result.data.checks.find((i) => i.skuId === fixture.skuIds[0])!.status, 'excess');
  await db.sku.update({ where: { id: fixture.skuIds[1] }, data: { enabled: false } });
  const disabled = await merge(b.token, [item(fixture.skuIds[1]!)]);
  assert.equal(disabled.data.checks[0]!.status, 'unavailable');
  assert.ok(disabled.data.cart.items.some((i) => i.skuId === fixture.skuIds[1]));
  assert.equal(
    (
      await call('/consumer/cart/items', {
        token: b.token,
        body: { version: disabled.data.cart.version, skuId: fixture.skuIds[1] },
      })
    ).status,
    409,
  );
  await db.sku.update({ where: { id: fixture.skuIds[1] }, data: { enabled: true } });
});
test('old version/parallel updates cannot overwrite quantity; selection/removal are owned and persisted', async () => {
  const b = await login('customer-b'),
    cart = (await read(b.token)).data,
    id = fixture.skuIds[0]!;
  const updates = await Promise.all([
    call('/consumer/cart/items/' + id, {
      token: b.token,
      method: 'PUT',
      body: { version: cart.version, quantity: 3, selected: true },
    }),
    call('/consumer/cart/items/' + id, {
      token: b.token,
      method: 'PUT',
      body: { version: cart.version, quantity: 4, selected: false },
    }),
  ]);
  assert.deepEqual(updates.map((r) => r.status).sort(), [200, 409]);
  let next = (await read(b.token)).data;
  next = (
    await call('/consumer/cart/selection', {
      token: b.token,
      body: { version: next.version, skuIds: next.items.map((i) => i.skuId), selected: false },
    })
  ).data;
  assert.ok(next.items.every((i) => !i.selected));
  const removed = await call('/consumer/cart/items/' + id, {
    token: b.token,
    method: 'DELETE',
    body: { version: next.version },
  });
  assert.equal(removed.status, 200);
  assert.ok(!removed.data.items.some((i) => i.skuId === id));
});
test('aggregate cap rejects whole merge without partial data, version, audit or receipt; invalid quantities/duplicates rejected', async () => {
  const a = await login(),
    before = (await read(a.token)).data,
    key = randomUUID();
  const audits = await db.consumerCartAudit.count();
  const tooMany = await merge(a.token, [item(randomUUID(), 200)], key);
  assert.equal(tooMany.status, 409);
  assert.equal(tooMany.error?.code, 'CART_LIMIT_EXCEEDED');
  assert.deepEqual((await read(a.token)).data, before);
  assert.equal(await db.consumerCartAudit.count(), audits);
  assert.equal(await db.consumerCartMerge.count({ where: { userId: a.user.id, key } }), 0);
  for (const items of [
    [item(randomUUID(), 0)],
    [item(randomUUID(), 1.5)],
    [item(fixture.skuIds[0]!), item(fixture.skuIds[0]!)],
    [{ ...item(randomUUID()), priceCents: 1 }],
  ])
    assert.equal((await merge(a.token, items)).status, 400);
});
test('50 rows and 200 units boundary is accepted; 51st row atomic rejection', async () => {
  const b = await login('customer-b');
  let cart = (await read(b.token)).data;
  for (const row of cart.items) {
    cart = (
      await call('/consumer/cart/items/' + row.skuId, {
        token: b.token,
        method: 'DELETE',
        body: { version: cart.version },
      })
    ).data;
  }
  const items = Array.from({ length: 50 }, () => item(randomUUID(), 4));
  const accepted = await merge(b.token, items);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.data.cart.items.length, 50);
  const before = accepted.data.cart;
  assert.equal((await merge(b.token, [item(randomUUID())])).status, 409);
  assert.deepEqual((await read(b.token)).data, before);
});
test('merge replay after intervening edits returns original receipt; current read retains new version', async () => {
  const a = await login(),
    key = randomUUID();
  const result = await merge(a.token, [item(fixture.skuIds[0]!)], key);
  const row = result.data.cart.items[0]!;
  const changed = await call('/consumer/cart/items/' + row.skuId, {
    token: a.token,
    method: 'PUT',
    body: { version: result.data.cart.version, quantity: 1, selected: false },
  });
  assert.equal(changed.status, 200);
  assert.deepEqual((await merge(a.token, [item(fixture.skuIds[0]!)], key)).data, result.data);
  assert.deepEqual((await read(a.token)).data, changed.data);
});
test('late database failure rolls back cart, audit and merge receipt together', async () => {
  const a = await login(),
    before = (await read(a.token)).data;
  const count = await db.consumerCartAudit.count();
  await admin.query(
    `CREATE FUNCTION fail_cart_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected cart failure'; END $$`,
  );
  await admin.query(
    'CREATE TRIGGER fail_cart_receipt BEFORE INSERT ON consumer_cart_merges FOR EACH ROW EXECUTE FUNCTION fail_cart_receipt()',
  );
  try {
    assert.equal((await merge(a.token, [item(randomUUID())])).status, 500);
  } finally {
    await admin.query('DROP TRIGGER fail_cart_receipt ON consumer_cart_merges');
    await admin.query('DROP FUNCTION fail_cart_receipt()');
  }
  assert.deepEqual((await read(a.token)).data, before);
  assert.equal(await db.consumerCartAudit.count(), count);
});
test('sessions revoked after guard lookup cannot mutate and persisted cart survives a second instance', async () => {
  const a = await login();
  const second = await createApplication(url.toString(), { config, accessLog: () => {} });
  try {
    await second.app.listen(0, '127.0.0.1');
    assert.deepEqual(
      (await call('/consumer/cart', { token: a.token }, await second.app.getUrl())).data,
      (await read(a.token)).data,
    );
  } finally {
    await second.close();
  }
  const stale = await runtime.db.consumerSession.findUniqueOrThrow({
    where: { tokenHash: tokenHash(a.token) },
  });
  await call('/consumer/auth/logout', { token: a.token, body: {} });
  await assert.rejects(
    new ConsumerCartService(new CatalogService(runtime.db, warehouseId)).merge(
      {
        method: 'POST',
        headers: {},
        socket: {},
        requestId: randomUUID(),
        consumerContext: {
          sessionId: stale.id,
          userId: a.user.id,
          displayName: a.user.displayName,
          provider: 'DEVELOPMENT',
          expiresAt: a.expiresAt,
        },
      },
      { items: [item(randomUUID())] },
      randomUUID(),
    ),
    (e: unknown) =>
      e instanceof Error && 'getStatus' in e && (e as { getStatus(): number }).getStatus() === 401,
  );
  assert.equal((await merge(a.token, [item(randomUUID())])).status, 401);
  assert.equal(await db.stockLedger.count(), 2);
  assert.equal(
    await db.consumerCartMerge.count(),
    await db.consumerCartAudit.count({ where: { action: 'MERGE' } }),
  );
});
