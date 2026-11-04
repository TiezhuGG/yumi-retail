import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { Client } from 'pg';
import { assertRecoveryOptIn, createRecoveryLab } from './local-recovery-cluster.mjs';

// No .env loading, connection URL, data-directory argument or remote target is supported.
let stage = 'OPT_IN';
async function main() {
  assertRecoveryOptIn(process.env, process.argv.slice(2));
  stage = 'CREATE_ISOLATED_CLUSTER';
  const lab = await createRecoveryLab(),
    previous = process.env.TEST_DATABASE_URL;
  let fixture, restored;
  try {
    await rm('.local/express-recovery-report.json', { force: true });
    process.env.TEST_DATABASE_URL = lab.sourceUrl.toString();
    const { controlledExpressFixture } =
      await import('../tests/helpers/controlled-express-fixture.ts');
    const { createApplication } = await import('../apps/api/dist/app.js');
    stage = 'SEED_SYNTHETIC_SCENARIOS';
    fixture = await controlledExpressFixture();
    const f = fixture,
      db = f.controlled.db;
    const schema = (await db.$queryRaw`SELECT current_schema() AS schema`)[0].schema;
    assert.match(schema, /^address_ui_[a-f0-9]{32}$/);
    const shipped = await f.controlledOrder(),
      waiting = await f.controlledOrder(),
      canceled = await f.controlledOrder();
    const ship = {
      version: 0,
      carrierCode: 'SF',
      trackingNo: 'SF-RECOVERY-ORIGINAL',
      dispatchConfirmed: true,
    };
    const correction = {
      version: 0,
      carrierCode: 'ZTO',
      trackingNo: 'ZTO-RECOVERY-CURRENT',
      reason: '合成恢复核对',
      verified: true,
    };
    const feedback = { category: 'OTHER', message: '合成恢复反馈原文' };
    const shipKey = randomUUID(),
      correctionKey = randomUUID(),
      feedbackKey = randomUUID(),
      cancelKey = randomUUID();
    const staffCall = (path, body, key) => f.call(path, body, key, '', true);
    assert.equal(
      (await staffCall('/admin/redemptions/' + shipped.id + '/ship', ship, shipKey)).status,
      200,
    );
    assert.equal(
      (
        await staffCall(
          '/admin/redemptions/' + shipped.id + '/shipping-corrections',
          correction,
          correctionKey,
        )
      ).status,
      200,
    );
    assert.equal(
      (await f.call('/consumer/redemptions/' + shipped.id + '/after-sales', feedback, feedbackKey))
        .status,
      200,
    );
    assert.equal(
      (await f.call('/consumer/redemptions/' + canceled.id + '/cancel', { version: 0 }, cancelKey))
        .status,
      200,
    );
    const original = (await f.call('/consumer/redemptions/' + shipped.id)).data;
    const originalFeedback = (await f.call('/consumer/redemptions/' + shipped.id + '/after-sales'))
      .data;
    // Store a synthetic key copy separately in memory, never in the DB backup/report.
    const keyCopy = Buffer.from(f.config.addressEncryptionKey, 'hex');
    const config = structuredClone(f.config);
    config.pointsExpress.submit = false;
    config.pointsExpress.operations = false;
    stage = 'SNAPSHOT_SOURCE';
    const tables = await snapshot(lab.sourceUrl, schema);
    await f.controlled.close();
    await f.closeForColdBackup();
    fixture = undefined;
    stage = 'COPY_AND_RESTORE_STOPPED_CLUSTER';
    const startedAt = Date.now(),
      backup = await lab.backupAndRestore();
    stage = 'COMPARE_RESTORED_ROWS';
    assert.deepEqual(await snapshot(backup.restoredUrl, schema), tables);
    const recoveryMilliseconds = Date.now() - startedAt;
    const restoredUrl = new URL(backup.restoredUrl);
    restoredUrl.searchParams.set('schema', schema);
    // A syntactically valid but wrong key must fail private reads, never produce a blank address.
    stage = 'WRONG_KEY_REJECTION';
    restored = await createApplication(restoredUrl.toString(), {
      config: { ...config, addressEncryptionKey: randomBytes(32).toString('hex') },
      accessLog: () => {},
    });
    await restored.app.listen(0, '127.0.0.1');
    let base = await restored.app.getUrl();
    async function request(path, body, key = randomUUID(), staff = false) {
      const r = await fetch(base + '/api/v1' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          ...(staff
            ? {
                Cookie: f.cookie,
                Origin: 'http://127.0.0.1:5188',
                'X-CSRF-Token': f.profile.csrfToken,
              }
            : { Authorization: 'Bearer ' + f.a.token }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: r.status, ...(await r.json()) };
    }
    assert.equal((await request('/consumer/redemptions/' + shipped.id)).status, 500);
    assert.equal(
      (await request('/consumer/redemptions/' + shipped.id + '/after-sales')).status,
      500,
    );
    await restored.close();
    restored = undefined;
    stage = 'RESTORE_KEY_AND_REPLAY';
    config.addressEncryptionKey = keyCopy.toString('hex');
    keyCopy.fill(0);
    restored = await createApplication(restoredUrl.toString(), { config, accessLog: () => {} });
    await restored.app.listen(0, '127.0.0.1');
    base = await restored.app.getUrl();
    const order = await request('/consumer/redemptions/' + shipped.id);
    assert.equal(order.status, 200);
    assert.deepEqual(order.data.address, original.address);
    assert.equal(order.data.expressShipment.trackingNo, correction.trackingNo);
    assert.equal(order.data.expressShipment.shippedAt, original.expressShipment.shippedAt);
    assert.equal(order.data.executionMode, 'CONTROLLED');
    const conversation = await request('/consumer/redemptions/' + shipped.id + '/after-sales');
    assert.equal(conversation.status, 200);
    assert.deepEqual(conversation.data.ticket, originalFeedback.ticket);
    assert.equal((await request('/consumer/redemption-quotes', f.quoteInput)).status, 503);
    assert.equal(
      (
        await request(
          '/admin/redemptions/' + waiting.id + '/ship',
          { ...ship, trackingNo: 'SF-RECOVERY-NEW' },
          randomUUID(),
          true,
        )
      ).status,
      503,
    );
    // Successful keys remain recoverable while all new write gates are paused.
    for (const item of [shipped, waiting, canceled]) {
      const r = await request('/consumer/redemptions', { quoteId: item.quote.id }, item.key);
      assert.equal(r.status, 200);
      assert.equal(r.data.id, item.id);
    }
    assert.equal(
      (await request('/admin/redemptions/' + shipped.id + '/ship', ship, shipKey, true)).status,
      200,
    );
    assert.equal(
      (
        await request(
          '/admin/redemptions/' + shipped.id + '/shipping-corrections',
          correction,
          correctionKey,
          true,
        )
      ).status,
      200,
    );
    assert.equal(
      (await request('/consumer/redemptions/' + shipped.id + '/after-sales', feedback, feedbackKey))
        .status,
      200,
    );
    assert.equal(
      (await request('/consumer/redemptions/' + canceled.id + '/cancel', { version: 0 }, cancelKey))
        .status,
      200,
    );
    // Every historical identity must still belong to its original shipment after restore.
    config.pointsExpress.operations = true;
    for (const used of [ship, correction]) {
      assert.equal(
        (
          await request(
            '/admin/redemptions/' + waiting.id + '/ship',
            { ...ship, carrierCode: used.carrierCode, trackingNo: used.trackingNo },
            randomUUID(),
            true,
          )
        ).status,
        409,
      );
    }
    config.pointsExpress.operations = false;
    stage = 'COMPARE_AFTER_REPLAY';
    const after = await snapshot(backup.restoredUrl, schema);
    // Authentication can touch session timestamps; all other rows must remain exact.
    for (const [table, digest] of Object.entries(tables))
      if (!['staff_sessions', 'consumer_sessions'].includes(table))
        assert.deepEqual(after[table], digest, table);
    const report = await request(
      '/admin/redemption-express-readiness',
      undefined,
      randomUUID(),
      true,
    );
    assert.equal(report.status, 200);
    assert.equal(report.data.metrics.inconsistentOrders, 0);
    assert.equal(report.data.canLaunch, false);
    assert.equal(await restored.db.redemptionPickingTask.count(), 0);
    await restored.close();
    restored = undefined;
    const result = {
      passed: true,
      generatedAt: new Date().toISOString(),
      canLaunch: false,
      method: 'STOPPED_FULL_CLUSTER_COPY',
      postgres: '17.11',
      syntheticOnly: true,
      tablesCompared: Object.keys(tables).length,
      filesVerified: backup.files,
      bytesVerified: backup.bytes,
      backupSha256: backup.digest,
      recoveryMilliseconds,
      originalRequestsReplayed: 7,
      wrongKeyReadsRejected: 2,
      historicalWaybillsRejected: 2,
      externalKeyEscrowVerified: false,
      productionRecoveryVerified: false,
      pitrVerified: false,
      productionRpoRtoVerified: false,
    };
    await lab.cleanup();
    await writeFile(
      '.local/express-recovery-report.json',
      JSON.stringify({ ...result, cleaned: true }, null, 2) + '\n',
    );
    console.log(JSON.stringify({ ...result, cleaned: true }, null, 2));
  } finally {
    await restored?.close();
    if (fixture) {
      await fixture.controlled.close();
      await fixture.closeForColdBackup();
    }
    await lab.cleanup();
    if (previous === undefined) delete process.env.TEST_DATABASE_URL;
    else process.env.TEST_DATABASE_URL = previous;
  }
}

async function snapshot(url, schema) {
  assert.match(schema, /^address_ui_[a-f0-9]{32}$/);
  const client = new Client({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const names = await client.query(
      'SELECT tablename FROM pg_tables WHERE schemaname=$1 ORDER BY tablename',
      [schema],
    );
    const result = {};
    for (const { tablename } of names.rows) {
      assert.match(tablename, /^[a-z_]+$/);
      const rows = await client.query(
        `SELECT to_jsonb(t)::text AS row FROM "${schema}"."${tablename}" t ORDER BY to_jsonb(t)::text`,
      );
      result[tablename] = {
        rows: rows.rowCount,
        sha256: createHash('sha256').update(JSON.stringify(rows.rows)).digest('hex'),
      };
    }
    await client.query('COMMIT');
    return result;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  const detail =
    error instanceof assert.AssertionError && typeof error.actual === 'number'
      ? ` (actual=${error.actual}, expected=${error.expected})`
      : '';
  const code = /^[A-Z_0-9]+$/.test(error.message)
    ? error.message
    : /^[A-Z_0-9]+$/.test(error.code ?? '')
      ? error.code
      : 'CHECK_FAILED';
  console.error(
    `LOCAL_RECOVERY_FAILED at ${stage}: ${code}; no production acceptance granted.` + detail,
  );
  process.exitCode = 1;
});
