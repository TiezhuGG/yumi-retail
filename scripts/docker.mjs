import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const candidate =
  process.platform === 'win32' && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'Programs', 'DockerDesktop', 'resources', 'bin', 'docker.exe')
    : '';
const executable = candidate && existsSync(candidate) ? candidate : 'docker';
const result = spawnSync(executable, process.argv.slice(2), { stdio: 'inherit', shell: false });
if (result.error) {
  console.error(
    'Docker command could not start. Check Docker Desktop or Docker Engine and the Docker CLI installation.',
  );
}
process.exit(result.status ?? 1);
