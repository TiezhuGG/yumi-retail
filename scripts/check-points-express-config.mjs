import { pathToFileURL } from 'node:url';
import { applicationConfig } from '../apps/api/dist/config.js';
import { validatePointsExpressRuntime } from '../apps/api/dist/points-express-config.js';
export function inspectPointsExpressConfiguration(env) {
  try {
    const c = applicationConfig(env);
    validatePointsExpressRuntime(env.DATABASE_URL ?? '', c);
    if (!c.pointsExpress || c.pointsExpress.mode === 'off')
      return {
        configurationValid: false,
        canLaunch: false,
        networkChecked: false,
        code: 'FORMAL_MODE_OFF',
      };
    return {
      configurationValid: true,
      canLaunch: false,
      networkChecked: false,
      mode: c.pointsExpress.mode,
      newSubmissionsEnabled: c.pointsExpress.submit,
      operationsEnabled: c.pointsExpress.operations,
      controlledAccountCount: c.pointsExpress.allowedUsers.length,
      checks: [
        'ISOLATED_FROM_DEVELOPMENT',
        'WECHAT_CONFIGURED',
        'WAREHOUSE_CONFIGURED',
        'ENCRYPTION_CONFIGURED',
        'HTTPS_ORIGIN_DECLARED',
        'DATABASE_SCOPE_VALIDATED',
      ],
      remaining: [
        'REAL_WECHAT_AND_HTTPS',
        'DEVICE_ACCEPTANCE',
        'PHYSICAL_SHIPPING',
        'BACKUP_RESTORE',
        'AUTHORIZED_DEPLOYMENT',
      ],
    };
  } catch {
    return {
      configurationValid: false,
      canLaunch: false,
      networkChecked: false,
      code: 'FORMAL_CONFIGURATION_INVALID',
    };
  }
}
export function main(args = process.argv.slice(2)) {
  if (args.length) throw Error('UNKNOWN_ARGUMENT');
  const r = inspectPointsExpressConfiguration(process.env);
  console.log(JSON.stringify(r, null, 2));
  if (!r.configurationValid) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch {
    console.error('Configuration inspection failed; no values printed.');
    process.exitCode = 1;
  }
}
