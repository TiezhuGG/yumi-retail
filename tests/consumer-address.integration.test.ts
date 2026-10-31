import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { createDatabase } from '../packages/database/src/index.ts';
import { createApplication } from '../apps/api/dist/app.js';
import { applicationConfig } from '../apps/api/dist/config.js';
import { ConsumerAddressService } from '../apps/api/dist/consumer-address.js';
import { CatalogService } from '../apps/api/dist/catalog-service.js';
import type {
  ConsumerAddressBook,
  ConsumerAddressReceipt,
} from '../packages/contracts/src/index.ts';
import type { ApiRequest } from '../apps/api/dist/http.js';
const url = new URL(process.env.TEST_DATABASE_URL ?? '');
if (url.hostname !== '127.0.0.1' || url.pathname !== '/yumi_test' || url.searchParams.has('schema'))
  throw Error('Disposable local test schema only');
const { Client } = createRequire(import.meta.url)('pg'),
  admin = new Client({ connectionString: url.toString() }),
  schema = 'address_' + randomUUID().replaceAll('-', '');
url.searchParams.set('schema', schema);
const db = createDatabase(url.toString()),
  warehouseId = randomUUID(),
  areaId = randomUUID(),
  buildingId = randomUUID(),
  pausedId = randomUUID(),
  key = randomBytes(32).toString('hex');
const config = applicationConfig({
  NODE_ENV: 'test',
  PUBLIC_WAREHOUSE_ID: warehouseId,
  CONSUMER_DEV_LOGIN_ENABLED: '1',
  ADDRESS_ENCRYPTION_KEY: key,
});
let runtime: Awaited<ReturnType<typeof createApplication>>, base: string;
const people: Array<{ token: string; user: { id: string } }> = [];
async function call<T = ConsumerAddressBook>(
  path: string,
  body?: unknown,
  actor = 0,
  operation = randomUUID(),
  headers: Record<string, string> = {},
) {
  const response = await fetch(base + '/api/v1' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Yumi-Dev-Login': '1',
      ...(people[actor] ? { Authorization: 'Bearer ' + people[actor]!.token } : {}),
      'Idempotency-Key': operation,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    ...((await response.json()) as { data: T; error?: { code: string } }),
  };
}
const read = (actor = 0) => call('/consumer/addresses', undefined, actor);
const input = (version: number, extra: Record<string, unknown> = {}) => ({
  version,
  areaId,
  buildingId,
  unit: '验收单元',
  room: '合成门牌101',
  contactName: '合成测试联系人',
  phone: '00000000000',
  note: '隔离测试资料',
  isDefault: false,
  ...extra,
});
async function write(
  path: string,
  body: unknown,
  expected = 200,
  actor = 0,
  operation = randomUUID(),
) {
  const r = await call<ConsumerAddressReceipt>(
    '/consumer/addresses' + path,
    body,
    actor,
    operation,
  );
  assert.equal(r.status, expected, JSON.stringify(r));
  return r;
}
before(async () => {
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query("SELECT set_config('search_path',$1,false)", [schema]);
  for (const dir of (await readdir('packages/database/prisma/migrations'))
    .filter((n) => /^\d/.test(n))
    .sort())
    await admin.query(
      await readFile(`packages/database/prisma/migrations/${dir}/migration.sql`, 'utf8'),
    );
  await db.warehouse.create({ data: { id: warehouseId, code: 'ADDRESS', name: '隔离测试仓' } });
  await db.serviceArea.create({
    data: { id: areaId, warehouseId, name: '合成地址验收小区', enabled: true },
  });
  await db.serviceBuilding.createMany({
    data: [
      { id: buildingId, areaId, name: '合成A栋', nameKey: '合成a栋', enabled: true },
      { id: pausedId, areaId, name: '暂停栋', nameKey: '暂停栋' },
    ],
  });
  runtime = await createApplication(url.toString(), { config, accessLog: () => {} });
  await runtime.app.listen(0, '127.0.0.1');
  base = await runtime.app.getUrl();
  for (const profile of ['customer-a', 'customer-b']) {
    const login = await call<{ token: string; user: { id: string } }>(
      '/consumer/auth/dev-session',
      { profile },
      -1,
    );
    assert.equal(login.status, 200);
    people.push(login.data);
  }
});
after(async () => {
  try {
    if (runtime) await runtime.close();
    await db.$disconnect();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  } finally {
    await admin.end();
  }
});
test('consumer identity, strict inputs, phone and fields are enforced', async () => {
  assert.equal((await read(-1)).status, 401);
  assert.equal((await call('/consumer/addresses?userId=' + people[0]!.user.id)).status, 400);
  for (const extra of [
    { userId: people[1]!.user.id },
    { room: '' },
    { contactName: 'x'.repeat(41) },
    { phone: 'abc123' },
    { phone: '12345' },
    { phone: '0'.repeat(21) },
    { isDefault: 1 },
    { unit: 'a\nb' },
    { areaId: 'bad' },
    { version: -1 },
  ])
    await write('', input(0, extra), 400);
  assert.deepEqual((await read()).data, { version: 0, items: [] });
});
test('create is idempotent under concurrency; encrypted data and receipts/audits contain no contact plaintext', async () => {
  const operation = randomUUID(),
    body = input(0, { isDefault: true, unit: '', note: '' });
  const r = await Promise.all([
    write('', body, 200, 0, operation),
    write('', body, 200, 0, operation),
  ]);
  assert.deepEqual(r[0]!.data, r[1]!.data);
  const book = (await read()).data;
  assert.equal(book.version, 1);
  assert.equal(book.items.length, 1);
  assert.equal(book.items[0]!.room, body.room);
  assert.equal(book.items[0]!.isDefault, true);
  assert.equal(book.items[0]!.available, true);
  const row = await db.consumerAddress.findUniqueOrThrow({ where: { id: r[0]!.data.id } });
  assert.ok(row.payload?.startsWith('v1.'));
  for (const value of [
    row,
    await db.consumerAddressOperation.findMany(),
    await db.consumerAddressAudit.findMany(),
  ]) {
    const text = JSON.stringify(value);
    for (const secret of [body.phone, body.contactName, body.room])
      assert.equal(text.includes(secret), false);
  }
  await write('', input(0, { room: 'changed' }), 409, 0, operation);
  assert.equal(await db.consumerAddress.count(), 1);
  assert.equal(await db.consumerAddressAudit.count(), 1);
});
test('ownership cannot be bypassed by ID or body; duplicate keys are isolated by consumer', async () => {
  const a = (await read()).data.items[0]!;
  assert.deepEqual((await read(1)).data.items, []);
  for (const action of ['update', 'default', 'delete'])
    await write(`/${a.id}/${action}`, action === 'update' ? input(0) : { version: 0 }, 404, 1);
  const sameKey = randomUUID();
  await write('', input(0), 200, 1, sameKey);
  const b = (await read(1)).data;
  assert.equal(b.items.length, 1);
  assert.notEqual(b.items[0]!.id, a.id);
  await write(`/${a.id}/default`, { version: 1, userId: people[1]!.user.id }, 400);
});
test('default replacement is atomic and concurrent stale edits reject one contender', async () => {
  let book = (await read()).data;
  await write('', input(book.version, { room: '合成门牌202', isDefault: true }));
  book = (await read()).data;
  assert.equal(book.items.filter((i) => i.isDefault).length, 1);
  assert.equal(book.items.find((i) => i.isDefault)!.room, '合成门牌202');
  const [a, b] = book.items;
  const rs = await Promise.all([
    call(`/consumer/addresses/${a!.id}/default`, { version: book.version }),
    call(`/consumer/addresses/${b!.id}/default`, { version: book.version }),
  ]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  book = (await read()).data;
  assert.equal(book.items.filter((i) => i.isDefault).length, 1);
  const current = book.items.find((i) => i.isDefault)!;
  await assert.rejects(() =>
    db.consumerAddress.update({
      where: { id: book.items.find((i) => i.id !== current.id)!.id },
      data: { isDefault: true },
    }),
  );
});
test('paused building/area/warehouse and mismatched area are rejected on write; retained rows indicate unavailable', async () => {
  let book = (await read()).data;
  await write('', input(book.version, { buildingId: pausedId }), 409);
  await write('', input(book.version, { areaId: randomUUID() }), 409);
  const row = book.items[0]!;
  await db.serviceBuilding.update({ where: { id: buildingId }, data: { enabled: false } });
  book = (await read()).data;
  assert.ok(book.items.every((i) => !i.available));
  await write(`/${row.id}/update`, input(book.version), 409);
  await write(`/${row.id}/default`, { version: book.version }, 409);
  await db.serviceBuilding.update({ where: { id: buildingId }, data: { enabled: true } });
  await db.serviceArea.update({ where: { id: areaId }, data: { enabled: false } });
  await write('', input(book.version), 409);
  await db.serviceArea.update({ where: { id: areaId }, data: { enabled: true } });
  await db.warehouse.update({ where: { id: warehouseId }, data: { enabled: false } });
  await write('', input(book.version), 409);
  await db.warehouse.update({ where: { id: warehouseId }, data: { enabled: true } });
});
test('update changes encrypted contact fields; delete clears default and PII, replay does not resurrect', async () => {
  let book = (await read()).data;
  const row = book.items.find((i) => i.isDefault)!;
  await write(
    `/${row.id}/update`,
    input(book.version, { room: '合成新门牌303', phone: '+000000000000', isDefault: true }),
  );
  book = (await read()).data;
  assert.equal(book.items.find((i) => i.id === row.id)!.room, '合成新门牌303');
  const operation = randomUUID(),
    body = { version: book.version };
  const result = await write(`/${row.id}/delete`, body, 200, 0, operation);
  const stored = await db.consumerAddress.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(stored.payload, null);
  assert.equal(stored.deleted, true);
  assert.equal(stored.isDefault, false);
  book = (await read()).data;
  assert.ok(book.items.every((i) => !i.isDefault));
  assert.ok(book.items.every((i) => i.id !== row.id));
  assert.deepEqual((await write(`/${row.id}/delete`, body, 200, 0, operation)).data, result.data);
  await write(`/${row.id}/update`, input(book.version), 404);
});
test('late audit failure rolls back default replacement, payload, version and receipt', async () => {
  const before = (await read()).data,
    keys = await db.consumerAddressOperation.count();
  await admin.query(
    `CREATE FUNCTION fail_address_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$`,
  );
  await admin.query(
    'CREATE TRIGGER fail_address_audit BEFORE INSERT ON consumer_address_audits FOR EACH ROW EXECUTE FUNCTION fail_address_audit()',
  );
  try {
    await write('', input(before.version, { isDefault: true }), 500);
  } finally {
    await admin.query('DROP TRIGGER fail_address_audit ON consumer_address_audits');
    await admin.query('DROP FUNCTION fail_address_audit()');
  }
  assert.deepEqual((await read()).data, before);
  assert.equal(await db.consumerAddressOperation.count(), keys);
});
test('a range pause holding the building lock prevents a subsequent address save', async () => {
  const book = (await read()).data;
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r));
  const transaction = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM service_buildings WHERE id=${buildingId}::uuid FOR UPDATE`;
    entered();
    await gate;
    await tx.serviceBuilding.update({ where: { id: buildingId }, data: { enabled: false } });
  });
  await ready;
  const pending = call('/consumer/addresses', input(book.version));
  release();
  await transaction;
  assert.equal((await pending).status, 409);
  await db.serviceBuilding.update({ where: { id: buildingId }, data: { enabled: true } });
});
test('session is revalidated inside the write transaction and missing encryption config fails closed', async () => {
  const userId = people[1]!.user.id,
    session = await db.consumerSession.findFirstOrThrow({ where: { userId } }),
    book = (await read(1)).data;
  const req = {
    method: 'POST',
    headers: {},
    socket: {},
    requestId: randomUUID(),
    consumerContext: { userId, sessionId: session.id },
  } as ApiRequest;
  await db.consumerSession.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
  const service = new ConsumerAddressService(new CatalogService(runtime.db, warehouseId), key);
  await assert.rejects(
    () => service.write(req, randomUUID(), 'CREATE', input(book.version)),
    (e: unknown) =>
      Boolean(
        e &&
        typeof e === 'object' &&
        'getStatus' in e &&
        (e as { getStatus: () => number }).getStatus() === 401,
      ),
  );
  await assert.rejects(
    () => new ConsumerAddressService(new CatalogService(runtime.db, warehouseId)).read(req),
    (e: unknown) =>
      Boolean(
        e &&
        typeof e === 'object' &&
        'getStatus' in e &&
        (e as { getStatus: () => number }).getStatus() === 503,
      ),
  );
  assert.throws(() => applicationConfig({ ADDRESS_ENCRYPTION_KEY: 'bad' }));
});
test('20 active address limit is atomic and deleting a row frees capacity', async () => {
  let book = (await read()).data;
  while (book.items.length < 20) {
    await write('', input(book.version));
    book = (await read()).data;
  }
  const count = await db.consumerAddressOperation.count();
  await write('', input(book.version), 409);
  assert.equal(await db.consumerAddressOperation.count(), count);
  await write(`/${book.items[0]!.id}/delete`, { version: book.version });
  book = (await read()).data;
  await write('', input(book.version));
  assert.equal((await read()).data.items.length, 20);
});
