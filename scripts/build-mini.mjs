import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import {
  apiBaseForBuild,
  collectBuildInfo,
  verifyBuildInfo,
  consumerDevelopmentBuild,
} from './mini-build-info.mjs';

try {
  const target = process.argv[2] || 'local';
  // Validate before touching the existing output or its last valid manifest.
  const apiBase = apiBaseForBuild(process.env.TARO_APP_API_BASE_URL, target);
  const developmentLogin = consumerDevelopmentBuild(
    process.env.TARO_APP_CONSUMER_DEV_LOGIN,
    target,
    apiBase,
    process.env.NODE_ENV,
  );
  const manifest = '.local/mini-build.json';
  mkdirSync('.local', { recursive: true });
  rmSync(manifest, { force: true });
  const build = spawnSync(
    process.execPath,
    ['node_modules/pnpm/bin/pnpm.cjs', '--filter', '@yumi/consumer-mini', 'build'],
    {
      stdio: 'inherit',
      env: { ...process.env, TARO_APP_API_BASE_URL: apiBase, YUMI_MINI_BUILD_TARGET: target },
    },
  );
  if (build.error || build.status !== 0) throw Error('微信编译未成功；未生成可用的构建清单。');
  const artifacts = spawnSync(process.execPath, ['scripts/verify-mini-artifacts.mjs'], {
    stdio: 'inherit',
  });
  if (artifacts.error || artifacts.status !== 0)
    throw Error('微信工程入口或页面产物检查失败，未生成构建清单。');
  const info = collectBuildInfo('apps/consumer-mini/dist', target, apiBase);
  info.consumerDevelopmentLogin = developmentLogin;
  verifyBuildInfo('apps/consumer-mini/dist', info, target);
  writeFileSync(manifest, JSON.stringify(info, null, 2) + '\n');
  console.log(`Mini ${target} build verified. API: ${apiBase}. Manifest: ${manifest}`);
  console.log(
    'This records compiled output only; developer-tool, legal-domain and real-device acceptance remain separate.',
  );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
