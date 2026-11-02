import { existsSync, readFileSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { Client } from 'pg';

const flags = [
  'CONSUMER_DEV_LOGIN_ENABLED',
  'ORDER_DEV_SUBMIT_ENABLED',
  'REDEMPTION_DEV_SUBMIT_ENABLED',
  'PAYMENT_NOTIFICATION_LAB_ENABLED',
  'PAYMENT_QUERY_LAB_WORKER_ENABLED',
  'PICKING_LAB_ENABLED',
];
export function inspectLocalConfiguration(env, version = process.versions.node) {
  const expected = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    .engines.node;
  const checks = [
    { code: 'NODE', ok: version === expected, detail: `Node ${version}; required ${expected}` },
    {
      code: 'SAFE_SWITCHES',
      ok: flags.every((k) => env[k] === undefined || env[k] === '0'),
      detail: 'Development write/login/worker switches must remain off.',
    },
    {
      code: 'PAYMENT_DISABLED',
      ok: env.PAYMENT_MODE === undefined || env.PAYMENT_MODE === 'disabled',
      detail: 'No real payment adapter may be enabled.',
    },
    {
      code: 'LOCAL_BINDING',
      ok: env.API_HOST === undefined || ['127.0.0.1', 'localhost', '::1'].includes(env.API_HOST),
      detail: 'Local API binding only.',
    },
    {
      code: 'LOCAL_ENVIRONMENT',
      ok: env.NODE_ENV === undefined || ['development', 'test'].includes(env.NODE_ENV),
      detail: 'Local preparation cannot approve production.',
    },
  ];
  for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL']) {
    let ok = false;
    try {
      const u = new URL(env[key] ?? '');
      ok =
        ['postgres:', 'postgresql:'].includes(u.protocol) &&
        ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) &&
        u.pathname === (key === 'TEST_DATABASE_URL' ? '/yumi_test' : '/yumi_dev') &&
        !u.search;
    } catch {
      /* No values or parser errors are logged. */
    }
    checks.push({
      code: key,
      ok,
      detail:
        key === 'TEST_DATABASE_URL'
          ? 'Explicit loopback yumi_test URL without schema required.'
          : 'Explicit loopback yumi_dev URL without schema required.',
    });
  }
  return checks;
}
export async function rehearseMigrations(connectionString) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw Error('LOCAL_TEST_DATABASE_REQUIRED');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/yumi_test' ||
    !!url.search
  )
    throw Error('LOCAL_TEST_DATABASE_REQUIRED');
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
    statement_timeout: 15000,
    lock_timeout: 5000,
  });
  const schema = 'preflight_' + randomUUID().replaceAll('-', '');
  let created = false;
  try {
    await client.connect();
    await client.query(`CREATE SCHEMA "${schema}"`);
    created = true;
    await client.query(`SET search_path TO "${schema}"`);
    await client.query("SET TIME ZONE 'UTC'");
    const folders = (
      await readdir(new URL('../packages/database/prisma/migrations/', import.meta.url))
    )
      .filter((n) => /^\d/.test(n))
      .sort();
    for (const folder of folders)
      await client.query(
        await readFile(
          new URL(
            `../packages/database/prisma/migrations/${folder}/migration.sql`,
            import.meta.url,
          ),
          'utf8',
        ),
      );
    const result = await client.query(
      'SELECT count(*)::int AS count FROM information_schema.tables WHERE table_schema=$1',
      [schema],
    );
    const gate = await client.query(
      "SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1 AND p.proname='yumi_delivery_assignment_gate'",
      [schema],
    );
    if (!gate.rows[0]?.prosrc.includes('NEW.actor_id')) throw Error('ASSIGNER_GATE_MISSING');
    return {
      migrationCount: folders.length,
      tableCount: result.rows[0].count,
      assignerGate: true,
      timezone: 'UTC',
      scope: 'disposable test schema',
      cleanup: 'completed before report returns',
    };
  } finally {
    try {
      if (created) {
        await client.query('ROLLBACK');
        await client.query('SET search_path TO public');
        await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
    } finally {
      await client.end();
    }
  }
}
export async function inspectLocalDatabases(env) {
  const checks = inspectLocalConfiguration(env);
  if (checks.some((c) => ['DATABASE_URL', 'TEST_DATABASE_URL'].includes(c.code) && !c.ok))
    throw Error('LOCAL_DATABASES_REQUIRED');
  const folders = (
    await readdir(new URL('../packages/database/prisma/migrations/', import.meta.url))
  )
    .filter((n) => /^\d/.test(n))
    .sort();
  const expected = await Promise.all(
    folders.map(async (n) => ({
      name: n,
      checksum: createHash('sha256')
        .update(
          await readFile(
            new URL(
              '../packages/database/prisma/migrations/' + n + '/migration.sql',
              import.meta.url,
            ),
          ),
        )
        .digest('hex'),
    })),
  );
  const results = [];
  for (const [label, key] of [
    ['development', 'DATABASE_URL'],
    ['test', 'TEST_DATABASE_URL'],
  ]) {
    const c = new Client({
      connectionString: env[key],
      connectionTimeoutMillis: 5000,
      statement_timeout: 10000,
    });
    try {
      await c.connect();
      const meta = (
        await c.query(
          "SELECT current_setting('TimeZone') AS timezone,current_setting('server_version') AS version",
        )
      ).rows[0];
      const applied = (
        await c.query(
          'SELECT migration_name,checksum,finished_at,rolled_back_at FROM public._prisma_migrations',
        )
      ).rows;
      const migrationsMatch =
        expected.every((e) =>
          applied.some(
            (a) =>
              a.migration_name === e.name &&
              a.checksum === e.checksum &&
              a.finished_at &&
              !a.rolled_back_at,
          ),
        ) &&
        applied.filter((a) => a.finished_at && !a.rolled_back_at).length === expected.length &&
        !applied.some((a) => !a.finished_at && !a.rolled_back_at);
      const gate = (
        await c.query(
          "SELECT prosrc FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='yumi_delivery_assignment_gate'",
        )
      ).rows[0];
      results.push({
        database: label,
        version: meta.version,
        versionCompatible: meta.version.split(' ')[0] === '17.11',
        timezoneUtc: meta.timezone === 'UTC',
        appliedMigrations: applied.filter((a) => a.finished_at && !a.rolled_back_at).length,
        expectedMigrations: expected.length,
        migrationsMatch,
        assignerGate: !!gate?.prosrc.includes('NEW.actor_id'),
      });
    } finally {
      await c.end();
    }
  }
  return results;
}
export async function main(args = process.argv.slice(2)) {
  if (args.some((a) => !['--rehearse', '--database'].includes(a))) throw Error('UNKNOWN_ARGUMENT');
  const checks = inspectLocalConfiguration(process.env);
  const paths = [
    'apps/api/dist/app.js',
    'apps/worker/dist/main.js',
    'packages/database/src/generated/prisma/client.ts',
    'apps/admin-web/dist/index.html',
    'apps/ops-mobile/dist/index.html',
  ];
  for (const path of paths)
    checks.push({
      code: 'ARTIFACT_' + path.split('/')[1],
      ok: existsSync(path),
      detail: path + ' presence only; not proof of freshness or health.',
    });
  const report = {
    checkedAt: new Date().toISOString(),
    localChecksPassed: checks.every((c) => c.ok),
    canStartRealFulfillment: false,
    checks,
    rehearsal: null,
    databaseInspection: null,
    externalGates: [
      {
        code: 'BUSINESS',
        status: 'UNVERIFIED',
        detail: '负责人确认真实小区楼栋、商品实物、营业及费用/缺货/退回规则。',
      },
      {
        code: 'REAL_PAYMENT',
        status: 'BLOCKED',
        detail: '真实渠道下单/通知入账/查询补偿未闭环；合成结果不能通过此门禁。',
      },
      {
        code: 'DEVICE',
        status: 'UNVERIFIED',
        detail: 'HTTPS测试API、微信工具/真机及仓管骑手实际弱网验收。',
      },
      {
        code: 'REAL_FULFILLMENT',
        status: 'BLOCKED',
        detail: '正式订单拣货出库/配送链路尚未接入；现有演练为独立合成凭据。',
      },
      {
        code: 'PRODUCTION',
        status: 'UNVERIFIED',
        detail: '部署、备份恢复、安全及受控真实走单需独立授权验收。',
      },
    ],
  };
  if (args.includes('--rehearse')) {
    try {
      report.rehearsal = await rehearseMigrations(process.env.TEST_DATABASE_URL ?? '');
    } catch (e) {
      report.localChecksPassed = false;
      report.rehearsal = {
        error: /^[A-Z0-9_]{1,60}$/.test(e.code ?? e.message ?? '')
          ? (e.code ?? e.message)
          : 'REHEARSAL_FAILED',
        detail: 'Migration rehearsal failed; no connection string or SQL contents are logged.',
      };
    }
  }
  if (args.includes('--database')) {
    try {
      report.databaseInspection = await inspectLocalDatabases(process.env);
      if (
        report.databaseInspection.some(
          (r) => !r.versionCompatible || !r.timezoneUtc || !r.migrationsMatch || !r.assignerGate,
        )
      )
        report.localChecksPassed = false;
    } catch {
      report.localChecksPassed = false;
      report.databaseInspection = {
        error: 'LOCAL_DATABASE_INSPECTION_FAILED',
        detail: 'Check local PostgreSQL and applied migrations; no connection values logged.',
      };
    }
  }
  console.log(JSON.stringify(report, null, 2));
  if (!report.localChecksPassed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error('Local preparation check failed; no configuration values logged.');
    process.exitCode = 1;
  });
