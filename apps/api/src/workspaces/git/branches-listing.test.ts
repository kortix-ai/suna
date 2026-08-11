import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { listBranches } from './branches';
import { repoCachePath } from './mirror';

const exec = promisify(execFile);
const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createRemoteWithBranches(branchCount: number) {
  const root = await mkdtemp(join(tmpdir(), 'kortix-branch-listing-'));
  cleanupPaths.push(root);
  const work = join(root, 'work');
  const remote = join(root, 'remote.git');
  const cache = join(root, 'cache');

  await exec('git', ['init', work]);
  await exec('git', ['-C', work, 'config', 'user.name', 'Kortix Test']);
  await exec('git', ['-C', work, 'config', 'user.email', 'test@kortix.ai']);
  await Bun.write(join(work, 'README.md'), '# test\n');
  await exec('git', ['-C', work, 'add', 'README.md']);
  await exec('git', ['-C', work, 'commit', '-m', 'initial']);
  await exec('git', ['-C', work, 'branch', '-M', 'main']);
  const { stdout } = await exec('git', ['-C', work, 'rev-parse', 'HEAD']);
  const tip = stdout.trim();

  await exec('git', ['init', '--bare', remote]);
  await exec('git', ['-C', work, 'remote', 'add', 'origin', remote]);
  await exec('git', ['-C', work, 'push', 'origin', 'main']);
  await Promise.all(
    Array.from({ length: branchCount }, (_, index) =>
      exec('git', [
        '--git-dir',
        remote,
        'update-ref',
        `refs/heads/session-${String(index).padStart(4, '0')}`,
        tip,
      ]),
    ),
  );

  return { cache, remote, tip };
}

describe('listBranches', () => {
  test('lists a large remote without creating a full repository mirror', async () => {
    const { cache, remote, tip } = await createRemoteWithBranches(250);
    const previousCacheDir = process.env.KORTIX_GIT_CACHE_DIR;
    process.env.KORTIX_GIT_CACHE_DIR = cache;

    try {
      const project = {
        workspaceId: 'branch-listing-regression',
        repoUrl: remote,
        defaultBranch: 'main',
        manifestPath: 'kortix.yaml',
      };
      const branches = await listBranches(project);

      expect(branches).toHaveLength(251);
      expect(branches[0]).toMatchObject({
        name: 'main',
        is_default: true,
        tip,
        tip_short: tip.slice(0, 7),
        ahead: 0,
        behind: 0,
      });
      expect(branches.at(-1)?.name).toBe('session-0249');
      expect(await Bun.file(join(repoCachePath(project), 'HEAD')).exists()).toBe(false);
    } finally {
      if (previousCacheDir === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
      else process.env.KORTIX_GIT_CACHE_DIR = previousCacheDir;
    }
  });
});
