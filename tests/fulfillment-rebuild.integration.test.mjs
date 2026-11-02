import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { rehearseMigrations } from '../scripts/check-fulfillment-local.mjs';
test('real PostgreSQL fresh migration rehearsal cleans only its schema and preserves independent sentinel', async () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '');
  if (url.hostname !== '127.0.0.1' || url.pathname !== '/yumi_test' || url.search)
    throw Error('Local test DB only');
  const c = new Client({ connectionString: url.toString() }),
    schema = 'rebuild_guard_' + randomUUID().replaceAll('-', '');
  await c.connect();
  try {
    await c.query(`CREATE SCHEMA "${schema}"`);
    await c.query(`CREATE TABLE "${schema}".sentinel (value int)`);
    await c.query(`INSERT INTO "${schema}".sentinel VALUES (7)`);
    const before = (
      await c.query(
        "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'preflight_%' ORDER BY nspname",
      )
    ).rows;
    const result = await rehearseMigrations(url.toString());
    assert.ok(result.migrationCount >= 36);
    assert.ok(result.tableCount >= 72);
    assert.equal(result.assignerGate, true);
    assert.deepEqual(
      (
        await c.query(
          "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'preflight_%' ORDER BY nspname",
        )
      ).rows,
      before,
    );
    assert.equal((await c.query(`SELECT value FROM "${schema}".sentinel`)).rows[0].value, 7);
  } finally {
    await c.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await c.end();
  }
});
