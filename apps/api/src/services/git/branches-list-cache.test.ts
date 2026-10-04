import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { listBranches } from './branches';
import { clearBranchListCacheForTests } from './branch-list-cache';
import { invalidateProjectMirror } from './mirror';

/**
 * `GET /branches?include_session_branches=false` (the web's Files and Git
 * views) answered every request with a fresh `git ls-remote` against the
 * upstream: 451-1431 ms on prod for a 2,900-branch repository, while the local
 * enrichment (`for-each-ref`) costs ~50 ms. The view may read a recent listing;
 * every other caller keeps reading the upstream live.
 */

const exec = promisify(execFile);
const cleanupPaths: string[] = [];

afterEach(async () => {
  setSystemTime();
  clearBranchListCacheForTests();
  await Promise.all(cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function remoteRepo() {
  const root = await mkdtemp(join(tmpdir(), 'kortix-branch-list-cache-'));
  cleanupPaths.push(root);
  const work = join(root, 'work');
  const remote = join(root, 'remote.git');
  await exec('git', ['init', work]);
  await exec('git', ['-C', work, 'config', 'user.name', 'Kortix Test']);
  await exec('git', ['-C', work, 'config', 'user.email', 'test@kortix.invalid']);
  await Bun.write(join(work, 'README.md'), '# test\n');
  await exec('git', ['-C', work, 'add', 'README.md']);
  await exec('git', ['-C', work, 'commit', '-m', 'initial']);
  await exec('git', ['-C', work, 'branch', '-M', 'main']);
  const tip = (await exec('git', ['-C', work, 'rev-parse', 'HEAD'])).stdout.trim();
  await exec('git', ['init', '--bare', remote]);
  await exec('git', ['-C', work, 'remote', 'add', 'origin', remote]);
  await exec('git', ['-C', work, 'push', 'origin', 'main']);
  const addBranch = (name: string) =>
    exec('git', ['--git-dir', remote, 'update-ref', `refs/heads/${name}`, tip]);
  const project = {
    projectId: `branch-list-cache-${crypto.randomUUID()}`,
    repoUrl: remote,
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
  };
  return { project, addBranch, cache: join(root, 'cache') };
}

const names = (branches: Array<{ name: string }>) => branches.map((b) => b.name).sort();

async function withCacheDir<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.KORTIX_GIT_CACHE_DIR;
  process.env.KORTIX_GIT_CACHE_DIR = dir;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.KORTIX_GIT_CACHE_DIR;
    else process.env.KORTIX_GIT_CACHE_DIR = previous;
  }
}

describe('listBranches view cache', () => {
  test('a view reads a recent listing; a caller that did not ask reads the upstream live', async () => {
    const { project, addBranch, cache } = await remoteRepo();
    await withCacheDir(cache, async () => {
      expect(names(await listBranches(project, { allowRecent: true }))).toEqual(['main']);
      await addBranch('feature');

      expect(names(await listBranches(project, { allowRecent: true }))).toEqual(['main']);
      expect(names(await listBranches(project))).toEqual(['feature', 'main']);
    });
  });

  test('a base-branch move (invalidateProjectMirror) drops the listing', async () => {
    const { project, addBranch, cache } = await remoteRepo();
    await withCacheDir(cache, async () => {
      await listBranches(project, { allowRecent: true });
      await addBranch('feature');
      invalidateProjectMirror(project.projectId);
      expect(names(await listBranches(project, { allowRecent: true }))).toEqual(['feature', 'main']);
    });
  });

  test('past the fresh window it answers at once and refreshes in the background', async () => {
    const { project, addBranch, cache } = await remoteRepo();
    await withCacheDir(cache, async () => {
      const start = Date.now();
      setSystemTime(new Date(start));
      await listBranches(project, { allowRecent: true });
      await addBranch('feature');

      setSystemTime(new Date(start + 20_000));
      expect(names(await listBranches(project, { allowRecent: true }))).toEqual(['main']);
      // The background refresh lands; the next read sees the new branch.
      for (let i = 0; i < 50; i += 1) {
        if (names(await listBranches(project, { allowRecent: true })).includes('feature')) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(names(await listBranches(project, { allowRecent: true }))).toEqual(['feature', 'main']);
    });
  });

  test('past the stale bound a view waits for the upstream', async () => {
    const { project, addBranch, cache } = await remoteRepo();
    await withCacheDir(cache, async () => {
      const start = Date.now();
      setSystemTime(new Date(start));
      await listBranches(project, { allowRecent: true });
      await addBranch('feature');

      setSystemTime(new Date(start + 6 * 60_000));
      expect(names(await listBranches(project, { allowRecent: true }))).toEqual(['feature', 'main']);
    });
  });

  test('a failed listing is never kept', async () => {
    const { project, cache } = await remoteRepo();
    const missing = { ...project, repoUrl: `${project.repoUrl}-missing` };
    await withCacheDir(cache, async () => {
      await expect(listBranches(missing, { allowRecent: true })).rejects.toThrow();
      await expect(listBranches(missing, { allowRecent: true })).rejects.toThrow();
    });
  });
});
