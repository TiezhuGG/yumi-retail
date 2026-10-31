import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import { createDatabase, hashPassword } from '../packages/database/src/index.ts';
import { createApplication } from '../apps/api/dist/app.js';
import { applicationConfig } from '../apps/api/dist/config.js';
import type { ServiceAreaDetail, StaffProfile } from '../packages/contracts/src/index.ts';
const url = new URL(process.env.TEST_DATABASE_URL ?? '');
if (
  !['127.0.0.1', 'localhost'].includes(url.hostname) ||
  url.pathname !== '/yumi_test' ||
  url.searchParams.has('schema')
)
  throw Error('Disposable local test schema only');
const schema = 'area_' + randomUUID().replaceAll('-', '');
const { Client } = createRequire(import.meta.url)('pg');
const admin = new Client({ connectionString: url.toString() });
url.searchParams.set('schema', schema);
const db = createDatabase(url.toString()),
  warehouseId = randomUUID(),
  otherWarehouse = randomUUID();
const password = randomBytes(24).toString('hex'),
  staffIds = Array.from({ length: 5 }, () => randomUUID());
const sessions: Array<{ cookie: string; csrf: string }> = [];
let runtime: Awaited<ReturnType<typeof createApplication>>, base: string, area: ServiceAreaDetail;
async function call(
  path: string,
  body?: unknown,
  actor = 0,
  key = randomUUID(),
  headers: Record<string, string> = {},
) {
  const response = await fetch(base + '/api/v1' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: 'http://127.0.0.1:5173',
      'Content-Type': 'application/json',
      ...(sessions[actor]
        ? { Cookie: sessions[actor]!.cookie, 'X-CSRF-Token': sessions[actor]!.csrf }
        : {}),
      'Idempotency-Key': key,
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    cookie: response.headers.get('set-cookie'),
    ...((await response.json()) as {
      data: { area: ServiceAreaDetail; items: Array<{ id: string; name: string }> };
      error?: { code: string };
    }),
  };
}
const write = async (
  path: string,
  body: unknown,
  expected = 200,
  actor = 0,
  key = randomUUID(),
) => {
  const r = await call('/admin/service-area' + path, body, actor, key);
  assert.equal(r.status, expected, JSON.stringify(r));
  if (r.status === 200) area = r.data.area;
  return r;
};
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
  await db.warehouse.createMany({
    data: [
      { id: warehouseId, code: 'AREA', name: '隔离测试仓' },
      { id: otherWarehouse, code: 'OTHER', name: '其他测试仓' },
    ],
  });
  const passwordHash = await hashPassword(password);
  for (const [i, id] of staffIds.entries())
    await db.staff.create({
      data: {
        id,
        loginName: 'area' + i,
        displayName: '范围测试员工',
        passwordHash,
        roles: {
          create: {
            roleCode: ['SUPER_ADMIN', 'OPERATIONS', 'WAREHOUSE_MANAGER', 'RIDER', 'OPERATIONS'][i]!,
          },
        },
        warehouses: { create: { warehouseId: i === 4 ? otherWarehouse : warehouseId } },
      },
    });
  runtime = await createApplication(url.toString(), {
    config: applicationConfig({ NODE_ENV: 'test', PUBLIC_WAREHOUSE_ID: warehouseId }),
    accessLog: () => {},
  });
  await runtime.app.listen(0, '127.0.0.1');
  base = await runtime.app.getUrl();
  for (let i = 0; i < 5; i++) {
    const login = await call('/staff/auth/session', { loginName: 'area' + i, password }, -1);
    assert.equal(login.status, 200);
    sessions[i] = { cookie: login.cookie!.split(';')[0]!, csrf: '' };
    const me = await call('/staff/me', undefined, i);
    sessions[i]!.csrf = (me.data as unknown as StaffProfile).csrfToken;
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
test('empty range, strict fields, staff role and warehouse scope, CSRF', async () => {
  assert.deepEqual((await call('/service-areas')).data.items, []);
  assert.equal((await call('/admin/service-area')).data.area, null);
  assert.equal((await call('/admin/service-area', undefined, -1)).status, 401);
  for (const i of [2, 3, 4])
    assert.equal((await call('/admin/service-area', undefined, i)).status, 403);
  assert.equal(
    (await call('/admin/service-area', { name: '测试' }, 0, randomUUID(), { 'X-CSRF-Token': '' }))
      .status,
    403,
  );
  for (const body of [
    { name: '测试', warehouseId },
    { name: '' },
    { name: 'a\nb' },
    { name: 'x'.repeat(101) },
    { name: '测试', enabled: true },
  ])
    await write('', body, 400);
  assert.equal((await call('/service-areas?warehouseId=' + otherWarehouse)).status, 400);
  assert.equal((await call('/service-areas/bad/buildings')).status, 400);
});
test('singleton creation is serialized, defaults disabled, idempotent replay and changed payload conflict', async () => {
  const key = randomUUID(),
    body = { name: '  合成验收小区  ' };
  const rs = await Promise.all([write('', body, 200, 0, key), write('', body, 200, 0, key)]);
  assert.deepEqual(rs[0]!.data, rs[1]!.data);
  assert.equal(area.enabled, false);
  assert.equal(area.name, '合成验收小区');
  assert.equal(area.version, 0);
  await write('', { name: '另一个小区' }, 409);
  await write('', { name: '不同名称' }, 409, 0, key);
  assert.equal(await db.serviceArea.count(), 1);
  assert.equal(await db.businessAudit.count(), 1);
  assert.equal(await db.idempotencyRecord.count(), 1);
  assert.deepEqual((await call('/service-areas')).data.items, []);
  assert.equal((await call(`/service-areas/${area.id}/buildings`)).status, 404);
});
test('building default disabled, unique normalized names, enable child and parent independently', async () => {
  await write('/buildings', { version: area.version, name: '  A座  ' }, 200, 1);
  const b = area.buildings[0]!;
  assert.equal(b.enabled, false);
  await write('/buildings', { version: area.version, name: 'a座' }, 409);
  await write('/buildings', { version: area.version, name: '\tB座' }, 400);
  await write(`/buildings/${b.id}/update`, { version: area.version, name: b.name, enabled: true });
  assert.equal((await call(`/service-areas/${area.id}/buildings`)).status, 404);
  await write('/update', { version: area.version, name: area.name, enabled: true });
  let publicRows = await call(`/service-areas/${area.id}/buildings`);
  assert.deepEqual(publicRows.data.items, [{ id: b.id, name: b.name }]);
  assert.equal('warehouse' in publicRows.data.area, false);
  assert.equal((await call(`/service-areas/${area.id}/buildings/${b.id}`)).status, 200);
  assert.equal((await call(`/service-areas/${area.id}/buildings/${randomUUID()}`)).status, 404);
  await write('/buildings', { version: area.version, name: 'B座' });
  assert.equal(
    (
      await call(
        `/service-areas/${area.id}/buildings/${area.buildings.find((x) => x.name === 'B座')!.id}`,
      )
    ).status,
    404,
  );
  await write('/update', { version: area.version, name: area.name, enabled: false });
  assert.deepEqual((await call('/service-areas')).data.items, []);
  await write('/update', { version: area.version, name: area.name, enabled: true });
  publicRows = await call(`/service-areas/${area.id}/buildings`);
  assert.equal(publicRows.data.items.length, 1);
});
test('stale writes and concurrent distinct edits have one winner; historical replay does not revert current data', async () => {
  const old = area.version,
    key = randomUUID(),
    body = { version: old, name: '合成验收小区更新', enabled: true };
  const rs = await Promise.all([
    call('/admin/service-area/update', body, 0, key),
    call('/admin/service-area/buildings', { version: old, name: '并发楼栋' }, 1),
  ]);
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  area = (await call('/admin/service-area')).data.area;
  await write('/update', { version: old, name: area.name, enabled: true }, 409);
  const v = area.version,
    replayKey = randomUUID(),
    edit = { version: v, name: area.name, enabled: true };
  const first = await write('/update', edit, 200, 0, replayKey);
  await write('/buildings', { version: area.version, name: '后续楼栋' });
  const current = area.version;
  const replay = await call('/admin/service-area/update', edit, 0, replayKey);
  assert.deepEqual(replay.data, first.data);
  assert.equal((await call('/admin/service-area')).data.area.version, current);
});
test('current scope and warehouse state apply to historical replay and public query', async () => {
  const key = randomUUID(),
    body = { version: area.version, name: area.name, enabled: true };
  await write('/update', body, 200, 0, key);
  await db.staffWarehouse.deleteMany({ where: { staffId: staffIds[0] } });
  assert.equal((await call('/admin/service-area/update', body, 0, key)).status, 403);
  await db.staffWarehouse.create({ data: { staffId: staffIds[0]!, warehouseId } });
  await db.warehouse.update({ where: { id: warehouseId }, data: { enabled: false } });
  assert.equal((await call('/admin/service-area/update', body, 0, key)).status, 403);
  assert.deepEqual((await call('/service-areas')).data.items, []);
  assert.equal((await call(`/service-areas/${area.id}/buildings`)).status, 404);
  await db.warehouse.update({ where: { id: warehouseId }, data: { enabled: true } });
});
test('audit failure rolls back building, version and operation record', async () => {
  const before = await db.serviceArea.findUniqueOrThrow({ where: { id: area.id } }),
    count = await db.serviceBuilding.count(),
    keys = await db.idempotencyRecord.count();
  await admin.query(
    `CREATE FUNCTION fail_area_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$`,
  );
  await admin.query(
    `CREATE TRIGGER fail_area_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION fail_area_audit()`,
  );
  try {
    await write('/buildings', { version: before.version, name: '应回滚楼栋' }, 500);
  } finally {
    await admin.query('DROP TRIGGER fail_area_audit ON business_audits');
    await admin.query('DROP FUNCTION fail_area_audit()');
  }
  assert.equal(
    (await db.serviceArea.findUniqueOrThrow({ where: { id: area.id } })).version,
    before.version,
  );
  assert.equal(await db.serviceBuilding.count(), count);
  assert.equal(await db.idempotencyRecord.count(), keys);
});
test('unknown building, bounds and singleton DB constraints cannot be bypassed', async () => {
  await write(
    `/buildings/${randomUUID()}/update`,
    { version: area.version, name: '未知楼栋', enabled: true },
    404,
  );
  await write('/update', { version: area.version, name: area.name, enabled: 'true' }, 400);
  const count = await db.serviceBuilding.count();
  await db.serviceBuilding.createMany({
    data: Array.from({ length: 200 - count }, (_, i) => ({
      id: randomUUID(),
      areaId: area.id,
      name: '技术边界' + i,
      nameKey: '技术边界' + i,
    })),
  });
  await write('/buildings', { version: area.version, name: '超上限' }, 409);
  assert.equal(await db.serviceBuilding.count(), 200);
  await assert.rejects(() =>
    db.serviceArea.create({
      data: { id: randomUUID(), warehouseId: otherWarehouse, name: '另一个', singleton: false },
    }),
  );
});
