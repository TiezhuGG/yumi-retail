// Disposable local schema, synthetic address data only. Never writes operational service range.
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { createApplication } from '../../apps/api/dist/app.js';
import { applicationConfig } from '../../apps/api/dist/config.js';
import type { WechatExchange } from '../../apps/api/src/wechat-login.js';
export async function addressFixture(
  options: {
    orders?: boolean;
    redemptions?: boolean;
    redemptionPicking?: boolean;
    holdSeconds?: number;
    pickingLab?: boolean;
    notificationLab?: boolean;
    wechatExchange?: WechatExchange;
  } = {},
) {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '');
  if (
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/yumi_test' ||
    url.searchParams.has('schema')
  )
    throw Error('Disposable local test schema only');
  const { Client } = createRequire(import.meta.url)('pg'),
    admin = new Client({ connectionString: url.toString() }),
    schema = 'address_ui_' + randomUUID().replaceAll('-', '');
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  await admin.query("SELECT set_config('search_path',$1,false)", [schema]);
  let runtime: Awaited<ReturnType<typeof createApplication>> | undefined;
  const cleanup = async () => {
    if (runtime) await runtime.close();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  };
  try {
    for (const dir of (await readdir('packages/database/prisma/migrations'))
      .filter((n) => /^\d/.test(n))
      .sort())
      await admin.query(
        await readFile(`packages/database/prisma/migrations/${dir}/migration.sql`, 'utf8'),
      );
    url.searchParams.set('schema', schema);
    const warehouseId = randomUUID(),
      areaId = randomUUID(),
      buildingId = randomUUID();
    runtime = await createApplication(url.toString(), {
      config: applicationConfig({
        NODE_ENV: 'test',
        PICKING_LAB_ENABLED: options.pickingLab ? '1' : '0',
        PAYMENT_NOTIFICATION_LAB_ENABLED: options.notificationLab ? '1' : '0',
        REDEMPTION_PICKING_DEV_ENABLED: options.redemptionPicking ? '1' : '0',
        REDEMPTION_DEV_SUBMIT_ENABLED: options.redemptions ? '1' : '0',
        ORDER_DEV_SUBMIT_ENABLED: options.orders ? '1' : '0',
        ORDER_DEV_HOLD_SECONDS: String(options.holdSeconds ?? 900),
        STAFF_ALLOWED_ORIGINS: 'http://127.0.0.1:5188,http://127.0.0.1:5173',
        PUBLIC_WAREHOUSE_ID: warehouseId,
        CONSUMER_DEV_LOGIN_ENABLED: '1',
        WECHAT_LOGIN_ENABLED: options.wechatExchange ? '1' : '0',
        WECHAT_APP_ID: options.wechatExchange ? 'wx' + '0'.repeat(16) : undefined,
        WECHAT_APP_SECRET: options.wechatExchange ? randomBytes(16).toString('hex') : undefined,
        ADDRESS_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      }),
      accessLog: () => {},
      wechatExchange: options.wechatExchange,
    });
    await runtime.db.warehouse.create({
      data: { id: warehouseId, code: 'ADDRESS-UI', name: '隔离测试仓' },
    });
    await runtime.db.serviceArea.create({
      data: { id: areaId, warehouseId, name: '合成验收小区（非真实范围）', enabled: true },
    });
    await runtime.db.serviceBuilding.create({
      data: { id: buildingId, areaId, name: '合成1栋', nameKey: '合成1栋', enabled: true },
    });
    await runtime.app.listen(0, '127.0.0.1');
    const base = await runtime.app.getUrl();
    const response = await fetch(base + '/api/v1/consumer/auth/dev-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Yumi-Dev-Login': '1' },
      body: JSON.stringify({ profile: 'customer-a' }),
    });
    if (response.status !== 200) throw Error('Fixture login failed');
    const { data: identity } = (await response.json()) as {
      data: {
        token: string;
        expiresAt: string;
        user: { id: string; displayName: string; provider: 'DEVELOPMENT' };
      };
    };
    return {
      runtime,
      base,
      identity,
      areaId,
      buildingId,
      warehouseId,
      cleanup,
      // Only for an owner of a disposable whole cluster: leave the schema intact,
      // release every connection before cold backup; the owner removes that cluster.
      async closeForColdBackup() {
        await runtime?.close();
        await admin.end();
      },
    };
  } catch (e) {
    // A transactional migration may fail before COMMIT. Clear the aborted transaction
    // so schema cleanup can still run and the diagnostic is not masked.
    await admin.query('ROLLBACK');
    await cleanup();
    throw e;
  }
}
