import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { applicationConfig } from '../apps/api/dist/config.js';
import { apiBaseForBuild, verifyBuildInfo } from './mini-build-info.mjs';
import { realWechatAppId, wechatProjectAppId } from './wechat-project.mjs';

// Static, read-only preparation report. Never calls WeChat, DNS or a database.
export function inspectWechatLogin(env, options = {}) {
  let serverValid = false,
    projectMatches = false,
    httpsApi = false,
    outputMatches = false;
  try {
    serverValid = applicationConfig(env).wechatLogin === true;
  } catch {
    /* Fixed checks below contain no configuration values. */
  }
  try {
    projectMatches =
      wechatProjectAppId(options.projects ?? [], 'device', env.WECHAT_APP_ID) === env.WECHAT_APP_ID;
  } catch {
    /* No raw errors or IDs. */
  }
  try {
    const api = apiBaseForBuild(
      env.TARO_APP_API_BASE_URL ||
        (options.build?.target === 'device' ? options.build.apiBase : undefined),
      'device',
    );
    httpsApi =
      !env.POINTS_EXPRESS_API_ORIGIN || new URL(api).origin === env.POINTS_EXPRESS_API_ORIGIN;
    outputMatches =
      !!options.buildVerified &&
      options.build?.target === 'device' &&
      options.build.wechatAppId === env.WECHAT_APP_ID &&
      options.build.apiBase === api &&
      options.build.consumerDevelopmentLogin === false;
  } catch {
    /* Static URL checks do not resolve the domain. */
  }
  const devKeys = [
    'CONSUMER_DEV_LOGIN_ENABLED',
    'ORDER_DEV_SUBMIT_ENABLED',
    'REDEMPTION_DEV_SUBMIT_ENABLED',
    'REDEMPTION_PICKING_DEV_ENABLED',
  ];
  const checks = [
    { code: 'LOGIN_ENABLED', ok: serverValid, message: '服务端微信登录配置完整并启用' },
    {
      code: 'APP_ID',
      ok: realWechatAppId(env.WECHAT_APP_ID),
      message: '已配置真实小程序AppID（非游客或占位值）',
    },
    {
      code: 'SERVER_SECRET',
      ok:
        /^[A-Za-z0-9]{32}$/.test(env.WECHAT_APP_SECRET ?? '') &&
        env.WECHAT_APP_SECRET !== '0'.repeat(32),
      message: 'AppSecret仅配置在服务端私有环境',
    },
    { code: 'PROJECT_MATCH', ok: projectMatches, message: '两处源工程AppID与服务端一致' },
    { code: 'HTTPS_API', ok: httpsApi, message: '已声明可用于真机的HTTPS API地址（尚未检查网络）' },
    {
      code: 'DEVICE_OUTPUT',
      ok: outputMatches,
      message: '当前有效真机构建与AppID、API一致，且未启用开发顾客入口',
    },
    {
      code: 'DEVELOPMENT_OFF',
      ok: devKeys.every((k) => env[k] !== '1'),
      message: '真实联调环境已关闭开发交易与身份入口',
    },
  ];
  return {
    scope: 'WECHAT_LOGIN_PREPARATION',
    configurationReady: checks.every((c) => c.ok),
    canLaunch: false,
    networkChecked: false,
    realWechatVerified: false,
    checks,
    remaining: [
      ...checks
        .filter((c) => !c.ok)
        .map(
          (c) =>
            ({
              LOGIN_ENABLED: '填好服务端私有配置后启用微信登录',
              APP_ID: '注册并取得自己的小程序AppID',
              SERVER_SECRET: '将AppSecret填写到服务端私有配置文件',
              PROJECT_MATCH: '将两个源工程的AppID与服务端同步',
              HTTPS_API: '准备HTTPS API并配置小程序合法请求域名',
              DEVICE_OUTPUT: '生成AppID和API匹配、无开发入口的真机构建',
              DEVELOPMENT_OFF: '关闭真实联调环境中的开发身份和交易开关',
            })[c.code],
        ),
      '微信开发者工具与真机登录、恢复、退出验收',
      '正式兑换另需受控门禁及真实积分/库存配置',
    ],
  };
}

export function main(args = process.argv.slice(2)) {
  if (args.length) throw Error('不接受额外参数。');
  let projects = [],
    build,
    buildVerified = false;
  try {
    projects = ['project.config.json', 'apps/consumer-mini/project.config.json'].map((p) =>
      JSON.parse(readFileSync(p, 'utf8')),
    );
  } catch {
    /* Missing/malformed files are reported as failed checks. */
  }
  try {
    build = JSON.parse(readFileSync('.local/mini-build.json', 'utf8'));
    verifyBuildInfo('apps/consumer-mini/dist', build, 'device');
    buildVerified = true;
  } catch {
    /* A local/stale build does not become a device build. */
  }
  const report = inspectWechatLogin(process.env, { projects, build, buildVerified });
  console.log(JSON.stringify(report, null, 2));
  if (!report.configurationReady) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch {
    console.error('微信登录准备检查失败，未输出配置值。');
    process.exitCode = 1;
  }
}
