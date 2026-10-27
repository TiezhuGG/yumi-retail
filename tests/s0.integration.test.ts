import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { createDatabase } from '../packages/database/src/index.ts';
import { reserveValidationStock } from '../packages/database/src/validation-stock.ts';
import { createApplication } from '../apps/api/dist/app.js';

const url = new URL(process.env.TEST_DATABASE_URL ?? '');
if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.pathname !== '/yumi_test') throw new Error('S0 tests require the isolated local yumi_test database.');
const db = createDatabase(url.toString());
const ids: string[] = [];
const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), database: 'isolated local PostgreSQL', checks: [] };
const checks = evidence.checks as string[];
async function fixture(onHand: number) {
  const id = randomUUID(); ids.push(id);
  await db.validationStock.create({ data: { id, label: 'S0 isolated test fixture', onHand } });
  return id;
}
before(async () => { await db.$connect(); });
after(async () => {
  // Delete only fixtures created by this run. No truncation, reset, or development data deletion.
  try {
    await db.validationLedger.deleteMany({ where: { stockId: { in: ids } } });
    await db.validationReservation.deleteMany({ where: { stockId: { in: ids } } });
    await db.validationStock.deleteMany({ where: { id: { in: ids } } });
    evidence.finishedAt = new Date().toISOString();
    await mkdir('.local', { recursive: true });
    await writeFile('.local/s0-results.json', JSON.stringify(evidence, null, 2) + '\n');
  } finally { await db.$disconnect(); }
});

test('Prisma PostgreSQL create/read/update/delete and migration visibility', async () => {
  const id = await fixture(10);
  assert.equal((await db.validationStock.findUniqueOrThrow({ where: { id } })).onHand, 10);
  await db.validationStock.update({ where: { id }, data: { onHand: 12 } });
  assert.equal((await db.validationStock.findUniqueOrThrow({ where: { id } })).onHand, 12);
  await db.validationStock.delete({ where: { id } });
  assert.equal(await db.validationStock.findUnique({ where: { id } }), null);
  checks.push('CRUD');
});

test('rollback restores stock and removes reservation/ledger together', async () => {
  const id = await fixture(3); const key = randomUUID();
  await assert.rejects(db.$transaction(async tx => {
    await tx.validationStock.update({ where: { id }, data: { reserved: 1 } });
    await tx.validationReservation.create({ data: { id: randomUUID(), requestKey: key, stockId: id, quantity: 1 } });
    await tx.validationLedger.create({ data: { id: randomUUID(), actionKey: key, stockId: id, deltaReserved: 1 } });
    throw new Error('INTENTIONAL_ROLLBACK');
  }), /INTENTIONAL_ROLLBACK/);
  assert.equal((await db.validationStock.findUniqueOrThrow({ where: { id } })).reserved, 0);
  assert.equal(await db.validationReservation.count({ where: { stockId: id } }), 0);
  assert.equal(await db.validationLedger.count({ where: { stockId: id } }), 0);
  checks.push('atomic rollback');
});

test('50 simultaneous purchase intents compete for the last unit without overselling', async () => {
  const id = await fixture(1);
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const attempts = Array.from({ length: 50 }, async () => { await barrier; return reserveValidationStock(db, id, randomUUID()); });
  release();
  const results = await Promise.all(attempts);
  const accepted = results.filter(r => r.accepted).length;
  assert.equal(accepted, 1);
  const stock = await db.validationStock.findUniqueOrThrow({ where: { id } });
  assert.equal(stock.onHand, 1); assert.equal(stock.reserved, 1);
  assert.equal(await db.validationReservation.count({ where: { stockId: id } }), 1);
  assert.equal(await db.validationLedger.count({ where: { stockId: id } }), 1);
  evidence.lastUnitRace = { attempts: 50, accepted, rejectedAsUnavailable: 49, reserved: stock.reserved, ledgerRows: 1 };
  checks.push('50-way last-unit contention');
});

test('20 retries of one intent reserve once and reject changed request content', async () => {
  const id = await fixture(10); const key = randomUUID();
  const results = await Promise.all(Array.from({ length: 20 }, () => reserveValidationStock(db, id, key)));
  assert.equal(results.filter(r => r.accepted && !r.reused).length, 1);
  assert.equal(results.filter(r => r.reused).length, 19);
  assert.equal((await db.validationStock.findUniqueOrThrow({ where: { id } })).reserved, 1);
  assert.equal(await db.validationReservation.count({ where: { stockId: id } }), 1);
  assert.equal(await db.validationLedger.count({ where: { stockId: id } }), 1);
  await assert.rejects(reserveValidationStock(db, id, key, 2), /IDEMPOTENCY_CONFLICT/);
  checks.push('idempotent retries and request mismatch');
});

test('database CHECK prevents an invalid negative/over-reserved balance', async () => {
  const id = await fixture(1);
  await assert.rejects(db.validationStock.update({ where: { id }, data: { reserved: 2 } }));
  await assert.rejects(db.validationStock.update({ where: { id }, data: { onHand: -1 } }));
  const stock = await db.validationStock.findUniqueOrThrow({ where: { id } });
  assert.equal(stock.onHand, 1); assert.equal(stock.reserved, 0);
  checks.push('database constraints');
});

test('NestJS live/readiness endpoints connect to the real PostgreSQL database', async () => {
  const runtime = await createApplication(url.toString());
  try {
    await runtime.app.listen(0, '127.0.0.1');
    const base = await runtime.app.getUrl();
    const live = await fetch(`${base}/api/v1/health/live`);
    assert.equal(live.status, 200);
    const ready = await fetch(`${base}/api/v1/health/ready`);
    assert.equal(ready.status, 200);
    assert.equal((await ready.json()).data.database, 'connected');
    checks.push('Nest real-database readiness');
  } finally { await runtime.close(); }
});
