import { afterEach, expect, mock, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { GitFileRevisionConflictError, commitMultipleFilesToBranch } from './branches';
import type { GitBackedProject } from './types';

// Real bare-Git contract for atomic skill deletion.

mock.module('../lib/config-convergence-triggers', () => ({ notifyBaseBranchMoved: async () => {} }));

const exec = promisify(execFile);
const cleanupPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function git(args: string[]): Promise<string> {
  const { stdout } = await exec('git', args);
  return stdout.trim();
}

async function makeFixture(): Promise<{ root: string; remote: string; project: GitBackedProject }> {
  const root = await mkdtemp(join(tmpdir(), 'kortix-commit-race-'));
  cleanupPaths.push(root);
  const seed = join(root, 'seed');
  const remote = join(root, 'remote.git');

  await git(['init', '--initial-branch=main', seed]);
  await git(['-C', seed, 'config', 'user.name', 'Kortix Test']);
  await git(['-C', seed, 'config', 'user.email', 'test@kortix.invalid']);
  await writeFile(join(seed, 'kortix.yaml'), 'kortix_version: 2\nconnectors: []\n');
  await git(['-C', seed, 'add', 'kortix.yaml']);
  await git(['-C', seed, 'commit', '-m', 'seed manifest']);
  await git(['init', '--bare', remote]);
  await git(['-C', seed, 'remote', 'add', 'origin', remote]);
  await git(['-C', seed, 'push', 'origin', 'main']);
  await git(['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);

  process.env.KORTIX_GIT_CACHE_DIR = join(root, 'cache');

  const project: GitBackedProject = {
    projectId: `commit-race-${crypto.randomUUID()}`,
    repoUrl: remote,
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    gitAuthToken: 'local-test',
  };
  return { root, remote, project };
}

test('deletes every skill asset and updates the manifest atomically, preserving siblings', async () => {
  const { remote, project } = await makeFixture();
  await commitMultipleFilesToBranch(project, {
    files: [
      { path: 'skills/research/SKILL.md', content: '# Research' },
      { path: 'skills/research/references/a.md', content: 'reference' },
      { path: 'skills/keep/SKILL.md', content: '# Keep' },
    ], message: 'seed skill assets',
  });
  const revision = await git(['--git-dir', remote, 'rev-parse', 'main:kortix.yaml']);
  const result = await commitMultipleFilesToBranch(project, {
    files: [{ path: 'kortix.yaml', content: 'kortix_version: 3\nskills: {}\n' }],
    deletes: ['skills/research/SKILL.md', 'skills/research/references/a.md'],
    expectedFileRevision: { path: 'kortix.yaml', sha: revision },
    message: 'delete skill',
  });
  expect(await git(['--git-dir', remote, 'ls-tree', '-r', '--name-only', 'main'])).toBe('kortix.yaml\nskills/keep/SKILL.md');
  expect(await git(['--git-dir', remote, 'show', 'main:kortix.yaml'])).toBe('kortix_version: 3\nskills: {}');
  expect(await git(['--git-dir', remote, 'rev-parse', 'main'])).toBe(result.commitSha);
});

test('snapshot CAS refuses assets added after enumeration', async () => {
  const { remote, project } = await makeFixture();
  const snapshot = await git(['--git-dir', remote, 'rev-parse', 'main']);
  await commitMultipleFilesToBranch(project, { files: [{ path: 'skills/research/new.md', content: 'new' }], message: 'concurrent asset' });
  await expect(commitMultipleFilesToBranch(project, {
    files: [{ path: 'kortix.yaml', content: 'kortix_version: 3\n' }],
    deletes: ['skills/research/SKILL.md'], message: 'delete stale snapshot',
    expectedCommit: snapshot,
    expectedFileRevision: { path: 'kortix.yaml', sha: await git(['--git-dir', remote, 'rev-parse', 'main:kortix.yaml']) },
  })).rejects.toBeInstanceOf(GitFileRevisionConflictError);
  expect(await git(['--git-dir', remote, 'show', 'main:skills/research/new.md'])).toBe('new');
});
