import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { assertRecoveryOptIn, fileManifest } from '../scripts/local-recovery-cluster.mjs';

test('cold recovery requires explicit opt-in and rejects all supplied targets before starting a server', () => {
  assert.throws(() => assertRecoveryOptIn({}), /OPT_IN_REQUIRED/);
  assert.throws(() => assertRecoveryOptIn({ YUMI_LOCAL_RECOVERY: 'true' }), /OPT_IN_REQUIRED/);
  for (const target of [
    '--database=postgresql://example.invalid/main',
    '--data=.local/dev-pg-data',
  ])
    assert.throws(
      () => assertRecoveryOptIn({ YUMI_LOCAL_RECOVERY: '1' }, [target]),
      /OPT_IN_REQUIRED/,
    );
});

test('backup manifests detect same-size byte corruption and reject junctions outside the copied tree', async () => {
  const parent = await realpath(tmpdir()),
    root = await mkdtemp(join(parent, 'yumi-recovery-test-'));
  try {
    const data = join(root, 'data'),
      outside = join(root, 'outside');
    await mkdir(data);
    await mkdir(outside);
    await writeFile(join(data, 'row'), 'abcd');
    const before = await fileManifest(data);
    await writeFile(join(data, 'row'), 'abce');
    const after = await fileManifest(data);
    assert.equal(before[0].bytes, after[0].bytes);
    assert.notEqual(before[0].sha256, after[0].sha256);
    await symlink(
      outside,
      join(data, 'external'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(fileManifest(data), /RECOVERY_LINK_REJECTED/);
  } finally {
    const target = await realpath(root);
    assert.ok(target.startsWith(parent + sep + 'yumi-recovery-test-'));
    await rm(target, { recursive: true });
  }
});
