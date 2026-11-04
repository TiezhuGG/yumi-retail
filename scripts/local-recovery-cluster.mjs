// Disposable cold-backup laboratory. Never accepts an existing database/data directory.
import { spawnSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

export function assertRecoveryOptIn(env, args = []) {
  if (env.YUMI_LOCAL_RECOVERY !== '1' || args.length || process.platform !== 'win32')
    throw Error('LOCAL_WINDOWS_RECOVERY_OPT_IN_REQUIRED');
}

export async function fileManifest(root) {
  const files = [];
  async function visit(relative = '') {
    for (const name of (await readdir(join(root, relative))).sort()) {
      const path = join(root, relative, name),
        stat = await lstat(path);
      if (stat.isSymbolicLink()) throw Error('RECOVERY_LINK_REJECTED');
      if (stat.isDirectory()) await visit(join(relative, name));
      else if (stat.isFile()) {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(path)) hash.update(chunk);
        files.push({ path: join(relative, name), bytes: stat.size, sha256: hash.digest('hex') });
      } else throw Error('RECOVERY_SPECIAL_FILE_REJECTED');
    }
  }
  await visit();
  return files;
}

export async function createRecoveryLab() {
  assertRecoveryOptIn(process.env);
  const workspace = await realpath(fileURLToPath(new URL('..', import.meta.url)));
  if ((await realpath('.')) !== workspace) throw Error('RECOVERY_PROJECT_DIRECTORY_REQUIRED');
  const bin = resolve('.local/pg-tools/node_modules/@embedded-postgres/windows-x64/native/bin');
  function run(name, args) {
    const r = spawnSync(join(bin, name + '.exe'), args, {
      encoding: 'utf8',
      // pg_ctl's detached Windows children must not inherit Node's capture pipes.
      stdio: args.includes('--version') ? 'pipe' : 'ignore',
      windowsHide: true,
      timeout: 45000,
    });
    if (r.error || r.status !== 0) throw Error('LOCAL_POSTGRES_COMMAND_FAILED_' + name);
    return r.stdout;
  }
  if (!/\b17\.11\b/.test(run('postgres', ['--version']))) throw Error('POSTGRES_17_11_REQUIRED');
  await mkdir('.local', { recursive: true });
  const local = await realpath('.local');
  if (local !== join(workspace, '.local')) throw Error('RECOVERY_LOCAL_LINK_REJECTED');
  const root = await mkdtemp(join(local, 'express-recovery-'));
  const password = randomBytes(32).toString('hex'),
    username = 'recovery_lab';
  const started = new Set();
  async function owned(path) {
    const target = await realpath(path);
    if (!target.startsWith(root + sep)) throw Error('RECOVERY_PATH_OUTSIDE_LAB');
    return target;
  }
  async function stop(directory) {
    await owned(directory);
    run('pg_ctl', ['stop', '-D', directory, '-m', 'fast', '-w', '-t', '30']);
    started.delete(directory);
  }
  async function start(directory) {
    await owned(directory);
    // A free loopback port is requested anew; collisions fail rather than attach to another server.
    const probe = createServer();
    await new Promise((res, rej) => {
      probe.once('error', rej);
      probe.listen(0, '127.0.0.1', res);
    });
    const port = probe.address().port;
    await new Promise((res, rej) => probe.close((error) => (error ? rej(error) : res())));
    started.add(directory); // Also attempt shutdown if startup times out.
    run('pg_ctl', [
      'start',
      '-D',
      directory,
      '-l',
      join(root, 'postgres-' + port + '.log'),
      '-o',
      `-h 127.0.0.1 -p ${port} -c timezone=UTC`,
      '-w',
      '-t',
      '30',
    ]);
    const url = new URL(`postgresql://127.0.0.1:${port}/yumi_test`);
    url.username = username;
    url.password = password;
    return url;
  }
  let cleaned = false;
  async function cleanup() {
    if (cleaned) return;
    for (const dir of started) await stop(dir);
    // Resolve and validate the final target before any recursive removal.
    const target = await realpath(root);
    if (target !== root || !target.startsWith(local + sep + 'express-recovery-'))
      throw Error('RECOVERY_CLEANUP_PATH_REJECTED');
    await rm(target, { recursive: true, maxRetries: 10, retryDelay: 200 });
    cleaned = true;
  }
  try {
    const source = join(root, 'source'),
      backup = join(root, 'backup'),
      restored = join(root, 'restored');
    const pwfile = join(root, 'password');
    await writeFile(pwfile, password, { flag: 'wx', mode: 0o600 });
    try {
      run('initdb', [
        '-D',
        source,
        '-U',
        username,
        '--pwfile=' + pwfile,
        '--auth=scram-sha-256',
        '--encoding=UTF8',
        '--locale=C',
      ]);
    } finally {
      await rm(pwfile);
    }
    console.log('LOCAL_RECOVERY: isolated cluster initialized');
    const sourceUrl = await start(source),
      adminUrl = new URL(sourceUrl);
    adminUrl.pathname = '/postgres';
    console.log('LOCAL_RECOVERY: isolated cluster started');
    const client = new Client({
      connectionString: adminUrl.toString(),
      connectionTimeoutMillis: 5000,
    });
    try {
      await client.connect();
      console.log('LOCAL_RECOVERY: isolated database connection established');
      await client.query('CREATE DATABASE yumi_test');
    } catch (error) {
      const code = /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'CONNECTION_OR_CREATE';
      throw Error('RECOVERY_DATABASE_' + code);
    } finally {
      await client.end();
    }
    return {
      sourceUrl,
      async backupAndRestore() {
        await stop(source);
        const status = spawnSync(join(bin, 'pg_ctl.exe'), ['status', '-D', source], {
          windowsHide: true,
          stdio: 'ignore',
          timeout: 5000,
        });
        if (
          status.status !== 3 ||
          (await lstat(join(source, 'postmaster.pid')).then(
            () => true,
            (e) => {
              if (e.code === 'ENOENT') return false;
              throw e;
            },
          ))
        )
          throw Error('RECOVERY_SOURCE_NOT_STOPPED');
        const expected = await fileManifest(source);
        await cp(source, backup, { recursive: true, force: false, errorOnExist: true });
        if (JSON.stringify(await fileManifest(backup)) !== JSON.stringify(expected))
          throw Error('RECOVERY_BACKUP_MISMATCH');
        await cp(backup, restored, { recursive: true, force: false, errorOnExist: true });
        if (JSON.stringify(await fileManifest(restored)) !== JSON.stringify(expected))
          throw Error('RECOVERY_RESTORE_MISMATCH');
        // New target directory, same exact binary/platform. Source remains stopped.
        const restoredUrl = await start(restored);
        return {
          restoredUrl,
          files: expected.length,
          bytes: expected.reduce((sum, file) => sum + file.bytes, 0),
          digest: createHash('sha256').update(JSON.stringify(expected)).digest('hex'),
        };
      },
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
