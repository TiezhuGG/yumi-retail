import { createRequire } from 'node:module';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createHash } from 'node:crypto';

const groups = {
  '.': ['pnpm', 'typescript', 'tsx', 'eslint', 'typescript-eslint', 'prettier'],
  'apps/api': ['@nestjs/common', '@nestjs/core', '@nestjs/platform-express', '@nestjs/swagger'],
  'apps/admin-web': ['react', 'react-dom', 'vite', 'antd', '@vitejs/plugin-react'],
  'apps/consumer-mini': [
    '@tarojs/cli',
    '@tarojs/taro',
    '@tarojs/plugin-framework-react',
    '@tarojs/webpack5-runner',
    'vite',
    'less',
    '@babel/core',
    '@babel/preset-react',
  ],
  'packages/database': ['prisma', '@prisma/client', '@prisma/adapter-pg', 'pg'],
};
const installed = {};
for (const [workspace, packages] of Object.entries(groups)) {
  const require = createRequire(resolve(workspace, 'package.json'));
  installed[workspace] = {};
  for (const name of packages) {
    let file;
    try {
      file = require.resolve(`${name}/package.json`);
    } catch {
      let directory = dirname(require.resolve(name));
      while (directory !== dirname(directory)) {
        const candidate = join(directory, 'package.json');
        if (existsSync(candidate) && JSON.parse(readFileSync(candidate, 'utf8')).name === name) {
          file = candidate;
          break;
        }
        directory = dirname(directory);
      }
    }
    if (!file) throw new Error(`Cannot inspect installed version of ${name}`);
    installed[workspace][name] = JSON.parse(readFileSync(file, 'utf8')).version;
  }
}
const result = {
  observedAt: new Date().toISOString(),
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  lockfileSha256: createHash('sha256').update(readFileSync('pnpm-lock.yaml')).digest('hex'),
  installed,
};
mkdirSync('.local', { recursive: true });
writeFileSync('.local/installed-versions.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
