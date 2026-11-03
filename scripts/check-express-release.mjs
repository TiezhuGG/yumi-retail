import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { inspectLocalConfiguration, rehearseMigrations } from './check-fulfillment-local.mjs';
export async function expressReleaseReport(env, options = {}) {
  const checks = inspectLocalConfiguration(env, options.nodeVersion);
  checks.push({
    code: 'FORMAL_SWITCHES_OFF',
    ok:
      (env.POINTS_EXPRESS_MODE === undefined || env.POINTS_EXPRESS_MODE === 'off') &&
      ['POINTS_EXPRESS_SUBMIT_ENABLED', 'POINTS_EXPRESS_OPERATIONS_ENABLED'].every(
        (k) => env[k] === undefined || env[k] === '0',
      ),
    detail:
      'Local preparation keeps formal points mode and write switches off; inspect formal configuration separately.',
  });
  const json = JSON.parse(
    await readFile(new URL('../docs/api/openapi.json', import.meta.url), 'utf8'),
  );
  const folders = (
    await readdir(new URL('../packages/database/prisma/migrations/', import.meta.url))
  )
    .filter((n) => /^\d/.test(n))
    .sort();
  const migrations = await Promise.all(
    folders.map(async (name) => ({
      name,
      sha256: createHash('sha256')
        .update(
          await readFile(
            new URL(
              '../packages/database/prisma/migrations/' + name + '/migration.sql',
              import.meta.url,
            ),
          ),
        )
        .digest('hex'),
    })),
  );
  const artifacts = [];
  for (const path of [
    'pnpm-lock.yaml',
    'docs/api/openapi.json',
    'apps/api/dist/app.js',
    'apps/worker/dist/main.js',
    'apps/admin-web/dist/index.html',
    'apps/ops-mobile/dist/index.html',
    'apps/consumer-mini/dist/app.json',
  ]) {
    try {
      const content = await readFile(new URL('../' + path, import.meta.url));
      artifacts.push({
        path,
        sha256: createHash('sha256').update(content).digest('hex'),
        bytes: content.length,
      });
    } catch {
      checks.push({
        code: 'ARTIFACT_' + path,
        ok: false,
        detail: 'Required local artifact missing.',
      });
    }
  }
  let miniBuild = 'UNVERIFIED';
  try {
    const info = JSON.parse(
      await readFile(new URL('../.local/mini-build.json', import.meta.url), 'utf8'),
    );
    const { verifyBuildInfo } = await import('./mini-build-info.mjs');
    verifyBuildInfo(
      fileURLToPath(new URL('../apps/consumer-mini/dist/', import.meta.url)),
      info,
      info.target,
    );
    miniBuild = info.target === 'device' ? 'DEVICE_OUTPUT_ONLY' : 'LOCAL_OUTPUT_ONLY';
  } catch {
    /* No configured URL or parser errors printed. */
  }
  checks.push({
    code: 'MINI_MANIFEST',
    ok: miniBuild !== 'UNVERIFIED',
    detail:
      'A valid current mini output manifest is required; a local/device build is not device acceptance.',
  });
  const report = {
    checkedAt: new Date().toISOString(),
    scope: 'LOCAL_PREPARATION',
    localChecksPassed: checks.every((c) => c.ok),
    canLaunch: false,
    apiVersion: json.info.version,
    checks,
    migrations,
    artifacts,
    miniBuild,
    artifactLimit:
      'Hashes identify current files only; they do not prove a matching build, health, device acceptance or deployment.',
    migrationRehearsal: null,
    remaining: [
      {
        code: 'WECHAT_IDENTITY',
        status: 'BLOCKED',
        detail: '微信身份适配器已实现；真实账号/凭据/HTTPS及真机联调未验收。',
      },
      {
        code: 'PRODUCTION_WRITE',
        status: 'BLOCKED',
        detail: '独立正式门禁已实现；真实环境配置、身份、设备及发布验收仍待完成。',
      },
      { code: 'DEVICE', status: 'UNVERIFIED', detail: 'HTTPS/合法域名/开发工具/真机验收。' },
      { code: 'PHYSICAL', status: 'UNVERIFIED', detail: '实物/打印机/实际交快递和真实运单核实。' },
      {
        code: 'BACKUP_RESTORE',
        status: 'UNVERIFIED',
        detail: '数据库及加密密钥的独立备份恢复，不以迁移重放替代。',
      },
      {
        code: 'OPERATIONS_DEPLOYMENT',
        status: 'UNVERIFIED',
        detail: '经营参数、值守/监控及明确授权后的受控部署。',
      },
    ],
  };
  if (options.rehearse) {
    if (!report.localChecksPassed) throw Error('LOCAL_CONFIGURATION_REQUIRED');
    report.migrationRehearsal = await rehearseMigrations(env.TEST_DATABASE_URL ?? '');
  }
  return report;
}
export async function main(args = process.argv.slice(2)) {
  if (args.some((a) => a !== '--rehearse')) throw Error('UNKNOWN_ARGUMENT');
  const report = await expressReleaseReport(process.env, { rehearse: args.includes('--rehearse') });
  console.log(JSON.stringify(report, null, 2));
  if (!report.localChecksPassed) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => {
    console.error('Express local preparation failed; no configuration values or SQL logged.');
    process.exitCode = 1;
  });
