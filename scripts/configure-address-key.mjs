// Creates an ignored local development key without printing it. Never replaces an existing key.
import { readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const env = readFileSync('.env', 'utf8');
execFileSync('git', ['check-ignore', '--quiet', '.env']);
if (process.env.NODE_ENV === 'production') throw Error('Local development only');
const database = env
  .match(/^DATABASE_URL=(.*)$/m)?.[1]
  ?.trim()
  .replace(/^['"]|['"]$/g, '');
const url = new URL(database ?? '');
if (url.hostname !== '127.0.0.1' || url.pathname !== '/yumi_dev')
  throw Error('Local yumi_dev only');
const current = env.match(/^ADDRESS_ENCRYPTION_KEY=(.*)$/m)?.[1]?.trim();
if (current) {
  if (!/^[a-f0-9]{64}$/i.test(current))
    throw Error('Existing address key needs manual checking; not overwritten');
  console.log('Existing local address key preserved.');
} else {
  const entry = `ADDRESS_ENCRYPTION_KEY=${randomBytes(32).toString('hex')}`;
  writeFileSync(
    '.env',
    /^ADDRESS_ENCRYPTION_KEY=/m.test(env)
      ? env.replace(/^ADDRESS_ENCRYPTION_KEY=.*$/m, entry)
      : env + `${env.endsWith('\n') ? '' : '\n'}${entry}\n`,
    { mode: 0o600 },
  );
  chmodSync('.env', 0o600);
  console.log('Local address key saved in ignored .env; keep it with encrypted database backups.');
}
