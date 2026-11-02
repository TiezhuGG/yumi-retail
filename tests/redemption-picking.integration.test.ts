import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  leaseRedemptionPicking,
  finishRedemptionPicking,
  failRedemptionPicking,
  runRedemptionPickingOnce,
  redemptionPickingWorkerEnabled,
} from '../packages/database/dist/index.js';
import { applicationConfig } from '../apps/api/dist/config.js';
import { RedemptionPickingService } from '../apps/api/dist/redemption-picking.js';
import { redemptionPickingFixture } from './helpers/redemption-picking-fixture.ts';
async function fixture(
  work: (f: Awaited<ReturnType<typeof redemptionPickingFixture>>) => Promise<void>,
  enabled = true,
) {
  const f = await redemptionPickingFixture(enabled);
  try {
    await work(f);
  } finally {
    await f.cleanup();
  }
}
test('local worker/API controls default off and reject production, remote or malformed activation', async () => {
  assert.equal(redemptionPickingWorkerEnabled({}), false);
  assert.throws(() =>
    redemptionPickingWorkerEnabled({
      REDEMPTION_FULFILLMENT_WORKER_ENABLED: '1',
      DATABASE_URL: 'postgresql://127.0.0.1/yumi_test?host=remote.invalid',
    }),
  );
  assert.equal(applicationConfig({}).redemptionPickingDev, false);
  for (const env of [
    { REDEMPTION_FULFILLMENT_WORKER_ENABLED: 'true' },
    {
      REDEMPTION_FULFILLMENT_WORKER_ENABLED: '1',
      DATABASE_URL: 'postgresql://127.0.0.1/yumi_test',
      NODE_ENV: 'production',
    },
    {
      REDEMPTION_FULFILLMENT_WORKER_ENABLED: '1',
      DATABASE_URL: 'postgresql://remote.invalid/yumi_test',
    },
  ])
    assert.throws(() => redemptionPickingWorkerEnabled(env));
  assert.throws(() => applicationConfig({ REDEMPTION_PICKING_DEV_ENABLED: 'true' }));
  assert.throws(() =>
    applicationConfig({
      NODE_ENV: 'production',
      STAFF_ALLOWED_ORIGINS: 'https://example.invalid',
      REDEMPTION_PICKING_DEV_ENABLED: '1',
    }),
  );
  await fixture(async (f) => {
    const id = await f.order();
    await runRedemptionPickingOnce(f.runtime.db);
    assert.equal(
      (await f.api(f.prefix + '/' + id + '/claim', { version: 0 })).error?.code,
      'REDEMPTION_PICKING_DISABLED',
    );
    assert.equal((await f.read(id)).data.enabled, false);
  }, false);
});
test('parallel workers lease one job and materialize one real source task without moving points or stock', async () =>
  fixture(async (f) => {
    const id = await f.order(),
      db = f.runtime.db,
      balance = await db.pointsAccount.findMany(),
      stock = await db.stockBalance.findMany();
    const leases = await Promise.all([leaseRedemptionPicking(db), leaseRedemptionPicking(db)]);
    assert.equal(leases.filter(Boolean).length, 1);
    const lease = leases.find(Boolean)!;
    assert.equal(await finishRedemptionPicking(db, lease), true);
    assert.equal(await finishRedemptionPicking(db, lease), false);
    assert.equal(await db.redemptionPickingTask.count(), 1);
    assert.equal(
      (await db.redemptionPickingTask.findUniqueOrThrow({ where: { orderId: id } })).state,
      'READY',
    );
    assert.deepEqual(await db.pointsAccount.findMany(), balance);
    assert.deepEqual(await db.stockBalance.findMany(), stock);
    assert.equal(await db.pickingLabTask.count(), 0);
    const view = (await f.read(id)).data.items[0]!;
    assert.equal(view.readiness.ready, true);
    assert.equal(view.lines[0]!.batchNo, 'CART-0');
    assert.equal('address' in view, false);
    assert.equal('leaseToken' in view.job, false);
    assert.equal(
      (await f.call('/consumer/redemptions/' + id)).data.fulfillmentState,
      'READY_TO_PICK',
    );
  }));
test('canceling before materialization fences a leased worker; canceling READY task stops it and refunds once', async () =>
  fixture(async (f) => {
    const db = f.runtime.db,
      id = await f.order(),
      lease = (await leaseRedemptionPicking(db))!;
    assert.equal(
      (await f.call('/consumer/redemptions/' + id + '/cancel', { version: 0 })).status,
      200,
    );
    assert.equal(await finishRedemptionPicking(db, lease), false);
    assert.equal(await db.redemptionPickingTask.count(), 0);
    const second = await f.order();
    await runRedemptionPickingOnce(db);
    assert.equal(
      (await f.call('/consumer/redemptions/' + second + '/cancel', { version: 0 })).status,
      200,
    );
    assert.equal(
      (await db.redemptionPickingTask.findUniqueOrThrow({ where: { orderId: second } })).state,
      'CANCELED',
    );
    assert.equal(
      await db.pointsEntry.count({ where: { redemptionId: second, redemptionAction: 'CANCEL' } }),
      1,
    );
    assert.equal((await f.api(f.prefix + '/' + second + '/claim', { version: 0 })).status, 409);
  }));
test('two staff compete for one claim; original request recovers and consumer cancel is rejected after claim', async () =>
  fixture(async (f) => {
    const db = f.runtime.db,
      id = await f.order();
    await runRedemptionPickingOnce(db);
    const other = await f.workerActor(),
      k = randomUUID();
    const outcomes = await Promise.all([
      f.api(f.prefix + '/' + id + '/claim', { version: 0 }, k),
      f.api(f.prefix + '/' + id + '/claim', { version: 0 }, randomUUID(), other.cookie, other.csrf),
    ]);
    assert.deepEqual(outcomes.map((r) => r.status).sort(), [200, 409]);
    const task = await db.redemptionPickingTask.findUniqueOrThrow({ where: { orderId: id } });
    assert.equal(task.state, 'CLAIMED');
    assert.equal(
      await db.redemptionPickingEvent.count({ where: { taskId: task.id, action: 'CLAIMED' } }),
      1,
    );
    if (outcomes[0]!.status === 200)
      assert.equal((await f.api(f.prefix + '/' + id + '/claim', { version: 0 }, k)).status, 200);
    assert.equal(
      (await f.call('/consumer/redemptions/' + id + '/cancel', { version: 0 })).error?.code,
      'CANCELLATION_REVIEW_REQUIRED',
    );
    assert.equal(
      (await db.pointsAccount.findUniqueOrThrow({ where: { userId: f.identity.user.id } })).balance,
      880n,
    );
    assert.equal((await f.call('/consumer/redemptions/' + id)).data.fulfillmentState, 'PICKING');
  }));
test('concurrent claim and consumer cancel have exactly one permitted outcome', async () =>
  fixture(async (f) => {
    const db = f.runtime.db,
      id = await f.order();
    await runRedemptionPickingOnce(db);
    const [claim, cancel] = await Promise.all([
      f.api(f.prefix + '/' + id + '/claim', { version: 0 }),
      f.call('/consumer/redemptions/' + id + '/cancel', { version: 0 }),
    ]);
    assert.equal([claim, cancel].filter((r) => r.status === 200).length, 1);
    assert.equal([claim, cancel].filter((r) => r.status === 409).length, 1);
    const o = await db.redemptionOrder.findUniqueOrThrow({ where: { id } }),
      task = await db.redemptionPickingTask.findUniqueOrThrow({ where: { orderId: id } }),
      account = await db.pointsAccount.findUniqueOrThrow({ where: { userId: f.identity.user.id } });
    if (o.status === 'CANCELED') {
      assert.equal(task.state, 'CANCELED');
      assert.equal(account.balance, 1000n);
    } else {
      assert.equal(task.state, 'CLAIMED');
      assert.equal(account.balance, 880n);
    }
  }));
test('expired lease is recovered under a new token and stale worker cannot finalize', async () =>
  fixture(async (f) => {
    const db = f.runtime.db;
    await f.order();
    const old = (await leaseRedemptionPicking(db, 1))!;
    await delay(1100);
    const next = (await leaseRedemptionPicking(db, 30))!;
    assert.notEqual(old.token, next.token);
    assert.equal(await finishRedemptionPicking(db, old), false);
    assert.equal(await failRedemptionPicking(db, old), false);
    assert.equal(await finishRedemptionPicking(db, next), true);
    assert.equal(await db.redemptionPickingTask.count(), 1);
    assert.equal(await db.redemptionOutboxEvent.count({ where: { reason: 'RECOVERED' } }), 1);
  }));
test('frozen inventory retries with backoff, exhausts at three attempts and requires authorized manual retry', async () =>
  fixture(async (f) => {
    const db = f.runtime.db,
      id = await f.order(),
      where = { warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.catalog.skuIds[0]! } };
    await db.stockBalance.update({ where, data: { inventoryHold: true } });
    assert.equal(await runRedemptionPickingOnce(db), true);
    assert.equal(
      (await db.redemptionOutbox.findUniqueOrThrow({ where: { orderId: id } })).state,
      'RETRY',
    );
    assert.equal(await leaseRedemptionPicking(db), null);
    await delay(2100);
    await runRedemptionPickingOnce(db);
    await delay(4100);
    await runRedemptionPickingOnce(db);
    const failed = await db.redemptionOutbox.findUniqueOrThrow({ where: { orderId: id } });
    assert.equal(failed.state, 'FAILED');
    assert.equal(failed.attempts, 3);
    assert.equal(await db.redemptionPickingTask.count(), 0);
    const picker = await f.workerActor();
    assert.equal(
      (
        await f.api(
          f.prefix + '/' + id + '/retry',
          { version: failed.version },
          randomUUID(),
          picker.cookie,
          picker.csrf,
        )
      ).status,
      403,
    );
    await db.stockBalance.update({ where, data: { inventoryHold: false } });
    const k = randomUUID();
    assert.equal(
      (await f.api(f.prefix + '/' + id + '/retry', { version: failed.version }, k)).status,
      200,
    );
    assert.equal(
      (await f.api(f.prefix + '/' + id + '/retry', { version: failed.version }, k)).status,
      200,
    );
    await runRedemptionPickingOnce(db);
    assert.equal(
      (await db.redemptionPickingTask.findUniqueOrThrow({ where: { orderId: id } })).state,
      'READY',
    );
  }));
test('claim rechecks holds, expired batches, disabled location and source without changing stock or owner', async () =>
  fixture(async (f) => {
    const db = f.runtime.db,
      id = await f.order();
    await runRedemptionPickingOnce(db);
    const where = {
      warehouseId_skuId: { warehouseId: f.warehouseId, skuId: f.catalog.skuIds[0]! },
    };
    await db.stockBalance.update({ where, data: { inventoryHold: true } });
    assert.equal(
      (await f.api(f.prefix + '/' + id + '/claim', { version: 0 })).error?.code,
      'PICKING_BLOCKED',
    );
    await db.stockBalance.update({ where, data: { inventoryHold: false } });
    const pos = await db.stockPosition.findFirstOrThrow({ where: { skuId: f.catalog.skuIds[0]! } });
    await db.stockLot.update({
      where: { id: pos.lotId },
      data: { producedAt: new Date(0), expiresAt: new Date(86400000) },
    });
    assert.equal((await f.api(f.prefix + '/' + id + '/claim', { version: 0 })).status, 409);
    await db.stockLot.update({
      where: { id: pos.lotId },
      data: { producedAt: null, expiresAt: null },
    });
    await db.warehouseLocation.update({ where: { id: pos.locationId }, data: { enabled: false } });
    assert.equal((await f.api(f.prefix + '/' + id + '/claim', { version: 0 })).status, 409);
    await db.warehouseLocation.update({ where: { id: pos.locationId }, data: { enabled: true } });
    await db.sku.update({ where: { id: f.catalog.skuIds[0]! }, data: { enabled: false } });
    assert.equal((await f.api(f.prefix + '/' + id + '/claim', { version: 0 })).status, 409);
    await db.sku.update({ where: { id: f.catalog.skuIds[0]! }, data: { enabled: true } });
    assert.equal(
      (await db.redemptionPickingTask.findUniqueOrThrow({ where: { orderId: id } })).state,
      'READY',
    );
    assert.equal((await f.api(f.prefix + '/' + id + '/claim', { version: 0 })).status, 200);
  }));
test('late worker/task and claim audit failure roll back; original claim key restores one owner', async () =>
  fixture(async (f) => {
    const db = f.runtime.db,
      id = await f.order();
    await db.$executeRawUnsafe(
      "CREATE FUNCTION reject_pick_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic picking event failure'; END $$",
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER reject_pick_event BEFORE INSERT ON redemption_picking_events FOR EACH ROW EXECUTE FUNCTION reject_pick_event()',
    );
    await runRedemptionPickingOnce(db);
    assert.equal(await db.redemptionPickingTask.count(), 0);
    assert.equal(
      (await db.redemptionOutbox.findUniqueOrThrow({ where: { orderId: id } })).state,
      'RETRY',
    );
    await db.$executeRawUnsafe('DROP TRIGGER reject_pick_event ON redemption_picking_events');
    await delay(2100);
    await runRedemptionPickingOnce(db);
    await db.$executeRawUnsafe(
      "CREATE FUNCTION reject_pick_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='REDEMPTION_PICKING_CLAIM' THEN RAISE EXCEPTION 'synthetic audit failure'; END IF; RETURN NEW; END $$",
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER reject_pick_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION reject_pick_audit()',
    );
    const k = randomUUID();
    assert.equal((await f.api(f.prefix + '/' + id + '/claim', { version: 0 }, k)).status, 500);
    assert.equal(
      (await db.redemptionPickingTask.findUniqueOrThrow({ where: { orderId: id } })).state,
      'READY',
    );
    await db.$executeRawUnsafe('DROP TRIGGER reject_pick_audit ON business_audits');
    assert.equal((await f.api(f.prefix + '/' + id + '/claim', { version: 0 }, k)).status, 200);
    assert.equal(
      await db.redemptionPickingEvent.count({ where: { orderId: id, action: 'CLAIMED' } }),
      1,
    );
  }));
test('roles, warehouse, CSRF, in-transaction revocation and SQL event/source constraints prevent bypass', async () =>
  fixture(async (f) => {
    const db = f.runtime.db,
      id = await f.order();
    await runRedemptionPickingOnce(db);
    const rider = await f.workerActor('RIDER');
    assert.equal(
      (
        await f.api(
          f.prefix + '/' + id + '/claim',
          { version: 0 },
          randomUUID(),
          rider.cookie,
          rider.csrf,
        )
      ).status,
      403,
    );
    const other = await db.warehouse.create({
        data: { id: randomUUID(), code: 'PICK-OTHER', name: '合成其他仓' },
      }),
      outsider = await f.workerActor('PICKER', other.id);
    assert.equal(
      (
        await f.api(
          f.prefix + '/' + id + '/claim',
          { version: 0 },
          randomUUID(),
          outsider.cookie,
          outsider.csrf,
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.api(f.prefix + '/' + id + '/claim', { version: 0 }, randomUUID(), f.cookie, ''))
        .status,
      403,
    );
    const task = await db.redemptionPickingTask.findUniqueOrThrow({ where: { orderId: id } });
    await assert.rejects(db.redemptionPickingTask.delete({ where: { id: task.id } }));
    await assert.rejects(
      db.redemptionPickingTask.update({
        where: { id: task.id },
        data: {
          state: 'CLAIMED',
          ownerId: rider.id,
          claimedAt: new Date(),
          version: { increment: 1 },
        },
      }),
    );
    const service = f.runtime.app.get(RedemptionPickingService),
      original = service.catalog.write.bind(service.catalog),
      staff = await db.staff.findFirstOrThrow({ where: { loginName: 'points-ui' } });
    service.catalog.write = async (...args) => {
      await db.staffWarehouse.deleteMany({ where: { staffId: staff.id } });
      return original(...args);
    };
    try {
      assert.equal((await f.api(f.prefix + '/' + id + '/claim', { version: 0 })).status, 403);
    } finally {
      service.catalog.write = original;
    }
    assert.equal(
      (await db.redemptionPickingTask.findUniqueOrThrow({ where: { orderId: id } })).state,
      'READY',
    );
  }));

test('slow task creation loses its lease without a task; late batch expiry also rolls back a staff claim', async () =>
  fixture(async (f) => {
    const db = f.runtime.db,
      id = await f.order(),
      lease = (await leaseRedemptionPicking(db, 1))!;
    await db.$executeRawUnsafe(
      'CREATE FUNCTION slow_pick_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(1); RETURN NEW; END $$',
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER slow_pick_event BEFORE INSERT ON redemption_picking_events FOR EACH ROW EXECUTE FUNCTION slow_pick_event()',
    );
    await assert.rejects(finishRedemptionPicking(db, lease));
    assert.equal(await db.redemptionPickingTask.count(), 0);
    await db.$executeRawUnsafe('DROP TRIGGER slow_pick_event ON redemption_picking_events');
    const replacement = (await leaseRedemptionPicking(db, 30))!;
    assert.equal(await finishRedemptionPicking(db, replacement), true);
    const lot = await db.stockLot.findFirstOrThrow({ where: { skuId: f.catalog.skuIds[0]! } });
    await db.stockLot.update({
      where: { id: lot.id },
      data: { producedAt: new Date(0), expiresAt: new Date(Date.now() + 700) },
    });
    await db.$executeRawUnsafe(
      "CREATE FUNCTION slow_pick_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='REDEMPTION_PICKING_CLAIM' THEN PERFORM pg_sleep(1); END IF; RETURN NEW; END $$",
    );
    await db.$executeRawUnsafe(
      'CREATE TRIGGER slow_pick_audit BEFORE INSERT ON business_audits FOR EACH ROW EXECUTE FUNCTION slow_pick_audit()',
    );
    assert.equal(
      (await f.api(f.prefix + '/' + id + '/claim', { version: 0 })).error?.code,
      'PICKING_BLOCKED',
    );
    assert.equal(
      (await db.redemptionPickingTask.findUniqueOrThrow({ where: { orderId: id } })).ownerId,
      null,
    );
  }));

test('actual Worker process keeps disabled jobs pending and restart does not duplicate a materialized task', async () =>
  fixture(async (f) => {
    const { spawn } = await import('node:child_process');
    const db = f.runtime.db,
      id = await f.order();
    const schema = (
      await db.$queryRaw<Array<{ name: string }>>`SELECT current_schema() AS name`
    )[0]!.name;
    assert.ok(schema.startsWith('address_ui_'));
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('schema', schema);
    async function start(enabled: boolean) {
      const child = spawn(process.execPath, ['apps/worker/dist/main.js'], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          PAYMENT_MODE: 'disabled',
          DATABASE_URL: url.toString(),
          REDEMPTION_FULFILLMENT_WORKER_ENABLED: enabled ? '1' : '0',
          PAYMENT_QUERY_LAB_WORKER_ENABLED: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let connected = false;
      child.stdout.on('data', (data) => {
        if (String(data).includes('Yumi worker connected')) connected = true;
      });
      child.stderr.on('data', () => {});
      async function stop() {
        if (child.exitCode !== null) return;
        const done = new Promise<void>((resolve) => child.once('exit', () => resolve()));
        child.kill('SIGTERM');
        await Promise.race([done, delay(5000)]);
        if (child.exitCode === null) {
          child.kill('SIGKILL');
          await done;
        }
      }
      for (let i = 0; i < 40 && !connected; i++) {
        if (child.exitCode !== null) throw Error('Worker exited before healthy startup');
        await delay(100);
      }
      if (!connected) {
        await stop();
        throw Error('Worker startup not observed');
      }
      return stop;
    }
    let stop = await start(false);
    try {
      await delay(200);
      assert.equal(
        (await db.redemptionOutbox.findUniqueOrThrow({ where: { orderId: id } })).state,
        'PENDING',
      );
    } finally {
      await stop();
    }
    stop = await start(true);
    try {
      for (let i = 0; i < 40; i++) {
        if (await db.redemptionPickingTask.count({ where: { orderId: id } })) break;
        await delay(100);
      }
      assert.equal(await db.redemptionPickingTask.count({ where: { orderId: id } }), 1);
    } finally {
      await stop();
    }
    stop = await start(true);
    try {
      await delay(200);
      assert.equal(await db.redemptionPickingTask.count({ where: { orderId: id } }), 1);
    } finally {
      await stop();
    }
  }));
