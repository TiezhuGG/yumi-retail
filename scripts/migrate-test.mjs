import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const url = new URL(process.env.TEST_DATABASE_URL ?? '');
if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.pathname !== '/yumi_test')
  throw new Error('Migrations only permit the isolated local test database.');
const require = createRequire(new URL('../packages/database/package.json', import.meta.url));
const prismaCli = join(dirname(require.resolve('prisma/package.json')), 'build/index.js');
const result = spawnSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
  cwd: new URL('../packages/database', import.meta.url),
  env: { ...process.env, DATABASE_URL: url.toString() },
  stdio: 'inherit',
  shell: false,
});
process.exit(result.status ?? 1);
