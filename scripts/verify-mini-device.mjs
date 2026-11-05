import { wechatProjectAppId } from './wechat-project.mjs';
import { readFileSync } from 'node:fs';
import { verifyBuildInfo } from './mini-build-info.mjs';
try {
  const info = JSON.parse(readFileSync('.local/mini-build.json', 'utf8'));
  verifyBuildInfo('apps/consumer-mini/dist', info, 'device');
  wechatProjectAppId(
    [
      'project.config.json',
      'apps/consumer-mini/project.config.json',
      'apps/consumer-mini/dist/project.config.json',
    ].map((p) => JSON.parse(readFileSync(p, 'utf8'))),
    'device',
    info.wechatAppId,
  );
  console.log(`Device build output verified. API: ${info.apiBase}. Built: ${info.builtAt}`);
  console.log(
    'Still requires WeChat legal-domain confirmation, reachable HTTPS API, developer-tool compile and physical-device acceptance.',
  );
} catch (e) {
  console.error(
    e.code === 'ENOENT'
      ? '缺少真机构建清单，请先配置 HTTPS API 并运行 npm run build:mini:device。'
      : e.message,
  );
  process.exitCode = 1;
}
