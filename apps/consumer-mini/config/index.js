const { defineConfig } = require('@tarojs/cli');
module.exports = defineConfig({
  projectName: 'yumi-retail', date: '2026-10-26',
  designWidth: 375, deviceRatio: { 375: 2 },
  sourceRoot: 'src', outputRoot: 'dist',
  framework: 'react', compiler: 'webpack5',
  plugins: ['@tarojs/plugin-platform-weapp'],
  cache: { enable: false },
  mini: { postcss: { pxtransform: { enable: true }, cssModules: { enable: false } } },
});
