const { defineConfig } = require('@tarojs/cli');
const devLogin = process.env.TARO_APP_CONSUMER_DEV_LOGIN === '1';
if (
  devLogin &&
  (process.env.YUMI_MINI_BUILD_TARGET !== 'local' ||
    !/^http:\/\/127\.0\.0\.1(?::\d+)?\/api\/v1$/.test(
      process.env.TARO_APP_API_BASE_URL || 'http://127.0.0.1:3000/api/v1',
    ))
)
  throw Error('Consumer development login requires the explicit loopback development build.');
module.exports = defineConfig({
  projectName: 'yumi-retail',
  date: '2026-10-26',
  designWidth: 375,
  deviceRatio: { 375: 2 },
  sourceRoot: 'src',
  outputRoot: 'dist',
  framework: 'react',
  compiler: 'webpack5',
  plugins: ['@tarojs/plugin-platform-weapp'],
  cache: { enable: false },
  defineConstants: {
    CONSUMER_DEV_LOGIN: JSON.stringify(devLogin),
    API_BASE_URL: JSON.stringify(
      process.env.TARO_APP_API_BASE_URL || 'http://127.0.0.1:3000/api/v1',
    ),
  },
  mini: { postcss: { pxtransform: { enable: true }, cssModules: { enable: false } } },
});
